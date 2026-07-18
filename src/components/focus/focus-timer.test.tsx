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

// Owner reconcile (#8 Phase 5): there is now exactly ONE low-shame exit
// control, labelled "⏸️ Pause for now" (focus.pauseForNow). It does NOT end
// the FocusSession — no server call at all — so the step stays `resumable`
// and Task 3's Inbox resume banner can surface it. It shows the
// "Paused — no guilt" card (phase "gaveup").
const PAUSE_FOR_NOW = "⏸️ Pause for now";

describe("FocusTimer — Pause for now (light exit, keeps session open)", () => {
  it("shows exactly one 'Pause for now' control once the session is running", async () => {
    await renderRunning();
    expect(beginFocus).toHaveBeenCalledWith("s1", 10);
    expect(
      screen.getAllByRole("button", { name: PAUSE_FOR_NOW }),
    ).toHaveLength(1);
  });

  it("leaves the session open (no giveUpFocus/completeFocus call) and shows the paused card", async () => {
    const user = await renderRunning();
    await user.click(screen.getByRole("button", { name: PAUSE_FOR_NOW }));

    // The session is left OPEN — no server call ends it. This is what keeps
    // the step `resumable` so Task 3's Inbox banner surfaces it.
    expect(giveUpFocus).not.toHaveBeenCalled();
    expect(completeFocus).not.toHaveBeenCalled();

    // The "Paused — no guilt" card renders in place of the timer.
    expect(screen.getByText("Paused — no guilt.")).toBeInTheDocument();
  });
});
