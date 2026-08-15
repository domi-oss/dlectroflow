"use client";

import {
  useCallback,
  useEffect,
  useMemo,
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
 * ── ⚠️ Residual, NOT fixed: another tab's Discard is undone by this one ───────
 *
 * The re-enqueue infers "clobbered" from **absence**, and a Discard in another tab
 * is absence too. `claimed` and `inFlightKeys` are per-tab refs, so neither can
 * see it: with the inbox open twice, pressing *Discard for good* in one tab has
 * the other put the capture straight back and save it on the next reconnect —
 * words the user explicitly destroyed landing in their inbox. Found while
 * resolving Duo review round 2 on `!348`, which reported the in-tab window rather
 * than this one; measured, not reasoned about.
 *
 * **Left open deliberately, because the fix is a design decision and not a patch.**
 * The cheapest correct discriminator is already in the tree and needs no new
 * storage: **the mirror.** `discard` deletes the IndexedDB entry *before* the
 * `localStorage` one — an ordering this file already calls "the whole fix" — while
 * a clobber writes only `localStorage`. So *"still in the mirror"* means *"nobody
 * removed this on purpose"*. Two things make it more than a one-line change and
 * both want a reviewer: it makes this handler asynchronous (safe in principle —
 * the re-enqueue is a recovery after the fact, never on a critical path, and
 * `enqueue` treats a repeated `clientKey` as the same capture so a doubled
 * recovery is idempotent), and it needs a stated answer for a browser with no
 * IndexedDB, where nothing can be told apart. That answer should be **fail open**
 * — re-enqueue, keeping today's behaviour and today's bug — because this module's
 * governing rule is that a wasted retry is recoverable and a dropped capture is
 * not.
 *
 * What IS fixed: a discard no longer leaves a recovery claim behind on any arm,
 * so the single-tab version of this — a confirm resolving against an entry that
 * has already left the queue — cannot resurrect anything.
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
 * How long one entry's `POST` is given before it is abandoned and left queued.
 *
 * ⚠️ **Moved here from `inbox-view.tsx`'s `CAPTURE_TIMEOUT_MS` by #175's client
 * half**, keeping the same 10s value that `shopping-list.tsx`,
 * `breakdown-chat.tsx`, `library-done-delete.tsx`, `use-save-status.tsx` and
 * `focus-timer.tsx` all cite as the house bound for this class of call. Their
 * comments were repointed here rather than left naming a constant that no longer
 * exists — a citation goes on reading authoritatively after it stops being true.
 *
 * **It is load-bearing rather than tidy, and the copy already promises it.** The
 * third failure mode is silence, not a rejection — a pod rolling mid-request, a
 * connection that never closes. Unbounded, that entry's key stays in
 * `inFlightKeys` for the life of the tab, so `flushing` never goes false, the
 * polite region says *"Saving what's waiting…"* for ever, and every Discard of
 * that entry is refused with *"This one is being saved right now. Give it a
 * moment and try again"* — a wait for something that will not happen.
 *
 * **And here the abort is real, which it could not be for the write this
 * replaced.** A server action cannot be aborted from the client, so
 * `withActionTimeout` only ever bounded the UI's patience while the request
 * carried on — which is why #210 had to carry a `timedOut` flag meaning "whether
 * it landed is unknown". A route handler takes an `AbortSignal`, and a write that
 * lands anyway is answered `200` on the retry because of `clientKey`. So the
 * unknown-outcome state this design replaced does not exist here at all.
 */
export const CAPTURE_FLUSH_TIMEOUT_MS = 10_000;

/**
 * A per-request timeout signal, or nothing where the platform has no
 * `AbortSignal.timeout`.
 *
 * Degrading to an unbounded request is the correct fallback: it is what the
 * previous implementation did on every browser, and losing the bound costs a
 * stuck "Saving…" while refusing to send at all would cost the capture.
 */
function flushSignal(): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(CAPTURE_FLUSH_TIMEOUT_MS);
  } catch {
    return undefined;
  }
}

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
  flush: () => Promise<CaptureFlushResult>;
  /** Throw entries away at the user's request. Mirror first, then `localStorage`. */
  discard: (clientKeys: readonly string[]) => Promise<DiscardOutcome>;
  /** The last refusal to ANNOUNCE, with a token that changes on every occurrence. */
  announcement: {
    reason: EnqueueRefusal | DiscardOutcome;
    token: number;
  } | null;
  /** Drop the announcement, so an identical next one is a genuine change. */
  clearAnnouncement: () => void;
  /**
   * Bumped once per flush pass that saved anything, by ANY trigger.
   *
   * The inbox needs it because three of the four triggers are the hook's own —
   * mount, `visibilitychange`, `online` — so the caller never learns about those
   * saves from a return value. Without it a capture that flushes on mount leaves
   * the queue, the strip stops mentioning it, and **nothing appears in the list**
   * until the next unrelated interaction: the words look destroyed at the exact
   * moment they became safe, which is #210's defect with the sign flipped.
   *
   * A counter rather than a boolean or a callback: the consumer's reaction is
   * `router.refresh()`, so what it needs is "something changed since I last
   * looked", and an effect keyed on a number gives that with no subscription to
   * tear down. Starts at 0 and only ever increases.
   */
  savedTicket: number;
};

export type CaptureEnqueueResult =
  | {
      ok: true;
      /**
       * The key this capture was stored under, so the caller can ask whether
       * **these** words reached the server rather than whether the pass saved
       * anything. `submit()` shows "captured ✓" off it, and a confirmation about
       * the wrong capture is the unverifiable promise #210 exists to remove.
       */
      clientKey: string;
    }
  | { ok: false; reason: EnqueueRefusal };

/**
 * Which captures a flush pass got onto the server, by `clientKey`.
 *
 * `duplicate` (200) counts as saved and that is deliberate: the row exists, which
 * is the only thing the caller is deciding on. The distinction matters inside the
 * pass — it is why a replayed capture is not an error — and nowhere outside it.
 */
export type CaptureFlushResult = { saved: readonly string[] };

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
  const [savedTicket, setSavedTicket] = useState(0);
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
      //
      // ⚠️ **It infers "clobbered" from ABSENCE, and absence has three causes.**
      // The two guards below are how the other two are told apart, and each one
      // reads as redundant while the other stands — see the residual note in this
      // module's docblock before removing either.
      for (const [key, capture] of awaiting.current) {
        if (present.has(key)) continue;
        // A capture whose flush is outstanding may legitimately have been removed
        // by ANOTHER tab's successful flush of the same key, so re-adding it would
        // resurrect something already saved. The idempotency key makes the
        // opposite mistake cheap — a duplicate POST answered 200 — so the entry is
        // only put back while nothing is in flight for it.
        if (inFlightKeys.current.has(key)) continue;
        // The third cause: the user asked for these words to be thrown away, and
        // `discard` holds the claim across its mirror delete. Putting them back is
        // the "silent save after an explicit refusal" that `discard`'s mirror-first
        // ordering exists to prevent, arriving by a different door — and it is
        // strictly worse than the flush case above, because a never-saved capture
        // has no `200` duplicate to absorb the re-POST. It is created.
        //
        // Duo review round 2 on `!348` asked for exactly this guard. Honest note
        // on its status: the window is **not reachable today**, because
        // `discardCapture`, `broadcast()` and the `awaiting` purge all run in one
        // synchronous block after that await, so anything re-added is removed
        // again before control returns. One extra `await` between them — an
        // ordinary future edit — makes it durable with nothing going red, which is
        // why the guard is here rather than an argument in a comment.
        if (claimed.current.has(key)) continue;
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

  const flush = useCallback(async (): Promise<CaptureFlushResult> => {
    const store = currentStore();
    const saved: string[] = [];
    if (!store) return { saved };
    // ⚠️ **The keys are the plan; every ENTRY is re-read against live storage.**
    //
    // `await fetch` below yields for as long as a network round-trip, so a
    // snapshot taken once is stale for every entry after the first — and the
    // window is not a narrow one: the two-step confirm is *"a human pause of
    // exactly the length a flush trigger needs"*, which is this module's own
    // reason for re-checking inside `discard`.
    //
    // `claimed` bridges a discard's `await` and `inFlightKeys` bridges a POST, but
    // a discard that has **completed** holds neither — and its entry is still in
    // the snapshot. Flushing it POSTs words the user destroyed, and a never-saved
    // capture has no `200` duplicate to absorb it, so the row is *created*: the
    // "silent save after an explicit refusal" that `discard`'s mirror-first
    // ordering exists to prevent, arriving from the flush side. Single tab, one
    // press — **not** the two-tab residual recorded above as `#267`.
    //
    // Re-reading the whole entry rather than testing presence is deliberate: it
    // also picks up a `blockedBy` a concurrent pass or the mirror carve-out wrote
    // while this one waited, so a terminal mark is honoured on the first entry
    // that learns it instead of one pass later.
    for (const key of readQueue(store).map((c) => c.clientKey)) {
      const capture = readQueue(store).find((c) => c.clientKey === key);
      // Discarded, expired or already saved while this pass was mid-flight.
      if (capture === undefined) continue;
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
            signal: flushSignal(),
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
          saved.push(capture.clientKey);
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
    // Bumped for the pass, not per entry: the consumer's reaction is one
    // `router.refresh()`, and a counter that moved three times would buy three
    // refetches of the same list.
    if (saved.length > 0) setSavedTicket((n) => n + 1);
    return { saved };
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
      return { ok: true, clientKey: capture.clientKey };
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
        // ⚠️ Drop the recovery claim even though nothing is being removed. The
        // entry left the queue while the confirm was open, so `awaiting` still
        // held it — and the NEXT `storage` event would then re-enqueue words the
        // user had just asked to destroy, permanently. That re-POST is created
        // rather than answered `200`, because this capture never saved.
        for (const key of clientKeys) awaiting.current.delete(key);
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
        const mirrored = mirror.current;
        const clearedMirror = await deleteMirrored(mirrored, stillQueued);
        // ⚠️ **And the ordering only delivers that if the RESULT is read.** An
        // aborted `readwrite` transaction leaves the row mirrored — storage
        // pressure on a phone, a version change from another tab, an evicted
        // origin — and removing it from `localStorage` anyway produces exactly the
        // direction ranked unacceptable above: the strip stops showing the words,
        // the user believes they are gone, and the worker `POST`s whatever it still
        // finds. Refusing keeps the other direction, which is the recoverable one.
        //
        // ⚠️ Only when there WAS a mirror. `writeMirror` answers `false` for a
        // `null` db as well as for an abort, and the two must not be treated alike:
        // with no mirror there is nothing for the worker to find, so refusing would
        // deny a perfectly safe discard on every browser without IndexedDB, in
        // Firefox private browsing, and in the window before `openMirror` resolves.
        if (mirrored !== null && !clearedMirror) {
          announce("storage-unavailable");
          return "storage-unavailable";
        }
        const result = discardCapture(store, stillQueued);
        broadcast();
        if (!result.ok) {
          announce("storage-unavailable");
          return "storage-unavailable";
        }
        // Every key the user named, not only the ones still queued: any that were
        // already gone are the `already-saved` case per key, and leaving them in
        // `awaiting` is the same resurrection one entry at a time.
        for (const key of clientKeys) awaiting.current.delete(key);
        return "discarded";
      } finally {
        for (const key of stillQueued) claimed.current.delete(key);
      }
    },
    [announce],
  );

  /**
   * Memoised, and it is a correctness property for the consumer rather than a
   * micro-optimisation.
   *
   * `partitionQueue` allocates two fresh arrays per call, so without this every
   * render of whatever mounts the hook handed the strip new identities — including
   * renders that have nothing to do with the queue, which in `inbox-view.tsx`
   * means every keystroke in the controlled capture field. Anything downstream
   * that keys an effect on `mine`/`stranded` therefore fired constantly, and one
   * did: the strip's focus hand-off re-stole focus onto an open Discard confirm
   * (Duo review round 2 on `!348`).
   *
   * The strip's own fix is the real one — an effect must be correct however often
   * it runs, and `onReturnFocus` alone can still change identity. This is the other
   * half: `queue` is already referentially stable per raw string (see
   * `getSnapshot`), so these can be too, and a derived value that changes identity
   * without changing value is a trap laid for the next reader.
   */
  const { mine, stranded } = useMemo(
    () => partitionQueue(queue, workspaceId),
    [queue, workspaceId],
  );

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
    savedTicket,
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
