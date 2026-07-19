// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SingleTaskLane, MultiStepLane } from "@/components/focus/focus-lanes";
import type { FocusableStep } from "@/lib/focus-launcher";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

vi.mock("@/app/actions/braindump", () => ({
  ensureFocusStep: vi.fn().mockResolvedValue("step-77"),
  completeItem: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/app/actions/focus", () => ({
  completeStep: vi.fn().mockResolvedValue(undefined),
}));

import { ensureFocusStep, completeItem } from "@/app/actions/braindump";
import { completeStep } from "@/app/actions/focus";

const multi = (o: Partial<FocusableStep> & { stepId: string }): FocusableStep => ({
  stepText: o.stepId,
  subtaskEmoji: null,
  estMinutes: 15,
  taskId: "task-" + o.stepId,
  taskTitle: "Task " + o.stepId,
  resumable: false,
  resumeAt: null,
  stepIndex: 1,
  stepsDone: 0,
  stepsTotal: 2,
  nextStepText: null,
  nextStepEmoji: null,
  ...o,
});

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("SingleTaskLane", () => {
  it("▶ Start ensures the focus step then routes to the timer", async () => {
    const user = userEvent.setup();
    render(<SingleTaskLane voice="plain" items={[{ itemId: "i1", text: "Buy milk", estMinutes: 8 }]} />);
    await user.click(screen.getByRole("button", { name: /start/i }));
    expect(ensureFocusStep).toHaveBeenCalledWith("i1");
    expect(push).toHaveBeenCalledWith("/focus/step-77");
  });

  it("inline ✓ optimistically removes the row, completeItem + refresh", async () => {
    const user = userEvent.setup();
    render(<SingleTaskLane voice="plain" items={[{ itemId: "i1", text: "Buy milk", estMinutes: 8 }]} />);
    await user.click(screen.getByRole("button", { name: /complete/i }));
    expect(screen.queryByText("Buy milk")).not.toBeInTheDocument(); // optimistic
    expect(completeItem).toHaveBeenCalledWith("i1");
    expect(refresh).toHaveBeenCalled();
  });
});

describe("MultiStepLane", () => {
  it("row links task title + step text + k/n progress + estimate", () => {
    render(
      <MultiStepLane
        voice="plain"
        items={[multi({ stepId: "m1", stepText: "Draft intro", taskTitle: "Report", stepsDone: 1, stepsTotal: 3, estMinutes: 20 })]}
      />,
    );
    expect(screen.getByText("Report")).toBeInTheDocument();
    expect(screen.getByText(/Draft intro/)).toBeInTheDocument();
    expect(screen.getByText(/1\/3/)).toBeInTheDocument();
    expect(screen.getByText(/20m/)).toBeInTheDocument();
  });

  it("▶ Open routes straight to the timer (no ensureFocusStep)", async () => {
    const user = userEvent.setup();
    render(<MultiStepLane voice="plain" items={[multi({ stepId: "m1" })]} />);
    await user.click(screen.getByRole("button", { name: /open/i }));
    expect(push).toHaveBeenCalledWith("/focus/m1");
    expect(ensureFocusStep).not.toHaveBeenCalled();
  });

  it("inline ✓ completes the shown next step (completeStep) + refresh, optimistic remove", async () => {
    const user = userEvent.setup();
    render(<MultiStepLane voice="plain" items={[multi({ stepId: "m1", stepText: "Draft intro" })]} />);
    await user.click(screen.getByRole("button", { name: /complete/i }));
    expect(screen.queryByText(/Draft intro/)).not.toBeInTheDocument();
    expect(completeStep).toHaveBeenCalledWith("m1");
    expect(refresh).toHaveBeenCalled();
  });
});
