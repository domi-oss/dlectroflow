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
