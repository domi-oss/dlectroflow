"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  CAPTURE_QUEUE_STORAGE_KEY,
  applyFlushOutcome,
  discardCapture,
  enqueue,
  newClientKey,
  partitionQueue,
  readQueue,
  sweepUnresolvable,
  type EnqueueRefusal,
  type FlushOutcome,
  type QueuedCapture,
  type StrandedGroup,
} from "@/lib/capture-queue";
import {
  CAPTURE_SYNC_TAG,
  deleteMirrored,
  mirroredFrom,
  openMirror,
  planMirrorReconciliation,
  putMirrored,
  readMirrored,
} from "@/lib/capture-mirror";

/**
 * #175 — the component-lifecycle half of the offline capture queue.
 *
 * `capture-queue.ts` is pure and knows nothing about the DOM; this is everything
 * that needs a mount, an unmount or a network call. The split is the same one
 * `hyper-focus.ts` / `use-hyper-focus.ts` uses, and it is load-bearing here for a
 * reason that module records explicitly: **the `storage`-event re-enqueue must not
 * be closed by putting a listener in a pure module.**
 *
 * ── The four foreground triggers, and why none of them is `beforeunload` ──────
 *
 * mount · `visibilitychange` → visible · `online` · after any successful submit.
 *
 * There is deliberately no flush-on-exit anywhere. Chrome discards background
 * tabs under memory pressure and **a discarded tab fires no unload event at
 * all**, which is the whole reason the words are written to storage *before* the
 * network is attempted rather than on the way out.
 *
 * `online` is an **opportunistic hint only**, never a gate: `navigator.onLine`
 * reads `true` on a captive portal, in a lift and at the edge of coverage, so
 * nothing here ever reads it to decide whether to try.
 *
 * ── The residual `capture-queue.ts` hands over ───────────────────────────────
 *
 * `getItem` carries no ordering guarantee against another tab's `setItem`, so a
 * read can be stale the instant it returns and **no amount of re-reading detects
 * that**. The `storage` event does not fix it by letting a tab learn before
 * writing; it fixes it by letting the **losing** tab notice afterwards that the
 * queue no longer holds its own pending capture, and re-enqueue. That needs "what
 * I am still waiting on" in memory plus subscribe/unsubscribe — a component
 * lifecycle, which is why it lives here.
 *
 * It is also `capture-queue.ts`'s own safety net: the last CAS attempt writes
 * **without** the comparison, deliberately, and the reason that improbable
 * clobber is acceptable is not that the loss is small — it is that **the clobbered
 * tab has already told its user the words are queued**, and this is the only thing
 * that recovers them.
 *
 * ── Nothing here throws either ───────────────────────────────────────────────
 *
 * Every failure resolves to "still queued, still visible". A capture bar that
 * crashes is worse than one reporting "not saved", because the bar is how the
 * problem gets reported at all.
 */

/**
 * Broadcast on every write so every mounted reader updates at once.
 *
 * `storage` fires only in the OTHER tabs and never in the one that wrote (see
 * `HYPER_FOCUS_EVENT` for the same asymmetry), so this tab needs its own signal
 * — and that asymmetry is exactly what makes `storage` the right input for the
 * re-enqueue below.
 */
export const CAPTURE_QUEUE_EVENT = "df-capture-queue-change";

/** The route the queue flushes through. Plain, because a worker cannot replay an action. */
const FLUSH_URL = "/api/braindump";

/**
 * What the strip is told. Everything the component needs and nothing it could
 * use to reach storage itself.
 */
export type CaptureQueueApi = {
  /** Captures the live session may show in full, oldest first. */
  mine: QueuedCapture[];
  /** Captures it may only COUNT, grouped by state. Never their text. */
  stranded: StrandedGroup[];
  /** True while any `POST` is outstanding — drives the wait announcement. */
  flushing: boolean;
  /** Is a `POST` outstanding for this entry? Used by Discard's courtesy check. */
  inFlight: (clientKey: string) => boolean;
  /** Store a capture before the network is attempted. Called from `submit()`. */
  enqueueCapture: (text: string) => CaptureEnqueueResult;
  /** Try the queue now. Safe to call concurrently; overlapping passes coalesce. */
  flush: () => Promise<void>;
  /** Throw entries away at the user's request. Mirror first, then `localStorage`. */
  discard: (clientKeys: readonly string[]) => Promise<DiscardOutcome>;
  /** The last refusal to ANNOUNCE, with a token that changes on every occurrence. */
  announcement: {
    reason: EnqueueRefusal | DiscardOutcome;
    token: number;
  } | null;
  /** Drop the announcement, so an identical next one is a genuine change. */
  clearAnnouncement: () => void;
};

export type CaptureEnqueueResult =
  { ok: true } | { ok: false; reason: EnqueueRefusal };

/**
 * What a Discard did.
 *
 * `refused` and `already-saved` are not errors — they are the two arms of the
 * confirm-resolution re-check, and each has its own sentence, because in both
 * cases the store ends up in the state a naive implementation would also reach
 * and the difference is entirely what the user is told.
 */
export type DiscardOutcome =
  "discarded" | "refused-in-flight" | "already-saved" | "storage-unavailable";

function currentStore(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // A blocked-cookies policy throws on property access, not just on `getItem`.
    return null;
  }
}

/**
 * A referentially stable snapshot.
 *
 * `useSyncExternalStore` re-renders forever if `getSnapshot` returns a fresh
 * array each call, so the parse is memoised on the raw string — which is also the
 * only version marker `localStorage` offers.
 */
let cachedRaw: string | null | undefined;
let cachedQueue: QueuedCapture[] = [];

/**
 * Off on the server, and the same value on the first client render.
 *
 * Deliberate rather than incidental: #75 and #94 are both hydration mismatches in
 * this tree, and #75's silently reverted dark mode for real users. Nothing is read
 * from `localStorage` during render; the subscription is what updates it.
 */
function getServerSnapshot(): QueuedCapture[] {
  return EMPTY;
}

function getSnapshot(): QueuedCapture[] {
  const store = currentStore();
  if (!store) return EMPTY;
  let raw: string | null = null;
  try {
    raw = store.getItem(CAPTURE_QUEUE_STORAGE_KEY);
  } catch {
    return EMPTY;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedQueue = readQueue(store);
  }
  return cachedQueue;
}

/** One shared empty array, so the no-storage path is stable too. */
const EMPTY: QueuedCapture[] = [];

/** Tell this tab. Without it nothing has a reason to re-read its own write. */
function broadcast(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CAPTURE_QUEUE_EVENT));
}

/**
 * The route's status → the queue's vocabulary.
 *
 * ⚠️ **Everything unrecognised is `retry`, and that is the load-bearing part.**
 * An unlisted status must not be able to discard words, so this maps what it
 * knows and keeps the capture for everything else. `400` and `413` are retryable
 * knowing they will not clear on their own — a misconfigured origin rule retries
 * for ever — because the alternative is a client that deletes a capture on a
 * status the server may be returning for a reason the client cannot see. **A
 * wasted retry is recoverable; a dropped capture is not.**
 */
function outcomeOf(status: number, body: unknown): FlushOutcome {
  if (status === 201) return "saved";
  if (status === 200) return "duplicate";
  // ⚠️ A terminal mark needs the status line AND the parsed body to agree, and
  // `flushOne` in public/sw.js must keep the same rule — it can import nothing,
  // so the agreement is carried by tests on both sides and by this note.
  //
  // Either control alone is reachable from something the app did not author: a
  // 403 from an auth proxy, an ingress rule or a corporate filter in front of the
  // route; or a proxy error page answering 5xx with a JSON body of its own that
  // happens to carry `status: "account-revoked"`. Either would permanently mark a
  // perfectly good capture "this account can no longer save", whose only exit is
  // the user deliberately destroying the words.
  //
  // ⚠️ This comment used to read "taken from the parsed BODY, never from the
  // status line", which is what the merged spec says and is NOT what the two
  // lines below do. Duo review round 2 on `!348` found the worker had implemented
  // the comment rather than the code, so the two flush paths disagreed about the
  // same response — in the direction that loses words. The rule is the strict
  // conjunction; do not relax either half back toward the prose.
  const declared =
    typeof body === "object" && body !== null
      ? (body as { status?: unknown }).status
      : undefined;
  if (status === 403 && declared === "account-revoked")
    return "account-revoked";
  if (status === 409 && declared === "session-expired")
    return "session-expired";
  return "retry";
}

export function useCaptureQueue(workspaceId: string): CaptureQueueApi {
  const [flightCount, setFlightCount] = useState(0);
  const [announcement, setAnnouncement] = useState<{
    reason: EnqueueRefusal | DiscardOutcome;
    token: number;
  } | null>(null);

  /** Entries this tab enqueued and has not yet seen accounted for. */
  const awaiting = useRef(new Map<string, QueuedCapture>());
  /** Keys with a `POST` outstanding, or claimed by a discard in progress. */
  const inFlightKeys = useRef(new Set<string>());
  const claimed = useRef(new Set<string>());
  const mirror = useRef<IDBDatabase | null>(null);
  /** Bumped on every announcement so an identical sentence is a real change. */
  const token = useRef(0);

  const announce = useCallback((reason: EnqueueRefusal | DiscardOutcome) => {
    token.current += 1;
    setAnnouncement({ reason, token: token.current });
  }, []);

  // ── The subscription, and the re-enqueue that is the point of it ───────────
  //
  // `useSyncExternalStore` rather than `useState` plus an effect, for the reason
  // `use-hyper-focus.ts` gives: the value lives outside React, more than one
  // reader can be mounted in a session, and they must never disagree about
  // whether somebody's words are saved.
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === "undefined") return () => {};
    const onStorage = (event: StorageEvent) => {
      // `null` key means the whole store was cleared, which is also our business.
      if (event.key !== null && event.key !== CAPTURE_QUEUE_STORAGE_KEY) return;
      const store = currentStore();
      const present = new Set(readQueue(store).map((c) => c.clientKey));
      // ⚠️ The losing tab of a clobber finds its own pending capture gone from a
      // queue it never removed it from. Re-enqueueing is the ONLY recovery: this
      // tab has already told its user the words are safe.
      for (const [key, capture] of awaiting.current) {
        if (present.has(key)) continue;
        // A capture whose flush is outstanding may legitimately have been removed
        // by ANOTHER tab's successful flush of the same key, so re-adding it would
        // resurrect something already saved. The idempotency key makes the
        // opposite mistake cheap — a duplicate POST answered 200 — so the entry is
        // only put back while nothing is in flight for it.
        if (inFlightKeys.current.has(key)) continue;
        enqueue(store, capture);
      }
      onChange();
    };
    window.addEventListener(CAPTURE_QUEUE_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CAPTURE_QUEUE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const queue = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const flush = useCallback(async (): Promise<void> => {
    const store = currentStore();
    if (!store) return;
    for (const capture of readQueue(store)) {
      if (capture.workspaceId !== workspaceId) continue;
      // A terminal entry is skipped rather than flushed: a 403 that can never
      // clear must not be re-POSTed on every trigger for the life of the profile.
      if (capture.blockedBy === "account-revoked") continue;
      // ⚠️ Per-entry, matching the worker's rule: a claimed entry must not stop
      // the pass draining the rest, or one discard-in-progress reintroduces the
      // head-of-line failure this design refuses.
      if (claimed.current.has(capture.clientKey)) continue;
      if (inFlightKeys.current.has(capture.clientKey)) continue;

      inFlightKeys.current.add(capture.clientKey);
      setFlightCount((n) => n + 1);
      try {
        let status = 0;
        let body: unknown = null;
        try {
          const response = await fetch(FLUSH_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              clientKey: capture.clientKey,
              text: capture.text,
              workspaceId: capture.workspaceId,
            }),
          });
          status = response.status;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
        } catch {
          // Network failure — the ordinary case this feature exists for.
          status = 0;
        }
        const outcome = outcomeOf(status, body);
        // The live workspace is passed so a 409 records `blockedUnder`; it is the
        // only thing the client holds that changes when the user signs in.
        applyFlushOutcome(store, capture.clientKey, outcome, workspaceId);
        if (outcome === "saved" || outcome === "duplicate") {
          awaiting.current.delete(capture.clientKey);
          await deleteMirrored(mirror.current, [capture.clientKey]);
        } else {
          await putMirrored(mirror.current, [
            mirroredFrom({ ...capture, blockedBy: markOf(outcome) }),
          ]);
        }
      } finally {
        inFlightKeys.current.delete(capture.clientKey);
        setFlightCount((n) => Math.max(0, n - 1));
      }
    }
    broadcast();
  }, [workspaceId]);

  // ── Mount: sweep, reconcile the mirror, flush ──────────────────────────────
  useEffect(() => {
    let live = true;
    const store = currentStore();
    // The expiry sweep needs the live workspace, so it runs here and not in the
    // pure module's own mount-less world. It writes nothing when nothing changed.
    if (store) sweepUnresolvable(store, workspaceId, Date.now());

    void (async () => {
      const db = await openMirror(
        typeof window === "undefined" ? null : window.indexedDB,
      );
      if (!live) return;
      mirror.current = db;
      const plan = planMirrorReconciliation(
        readQueue(currentStore()),
        await readMirrored(db),
      );
      if (!live) return;
      if (plan.remove.length > 0) await deleteMirrored(db, plan.remove);
      if (plan.put.length > 0) await putMirrored(db, plan.put);
      // The carve-out: a mark the worker learned while no tab was open. Applied
      // through `applyFlushOutcome`, so the module's own precedence decides it.
      for (const mark of plan.marks) {
        applyFlushOutcome(
          currentStore(),
          mark.clientKey,
          mark.blockedBy,
          workspaceId,
        );
      }
      if (plan.marks.length > 0) broadcast();
      if (!live) return;
      await flush();
    })();

    return () => {
      live = false;
    };
    // Mount and workspace changes only. `flush` is stable per workspace.
  }, [flush, workspaceId]);

  // ── visibilitychange and online: opportunistic, never a gate ───────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void flush();
    };
    const onOnline = () => void flush();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [flush]);

  const enqueueCapture = useCallback(
    (text: string): CaptureEnqueueResult => {
      const store = currentStore();
      if (!store) {
        announce("storage-unavailable");
        return { ok: false, reason: "storage-unavailable" };
      }
      const capture: QueuedCapture = {
        // The cross-tab guard: the keys already queued are handed over so a
        // tier-3 candidate colliding with one is redrawn. See `newClientKey`.
        clientKey: newClientKey(readQueue(store).map((c) => c.clientKey)),
        text,
        workspaceId,
        capturedAt: Date.now(),
      };
      const result = enqueue(store, capture);
      if (!result.ok) {
        announce(result.reason);
        return result;
      }
      // Remembered so the `storage` listener can put it back if another tab
      // clobbers the write this tab has already acknowledged.
      awaiting.current.set(capture.clientKey, capture);
      broadcast();
      // Best-effort, and initiated in the same block as the synchronous write —
      // the durability guarantee is carried by `localStorage`, never by this.
      void putMirrored(mirror.current, [mirroredFrom(capture)]).then(() =>
        registerSync(),
      );
      return { ok: true };
    },
    [announce, workspaceId],
  );

  const discard = useCallback(
    async (clientKeys: readonly string[]): Promise<DiscardOutcome> => {
      const store = currentStore();
      // ⚠️ Step 2 of the resolution order: **re-evaluate against live state.**
      // The press-time check is a courtesy; THIS is the guard. An open-time-only
      // check leaves the ordinary case open, because the two-step confirm is a
      // human pause of exactly the length a flush trigger needs — and
      // `visibilitychange` fires on the very tab-switch a hesitating user makes.
      const live = new Set(readQueue(store).map((c) => c.clientKey));
      const stillQueued = clientKeys.filter((key) => live.has(key));
      if (stillQueued.length === 0) {
        announce("already-saved");
        return "already-saved";
      }
      if (stillQueued.some((key) => inFlightKeys.current.has(key))) {
        announce("refused-in-flight");
        return "refused-in-flight";
      }
      // Step 3: claim SYNCHRONOUSLY, in the same tick as the re-check and before
      // awaiting anything. The mirror delete is asynchronous, so the re-check and
      // the delete are not one atomic step — and a claim bridges them because the
      // flush loop and the discard run on one tab's single thread. A claim fails
      // closed, where suppressing the four triggers would fail open the day a
      // fifth is added.
      for (const key of stillQueued) claimed.current.add(key);
      try {
        // ⚠️ MIRROR FIRST, and the order is the whole fix. A `sync` event between
        // the two deletes would otherwise find the entry still mirrored and POST
        // a capture the user had just discarded. The two failure directions are
        // not equally bad: mirror-gone-but-queued is annoying, honest and
        // recoverable — the words are on screen and it is re-mirrored on next
        // mount — while queued-gone-but-mirrored is a silent save after an
        // explicit refusal.
        await deleteMirrored(mirror.current, stillQueued);
        const result = discardCapture(store, stillQueued);
        broadcast();
        if (!result.ok) {
          announce("storage-unavailable");
          return "storage-unavailable";
        }
        for (const key of stillQueued) awaiting.current.delete(key);
        return "discarded";
      } finally {
        for (const key of stillQueued) claimed.current.delete(key);
      }
    },
    [announce],
  );

  const { mine, stranded } = partitionQueue(queue, workspaceId);

  return {
    mine,
    stranded,
    flushing: flightCount > 0,
    inFlight: (clientKey) => inFlightKeys.current.has(clientKey),
    enqueueCapture,
    flush,
    discard,
    announcement,
    clearAnnouncement: () => setAnnouncement(null),
  };
}

/** The mark a non-successful outcome leaves, for the mirror's copy. */
function markOf(outcome: FlushOutcome) {
  return outcome === "account-revoked" || outcome === "session-expired"
    ? outcome
    : undefined;
}

/**
 * Ask for a background flush. Silent no-op where Background Sync does not exist.
 *
 * `registration.sync.register` **no-ops on Safari and Firefox**, so the feature
 * degrades to the foreground triggers there with no code branch of its own beyond
 * this capability check — the words are just as durable and just as unlosable,
 * they save on the next open.
 */
async function registerSync(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const sync = (
      registration as ServiceWorkerRegistration & {
        sync?: { register: (tag: string) => Promise<void> };
      }
    ).sync;
    if (!sync) return;
    await sync.register(CAPTURE_SYNC_TAG);
  } catch {
    // A rejected registration costs the background flush and nothing else.
  }
}
