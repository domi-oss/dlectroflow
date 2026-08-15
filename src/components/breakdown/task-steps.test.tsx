// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
  fireEvent,
} from "@testing-library/react";
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
  //
  // #253 — and it now forwards EVERYTHING ELSE too, `className` included, because
  // this double dropped that prop and the hazard its own note describes happened a
  // second time: the ▾ list's restored focus-timer entry is a `Link` carrying
  // `rowMenuEntry()`, and the 44px guard read `className=""` and failed on markup
  // that is correct in the browser. Enumerating props is what makes a double diverge
  // from the thing it stands in for, so it stops enumerating them.
  default: ({
    children,
    href,
    ref,
    ...rest
  }: React.ComponentPropsWithRef<"a"> & { href: string }) => (
    <a href={href} ref={ref} {...rest}>
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
    expect(screen.getAllByRole("button", { name: "Complete" })).toHaveLength(2);
    // Inline Start Focus CTA on each row.
    expect(screen.getAllByText("▶ Start Focus")).toHaveLength(2);
    // 🔽 dropdown trigger on each row.
    expect(screen.getAllByRole("button", { name: "All options" })).toHaveLength(
      2,
    );
    // The old ↗ send-to-review icon is gone.
    expect(screen.queryByTitle("Send to review")).not.toBeInTheDocument();
  });

  // #253 — three entries, not five. "Start focus timer" pointed at the same
  // `/focus/${id}` as the inline ▶ Start Focus and "Complete step" called the same
  // `complete(id)` as the inline Complete, so both were height in a list that is
  // now the only route to what is left. Asserted as an exact set rather than three
  // `getByText` calls: a re-added mirror is the regression, and presence checks
  // cannot see one.
  /**
   * #253 — the ▾ is this STEP's canonical action list, asserted as an exact ordered
   * list because the claim is about sequence and completeness, which presence checks
   * cannot see.
   *
   * `Send back to review` leads as the step-grain "where does this belong" question
   * (`ejectStepToInbox` re-buckets the step into Needs review — it is this row's
   * `Move to…`, not its Delete). Then the two twins of the inline bar, restored
   * because the list is the complete set and the bar a shortcut subset of it. Then
   * the property edit, which takes the tail slot only because a step has nothing
   * destructive to put there.
   *
   * `Edit step title` is asserted ABSENT, and that is a tenth instance of the mirror
   * class #253 has been removing: it fired `setEditEstId(null);
   * setEditTitleId(s.id)`, character-for-character what the ✎ pencil fires, and the
   * pencil's `aria-label` ("Edit First") names the step, so it is strictly clearer.
   * `Edit time estimate` STAYS by the same test applied honestly — the estimate is a
   * plain `<span>`, not a control, so that entry is its only route.
   */
  it("the 🔽 dropdown is the step's canonical actions, in order, and carries no Edit-title mirror", async () => {
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    await openMenu(user);
    const popup = screen.getByRole("dialog", { name: "All options" });
    expect(
      Array.from(popup.querySelectorAll("a, button")).map((b) => b.textContent),
    ).toEqual([
      "Send back to review",
      "Start focus timer",
      "Complete step",
      "Edit time estimate",
    ]);
    expect(
      within(popup).queryByText("Edit step title"),
      "the Edit-title mirror of the ✎ pencil is back",
    ).toBeNull();
    // Four groups' worth of entries in three intent groups → two rules, and they are
    // decoration: no role, so they cannot be announced or counted as entries.
    expect(
      popup.querySelectorAll(":scope > [aria-hidden='true']"),
    ).toHaveLength(2);
  });

  // Every ▾ entry is the sole route to its action now, so each carries the 44px
  // minimum the row controls have always had (`rowMenuEntry`). Height only: a
  // full-width entry is already far past 44px wide.
  it("every 🔽 entry carries the 44px minimum height", async () => {
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    await openMenu(user);
    // `a, button` rather than the button role: the focus-timer entry is a `Link`,
    // and the restored twins are exactly the entries most likely to be given the
    // 44px floor last, since each has an inline sibling that already has it.
    const entries = Array.from(
      screen
        .getByRole("dialog", { name: "All options" })
        .querySelectorAll<HTMLElement>("a, button"),
    );
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect(entry.className, `"${entry.textContent}"`).toContain("min-h-11");
    }
  });

  /**
   * #205's leg on this file, folded in because #253 is what makes it load-bearing.
   *
   * The ✎ pencil was a ~20px convenience (`px-1 text-xs`) while `Edit step title`
   * sat in the ▾ at 44px. This issue removed that entry as a mirror — correctly,
   * the two fired identical calls — which leaves the pencil as the SOLE route to
   * renaming a step, at a fifth of the area of the entry it outlived.
   *
   * That is the line `anchored-popup.ts` draws for itself, applied here: "entries
   * whose sole-route status THIS change creates". The pencil's status was created by
   * this change, so this change sizes it, rather than deferring a control it just
   * promoted.
   *
   * 44x44 is **2.5.5 Target Size (Enhanced), AAA**; **2.5.8 (Minimum) is the AA
   * one, at 24x24**. A house convention, not a conformance fix — see
   * `breakdown/note-field.tsx`, which records having had to undo that inversion.
   *
   * Both dimensions, unlike the ▾-entry test above: that one checks height only
   * because a full-width entry is already far past 44px wide. This is an
   * emoji-only glyph, so width is the dimension it actually fails.
   */
  it("the ✎ pencil carries the 44px minimum, being the only route to a rename now", () => {
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    const pencil = screen.getByRole("button", { name: "Edit First" });
    expect(pencil.className, "the ✎ pencil is under 44px tall").toContain(
      "min-h-11",
    );
    expect(pencil.className, "the ✎ pencil is under 44px wide").toContain(
      "min-w-11",
    );
  });

  it("the sized pencil still opens the title editor for its own step", async () => {
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    await user.click(screen.getByRole("button", { name: "Edit First" }));
    // Pins the behaviour the class change rides on: the pencil's `onClick` clears
    // the estimate editor and opens the title one for THIS step.
    expect(
      screen.getByRole("textbox", { name: "Edit step title" }),
    ).toBeInTheDocument();
  });

  it("uses Resume labels for a resumable step (inline + dropdown)", async () => {
    const user = userEvent.setup();
    render(
      <TaskSteps taskId="t1" steps={[{ ...baseStep(), resumable: true }]} />,
    );
    expect(screen.getByText("▶ Resume Focus")).toBeInTheDocument();
    expect(screen.queryByText("▶ Start Focus")).not.toBeInTheDocument();
    // #253 — BOTH halves again, and the resumable variant has to reach both: the
    // dropdown twin is restored, and it takes its label from the same `s.resumable`
    // the inline CTA does. A pass that wired the entry to the Start label on a
    // resumable step would be invisible without this.
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
      screen.queryByRole("button", { name: "Complete" }),
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
      screen.queryByRole("button", { name: "Complete" }),
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

    await user.click(screen.getByRole("button", { name: "Complete" }));

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
    await user.click(screen.getAllByRole("button", { name: "Complete" })[0]);
    expect(completeStep).toHaveBeenCalledWith("s1");
  });

  // #253 replaced the dropdown mirror with the inline control it duplicated. The
  // behaviour under test — a press reaches `completeStep` with this step's id —
  // is kept and re-pointed rather than deleted, because that is the assertion, not
  // the button it was made through.
  it("the inline Complete button calls completeStep", async () => {
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    await user.click(screen.getByRole("button", { name: "Complete" }));
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
  // #253 — reached through the ✎ pencil, which is the row's only edit route now
  // that the ▾ mirror of it is gone. The behaviour under test (renameStep on Enter)
  // is unchanged; only the way in is.
  it("Edit step title saves the new text via renameStep", async () => {
    const user = userEvent.setup();
    render(<TaskSteps taskId="t1" steps={[steps()[0]]} />);
    await user.click(screen.getByRole("button", { name: "Edit First" }));
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
    await user.click(screen.getByRole("button", { name: "Edit First" }));
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
    const complete = screen.getByRole("button", { name: "Complete" });
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
      screen.getByRole("button", { name: "Complete" }).closest("li"),
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

describe("TaskSteps — focus survives a FAILED un-complete and its retry (#215)", () => {
  // #215, the residual half of the defect `!286` fixed the other half of. Round 15
  // swapped both undo controls to `aria-disabled`, which fixes the case where the
  // pressed element is merely held. The Retry has a second, independent route to
  // the same outcome: pressing it clears this row from `undoFailedIds`, which
  // unmounts the `role="alert"` it lives inside, so the button is destroyed and no
  // attribute choice can keep focus on it. WCAG 2.4.3.
  //
  // The decision recorded here and in the component: focus MOVES to the row's own
  // undo control rather than the notice being kept mounted. See the note beside
  // the round-14 clear-on-the-way-in in `task-steps.tsx`.
  it("hands focus to the row's own undo when Retry withdraws the notice", async () => {
    const user = userEvent.setup();
    vi.mocked(uncompleteStep)
      .mockRejectedValueOnce(new Error("db down"))
      // The retry hangs, so the in-flight state is observable rather than racing
      // a resolution. `…Once`, so nothing leaks into the next spec.
      .mockImplementationOnce(() => new Promise<void>(() => {}));
    render(
      <TaskSteps
        taskId="t1"
        steps={[{ ...baseStep(), id: "s1", text: "First", done: true }]}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /mark not done: first/i }),
    );
    const retry = await screen.findByRole("button", { name: /try again/i });
    // A keyboard user reaches Retry by tabbing to it; the bug is in what happens
    // to that focus, so the press has to be a keyboard press from that element.
    retry.focus();
    expect(retry).toHaveFocus();
    await user.keyboard("{Enter}");

    // The negative control. Without this, "the undo has focus" could be true
    // vacuously — it proves the pressed element really was destroyed, so focus
    // can only be where it is because something moved it.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /try again/i }),
      ).not.toBeInTheDocument(),
    );
    expect(retry).not.toBeInTheDocument();
    expect(document.body).not.toHaveFocus();

    // Not <body>, and not just "something": the row's own undo, which stays
    // mounted throughout, is the same action, and — being `aria-disabled` with
    // `aria-busy` and a spoken reason — announces the wait to whoever is on it.
    const undo = screen.getByRole("button", { name: /mark not done: first/i });
    expect(undo).toHaveFocus();
    expect(undo).toHaveAttribute("aria-disabled", "true");
    expect(undo).toHaveAccessibleName(/already in progress for this row/i);
  });

  it("hands off to the retried row's undo, not to the first row's", async () => {
    // The hand-off is keyed, like every other per-row record in this file. A
    // single unkeyed target would pass the spec above and still land a two-row
    // list's correction on the wrong row.
    const user = userEvent.setup();
    vi.mocked(uncompleteStep)
      .mockRejectedValueOnce(new Error("db down"))
      .mockImplementationOnce(() => new Promise<void>(() => {}));
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
      screen.getByRole("button", { name: /mark not done: second/i }),
    );
    const retry = await screen.findByRole("button", { name: /try again/i });
    retry.focus();
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /mark not done: second/i }),
      ).toHaveFocus(),
    );
    expect(
      screen.getByRole("button", { name: /mark not done: first/i }),
    ).not.toHaveFocus();
  });

  it("leaves focus on the row's undo when the first attempt fails", async () => {
    // The other failure path #215 asks to be checked against the same reasoning.
    // This one needs no hand-off and must not get one: the control that was
    // pressed is `aria-disabled`, never unmounted, so focus stays put on its own
    // and the `role="alert"` announces without moving anybody. Pinned so a future
    // hand-off cannot start yanking focus off it.
    const user = userEvent.setup();
    vi.mocked(uncompleteStep).mockRejectedValueOnce(new Error("db down"));
    render(
      <TaskSteps
        taskId="t1"
        steps={[{ ...baseStep(), id: "s1", text: "First", done: true }]}
      />,
    );

    const undo = screen.getByRole("button", { name: /mark not done: first/i });
    undo.focus();
    await user.keyboard("{Enter}");

    await screen.findByRole("alert");
    expect(undo).toBeInTheDocument();
    expect(undo).toHaveFocus();
    expect(document.body).not.toHaveFocus();
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
    expect(screen.getByRole("button", { name: "Complete" })).not.toHaveFocus();
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
    //
    // #237 re-decided ONE line of this spec, and it is worth saying which and why
    // rather than leaving it to a blame trawl. It used to leave focus on s2's undo
    // across both releases and still assert that s1's Start Focus took focus — so
    // it pinned a hand-off firing onto a row the user was NOT standing on, which is
    // the defect #237 is about. What round 15 actually needs to observe is that the
    // two ARMS do not clobber each other, and arming is what the `.focus()` calls
    // below preserve: both writes are still in flight together, and each resolves
    // while its own row's undo holds focus.
    //
    // Reachable, not a contrivance: both undos are `aria-disabled` rather than
    // `disabled` (round 15, so a busy control can still hold focus), so a keyboard
    // user who presses s1's undo, presses s2's, then Shift+Tabs back to s1 while
    // both are still out is exactly this.
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

    const undo1 = screen.getByRole("button", {
      name: /mark not done: first/i,
    });
    const undo2 = screen.getByRole("button", {
      name: /mark not done: second/i,
    });
    await user.click(undo1);
    await user.click(undo2);
    expect(uncompleteStep).toHaveBeenCalledTimes(2);

    // Both are out before either resolves, which is what makes the two arms
    // simultaneous and reproduces the single-slot clobber. Focus rides with the row
    // whose write is landing, so each arm is legitimately entitled to its hand-off
    // under #237's gate — the property under test is that the second arming does
    // not erase the first.
    // Awaited between the two releases, not fired back to back: the gate reads
    // `document.activeElement` in the continuation after the write's `await`, so
    // both continuations would otherwise run as microtasks AFTER both `.focus()`
    // calls and both would read s2's undo. That is a property of this spec's
    // instrumentation, not of the component.
    undo1.focus();
    releases[0]();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    undo2.focus();
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

describe("TaskSteps — a hand-off only fires when the press held focus (#237)", () => {
  // #237. The two describes above pin WHERE focus goes when a control the user is
  // standing on is destroyed. Neither pinned the prior question, and both
  // hand-offs armed without asking it: 2.4.3 is about focus that is destroyed, it
  // does not license taking focus off something else, and doing that is 3.2.2's
  // harm instead.
  //
  // Why the press cannot be trusted to have held focus — re-measured in Playwright
  // against both engines rather than inherited:
  //
  //   gesture                                    WebKit    Chromium
  //   click a <button>, nothing focused          BODY      BUTTON
  //   click a <button> while typing in a field   BODY      BUTTON
  //   Enter on a focused <button>                BUTTON    BUTTON
  //
  // So on WebKit — Safari, and every browser on iOS — a mouse or touch press never
  // holds focus, which makes the unguarded arm the ORDINARY mouse case there
  // rather than an edge. Assistive-technology activation is the second route: it
  // fires a click without moving DOM focus on every engine.
  //
  // This list is where that becomes reachable, and the reason is structural: the
  // failed-undo notice renders per row, inside the same `steps.map()` as the two
  // `autoFocus` inline editors, so the control that unmounts and the field the user
  // is typing in are siblings.
  //
  // `focus-timer.tsx` is deliberately left unguarded, but NOT for the reason #237's
  // table gives — "nowhere else focus could be" is wrong, and this comment said so
  // in its first draft. It has the re-estimate minutes field at `:2092`, in the same
  // phase block as the failure notice whose hand-off is unarmed. What stands in for
  // a guard there is `showEstimateField` (`:1209`) unmounting that field across any
  // in-flight window that has not yet failed. See the correction on #237 for the one
  // path where that does not hold.
  //
  // Same guard, same shape and same reason as `breakdown-chat.tsx`'s "leaves focus
  // where it was when the press did not come from it" and `inbox-view.tsx`'s
  // `retryCtaRef.current === document.activeElement`. Following the in-tree
  // pattern is the point — four components had grown this machinery and two had
  // the guard.
  //
  // `fireEvent.click` rather than `user.click` for the press under test:
  // userEvent focuses the element first, which is the very thing being guarded, so
  // it would make the unguarded code pass. fireEvent dispatches the press without
  // moving focus, which is what WebKit does.

  /** Row 1 not done, so it carries the ✎ pencil and its `autoFocus` editor; row 2
   *  done, so it can carry the failed undo and the Retry inside its notice. The
   *  two live in one `<ol>`, which is the whole hazard. */
  const mixedRows = () => [
    { ...baseStep(), id: "s1", text: "First", done: false },
    { ...baseStep(), id: "s2", order: 2, text: "Second", done: true },
  ];

  it("leaves focus in another row's editor when the Retry press never held it", async () => {
    const user = userEvent.setup();
    vi.mocked(uncompleteStep)
      .mockRejectedValueOnce(new Error("db down"))
      // The retry hangs, so the state after the press is observable rather than
      // racing a resolution — the shape the #215 specs above use.
      .mockImplementationOnce(() => new Promise<void>(() => {}));
    render(<TaskSteps taskId="t1" steps={mixedRows()} />);

    await user.click(
      screen.getByRole("button", { name: /mark not done: second/i }),
    );
    const retry = await screen.findByRole("button", { name: /try again/i });

    // The user is mid-word in the OTHER row's title editor.
    await user.click(screen.getByRole("button", { name: "Edit First" }));
    const field = screen.getByLabelText("Edit step title");
    await user.clear(field);
    await user.type(field, "half a wor");
    expect(field).toHaveFocus();

    fireEvent.click(retry);

    // The press is still honoured — the retry runs and its notice still
    // withdraws. Only the focus move is suppressed, so this is not the guard
    // passing vacuously by refusing the press.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /try again/i }),
      ).not.toBeInTheDocument(),
    );
    expect(uncompleteStep).toHaveBeenCalledTimes(2);

    expect(field).toHaveFocus();
    // The words survive too. On WebKit the click blurs the field but keeps its
    // value (measured above), so a hand-off that fires anyway costs the user the
    // caret in text they are still holding, not the text itself.
    expect(field).toHaveValue("half a wor");
    expect(
      screen.getByRole("button", { name: /mark not done: second/i }),
    ).not.toHaveFocus();
  });

  it("leaves focus in another row's editor when the undo's press never held it", async () => {
    // The same defect on the OTHER hand-off — the successful-undo one — reached
    // the same way, and this is the arm whose window is widest: it opens when the
    // write resolves and closes only when `router.refresh()` comes back. So it
    // does not need WebKit to fire on the wrong element; a user who opened another
    // row's inline editor while the undo was in flight is enough, on any engine.
    // Both arms sit in `uncomplete`'s two routes in, so guarding one and not the
    // other would leave the file inconsistent with itself — which is what #237 is
    // about.
    const user = userEvent.setup();
    let release!: () => void;
    vi.mocked(uncompleteStep).mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          release = res;
        }),
    );
    const rows = mixedRows();
    const { rerender } = render(<TaskSteps taskId="t1" steps={rows} />);

    const pencil = screen.getByRole("button", { name: "Edit First" });
    pencil.focus();
    fireEvent.click(
      screen.getByRole("button", { name: /mark not done: second/i }),
    );

    // Mid-flight, the user opens the other row's title editor — an ordinary thing
    // to do while a write is out, and it is where focus is when the refresh lands.
    await user.click(pencil);
    const field = screen.getByLabelText("Edit step title");
    expect(field).toHaveFocus();

    release();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // What the refresh does in production: the server re-renders row 2 as
    // not-done, unmounting the undo that was pressed.
    rerender(
      <TaskSteps taskId="t1" steps={[rows[0], { ...rows[1], done: false }]} />,
    );

    const links = screen.getAllByRole("link", { name: /focus/i });
    expect(links).toHaveLength(2);
    expect(links[1]).not.toHaveFocus();
    expect(field).toHaveFocus();
  });

  it("still hands off when the press DID hold focus, on both arms", async () => {
    // The control for the two specs above. Without it "focus did not move" could
    // be true because the guard disabled the feature outright, and #206/#215 both
    // exist because focus dropping to <body> here is a real defect.
    const user = userEvent.setup();
    vi.mocked(uncompleteStep)
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(undefined);
    const rows = mixedRows();
    const { rerender } = render(<TaskSteps taskId="t1" steps={rows} />);

    await user.click(
      screen.getByRole("button", { name: /mark not done: second/i }),
    );
    const retry = await screen.findByRole("button", { name: /try again/i });
    retry.focus();
    await user.keyboard("{Enter}");

    // Arm one: the Retry unmounted under a user who was standing on it, so focus
    // lands on the row's own undo.
    const undo = await screen.findByRole("button", {
      name: /mark not done: second/i,
    });
    await waitFor(() => expect(undo).toHaveFocus());

    // Arm two: that undo is where focus now is, so when the refresh unmounts it
    // the reopened row's Start Focus receives the hand-off.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    rerender(
      <TaskSteps taskId="t1" steps={[rows[0], { ...rows[1], done: false }]} />,
    );
    const links = screen.getAllByRole("link", { name: /focus/i });
    expect(links).toHaveLength(2);
    await waitFor(() => expect(links[1]).toHaveFocus());
  });
});
