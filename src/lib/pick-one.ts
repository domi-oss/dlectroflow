/**
 * Pick one member of a fixed list at random, using the platform CSPRNG.
 *
 * **This is a maintenance fix, not a security one.** The three callers pick a
 * congratulations line, a fallback spark and a fable line — none of them
 * protects anything, and `Math.random` was a perfectly correct choice for all
 * three on the merits.
 *
 * The reason it changed is that the `Math.random` form regenerates a MEDIUM
 * SAST finding ("Use of cryptographically weak pseudo-random number generator")
 * whose fingerprint includes the line number. One statement in `focus-timer.tsx`
 * has therefore been dismissed **five separate times** — at lines 638, 675,
 * 683, 731 and 738 — each time an unrelated change shifted it down the file,
 * and #181 was about to mint a sixth at line 795. Every one of those dismissals
 * was correct and none of them stayed true for long, which makes the dismissal
 * the wrong tool: it treats a recurring cost as a series of one-off judgements.
 *
 * Removing the flagged construct ends that permanently, and collapses three
 * copies of the same three-line idiom into one tested place. `crypto` is a
 * global from Node 19 on and the project requires Node >= 20.19, so there is no
 * import and no polyfill.
 *
 * Deliberately NOT applied to `shuffleIndices`/`buildPlayOrder`
 * (`src/lib/focus-sounds.ts`), which take an injectable `rng` defaulting to
 * `Math.random` so tests can pin a deterministic order. That is a better
 * pattern than this one, it has never been flagged, and swapping it would trade
 * away test determinism for nothing.
 */

/**
 * Scale a full-range unsigned 32-bit integer into `[0, length)`.
 *
 * Dividing by `2 ** 32` — not `0xffffffff` — is what keeps the result below
 * `length`. `0xffffffff / 0xffffffff` is exactly 1, so that divisor would let
 * the largest draw index one past the end and return `undefined`; there is a
 * test that forces precisely that value.
 *
 * The modulo bias from not rejecting the tail is real and irrelevant here: the
 * lists are a handful of UI strings, and nothing depends on the distribution
 * being exactly uniform.
 */
function indexBelow(length: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return Math.floor((buf[0] / 2 ** 32) * length);
}

/**
 * One member of `list`, chosen at random.
 *
 * Throws on an empty list rather than returning `undefined`. Every caller
 * passes a compile-time constant, so an empty one is a bug at the call site,
 * and the alternative is a blank line appearing in the UI with nothing to
 * explain it.
 */
export function pickOne<T>(list: readonly T[]): T {
  if (list.length === 0) {
    throw new Error("pickOne: cannot pick from an empty list");
  }
  return list[indexBelow(list.length)];
}
