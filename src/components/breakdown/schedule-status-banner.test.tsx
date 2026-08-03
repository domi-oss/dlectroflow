// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ScheduleStatusBanner } from "@/components/breakdown/schedule-status-banner";
import { STATUS_BANNER_TONE } from "@/lib/status-banner-style";

afterEach(cleanup);

describe("ScheduleStatusBanner — reflects ground-truth scheduling state", () => {
  it("shows the scheduled banner when the task is persisted-scheduled", () => {
    render(<ScheduleStatusBanner scheduled voice="plain" />);
    expect(
      screen.getByText(/scheduled — these steps are on your calendar/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not scheduled yet/i)).toBeNull();
  });

  it("shows the not-scheduled banner when the task has never been scheduled", () => {
    render(<ScheduleStatusBanner scheduled={false} voice="plain" />);
    expect(
      screen.getByText(/not scheduled yet — connect a calendar/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/these steps are on your calendar/i)).toBeNull();
  });

  it("is voice-aware (playful adds a flavour glyph to the not-scheduled copy)", () => {
    render(<ScheduleStatusBanner scheduled={false} voice="playful" />);
    expect(screen.getByText(/🔌 Not scheduled yet/)).toBeInTheDocument();
  });
});

/**
 * #109 — this banner was in neither issue's inventory, because its tokens were
 * already correct-looking: `text-green-700 dark:text-green-400`, with a comment
 * asserting "-700 is AA on the light tint". Measured, it is not. The banner's own
 * `bg-green-600/10` composites over `--background` and pulls the background
 * toward the text, so green-700 reads **4.16:1** and amber-700 **4.42:1** — both
 * under the 4.5:1 this 14px copy needs. The comment's numbers came from measuring
 * the token against the bare background instead of against what the banner paints.
 *
 * The tone table is now the single source, so a fix here cannot drift from the
 * five sibling banners in `(app)/page.tsx` and `breakdown-chat.tsx`.
 */
describe("ScheduleStatusBanner — AA on its own tint (#109)", () => {
  it.each([
    [true, "ok" as const],
    [false, "warn" as const],
  ])(
    "takes the %s banner's colours from STATUS_BANNER_TONE",
    (scheduled, tone) => {
      render(<ScheduleStatusBanner scheduled={scheduled} voice="plain" />);
      // `getByRole` throws if the banner is missing and returns a non-nullable
      // HTMLElement, so there is no null check to guard and no optional chaining
      // to explain — and the failure points at the missing banner rather than at
      // a `toContain(undefined)`. Duo review, !250, which suggested `banner!`;
      // this locates the element the way a user does instead, and matches the
      // idiom the rest of this file already uses.
      const banner = screen.getByRole("status");
      for (const token of STATUS_BANNER_TONE[tone].split(/\s+/)) {
        expect(banner.className).toContain(token);
      }
    },
  );

  it("no longer uses the -700 shades that failed on the tint", () => {
    render(<ScheduleStatusBanner scheduled voice="plain" />);
    expect(screen.getByRole("status").className).not.toContain(
      "text-green-700",
    );
    cleanup();
    render(<ScheduleStatusBanner scheduled={false} voice="plain" />);
    expect(screen.getByRole("status").className).not.toContain(
      "text-amber-700",
    );
  });
});
