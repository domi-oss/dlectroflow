import { describe, it, expect, vi, afterEach } from "vitest";
import { FABLE_LINES, randomFableLine } from "@/lib/fable-lines";
import { mockCsprngDraw } from "@/lib/__tests__/mock-csprng";

afterEach(() => vi.restoreAllMocks());

describe("fable decoy lines (#72 follow-up)", () => {
  it("always returns one of the defined lines", () => {
    expect(FABLE_LINES.length).toBeGreaterThan(1);
    for (let i = 0; i < 50; i++) {
      expect(FABLE_LINES).toContain(randomFableLine());
    }
  });

  it("can reach the first and last line", () => {
    // `randomFableLine` draws from the platform CSPRNG via `pickOne`
    // (src/lib/pick-one.ts), so a `Math.random` spy no longer reaches it. The
    // cases are the same two ends of the range, expressed as the 32-bit draw
    // the code now reads: 0 is the bottom, 0xffffffff the top.
    mockCsprngDraw(0);
    expect(randomFableLine()).toBe(FABLE_LINES[0]);
    mockCsprngDraw(0xffffffff);
    expect(randomFableLine()).toBe(FABLE_LINES[FABLE_LINES.length - 1]);
  });

  it("lives outside the client component, so the server can call it", async () => {
    // Regression guard: this used to be picked in a `useState` initialiser
    // inside the client component that renders the decoy ("use client"), which
    // made every /settings load a hydration mismatch. Moving it to a client
    // module's exports is NOT a fix either — a server render cannot call a client
    // reference. (#101 split that component out of settings-panel.tsx into
    // breakdown-model-section.tsx; the guard follows the decoy.)
    // Resolved against THIS file, not the process cwd, so the test still works
    // if vitest is ever run from somewhere other than the repo root.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL(
          "../components/settings/breakdown-model-section.tsx",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(source).not.toMatch(/Math\.random/);
  });
});
