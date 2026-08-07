// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskSteps } from "@/components/breakdown/task-steps";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));
vi.mock("@/app/actions/breakdown", () => ({
  ejectStepToInbox: vi.fn(),
}));
vi.mock("@/app/actions/focus", () => ({
  completeStep: vi.fn().mockResolvedValue(undefined),
  uncompleteStep: vi.fn().mockResolvedValue(undefined),
  renameStep: vi.fn().mockResolvedValue(undefined),
  updateStepEstimate: vi.fn().mockResolvedValue(undefined),
}));
// #44 — every row now mounts a note disclosure, so the action it binds has to
// exist even in the specs that are about something else entirely.
vi.mock("@/app/actions/step-notes", () => ({
  updateStepNotes: vi
    .fn()
    .mockImplementation(async (_id: string, notes: string | null) => ({
      ok: true,
      notes,
    })),
}));

import { ejectStepToInbox } from "@/app/actions/breakdown";
import {
  completeStep,
  uncompleteStep,
  renameStep,
  updateStepEstimate,
} from "@/app/actions/focus";

function steps(overrides: Partial<ReturnType<typeof baseStep>>[] = []) {
  const base = [
    {
      id: "s1",
      order: 1,
      total: 2,
      text: "First",
      subtaskEmoji: "🌱",
      estMinutes: 10,
      done: false,
      notes: null as string | null,
      resumable: false,
    },
    {
      id: "s2",
      order: 2,
      total: 2,
      text: "Second",
      subtaskEmoji: "🚀",
      estMinutes: 15,
      done: false,
      notes: null as string | null,
      resumable: false,
    },
  ];
  return base.map((s, i) => ({ ...s, ...(overrides[i] ?? {}) }));
}
function baseStep() {
  return {
    id: "s1",
    order: 1,
    total: 2,
    text: "First",
    subtaskEmoji: "🌱",
    estMinutes: 10,
    done: false,
    notes: null as string | null,
    resumable: false,
  };
}

const openMenu = async (user: ReturnType<typeof userEvent.setup>, index = 0) =>
  user.click(screen.getAllByRole("button", { name: "All options" })[index]);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("TaskSteps — row layout mirrors the inbox ItemRow", () => {
  it("each not-done row renders Complete + Start Focus + the 🔽 dropdown trigger", () => {
    render(<TaskSteps taskId="t1" steps={steps()} />);
    // Shared CompleteButton (plain voice → "Complete") on each row.
    expect(screen.getAllByRole("button", { name: "✓ Complete" })).toHaveLength(
      2,
    );
    // Inline Start Focus CTA on each row.
    expect(screen.getAllByText("▶ Start Focus")).toHaveLength(2);
    // 🔽 dropdown trigger on each row.
    expect(screen.getAllByRole("button", { name: "All options" })).toHaveLength(
      2,
    );
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
    render(
      <TaskSteps taskId="t1" steps={[{ ...baseStep(), resumable: true }]} />,
    );
    expect(screen.getByText("▶ Resume Focus")).toBeInTheDocument();
    expect(screen.queryByText("▶ Start Focus")).not.toBeInTheDocument();
    await openMenu(user);
    expect(screen.getByText("Resume focus timer")).toBeInTheDocument();
    expect(screen.queryByText("Start focus timer")).not.toBeInTheDocument();
  });

  it("Start Focus points at /focus/[stepId]", () => {
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    expect(screen.getByText("▶ Start Focus").closest("a")).toHaveAttribute(
      "href",
      "/focus/s1",
    );
  });
});

describe("TaskSteps — done steps", () => {
  it("shows the done state (strikethrough + ✓) and omits the action line", () => {
    render(<TaskSteps taskId="t1" steps={[{ ...baseStep(), done: true }]} />);
    const title = screen.getByText(/First/);
    // Done step uses the app-wide completion treatment (Design D), not a
    // hard-coded line-through / green.
    expect(title.className).toContain(
      "[text-decoration-line:var(--complete-decoration)]",
    );
    // The done marker is the shared app-wide DonePill ("✓ done"), tick colour
    // from --tick-color — the same pill the Library "done" view uses.
    const pill = screen.getByText(/✓\s*done/i);
    expect(pill.className).toContain("text-[color:var(--tick-color)]");
    expect(pill.className).toContain("rounded-full");
    expect(
      screen.queryByRole("button", { name: "✓ Complete" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("▶ Start Focus")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "All options" }),
    ).not.toBeInTheDocument();
  });
});

describe("TaskSteps — un-completing a done step (#198)", () => {
  // Until this existed, a step completed while its task still had other open
  // steps could not be reopened anywhere: `reopenItem` takes a BrainDumpItem id
  // and is only reachable from the inbox Done view, which the item never reaches
  // while any step is outstanding.
  it("a done row offers an un-complete, and it calls uncompleteStep for THAT step", async () => {
    const user = userEvent.setup();
    render(
      <TaskSteps
        taskId="t1"
        steps={[{ ...baseStep(), id: "s7", done: true }]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /mark not done/i }));
    expect(uncompleteStep).toHaveBeenCalledWith("s7");
    expect(refresh).toHaveBeenCalled();
  });

  it("names the control after its own step, so a page of done rows is navigable", () => {
    render(
      <TaskSteps
        taskId="t1"
        steps={[
          { ...baseStep(), id: "s1", text: "First", done: true },
          { ...baseStep(), id: "s2", order: 2, text: "Second", done: true },
        ]}
      />,
    );
    // Two controls both called "Mark not done" would be indistinguishable in a
    // screen reader's list of buttons (WCAG 2.4.6) — the same reason the note
    // triggers carry their step's text.
    expect(
      screen.getByRole("button", { name: /mark not done: first/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /mark not done: second/i }),
    ).toBeInTheDocument();
  });

  it("is the ONLY action a done row gains — Complete, Start Focus and the menu stay absent", () => {
    render(<TaskSteps taskId="t1" steps={[{ ...baseStep(), done: true }]} />);
    expect(
      screen.getByRole("button", { name: /mark not done/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "✓ Complete" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("▶ Start Focus")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "All options" }),
    ).not.toBeInTheDocument();
  });

  // Round 10 — the same defect #169 fixed in the inbox, reintroduced here. The
  // undo carried `disabled={pending}` from the ONE `useTransition` shared by every
  // action in this list, so completing, renaming or re-estimating any *other* step
  // greyed out this row's undo for the length of that round trip, and a press
  // landing in the window was discarded with no error and no toast.
  //
  // Holding the action's promise unresolved makes the in-flight window real rather
  // than a race — the technique !237, !264, !265 and the #169 fix all use.
  it("holds only the undoing row's own control while its call is in flight", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    vi.mocked(uncompleteStep).mockImplementationOnce(
      () => new Promise<void>((res) => (release = res)),
    );
    render(
      <TaskSteps
        taskId="t1"
        steps={[
          { ...baseStep(), id: "s1", text: "First", done: true },
          { ...baseStep(), id: "s2", order: 2, text: "Second", done: true },
        ]}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /mark not done: first/i }),
    );

    // Its own control: still held — that is all double-submit protection ever
    // needed, and it now says why rather than going quietly grey.
    const first = screen.getByRole("button", {
      name: /mark not done: first/i,
    });
    expect(first).toBeDisabled();
    expect(first).toHaveAccessibleName(/already in progress for this row/i);
    expect(first).toHaveAttribute("aria-busy", "true");

    // The other row was never a party to it, so its press must land.
    const second = screen.getByRole("button", {
      name: /mark not done: second/i,
    });
    expect(second).toBeEnabled();
    expect(second).not.toHaveAttribute("aria-busy");

    release();
    await waitFor(() => expect(first).toBeEnabled());
  });

  it("completing a different step disables no undo control at all", async () => {
    // The live half, driven through the path a user actually takes: a task with
    // one outstanding step and one already done. Completing the outstanding one
    // has nothing to do with the done one's undo, and no list-wide argument
    // covers it — the same case rename was for #169.
    const user = userEvent.setup();
    let release!: () => void;
    vi.mocked(completeStep).mockImplementationOnce(
      () => new Promise<void>((res) => (release = res)),
    );
    render(
      <TaskSteps
        taskId="t1"
        steps={[
          { ...baseStep(), id: "s1", text: "Still open", done: false },
          { ...baseStep(), id: "s2", order: 2, text: "Second", done: true },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "✓ Complete" }));

    const undo = screen.getByRole("button", {
      name: /mark not done: second/i,
    });
    expect(undo).toBeEnabled();
    expect(undo).toHaveAccessibleName(/^mark not done: second$/i);

    release();
    await waitFor(() => expect(completeStep).toHaveBeenCalledWith("s1"));
  });
});

describe("TaskSteps — complete step", () => {
  it("the inline Complete button calls completeStep", async () => {
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={steps()} />);
    await user.click(screen.getAllByRole("button", { name: "✓ Complete" })[0]);
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
    (ejectStepToInbox as ReturnType<typeof vi.fn>).mockResolvedValue({
      taskId: "t1",
      remaining: 1,
    });
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={steps()} />);

    await openMenu(user);
    await user.click(screen.getByText("Send back to review"));
    await waitFor(() => expect(ejectStepToInbox).toHaveBeenCalledWith("s1"));
    expect(refresh).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the empty-task chooser when the last step is extracted", async () => {
    (ejectStepToInbox as ReturnType<typeof vi.fn>).mockResolvedValue({
      taskId: "t1",
      remaining: 0,
    });
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);

    await openMenu(user);
    await user.click(screen.getByText("Send back to review"));
    expect(
      await screen.findByRole("button", { name: /Re-plan with AI/i }),
    ).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("chooser routes: AI editor, manual editor, keep-as-todo", async () => {
    (ejectStepToInbox as ReturnType<typeof vi.fn>).mockResolvedValue({
      taskId: "t1",
      remaining: 0,
    });
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    await openMenu(user);
    await user.click(screen.getByText("Send back to review"));

    await user.click(
      await screen.findByRole("button", { name: /Re-plan with AI/i }),
    );
    expect(push).toHaveBeenCalledWith("/tasks/t1");
    await user.click(screen.getByRole("button", { name: /Re-plan manually/i }));
    expect(push).toHaveBeenCalledWith("/tasks/t1?edit=1&manual=1");
    await user.click(screen.getByRole("button", { name: /single to-do/i }));
    expect(push).toHaveBeenCalledWith("/");
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
    expect(
      screen.queryByLabelText("Edit time estimate"),
    ).not.toBeInTheDocument();
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

// #44 — placement, pinned at the step grain too. The disclosure behaves
// identically wherever it is mounted, so only a container assertion can tell
// the two placements apart, and only this stops it drifting back.
describe("TaskSteps — the note trigger sits in the step's action group (#44)", () => {
  it("puts the trigger in the SAME action group as that step's Complete", () => {
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    const complete = screen.getByRole("button", { name: "✓ Complete" });
    const trigger = screen.getByRole("button", {
      name: "Note for step 1 of 2: First",
    });
    const group = complete.closest("[data-row-actions]");
    expect(group).not.toBeNull();
    expect(trigger.closest("[data-row-actions]")).toBe(group);
  });

  it("names each step's trigger after ITS step, not just 'Note'", () => {
    // Twelve identical "Note" buttons down a list is the failure this prevents,
    // and it is the one an automated a11y gate cannot see.
    render(<TaskSteps taskId="t1" steps={steps()} />);
    expect(
      screen.getByRole("button", { name: "Note for step 1 of 2: First" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Note for step 2 of 2: Second" }),
    ).toBeTruthy();
  });

  it("opens the editor below the action line, still inside that step's row", async () => {
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    await user.click(
      screen.getByRole("button", { name: "Note for step 1 of 2: First" }),
    );
    const box = screen.getByRole("textbox", {
      name: "Note for step 1 of 2: First",
    });
    expect(box.closest("[data-row-actions]")).toBeNull();
    expect(box.closest("li")).toBe(
      screen.getByRole("button", { name: "✓ Complete" }).closest("li"),
    );
  });
});

describe("TaskSteps — a failed un-complete says so, and is retryable (#198, round 11)", () => {
  // Round 11's second finding. The timer's undo routes through `run()` and shows
  // "it is still marked done" with a Try again; this row-level one had no `catch`
  // at all, so a failed undo cleared the spinner and reverted to the idle done
  // appearance with nothing said. The CHANGELOG entry for #198 claims "an undo
  // that fails is an undo you can retry" — that was true on the timer and false
  // here, which makes it a defect in this MR rather than a pre-existing gap.
  it("surfaces the failure, keeps the row usable, and retries on demand", async () => {
    const user = userEvent.setup();
    vi.mocked(uncompleteStep).mockRejectedValueOnce(new Error("db down"));
    render(
      <TaskSteps
        taskId="t1"
        steps={[{ ...baseStep(), id: "s1", text: "First", done: true }]}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /mark not done: first/i }),
    );

    // Said out loud, not just coloured: `role="alert"` is what reaches a screen
    // reader without moving focus off whatever the user was doing.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/still marked done/i);
    // The claim is TRUE, which is why this string can be reused verbatim from the
    // timer: the guarded transaction rolls back, so the step really is still done.
    expect(refresh).not.toHaveBeenCalled();

    // Not left stuck disabled — `finally` clears the in-flight id even on a throw.
    const undo = screen.getByRole("button", { name: /mark not done: first/i });
    expect(undo).toBeEnabled();

    // And the retry actually retries.
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(uncompleteStep).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("keeps one row's failure to that row", async () => {
    const user = userEvent.setup();
    vi.mocked(uncompleteStep).mockRejectedValueOnce(new Error("db down"));
    render(
      <TaskSteps
        taskId="t1"
        steps={[
          { ...baseStep(), id: "s1", text: "First", done: true },
          { ...baseStep(), id: "s2", order: 2, text: "Second", done: true },
        ]}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /mark not done: first/i }),
    );
    await screen.findByRole("alert");
    // One notice, on the row that failed — not a page-level banner that leaves the
    // user guessing which of several done rows it refers to.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: /mark not done: second/i }),
    ).toBeEnabled();
  });
});
