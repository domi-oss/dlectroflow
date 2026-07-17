// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskSteps } from "@/components/breakdown/task-steps";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/app/actions/breakdown", () => ({
  extractStepToInbox: vi.fn(),
}));
vi.mock("@/app/actions/focus", () => ({
  completeStep: vi.fn().mockResolvedValue(undefined),
  renameStep: vi.fn().mockResolvedValue(undefined),
  updateStepEstimate: vi.fn().mockResolvedValue(undefined),
}));

import { extractStepToInbox } from "@/app/actions/breakdown";
import { completeStep, renameStep, updateStepEstimate } from "@/app/actions/focus";

function steps(overrides: Partial<ReturnType<typeof baseStep>>[] = []) {
  const base = [
    { id: "s1", order: 1, total: 2, text: "First", subtaskEmoji: "🌱", estMinutes: 10, done: false, resumable: false },
    { id: "s2", order: 2, total: 2, text: "Second", subtaskEmoji: "🚀", estMinutes: 15, done: false, resumable: false },
  ];
  return base.map((s, i) => ({ ...s, ...(overrides[i] ?? {}) }));
}
function baseStep() {
  return { id: "s1", order: 1, total: 2, text: "First", subtaskEmoji: "🌱", estMinutes: 10, done: false, resumable: false };
}

const openMenu = async (user: ReturnType<typeof userEvent.setup>, index = 0) =>
  user.click(screen.getAllByRole("button", { name: "All options" })[index]);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("TaskSteps — row layout mirrors the inbox ItemRow", () => {
  it("each not-done row renders Complete + Start Focus + the 🔽 dropdown trigger", () => {
    render(<TaskSteps taskId="t1" steps={steps()} />);
    // Shared CompleteButton (plain voice → "Complete") on each row.
    expect(screen.getAllByRole("button", { name: "Complete" })).toHaveLength(2);
    // Inline Start Focus CTA on each row.
    expect(screen.getAllByText("▶ Start Focus")).toHaveLength(2);
    // 🔽 dropdown trigger on each row.
    expect(screen.getAllByRole("button", { name: "All options" })).toHaveLength(2);
    // The old ↗ send-to-review icon is gone.
    expect(screen.queryByTitle("Send to review")).not.toBeInTheDocument();
  });

  it("the 🔽 dropdown lists all five entries", async () => {
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    await openMenu(user);
    expect(screen.getByText("Start focus timer")).toBeInTheDocument();
    expect(screen.getByText("Complete step")).toBeInTheDocument();
    expect(screen.getByText("Edit time estimate")).toBeInTheDocument();
    expect(screen.getByText("Edit step title")).toBeInTheDocument();
    expect(screen.getByText("Send back to review")).toBeInTheDocument();
  });

  it("uses Resume labels for a resumable step (inline + dropdown)", async () => {
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[{ ...baseStep(), resumable: true }]} />);
    expect(screen.getByText("▶ Resume Focus")).toBeInTheDocument();
    expect(screen.queryByText("▶ Start Focus")).not.toBeInTheDocument();
    await openMenu(user);
    expect(screen.getByText("Resume focus timer")).toBeInTheDocument();
    expect(screen.queryByText("Start focus timer")).not.toBeInTheDocument();
  });

  it("Start Focus points at /focus/[stepId]", () => {
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    expect(screen.getByText("▶ Start Focus").closest("a")).toHaveAttribute("href", "/focus/s1");
  });
});

describe("TaskSteps — done steps", () => {
  it("shows the done state (strikethrough + ✓) and omits the action line", () => {
    render(<TaskSteps taskId="t1" steps={[{ ...baseStep(), done: true }]} />);
    const title = screen.getByText(/First/);
    expect(title.className).toContain("line-through");
    expect(screen.getByText("✓")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Complete" })).not.toBeInTheDocument();
    expect(screen.queryByText("▶ Start Focus")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All options" })).not.toBeInTheDocument();
  });
});

describe("TaskSteps — complete step", () => {
  it("the inline Complete button calls completeStep", async () => {
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={steps()} />);
    await user.click(screen.getAllByRole("button", { name: "Complete" })[0]);
    expect(completeStep).toHaveBeenCalledWith("s1");
  });

  it("the dropdown Complete step entry calls completeStep", async () => {
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    await openMenu(user);
    await user.click(screen.getByText("Complete step"));
    expect(completeStep).toHaveBeenCalledWith("s1");
  });
});

describe("TaskSteps — send back to review (dropdown)", () => {
  it("extracts a step and refreshes when steps remain", async () => {
    (extractStepToInbox as ReturnType<typeof vi.fn>).mockResolvedValue({ taskId: "t1", remaining: 1 });
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={steps()} />);

    await openMenu(user);
    await user.click(screen.getByText("Send back to review"));
    await waitFor(() => expect(extractStepToInbox).toHaveBeenCalledWith("s1"));
    expect(refresh).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the empty-task chooser when the last step is extracted", async () => {
    (extractStepToInbox as ReturnType<typeof vi.fn>).mockResolvedValue({ taskId: "t1", remaining: 0 });
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);

    await openMenu(user);
    await user.click(screen.getByText("Send back to review"));
    expect(await screen.findByRole("button", { name: /Re-plan with AI/i })).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("chooser routes: AI editor, manual editor, keep-as-todo", async () => {
    (extractStepToInbox as ReturnType<typeof vi.fn>).mockResolvedValue({ taskId: "t1", remaining: 0 });
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    await openMenu(user);
    await user.click(screen.getByText("Send back to review"));

    await user.click(await screen.findByRole("button", { name: /Re-plan with AI/i }));
    expect(push).toHaveBeenCalledWith("/tasks/t1");
    await user.click(screen.getByRole("button", { name: /Re-plan manually/i }));
    expect(push).toHaveBeenCalledWith("/tasks/t1?edit=1&manual=1");
    await user.click(screen.getByRole("button", { name: /single to-do/i }));
    expect(push).toHaveBeenCalledWith("/inbox");
  });
});

describe("TaskSteps — inline editors", () => {
  it("Edit step title saves the new text via renameStep", async () => {
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    await openMenu(user);
    await user.click(screen.getByText("Edit step title"));
    const input = screen.getByLabelText("Edit step title");
    await user.clear(input);
    await user.type(input, "Renamed step{Enter}");
    expect(renameStep).toHaveBeenCalledWith("s1", "Renamed step");
  });

  it("the ✏️ pencil beside the title opens the inline rename editor (no menu needed)", async () => {
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    await user.click(screen.getByRole("button", { name: "Edit First" }));
    expect(screen.getByLabelText("Edit step title")).toBeInTheDocument();
  });

  it("Edit step title Escape cancels without saving", async () => {
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    await openMenu(user);
    await user.click(screen.getByText("Edit step title"));
    const input = screen.getByLabelText("Edit step title");
    await user.type(input, "nope{Escape}");
    expect(renameStep).not.toHaveBeenCalled();
  });

  it("Edit time estimate saves the new minutes via updateStepEstimate", async () => {
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    await openMenu(user);
    await user.click(screen.getByText("Edit time estimate"));
    const input = screen.getByLabelText("Edit time estimate");
    await user.clear(input);
    await user.type(input, "45{Enter}");
    expect(updateStepEstimate).toHaveBeenCalledWith("s1", 45);
  });

  it("Edit time estimate: clearing the field + Enter cancels, does not save 0 (Duo review)", async () => {
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    await openMenu(user);
    await user.click(screen.getByText("Edit time estimate"));
    const input = screen.getByLabelText("Edit time estimate");
    await user.clear(input);
    await user.keyboard("{Enter}");
    expect(updateStepEstimate).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Edit time estimate")).not.toBeInTheDocument();
  });

  it("Edit time estimate: a value over 480 + Enter cancels, not saved (Duo review)", async () => {
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    await openMenu(user);
    await user.click(screen.getByText("Edit time estimate"));
    const input = screen.getByLabelText("Edit time estimate");
    await user.clear(input);
    await user.type(input, "999{Enter}");
    expect(updateStepEstimate).not.toHaveBeenCalled();
  });
});
