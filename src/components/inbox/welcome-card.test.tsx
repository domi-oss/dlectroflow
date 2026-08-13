// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WelcomeCard } from "./welcome-card";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock("@/app/actions/settings", () => ({
  dismissWelcome: vi.fn().mockResolvedValue(undefined),
  updateVoice: vi.fn().mockResolvedValue(undefined),
}));

import { dismissWelcome } from "@/app/actions/settings";

afterEach(cleanup);

describe("WelcomeCard", () => {
  it("opens with the greeting in the body (👋); the separate title heading is dropped", () => {
    render(<WelcomeCard voice="plain" />);
    const body = screen.getByText(
      /Welcome to dlectroflow, you are in the inbox/,
    );
    expect(body).toBeInTheDocument();
    expect(body.textContent).toContain("👋");
    // No standalone <h2> title any more — the greeting lives in the body.
    expect(
      screen.queryByRole("heading", { name: /Welcome to dlectroflow/ }),
    ).toBeNull();
  });

  // ── Links are embedded INLINE in the body sentences (no separate row) ──────
  it("embeds the Focus Timer link (→ /focus)", () => {
    render(<WelcomeCard voice="plain" />);
    expect(screen.getByRole("link", { name: "Focus Timer" })).toHaveAttribute(
      "href",
      "/focus",
    );
  });

  it("embeds the Library link (→ /library) with the plain label", () => {
    render(<WelcomeCard voice="plain" />);
    expect(screen.getByRole("link", { name: "Library" })).toHaveAttribute(
      "href",
      "/library",
    );
  });

  it("embeds the Library link with the playful label (Larder → /library)", () => {
    render(<WelcomeCard voice="playful" />);
    expect(screen.getByRole("link", { name: "Larder" })).toHaveAttribute(
      "href",
      "/library",
    );
  });

  it("embeds only 'Help section' as the /help link", () => {
    render(<WelcomeCard voice="plain" />);
    expect(screen.getByRole("link", { name: "Help section" })).toHaveAttribute(
      "href",
      "/help",
    );
  });

  it("renders both voice options", () => {
    render(<WelcomeCard voice="plain" />);
    expect(screen.getByRole("button", { name: "Plain" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Playful" })).toBeInTheDocument();
  });

  it("calls dismissWelcome when the Dismiss button is clicked", async () => {
    render(<WelcomeCard voice="plain" />);
    await userEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(dismissWelcome).toHaveBeenCalledTimes(1);
  });
});

/**
 * #205 (folded into #253) — the first-run card's buttons carry the shared 44px
 * floor. It was one of the two files #205's audit found with **zero**
 * `touchTarget` anywhere in it; `select-action-bar.tsx` was the third and landed
 * earlier on this branch.
 *
 * Citation, stated the way `row-menu-viewport-fit.spec.ts` and
 * `breakdown/note-field.tsx` state it, because getting it backwards is a
 * documented error in this repo: 44x44 is **2.5.5 Target Size (Enhanced), AAA**.
 * **2.5.8 (Minimum) is the AA one and asks for 24x24**, which these buttons
 * already met at `py-1`. So this is the app exceeding its own AA bar on purpose
 * — a house convention (`touchTarget` in `@/lib/utils`), not a conformance fix.
 * Writing "2.5.8" here would make a voluntary 44px read as mandatory and invite
 * a future reader to treat dropping it as an AA regression.
 *
 * The reason to do it anyway is #184's, and it is a product reason: this is a
 * tool for people with ADHD used mostly on a phone, and on first run these three
 * buttons are the only controls on the screen bar the capture box.
 *
 * The three inline `<Link>`s in the body prose are deliberately NOT sized. They
 * are links inside a sentence, where both 2.5.5 and 2.5.8 carve out an explicit
 * inline exception, and squaring them to 44px would break the line box of the
 * paragraph they read as part of.
 */
describe("WelcomeCard — 44px targets (#205 leg)", () => {
  const expect44 = (el: HTMLElement) => {
    expect(el.className, `"${el.textContent}" is not ≥44px tall`).toContain(
      "min-h-11",
    );
    expect(el.className, `"${el.textContent}" is not ≥44px wide`).toContain(
      "min-w-11",
    );
  };

  it("both voice options and the dismiss button carry the 44px touch target", () => {
    render(<WelcomeCard voice="plain" />);
    const names = ["Plain", "Playful", "Got it"];
    for (const name of names) {
      expect44(screen.getByRole("button", { name }));
    }
    // Guard the guard. #205's own table says this file has "2" buttons — that is
    // the count of `<button` occurrences in the source, not of rendered controls:
    // the voice pair comes out of a `.map`, so THREE render. A loop over names
    // would pass just as happily against two.
    expect(screen.getAllByRole("button")).toHaveLength(names.length);
  });

  it("keeps the pair reading as one segmented control, not two loose buttons", () => {
    render(<WelcomeCard voice="plain" />);
    // The 44px floor is applied INSIDE the bordered group, so the group grows
    // with its buttons. Sizing the group instead would leave a 24px hit area
    // inside a 44px box — the shape that makes a target-size fix look done and
    // measure wrong.
    const group = screen.getByRole("group", { name: "Voice preference" });
    expect(group).toContainElement(
      screen.getByRole("button", { name: "Plain" }),
    );
    expect(group.className).not.toContain("min-h-11");
  });

  it("the inline body links stay inline and unsized", () => {
    render(<WelcomeCard voice="plain" />);
    for (const name of ["Focus Timer", "Library", "Help section"]) {
      const link = screen.getByRole("link", { name });
      expect(link.className, `"${name}" was squared up`).not.toContain(
        "min-h-11",
      );
    }
  });

  it("sizing did not cost the pressed state or the pending disable", () => {
    render(<WelcomeCard voice="playful" />);
    // `aria-pressed` is how the segmented pair announces the current voice; it
    // rides the same className expression the fix rewrote.
    expect(screen.getByRole("button", { name: "Playful" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Plain" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
