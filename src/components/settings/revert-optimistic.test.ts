import { describe, it, expect } from "vitest";
import { createOptimisticOwnership } from "@/components/settings/revert-optimistic";

type Prefs = { a: boolean; b: boolean; time: string };

const prefs = (over: Partial<Prefs> = {}): Prefs => ({
  a: false,
  b: false,
  time: "17:00",
  ...over,
});

describe("createOptimisticOwnership", () => {
  it("puts back the field this attempt changed", () => {
    const ownership = createOptimisticOwnership<Prefs>();
    const previous = prefs();
    const attempted = prefs({ a: true });

    const attempt = ownership.claim(attempted, previous);

    expect(attempt.revert(attempted)).toEqual(previous);
  });

  it("leaves fields this attempt did not touch exactly as they now are", () => {
    const ownership = createOptimisticOwnership<Prefs>();
    const previous = prefs();
    const attempted = prefs({ a: true });
    const attempt = ownership.claim(attempted, previous);
    // `b` was flipped by a LATER, successful attempt. Restoring the whole
    // `previous` object wholesale would silently undo it.
    const current = prefs({ a: true, b: true });

    expect(attempt.revert(current)).toEqual(prefs({ a: false, b: true }));
  });

  /**
   * The guard, and the reason a plain `setPrefs(previous)` is wrong: a slow
   * FAILING write must not clobber a newer SUCCESSFUL one.
   *
   * Attempt 1 turns `a` on and hangs. Attempt 2 turns `a` back off and lands.
   * When attempt 1 finally rejects it is no longer the newest attempt for the
   * field, so its rollback has nothing it owns to undo — and undoing anything
   * here would leave the UI showing the opposite of the database.
   */
  it("declines to undo a value a newer attempt has already replaced", () => {
    const ownership = createOptimisticOwnership<Prefs>();
    const one = ownership.claim(prefs({ a: true }), prefs());
    const two = ownership.claim(prefs(), prefs({ a: true }));
    two.confirm();

    expect(one.revert(prefs())).toEqual(prefs());
  });

  /**
   * #227 review — the hole value equality left open, and the reason ownership
   * is a token rather than a comparison.
   *
   * A value-equality guard asks "is the field still showing what I wrote?",
   * which a *newer* attempt can answer `true` by coincidence:
   *
   *   1. `previous.a` is `false`. Attempt 1 optimistically writes `true`, hangs.
   *   2. Attempt 2 writes `false` and lands.
   *   3. Attempt 3 writes `true` and lands — the same value attempt 1 wrote.
   *   4. Attempt 1 finally rejects.
   *
   * At step 4 the field reads `true` and attempt 1 wrote `true`, so value
   * equality concludes attempt 1 still owns it and restores `false` — over a
   * value the server has actually accepted. These sections seed their
   * `useState` from props exactly once, so nothing re-syncs afterwards and the
   * control disagrees with the database until the page is reloaded.
   */
  it("declines to undo when a newer attempt coincidentally re-wrote the same value", () => {
    const ownership = createOptimisticOwnership<Prefs>();

    const one = ownership.claim(prefs({ a: true }), prefs()); // hangs
    const two = ownership.claim(prefs({ a: false }), prefs({ a: true }));
    two.confirm(); // lands: server holds false
    const three = ownership.claim(prefs({ a: true }), prefs({ a: false }));
    three.confirm(); // lands: server holds true

    const current = prefs({ a: true });
    expect(one.revert(current)).toEqual(prefs({ a: true }));
    // Referentially untouched too, so React bails out of the re-render.
    expect(one.revert(current)).toBe(current);
  });

  /**
   * The mirror of the case above: when the failures chain, each one must still
   * undo, and it must undo back to what the server last confirmed rather than
   * to whatever a *previous, unconfirmed* attempt happened to leave on screen.
   *
   * Attempt 1 writes `true` and hangs; attempt 2 writes `false` on top of it
   * and fails. Attempt 2's `previous` is attempt 1's optimistic `true`, which
   * the server never accepted — restoring it would show a value that was only
   * ever a guess.
   */
  it("undoes to the last value the server confirmed, not to an unconfirmed guess", () => {
    const ownership = createOptimisticOwnership<Prefs>();

    const one = ownership.claim(prefs({ a: true }), prefs()); // hangs
    const two = ownership.claim(prefs({ a: false }), prefs({ a: true }));

    expect(two.revert(prefs({ a: false }))).toEqual(prefs({ a: false }));
    // …and attempt 1's own late rejection agrees rather than fighting it.
    expect(one.revert(prefs({ a: false }))).toEqual(prefs({ a: false }));
  });

  it("still undoes when the failures arrive out of order", () => {
    const ownership = createOptimisticOwnership<Prefs>();

    const one = ownership.claim(prefs({ a: true }), prefs());
    const two = ownership.claim(prefs({ a: false }), prefs({ a: true }));

    // Attempt 1 rejects FIRST; it is no longer the owner, so it stands down.
    expect(one.revert(prefs({ a: false }))).toEqual(prefs({ a: false }));
    // Attempt 2 owns the field and restores the server's `false`.
    expect(two.revert(prefs({ a: false }))).toEqual(prefs({ a: false }));
  });

  /**
   * A confirmation is ownership-gated for the same reason a rollback is. An
   * attempt that hung and *eventually succeeded* cannot be trusted to say what
   * the server holds once a newer attempt has written the field — the two
   * writes' arrival order at the server is not the order their promises
   * settled in on the client.
   */
  it("ignores a stale attempt's late success when a newer attempt owns the field", () => {
    const ownership = createOptimisticOwnership<Prefs>();

    const one = ownership.claim(prefs({ a: true }), prefs()); // hangs
    const two = ownership.claim(prefs({ a: false }), prefs({ a: true }));
    two.confirm(); // server holds false
    one.confirm(); // late, and not the owner: must not move the baseline

    const three = ownership.claim(prefs({ a: true }), prefs({ a: false }));
    expect(three.revert(prefs({ a: true }))).toEqual(prefs({ a: false }));
  });

  it("returns the very same object when there is nothing to undo", () => {
    // Referential identity, not just equality: React bails out of the re-render
    // when the state object is unchanged, so a rollback that always allocates
    // would repaint every section on every failure it does not own.
    const ownership = createOptimisticOwnership<Prefs>();
    const one = ownership.claim(prefs({ a: true }), prefs());
    ownership.claim(prefs({ a: false }), prefs({ a: true })).confirm();

    const current = prefs({ a: false, b: true });
    expect(one.revert(current)).toBe(current);
  });

  it("does not mutate any of the three objects it is given", () => {
    const ownership = createOptimisticOwnership<Prefs>();
    const previous = prefs();
    const attempted = prefs({ a: true });
    const current = prefs({ a: true });

    ownership.claim(attempted, previous).revert(current);

    expect(previous).toEqual(prefs());
    expect(attempted).toEqual(prefs({ a: true }));
    expect(current).toEqual(prefs({ a: true }));
  });

  it("handles a no-op attempt, where nothing was optimistically written", () => {
    const ownership = createOptimisticOwnership<Prefs>();
    const current = prefs({ b: true });

    expect(ownership.claim(prefs(), prefs()).revert(current)).toBe(current);
  });

  it("restores several fields when one attempt changed several", () => {
    const ownership = createOptimisticOwnership<Prefs>();
    const previous = prefs();
    const attempted = prefs({ a: true, time: "09:00" });

    expect(ownership.claim(attempted, previous).revert(attempted)).toEqual(
      previous,
    );
  });

  it("works on strings, not just booleans", () => {
    const ownership = createOptimisticOwnership<Prefs>();
    const previous = prefs({ time: "17:00" });
    const attempted = prefs({ time: "08:30" });

    expect(ownership.claim(attempted, previous).revert(attempted).time).toBe(
      "17:00",
    );
  });

  // `null` is a real stored value here — FocusTimerSection's `timerStyle` is
  // nullable, and "never chosen" is meaningfully different from any style. A
  // rollback that lost it would silently promote the voice-resolved default into
  // an explicit choice.
  it("restores a null the user had before, rather than dropping the field", () => {
    type Nullable = { timerStyle: string | null };
    const ownership = createOptimisticOwnership<Nullable>();
    const previous: Nullable = { timerStyle: null };
    const attempted: Nullable = { timerStyle: "mug" };

    const reverted = ownership.claim(attempted, previous).revert(attempted);
    expect(reverted).toEqual({ timerStyle: null });
    expect("timerStyle" in reverted).toBe(true);
  });

  // One ledger per mounted section. Two sections sharing tokens would let one
  // section's newer attempt silently disown the other section's pending one.
  it("keeps two ledgers independent", () => {
    const previous = prefs();
    const attempted = prefs({ a: true });

    const first = createOptimisticOwnership<Prefs>().claim(attempted, previous);
    // A second ledger's attempt must not take ownership of the first's field.
    createOptimisticOwnership<Prefs>().claim(attempted, previous);

    expect(first.revert(attempted)).toEqual(previous);
  });
});
