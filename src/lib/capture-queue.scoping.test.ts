import { describe, it, expect } from "vitest";
import {
  CAPTURE_QUEUE_STORAGE_KEY,
  CAPTURE_QUEUE_MAX_ITEMS,
  CAPTURE_QUEUE_MAX_BYTES,
  CAPTURE_ORPHAN_WINDOW_HOURS,
  applyFlushOutcome,
  discardCapture,
  enqueue,
  newClientKey,
  partitionQueue,
  readQueue,
  sweepUnresolvable,
  type QueueStore,
  type QueuedCapture,
} from "@/lib/capture-queue";

/**
 * #175 MR 2 — the half of the queue that only the browser half needs.
 *
 * `capture-queue.test.ts` covers what `!334` shipped: enqueue, the caps as one
 * origin-wide pair, the outcome map and the `blockedBy` precedence. This file
 * covers what the strip adds, and it is a separate file for the reason
 * `inbox-view.write-failure.test.tsx` is one: the questions are different, and
 * every case here needs a **live workspace** to compare against, which nothing
 * in the other file has.
 *
 * Spec: `docs/design/specs/2026-08-11-offline-capture-queue-design.md`, under
 * *"A shared browser"* and *"Display order"*.
 */

const LIVE = "ws-live";
const OTHER = "ws-other";

function memoryStore(seed: Record<string, string> = {}): QueueStore {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function capture(over: Partial<QueuedCapture> = {}): QueuedCapture {
  return {
    clientKey: "k1",
    text: "ring mum about the boiler",
    workspaceId: LIVE,
    capturedAt: 1_000,
    ...over,
  };
}

function seeded(items: QueuedCapture[]): QueueStore {
  return memoryStore({ [CAPTURE_QUEUE_STORAGE_KEY]: JSON.stringify(items) });
}

const HOUR_MS = 60 * 60 * 1000;

describe("capture queue — the strip is scoped to the live workspace (#175)", () => {
  it("renders another workspace's captures as a count and never as text", () => {
    // A NON-EMPTY other-workspace set, deliberately: a filter that returned
    // nothing at all would pass an assertion made only on `mine`.
    const queue = [
      capture({ clientKey: "mine-1" }),
      capture({
        clientKey: "theirs-1",
        workspaceId: OTHER,
        text: "their words",
      }),
      capture({
        clientKey: "theirs-2",
        workspaceId: OTHER,
        text: "more of theirs",
      }),
    ];

    const { mine, stranded } = partitionQueue(queue, LIVE);

    expect(mine.map((c) => c.clientKey)).toEqual(["mine-1"]);
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toMatchObject({ state: "unmarked", count: 2 });
    // The whole property: the words are not in what the strip is handed.
    expect(JSON.stringify(stranded)).not.toContain("their words");
    expect(JSON.stringify(stranded)).not.toContain("more of theirs");
  });

  it("groups stranded entries by STATE, so two foreign workspaces make one row", () => {
    // One row per workspace would leak how many prior sessions this browser has
    // held. Two different non-matching workspaces, one shared state, one row.
    const queue = [
      capture({
        clientKey: "a",
        workspaceId: OTHER,
        blockedBy: "session-expired",
        blockedUnder: LIVE,
      }),
      capture({
        clientKey: "b",
        workspaceId: "ws-third",
        blockedBy: "session-expired",
        blockedUnder: LIVE,
      }),
    ];

    const { stranded } = partitionQueue(queue, LIVE);

    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toMatchObject({
      state: "session-expired",
      count: 2,
      clientKeys: ["a", "b"],
    });
  });

  it("offers the sign-in while the live session still resolves to blockedUnder", () => {
    const queue = [
      capture({
        clientKey: "a",
        workspaceId: OTHER,
        blockedBy: "session-expired",
        blockedUnder: LIVE,
      }),
    ];

    const { stranded } = partitionQueue(queue, LIVE);

    expect(stranded[0]?.state).toBe("session-expired");
  });

  it("withdraws the sign-in once the session has changed and the 409 stands", () => {
    // The remedy has been taken and did not work, so the copy must stop
    // repeating it. Without this arm an implementation that always offers the
    // sign-in passes the test above.
    const queue = [
      capture({
        clientKey: "a",
        workspaceId: OTHER,
        blockedBy: "session-expired",
        blockedUnder: "ws-before-the-sign-in",
      }),
    ];

    const { stranded } = partitionQueue(queue, LIVE);

    expect(stranded[0]?.state).toBe("session-changed");
  });

  it("keeps a revoked-account group on its own sentence", () => {
    const queue = [
      capture({
        clientKey: "a",
        workspaceId: OTHER,
        blockedBy: "account-revoked",
      }),
      capture({ clientKey: "b", workspaceId: OTHER }),
    ];

    const { stranded } = partitionQueue(queue, LIVE);

    expect(stranded.map((g) => g.state).sort()).toEqual([
      "account-revoked",
      "unmarked",
    ]);
  });

  it("renders a matching entry in full even when it carries a refusal", () => {
    // A 403 arrives in the session that owns the entry, so the full row — and
    // its Discard control — must still be reachable in that render.
    const queue = [capture({ blockedBy: "account-revoked" })];

    const { mine, stranded } = partitionQueue(queue, LIVE);

    expect(mine).toHaveLength(1);
    expect(stranded).toEqual([]);
  });

  it("keeps the sign-in offer while the live workspace is still unresolved", () => {
    // ⚠️ Duo review round 1 on !348, grounded but undeliverable. `partitionQueue`
    // sends EVERY entry to the stranded branch while `liveWorkspaceId` is `""`,
    // and a comparison against `blockedUnder` then reads any real workspace id as
    // "the session changed" — which WITHDRAWS the sign-in offer for as long as the
    // prop takes to settle.
    //
    // On the one screen whose whole job is "your captures are safe, here is how to
    // get them saved", a flicker that removes the recovery affordance is not
    // cosmetic: it tells the user the wrong thing about why they are stuck, and the
    // wrong thing is the one with no remedy.
    //
    // The file already states the convention this broke — `applySweep` refuses to
    // start the expiry clock on `""` because "a render that knows nothing" must not
    // act. Not knowing the live workspace is not evidence that it changed.
    const queue = [
      capture({
        clientKey: "a",
        workspaceId: OTHER,
        blockedBy: "session-expired",
        blockedUnder: "ws-whatever-it-was",
      }),
    ];

    const { stranded } = partitionQueue(queue, "");

    expect(stranded[0]?.state).toBe("session-expired");
  });

  it("still withdraws it once a KNOWN live workspace differs", () => {
    // The control. A fix that returned `session-expired` unconditionally would
    // pass the case above and reopen the forever-promise bug `blockedUnder` exists
    // to close.
    const queue = [
      capture({
        clientKey: "a",
        workspaceId: OTHER,
        blockedBy: "session-expired",
        blockedUnder: "ws-whatever-it-was",
      }),
    ];

    expect(partitionQueue(queue, LIVE).stranded[0]?.state).toBe(
      "session-changed",
    );
  });

  it("treats an unresolved live workspace as matching nothing, without throwing", () => {
    // The strip can render before the prop resolves. Showing nothing is right;
    // showing everything as "mine" would leak across the boundary.
    const queue = [capture()];

    const { mine, stranded } = partitionQueue(queue, "");

    expect(mine).toEqual([]);
    expect(stranded).toHaveLength(1);
  });
});

describe("capture queue — the caps split (#175)", () => {
  it("counts the item cap per workspace, so a full foreign queue does not block a capture", () => {
    const theirs = Array.from({ length: CAPTURE_QUEUE_MAX_ITEMS }, (_, i) =>
      capture({ clientKey: `theirs-${i}`, workspaceId: OTHER, text: "x" }),
    );
    const store = seeded(theirs);

    const result = enqueue(store, capture({ clientKey: "mine", text: "mine" }));

    expect(result.ok).toBe(true);
    expect(readQueue(store)).toHaveLength(CAPTURE_QUEUE_MAX_ITEMS + 1);
  });

  it("still refuses the 21st capture of the LIVE workspace", () => {
    const mine = Array.from({ length: CAPTURE_QUEUE_MAX_ITEMS }, (_, i) =>
      capture({ clientKey: `mine-${i}`, text: "x" }),
    );
    const store = seeded(mine);

    const result = enqueue(store, capture({ clientKey: "over", text: "over" }));

    expect(result).toEqual({ ok: false, reason: "max-items" });
  });

  it("counts the byte cap across every entry in the key, foreign ones included", () => {
    // The quota is charged per origin, so A's bulk does refuse B — with the
    // room-not-ownership copy, which is why the reason must be `no-room` and not
    // `too-long`: B's capture is 600 bytes and blameless.
    const filler = "y".repeat(CAPTURE_QUEUE_MAX_BYTES - 400);
    const store = seeded([
      capture({ clientKey: "theirs", workspaceId: OTHER, text: filler }),
    ]);

    const result = enqueue(
      store,
      capture({ clientKey: "mine", text: "z".repeat(600) }),
    );

    expect(result).toEqual({ ok: false, reason: "no-room" });
  });
});

describe("capture queue — blockedUnder is a comparison, not a flag (#175)", () => {
  it("records the live workspace when a 409 is logged", () => {
    const store = seeded([capture()]);

    applyFlushOutcome(store, "k1", "session-expired", LIVE);

    expect(readQueue(store)[0]).toMatchObject({
      blockedBy: "session-expired",
      blockedUnder: LIVE,
    });
  });

  it("does not move blockedUnder on a second 409 under the same session", () => {
    const store = seeded([capture()]);

    applyFlushOutcome(store, "k1", "session-expired", LIVE);
    applyFlushOutcome(store, "k1", "session-expired", LIVE);

    expect(readQueue(store)[0]?.blockedUnder).toBe(LIVE);
  });

  it("re-points blockedUnder when a later 409 arrives under a different session", () => {
    // The comparison the strip makes is "does the live workspace still equal
    // blockedUnder"; the value has to follow the session or the withdrawal
    // sticks for ever after one sign-in.
    const store = seeded([
      capture({ blockedBy: "session-expired", blockedUnder: "ws-old" }),
    ]);

    applyFlushOutcome(store, "k1", "session-expired", LIVE);

    expect(readQueue(store)[0]?.blockedUnder).toBe(LIVE);
  });

  it("clears blockedUnder with the mark it belongs to", () => {
    const store = seeded([
      capture({ blockedBy: "session-expired", blockedUnder: "ws-old" }),
    ]);

    applyFlushOutcome(store, "k1", "retry", LIVE);

    const entry = readQueue(store)[0];
    expect(entry?.blockedBy).toBeUndefined();
    expect(entry?.blockedUnder).toBeUndefined();
  });

  it("leaves a sticky account-revoked mark and its absence of blockedUnder alone", () => {
    const store = seeded([capture({ blockedBy: "account-revoked" })]);

    applyFlushOutcome(store, "k1", "session-expired", LIVE);

    const entry = readQueue(store)[0];
    expect(entry?.blockedBy).toBe("account-revoked");
    expect(entry?.blockedUnder).toBeUndefined();
  });

  /**
   * ⚠️ **The direction the case above does NOT cover: 409 first, then 403.**
   *
   * `session-expired` is transient, so a 403 legitimately supersedes it — and the
   * spread that carried the new mark used to carry the old `blockedUnder` with it.
   * The `retry` arm two cases up already clears both together, on the stated
   * grounds that the field *"means nothing without the mark"*; a 403 ends the
   * comparison just as finally, so the same rule has to apply.
   *
   * Honest note on reachability: there is **no visible symptom today**, because
   * `strandedStateOf` returns on `account-revoked` before any `blockedUnder` is
   * read, and the mark is sticky, so the only thing that clears it is a success
   * that removes the entry outright. It is fixed because the module's own
   * invariant is that this field follows the session, and because the default here
   * is the wrong one — the same argument `BLOCK_PERSISTENCE` makes for being an
   * exhaustive `Record` rather than a hand-copied comparison.
   *
   * Duo review round 9 on `!348`, and the one finding of that round. Verified
   * against `applyOutcome` before acting: the finding is accurate, including its
   * own note about the short-circuit.
   */
  it("drops a stale blockedUnder when a 403 supersedes a 409", () => {
    const store = seeded([
      capture({ blockedBy: "session-expired", blockedUnder: "ws-old" }),
    ]);

    applyFlushOutcome(store, "k1", "account-revoked", LIVE);

    const entry = readQueue(store)[0];
    expect(entry?.blockedBy).toBe("account-revoked");
    expect(entry?.blockedUnder).toBeUndefined();
  });

  it("rejects a stored blockedUnder that is not a non-empty string", () => {
    const store = memoryStore({
      [CAPTURE_QUEUE_STORAGE_KEY]: JSON.stringify([
        { ...capture({ clientKey: "bad" }), blockedUnder: 7 },
        { ...capture({ clientKey: "blank" }), blockedUnder: "" },
        { ...capture({ clientKey: "good" }), blockedUnder: LIVE },
      ]),
    });

    // The kept case is the point: a guard that rejected everything would pass a
    // test asserting only rejection, and this field selects the sentence.
    expect(readQueue(store).map((c) => c.clientKey)).toEqual(["good"]);
  });
});

describe("capture queue — orphan expiry (#175)", () => {
  it("stamps unresolvableSince the first time the workspace does not match", () => {
    const store = seeded([capture({ workspaceId: OTHER })]);

    sweepUnresolvable(store, LIVE, 5_000);

    expect(readQueue(store)[0]?.unresolvableSince).toBe(5_000);
  });

  it("does not move an existing stamp on a later read that still does not match", () => {
    // An implementation that rewrites the stamp on every read never expires
    // anything at all.
    const store = seeded([capture({ workspaceId: OTHER })]);

    sweepUnresolvable(store, LIVE, 5_000);
    sweepUnresolvable(store, LIVE, 9_000);

    expect(readQueue(store)[0]?.unresolvableSince).toBe(5_000);
  });

  it("clears the stamp when the workspace resolves again", () => {
    const store = seeded([capture({ unresolvableSince: 5_000 })]);

    sweepUnresolvable(store, LIVE, 9_000);

    expect(readQueue(store)[0]?.unresolvableSince).toBeUndefined();
  });

  it("keeps an entry still inside the window", () => {
    // The assertion that matters: an expiry firing early destroys unsaved
    // words, which is the one thing this feature exists to prevent.
    const window = CAPTURE_ORPHAN_WINDOW_HOURS * HOUR_MS;
    const store = seeded([
      capture({ workspaceId: OTHER, unresolvableSince: 1_000 }),
    ]);

    sweepUnresolvable(store, LIVE, 1_000 + window - 1);

    expect(readQueue(store)).toHaveLength(1);
  });

  it("removes an entry past the window", () => {
    const window = CAPTURE_ORPHAN_WINDOW_HOURS * HOUR_MS;
    const store = seeded([
      capture({ workspaceId: OTHER, unresolvableSince: 1_000 }),
      capture({ clientKey: "mine", text: "still mine" }),
    ]);

    sweepUnresolvable(store, LIVE, 1_000 + window + 1);

    expect(readQueue(store).map((c) => c.clientKey)).toEqual(["mine"]);
  });

  it("never expires an entry belonging to the live workspace", () => {
    const window = CAPTURE_ORPHAN_WINDOW_HOURS * HOUR_MS;
    const store = seeded([capture({ unresolvableSince: 1_000 })]);

    sweepUnresolvable(store, LIVE, 1_000 + window + 1);

    expect(readQueue(store)).toHaveLength(1);
  });

  it("rejects a stored unresolvableSince that is not a finite number", () => {
    // NaN compares false against every bound, so a corrupt entry would become
    // permanent rather than loud.
    const store = memoryStore({
      [CAPTURE_QUEUE_STORAGE_KEY]: JSON.stringify([
        { ...capture({ clientKey: "bad" }), unresolvableSince: "soon" },
        { ...capture({ clientKey: "nan" }), unresolvableSince: null },
        { ...capture({ clientKey: "good" }), unresolvableSince: 1 },
      ]),
    });

    expect(readQueue(store).map((c) => c.clientKey)).toEqual(["good"]);
  });

  it("reports a refused write rather than claiming the sweep landed", () => {
    // Unstamped and non-matching, so the sweep genuinely has a write to make —
    // an already-stamped entry inside the window is a no-op and would pass this
    // assertion for the wrong reason.
    const store: QueueStore = {
      getItem: () => JSON.stringify([capture({ workspaceId: OTHER })]),
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };

    expect(sweepUnresolvable(store, LIVE, 9_000)).toEqual({
      ok: false,
      reason: "storage-unavailable",
    });
  });

  it("writes nothing when there is nothing to change", () => {
    // The sweep runs on every mount, so a no-op that still wrote would put a
    // 64 KB `setItem` on the mount path of every load.
    let writes = 0;
    const base: QueueStore = memoryStore({
      [CAPTURE_QUEUE_STORAGE_KEY]: JSON.stringify([capture()]),
    });
    const store: QueueStore = {
      getItem: base.getItem,
      setItem: (k, v) => {
        writes += 1;
        base.setItem(k, v);
      },
      removeItem: base.removeItem,
    };

    sweepUnresolvable(store, LIVE, 9_000);

    expect(writes).toBe(0);
  });
});

describe("capture queue — discard (#175)", () => {
  it("removes exactly one entry and leaves the rest byte-identical", () => {
    const queue = [
      capture({ clientKey: "a" }),
      capture({ clientKey: "b" }),
      capture({ clientKey: "c" }),
    ];
    const store = seeded(queue);

    const result = discardCapture(store, "b");

    expect(result.ok).toBe(true);
    expect(readQueue(store)).toEqual([queue[0], queue[2]]);
  });

  it("empties the key rather than leaving [] behind", () => {
    const store = seeded([capture()]);

    discardCapture(store, "k1");

    expect(store.getItem(CAPTURE_QUEUE_STORAGE_KEY)).toBeNull();
  });

  it("removes a whole stranded group by its keys", () => {
    const store = seeded([
      capture({ clientKey: "a", workspaceId: OTHER }),
      capture({ clientKey: "b", workspaceId: OTHER }),
      capture({ clientKey: "mine" }),
    ]);

    discardCapture(store, ["a", "b"]);

    expect(readQueue(store).map((c) => c.clientKey)).toEqual(["mine"]);
  });

  it("reports a refused write instead of reporting words thrown away", () => {
    const store: QueueStore = {
      getItem: () => JSON.stringify([capture()]),
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };

    expect(discardCapture(store, "k1")).toEqual({
      ok: false,
      reason: "storage-unavailable",
    });
  });
});

describe("capture queue — clientKey does not collide with a queued key (#175)", () => {
  it("increments the tier-3 sequence past a key already in the queue", () => {
    // Same state a second tab would have produced, reached through the store
    // rather than through two JS realms — which a test cannot hold.
    const realCrypto = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, "crypto", {
        value: undefined,
        configurable: true,
      });
      const first = newClientKey();
      const second = newClientKey([first]);
      expect(second).not.toBe(first);
      expect(second.startsWith("clk-")).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: realCrypto,
        configurable: true,
      });
    }
  });

  it("does not increment when nothing collides — the control", () => {
    // Without this half, a guard that always increments passes the test above.
    const realCrypto = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, "crypto", {
        value: undefined,
        configurable: true,
      });
      const withNoRivals = newClientKey([]);
      const again = newClientKey([]);
      // Two calls still differ (the module counter), and neither had to skip a
      // sequence value to get there.
      expect(withNoRivals).not.toBe(again);
      const seqOf = (key: string) => key.split("-")[2];
      const step =
        parseInt(seqOf(again) ?? "0", 36) -
        parseInt(seqOf(withNoRivals) ?? "0", 36);
      expect(step).toBe(1);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: realCrypto,
        configurable: true,
      });
    }
  });

  it("re-draws a random key that collides, so tiers 1 and 2 get the same guard", () => {
    const first = newClientKey();
    const second = newClientKey([first]);
    expect(second).not.toBe(first);
  });
});
