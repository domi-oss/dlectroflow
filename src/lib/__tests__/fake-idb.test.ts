import { describe, it, expect } from "vitest";
import { fakeIdbFactory } from "./fake-idb";

/**
 * The double's own test (#175).
 *
 * `mock-csprng.test.ts` is the precedent and the reasoning is stronger here: a
 * behavioural test of `capture-mirror.ts` or `public/sw.js` written against this
 * double can pass because the **double** is wrong. These three properties are the
 * ones both of those depend on, so a divergence shows up here rather than as a
 * green suite over a broken mirror.
 */

type MinimalDb = {
  createObjectStore(name: string, opts: { keyPath: string }): unknown;
  transaction(
    name: string,
    mode?: string,
  ): {
    objectStore(name: string): {
      put(value: Record<string, unknown>): { onsuccess: (() => void) | null };
      getAll(): {
        result: Record<string, unknown>[];
        onsuccess: (() => void) | null;
      };
    };
    oncomplete: (() => void) | null;
    onerror: (() => void) | null;
  };
};

function open(
  factory: ReturnType<typeof fakeIdbFactory>,
): Promise<{ db: MinimalDb | null; upgraded: boolean }> {
  return new Promise((resolve) => {
    const request = factory.open("db", 1) as unknown as {
      result: MinimalDb;
      onupgradeneeded: (() => void) | null;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
    };
    let upgraded = false;
    request.onupgradeneeded = () => {
      upgraded = true;
      request.result.createObjectStore("captures", { keyPath: "clientKey" });
    };
    request.onsuccess = () => resolve({ db: request.result, upgraded });
    request.onerror = () => resolve({ db: null, upgraded });
  });
}

describe("fakeIdbFactory", () => {
  it("fires handlers asynchronously, as a real IDBRequest does", async () => {
    // The property most likely to make a double lie. A real request cannot
    // settle during the call that created it, so code assigning `onsuccess` on
    // the next line works — and a synchronous double would let an implementation
    // that assigns its handler late pass anyway.
    const factory = fakeIdbFactory();
    let firedSynchronously = true;
    const request = factory.open("db", 1) as unknown as {
      onsuccess: (() => void) | null;
    };
    // Assigned AFTER the call, which is the whole point.
    const settled = new Promise<void>((resolve) => {
      request.onsuccess = () => {
        firedSynchronously = false;
        resolve();
      };
    });
    await settled;
    expect(firedSynchronously).toBe(false);
  });

  it("runs onupgradeneeded before onsuccess, so the store exists by then", async () => {
    const { db, upgraded } = await open(fakeIdbFactory());
    expect(upgraded).toBe(true);
    expect(db).not.toBeNull();
  });

  it("upserts on the keyPath rather than duplicating", async () => {
    const factory = fakeIdbFactory();
    const { db } = await open(factory);
    const tx = db!.transaction("captures", "readwrite");
    tx.objectStore("captures").put({ clientKey: "a", text: "first" });
    tx.objectStore("captures").put({ clientKey: "a", text: "second" });
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });

    expect(factory.rows("captures")).toEqual([
      { clientKey: "a", text: "second" },
    ]);
  });

  it("reaches onerror rather than oncomplete when writes are set to fail", async () => {
    const factory = fakeIdbFactory({ failWrites: true });
    const { db } = await open(factory);
    const tx = db!.transaction("captures", "readwrite");
    const reached = await new Promise<string>((resolve) => {
      tx.oncomplete = () => resolve("complete");
      tx.onerror = () => resolve("error");
    });

    expect(reached).toBe("error");
  });

  it("reaches onerror on open when opening is set to fail", async () => {
    const { db } = await open(fakeIdbFactory({ failOpen: true }));
    expect(db).toBeNull();
  });

  it("hands seeded rows back through getAll, junk included", async () => {
    // The mirror's validator has to be exercisable against a value nothing in
    // this app wrote, which is why the double can be seeded directly.
    const factory = fakeIdbFactory();
    const { db } = await open(factory);
    factory.seed("captures", [{ clientKey: "junk", nonsense: true }]);
    const tx = db!.transaction("captures", "readonly");
    const request = tx.objectStore("captures").getAll();
    await new Promise<void>((resolve) => {
      request.onsuccess = () => resolve();
    });

    expect(request.result).toEqual([{ clientKey: "junk", nonsense: true }]);
  });
});
