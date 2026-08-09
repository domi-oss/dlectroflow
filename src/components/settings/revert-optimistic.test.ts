import { describe, it, expect } from "vitest";
import { revertOptimistic } from "@/components/settings/revert-optimistic";

type Prefs = { a: boolean; b: boolean; time: string };

const prefs = (over: Partial<Prefs> = {}): Prefs => ({
  a: false,
  b: false,
  time: "17:00",
  ...over,
});

describe("revertOptimistic", () => {
  it("puts back the field this attempt changed", () => {
    const previous = prefs();
    const attempted = prefs({ a: true });

    expect(revertOptimistic(attempted, attempted, previous)).toEqual(previous);
  });

  it("leaves fields this attempt did not touch exactly as they now are", () => {
    const previous = prefs();
    const attempted = prefs({ a: true });
    // `b` was flipped by a LATER, successful attempt. Restoring the whole
    // `previous` object wholesale would silently undo it.
    const current = prefs({ a: true, b: true });

    expect(revertOptimistic(current, attempted, previous)).toEqual(
      prefs({ a: false, b: true }),
    );
  });

  /**
   * The guard, and the reason a plain `setPrefs(previous)` is wrong: a slow
   * FAILING write must not clobber a newer SUCCESSFUL one.
   *
   * Attempt 1 turns `a` on and hangs. Attempt 2 turns `a` back off and lands.
   * When attempt 1 finally rejects, the field no longer holds the value that
   * attempt set, so its rollback has nothing it owns to undo — and undoing
   * anything here would leave the UI showing the opposite of the database.
   */
  it("declines to undo a value a newer attempt has already replaced", () => {
    const previous = prefs();
    const attempted = prefs({ a: true });
    const current = prefs({ a: false });

    expect(revertOptimistic(current, attempted, previous)).toEqual(current);
  });

  it("returns the very same object when there is nothing to undo", () => {
    // Referential identity, not just equality: React bails out of the re-render
    // when the state object is unchanged, so a rollback that always allocates
    // would repaint every section on every failure it does not own.
    const previous = prefs();
    const attempted = prefs({ a: true });
    const current = prefs({ a: false, b: true });

    expect(revertOptimistic(current, attempted, previous)).toBe(current);
  });

  it("does not mutate any of the three objects it is given", () => {
    const previous = prefs();
    const attempted = prefs({ a: true });
    const current = prefs({ a: true });

    revertOptimistic(current, attempted, previous);

    expect(previous).toEqual(prefs());
    expect(attempted).toEqual(prefs({ a: true }));
    expect(current).toEqual(prefs({ a: true }));
  });

  it("handles a no-op attempt, where nothing was optimistically written", () => {
    const previous = prefs();
    const current = prefs({ b: true });

    expect(revertOptimistic(current, prefs(), previous)).toBe(current);
  });

  it("restores several fields when one attempt changed several", () => {
    const previous = prefs();
    const attempted = prefs({ a: true, time: "09:00" });

    expect(revertOptimistic(attempted, attempted, previous)).toEqual(previous);
  });

  it("works on strings, not just booleans", () => {
    const previous = prefs({ time: "17:00" });
    const attempted = prefs({ time: "08:30" });

    expect(revertOptimistic(attempted, attempted, previous).time).toBe("17:00");
  });

  // `null` is a real stored value here — FocusTimerSection's `timerStyle` is
  // nullable, and "never chosen" is meaningfully different from any style. A
  // rollback that lost it would silently promote the voice-resolved default into
  // an explicit choice.
  it("restores a null the user had before, rather than dropping the field", () => {
    type Nullable = { timerStyle: string | null };
    const previous: Nullable = { timerStyle: null };
    const attempted: Nullable = { timerStyle: "mug" };

    const reverted = revertOptimistic(attempted, attempted, previous);
    expect(reverted).toEqual({ timerStyle: null });
    expect("timerStyle" in reverted).toBe(true);
  });
});
