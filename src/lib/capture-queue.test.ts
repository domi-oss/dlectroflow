import { describe, it, expect } from "vitest";
import {
  CAPTURE_QUEUE_STORAGE_KEY,
  CAPTURE_QUEUE_MAX_ITEMS,
  CAPTURE_QUEUE_MAX_BYTES,
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

  // Reaching a retryable failure proves the guard is no longer the obstacle, so a
  // stale mark would keep asking for a sign-in that already happened.
  it("clears either mark when a retry gets past the guard without saving yet", () => {
    for (const was of ["session-expired", "account-revoked"] as const) {
      const store = seeded([capture({ clientKey: "a", blockedBy: was })]);
      applyFlushOutcome(store, "a", "retry");
      expect(readQueue(store)[0].blockedBy).toBeUndefined();
    }
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

    const returned = applyFlushOutcome(store, "a", "saved");

    expect(readQueue(store).map((c) => c.clientKey)).toEqual([
      "b",
      "other-tab",
    ]);
    expect(returned).toEqual(readQueue(store));
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
