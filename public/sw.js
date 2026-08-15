// Service worker for dlectroflow. Two jobs, and they are unrelated:
//
//  1. hosting notifications (showNotification / notificationclick);
//  2. #175 — draining the offline capture queue through Background Sync, which
//     is the ONLY path that flushes a queued brain dump while no tab is open.
//
// Design: docs/design/specs/2026-08-11-offline-capture-queue-design.md.
//
// ⚠️ This file is served as a static asset and is NOT bundled, so it can import
// nothing. Every constant below is repeated from src/lib/capture-mirror.ts, and
// src/lib/capture-sync-worker.test.ts asserts the two agree — the drift it
// guards has no symptom, because a worker reading a renamed store finds an empty
// database for ever while the foreground flush keeps working and nothing on
// screen changes.

/** Mirrors CAPTURE_MIRROR_DB_NAME. Same string as the localStorage key. */
const MIRROR_DB_NAME = "df-capture-queue";
/** Mirrors CAPTURE_MIRROR_DB_VERSION. */
const MIRROR_DB_VERSION = 1;
/** Mirrors CAPTURE_MIRROR_STORE, keyed on clientKey so a put upserts. */
const MIRROR_STORE = "captures";
/** Mirrors CAPTURE_SYNC_TAG, registered by the page on every enqueue. */
const SYNC_TAG = "capture-flush";
/** The plain route, because a worker cannot replay a Next server action. */
const FLUSH_URL = "/api/braindump";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Focus (or open) the app when a reminder is clicked.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) return client.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow("/");
      }),
  );
});

// ── #175: Background Sync ───────────────────────────────────────────────────
//
// The browser retries a `sync` event only if the promise given to
// `event.waitUntil()` REJECTS. Resolve and the platform considers the work done
// and will not come back. So the exit condition is "no retryable work remains",
// NOT "the mirror is empty" — see `drainMirror`.
self.addEventListener("sync", (event) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(drainMirror());
});

/**
 * Is this stored row really a mirrored capture?
 *
 * The mirror is writable by anything on the origin and this worker POSTs
 * whatever it finds, so an unvalidated read is a request built from a value
 * nothing in this app wrote. Deliberately a copy of `isMirroredCapture` in
 * src/lib/capture-mirror.ts: nothing can be imported here, and a worker that
 * skipped validation because "the app already validates" would be trusting a
 * store the app is not the only writer of.
 */
function isCapture(row) {
  return (
    typeof row === "object" &&
    row !== null &&
    typeof row.clientKey === "string" &&
    row.clientKey.length > 0 &&
    typeof row.text === "string" &&
    row.text.length > 0 &&
    typeof row.workspaceId === "string" &&
    row.workspaceId.length > 0 &&
    // ⚠️ These last two were MISSING while the docblock above claimed this was a
    // copy of `isMirroredCapture` (Duo review round 5 on !348, which found the
    // `blockedBy` half). Not harmful as it stood — a malformed `blockedBy` just
    // failed the `=== "account-revoked"` comparison below and fell through to a
    // retry — but the claimed parity IS the invariant this file rests on, because
    // it can import nothing and a drift here has no symptom.
    //
    // Finiteness rather than `typeof number`, for the reason `isQueuedCapture`
    // gives: `NaN` compares false against everything, so a corrupt value becomes
    // permanent rather than loud.
    typeof row.capturedAt === "number" &&
    Number.isFinite(row.capturedAt) &&
    // The two `CAPTURE_BLOCK_REASONS`, spelled out because nothing can be
    // imported here. Both of them: allowing only `account-revoked` would look
    // stricter and would silently drop every 409'd capture out of the background
    // path, which is the opposite of what this validator is for.
    (row.blockedBy === undefined ||
      row.blockedBy === "session-expired" ||
      row.blockedBy === "account-revoked")
  );
}

/** Open the mirror. Resolves `null` for every failure — never rejects. */
function openMirror() {
  return new Promise((resolve) => {
    let request;
    try {
      request = self.indexedDB.open(MIRROR_DB_NAME, MIRROR_DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      try {
        const db = request.result;
        if (!db.objectStoreNames.contains(MIRROR_STORE)) {
          db.createObjectStore(MIRROR_STORE, { keyPath: "clientKey" });
        }
      } catch {
        // Surfaces as onerror below; swallowed so the handler cannot throw
        // into the platform.
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/** Every valid row in the mirror. `[]` for every failure. */
function readMirror(db) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(MIRROR_STORE, "readonly");
      const request = tx.objectStore(MIRROR_STORE).getAll();
      request.onsuccess = () => {
        const rows = request.result;
        resolve(Array.isArray(rows) ? rows.filter(isCapture) : []);
      };
      request.onerror = () => resolve([]);
      tx.onerror = () => resolve([]);
      tx.onabort = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/**
 * One validated row by key. `null` for absent, invalid, or any failure.
 *
 * ⚠️ **Keyed rather than a `getAll` filtered down**, and on this path that is a
 * real cost rather than a style preference: the drain loop re-reads per entry, so
 * a whole-store scan each time is up to `CAPTURE_QUEUE_MAX_ITEMS` scans of as much
 * as 64 KB per `sync` — on a battery-sensitive background task. Duo review round 7
 * on `!348` measured the shape; `fake-idb`'s `scans` counter pins it.
 *
 * Validated for the same reason `readMirror` validates: the mirror is writable by
 * anything on the origin and this worker `POST`s what it finds, so one row read by
 * key is no more trustworthy than the whole store.
 */
function readMirrorEntry(db, key) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(MIRROR_STORE, "readonly");
      const request = tx.objectStore(MIRROR_STORE).get(key);
      request.onsuccess = () => {
        const row = request.result;
        resolve(isCapture(row) ? row : null);
      };
      request.onerror = () => resolve(null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * One write transaction. Resolves on `oncomplete`, not on the request.
 *
 * A `put` calls back as soon as the value is accepted and the transaction can
 * still abort afterwards, so resolving on the request would report a write that
 * did not durably happen.
 */
function writeMirror(db, work) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(MIRROR_STORE, "readwrite");
      let settled = false;
      const answer = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      tx.oncomplete = () => answer(true);
      tx.onerror = () => answer(false);
      tx.onabort = () => answer(false);
      work(tx.objectStore(MIRROR_STORE));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Flush one capture. Returns `"done"`, `"terminal"` or `"retry"`.
 *
 * ⚠️ **A terminal mark needs the status line AND the parsed body to agree, and
 * this must stay identical to `outcomeOf` in src/lib/use-capture-queue.ts.**
 * Either control alone is reachable from something the app did not author:
 *
 *  * body alone — a proxy error page, a self-host's ingress, a misconfigured
 *    upstream answering `500` with a JSON body of its own that happens to carry
 *    `status: "account-revoked"`;
 *  * status alone — a 403 from an auth proxy, an ingress rule or a corporate
 *    filter in front of the route.
 *
 * Either one would permanently mark a perfectly good capture "this account can no
 * longer save", whose only exit is the user deliberately destroying the words.
 * The body check was here from the start; the status check is Duo review round 2
 * on `!348`, which found the two flush paths disagreeing about the same response
 * — the foreground read it as retryable and the worker as terminal.
 *
 * **Both directions are pinned by tests** (`capture-sync-worker.test.ts`), and
 * that matters more than usual here: dropping either half leaves a guard that
 * reads as complete, and the failure it lets through is silent and permanent.
 *
 * Everything unrecognised is `"retry"`, deliberately: a wasted retry is
 * recoverable and a dropped capture is not.
 */
async function flushOne(entry) {
  let response;
  try {
    response = await fetch(FLUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Only the three fields the route's contract names. `capturedAt` is the
      // strip's age display and the route neither reads nor accepts it.
      body: JSON.stringify({
        clientKey: entry.clientKey,
        text: entry.text,
        workspaceId: entry.workspaceId,
      }),
      // The worker's own fetch carries the registering origin, which is the
      // matching-Origin case the route's CSRF check already allows. Credentials
      // are needed for the session cookie the route resolves the workspace from.
      credentials: "include",
    });
  } catch {
    // Network failure, which is the ordinary case this whole feature is for.
    return "retry";
  }

  if (response.status === 201 || response.status === 200) return "done";

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  // ⚠️ `account-revoked` is the ONLY mark this worker may write. A
  // `session-expired` mark is useless without `blockedUnder` — "the workspace
  // the CLIENT was running under" — and the worker has no session to resolve, so
  // it cannot compute one. A 409 it sees is therefore left unmarked and simply
  // retried; the next foreground flush records it properly.
  //
  // The `403` comparand is the same one `outcomeOf` uses, deliberately spelled
  // out rather than derived: this file can import nothing, so agreement between
  // the two paths is carried by the tests and by this note.
  if (response.status === 403 && body && body.status === "account-revoked") {
    return "terminal";
  }
  return "retry";
}

/**
 * Drain the mirror and decide the promise.
 *
 * | After a pass | waitUntil | Why |
 * |---|---|---|
 * | mirror empty | resolve | nothing to come back for |
 * | anything retryable left (5xx, network, 401, **409**) | reject | the only way to get another attempt with no tab open |
 * | everything left is `account-revoked` | resolve | ⚠️ rejecting here is the bug — those can never flush, so the platform would retry on its own schedule for ever, burn battery and give up anyway, while the remedy (Discard) is a foreground control |
 * | mixed | reject | the retryable ones justify another attempt; the blocked ones are skipped each pass |
 *
 * **Failures are per-entry, not per-pass.** One capture's 5xx must not stop the
 * pass trying the rest, or a single stuck entry blocks the queue behind it —
 * the head-of-line failure this design's premise refuses.
 */
async function drainMirror() {
  const db = await openMirror();
  // No mirror, no work, and nothing a retry would fix.
  if (!db) return;

  const keys = (await readMirror(db)).map((row) => row.clientKey);
  if (keys.length === 0) return;

  const saved = [];
  const terminal = [];
  let retryable = 0;

  // ⚠️ **The keys are the plan; every row is re-read against the live mirror.**
  //
  // `flushOne` awaits a network round-trip, so a snapshot taken once is stale for
  // every row after the first. **`sync` can fire while a tab is open**, so this
  // needs no closed-tab premise: the connection returns, the platform fires the
  // sync, and the user is looking at the strip. A Discard deletes the mirror row
  // **first** — deliberately, the ordering this design calls "the whole fix" — so a
  // removal inside that window is exactly what this loop meets, and its snapshot
  // cannot see it. POSTing the stale copy resurrects a capture the user explicitly
  // destroyed, and a never-saved capture has no `200` duplicate to absorb it, so
  // the row is CREATED.
  //
  // Reported by Duo review round 5 on !348, against the rule the spec's step 5
  // states for the foreground pass. The two paths cannot share code — this file
  // imports nothing — so the rule is carried by tests on both sides and this note,
  // the same arrangement `flushOne`'s terminal-mark conjunction uses.
  for (const key of keys) {
    const entry = await readMirrorEntry(db, key);
    // Discarded or already flushed while this pass was mid-flight. Not counted as
    // retryable: there is nothing left to come back for.
    if (!entry) continue;
    // Skipped rather than flushed: a terminal entry must not be POSTed on every
    // pass for the life of the browser profile.
    if (entry.blockedBy === "account-revoked") continue;

    const outcome = await flushOne(entry);
    if (outcome === "done") saved.push(entry.clientKey);
    else if (outcome === "terminal") terminal.push(entry);
    else retryable += 1;
  }

  if (saved.length > 0) {
    // The worker cannot write localStorage, so this removes the entry from the
    // mirror and nothing more: localStorage still lists it as waiting until a
    // foreground tab next runs, at which point reconciliation re-mirrors it, the
    // foreground flush re-POSTs it, and the route answers 200 — already saved —
    // which removes it from both stores. The clientKey column is what makes that
    // safe; without it the worker's success would be a duplicate row on the next
    // open. Cost: one redundant POST per worker-flushed capture, paid once.
    await writeMirror(db, (store) => {
      for (const key of saved) store.delete(key);
    });
  }

  if (terminal.length > 0) {
    // The worker's own first-failure case. Recorded in the mirror — which it CAN
    // write — and propagated into localStorage by mount-time reconciliation.
    await writeMirror(db, (store) => {
      for (const entry of terminal) {
        store.put({ ...entry, blockedBy: "account-revoked" });
      }
    });
  }

  if (retryable > 0) {
    throw new Error("capture-flush: retryable work remains");
  }
}
