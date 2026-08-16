import { describe, it, expect } from "vitest";
import {
  CAPTURE_MIRROR_DB_NAME,
  CAPTURE_MIRROR_DB_VERSION,
  CAPTURE_MIRROR_STORE,
  CAPTURE_SYNC_TAG,
  deleteMirrored,
  mirroredFrom,
  openMirror,
  planMirrorReconciliation,
  putMirrored,
  readMirrored,
  type MirroredCapture,
} from "@/lib/capture-mirror";
import type { QueuedCapture } from "@/lib/capture-queue";
import { fakeIdbFactory } from "@/lib/__tests__/fake-idb";

/**
 * #175 — the worker-readable mirror of the capture queue.
 *
 * The service worker cannot read `localStorage`, so the queue is copied into
 * IndexedDB **for the worker's benefit only** — a cache of the real thing, never
 * the source of truth. `localStorage` carries the durability guarantee because it
 * completes synchronously inside `submit()`; the mirror write is initiated in the
 * same block and settles later.
 *
 * Spec: `docs/design/specs/2026-08-11-offline-capture-queue-design.md`, under
 * *"Reconciliation on mount runs in both directions"*.
 */

const LIVE = "ws-live";

function capture(over: Partial<QueuedCapture> = {}): QueuedCapture {
  return {
    clientKey: "k1",
    text: "ring mum about the boiler",
    workspaceId: LIVE,
    capturedAt: 1_000,
    ...over,
  };
}

describe("capture mirror — what gets mirrored (#175)", () => {
  it("carries blockedBy, because the worker needs it to skip a terminal entry", () => {
    // Stated in the spec because the mirror is described as "a cache of the real
    // thing" and a reader could reasonably mirror only the fields the POST body
    // needs — which would silently remove the worker's only way to tell its two
    // `waitUntil` exits apart, and put it back into rejecting for ever.
    const entry = mirroredFrom(capture({ blockedBy: "account-revoked" }));

    expect(entry.blockedBy).toBe("account-revoked");
  });

  it("does not mirror blockedUnder or unresolvableSince", () => {
    // Both are written from the live session's resolved workspace, which the
    // worker has none of. It never expires anything and never chooses copy, so
    // mirroring them would add a second at-rest copy of user data with no reader.
    const entry = mirroredFrom(
      capture({
        blockedBy: "session-expired",
        blockedUnder: LIVE,
        unresolvableSince: 5_000,
      }),
    ) as MirroredCapture & Record<string, unknown>;

    expect(entry.blockedUnder).toBeUndefined();
    expect(entry.unresolvableSince).toBeUndefined();
    expect(Object.keys(entry).sort()).toEqual([
      "blockedBy",
      "capturedAt",
      "clientKey",
      "text",
      "workspaceId",
    ]);
  });

  it("omits blockedBy entirely when there is no refusal", () => {
    expect(Object.keys(mirroredFrom(capture())).sort()).toEqual([
      "capturedAt",
      "clientKey",
      "text",
      "workspaceId",
    ]);
  });
});

describe("capture mirror — reconciliation runs in both directions (#175)", () => {
  it("deletes a mirror entry with no localStorage counterpart", () => {
    // It was already saved, or the user discarded it. A mirror is not allowed to
    // resurrect anything.
    const plan = planMirrorReconciliation(
      [capture({ clientKey: "still-here" })],
      [
        mirroredFrom(capture({ clientKey: "still-here" })),
        mirroredFrom(capture({ clientKey: "gone" })),
      ],
    );

    expect(plan.remove).toEqual(["gone"]);
    expect(plan.put).toEqual([]);
  });

  it("re-mirrors a localStorage entry missing from IndexedDB", () => {
    // The direction that is not obvious, and the one whose absence would put an
    // arbitrary subset of the queue permanently outside Background Sync — the
    // only path that works while no tab is open. A tab discarded between the
    // synchronous `localStorage` write and the async mirror write leaves exactly
    // this state, and it is what Chrome Android does.
    const plan = planMirrorReconciliation(
      [capture({ clientKey: "a" }), capture({ clientKey: "b" })],
      [mirroredFrom(capture({ clientKey: "a" }))],
    );

    expect(plan.put.map((e) => e.clientKey)).toEqual(["b"]);
    expect(plan.remove).toEqual([]);
  });

  it("plans nothing when the two stores already agree", () => {
    const queue = [capture({ clientKey: "a" })];
    const plan = planMirrorReconciliation(queue, queue.map(mirroredFrom));

    expect(plan).toEqual({ remove: [], put: [], marks: [] });
  });

  it("copies an account-revoked mark from the mirror INTO localStorage", () => {
    // The worker is the only writer that can learn a refusal while no tab is
    // open, and it cannot write `localStorage`. `blockedBy` is not membership, so
    // it sits outside the "localStorage wins" rule rather than contradicting it.
    const plan = planMirrorReconciliation(
      [capture({ clientKey: "a" })],
      [mirroredFrom(capture({ clientKey: "a", blockedBy: "account-revoked" }))],
    );

    expect(plan.marks).toEqual([
      { clientKey: "a", blockedBy: "account-revoked" },
    ]);
    // Membership is unaffected: the carve-out moves a FIELD onto an entry that
    // already exists on both sides, and never adds or revives one.
    expect(plan.remove).toEqual([]);
  });

  it("does NOT generalise the carve-out into resurrecting a deleted entry", () => {
    // The control. An implementation that read "the mirror can be newer" would
    // pass the mark test above and fail this one.
    const plan = planMirrorReconciliation(
      [],
      [mirroredFrom(capture({ clientKey: "a", blockedBy: "account-revoked" }))],
    );

    expect(plan.marks).toEqual([]);
    expect(plan.remove).toEqual(["a"]);
  });

  it("does not copy a session-expired mark in from the mirror", () => {
    // Only `account-revoked` may flow this way. A `session-expired` mark is
    // useless without `blockedUnder`, which the worker cannot compute — and
    // accepting one would RESURRECT a mark a retryable outcome had deliberately
    // cleared, re-offering a sign-in that has already happened.
    const plan = planMirrorReconciliation(
      [capture({ clientKey: "a" })],
      [mirroredFrom(capture({ clientKey: "a", blockedBy: "session-expired" }))],
    );

    expect(plan.marks).toEqual([]);
    // The stale mirror copy is corrected instead.
    expect(plan.put.map((e) => e.clientKey)).toEqual(["a"]);
  });

  it("keeps an account-revoked mark already in localStorage against a weaker mirror", () => {
    // Precedence decides the merge, so the carve-out cannot downgrade anything.
    const plan = planMirrorReconciliation(
      [capture({ clientKey: "a", blockedBy: "account-revoked" })],
      [mirroredFrom(capture({ clientKey: "a", blockedBy: "session-expired" }))],
    );

    expect(plan.marks).toEqual([]);
    expect(plan.put[0]?.blockedBy).toBe("account-revoked");
  });

  it("re-mirrors an entry whose text drifted, so the worker never POSTs stale words", () => {
    const plan = planMirrorReconciliation(
      [capture({ clientKey: "a", text: "the real words" })],
      [mirroredFrom(capture({ clientKey: "a", text: "an older copy" }))],
    );

    expect(plan.put[0]?.text).toBe("the real words");
  });
});

describe("capture mirror — the IndexedDB layer (#175)", () => {
  it("opens the store and round-trips an entry", async () => {
    const factory = fakeIdbFactory();
    const db = await openMirror(factory);
    expect(db).not.toBeNull();

    await putMirrored(db, [mirroredFrom(capture({ clientKey: "a" }))]);

    expect((await readMirrored(db)).map((e) => e.clientKey)).toEqual(["a"]);
  });

  it("deletes by key", async () => {
    const db = await openMirror(fakeIdbFactory());
    await putMirrored(db, [
      mirroredFrom(capture({ clientKey: "a" })),
      mirroredFrom(capture({ clientKey: "b" })),
    ]);

    await deleteMirrored(db, ["a"]);

    expect((await readMirrored(db)).map((e) => e.clientKey)).toEqual(["b"]);
  });

  it("upserts on the same key rather than duplicating", async () => {
    const db = await openMirror(fakeIdbFactory());
    await putMirrored(db, [mirroredFrom(capture({ clientKey: "a" }))]);
    await putMirrored(db, [
      mirroredFrom(capture({ clientKey: "a", blockedBy: "account-revoked" })),
    ]);

    const all = await readMirrored(db);
    expect(all).toHaveLength(1);
    expect(all[0]?.blockedBy).toBe("account-revoked");
  });

  it("drops a stored value that is not a mirrored capture", async () => {
    // The mirror is writable by anything on the origin, and the worker POSTs
    // whatever it finds. An unvalidated read is a request built from a value
    // nothing in this app wrote.
    const factory = fakeIdbFactory();
    const db = await openMirror(factory);
    factory.seed(CAPTURE_MIRROR_STORE, [
      { clientKey: "junk" },
      mirroredFrom(capture({ clientKey: "real" })),
    ]);

    expect((await readMirrored(db)).map((e) => e.clientKey)).toEqual(["real"]);
  });

  it("returns null rather than throwing when IndexedDB is unavailable", async () => {
    // Firefox private browsing throws from `open`, and a capture bar that
    // crashes is worse than one with no background flush.
    expect(await openMirror(undefined)).toBeNull();
    expect(await openMirror(fakeIdbFactory({ failOpen: true }))).toBeNull();
  });

  it("answers every write on a null database instead of throwing", async () => {
    // The mirror is best-effort by construction: `localStorage` already holds the
    // words, so a mirror failure costs Background Sync and never a capture.
    await expect(putMirrored(null, [mirroredFrom(capture())])).resolves.toBe(
      false,
    );
    await expect(deleteMirrored(null, ["a"])).resolves.toBe(false);
    await expect(readMirrored(null)).resolves.toEqual([]);
  });

  it("reports a failed transaction instead of claiming the write landed", async () => {
    const db = await openMirror(fakeIdbFactory({ failWrites: true }));

    await expect(putMirrored(db, [mirroredFrom(capture())])).resolves.toBe(
      false,
    );
  });
});

describe("capture mirror — the constants the worker copies (#175)", () => {
  it("names the store, the version and the sync tag in one place", () => {
    // `public/sw.js` is not bundled, so it cannot import these. It repeats them
    // as literals, and `capture-sync-worker.test.ts` asserts the two agree —
    // which is the only thing standing between a renamed store and a worker
    // reading an empty database for ever.
    expect(CAPTURE_MIRROR_DB_NAME).toBe("df-capture-queue");
    expect(CAPTURE_MIRROR_DB_VERSION).toBe(1);
    expect(CAPTURE_MIRROR_STORE).toBe("captures");
    expect(CAPTURE_SYNC_TAG).toBe("capture-flush");
  });
});
