/**
 * A minimal in-memory IndexedDB, for the offline capture queue's mirror (#175).
 *
 * ── Why a hand-written double and not a package ──────────────────────────────
 *
 * `fake-indexeddb` would do this, and adding it is not free here: local `npm` is
 * allow-scripts-wrapped, so a lockfile change has to be regenerated inside the CI
 * image, and this repo's dependency surface is deliberately small. The API the
 * mirror actually uses is six calls wide — `open`, `createObjectStore`,
 * `transaction`, `getAll`, `put`, `delete` — so a double is cheaper than a
 * dependency and, unlike one, can be made to fail on demand.
 *
 * ── Why the double has its own test ──────────────────────────────────────────
 *
 * `mock-csprng.ts` is the precedent, and the reasoning is stronger here: a
 * behavioural test against a double can pass because the DOUBLE is wrong.
 * `fake-idb.test.ts` pins the three properties `capture-mirror.ts` and
 * `public/sw.js` actually depend on — that a `keyPath` store upserts rather than
 * duplicating, that handlers fire asynchronously rather than during the call, and
 * that a failing transaction reaches `onerror` rather than `oncomplete`.
 *
 * ⚠️ **It is cast to `IDBFactory` at the call site rather than declaring itself
 * one**, and that trade is stated because it is the double's one real weakness:
 * the mirror is typed against the real DOM API, which is what runs in a browser,
 * so a divergence between this double and a real engine is not something `tsc`
 * can catch. Kept honest by keeping the surface tiny and by the double's own
 * test.
 *
 * Lives in `__tests__/` for the reason `mock-csprng.ts` gives: it is not app
 * code, nothing under `src/app` or `src/components` may import it, and Vitest
 * only collects `*.test.ts`, so it sits here without being run as a suite.
 */

type Row = Record<string, unknown>;

type FakeOptions = {
  /** `open` reaches `onerror` — Firefox private browsing, a corrupt profile. */
  failOpen?: boolean;
  /** Every write transaction aborts, so a caller must not report success. */
  failWrites?: boolean;
};

export type FakeIdb = {
  /** Hand the store rows directly, including ones no validator would accept. */
  seed(store: string, rows: Row[]): void;
  /** Everything currently held, for asserting on a write from the outside. */
  rows(store: string): Row[];
  /** How many transactions have been opened, so a caller can count round trips. */
  transactions: number;
};

/**
 * Settle a request the way a real engine does: **after** the caller has had a
 * chance to attach its handler.
 *
 * This is the property most likely to make a double lie. A real `IDBRequest`
 * cannot fire during the call that created it, so code that assigns `onsuccess`
 * on the next line works; a double that called back synchronously would let a
 * broken implementation pass, and would hide one that assigns its handler late.
 */
function settle(run: () => void): void {
  queueMicrotask(run);
}

export function fakeIdbFactory(
  options: FakeOptions = {},
): IDBFactory & FakeIdb {
  const stores = new Map<string, { keyPath: string; rows: Map<string, Row> }>();
  const state = { transactions: 0 };

  function makeStore(name: string, keyPath: string) {
    if (!stores.has(name)) stores.set(name, { keyPath, rows: new Map() });
    const store = stores.get(name)!;
    return {
      put(value: Row) {
        const key = String(value[store.keyPath]);
        // A `keyPath` store upserts. `add` would throw on a duplicate; the
        // mirror deliberately uses `put`, because re-mirroring the same capture
        // is the ordinary case on every mount.
        store.rows.set(key, value);
        const request = { result: key } as Record<string, unknown>;
        settle(() => (request.onsuccess as (() => void) | undefined)?.());
        return request;
      },
      delete(key: string) {
        store.rows.delete(String(key));
        const request = {} as Record<string, unknown>;
        settle(() => (request.onsuccess as (() => void) | undefined)?.());
        return request;
      },
      getAll() {
        const request = { result: [...store.rows.values()] } as Record<
          string,
          unknown
        >;
        settle(() => (request.onsuccess as (() => void) | undefined)?.());
        return request;
      },
    };
  }

  const db = {
    objectStoreNames: {
      contains: (name: string) => stores.has(name),
    },
    createObjectStore(name: string, opts?: { keyPath?: string }) {
      return makeStore(name, opts?.keyPath ?? "id");
    },
    transaction(name: string | string[], _mode?: string) {
      state.transactions += 1;
      const storeName = Array.isArray(name) ? name[0]! : name;
      const existing = stores.get(storeName);
      const handle = makeStore(storeName, existing?.keyPath ?? "clientKey");
      const tx = {
        objectStore: () => handle,
      } as Record<string, unknown>;
      settle(() => {
        if (options.failWrites) {
          (tx.onerror as (() => void) | undefined)?.();
          (tx.onabort as (() => void) | undefined)?.();
          return;
        }
        (tx.oncomplete as (() => void) | undefined)?.();
      });
      return tx;
    },
    close() {},
  };

  const factory = {
    open(_name: string, _version?: number) {
      const request = { result: db } as Record<string, unknown>;
      settle(() => {
        if (options.failOpen) {
          (request.onerror as (() => void) | undefined)?.();
          return;
        }
        (request.onupgradeneeded as (() => void) | undefined)?.();
        (request.onsuccess as (() => void) | undefined)?.();
      });
      return request;
    },
    seed(store: string, rows: Row[]) {
      const target = stores.get(store) ?? {
        keyPath: "clientKey",
        rows: new Map(),
      };
      stores.set(store, target);
      for (const row of rows) {
        target.rows.set(String(row[target.keyPath]), row);
      }
    },
    rows(store: string) {
      return [...(stores.get(store)?.rows.values() ?? [])];
    },
    get transactions() {
      return state.transactions;
    },
  };

  // The one cast, and the reason is in this module's docblock: the mirror is
  // typed against the real DOM API because that is what runs in a browser.
  return factory as unknown as IDBFactory & FakeIdb;
}
