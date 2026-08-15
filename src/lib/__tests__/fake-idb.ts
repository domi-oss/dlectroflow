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
  /**
   * Every `readwrite` transaction aborts, so a caller must not report success —
   * and, as in a real engine, **its staged writes are rolled back**.
   *
   * `readonly` transactions still complete. Aborting them too would make
   * `readMirrored`'s contract untestable under a write failure, which is the
   * state a `sync` handler is most likely to meet.
   */
  failWrites?: boolean;
};

export type FakeIdb = {
  /** Hand the store rows directly, including ones no validator would accept. */
  seed(store: string, rows: Row[]): void;
  /**
   * Remove a row from **outside** any transaction.
   *
   * Models another actor taking a row away mid-pass — a Discard, which deletes
   * the mirror entry first by design, or a second tab. A pass that walks one
   * snapshot cannot see it, which is the point.
   */
  drop(store: string, key: string): void;
  /** Everything currently held, for asserting on a write from the outside. */
  rows(store: string): Row[];
  /** How many transactions have been opened, so a caller can count round trips. */
  transactions: number;
  /**
   * How many **whole-store** scans have been made.
   *
   * A `getAll` costs the size of the store where a keyed `get` costs one row, and
   * on a service worker's battery-sensitive path that difference is the thing
   * worth asserting. Counting it is the only way to tell a per-pass scan from a
   * per-entry one, since both open the same number of transactions.
   */
  scans: number;
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
  const state = { transactions: 0, scans: 0 };

  type Store = { keyPath: string; rows: Map<string, Row> };

  function ensureStore(name: string, keyPath: string): Store {
    if (!stores.has(name)) stores.set(name, { keyPath, rows: new Map() });
    return stores.get(name)!;
  }

  /**
   * Where a handle's writes go until the transaction decides their fate.
   *
   * An array for a real transaction — applied on `oncomplete`, discarded on
   * `onabort` — or an immediate applier for the upgrade handle, which has no
   * commit to wait for.
   */
  type Staging = { push(apply: () => void): void };

  /**
   * ⚠️ **Writes are STAGED, not applied on the call**, so an aborted transaction
   * leaves the store exactly as it was — which is what a real engine does and what
   * production code here is entitled to assume. This double used to mutate
   * immediately while `failWrites` was decided a microtask later, so *"the
   * transaction failed"* and *"the store is unchanged"* came apart, and a test
   * asserting the rollback would have passed for the wrong reason (Duo review
   * round 4 on `!348`).
   *
   * The request still settles its own `onsuccess` on its own microtask, because
   * that IS the real behaviour and the whole reason `writeMirror` resolves on the
   * transaction rather than on the request.
   */
  function storeHandle(store: Store, staging: Staging) {
    return {
      put(value: Row) {
        const key = String(value[store.keyPath]);
        // A `keyPath` store upserts. `add` would throw on a duplicate; the
        // mirror deliberately uses `put`, because re-mirroring the same capture
        // is the ordinary case on every mount.
        staging.push(() => store.rows.set(key, value));
        const request = { result: key } as Record<string, unknown>;
        settle(() => (request.onsuccess as (() => void) | undefined)?.());
        return request;
      },
      delete(key: string) {
        staging.push(() => store.rows.delete(String(key)));
        const request = {} as Record<string, unknown>;
        settle(() => (request.onsuccess as (() => void) | undefined)?.());
        return request;
      },
      /** One row by key, which is what a keyed lookup should cost. */
      get(key: string) {
        const request = { result: store.rows.get(String(key)) } as Record<
          string,
          unknown
        >;
        settle(() => (request.onsuccess as (() => void) | undefined)?.());
        return request;
      },
      getAll() {
        // Committed rows. The mirror never reads and writes in one transaction,
        // so reading through an uncommitted overlay would be untested machinery
        // standing in for a case that does not arise.
        state.scans += 1;
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
      // The upgrade transaction is deliberately not modelled — nothing in this
      // repo writes during one — so this handle applies immediately rather than
      // staging for a commit that has no representation here.
      return storeHandle(ensureStore(name, opts?.keyPath ?? "id"), {
        push: (apply: () => void) => apply(),
      });
    },
    transaction(name: string | string[], mode?: string) {
      state.transactions += 1;
      const storeName = Array.isArray(name) ? name[0]! : name;
      const existing = stores.get(storeName);
      const store = ensureStore(storeName, existing?.keyPath ?? "clientKey");
      const pending: (() => void)[] = [];
      const handle = storeHandle(store, pending);
      // ⚠️ `failWrites` is about WRITE transactions, per its name and its own
      // comment. `mode` defaults to `"readonly"` in a real engine, and `_mode` was
      // previously accepted and ignored here, so reads aborted too.
      const aborting =
        options.failWrites === true && (mode ?? "readonly") !== "readonly";
      const tx = {
        objectStore: () => handle,
      } as Record<string, unknown>;
      settle(() => {
        if (aborting) {
          // `pending` is dropped unapplied. That is the rollback.
          (tx.onerror as (() => void) | undefined)?.();
          (tx.onabort as (() => void) | undefined)?.();
          return;
        }
        for (const apply of pending) apply();
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
    drop(store: string, key: string) {
      stores.get(store)?.rows.delete(String(key));
    },
    rows(store: string) {
      return [...(stores.get(store)?.rows.values() ?? [])];
    },
    get transactions() {
      return state.transactions;
    },
    get scans() {
      return state.scans;
    },
  };

  // The one cast, and the reason is in this module's docblock: the mirror is
  // typed against the real DOM API because that is what runs in a browser.
  return factory as unknown as IDBFactory & FakeIdb;
}
