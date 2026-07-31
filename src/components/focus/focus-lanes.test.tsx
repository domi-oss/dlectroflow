// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SingleTaskLane, MultiStepLane } from "@/components/focus/focus-lanes";
import type { FocusableStep, SingleFocusable } from "@/lib/focus-launcher";

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

const multi = (
  o: Partial<FocusableStep> & { stepId: string },
): FocusableStep => ({
  stepText: o.stepId,
  subtaskEmoji: null,
  estMinutes: 15,
  taskId: "task-" + o.stepId,
  taskTitle: "Task " + o.stepId,
  resumable: false,
  resumeAt: null,
  remainingMin: o.estMinutes ?? 15,
  stepIndex: 1,
  stepsDone: 0,
  stepsTotal: 2,
  nextStepText: null,
  nextStepEmoji: null,
  ...o,
});

const single = (
  o: Partial<SingleFocusable> & { itemId: string },
): SingleFocusable => ({
  text: o.itemId,
  estMinutes: 8,
  ...o,
});

/**
 * The number in this lane's SubHeader count badge, read off the DOM.
 *
 * #136 is a disagreement between that badge and the rows beside it, so every
 * assertion about it has to come from the rendered header rather than from the
 * props that went in.
 *
 * Scoped by the lane's named landmark rather than by walking up from the label
 * text (!226 review): `getByText(label).parentElement` would have assumed the
 * label is a direct child of SubHeader's root, and would break the moment
 * SubHeader — a component shared with the whole inbox — gained a wrapper. The
 * region is the lane's own contract. The count is the only pure-digit node in a
 * lane: a row's estimate renders "8m" and its progress renders "1/3".
 */
function laneCount(label: string): number {
  const lane = screen.getByRole("region", { name: label });
  return Number(within(lane).getByText(/^\d+$/).textContent);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("SingleTaskLane", () => {
  it("▶ Start ensures the focus step then routes to the timer", async () => {
    const user = userEvent.setup();
    render(
      <SingleTaskLane
        voice="plain"
        items={[{ itemId: "i1", text: "Buy milk", estMinutes: 8 }]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /start/i }));
    expect(ensureFocusStep).toHaveBeenCalledWith("i1");
    expect(push).toHaveBeenCalledWith("/focus/step-77");
  });

  it("inline ✓ optimistically removes the row, completeItem + refresh", async () => {
    const user = userEvent.setup();
    render(
      <SingleTaskLane
        voice="plain"
        items={[{ itemId: "i1", text: "Buy milk", estMinutes: 8 }]}
      />,
    );
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
        items={[
          multi({
            stepId: "m1",
            stepText: "Draft intro",
            taskTitle: "Report",
            stepsDone: 1,
            stepsTotal: 3,
            estMinutes: 20,
          }),
        ]}
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
    render(
      <MultiStepLane
        voice="plain"
        items={[multi({ stepId: "m1", stepText: "Draft intro" })]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /complete/i }));
    expect(screen.queryByText(/Draft intro/)).not.toBeInTheDocument();
    expect(completeStep).toHaveBeenCalledWith("m1");
    expect(refresh).toHaveBeenCalled();
  });
});

/**
 * #136 — the lane's own header and zero-state.
 *
 * Both used to live in the launcher shell (a Server Component) while the rows
 * lived here, which is precisely the bug: the badge counted the SERVER's rows
 * and the list rendered the OPTIMISTICALLY FILTERED ones, so completing the last
 * row left "1" beside a bare empty `<ul>` until `router.refresh()` landed.
 *
 * Every test below therefore exercises the OPTIMISTIC WINDOW — the state after a
 * ✓ click and before any new server props arrive (`router.refresh` is a mock, so
 * the filtered state is all there is). A test written against post-refresh props
 * would simply hand the lane `items={[]}` and pass against the bug.
 */
describe("focus lanes — header, count and zero-state (#136)", () => {
  it("renders the lane's own SubHeader label, count and see-all deep link", () => {
    render(<SingleTaskLane voice="plain" items={[single({ itemId: "i1" })]} />);
    expect(screen.getByText("Single-task to-dos")).toBeInTheDocument();
    expect(laneCount("Single-task to-dos")).toBe(1);
    expect(screen.getByRole("link", { name: /see all/i })).toHaveAttribute(
      "href",
      "/library?tab=plated",
    );
  });

  // a11y (WCAG 1.3.1) — each lane is a NAMED landmark, so a screen-reader user
  // moving between them can tell single-task rows from multi-step ones. It also
  // gives the count badge a stable home to be read from (!226 review): the
  // helper above scopes by this region rather than guessing at SubHeader's
  // internal structure.
  it("each lane is a named region, so the two are distinguishable", () => {
    render(<SingleTaskLane voice="plain" items={[single({ itemId: "i1" })]} />);
    render(<MultiStepLane voice="plain" items={[multi({ stepId: "m1" })]} />);
    expect(
      screen.getByRole("region", { name: "Single-task to-dos" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Multi-step to-dos" }),
    ).toBeInTheDocument();
  });

  it("the multi-step lane carries its own label and see-all deep link", () => {
    render(<MultiStepLane voice="plain" items={[multi({ stepId: "m1" })]} />);
    expect(screen.getByText("Multi-step to-dos")).toBeInTheDocument();
    expect(laneCount("Multi-step to-dos")).toBe(1);
    expect(screen.getByRole("link", { name: /see all/i })).toHaveAttribute(
      "href",
      "/library?tab=sorted",
    );
  });

  // THE bug. Not "the count is wrong" and not "the list is empty" — the two
  // together, which is what makes a blank box read as data loss.
  it("completing the LAST single-task row shows the cleared state, not an empty list", async () => {
    const user = userEvent.setup();
    render(<SingleTaskLane voice="plain" items={[single({ itemId: "i1" })]} />);
    await user.click(screen.getByRole("button", { name: /complete/i }));

    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByText(/Cleared/)).toBeInTheDocument();
    expect(laneCount("Single-task to-dos")).toBe(0);
  });

  it("completing the LAST multi-step row shows the cleared state, not an empty list", async () => {
    const user = userEvent.setup();
    render(<MultiStepLane voice="plain" items={[multi({ stepId: "m1" })]} />);
    await user.click(screen.getByRole("button", { name: /complete/i }));

    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByText(/Cleared/)).toBeInTheDocument();
    expect(laneCount("Multi-step to-dos")).toBe(0);
  });

  // The shared-source requirement, asserted as an invariant rather than as a
  // pair of expected numbers: whatever the badge says, that many rows are on
  // screen. This is the test that fails if a future refactor reintroduces a
  // `count` prop fed from anywhere but the rendered collection.
  it("the badge count always equals the rows actually rendered", async () => {
    const user = userEvent.setup();
    render(
      <SingleTaskLane
        voice="plain"
        items={[
          single({ itemId: "i1", text: "One" }),
          single({ itemId: "i2", text: "Two" }),
          single({ itemId: "i3", text: "Three" }),
        ]}
      />,
    );
    const agree = () =>
      expect(laneCount("Single-task to-dos")).toBe(
        screen.queryAllByRole("listitem").length,
      );

    agree();
    for (const text of ["One", "Two"]) {
      const row = screen.getByText(text).closest("li");
      await user.click(
        within(row as HTMLElement).getByRole("button", { name: /complete/i }),
      );
      agree();
    }
    expect(laneCount("Single-task to-dos")).toBe(1);
  });

  // The new-vs-emptied distinction /focus already draws with `clearedToday`. A
  // lane the server handed nothing is "Nothing here yet"; a lane the user just
  // emptied is a small celebration. Getting these the same way round is the
  // whole point of the third checkbox on #136.
  it("a lane the server handed nothing keeps the neutral 'Nothing here yet'", () => {
    render(<SingleTaskLane voice="plain" items={[]} />);
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.queryByText(/Cleared/)).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  // The acknowledgement has to OUTLIVE the optimistic window, not merely fill
  // it. `router.refresh()` lands a moment later with the row legitimately gone
  // from the server's props, and deciding on `items.length` alone would swap the
  // celebration for "Nothing here yet" a few hundred milliseconds after the user
  // earned it — the wrong half of #136's own distinction, since a lane the user
  // emptied is still an emptied lane once the server agrees.
  it("still reads as cleared after the server props catch up", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <SingleTaskLane voice="plain" items={[single({ itemId: "i1" })]} />,
    );
    await user.click(screen.getByRole("button", { name: /complete/i }));
    // What router.refresh() eventually delivers: the row really is gone now.
    rerender(<SingleTaskLane voice="plain" items={[]} />);

    expect(screen.getByText(/Cleared/)).toBeInTheDocument();
    expect(screen.queryByText("Nothing here yet")).not.toBeInTheDocument();
  });

  // …and it is NOT a live region: nothing happened, the text was there on first
  // paint, and announcing it would be announcing the absence of an event.
  it("the never-had-anything empty state is not announced as a status", () => {
    render(<SingleTaskLane voice="plain" items={[]} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // a11y — the list content changing out from under the user IS the event, so
  // the notice that replaces it is a polite live region (role="status", the same
  // conditional-mount pattern as the capture confirmation and the focus-timer
  // retry notice), never an alert: nothing has gone wrong.
  it("announces the cleared state politely (role=status, not alert)", async () => {
    const user = userEvent.setup();
    render(<SingleTaskLane voice="plain" items={[single({ itemId: "i1" })]} />);
    await user.click(screen.getByRole("button", { name: /complete/i }));

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent(/Cleared/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // a11y (WCAG 2.4.3) — the ✓ that was just pressed unmounts with its row. The
  // repo's rule for that (#65/#66/#137 in focus-timer.tsx) is that focus must go
  // somewhere sensible rather than to <body>; here the only sensible place is
  // the notice itself, which doubles as the announcement so the two cannot cut
  // each other short.
  it("hands focus to the cleared notice instead of dropping it to <body>", async () => {
    const user = userEvent.setup();
    render(<SingleTaskLane voice="plain" items={[single({ itemId: "i1" })]} />);
    await user.click(screen.getByRole("button", { name: /complete/i }));

    const notice = screen.getByRole("status");
    expect(notice).toHaveAttribute("tabindex", "-1");
    expect(document.activeElement).toBe(notice);
  });

  // Emptying a lane that still has rows left is not a cleared lane, so nothing
  // is announced and focus stays where the user put it.
  it("says nothing when rows remain after a complete", async () => {
    const user = userEvent.setup();
    render(
      <SingleTaskLane
        voice="plain"
        items={[
          single({ itemId: "i1", text: "One" }),
          single({ itemId: "i2", text: "Two" }),
        ]}
      />,
    );
    const row = screen.getByText("One").closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: /complete/i }));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("list")).toBeInTheDocument();
  });

  it("is voice-aware — playful gets the playful celebration", async () => {
    const user = userEvent.setup();
    render(<MultiStepLane voice="playful" items={[multi({ stepId: "m1" })]} />);
    await user.click(screen.getByRole("button", { name: /complete/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/Plate cleared/);
  });

  // Colour is never the only cue and the notice must stay a plain readable
  // paragraph: same element and same border tokens as the neutral string it
  // stands in for, so the zero-tolerance colour-contrast gate (#90/#99) sees no
  // new pairing. It drops `text-muted-foreground` for the same reason the
  // page-level all-clear card does — a celebration is read at full contrast.
  it("reuses the neutral empty-state paragraph's element and tokens", async () => {
    const user = userEvent.setup();
    render(<SingleTaskLane voice="plain" items={[single({ itemId: "i1" })]} />);
    const neutral = render(
      <SingleTaskLane voice="plain" items={[]} />,
    ).container.querySelector("p") as HTMLElement;
    await user.click(screen.getByRole("button", { name: /complete/i }));

    const notice = screen.getByRole("status");
    expect(notice.tagName).toBe("P");
    expect(notice.className).toContain("border-dashed");
    expect(neutral.className).toContain("text-muted-foreground");
    expect(notice.className).not.toContain("text-muted-foreground");
  });
});
