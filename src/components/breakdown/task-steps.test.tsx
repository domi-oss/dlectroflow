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
}));

import { extractStepToInbox } from "@/app/actions/breakdown";
import { completeStep } from "@/app/actions/focus";

function steps() {
  return [
    { id: "s1", order: 1, total: 2, text: "First", subtaskEmoji: "🌱", estMinutes: 10, done: false },
    { id: "s2", order: 2, total: 2, text: "Second", subtaskEmoji: "🚀", estMinutes: 15, done: false },
  ];
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("TaskSteps — send to review", () => {
  it("extracts a step and refreshes when steps remain", async () => {
    (extractStepToInbox as ReturnType<typeof vi.fn>).mockResolvedValue({ taskId: "t1", remaining: 1 });
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={steps()} />);

    await user.click(screen.getAllByTitle("Send to review")[0]);
    await waitFor(() => expect(extractStepToInbox).toHaveBeenCalledWith("s1"));
    expect(refresh).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the empty-task chooser when the last step is extracted", async () => {
    (extractStepToInbox as ReturnType<typeof vi.fn>).mockResolvedValue({ taskId: "t1", remaining: 0 });
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);

    await user.click(screen.getByTitle("Send to review"));
    expect(await screen.findByRole("button", { name: /Re-plan with AI/i })).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("chooser routes: AI editor, manual editor, keep-as-todo", async () => {
    (extractStepToInbox as ReturnType<typeof vi.fn>).mockResolvedValue({ taskId: "t1", remaining: 0 });
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    await user.click(screen.getByTitle("Send to review"));

    await user.click(await screen.findByRole("button", { name: /Re-plan with AI/i }));
    expect(push).toHaveBeenCalledWith("/tasks/t1");

    await user.click(screen.getByRole("button", { name: /Re-plan manually/i }));
    expect(push).toHaveBeenCalledWith("/tasks/t1?edit=1&manual=1");

    await user.click(screen.getByRole("button", { name: /single to-do/i }));
    expect(push).toHaveBeenCalledWith("/inbox");
  });
});

describe("TaskSteps — complete step", () => {
  it("a step's ✓ Complete calls completeStep", async () => {
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={steps()} />);
    await user.click(screen.getAllByRole("button", { name: /Complete/i })[0]);
    expect(completeStep).toHaveBeenCalledWith("s1");
  });
});
