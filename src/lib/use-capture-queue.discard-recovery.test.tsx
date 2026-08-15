// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect } from "react";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCaptureQueue, type CaptureQueueApi } from "@/lib/use-capture-queue";
import { CAPTURE_QUEUE_STORAGE_KEY, readQueue } from "@/lib/capture-queue";

/**
 * #175 — where a Discard meets the `storage`-event re-enqueue.
 *
 * ── Why this is its own file ─────────────────────────────────────────────────
 *
 * Both cases need the mirror's `deleteMirrored` to be **suspendable**, which
 * takes a module mock, and `use-capture-queue.test.tsx` deliberately runs against
 * the real `capture-mirror.ts` with `indexedDB` absent. Mocking it there would
 * quietly weaken thirty cases that are about the real reconciliation.
 *
 * ── The defect this file pins ────────────────────────────────────────────────
 *
 * The re-enqueue exists to recover a capture another tab **clobbered** out of the
 * queue — `capture-queue.ts`'s last CAS attempt writes without the comparison, so
 * a losing tab can find its own pending words gone from a queue it never removed
 * them from. It infers "clobbered" from **absence**, and absence has more than one
 * cause. One of them is a Discard, and re-adding those words is the *"silent save
 * after an explicit refusal"* that `discard`'s own mirror-first ordering exists to
 * prevent — arriving by a different door.
 *
 * Duo review round 2 on `!348` reported this as *"a missing `claimed` check"*. The
 * finding is real and the mechanism named is not the reachable one, so both are
 * handled here and the difference is written down rather than smoothed over:
 *
 *  * **Reachable, and fixed:** a Discard whose confirm resolves against an entry
 *    already gone answers `already-saved` and used to leave the key in
 *    `awaiting`, so the *next* `storage` event about the queue put the discarded
 *    capture back — permanently, and it would then be POSTed and created, because
 *    a never-saved capture has no `200` duplicate to absorb it. Case 1 below,
 *    measured red.
 *  * **Not reachable today, guarded anyway:** the window Duo described, inside
 *    `discard`'s own `await`. It self-heals only because `discardCapture`,
 *    `broadcast()` and the `awaiting` purge run in **one synchronous block** after
 *    that await — so a single extra `await` between them, a perfectly ordinary
 *    future edit, makes it durable with nothing going red. Case 2 pins the
 *    property instead of the accident.
 *
 * ⚠️ **A third case is NOT fixed here and must not be read as covered:** another
 * tab's Discard is still undone by this one, because `claimed` is per-tab and
 * nothing in `localStorage` distinguishes a deliberate removal from a clobber. It
 * is recorded in `use-capture-queue.ts`'s docblock with the shape of the fix.
 */

const LIVE = "ws-live";

/** Resolvers for the suspendable mirror writes, set per case. */
let pendingDeletes: (() => void)[] = [];
let deleteCalls: string[][] = [];

vi.mock("@/lib/capture-mirror", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capture-mirror")>();
  return {
    ...actual,
    // No real IndexedDB in jsdom, and the mount path must stay benign.
    openMirror: vi.fn().mockResolvedValue(null),
    readMirrored: vi.fn().mockResolvedValue([]),
    putMirrored: vi.fn().mockResolvedValue(true),
    /**
     * Suspends until the case releases it. This is the window `discard` really
     * has in a browser: `writeMirror` resolves on the transaction's
     * `oncomplete`, which is a task, so a `storage` event can be delivered
     * inside it. With `db === null` the real implementation resolves on a
     * microtask and no event can interleave — which is why the defect is
     * invisible to a test that does not do this.
     */
    deleteMirrored: vi.fn((_db: unknown, keys: readonly string[]) => {
      deleteCalls.push([...keys]);
      return new Promise<boolean>((resolve) => {
        pendingDeletes.push(() => resolve(true));
      });
    }),
  };
});

let latest: CaptureQueueApi | null = null;

function Host() {
  const api = useCaptureQueue(LIVE);
  useEffect(() => {
    latest = api;
  }, [api]);
  return (
    <button onClick={() => api.enqueueCapture("ring mum about the boiler")}>
      add
    </button>
  );
}

function installStorage(): void {
  const map = new Map<string, string>();
  const storage = {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}

/** What another tab writing the queue looks like from in here. */
function otherTabWrites(queue: unknown[]): void {
  window.localStorage.setItem(CAPTURE_QUEUE_STORAGE_KEY, JSON.stringify(queue));
  window.dispatchEvent(
    new StorageEvent("storage", { key: CAPTURE_QUEUE_STORAGE_KEY }),
  );
}

beforeEach(() => {
  installStorage();
  latest = null;
  pendingDeletes = [];
  deleteCalls = [];
  // Offline for every case here: the capture has to stay queued, and a flush that
  // succeeded would remove it from `awaiting` for the uninteresting reason.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
  vi.stubGlobal("indexedDB", undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Enqueue one capture from this tab and return its key. */
async function enqueueOne(): Promise<string> {
  render(<Host />);
  await userEvent.click(screen.getByRole("button", { name: "add" }));
  const queued = readQueue(window.localStorage)[0];
  expect(queued).toBeDefined();
  return queued!.clientKey;
}

describe("useCaptureQueue — a Discard is not undone by the re-enqueue (#175)", () => {
  it("stops recovering an entry whose discard resolved as already-saved", async () => {
    const key = await enqueueOne();

    // The entry leaves the queue between the press and the confirm — another tab
    // dealt with it. No storage event yet; this is just the state the re-check
    // will read.
    window.localStorage.setItem(CAPTURE_QUEUE_STORAGE_KEY, JSON.stringify([]));
    await act(async () => {
      expect(await latest!.discard([key])).toBe("already-saved");
    });

    // Any later event about the queue. The user has said "throw it away", so this
    // tab must have stopped holding a recovery claim on it.
    await act(async () => {
      otherTabWrites([]);
      await Promise.resolve();
    });

    expect(readQueue(window.localStorage).map((c) => c.clientKey)).toEqual([]);
  });

  /**
   * The non-vacuous control. The case above asserts an empty queue, which a hook
   * that had stopped re-enqueueing altogether would also produce — and that
   * regression removes the only recovery a clobbered capture has.
   */
  it("still recovers a capture nobody discarded", async () => {
    const key = await enqueueOne();

    await act(async () => {
      otherTabWrites([]);
      await Promise.resolve();
    });

    expect(readQueue(window.localStorage).map((c) => c.clientKey)).toEqual([
      key,
    ]);
  });

  it("does not re-enqueue an entry a discard has claimed but not yet removed", async () => {
    const key = await enqueueOne();

    // Started, deliberately not awaited: `discard` has claimed the key and is
    // suspended inside `deleteMirrored`, which is exactly where a browser's
    // transaction leaves it.
    let discarding: Promise<unknown> | null = null;
    await act(async () => {
      discarding = latest!.discard([key]);
      await Promise.resolve();
    });
    expect(deleteCalls).toEqual([[key]]);

    // Another tab removes it while the claim is held. Without the `claimed`
    // check, `awaiting` still holds the key and it goes straight back in.
    await act(async () => {
      otherTabWrites([]);
      await Promise.resolve();
    });
    expect(readQueue(window.localStorage).map((c) => c.clientKey)).toEqual([]);

    await act(async () => {
      for (const release of pendingDeletes) release();
      await discarding;
    });
    expect(readQueue(window.localStorage)).toEqual([]);
  });
});
