// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FocusTimer } from "@/components/focus/focus-timer";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

vi.mock("@/app/actions/focus", () => ({
  beginFocus: vi.fn().mockResolvedValue("session-1"),
  completeFocus: vi.fn(),
  giveUpFocus: vi.fn(),
  requeueFocus: vi.fn(),
  proposeNewEstimate: vi.fn(),
}));

import { beginFocus, completeFocus, giveUpFocus } from "@/app/actions/focus";

function baseStep() {
  return {
    id: "s1",
    text: "Write the report",
    estMinutes: 10,
    subtaskEmoji: null,
    order: 1,
    total: 1,
    done: false,
  };
}

async function renderRunning() {
  const user = userEvent.setup();
  render(
    <FocusTimer
      step={baseStep()}
      taskId="t1"
      taskTitle="Report"
      parentEmoji={null}
      addTimeIncrementMin={5}
      initialStats={{ focusMin: 0, sessions: 0 }}
      nextStepId={null}
    />,
  );
  await user.click(screen.getByRole("button", { name: /start focusing/i }));
  return user;
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

// NOTE: the pre-existing "Give up" button's plain-voice label is also, confusingly,
// "Pause for now" (no emoji) — see focus.giveUp in strings.ts. It ends the session
// (giveUpFocus). The new control below is distinguished by its ⏸️ glyph so this
// test doesn't collide with it; the label collision itself is flagged in the report.
const PAUSE_FOR_NOW = "⏸️ Pause for now";

describe("FocusTimer — Pause for now (light exit)", () => {
  it("shows a 'Pause for now' control once the session is running", async () => {
    await renderRunning();
    expect(beginFocus).toHaveBeenCalledWith("s1", 10);
    expect(
      screen.getByRole("button", { name: PAUSE_FOR_NOW }),
    ).toBeInTheDocument();
  });

  it("navigates to /inbox and does not end the session", async () => {
    const user = await renderRunning();
    await user.click(screen.getByRole("button", { name: PAUSE_FOR_NOW }));
    expect(push).toHaveBeenCalledWith("/inbox");
    expect(giveUpFocus).not.toHaveBeenCalled();
    expect(completeFocus).not.toHaveBeenCalled();
  });
});
