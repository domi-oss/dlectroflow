import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #89 — the paused focus ring's breathing pacer is a CSS animation, so the part
// that makes it a *guide* rather than decoration — its cadence — lives in
// globals.css, where the component tests cannot see it (jsdom loads no
// stylesheet). These assertions run against the real stylesheet.
const CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/**
 * A top-level block's body, given its selector/at-rule LITERALLY, or null when
 * the block is missing entirely — so a removed or renamed rule fails as "not
 * found" instead of as a confusing assertion about an empty string.
 *
 * A plain string scan rather than a `RegExp` built from the argument (semgrep
 * `non-literal-regexp`, cleared across the suite on !179). The callers now pass
 * the real header — `[data-breathing]`, not `\\[data-breathing\\]` — so there is
 * no regex escaping to get wrong at the call site either.
 *
 * Two properties of the regex it replaces are preserved deliberately:
 *
 *  1. The gap between the header and `{` must be WHITESPACE ONLY. That is what
 *     skips the prose mention of `[data-breathing]` in the comment above the
 *     rule — a bare `indexOf` finds that first and would make every assertion
 *     here vacuously null — and it also means a rule that grows a second
 *     selector (`[data-breathing], .x {`) fails loudly rather than silently
 *     matching a combined rule.
 *  2. The body ends at the first `\n}`, i.e. a closing brace in the first
 *     column, so a nested block (a keyframe stop) cannot terminate it early.
 */
function block(header: string): string | null {
  for (
    let at = CSS.indexOf(header);
    at !== -1;
    at = CSS.indexOf(header, at + 1)
  ) {
    const open = CSS.indexOf("{", at + header.length);
    if (open === -1) return null;
    // Not this occurrence (a comment, or a multi-selector rule) — keep looking.
    if (CSS.slice(at + header.length, open).trim() !== "") continue;
    const close = CSS.indexOf("\n}", open);
    return close === -1 ? null : CSS.slice(open + 1, close);
  }
  return null;
}

describe("focus-breathe pacer CSS (#89)", () => {
  const rule = block("[data-breathing]");
  const keyframes = block("@keyframes focus-breathe");

  it("binds the animation to the [data-breathing] marker the ring sets", () => {
    expect(
      rule,
      "[data-breathing] rule missing from globals.css",
    ).not.toBeNull();
    expect(rule).toMatch(/animation:\s*focus-breathe\s/);
    // Endless while the session is paused, and eased at both turning points —
    // a breath has no linear edges.
    expect(rule).toMatch(/\binfinite\b/);
    expect(rule).toMatch(/\bease-in-out\b/);
  });

  it("paces a real breath: ~4s in, ~6s out", () => {
    expect(rule).not.toBeNull();
    expect(keyframes, "@keyframes focus-breathe missing").not.toBeNull();
    const seconds = Number(
      /animation:\s*focus-breathe\s+([\d.]+)s/.exec(rule!)?.[1],
    );
    // The single intermediate stop is the top of the inhale; everything after it
    // is the exhale. Derived from the real numbers, so shortening the cycle
    // without moving the stop (or vice versa) fails here.
    const peakPct = Number(/^\s*([\d.]+)%\s*\{/m.exec(keyframes!)?.[1]);
    expect(seconds).toBeGreaterThan(0);
    expect(peakPct).toBeGreaterThan(0);
    expect((seconds * peakPct) / 100).toBeCloseTo(4, 1);
    expect(seconds * (1 - peakPct / 100)).toBeCloseTo(6, 1);
  });

  it("animates only compositor-safe properties — the pacer cannot reflow anything", () => {
    expect(keyframes).not.toBeNull();
    const animated = new Set(
      [...keyframes!.matchAll(/^\s*([a-z-]+)\s*:/gm)].map((m) => m[1]),
    );
    // Anything else (width/height/r/stroke-width/margin/inset…) would move the
    // controls or the readout under the breath, which the spec forbids.
    expect([...animated].sort()).toEqual(["opacity", "scale"]);
  });

  it("breathes INTO its resting size (peak scale 1) so it never spills past the ring's frame", () => {
    expect(keyframes).not.toBeNull();
    const peak = /^\s*[\d.]+%\s*\{([\s\S]*?)\}/m.exec(keyframes!)?.[1] ?? "";
    expect(peak).toMatch(/scale:\s*1\b/);
    expect(peak).toMatch(/opacity:\s*1\b/);
  });

  it("loops seamlessly: the first and last stops are identical", () => {
    expect(keyframes).not.toBeNull();
    // Literal patterns in a lookup, not one assembled from `name` (semgrep
    // `non-literal-regexp`). `name` only ever holds one of these two values, so
    // the patterns are byte-identical to the ones that were being built — every
    // whitespace tolerance is unchanged, which matters here: the stop bodies are
    // indented CSS that Prettier is free to re-wrap. The `\b` still stops `from`
    // matching inside a longer identifier such as `transform`.
    const STOP_PATTERN = {
      from: /\bfrom\s*\{([\s\S]*?)\}/,
      to: /\bto\s*\{([\s\S]*?)\}/,
    } as const;
    const stop = (name: "from" | "to") =>
      STOP_PATTERN[name].exec(keyframes!)?.[1]?.replace(/\s+/g, " ").trim();
    expect(stop("from")).toBeTruthy();
    expect(stop("from")).toBe(stop("to"));
  });

  it("sets no fill-mode, so a clamped animation cannot leave the ring stuck mid-breath", () => {
    // Reduced motion is handled in JS (the component drops the marker), but the
    // global prefers-reduced-motion rule below also clamps any animation to
    // 0.01ms / 1 iteration. With no `forwards`, that ends with the ring at its
    // normal size instead of frozen at the bottom of an exhale.
    expect(rule).not.toBeNull();
    expect(rule).not.toMatch(/\b(forwards|both)\b/);
    expect(rule).not.toMatch(/animation-fill-mode/);
  });
});
