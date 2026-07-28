import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #89 — the paused focus ring's breathing pacer is a CSS animation, so the part
// that makes it a *guide* rather than decoration — its cadence — lives in
// globals.css, where the component tests cannot see it (jsdom loads no
// stylesheet). These assertions run against the real stylesheet.
const CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/** A top-level block's body, given its selector/at-rule as regex source, or
 * null when the block is missing entirely — so a removed or renamed rule fails
 * as "not found" instead of as a confusing assertion about an empty string. */
function block(headerSource: string): string | null {
  return (
    new RegExp(`${headerSource}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(CSS)?.[1] ??
    null
  );
}

describe("focus-breathe pacer CSS (#89)", () => {
  const rule = block("\\[data-breathing\\]");
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
    const stop = (name: "from" | "to") =>
      new RegExp(`\\b${name}\\s*\\{([\\s\\S]*?)\\}`)
        .exec(keyframes!)?.[1]
        ?.replace(/\s+/g, " ")
        .trim();
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
