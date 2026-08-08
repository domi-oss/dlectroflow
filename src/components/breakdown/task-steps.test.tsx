// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskSteps } from "@/components/breakdown/task-steps";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("next/link", () => ({
  // Forwards `ref`, because the real `next/link` does and #206's focus hand-off
  // depends on it. A mock that silently drops the ref makes a working focus fix
  // look broken — which is exactly what it did on the first run of that spec.
  // React 19 passes `ref` as an ordinary prop to function components.
  default: ({
    children,
    href,
    ref,
  }: {
    children: React.ReactNode;
    href: string;
    ref?: React.Ref<HTMLAnchorElement>;
  }) => (
    <a href={href} ref={ref}>
      {children}
    </a>
  ),
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

/** Tailwind classes as discrete tokens, so `aria-disabled:x` and `disabled:x`
 *  are distinguishable — the first contains the second as a substring. */
const classList = (el: Element) => el.className.split(/\s+/).filter(Boolean);

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
    // needed, and it now says why rather than going quietly grey. Held via
    // `aria-disabled`, not the native attribute; see the spec below for why.
    const first = screen.getByRole("button", {
      name: /mark not done: first/i,
    });
    expect(first).toHaveAttribute("aria-disabled", "true");
    expect(first).toHaveAccessibleName(/already in progress for this row/i);
    expect(first).toHaveAttribute("aria-busy", "true");

    // The other row was never a party to it, so its press must land.
    const second = screen.getByRole("button", {
      name: /mark not done: second/i,
    });
    expect(second).toBeEnabled();
    expect(second).toHaveAttribute("aria-disabled", "false");
    expect(second).not.toHaveAttribute("aria-busy");

    release();
    await waitFor(() =>
      expect(first).toHaveAttribute("aria-disabled", "false"),
    );
  });

  // Round 15 — WCAG 2.4.3, and the third time this MR has had to fix the same
  // class: the timer's Retry in round 6, the reopened row's hand-off in round 12,
  // and now the control that starts the undo. A `disabled` element cannot hold
  // focus, so the browser blurs it to <body> the instant the attribute lands —
  // which is the instant a keyboard user presses it. They are then holding
  // nothing, in a list of visually identical done rows, while a write they cannot
  // observe runs. `focus-timer.tsx` already carries the reasoning in a comment;
  // this control was still on the native attribute.
  //
  // The #169 promise survives the swap and is strictly better served by it: the
  // comment there notes that a `disabled` element is skipped by most screen
  // readers, so an `aria-disabled` one is the version that can actually SAY why
  // it is holding.
  it("holds the undo with aria-disabled, so the press that starts it keeps focus", async () => {
    const user = userEvent.setup();
    vi.mocked(uncompleteStep).mockImplementationOnce(
      () => new Promise<void>(() => {}),
    );
    render(
      <TaskSteps
        taskId="t1"
        steps={[{ ...baseStep(), id: "s1", text: "First", done: true }]}
      />,
    );

    const undo = screen.getByRole("button", { name: /mark not done: first/i });
    await user.click(undo);

    // Focusable, and still focused — the whole point of the swap.
    expect(undo).not.toBeDisabled();
    expect(undo).toHaveAttribute("aria-disabled", "true");
    expect(undo).toHaveFocus();
    // Dimming has to follow the attribute that now carries the state, or the
    // control looks live while it is held. Matched on the class LIST, not the
    // string: `aria-disabled:opacity-50` contains `disabled:opacity-50`, so a
    // substring assertion for the absence of the old variant can never pass.
    expect(classList(undo)).toContain("aria-disabled:opacity-50");
    expect(classList(undo)).not.toContain("disabled:opacity-50");
  });

  it("does not fire a second call when the held undo is pressed again", async () => {
    // An aria-disabled button is still clickable, so the handler guard is what
    // replaces the double-submit protection the native attribute used to give
    // for free. Without it the swap above would trade a focus bug for a
    // double-write.
    const user = userEvent.setup();
    vi.mocked(uncompleteStep).mockImplementationOnce(
      () => new Promise<void>(() => {}),
    );
    render(
      <TaskSteps
        taskId="t1"
        steps={[{ ...baseStep(), id: "s1", text: "First", done: true }]}
      />,
    );

    const undo = screen.getByRole("button", { name: /mark not done: first/i });
    await user.click(undo);
    await user.click(undo);
    await user.click(undo);

    expect(uncompleteStep).toHaveBeenCalledTimes(1);
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

  it("cannot be double-submitted: the retry withdraws its own notice", async () => {
    // Round 14 raised this as "the Try again button has no `disabled`, unlike the
    // control ten lines above it". Correct about the inconsistency, and the guard is
    // now there for consistency and defence in depth — but it is worth recording
    // what ACTUALLY protects this control, because it is not the `disabled` flag.
    //
    // `uncomplete` clears this row from `undoFailedIds` on the way in, which
    // unmounts the whole `role="alert"` the retry lives inside. So the button does
    // not become disabled — it ceases to exist. `disabled={undoing}` can therefore
    // never be observed in the disabled state, and asserting that it can would be
    // asserting a state the component cannot reach.
    //
    // The user-visible guarantee is the one pinned here: one press, one call, and
    // the notice goes away while the retry is in flight rather than sitting there
    // inviting a second press.
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
    await screen.findByRole("alert");
    expect(uncompleteStep).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /try again/i }));

    // The notice — and the retry inside it — is gone, so there is nothing left to
    // press twice.
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /try again/i }),
    ).not.toBeInTheDocument();
    expect(uncompleteStep).toHaveBeenCalledTimes(2);
  });

  it("holds the retry with aria-disabled too, matching the control above it", async () => {
    // Round 15's other half. The guard round 14 added used the native attribute
    // while the control ten lines above it and the timer's own Retry both use
    // `aria-disabled` — and a `disabled` element cannot hold focus, so on the one
    // control that lives inside a `role="alert"` the user has just pressed, the
    // native version is the one that drops them to <body>.
    //
    // The TRUE state is not observable from outside, for the reason the spec above
    // records: pressing the retry clears this row from `undoFailedIds`, which
    // unmounts the notice the button lives in, so it ceases to exist rather than
    // becoming held. What is pinned here is therefore the contract — the state is
    // published through ARIA, the dimming is driven off that attribute, and the
    // press is guarded in the handler rather than by the DOM.
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
    await screen.findByRole("alert");

    const retry = screen.getByRole("button", { name: /try again/i });
    expect(retry).not.toBeDisabled();
    expect(retry).toHaveAttribute("aria-disabled", "false");
    expect(classList(retry)).toContain("aria-disabled:opacity-50");
    expect(classList(retry)).not.toContain("disabled:opacity-50");
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

describe("TaskSteps — focus survives a successful un-complete (#206, round 12)", () => {
  // Duo round 12, and it confirms #206's suspicion independently. `steps.map()`
  // renders two structurally different subtrees for the SAME `key={s.id}`
  // depending on `s.done`, so when the refresh flips this row to not-done React
  // reconciles in place and swaps the children — unmounting the very button the
  // user just pressed. Nothing moved focus, so a keyboard or screen-reader user
  // was dropped to `<body>` at the moment their correction succeeded. WCAG 2.4.3.
  //
  // The same class of bug this MR already fixed for the timer's undo in round 7,
  // which is what makes leaving it here indefensible rather than merely untidy.
  it("hands focus to the reopened row's Start Focus, not to <body>", async () => {
    const user = userEvent.setup();
    const done = { ...baseStep(), id: "s1", text: "First", done: true };
    const { rerender } = render(<TaskSteps taskId="t1" steps={[done]} />);

    await user.click(
      screen.getByRole("button", { name: /mark not done: first/i }),
    );
    expect(uncompleteStep).toHaveBeenCalledWith("s1");

    // What `router.refresh()` does in production: the server re-renders this step
    // as not-done. `refresh` is a mock here, so the prop change is applied
    // directly — same reconciliation, same key, same unmount of the pressed
    // control.
    rerender(<TaskSteps taskId="t1" steps={[{ ...done, done: false }]} />);

    const startFocus = screen.getByRole("link", { name: /start focus/i });
    await waitFor(() => expect(startFocus).toHaveFocus());
    // NOT the Complete button: the user has just un-completed this step, so
    // landing focus on the one control that would re-complete it turns a stray
    // Enter into an undo of their undo.
    expect(
      screen.getByRole("button", { name: "✓ Complete" }),
    ).not.toHaveFocus();
  });

  it("hands off to BOTH rows when two undos are in flight at once", async () => {
    // Round 15. `undoingIds` is a Set precisely because two rows can be
    // un-completing at the same time, so the hand-off cannot be a single slot: the
    // undo that resolves second overwrote the id the first had stored, and the
    // first row's reopened control then received nothing — round 12's bug,
    // silently, for that row.
    //
    // Sequenced so the two hand-offs are individually observable: s1 resolves
    // first (storing s1), s2 resolves second (which used to clobber it), then the
    // server flips s1 alone. At that render the only pending id under the old
    // single-slot version was s2, whose row is still done, so nothing was focused
    // and s1's correction ended on <body>.
    const user = userEvent.setup();
    // `…Once`, twice: `vi.clearAllMocks()` does not reset implementations, so a
    // plain `mockImplementation` here would leak an un-resolving undo into every
    // spec that ran after it.
    const releases: Array<() => void> = [];
    const held = () => new Promise<void>((res) => releases.push(res));
    vi.mocked(uncompleteStep)
      .mockImplementationOnce(held)
      .mockImplementationOnce(held);
    const done1 = { ...baseStep(), id: "s1", text: "First", done: true };
    const done2 = {
      ...baseStep(),
      id: "s2",
      order: 2,
      text: "Second",
      done: true,
    };
    const { rerender } = render(
      <TaskSteps taskId="t1" steps={[done1, done2]} />,
    );

    await user.click(
      screen.getByRole("button", { name: /mark not done: first/i }),
    );
    await user.click(
      screen.getByRole("button", { name: /mark not done: second/i }),
    );
    expect(uncompleteStep).toHaveBeenCalledTimes(2);

    releases[0]();
    releases[1]();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));

    // First refresh: the server has reopened s1 only.
    rerender(
      <TaskSteps taskId="t1" steps={[{ ...done1, done: false }, done2]} />,
    );
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /start focus/i })).toHaveFocus(),
    );

    // Second refresh: s2 follows, and its own hand-off still has to land — the
    // fix must not drop the remaining id when it drains the first.
    rerender(
      <TaskSteps
        taskId="t1"
        steps={[
          { ...done1, done: false },
          { ...done2, done: false },
        ]}
      />,
    );
    const links = screen.getAllByRole("link", { name: /focus/i });
    expect(links).toHaveLength(2);
    await waitFor(() => expect(links[1]).toHaveFocus());
  });

  it("does not steal focus when a row flips to not-done on its own", async () => {
    // Only an undo THIS component performed earns the hand-off. A step reopened
    // elsewhere — the timer, another tab, a server revalidation — must not yank
    // focus out from under whatever the user is currently doing.
    const done = { ...baseStep(), id: "s1", text: "First", done: true };
    const { rerender } = render(<TaskSteps taskId="t1" steps={[done]} />);
    rerender(<TaskSteps taskId="t1" steps={[{ ...done, done: false }]} />);
    expect(
      screen.getByRole("link", { name: /start focus/i }),
    ).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });
});
