import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CAPTURE_MIRROR_DB_NAME,
  CAPTURE_MIRROR_DB_VERSION,
  CAPTURE_MIRROR_STORE,
  CAPTURE_SYNC_TAG,
} from "@/lib/capture-mirror";
import { fakeIdbFactory, type FakeIdb } from "@/lib/__tests__/fake-idb";

/**
 * #175 — `public/sw.js`'s Background Sync handler.
 *
 * ⚠️ **This is the only path that works while no tab is open**, which is what
 * makes it worth testing in a worker-shaped context rather than trusting the
 * platform. It is also the one caller whose breakage would be **catastrophic and
 * invisible**: the foreground flush would keep working, so nothing on screen
 * would change while the promise this feature makes — *"they save themselves
 * whether or not you reopen the app"* — quietly stopped being true.
 *
 * ── How the file is exercised ────────────────────────────────────────────────
 *
 * `public/sw.js` is served as a static asset and is not bundled, so it cannot be
 * imported by path from a `.ts` file without dragging it into `tsconfig`'s
 * programme. It is loaded here through a **dynamic import of a `file://` URL**,
 * with a cache-busting query so each case gets a fresh module evaluation against
 * its own fake `self`. No `eval` and no `node:vm`: the file is a valid ES module
 * (it has no imports or exports), and `self` inside it resolves to
 * `globalThis.self`, which each case installs.
 *
 * The alternative — asserting on the file's TEXT — is the shape of false coverage
 * this repo's hygiene tests exist to catch. A regex proving the words
 * `account-revoked` appear in the worker says nothing about which `waitUntil`
 * exit it takes.
 */

/**
 * ⚠️ `process.cwd()` rather than a walk up from `__dirname`, and it is a SAST fix
 * rather than a style choice — see the same note in `capture-orphan-window.test.ts`.
 * Both resolve identically under `npm test` (Vitest pins `root` to the repo root,
 * #133); only the `__dirname` form trips `detect-non-literal-fs-filename`
 * (CWE-22), and a dismissal there regenerates every time the line moves.
 */
const SW_PATH = path.join(process.cwd(), "public", "sw.js");
const SW_SOURCE = readFileSync(SW_PATH, "utf8");

type FakeEvent = {
  tag: string;
  waited: Promise<unknown>[];
  waitUntil(promise: Promise<unknown>): void;
};

type Listeners = Map<string, ((event: unknown) => void)[]>;

type Harness = {
  listeners: Listeners;
  idb: ReturnType<typeof fakeIdbFactory> & FakeIdb;
  fetchMock: ReturnType<typeof vi.fn>;
  /** Fire the `sync` handler and return the promise it handed `waitUntil`. */
  fireSync(tag?: string): Promise<unknown>;
};

let loadCount = 0;
const savedGlobals: Record<string, unknown> = {};

async function loadWorker(
  fetchImpl: (...args: unknown[]) => unknown,
): Promise<Harness> {
  const listeners: Listeners = new Map();
  const idb = fakeIdbFactory();
  const fetchMock = vi.fn(fetchImpl as never);

  const self = {
    addEventListener(type: string, handler: (event: unknown) => void) {
      const existing = listeners.get(type) ?? [];
      existing.push(handler);
      listeners.set(type, existing);
    },
    skipWaiting() {},
    clients: {
      claim() {},
      matchAll: () => Promise.resolve([]),
      openWindow: () => Promise.resolve(null),
    },
    registration: { sync: { register: vi.fn() } },
    indexedDB: idb,
    fetch: fetchMock,
  };

  for (const [key, value] of Object.entries({
    self,
    indexedDB: idb,
    fetch: fetchMock,
  })) {
    savedGlobals[key] = (globalThis as Record<string, unknown>)[key];
    (globalThis as Record<string, unknown>)[key] = value;
  }

  loadCount += 1;
  // A distinct query per load, so Node's module cache does not hand back an
  // already-evaluated copy whose listeners closed over a previous fake `self`.
  await import(`${new URL(`file://${SW_PATH}`).href}?load=${loadCount}`);

  return {
    listeners,
    idb,
    fetchMock,
    fireSync(tag = CAPTURE_SYNC_TAG) {
      const event: FakeEvent = {
        tag,
        waited: [],
        waitUntil(promise) {
          this.waited.push(promise);
        },
      };
      for (const handler of listeners.get("sync") ?? []) handler(event);
      // A handler that registered nothing has nothing to wait on, which is a
      // resolve as far as the platform is concerned.
      return event.waited.length > 0
        ? Promise.all(event.waited)
        : Promise.resolve("not-handled");
    },
  };
}

/** A `Response`-shaped answer, since the node env has no worker `fetch`. */
function reply(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

function seedMirror(harness: Harness, rows: Record<string, unknown>[]): void {
  harness.idb.seed(CAPTURE_MIRROR_STORE, rows);
}

function entry(over: Record<string, unknown> = {}) {
  return {
    clientKey: "k1",
    text: "ring mum about the boiler",
    workspaceId: "ws-live",
    capturedAt: 1_000,
    ...over,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedGlobals)) {
    if (value === undefined) {
      delete (globalThis as Record<string, unknown>)[key];
    } else {
      (globalThis as Record<string, unknown>)[key] = value;
    }
  }
});

describe("sw.js — the sync handler drains the mirror (#175)", () => {
  it("registers a sync listener at all", async () => {
    const harness = await loadWorker(() => reply(201));
    expect(harness.listeners.has("sync")).toBe(true);
  });

  it("ignores a sync event for another tag", async () => {
    const harness = await loadWorker(() => reply(201));
    seedMirror(harness, [entry()]);

    await harness.fireSync("something-else");

    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs each mirrored capture to /api/braindump and removes what saved", async () => {
    const harness = await loadWorker(() => reply(201));
    seedMirror(harness, [entry({ clientKey: "a" }), entry({ clientKey: "b" })]);

    await harness.fireSync();

    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = harness.fetchMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("/api/braindump");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    // Only the three fields the route's contract names — the mirror holds a
    // `capturedAt` the route neither reads nor accepts.
    expect(Object.keys(JSON.parse(init.body)).sort()).toEqual([
      "clientKey",
      "text",
      "workspaceId",
    ]);
    expect(harness.idb.rows(CAPTURE_MIRROR_STORE)).toEqual([]);
  });

  it("removes a duplicate (200) exactly as it removes a save", async () => {
    // The whole payoff of the clientKey column: a worker flush the foreground
    // could not be told about comes back as `already saved`.
    const harness = await loadWorker(() => reply(200));
    seedMirror(harness, [entry()]);

    await harness.fireSync();

    expect(harness.idb.rows(CAPTURE_MIRROR_STORE)).toEqual([]);
  });

  it("resolves when the mirror is empty — nothing to come back for", async () => {
    const harness = await loadWorker(() => reply(201));

    await expect(harness.fireSync()).resolves.toBeDefined();
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when a retryable failure leaves work behind", async () => {
    // Rejection is the ONLY way to get another attempt while no tab is open.
    const harness = await loadWorker(() => reply(503));
    seedMirror(harness, [entry()]);

    await expect(harness.fireSync()).rejects.toBeTruthy();
    expect(harness.idb.rows(CAPTURE_MIRROR_STORE)).toHaveLength(1);
  });

  it("treats a 409 as retryable, and rejects on it", async () => {
    // Nothing the worker can read distinguishes a first 409 from a hundredth, so
    // it retries — which is the wanted behaviour, because a later sign-in will
    // save the capture. The only cost is background attempts nobody sees.
    const harness = await loadWorker(() =>
      reply(409, { status: "session-expired" }),
    );
    seedMirror(harness, [entry()]);

    await expect(harness.fireSync()).rejects.toBeTruthy();
  });

  it("treats a network throw as retryable", async () => {
    const harness = await loadWorker(() => {
      throw new TypeError("Failed to fetch");
    });
    seedMirror(harness, [entry()]);

    await expect(harness.fireSync()).rejects.toBeTruthy();
    expect(harness.idb.rows(CAPTURE_MIRROR_STORE)).toHaveLength(1);
  });

  it("RESOLVES when everything left is account-revoked", async () => {
    // ⚠️ Rejecting here is the bug. Those entries can never flush, so the
    // platform would retry on its own schedule for ever, burn battery, and give
    // up anyway — while the user-facing remedy is Discard, which only a
    // foreground tab can offer.
    const harness = await loadWorker(() => reply(201));
    seedMirror(harness, [entry({ blockedBy: "account-revoked" })]);

    await expect(harness.fireSync()).resolves.toBeDefined();
    // Skipped, not flushed: a terminal entry must not be POSTed on every pass.
    expect(harness.fetchMock).not.toHaveBeenCalled();
    expect(harness.idb.rows(CAPTURE_MIRROR_STORE)).toHaveLength(1);
  });

  it("rejects on a mixed pass, and still drains the retryable ones", async () => {
    const harness = await loadWorker((...args: unknown[]) => {
      const init = args[1] as { body: string };
      return JSON.parse(init.body).clientKey === "ok" ? reply(201) : reply(503);
    });
    seedMirror(harness, [
      entry({ clientKey: "blocked", blockedBy: "account-revoked" }),
      entry({ clientKey: "ok" }),
      entry({ clientKey: "later" }),
    ]);

    await expect(harness.fireSync()).rejects.toBeTruthy();
    expect(
      harness.idb
        .rows(CAPTURE_MIRROR_STORE)
        .map((r) => r.clientKey)
        .sort(),
    ).toEqual(["blocked", "later"]);
  });

  it("keeps failures per-entry, so one 5xx does not stop the pass", async () => {
    // Otherwise a single stuck entry blocks the queue behind it, which is the
    // head-of-line failure this design's whole premise refuses.
    const harness = await loadWorker((...args: unknown[]) => {
      const init = args[1] as { body: string };
      return JSON.parse(init.body).clientKey === "stuck"
        ? reply(503)
        : reply(201);
    });
    seedMirror(harness, [
      entry({ clientKey: "stuck" }),
      entry({ clientKey: "a" }),
      entry({ clientKey: "b" }),
    ]);

    await expect(harness.fireSync()).rejects.toBeTruthy();
    expect(harness.fetchMock).toHaveBeenCalledTimes(3);
    expect(
      harness.idb.rows(CAPTURE_MIRROR_STORE).map((r) => r.clientKey),
    ).toEqual(["stuck"]);
  });

  it("writes an account-revoked mark it learns with no tab open", async () => {
    // The worker's own first-failure case. Left unrecorded, it would retry a
    // permanently-refused capture on every sync for ever and the user's strip
    // would show it as merely "waiting" with no explanation.
    const harness = await loadWorker(() =>
      reply(403, { status: "account-revoked" }),
    );
    seedMirror(harness, [entry()]);

    await expect(harness.fireSync()).resolves.toBeDefined();

    const rows = harness.idb.rows(CAPTURE_MIRROR_STORE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.blockedBy).toBe("account-revoked");
  });

  it("takes the terminal mark from the BODY, never from the status line", async () => {
    // A 403 the app did not send — an auth proxy in front of a self-host, an
    // ingress rule, a corporate filter — must not permanently mark a perfectly
    // good capture "this account can no longer save", whose only exit is
    // deliberately destroying the words.
    const harness = await loadWorker(() =>
      reply(403, { error: "blocked by proxy" }),
    );
    seedMirror(harness, [entry()]);

    await expect(harness.fireSync()).rejects.toBeTruthy();
    expect(
      harness.idb.rows(CAPTURE_MIRROR_STORE)[0]?.blockedBy,
    ).toBeUndefined();
  });

  it("never writes session-expired, even on a 409 that says so", async () => {
    // The worker has no session to resolve, so it cannot compute `blockedUnder`
    // — and a mark without it leaves the strip reasoning with half its inputs
    // missing. The next foreground flush records it properly.
    const harness = await loadWorker(() =>
      reply(409, { status: "session-expired" }),
    );
    seedMirror(harness, [entry()]);

    await expect(harness.fireSync()).rejects.toBeTruthy();
    expect(
      harness.idb.rows(CAPTURE_MIRROR_STORE)[0]?.blockedBy,
    ).toBeUndefined();
  });

  it("skips a mirrored row that is not a capture rather than POSTing it", async () => {
    const harness = await loadWorker(() => reply(201));
    seedMirror(harness, [{ clientKey: "junk" }, entry({ clientKey: "real" })]);

    await harness.fireSync();

    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still hosts notifications — the worker's original job", async () => {
    // `registerServiceWorker` has four callers and none of them is this feature.
    const harness = await loadWorker(() => reply(201));
    expect(harness.listeners.has("notificationclick")).toBe(true);
    expect(harness.listeners.has("install")).toBe(true);
    expect(harness.listeners.has("activate")).toBe(true);
  });
});

describe("sw.js — the constants it cannot import (#175)", () => {
  it("names the same database, version, store and tag as capture-mirror.ts", () => {
    // The mechanical guard for the one drift with no symptom: rename the store in
    // `capture-mirror.ts` and the worker reads an empty database for ever while
    // the foreground flush keeps working, so nothing on screen changes.
    expect(SW_SOURCE).toContain(`"${CAPTURE_MIRROR_DB_NAME}"`);
    expect(SW_SOURCE).toContain(`"${CAPTURE_MIRROR_STORE}"`);
    expect(SW_SOURCE).toContain(`"${CAPTURE_SYNC_TAG}"`);
    expect(SW_SOURCE).toContain(`${CAPTURE_MIRROR_DB_VERSION}`);
  });

  it("posts to the route the queue flushes through", () => {
    expect(SW_SOURCE).toContain('"/api/braindump"');
  });
});
