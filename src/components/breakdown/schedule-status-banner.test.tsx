// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ScheduleStatusBanner } from "@/components/breakdown/schedule-status-banner";

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
