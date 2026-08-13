import { describe, it, expect, vi, afterEach } from "vitest";
import {
  CAPTURE_QUEUE_STORAGE_KEY,
  CAPTURE_QUEUE_MAX_ITEMS,
  CAPTURE_QUEUE_MAX_BYTES,
  CAPTURE_BLOCK_REASONS,
  byteLength,
  readQueue,
  enqueue,
  applyFlushOutcome,
  newClientKey,
  type QueueStore,
  type QueuedCapture,
} from "@/lib/capture-queue";

function memoryStore(seed: Record<string, string> = {}): QueueStore {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** A store whose `setItem` always throws, like Safari private mode or a full quota. */
function throwingStore(seed: Record<string, string> = {}): QueueStore {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: () => {
      const e = new Error("quota");
      e.name = "QuotaExceededError";
      throw e;
    },
    removeItem: (k) => void map.delete(k),
  };
}

/**
 * A store that refuses EVERY write, `removeItem` included.
 *
 * `throwingStore` above models a full quota, where only `setItem` throws. This
 * models a blocked-storage policy, and it is the only way to exercise the
 * `removeItem` branch of `write` — the one a flush takes when it empties the
 * queue, which is precisely the write whose failure used to be invisible.
 */
function writeBlockedStore(seed: Record<string, string> = {}): QueueStore {
  const map = new Map(Object.entries(seed));
  const refuse = (): never => {
    const e = new Error("storage is blocked by policy");
    e.name = "SecurityError";
    throw e;
  };
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: refuse,
    removeItem: refuse,
  };
}

function capture(over: Partial<QueuedCapture> = {}): QueuedCapture {
  return {
    clientKey: "k1",
    text: "ring mum about the boiler",
    workspaceId: "ws-owner",
    capturedAt: 1_000,
    ...over,
  };
}

function seeded(items: QueuedCapture[]): QueueStore {
  return memoryStore({ [CAPTURE_QUEUE_STORAGE_KEY]: JSON.stringify(items) });
}

/**
 * One origin, two tabs. `otherTabWrites` commits **once**, immediately after
 * this tab's first read has returned its value.
 *
 * That is a faithful model of the only window a synchronous read-modify-write
 * leaves open, and of what makes it a race rather than a wide one: this tab's
 * `getItem` hands back a snapshot, the other tab commits, and this tab is still
 * busy checking the caps and serialising as much as 64 KB before its own
 * `setItem` lands. `localStorage` has no compare-and-swap, so nothing in the
 * platform stops the second write from dropping the first.
 *
 * The read deliberately returns the value from BEFORE the other tab's write —
 * the point of the fixture is that this tab is holding something already stale.
 * The other tab is handed the plain store so its own writes are ordinary ones.
 */
function contendedStore(
  seed: QueuedCapture[],
  otherTabWrites: (store: QueueStore) => void,
): QueueStore {
  const map = new Map<string, string>();
  if (seed.length > 0) {
    map.set(CAPTURE_QUEUE_STORAGE_KEY, JSON.stringify(seed));
  }
  const committed: QueueStore = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  let fired = false;
  return {
    getItem: (k) => {
      const asOfThisRead = committed.getItem(k);
      if (!fired) {
        fired = true;
        otherTabWrites(committed);
      }
      return asOfThisRead;
    },
    setItem: (k, v) => committed.setItem(k, v),
    removeItem: (k) => committed.removeItem(k),
  };
}

describe("capture queue — reading (#175)", () => {
  it("is empty when nothing has been stored", () => {
    expect(readQueue(memoryStore())).toEqual([]);
  });

  it("is empty when there is no storage at all (server render, blocked cookies)", () => {
    expect(readQueue(null)).toEqual([]);
    expect(readQueue(undefined)).toEqual([]);
  });

  it("round-trips a capture", () => {
    const store = memoryStore();
    enqueue(store, capture());
    expect(readQueue(store)).toEqual([capture()]);
  });

  // The whole design rests on this read never throwing: a corrupt value must not
  // take the capture bar down with it, because the bar is how you report the
  // problem. Losing a corrupt queue is bad; losing the ability to capture is the
  // bug #175 exists to fix.
  it("recovers from corrupt JSON rather than throwing", () => {
    const store = memoryStore({ [CAPTURE_QUEUE_STORAGE_KEY]: "{not json" });
    expect(readQueue(store)).toEqual([]);
  });

  it("recovers from valid JSON of the wrong shape", () => {
    for (const junk of ['{"a":1}', '"a string"', "42", "null", "[1,2,3]"]) {
      const store = memoryStore({ [CAPTURE_QUEUE_STORAGE_KEY]: junk });
      expect(readQueue(store)).toEqual([]);
    }
  });

  it("drops individual entries that are missing required fields, keeping the good ones", () => {
    const store = memoryStore({
      [CAPTURE_QUEUE_STORAGE_KEY]: JSON.stringify([
        capture({ clientKey: "good" }),
        { text: "no client key" },
        { clientKey: "no-text", workspaceId: "ws", capturedAt: 1 },
        capture({ clientKey: "also-good" }),
      ]),
    });
    expect(readQueue(store).map((c) => c.clientKey)).toEqual([
      "good",
      "also-good",
    ]);
  });

  // One table for all three required strings, because the defect this closes was
  // an INCONSISTENCY between them rather than a missing check in isolation: the
  // guard demanded a non-empty `clientKey` and a non-empty `text` and let a blank
  // `workspaceId` through (Duo review round 7, `!334`).
  //
  // ⚠️ A blank `workspaceId` is not a display problem, and it is the one value here
  // whose absence the module itself can produce — `enqueue` stores whatever
  // `workspaceId` its caller hands it, where `clientKey` comes from this module's
  // own `newClientKey` and `text` is emptiness-checked at the door. Followed
  // through: `parseCapture` in `/api/braindump` refuses a zero-length
  // `workspaceId` with **400**, 400 is outside the status map so
  // `applyFlushOutcome` reads it as `retry`, and `retry` KEEPS the capture and
  // CLEARS any mark. So the entry retries on every flush, for ever, while the strip
  // says it is waiting to save and nothing anywhere says why. The route's own
  // comment asserts the opposite — "a queued capture can never be malformed …
  // `readQueue` returns only entries `isQueuedCapture` accepted" — which is an
  // invariant this guard has to actually hold up.
  it.each([
    ["clientKey", { clientKey: "" }],
    ["text", { text: "" }],
    ["workspaceId", { workspaceId: "" }],
  ])("drops an entry whose %s is present but blank", (_field, over) => {
    const store = memoryStore({
      [CAPTURE_QUEUE_STORAGE_KEY]: JSON.stringify([
        capture({ clientKey: "good" }),
        { ...capture({ clientKey: "junk" }), ...over },
      ]),
    });
    expect(readQueue(store).map((c) => c.clientKey)).toEqual(["good"]);
  });

  // ⚠️ `blockedBy` is not decoration: it selects the strip's copy AND the remedy
  // offered, so a value outside the union drives the strip into a state it has no
  // branch for. Worse than the display bug, a guard that returns `true` here has
  // told the compiler this object is a `QueuedCapture` when it is not, and every
  // exhaustive branch downstream is then built on that. Reachable with no
  // attacker at all: `localStorage` is editable in devtools, survives a version
  // change, and is shared with everything else on the origin.
  it("drops an entry whose blockedBy is not one of the two refusals", () => {
    for (const junk of ["banana", 3, null, "", true, ["session-expired"], {}]) {
      const store = memoryStore({
        [CAPTURE_QUEUE_STORAGE_KEY]: JSON.stringify([
          capture({ clientKey: "good" }),
          { ...capture({ clientKey: "junk" }), blockedBy: junk },
        ]),
      });
      expect(readQueue(store).map((c) => c.clientKey)).toEqual(["good"]);
    }
  });

  // The negative control, and the half that actually matters. A guard that
  // rejected EVERY `blockedBy` would pass the test above while silently losing
  // every capture the server has already refused — which is the same words-lost
  // bug approached from the other side, and the refused ones are precisely the
  // captures that have nowhere else to be.
  it("keeps an unmarked entry and an entry carrying either valid refusal", () => {
    const store = seeded([
      capture({ clientKey: "unmarked" }),
      capture({ clientKey: "expired", blockedBy: "session-expired" }),
      capture({ clientKey: "revoked", blockedBy: "account-revoked" }),
    ]);

    const q = readQueue(store);

    expect(q.map((c) => c.clientKey)).toEqual([
      "unmarked",
      "expired",
      "revoked",
    ]);
    expect(q.map((c) => c.blockedBy)).toEqual([
      undefined,
      "session-expired",
      "account-revoked",
    ]);
  });

  // Asserted through the exported list rather than against two literals, so a
  // third refusal state added to `CAPTURE_BLOCK_REASONS` is covered by this test
  // the moment it exists. The list is the guard's only source; this is the
  // outside check that the pair cannot drift.
  it("accepts every member of CAPTURE_BLOCK_REASONS, the guard's only source", () => {
    const store = seeded(
      CAPTURE_BLOCK_REASONS.map((reason) =>
        capture({ clientKey: reason, blockedBy: reason }),
      ),
    );

    expect(readQueue(store).map((c) => c.blockedBy)).toEqual([
      ...CAPTURE_BLOCK_REASONS,
    ]);
  });

  it("never throws when getItem itself throws", () => {
    const store: QueueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(readQueue(store)).toEqual([]);
  });
});

// `byteLength` is the ruler `CAPTURE_QUEUE_MAX_BYTES` is judged with, and since
// !334 it is exported and `/api/braindump`'s request guard uses the same one. So
// its UTF-8 semantics are a cross-file contract rather than an implementation
// detail: the reason it is shared is that a second, `.length`-based measurement
// on the route side let a non-Latin body past a budget the queue had already
// measured in bytes.
describe("capture queue — the shared byte ruler (#175)", () => {
  it.each([
    ["ASCII, where bytes and code units agree", "hello", 5],
    ["Cyrillic, two bytes per character", "привет", 12],
    ["CJK, three bytes per character", "考考考", 9],
    // An astral character is ONE code point and TWO UTF-16 code units, so this is
    // the case where `.length` over-counts rather than under-counts. Reachable:
    // people put emoji in captures.
    ["an astral emoji, four bytes and two code units", "🧠", 4],
  ])("counts %s", (_why, value, bytes) => {
    expect(byteLength(value)).toBe(bytes);
    // The same number an independent ruler gives, so this pins UTF-8 and not just
    // whatever `TextEncoder` happens to do.
    expect(byteLength(value)).toBe(Buffer.byteLength(value, "utf8"));
  });

  it("diverges from String.length on multi-byte text, which is the whole point", () => {
    const cjk = "考".repeat(1_000);
    expect(cjk.length).toBe(1_000);
    expect(byteLength(cjk)).toBe(3_000);
  });
});

describe("capture queue — enqueue and the caps (#175)", () => {
  it("appends in capture order, oldest first", () => {
    const store = memoryStore();
    enqueue(store, capture({ clientKey: "a", capturedAt: 1 }));
    enqueue(store, capture({ clientKey: "b", capturedAt: 2 }));
    expect(readQueue(store).map((c) => c.clientKey)).toEqual(["a", "b"]);
  });

  it("reports the queue back on success, so the caller need not re-read", () => {
    const store = memoryStore();
    const result = enqueue(store, capture());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.queue).toHaveLength(1);
  });

  // The cap is 20 rather than a number nobody reaches, so it is a limit a real
  // capture burst can meet. That makes this boundary user-facing behaviour.
  it("accepts the 20th capture", () => {
    const store = seeded(
      Array.from({ length: CAPTURE_QUEUE_MAX_ITEMS - 1 }, (_, i) =>
        capture({ clientKey: `k${i}` }),
      ),
    );
    const result = enqueue(store, capture({ clientKey: "twentieth" }));
    expect(result.ok).toBe(true);
    expect(readQueue(store)).toHaveLength(CAPTURE_QUEUE_MAX_ITEMS);
  });

  // ⚠️ This is the assertion that stops the cap quietly becoming eviction in a
  // later refactor. Losing the NEWEST capture with the user watching is honest;
  // losing the OLDEST silently is the exact bug #175 exists to fix, in a new
  // costume. If someone "improves" this by shifting the queue, this test fails.
  it("refuses the 21st and leaves all 20 already-queued captures untouched", () => {
    const existing = Array.from({ length: CAPTURE_QUEUE_MAX_ITEMS }, (_, i) =>
      capture({ clientKey: `k${i}` }),
    );
    const store = seeded(existing);
    const result = enqueue(store, capture({ clientKey: "twenty-first" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("max-items");
    expect(readQueue(store)).toEqual(existing);
    expect(readQueue(store).map((c) => c.clientKey)).not.toContain(
      "twenty-first",
    );
  });

  // Capture text has no length limit anywhere in the app — no `maxLength` on the
  // input, no check in `createBrainDumpItem`, and an unbounded Postgres `text`
  // column. So one pasted essay is the realistic way to exhaust the quota, and
  // the byte bound rather than the item bound is what stops it.
  it("refuses a single capture larger than the byte bound", () => {
    const store = memoryStore();
    const result = enqueue(
      store,
      capture({ text: "x".repeat(CAPTURE_QUEUE_MAX_BYTES + 1) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("max-bytes");
    expect(readQueue(store)).toEqual([]);
  });

  it("refuses a capture that would push the total over the byte bound, below the item cap", () => {
    const big = "y".repeat(Math.floor(CAPTURE_QUEUE_MAX_BYTES / 2));
    const store = memoryStore();
    expect(enqueue(store, capture({ clientKey: "a", text: big })).ok).toBe(
      true,
    );
    const result = enqueue(store, capture({ clientKey: "b", text: big }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("max-bytes");
    // Well under 20 items, so this proves the byte bound is independent.
    expect(readQueue(store)).toHaveLength(1);
  });

  it("refuses a capture whose text is only whitespace, without touching the queue", () => {
    const store = memoryStore();
    const result = enqueue(store, capture({ text: "   \n\t " }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty");
    expect(readQueue(store)).toEqual([]);
  });

  // A duplicate clientKey would defeat the idempotency the whole design rests
  // on, and it is reachable: a double-tap on Retry.
  it("is idempotent on clientKey — re-enqueueing the same key does not duplicate", () => {
    const store = memoryStore();
    enqueue(store, capture({ clientKey: "same" }));
    const result = enqueue(
      store,
      capture({ clientKey: "same", text: "again" }),
    );
    expect(result.ok).toBe(true);
    expect(readQueue(store)).toHaveLength(1);
    // The FIRST wins: the words already promised to the user are the ones kept.
    expect(readQueue(store)[0].text).toBe(capture().text);
  });

  it("reports a storage failure instead of throwing, and keeps nothing", () => {
    const store = throwingStore();
    const result = enqueue(store, capture());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("storage-unavailable");
  });

  it("refuses when there is no storage at all", () => {
    const result = enqueue(null, capture());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("storage-unavailable");
  });
});

describe("capture queue — flush outcomes (#175)", () => {
  const two = [
    capture({ clientKey: "a", capturedAt: 1 }),
    capture({ clientKey: "b", capturedAt: 2 }),
  ];

  it("removes a capture the server wrote (201)", () => {
    const store = seeded(two);
    applyFlushOutcome(store, "a", "saved");
    expect(readQueue(store).map((c) => c.clientKey)).toEqual(["b"]);
  });

  // The payoff of the idempotency key: a write that timed out at 10s and landed
  // at 14s comes back as a duplicate, and a duplicate means SAVED, not failed.
  it("removes a capture the server already had (200 duplicate)", () => {
    const store = seeded(two);
    applyFlushOutcome(store, "a", "duplicate");
    expect(readQueue(store).map((c) => c.clientKey)).toEqual(["b"]);
  });

  // ⚠️ 409 and 403 are asserted SEPARATELY and their marks compared. A test that
  // only checked "the capture was kept" would pass the collapsed-state bug the
  // spec review caught — both statuses keep the capture, and that is exactly why
  // "it was kept" is not enough to prove they are distinguished.
  it("KEEPS a capture whose session expired (409) and marks it session-expired", () => {
    const store = seeded(two);
    applyFlushOutcome(store, "a", "session-expired");
    const q = readQueue(store);
    expect(q.map((c) => c.clientKey)).toEqual(["a", "b"]);
    expect(q[0].blockedBy).toBe("session-expired");
    // Only the one it was told about.
    expect(q[1].blockedBy).toBeUndefined();
  });

  it("KEEPS a capture whose account was revoked (403) and marks it account-revoked", () => {
    const store = seeded(two);
    applyFlushOutcome(store, "a", "account-revoked");
    const q = readQueue(store);
    expect(q.map((c) => c.clientKey)).toEqual(["a", "b"]);
    expect(q[0].blockedBy).toBe("account-revoked");
  });

  // The distinction has a user consequence: for a revoked account, signing in
  // CANNOT help — #220 has already cleared the session and bounced to /login — so
  // the strip must not offer a sign-in. That decision is only possible if these
  // two never share a value.
  it("does not confuse the two refusals with each other", () => {
    const expired = seeded([capture({ clientKey: "a" })]);
    const revoked = seeded([capture({ clientKey: "a" })]);
    applyFlushOutcome(expired, "a", "session-expired");
    applyFlushOutcome(revoked, "a", "account-revoked");
    expect(readQueue(expired)[0].blockedBy).not.toBe(
      readQueue(revoked)[0].blockedBy,
    );
  });

  it("KEEPS a capture on a retryable failure, unmarked", () => {
    const store = seeded(two);
    applyFlushOutcome(store, "a", "retry");
    const q = readQueue(store);
    expect(q).toHaveLength(2);
    expect(q[0].blockedBy).toBeUndefined();
  });

  it("clears the mark when a previously-refused capture later saves", () => {
    const store = seeded([
      capture({ clientKey: "a", blockedBy: "session-expired" }),
    ]);
    applyFlushOutcome(store, "a", "saved");
    expect(readQueue(store)).toEqual([]);
  });

  // Reaching a retryable failure proves the SESSION guard is no longer the
  // obstacle, so a stale `session-expired` would keep asking for a sign-in that
  // already happened.
  //
  // ⚠️ This used to loop over both marks and assert both cleared. It was wrong
  // about `account-revoked`, and asserting it kept the bug in place: a 500 or a
  // dropped connection is no evidence an account was un-revoked. See the sticky
  // block below for the sequence #220 makes routine.
  it("clears session-expired when a retry gets past the guard without saving yet", () => {
    const store = seeded([
      capture({ clientKey: "a", blockedBy: "session-expired" }),
    ]);
    applyFlushOutcome(store, "a", "retry");
    expect(readQueue(store)[0].blockedBy).toBeUndefined();
  });

  it("removes the storage key entirely once the queue empties", () => {
    const store = seeded([capture({ clientKey: "a" })]);
    applyFlushOutcome(store, "a", "saved");
    expect(store.getItem(CAPTURE_QUEUE_STORAGE_KEY)).toBeNull();
  });

  it("is a no-op for a clientKey that is not queued", () => {
    const store = seeded(two);
    applyFlushOutcome(store, "never-queued", "saved");
    expect(readQueue(store)).toEqual(two);
  });

  it("never throws without storage", () => {
    expect(() => applyFlushOutcome(null, "a", "saved")).not.toThrow();
  });

  it("refuses without storage rather than reporting a queue, exactly as enqueue does", () => {
    const result = applyFlushOutcome(null, "a", "saved");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("storage-unavailable");
  });

  it("reports the queue it wrote when the write does land", () => {
    const store = seeded(two);
    const result = applyFlushOutcome(store, "a", "saved");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.queue.map((c) => c.clientKey)).toEqual(["b"]);
  });
});

// ⚠️ `account-revoked` is TERMINAL among the refusals, and #220 is what makes
// that a requirement rather than a tidiness. Precedence is
// `account-revoked` > `session-expired` > unmarked, and only a SUCCESSFUL outcome
// clears it.
//
// The sequence, every step of it in this tree:
//
//  1. A revoked owner's queued capture flushes. `currentWorkspaceId()` finds
//     `status !== active`, and `POST /api/braindump` answers 403 → the entry is
//     marked `account-revoked`. The strip deliberately offers NO sign-in, because
//     signing in cannot help.
//  2. #220 clears the owner cookie inside that same request —
//     `clearOwnerSession(jar)` runs immediately BEFORE the throw
//     (`src/lib/workspace.ts`), and this is a Route Handler, where Next 16 lets
//     the delete land (`cookies.md`: `.delete` may be called in a Route Handler;
//     it is only the sealed jar of a Server Component render that refuses).
//  3. So the NEXT flush carries no owner cookie. `/api/braindump` is neither
//     public nor gated, so `src/proxy.ts` mints a guest sandbox and forwards it —
//     and that sandbox cannot be the capture's declared `workspaceId`, so the
//     route answers 409, `session-expired`.
//  4. Overwriting the mark then puts "Your session expired. Sign in and these
//     will save." in front of an account that can never save again — a promise the
//     app cannot keep, and the exact collapse the spec split 403 from 409 to
//     prevent.
//
// A `retry` (5xx, or the connection dropping) is the same bug in a milder
// costume: it is no evidence an account was un-revoked.
//
// Stickiness is not a trap, and the `saved`/`duplicate` tests below are what say
// so: if the owner un-freezes the account and the person signs in again, the
// flush returns 201 or 200 and the entry leaves the queue whatever it was marked
// with. The mark survives failure; it does not survive success.
describe("capture queue — a revoked mark is terminal (#175, #220)", () => {
  const two = [
    capture({ clientKey: "a", capturedAt: 1 }),
    capture({ clientKey: "b", capturedAt: 2 }),
  ];

  // Step 4 above, and the one #220 GUARANTEES rather than merely allows.
  it("keeps account-revoked when the next flush comes back 409", () => {
    const store = seeded(two);

    applyFlushOutcome(store, "a", "account-revoked");
    const result = applyFlushOutcome(store, "a", "session-expired");

    const q = readQueue(store);
    expect(q.map((c) => c.clientKey)).toEqual(["a", "b"]);
    expect(q[0].blockedBy).toBe("account-revoked");
    // The caller renders the RETURNED queue without re-reading, so a fix that
    // only got the store right would still show the downgraded copy once.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.queue[0].blockedBy).toBe("account-revoked");
  });

  it("keeps account-revoked when the next flush is a retryable failure", () => {
    const store = seeded(two);

    applyFlushOutcome(store, "a", "account-revoked");
    applyFlushOutcome(store, "a", "retry");

    expect(readQueue(store)[0].blockedBy).toBe("account-revoked");
  });

  // Repeated refusals are the normal case — the strip retries on reconnect — so
  // the rule has to survive being applied more than twice.
  it("holds the mark across a run of refusals in any order", () => {
    const store = seeded(two);

    applyFlushOutcome(store, "a", "account-revoked");
    for (const outcome of [
      "session-expired",
      "retry",
      "session-expired",
      "retry",
    ] as const) {
      applyFlushOutcome(store, "a", outcome);
    }

    expect(readQueue(store)[0].blockedBy).toBe("account-revoked");
  });

  // ⚠️ The pair that keeps stickiness from becoming a trap. An un-frozen account
  // signing back in gets a 201 or a 200, and the entry leaves the queue regardless
  // of its mark — which is why nothing needs a way to un-revoke a mark by hand.
  it("removes a revoked capture that finally saves, mark and all", () => {
    const store = seeded(two);

    applyFlushOutcome(store, "a", "account-revoked");
    const result = applyFlushOutcome(store, "a", "saved");

    expect(result.ok).toBe(true);
    expect(readQueue(store).map((c) => c.clientKey)).toEqual(["b"]);
  });

  it("removes a revoked capture the server turns out to already hold (200)", () => {
    const store = seeded(two);

    applyFlushOutcome(store, "a", "account-revoked");
    applyFlushOutcome(store, "a", "duplicate");

    expect(readQueue(store).map((c) => c.clientKey)).toEqual(["b"]);
  });

  // The UNCHANGED direction. Precedence has to be an ordering, not a freeze: a
  // 409 seen before the account was frozen must still be upgradeable, or a
  // capture would keep offering a sign-in after the 403 that proves it useless.
  it("still upgrades session-expired to account-revoked", () => {
    const store = seeded(two);

    applyFlushOutcome(store, "a", "session-expired");
    applyFlushOutcome(store, "a", "account-revoked");

    expect(readQueue(store)[0].blockedBy).toBe("account-revoked");
  });

  it("still overwrites session-expired with session-expired", () => {
    const store = seeded(two);

    applyFlushOutcome(store, "a", "session-expired");
    applyFlushOutcome(store, "a", "session-expired");

    expect(readQueue(store)[0].blockedBy).toBe("session-expired");
  });

  it("still clears session-expired on a retryable failure", () => {
    const store = seeded(two);

    applyFlushOutcome(store, "a", "session-expired");
    applyFlushOutcome(store, "a", "retry");

    expect(readQueue(store)[0].blockedBy).toBeUndefined();
  });

  // Stickiness is per entry, not per queue: two captures flush independently, and
  // a mark that leaked sideways would refuse a sign-in to a capture nothing has
  // refused yet.
  it("does not spread a revoked mark to the other captures", () => {
    const store = seeded(two);

    applyFlushOutcome(store, "a", "account-revoked");
    applyFlushOutcome(store, "b", "session-expired");
    applyFlushOutcome(store, "b", "retry");

    const q = readQueue(store);
    expect(q[0].blockedBy).toBe("account-revoked");
    expect(q[1].blockedBy).toBeUndefined();
  });

  // A mark set before the reload a discarded Android tab forces is the case the
  // field is persisted for, so the rule has to hold when the mark arrives from
  // the STORE rather than from a call earlier in the same session.
  it("holds a mark it read from storage rather than one it wrote itself", () => {
    const store = seeded([
      capture({ clientKey: "a", blockedBy: "account-revoked" }),
    ]);

    applyFlushOutcome(store, "a", "session-expired");

    expect(readQueue(store)[0].blockedBy).toBe("account-revoked");
  });

  // The reconcile path: the mark this tab must not downgrade can be one the OTHER
  // tab wrote between this tab's read and its write. `applyOutcome` sees it only
  // because it re-reads, which is the same property the resurrection tests rely on.
  it("holds a mark the other tab wrote while this tab was mid-flush", () => {
    const store = contendedStore([capture({ clientKey: "a" })], (other) => {
      applyFlushOutcome(other, "a", "account-revoked");
    });

    applyFlushOutcome(store, "a", "session-expired");

    expect(readQueue(store)[0].blockedBy).toBe("account-revoked");
  });
});

// ⚠️ A write that did not land, reported as one that did, is the strip telling
// somebody their words are safe on the strength of nothing. `enqueue` has always
// checked `write`'s answer and named the failure `storage-unavailable`; this is
// the same contract arriving at the other writer.
//
// Reachable: a full quota, or Safari private mode, on the very write that removes
// a flushed capture. It self-heals — the capture is still queued, the next flush
// gets a 200 duplicate and removes it — but a self-healing lie is still a lie
// until it heals, and "were my words saved?" is the one question this feature
// exists to answer.
describe("capture queue — a write that does not land (#175)", () => {
  const two = [
    capture({ clientKey: "a", capturedAt: 1 }),
    capture({ clientKey: "b", capturedAt: 2 }),
  ];

  it("reports that a removal did not persist when setItem is refused", () => {
    const store = throwingStore({
      [CAPTURE_QUEUE_STORAGE_KEY]: JSON.stringify(two),
    });

    const result = applyFlushOutcome(store, "a", "saved");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("storage-unavailable");
    // The store is untouched, so both captures are still queued — which is what
    // makes the old return value a lie rather than merely incomplete.
    expect(readQueue(store).map((c) => c.clientKey)).toEqual(["a", "b"]);
  });

  // The `removeItem` branch, which `throwingStore` cannot reach: emptying the
  // queue deletes the key rather than writing "[]", so the last capture to flush
  // is the one whose failure takes a different code path.
  it("reports that emptying the queue did not persist when removeItem is refused", () => {
    const store = writeBlockedStore({
      [CAPTURE_QUEUE_STORAGE_KEY]: JSON.stringify([
        capture({ clientKey: "a" }),
      ]),
    });

    const result = applyFlushOutcome(store, "a", "saved");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("storage-unavailable");
    expect(readQueue(store).map((c) => c.clientKey)).toEqual(["a"]);
  });

  // The mark has the worse version of the consequence. A `blockedBy` that did not
  // persist means the capture comes back after the reload a discarded tab forces
  // with no record of why it is stuck — so the strip offers a Retry that cannot
  // work, which is the whole reason the mark is persisted rather than held in
  // component state.
  it("reports that a refusal mark did not persist", () => {
    const store = throwingStore({
      [CAPTURE_QUEUE_STORAGE_KEY]: JSON.stringify(two),
    });

    const result = applyFlushOutcome(store, "a", "session-expired");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("storage-unavailable");
    expect(readQueue(store)[0].blockedBy).toBeUndefined();
  });

  // `enqueue` is the model this copies, not a second site of the same defect.
  // Asserted here so the pair are read together and cannot drift apart.
  it("matches enqueue, which has always reported a refused write", () => {
    const store = throwingStore();
    const enqueued = enqueue(store, capture());
    const applied = applyFlushOutcome(
      throwingStore({ [CAPTURE_QUEUE_STORAGE_KEY]: JSON.stringify(two) }),
      "a",
      "saved",
    );

    expect(enqueued.ok).toBe(false);
    expect(applied.ok).toBe(false);
    if (!enqueued.ok && !applied.ok) {
      expect(applied.reason).toBe(enqueued.reason);
    }
  });
});

// #233 established that the only concurrency this app genuinely has needs two
// router instances — two tabs, or a tab and a phone — and that no in-memory guard
// can span them. The inbox open in two tabs is ordinary, and the target is
// Android Chrome, which discards a backgrounded tab and reopens it, so
// overlapping lifetimes are the normal case rather than the exception.
//
// Every test here fails if a writer reconciles against the snapshot it read
// instead of against the store, which is the loss this module exists to prevent
// wearing a costume the caps and the throw-safety tests do not catch.
describe("capture queue — two tabs against one origin (#175)", () => {
  it("keeps the capture another tab queued while this one was checking the caps", () => {
    const store = contendedStore(
      [capture({ clientKey: "a", capturedAt: 1 })],
      (other) => {
        enqueue(other, capture({ clientKey: "other-tab", capturedAt: 2 }));
      },
    );

    const result = enqueue(
      store,
      capture({ clientKey: "mine", capturedAt: 3 }),
    );

    expect(result.ok).toBe(true);
    // Write order, not `capturedAt`: what is already stored keeps the order it
    // has and the incoming capture goes on the end. See the module's Ordering
    // note for why nothing re-sorts by a clock two devices do not share.
    expect(readQueue(store).map((c) => c.clientKey)).toEqual([
      "a",
      "other-tab",
      "mine",
    ]);
    // The reported queue is the one that was written, not the snapshot it began
    // from — the caller renders this without re-reading.
    if (result.ok) expect(result.queue).toEqual(readQueue(store));
  });

  it("refuses the incoming capture when the other tab's write filled the item cap", () => {
    const nineteen = Array.from(
      { length: CAPTURE_QUEUE_MAX_ITEMS - 1 },
      (_, i) => capture({ clientKey: `k${i}` }),
    );
    const store = contendedStore(nineteen, (other) => {
      enqueue(other, capture({ clientKey: "other-tab" }));
    });

    const result = enqueue(store, capture({ clientKey: "mine" }));

    // The cap is measured against the MERGED queue, so the merge cannot become a
    // way past 20. Over it, the INCOMING capture is the one refused — same
    // contract as the plain cap, and the words stay in the field.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("max-items");
    const keys = readQueue(store).map((c) => c.clientKey);
    expect(keys).toHaveLength(CAPTURE_QUEUE_MAX_ITEMS);
    expect(keys).toContain("other-tab");
    expect(keys).not.toContain("mine");
  });

  it("refuses the incoming capture when the merged queue would breach the byte cap", () => {
    const big = "z".repeat(Math.floor(CAPTURE_QUEUE_MAX_BYTES / 2) - 200);

    // Control: the two big captures do fit together, so the refusal below is the
    // incoming capture being turned away and not the pair being impossible.
    const control = memoryStore();
    expect(enqueue(control, capture({ clientKey: "a", text: big })).ok).toBe(
      true,
    );
    expect(
      enqueue(control, capture({ clientKey: "other-tab", text: big })).ok,
    ).toBe(true);

    const store = contendedStore(
      [capture({ clientKey: "a", text: big })],
      (other) => {
        enqueue(other, capture({ clientKey: "other-tab", text: big }));
      },
    );

    const result = enqueue(
      store,
      capture({ clientKey: "mine", text: "z".repeat(1_000) }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("max-bytes");
    expect(readQueue(store).map((c) => c.clientKey)).toEqual([
      "a",
      "other-tab",
    ]);
  });

  // The case where the merge ALONE is over a cap, before anything incoming is
  // considered. Refuse, and leave every one of the other tab's captures exactly
  // where they are: truncating to fit would be the silent eviction of the oldest
  // that this module refuses to do, arrived at from a new direction.
  it("refuses without truncating when what the other tab left is already over the item cap", () => {
    const twentyTwo = Array.from(
      { length: CAPTURE_QUEUE_MAX_ITEMS + 2 },
      (_, i) => capture({ clientKey: `k${i}` }),
    );
    const store = contendedStore([capture({ clientKey: "a" })], (other) => {
      // Reachable without a hand-edited store: a tab left open across a deploy
      // is running the previous build, and the first draft of this design capped
      // at 200 (spec, 2026-08-11). Its queue is legitimately larger than ours.
      other.setItem(CAPTURE_QUEUE_STORAGE_KEY, JSON.stringify(twentyTwo));
    });

    const result = enqueue(store, capture({ clientKey: "mine" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("max-items");
    expect(readQueue(store)).toEqual(twentyTwo);
  });

  // Not a user story — two tabs cannot mint the same `clientKey`. It is the
  // contract MR 2's hook will lean on when it holds the queue in React state:
  // idempotency is judged against the store, never against a snapshot.
  it("judges idempotency against the store, so a key only the other tab wrote is not duplicated", () => {
    const store = contendedStore([], (other) => {
      enqueue(
        other,
        capture({ clientKey: "same", text: "the other tab's words" }),
      );
    });

    const result = enqueue(store, capture({ clientKey: "same", text: "mine" }));

    expect(result.ok).toBe(true);
    const q = readQueue(store);
    expect(q).toHaveLength(1);
    expect(q[0].text).toBe("the other tab's words");
  });

  it("keeps a capture the other tab queued while this one was recording a flush", () => {
    const store = contendedStore(
      [capture({ clientKey: "a" }), capture({ clientKey: "b" })],
      (other) => {
        enqueue(other, capture({ clientKey: "other-tab" }));
      },
    );

    const result = applyFlushOutcome(store, "a", "saved");

    expect(readQueue(store).map((c) => c.clientKey)).toEqual([
      "b",
      "other-tab",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.queue).toEqual(readQueue(store));
  });

  // ⚠️ The assertion that stops the merge being written as a set union of the two
  // queues, which is the obvious implementation and is WORSE than the bug it
  // fixes. This tab computes a queue without the key it just saved; the store
  // still holds that key because nothing has been written yet; a union puts it
  // straight back — permanently, and after the user has been told it saved.
  //
  // Only ever applying this tab's own delta to the fresh read is what makes a
  // tombstone and a per-entry version unnecessary: "deliberately removed" never
  // has to be told apart from "not yet known to me", because the tab doing the
  // removing removes it from a read it took itself.
  it("never resurrects a capture the other tab flushed successfully", () => {
    const store = contendedStore(
      [capture({ clientKey: "a" }), capture({ clientKey: "b" })],
      (other) => {
        applyFlushOutcome(other, "b", "saved");
      },
    );

    applyFlushOutcome(store, "a", "saved");

    expect(readQueue(store)).toEqual([]);
    expect(store.getItem(CAPTURE_QUEUE_STORAGE_KEY)).toBeNull();
  });

  // Reachable, and the worst-reading version of the same bug: two tabs flush the
  // same capture at once, one gets 201 and the other 409. Marking a capture the
  // other tab has already saved would bring the words back AND offer a sign-in
  // for work that is already done.
  it("does not resurrect a flushed capture in order to mark it refused", () => {
    const store = contendedStore([capture({ clientKey: "a" })], (other) => {
      applyFlushOutcome(other, "a", "saved");
    });

    applyFlushOutcome(store, "a", "session-expired");

    expect(readQueue(store)).toEqual([]);
  });
});

describe("capture queue — client keys (#175)", () => {
  it("generates distinct keys", () => {
    const keys = new Set(Array.from({ length: 200 }, () => newClientKey()));
    expect(keys.size).toBe(200);
  });

  it("generates keys that survive a JSON round trip unchanged", () => {
    const k = newClientKey();
    expect(JSON.parse(JSON.stringify({ k })).k).toBe(k);
  });

  // The key is a database value under a unique constraint, so an empty or
  // absurdly long one is a server-side problem waiting to happen.
  it("generates keys of a sane, bounded length", () => {
    const k = newClientKey();
    expect(k.length).toBeGreaterThan(15);
    expect(k.length).toBeLessThanOrEqual(64);
  });
});

// The third tier of `newClientKey` — reached only when a runtime has NEITHER
// `crypto.randomUUID` nor `crypto.getRandomValues`, so close to unreachable.
//
// It used to fill 16 bytes from `Math.random()`, which Semgrep flags MEDIUM
// (CWE-338) on every pipeline. `pick-one.ts` records why dismissing that is the
// wrong tool: the finding's fingerprint includes the LINE NUMBER, so one statement
// in `focus-timer.tsx` was dismissed five separate times as unrelated changes
// moved it down the file. A fix is permanent; a dismissal is a tax on every future
// MR that shifts the line.
//
// ⚠️ The security reading is the weaker argument and should not be the one relied
// on. A `clientKey` is an idempotency key, not a secret, and predicting one grants
// nothing without the victim's `workspaceId`. The CORRECTNESS reading is the real
// one: the column is `@@unique([workspaceId, clientKey])`, so a collision makes the
// second capture take the `200 duplicate` arm and be dropped from the queue as
// already saved — words lost, silently, in the one module whose whole premise is
// that that cannot happen. A clock plus a counter is collision-FREE within a
// session rather than merely unlikely, which is strictly better here than any PRNG.
describe("capture queue — client keys with no platform CSPRNG (#175)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // The mirror of `pick-one.test.ts`'s assertion that the CSPRNG *is* reached. If
  // a refactor reintroduces the flagged construct, this is what fails.
  it("does not reach for Math.random, which SAST flags on every pipeline", () => {
    vi.stubGlobal("crypto", {});
    const spy = vi.spyOn(Math, "random");

    newClientKey();

    expect(spy).not.toHaveBeenCalled();
  });

  // A fallback key that reached the database would otherwise be indistinguishable
  // from a `getRandomValues` one, and the two mean very different things about the
  // browser that produced it.
  it("is recognisable as the fallback, so one in the database is diagnosable", () => {
    vi.stubGlobal("crypto", {});
    expect(newClientKey().startsWith("clk-")).toBe(true);
  });

  it("still returns a key the server will accept", () => {
    vi.stubGlobal("crypto", {});
    const k = newClientKey();

    // Mirrors CLIENT_KEY_SHAPE in `src/app/api/braindump/route.ts`. A fallback key
    // the route refuses is a capture that can never flush — stuck in the queue
    // forever while the strip says it is waiting to save. The route's own test
    // proves the agreement end to end; this is the local half.
    expect(k).toMatch(/^[A-Za-z0-9-]{1,64}$/);
    expect(k.length).toBeGreaterThan(15);
    expect(k.length).toBeLessThanOrEqual(64);
    expect(JSON.parse(JSON.stringify({ k })).k).toBe(k);
  });

  // Uniqueness has to come from the COUNTER, not from the clock and not from luck.
  // Freezing time is what makes that the only thing left to carry it.
  it("cannot repeat inside a single millisecond", () => {
    vi.stubGlobal("crypto", {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T09:00:00.000Z"));
    try {
      const keys = Array.from({ length: 1_000 }, () => newClientKey());
      expect(new Set(keys).size).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  // The property the docblock leans on hardest: this function failing would take
  // capture down with it, which is worse than any key weakness.
  it("never throws, whatever crypto turns out to be", () => {
    for (const stub of [{}, undefined, null, { randomUUID: 42 }]) {
      vi.stubGlobal("crypto", stub);
      expect(() => newClientKey()).not.toThrow();
      expect(newClientKey().length).toBeGreaterThan(0);
    }
  });

  // The middle tier is unchanged and stays preferred — asserted so this change
  // cannot quietly demote a real CSPRNG to the counter.
  it("still prefers getRandomValues when that is the only member present", () => {
    const getRandomValues = vi.fn((a: Uint8Array) => a.fill(0xab));
    vi.stubGlobal("crypto", { getRandomValues });

    const k = newClientKey();

    expect(getRandomValues).toHaveBeenCalled();
    expect(k).toBe("ab".repeat(16));
  });
});
