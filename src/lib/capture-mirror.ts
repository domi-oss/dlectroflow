// #175 — the IndexedDB mirror of the capture queue, for the service worker.
//
// Design: `docs/design/specs/2026-08-11-offline-capture-queue-design.md`, under
// *"Reconciliation on mount runs in both directions"*.
//
// ── Why there is a second copy of the queue at all ──────────────────────────
//
// The worker cannot read `localStorage`, and Background Sync is the only
// mechanism that flushes with no tab open. So the queue is copied into IndexedDB
// **for the worker's benefit only** — a cache of the real thing, never the source
// of truth.
//
// The ordering is the reason this is not simply "use IndexedDB for everything":
// the `localStorage` write completes **synchronously** inside `submit()`, and the
// IndexedDB write is only *initiated* in the same block. The durability guarantee
// is therefore carried entirely by `localStorage`, which is also what the UI
// reads. A tab discarded between the two writes — exactly what Chrome Android
// does — leaves a capture that is durable but invisible to the worker, and
// {@link planMirrorReconciliation}'s second direction is what repairs that. The
// failure mode is a delayed save, never a lost one.
//
// ── Nothing here throws, and nothing here reports a write it did not make ────
//
// Same contract as `capture-queue.ts` and for a stronger reason: this store is
// entirely best-effort. `localStorage` already holds the words, so every failure
// below costs Background Sync and never a capture. Firefox private browsing
// throws from `open`, a corrupt profile aborts a transaction, and a capture bar
// that crashes is worse than one with no background flush.
//
// ── ⚠️ The one field that may flow BACKWARDS, and why it is not a general rule ─
//
// `localStorage` wins on **membership** — which captures exist. `blockedBy` is
// not membership, so it sits outside that rule rather than contradicting it: the
// worker is the only writer that can learn a refusal while no tab is open, and it
// cannot write `localStorage`. A mark present only in the mirror is copied in.
//
// **Only `account-revoked`.** See {@link planMirrorReconciliation} — a
// `session-expired` mark is useless without `blockedUnder`, which the worker
// cannot compute, and accepting one would resurrect a mark that a retryable
// outcome had deliberately cleared. Nothing else may flow that way: a mirror
// entry with no `localStorage` counterpart is still **deleted, never resurrected**,
// because that is the rule stopping the mirror putting back a capture the user
// discarded or already saved.

import {
  CAPTURE_BLOCK_REASONS,
  type CaptureBlockReason,
  type QueuedCapture,
} from "@/lib/capture-queue";

/**
 * The database name, deliberately the same string as the `localStorage` key.
 *
 * One name for one queue: a reader looking at either store, or at a browser's
 * storage inspector, sees the same words and does not have to learn that
 * `df-capture-queue` and some other name are two halves of one thing.
 */
export const CAPTURE_MIRROR_DB_NAME = "df-capture-queue";

/** Bumping this runs `onupgradeneeded` again; the store is created idempotently. */
export const CAPTURE_MIRROR_DB_VERSION = 1;

/** One object store, keyed on `clientKey` so a re-mirror upserts. */
export const CAPTURE_MIRROR_STORE = "captures";

/**
 * The Background Sync tag registered on every enqueue and handled in
 * `public/sw.js`.
 *
 * ⚠️ **`public/sw.js` is not bundled, so it cannot import any of these four
 * constants** and repeats them as literals. `capture-sync-worker.test.ts` asserts
 * the two surfaces agree, which is the only thing standing between a renamed
 * store and a worker that reads an empty database for ever — a failure with no
 * symptom, because the foreground flush would keep working.
 */
export const CAPTURE_SYNC_TAG = "capture-flush";

/**
 * What the worker needs, and nothing else.
 *
 * ⚠️ **`blockedBy` is included and that is load-bearing.** The mirror is
 * described as a cache, so a reader could reasonably mirror only the fields the
 * `POST` body needs — which would remove the worker's only way to tell its two
 * `waitUntil` exits apart, and put it straight back into rejecting for ever over
 * captures that can never flush.
 *
 * ⚠️ **`blockedUnder` and `unresolvableSince` are deliberately NOT mirrored.**
 * Both are written from the live session's resolved workspace, which the worker
 * has none of; it never expires anything and never chooses copy. Mirroring them
 * would add a second at-rest copy of data with no reader, which is a privacy cost
 * for nothing.
 */
export type MirroredCapture = {
  clientKey: string;
  text: string;
  workspaceId: string;
  capturedAt: number;
  blockedBy?: CaptureBlockReason;
};

/** The three things reconciliation decides. Each is asserted separately. */
export type MirrorPlan = {
  /** Mirror keys with no `localStorage` counterpart. Deleted, never revived. */
  remove: string[];
  /** Entries the mirror is missing or holds a stale copy of. */
  put: MirroredCapture[];
  /** Marks the worker learned while no tab was open, to copy into `localStorage`. */
  marks: { clientKey: string; blockedBy: CaptureBlockReason }[];
};

/** The mirrored projection of one queued capture. */
export function mirroredFrom(capture: QueuedCapture): MirroredCapture {
  const entry: MirroredCapture = {
    clientKey: capture.clientKey,
    text: capture.text,
    workspaceId: capture.workspaceId,
    capturedAt: capture.capturedAt,
  };
  // Assigned rather than spread with `undefined`, so an unrefused capture has no
  // `blockedBy` key at all. `structuredClone` (which is what IndexedDB does to
  // the value) keeps an explicit `undefined`, and an entry carrying the key would
  // read as different from one that never had it — which would make every mount
  // re-mirror the whole queue.
  if (capture.blockedBy !== undefined) entry.blockedBy = capture.blockedBy;
  return entry;
}

/** Is this stored value really a `MirroredCapture`? */
function isMirroredCapture(value: unknown): value is MirroredCapture {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.clientKey === "string" &&
    c.clientKey.length > 0 &&
    typeof c.text === "string" &&
    c.text.length > 0 &&
    typeof c.workspaceId === "string" &&
    c.workspaceId.length > 0 &&
    typeof c.capturedAt === "number" &&
    Number.isFinite(c.capturedAt) &&
    (c.blockedBy === undefined ||
      CAPTURE_BLOCK_REASONS.some((reason) => reason === c.blockedBy))
  );
}

/**
 * The mark the two stores should settle on, given what each holds.
 *
 * `account-revoked` wins from **either** side — that is the carve-out, and the
 * same precedence `capture-queue.ts` applies to a flush outcome, restated as a
 * merge so the carve-out cannot downgrade anything.
 *
 * ⚠️ **Anything weaker is taken from `localStorage` alone, and the mirror's copy
 * is treated as stale rather than as news.** A `session-expired` mark in the
 * mirror and none in `localStorage` cannot mean the worker learned something: the
 * worker is forbidden from writing that mark, because it needs `blockedUnder` to
 * mean anything and the worker has no session to compute one. It can only mean
 * `localStorage` cleared it — which a retryable outcome does deliberately, having
 * proved the session is no longer the obstacle. Propagating it back would
 * resurrect that mark and re-offer a sign-in that has already happened.
 */
function settledMark(
  stored: CaptureBlockReason | undefined,
  mirror: CaptureBlockReason | undefined,
): CaptureBlockReason | undefined {
  if (stored === "account-revoked" || mirror === "account-revoked") {
    return "account-revoked";
  }
  return stored;
}

/**
 * What has to happen for the two stores to agree — **both directions, and they
 * are separately asserted.**
 *
 * Only the first is obvious, and stopping there leaves a real hole: the mirror
 * write settles after the synchronous `localStorage` write, so a tab discarded
 * between the two leaves a capture durable but invisible to the worker for ever.
 * It is not lost — the foreground flush still finds it on next open — but it falls
 * silently out of Background Sync, the only path that works while no tab is open,
 * so coverage would be an arbitrary subset of the queue and **no test asserting
 * "the item survived" could see it.**
 *
 * The delete direction passes on its own against a one-way implementation, which
 * is how that gap survived the spec's first draft.
 */
export function planMirrorReconciliation(
  queue: QueuedCapture[],
  mirrored: MirroredCapture[],
): MirrorPlan {
  const byKey = new Map(mirrored.map((entry) => [entry.clientKey, entry]));
  const live = new Set(queue.map((c) => c.clientKey));

  const plan: MirrorPlan = { remove: [], put: [], marks: [] };

  // Direction 1 — membership. `localStorage` wins, and "wins" means the mirror
  // entry goes: it was already saved, or the user discarded it.
  for (const entry of mirrored) {
    if (!live.has(entry.clientKey)) plan.remove.push(entry.clientKey);
  }

  for (const capture of queue) {
    const mirror = byKey.get(capture.clientKey);

    // ⚠️ The carve-out, and it is narrower than "the mirror can be newer". Only
    // `account-revoked` may flow back, because it is terminal on the status alone
    // — which is exactly why it is the one mark a worker with no session can be
    // trusted with. A `session-expired` mark needs `blockedUnder` to mean
    // anything, and accepting one from the mirror would RESURRECT a mark a
    // retryable outcome had cleared, re-offering a sign-in that already happened.
    if (
      mirror?.blockedBy === "account-revoked" &&
      capture.blockedBy !== "account-revoked"
    ) {
      plan.marks.push({
        clientKey: capture.clientKey,
        blockedBy: "account-revoked",
      });
    }

    // Direction 2 — a `localStorage` entry the mirror is missing, or holds an
    // out-of-date copy of. The merged mark is written so the mirror cannot lose
    // one, which is what keeps the carve-out from being able to downgrade.
    const wanted = mirroredFrom({
      ...capture,
      blockedBy: settledMark(capture.blockedBy, mirror?.blockedBy),
    });
    if (!mirror || !sameMirrored(mirror, wanted)) plan.put.push(wanted);
  }

  return plan;
}

/** Field-by-field, so a stale text or a stale mark is a re-mirror. */
function sameMirrored(a: MirroredCapture, b: MirroredCapture): boolean {
  return (
    a.clientKey === b.clientKey &&
    a.text === b.text &&
    a.workspaceId === b.workspaceId &&
    a.capturedAt === b.capturedAt &&
    a.blockedBy === b.blockedBy
  );
}

/**
 * Open the mirror, creating the store on first use. **`null` for every failure.**
 *
 * `null` rather than a throw because every caller's fallback is the same and is
 * already correct: carry on without a mirror. Firefox private browsing throws
 * from `open`, a blocked-storage policy refuses it, and an origin at its quota
 * can fail the upgrade.
 */
export function openMirror(
  factory: IDBFactory | undefined | null,
): Promise<IDBDatabase | null> {
  if (!factory) return Promise.resolve(null);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(CAPTURE_MIRROR_DB_NAME, CAPTURE_MIRROR_DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      try {
        if (!db.objectStoreNames.contains(CAPTURE_MIRROR_STORE)) {
          db.createObjectStore(CAPTURE_MIRROR_STORE, { keyPath: "clientKey" });
        }
      } catch {
        // A failed upgrade surfaces as `onerror` below; swallowed here so the
        // handler itself cannot throw into the platform.
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/**
 * Everything the mirror holds, **validated**.
 *
 * The mirror is writable by anything on the origin and the worker `POST`s
 * whatever it finds, so an unvalidated read is a request built from a value
 * nothing in this app wrote. Entry-level, like `readQueue`: one malformed row
 * loses one capture from the *background* path, where rejecting the whole store
 * would lose the lot.
 */
export function readMirrored(
  db: IDBDatabase | null,
): Promise<MirroredCapture[]> {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(CAPTURE_MIRROR_STORE, "readonly");
      const request = tx.objectStore(CAPTURE_MIRROR_STORE).getAll();
      request.onsuccess = () => {
        const rows: unknown = request.result;
        resolve(Array.isArray(rows) ? rows.filter(isMirroredCapture) : []);
      };
      request.onerror = () => resolve([]);
      tx.onerror = () => resolve([]);
      tx.onabort = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/** Upsert entries. `false` when the transaction did not complete. */
export function putMirrored(
  db: IDBDatabase | null,
  entries: MirroredCapture[],
): Promise<boolean> {
  return writeMirror(db, (store) => {
    for (const entry of entries) store.put(entry);
  });
}

/** Remove entries by key. `false` when the transaction did not complete. */
export function deleteMirrored(
  db: IDBDatabase | null,
  clientKeys: readonly string[],
): Promise<boolean> {
  return writeMirror(db, (store) => {
    for (const key of clientKeys) store.delete(key);
  });
}

/**
 * One write transaction, resolved on `oncomplete` and **never on the individual
 * request**.
 *
 * That is the difference between reporting a write and reporting a durable one:
 * an IndexedDB `put` calls back as soon as the value is accepted, while the
 * transaction can still abort afterwards. Resolving on the request would report
 * the same false success `applyFlushOutcome` was fixed for on `!334`.
 */
function writeMirror(
  db: IDBDatabase | null,
  work: (store: IDBObjectStore) => void,
): Promise<boolean> {
  if (!db) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(CAPTURE_MIRROR_STORE, "readwrite");
      let settled = false;
      const answer = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      tx.oncomplete = () => answer(true);
      tx.onerror = () => answer(false);
      tx.onabort = () => answer(false);
      work(tx.objectStore(CAPTURE_MIRROR_STORE));
    } catch {
      resolve(false);
    }
  });
}
