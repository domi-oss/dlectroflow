// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect } from "react";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CAPTURE_QUEUE_EVENT,
  useCaptureQueue,
  type CaptureQueueApi,
} from "@/lib/use-capture-queue";
import {
  CAPTURE_QUEUE_STORAGE_KEY,
  readQueue,
  type QueuedCapture,
} from "@/lib/capture-queue";

/**
 * #175 — the hook: the four flush triggers, the `storage`-event re-enqueue, and
 * Discard's claim.
 *
 * ⚠️ **The re-enqueue is `capture-queue.ts`'s safety net, not a nicety.** That
 * module's last CAS attempt writes WITHOUT the comparison, deliberately — and the
 * reason the improbable clobber is acceptable is not that the loss is small, it is
 * that **the clobbered tab has already told its user the words are queued.** This
 * is the only thing that recovers them, and it needs a component lifecycle, which
 * is why it cannot live in the pure module.
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

function seed(items: QueuedCapture[]): void {
  window.localStorage.setItem(CAPTURE_QUEUE_STORAGE_KEY, JSON.stringify(items));
}

let latest: CaptureQueueApi | null = null;

/**
 * A host component, so the hook runs under real React rules.
 *
 * The api is published from an EFFECT rather than during render: assigning an
 * outer variable while rendering is a side effect, and `react-hooks/globals` is
 * an error in this repo for the reason it gives — the moment a component happens
 * to re-render then decides what a test observes.
 */
function Host({ workspaceId = LIVE }: { workspaceId?: string }) {
  const api = useCaptureQueue(workspaceId);
  useEffect(() => {
    latest = api;
  }, [api]);
  return (
    <div>
      <span data-testid="mine">{api.mine.length}</span>
      <span data-testid="stranded">{api.stranded.length}</span>
      <span data-testid="flushing">{String(api.flushing)}</span>
      <span data-testid="announcement">{api.announcement?.reason ?? ""}</span>
      <button onClick={() => api.enqueueCapture("typed just now")}>add</button>
    </div>
  );
}

function jsonReply(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * An in-memory `Storage`, installed on `window` for each case.
 *
 * ⚠️ **This jsdom environment has no `localStorage` at all** — `theme-toggle.test.tsx`
 * wraps its `localStorage.clear()` in a `try`/`catch` commented `/* jsdom *\/`
 * for exactly that reason, and it is why every pure module here takes the store
 * as an argument. The hook reads `window.localStorage`, so the double goes there.
 */
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

beforeEach(() => {
  installStorage();
  latest = null;
  fetchMock = vi.fn().mockResolvedValue(jsonReply(201));
  vi.stubGlobal("fetch", fetchMock);
  // IndexedDB is absent in jsdom. `openMirror` answers null for exactly this,
  // and every mirror write then reports false rather than throwing — which is
  // the property under test everywhere the mirror is not the subject.
  vi.stubGlobal("indexedDB", undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useCaptureQueue — the queue is written BEFORE the network (#175)", () => {
  it("stores the capture synchronously, before any fetch resolves", async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "add" }));

    // The assertion that matters: the words are in storage, whatever the network
    // then does. Chrome discards background tabs under memory pressure and a
    // discarded tab fires no unload event, so there is no later chance to write.
    const stored = readQueue(window.localStorage);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.text).toBe("typed just now");
    expect(stored[0]?.workspaceId).toBe(LIVE);
  });

  it("mints a clientKey that does not collide with one already queued", async () => {
    seed([capture({ clientKey: "already-here" })]);
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "add" }));

    const keys = readQueue(window.localStorage).map((c) => c.clientKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("reports a refusal and keeps the words out of storage", async () => {
    // A cap refusal is user-facing behaviour, not a defensive branch: the words
    // stay in the field and the strip says which of the four it was.
    // ⚠️ The network must FAIL here, or the mount flush drains the seeded 20 and
    // the cap is never reached — the test would pass for the wrong reason.
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    seed(
      Array.from({ length: 20 }, (_, i) =>
        capture({ clientKey: `k${i}`, text: "x" }),
      ),
    );
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "add" }));

    await waitFor(() =>
      expect(screen.getByTestId("announcement")).toHaveTextContent("max-items"),
    );
    expect(readQueue(window.localStorage)).toHaveLength(20);
  });

  it("gives every announcement a fresh token, so an identical one re-announces", async () => {
    // ⚠️ Writing the same string into `role="alert"` twice leaves the second
    // SILENT — the user presses Enter against a full queue, is refused, and hears
    // nothing at all. The token is what makes the region's content genuinely
    // change; the DOM holding the right words is not the same as them being said.
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    seed(
      Array.from({ length: 20 }, (_, i) =>
        capture({ clientKey: `k${i}`, text: "x" }),
      ),
    );
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "add" }));
    const first = latest?.announcement?.token;
    await userEvent.click(screen.getByRole("button", { name: "add" }));

    await waitFor(() => expect(latest?.announcement?.token).not.toBe(first));
    expect(latest?.announcement?.reason).toBe("max-items");
  });
});

describe("useCaptureQueue — the flush (#175)", () => {
  it("POSTs the three fields the route's contract names", async () => {
    seed([capture()]);
    render(<Host />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe("/api/braindump");
    expect(init.method).toBe("POST");
    expect(Object.keys(JSON.parse(init.body)).sort()).toEqual([
      "clientKey",
      "text",
      "workspaceId",
    ]);
  });

  it("removes a saved capture from the queue", async () => {
    seed([capture()]);
    render(<Host />);

    await waitFor(() => expect(readQueue(window.localStorage)).toEqual([]));
  });

  it("removes a duplicate exactly as it removes a save", async () => {
    fetchMock.mockResolvedValue(jsonReply(200, { status: "duplicate" }));
    seed([capture()]);
    render(<Host />);

    await waitFor(() => expect(readQueue(window.localStorage)).toEqual([]));
  });

  it("keeps a capture on a 5xx and clears no words", async () => {
    fetchMock.mockResolvedValue(jsonReply(503));
    seed([capture()]);
    render(<Host />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(readQueue(window.localStorage)).toHaveLength(1);
  });

  it("keeps a capture when fetch throws — the ordinary offline case", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    seed([capture()]);
    render(<Host />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(readQueue(window.localStorage)).toHaveLength(1);
  });

  it("records blockedUnder with a 409, so the sign-in offer can be withdrawn later", async () => {
    fetchMock.mockResolvedValue(jsonReply(409, { status: "session-expired" }));
    seed([capture()]);
    render(<Host />);

    await waitFor(() =>
      expect(readQueue(window.localStorage)[0]?.blockedUnder).toBe(LIVE),
    );
    expect(readQueue(window.localStorage)[0]?.blockedBy).toBe(
      "session-expired",
    );
  });

  it("needs the BODY as well as the status line — a bare 403 is retryable", async () => {
    // A 403 from an auth proxy, an ingress rule or a corporate filter must not
    // permanently mark a good capture "this account can no longer save", whose
    // only exit is the user deliberately destroying the words.
    fetchMock.mockResolvedValue(jsonReply(403, { error: "blocked by proxy" }));
    seed([capture()]);
    render(<Host />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(readQueue(window.localStorage)[0]?.blockedBy).toBeUndefined();
  });

  /**
   * The other half of the same conjunction, asserted here as well as in
   * `capture-sync-worker.test.ts` — deliberately, and not as duplication.
   *
   * Duo review round 2 on `!348` found `public/sw.js` and this hook classifying
   * one response two different ways. `outcomeOf` already had the strict rule, so a
   * test only on the worker would pin the fix at the site that happened to be
   * wrong rather than the rule both sites owe. The two flush paths cannot share
   * code — the worker imports nothing — so they are held together by having the
   * same pair of cases on each side.
   */
  it("needs the STATUS as well as the body — a 500 that says account-revoked is retryable", async () => {
    fetchMock.mockResolvedValue(jsonReply(500, { status: "account-revoked" }));
    seed([capture()]);
    render(<Host />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(readQueue(window.localStorage)[0]?.blockedBy).toBeUndefined();
  });

  it("marks a real 403 and then stops POSTing it", async () => {
    fetchMock.mockResolvedValue(jsonReply(403, { status: "account-revoked" }));
    seed([capture()]);
    render(<Host />);

    await waitFor(() =>
      expect(readQueue(window.localStorage)[0]?.blockedBy).toBe(
        "account-revoked",
      ),
    );
    const callsAfterMark = fetchMock.mock.calls.length;
    await act(async () => {
      await latest?.flush();
    });
    // Skipped, not retried: a 403 that can never clear must not be re-POSTed on
    // every trigger for the life of the browser profile.
    expect(fetchMock.mock.calls.length).toBe(callsAfterMark);
  });

  it("does not flush another workspace's captures", async () => {
    seed([capture({ workspaceId: "ws-someone-else" })]);
    render(<Host />);

    await act(async () => {
      await latest?.flush();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readQueue(window.localStorage)).toHaveLength(1);
  });
});

describe("useCaptureQueue — the four foreground triggers (#175)", () => {
  it("flushes on mount", async () => {
    seed([capture()]);
    render(<Host />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("flushes when the tab becomes visible again", async () => {
    render(<Host />);
    await waitFor(() => expect(latest).not.toBeNull());
    seed([capture()]);

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it("flushes on the online event, as an opportunistic hint", async () => {
    // `online` is never a GATE — `navigator.onLine` reads true on a captive
    // portal, in a lift and at the edge of coverage, so a false reading must
    // never prevent an attempt.
    render(<Host />);
    await waitFor(() => expect(latest).not.toBeNull());
    seed([capture()]);

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it("registers no unload listener at all", async () => {
    // A discarded tab fires neither `beforeunload` nor reliably `pagehide`, which
    // is why the write happens at submit instead. A listener here would read as a
    // durability mechanism and be none.
    const spy = vi.spyOn(window, "addEventListener");
    render(<Host />);
    await waitFor(() => expect(latest).not.toBeNull());

    const types = spy.mock.calls.map((c) => c[0]);
    expect(types).not.toContain("beforeunload");
    expect(types).not.toContain("pagehide");
    expect(types).not.toContain("unload");
  });
});

describe("useCaptureQueue — the storage-event re-enqueue (#175)", () => {
  it("puts back a capture another tab clobbered out of the queue", async () => {
    // The residual `capture-queue.ts` names and cannot close: `getItem` has no
    // ordering guarantee against another tab's `setItem`, so no amount of
    // re-reading detects a stale read. The losing tab notices AFTERWARDS that the
    // queue no longer holds its own pending capture, and re-enqueues.
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "add" }));

    const mine = readQueue(window.localStorage)[0];
    expect(mine).toBeDefined();

    // Another tab writes a queue that does not contain it.
    await act(async () => {
      seed([capture({ clientKey: "other-tabs-capture", text: "theirs" })]);
      window.dispatchEvent(
        new StorageEvent("storage", { key: CAPTURE_QUEUE_STORAGE_KEY }),
      );
      await Promise.resolve();
    });

    const after = readQueue(window.localStorage).map((c) => c.clientKey);
    expect(after).toContain("other-tabs-capture");
    expect(after).toContain(mine!.clientKey);
  });

  it("ignores a storage event for an unrelated key", async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "add" }));
    const before = readQueue(window.localStorage);

    await act(async () => {
      window.localStorage.removeItem(CAPTURE_QUEUE_STORAGE_KEY);
      window.dispatchEvent(new StorageEvent("storage", { key: "df-theme" }));
      await Promise.resolve();
    });

    // Nothing was put back, because nothing about OUR key was reported.
    expect(readQueue(window.localStorage)).toEqual([]);
    expect(before).toHaveLength(1);
  });

  it("does not resurrect a capture another tab successfully flushed", async () => {
    // The other direction, and the one that makes this a delta rather than a
    // union: re-adding a key whose flush is outstanding would put back something
    // that may have just saved.
    let resolveFetch: ((value: Response) => void) | null = null;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "add" }));
    // Started, deliberately not awaited: the POST has to still be outstanding
    // when the other tab's write arrives.
    const flushing = latest!.flush();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    await act(async () => {
      window.localStorage.removeItem(CAPTURE_QUEUE_STORAGE_KEY);
      window.dispatchEvent(
        new StorageEvent("storage", { key: CAPTURE_QUEUE_STORAGE_KEY }),
      );
      await Promise.resolve();
    });

    expect(readQueue(window.localStorage)).toEqual([]);
    await act(async () => {
      resolveFetch?.(jsonReply(200));
      await flushing;
    });
  });
});

describe("useCaptureQueue — Discard re-checks at resolution (#175)", () => {
  it("removes the entry and says so", async () => {
    seed([capture()]);
    fetchMock.mockResolvedValue(jsonReply(503));
    render(<Host />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    await act(async () => {
      expect(await latest!.discard(["k1"])).toBe("discarded");
    });
    expect(readQueue(window.localStorage)).toEqual([]);
  });

  it("says it SAVED when the confirm resolves against an entry already gone", async () => {
    // Silence here is the same defect as a silent save, one step along: the user
    // pressed a destructive control, was shown nothing, and the words are
    // somewhere they were told they would not be.
    render(<Host />);
    await waitFor(() => expect(latest).not.toBeNull());

    await act(async () => {
      expect(await latest!.discard(["never-existed"])).toBe("already-saved");
    });
  });

  it("REFUSES while a POST for that entry is outstanding", async () => {
    // ⚠️ The re-check at confirm-resolution is the guard, not the press-time
    // check. The two-step confirm is a human pause of exactly the length a flush
    // trigger needs, and `visibilitychange` fires on the very tab-switch a
    // hesitating user makes — so a flush that STARTS while the dialog is open is
    // the ordinary case, and an open-time-only check would let both deletes land
    // and the POST return 201. That is a silent save after an explicit refusal.
    let resolveFetch: ((value: Response) => void) | null = null;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    seed([capture()]);
    render(<Host />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    await act(async () => {
      expect(await latest!.discard(["k1"])).toBe("refused-in-flight");
    });
    // And the words are still there — refused, not lost.
    expect(readQueue(window.localStorage)).toHaveLength(1);

    await act(async () => {
      resolveFetch?.(jsonReply(503));
      await Promise.resolve();
    });
  });

  it("skips a claimed entry and still drains the rest of the pass", async () => {
    // Per-entry, matching the worker's rule: an implementation that aborted the
    // whole pass would satisfy "no POST for the claimed entry" while
    // reintroducing the head-of-line failure this design refuses. Counting POSTs
    // is the assertion.
    seed([
      capture({ clientKey: "a", text: "first" }),
      capture({ clientKey: "b", text: "second" }),
    ]);
    let released: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const discardStarted = vi.fn();
    fetchMock.mockImplementation(
      async (_url: string, init: { body: string }) => {
        if (JSON.parse(init.body).clientKey === "a") {
          discardStarted();
          await gate;
        }
        return jsonReply(201);
      },
    );

    render(<Host />);
    await waitFor(() => expect(discardStarted).toHaveBeenCalled());

    await act(async () => {
      // `a` is in flight, so this is the refusal arm; `b` must still flush.
      await latest!.discard(["a"]);
      released?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      const keys = fetchMock.mock.calls.map(
        (c) => JSON.parse((c[1] as { body: string }).body).clientKey as string,
      );
      expect(keys).toContain("b");
    });
  });
});

describe("useCaptureQueue — scoping and the sweep (#175)", () => {
  it("hands the strip another workspace's captures as a group, never as text", async () => {
    seed([capture({ workspaceId: "ws-someone-else", text: "their words" })]);
    render(<Host />);

    await waitFor(() => {
      expect(screen.getByTestId("mine")).toHaveTextContent("0");
      expect(screen.getByTestId("stranded")).toHaveTextContent("1");
    });
    expect(JSON.stringify(latest?.stranded)).not.toContain("their words");
  });

  it("stamps an unresolvable entry on mount so expiry has a reference instant", async () => {
    seed([capture({ workspaceId: "ws-someone-else" })]);
    render(<Host />);

    await waitFor(() =>
      expect(readQueue(window.localStorage)[0]?.unresolvableSince).toBeTypeOf(
        "number",
      ),
    );
  });

  it("re-reads on this tab's own broadcast, since storage never fires locally", async () => {
    render(<Host />);
    await waitFor(() => expect(latest).not.toBeNull());
    seed([capture()]);

    await act(async () => {
      window.dispatchEvent(new Event(CAPTURE_QUEUE_EVENT));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByTestId("mine")).not.toHaveTextContent("0"),
    );
  });
});
