// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InboxView, dragEndToMove } from "@/components/inbox/inbox-view";
import type { Item } from "@/components/inbox/bucket";
import type { AgingSettings } from "@/lib/aging";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock("@/app/actions/braindump", () => ({
  createBrainDumpItem: vi.fn().mockResolvedValue(undefined),
  triageBrainDumpItem: vi.fn().mockResolvedValue(undefined),
  snoozeBrainDumpItem: vi.fn().mockResolvedValue(undefined),
  deleteBrainDumpItem: vi.fn().mockResolvedValue(undefined),
  keepAsTask: vi.fn().mockResolvedValue(undefined),
  markReminded: vi.fn().mockResolvedValue(undefined),
  freshenItem: vi.fn().mockResolvedValue(undefined),
  dismissPrompt: vi.fn().mockResolvedValue(undefined),
  completeItem: vi.fn().mockResolvedValue(undefined),
  reopenItem: vi.fn().mockResolvedValue(undefined),
  moveToReview: vi.fn().mockResolvedValue(undefined),
  requestBreakdown: vi.fn().mockResolvedValue(undefined),
  ensureFocusStep: vi.fn().mockResolvedValue(null),
  renameItem: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/app/actions/breakdown", () => ({
  startBreakdown: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/app/actions/google-schedule", () => ({
  pushStepsToGoogleTasks: vi.fn().mockResolvedValue({ ok: true, scheduled: 1, listTitle: "Reclaim" }),
  scheduleSingleTask: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/notifications", () => ({
  notificationPermission: () => "default",
  subscribeNotificationPermission: () => () => {},
  requestNotificationPermission: vi.fn().mockResolvedValue("default"),
  registerServiceWorker: vi.fn().mockResolvedValue(null),
  showReminder: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/components/breakdown/task-steps", () => ({
  TaskSteps: ({ steps }: { steps: { id: string; text: string }[] }) => (
    <ol data-testid="inline-steps">{steps.map((s) => <li key={s.id}>{s.text}</li>)}</ol>
  ),
}));

// Passthrough spy on the shared move dispatcher: dropPlan keeps its REAL
// behavior, but its calls become observable — so tests can assert an action
// was routed through moveItemToBucket (e.g. the review row's "Save for
// later" = a direct move to the Saved bucket) versus a direct server-action
// call that bypasses the dispatcher (e.g. "Snooze 1h").
vi.mock("@/components/inbox/move-dispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/inbox/move-dispatch")>();
  return { ...actual, dropPlan: vi.fn(actual.dropPlan) };
});

import {
  createBrainDumpItem,
  deleteBrainDumpItem,
  dismissPrompt,
  freshenItem,
} from "@/app/actions/braindump";
import { dropPlan } from "@/components/inbox/move-dispatch";

const settings: AgingSettings = {
  agingThresholdMinutes: 30,
  demoOverrideSeconds: null,
  agingHours: 24,
  overdueHours: 48,
  wayOverdueHours: 72,
};

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "item-1",
    text: "sample item",
    createdAt: new Date(),
    status: "inbox",
    triagedAt: null,
    remindedAt: null,
    snoozedUntil: null,
    taskId: null,
    freshenedAt: null,
    promptDismissedAt: null,
    breakdownRequestedAt: null,
    stepsTotal: 0,
    stepsDone: 0,
    taskStatus: null,
    completedAt: null,
    steps: [],
    ...overrides,
  };
}

function makeMultiStep() {
  return makeItem({
    id: "m1",
    text: "plan trip",
    status: "triaged",
    taskId: "t1",
    stepsTotal: 3,
    stepsDone: 1,
    steps: [
      { id: "s1", order: 1, text: "book", done: true, estMinutes: 10, subtaskEmoji: null },
      { id: "s2", order: 2, text: "pack", done: false, estMinutes: 20, subtaskEmoji: null },
      { id: "s3", order: 3, text: "go", done: false, estMinutes: 5, subtaskEmoji: null },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("InboxView — capture confirm", () => {
  it("shows a transient 'captured ✓' indicator after submitting the capture form", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[]}
        settings={settings}
      />,
    );
    const input = screen.getByPlaceholderText(/Brain dump/i);
    await user.type(input, "buy milk{enter}");

    expect(await screen.findByText("captured ✓")).toBeInTheDocument();
    expect(createBrainDumpItem).toHaveBeenCalledWith("buy milk");
  });

  it("clears the captured indicator after ~1.5s", async () => {
    vi.useFakeTimers();
    render(
      <InboxView
        initialItems={[]}
        settings={settings}
      />,
    );
    const input = screen.getByPlaceholderText(/Brain dump/i);

    fireEvent.change(input, { target: { value: "buy milk" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Flush the microtask queue driving the startTransition/async action.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("captured ✓")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1600);
    });

    expect(screen.queryByText("captured ✓")).not.toBeInTheDocument();
  });
});

describe("InboxView — inline delete confirm", () => {
  it("requires a confirm click before calling deleteBrainDumpItem; cancel does not delete", async () => {
    const user = userEvent.setup();
    const item = makeItem({ id: "abc", text: "delete me" });
    render(
      <InboxView
        initialItems={[item]}
        settings={settings}
      />,
    );
    // v5: Delete lives inline in the row's end cluster (no menu needed).
    const row = screen.getByText("delete me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    expect(within(row).getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    // Cancel dismisses the confirm without deleting.
    await user.click(within(row).getByRole("button", { name: "Cancel" }));
    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    expect(within(row).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();

    // Click delete again, then confirm.
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await user.click(within(row).getByRole("button", { name: "Delete" }));

    expect(deleteBrainDumpItem).toHaveBeenCalledWith("abc");
  });
});

describe("InboxView — 24h still-needed prompt", () => {
  it("renders the inline prompt for an item past the 24h boundary and wires Dismiss to dismissPrompt", async () => {
    const user = userEvent.setup();
    const stale = makeItem({
      id: "stale-1",
      text: "old thing",
      createdAt: new Date(Date.now() - 25 * 3600_000),
    });
    render(
      <InboxView
        initialItems={[stale]}
        settings={settings}
      />,
    );

    expect(
      screen.getByText("This has been sitting a while — still needed?"),
    ).toBeInTheDocument();

    const row = screen.getByText("old thing").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Dismiss" }));
    expect(dismissPrompt).toHaveBeenCalledWith("stale-1");
  });

  it("wires 'Still need it' to freshenItem, resetting the freshness clock", async () => {
    const user = userEvent.setup();
    const stale = makeItem({
      id: "stale-3",
      text: "keep this",
      createdAt: new Date(Date.now() - 25 * 3600_000),
    });
    render(<InboxView initialItems={[stale]} settings={settings} />);

    const row = screen.getByText("keep this").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Still need it" }));
    expect(freshenItem).toHaveBeenCalledWith("stale-3");
    expect(dismissPrompt).not.toHaveBeenCalled();
  });

  it("does not render the prompt when promptDismissedAt is already set", () => {
    const stale = makeItem({
      id: "stale-2",
      text: "old thing",
      createdAt: new Date(Date.now() - 25 * 3600_000),
      promptDismissedAt: new Date(),
    });
    render(
      <InboxView
        initialItems={[stale]}
        settings={settings}
      />,
    );

    expect(
      screen.queryByText("This has been sitting a while — still needed?"),
    ).not.toBeInTheDocument();
  });
});

describe("InboxView — inbox zero copy", () => {
  it("renders the voice-aware inbox.zero string with no items", () => {
    render(
      <InboxView
        initialItems={[]}
        settings={settings}
      />,
    );
    expect(screen.getByText("Inbox zero. Nothing to review.")).toBeInTheDocument();
  });
});

describe("InboxView — settings panel moved to /settings", () => {
  it("no longer renders the aging & reminder settings panel on the inbox", () => {
    render(
      <InboxView
        initialItems={[makeItem()]}
        settings={settings}
      />,
    );
    // The aging/reminder settings now live on the /settings page (☰ menu),
    // not inline on the inbox.
    expect(
      screen.queryByText(/Aging & reminder settings/i),
    ).not.toBeInTheDocument();
  });
});

describe("InboxView — complete + completed bucket", () => {
  it("a needs-review row's Complete button (v5: inline) calls completeItem", async () => {
    const { completeItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "n1", text: "do it" })]} settings={settings} />);
    const row = screen.getByText("do it").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Complete" }));
    expect(completeItem).toHaveBeenCalledWith("n1");
  });

  it("a single-task row's Complete button (v5: inline) calls completeItem", async () => {
    const { completeItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "st1", text: "single todo", status: "triaged" })]}
        settings={settings}
      />,
    );
    const row = screen.getByText("single todo").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Complete" }));
    expect(completeItem).toHaveBeenCalledWith("st1");
  });

  it("a multi-step row's Complete button calls completeItem", async () => {
    const { completeItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeMultiStep()]} settings={settings} />);
    const row = screen.getByText("plan trip").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Complete" }));
    expect(completeItem).toHaveBeenCalledWith("m1");
  });

  it("renders the Completed section with a today count and Undo", async () => {
    const { reopenItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    const done = makeItem({ id: "d1", text: "finished", status: "triaged", completedAt: new Date() });
    render(<InboxView initialItems={[done]} settings={settings} />);
    expect(screen.getByText(/Completed today/i)).toBeInTheDocument();
    const row = screen.getByText("finished").closest("li")!;
    await user.click(within(row).getByRole("button", { name: /Reopen|Undo/ }));
    expect(reopenItem).toHaveBeenCalledWith("d1", undefined);
  });
});

describe("InboxView — per-step Undo picker (completed multi-step)", () => {
  const doneMulti = () =>
    makeItem({
      id: "dm1",
      text: "finished trip",
      status: "triaged",
      taskId: "t1",
      completedAt: new Date(),
      stepsTotal: 3,
      stepsDone: 3,
      taskStatus: "done",
      steps: [
        { id: "s1", order: 1, text: "book", done: true, estMinutes: 10, subtaskEmoji: null },
        // Emoji on purpose: it must stay decorative (aria-hidden), so the
        // checkbox's accessible name is still exactly "pack".
        { id: "s2", order: 2, text: "pack", done: true, estMinutes: 20, subtaskEmoji: "🧳" },
        { id: "s3", order: 3, text: "go", done: true, estMinutes: 5, subtaskEmoji: null },
      ],
    });

  it("Reopen on a completed multi-step opens the step picker instead of reopening", async () => {
    const { reopenItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[doneMulti()]} settings={settings} />);
    const row = screen.getByText("finished trip").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Reopen" }));
    expect(reopenItem).not.toHaveBeenCalled();
    expect(within(row).getByText("Which steps still need doing?")).toBeInTheDocument();
    expect(within(row).getByRole("checkbox", { name: "pack" })).toBeInTheDocument();
  });

  it("reopens only the checked steps", async () => {
    const { reopenItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[doneMulti()]} settings={settings} />);
    const row = screen.getByText("finished trip").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Reopen" }));
    await user.click(within(row).getByRole("checkbox", { name: "pack" }));
    await user.click(within(row).getByRole("button", { name: "Reopen selected" }));
    expect(reopenItem).toHaveBeenCalledWith("dm1", ["s2"]);
  });

  it("confirm is disabled with nothing checked; Reopen all resets every step", async () => {
    const { reopenItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[doneMulti()]} settings={settings} />);
    const row = screen.getByText("finished trip").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Reopen" }));
    expect(within(row).getByRole("button", { name: "Reopen selected" })).toBeDisabled();
    await user.click(within(row).getByRole("button", { name: "Reopen all" }));
    expect(reopenItem).toHaveBeenCalledWith("dm1", undefined);
  });

  it("Cancel closes the picker without reopening", async () => {
    const { reopenItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[doneMulti()]} settings={settings} />);
    const row = screen.getByText("finished trip").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Reopen" }));
    await user.click(within(row).getByRole("button", { name: "Cancel" }));
    expect(reopenItem).not.toHaveBeenCalled();
    expect(within(row).queryByText("Which steps still need doing?")).not.toBeInTheDocument();
  });

  it("Escape closes the picker without reopening (matches MoveToMenu)", async () => {
    const { reopenItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[doneMulti()]} settings={settings} />);
    const row = screen.getByText("finished trip").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Reopen" }));
    await user.keyboard("{Escape}");
    expect(reopenItem).not.toHaveBeenCalled();
    expect(within(row).queryByText("Which steps still need doing?")).not.toBeInTheDocument();
  });
});

describe("InboxView — always-visible bucket board", () => {
  it("shows all four To-Do buckets with empty states when there are no to-dos", () => {
    render(<InboxView initialItems={[]} settings={settings} />);
    // Section headers present even when empty
    expect(screen.getByText("Multi-step to-dos")).toBeInTheDocument();
    expect(screen.getByText("Single-task to-dos")).toBeInTheDocument();
    expect(screen.getByText("Saved for later")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    // "Nothing here yet" appears for the empty buckets (at least the 3 non-completed)
    expect(screen.getAllByText("Nothing here yet").length).toBeGreaterThanOrEqual(3);
  });

  it("does not show the empty helper for a bucket that has items", () => {
    const todo = makeItem({ id: "t1", text: "a todo", status: "triaged" });
    render(<InboxView initialItems={[todo]} settings={settings} />);
    const single = screen.getByText("a todo").closest<HTMLElement>("section, div")!;
    expect(within(single).queryByText("Nothing here yet")).not.toBeInTheDocument();
  });
});

describe("InboxView — multi-step step count + expand", () => {
  it("shows a step-count indicator", () => {
    render(<InboxView initialItems={[makeMultiStep()]} settings={settings} />);
    expect(screen.getByText(/3 steps · 1 done/)).toBeInTheDocument();
  });

  it("expands the inline step list when the row body is tapped", async () => {
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeMultiStep()]} settings={settings} />);
    expect(screen.queryByTestId("inline-steps")).not.toBeInTheDocument();
    // Exact match (not a substring regex): Task 10 adds a "Drag plan trip" grip
    // button alongside this title button, so a loose /plan trip/ match would be
    // ambiguous between the two.
    await user.click(screen.getByRole("button", { name: "plan trip" }));
    expect(screen.getByTestId("inline-steps")).toBeInTheDocument();
  });
});

describe("dragEndToMove (pure)", () => {
  it("maps an over-a-bucket drop to { itemId, target }", () => {
    expect(dragEndToMove("item-1", "completed")).toEqual({ itemId: "item-1", target: "completed" });
  });
  it("returns null when dropped outside any bucket", () => {
    expect(dragEndToMove("item-1", null)).toBeNull();
  });
  it("returns null when the drop target is not a bucket id", () => {
    expect(dragEndToMove("item-1", "some-other-droppable")).toBeNull();
  });
});

describe("InboxView — Move to… menu dispatch", () => {
  it("a single-task 'Move to Completed' completes the item", async () => {
    const { completeItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "s1", text: "todo", status: "triaged" })]} settings={settings} />);
    const row = screen.getByText("todo").closest("li")!;
    // Move to… now lives inside the row's ⋯ overflow menu.
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(within(row).getByRole("menuitem", { name: /Completed/ }));
    expect(completeItem).toHaveBeenCalledWith("s1");
  });

  it("a single-task 'Move to Needs review' un-triages via moveToReview", async () => {
    const { moveToReview } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "s1", text: "todo", status: "triaged" })]} settings={settings} />);
    const row = screen.getByText("todo").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(within(row).getByRole("menuitem", { name: /Needs review/ }));
    expect(moveToReview).toHaveBeenCalledWith("s1");
  });

  it("moving a Completed item to Single-task reopens it first", async () => {
    const { reopenItem, triageBrainDumpItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    const done = makeItem({ id: "d1", text: "done item", status: "triaged", completedAt: new Date() });
    render(<InboxView initialItems={[done]} settings={settings} />);
    const row = screen.getByText("done item").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(within(row).getByRole("menuitem", { name: /Single-task/ }));
    expect(reopenItem).toHaveBeenCalledWith("d1", undefined);
    expect(triageBrainDumpItem).toHaveBeenCalledWith("d1");
  });

  it("moving an item to Multi-step moves immediately via requestBreakdown (no prompt)", async () => {
    const { requestBreakdown } = await import("@/app/actions/braindump");
    const { startBreakdown } = await import("@/app/actions/breakdown");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "n1", text: "big thing" })]} settings={settings} />);
    const row = screen.getByText("big thing").closest("li")!;
    // Move to… now lives inside the needs-review row's ⋯ overflow menu too.
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(within(row).getByRole("menuitem", { name: /Multi-step/ }));
    expect(requestBreakdown).toHaveBeenCalledWith("n1");
    // The editor only opens from the row's "Break into steps now?" CTA.
    expect(startBreakdown).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("moving a Completed item to Multi-step reopens it first, then requests the breakdown", async () => {
    const { reopenItem, requestBreakdown } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    const done = makeItem({ id: "d1", text: "finished big thing", status: "triaged", completedAt: new Date() });
    render(<InboxView initialItems={[done]} settings={settings} />);
    const row = screen.getByText("finished big thing").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(within(row).getByRole("menuitem", { name: /Multi-step/ }));
    expect(reopenItem).toHaveBeenCalledWith("d1", undefined);
    expect(requestBreakdown).toHaveBeenCalledWith("d1");
  });
});

describe("InboxView — awaiting-breakdown row (red CTA)", () => {
  const awaiting = () =>
    makeItem({
      id: "aw1",
      text: "needs a plan",
      status: "triaged",
      breakdownRequestedAt: new Date(),
      stepsTotal: 0,
    });

  it("renders an awaiting-breakdown item in the Multi-step bucket with a 'Break into steps now?' CTA", () => {
    render(<InboxView initialItems={[awaiting()]} settings={settings} />);
    const row = screen.getByText("needs a plan").closest("li")!;
    expect(row.closest('[data-bucket="multiStep"]')).not.toBeNull();
    expect(within(row).getByRole("button", { name: "Break into steps now?" })).toBeInTheDocument();
    // No step count on an awaiting row.
    expect(within(row).queryByText(/steps ·/)).not.toBeInTheDocument();
  });

  it("clicking the CTA starts the breakdown and navigates to the editor", async () => {
    const { startBreakdown } = await import("@/app/actions/breakdown");
    (startBreakdown as ReturnType<typeof vi.fn>).mockResolvedValue("t9");
    const user = userEvent.setup();
    render(<InboxView initialItems={[awaiting()]} settings={settings} />);
    await user.click(screen.getByRole("button", { name: "Break into steps now?" }));
    expect(startBreakdown).toHaveBeenCalledWith("aw1");
    expect(push).toHaveBeenCalledWith("/tasks/t9");
  });

  it("not clicking the CTA blocks nothing: the row still moves elsewhere via Move to…", async () => {
    const { triageBrainDumpItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[awaiting()]} settings={settings} />);
    const row = screen.getByText("needs a plan").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(within(row).getByRole("menuitem", { name: /Single-task/ }));
    expect(triageBrainDumpItem).toHaveBeenCalledWith("aw1");
  });
});

describe("InboxView — ✎ edit title", () => {
  it("pencil → input → Enter renames the item (review row)", async () => {
    const { renameItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "r1", text: "old name" })]} settings={settings} />);
    // v5: the ✎ pencil sits beside the title again — no menu needed.
    const row = screen.getByText("old name").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Edit old name" }));
    const input = screen.getByRole("textbox", { name: "Edit title" });
    await user.clear(input);
    await user.type(input, "new name{Enter}");
    expect(renameItem).toHaveBeenCalledWith("r1", "new name");
  });

  it("Escape cancels without renaming", async () => {
    const { renameItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "r1", text: "old name" })]} settings={settings} />);
    const row = screen.getByText("old name").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Edit old name" }));
    await user.keyboard("{Escape}");
    expect(renameItem).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Edit title" })).not.toBeInTheDocument();
    expect(screen.getByText("old name")).toBeInTheDocument();
  });

  it("every bucket row has a pencil beside its title (v5: no menu needed)", () => {
    const items = [
      makeItem({ id: "r1", text: "review item" }),
      makeItem({ id: "s1", text: "single item", status: "triaged" }),
      makeMultiStep(),
      makeItem({ id: "v1", text: "saved item", snoozedUntil: new Date(Date.now() + 3_600_000) }),
      makeItem({ id: "d1", text: "done item", status: "triaged", completedAt: new Date() }),
    ];
    render(<InboxView initialItems={items} settings={settings} />);
    for (const text of ["review item", "single item", "plan trip", "saved item", "done item"]) {
      expect(screen.getByRole("button", { name: `Edit ${text}` })).toBeInTheDocument();
    }
  });

  it("the pencil also appears as a duplicate entry inside the ▾ menu", async () => {
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "r1", text: "review item" })]} settings={settings} />);
    const row = screen.getByText("review item").closest("li")!;
    expect(within(row).getAllByRole("button", { name: "Edit review item" })).toHaveLength(1);
    await user.click(within(row).getByRole("button", { name: "All options" }));
    expect(within(row).getAllByRole("button", { name: "Edit review item" })).toHaveLength(2);
  });

  it("unchanged text does not fire the action", async () => {
    const { renameItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "r1", text: "same" })]} settings={settings} />);
    const row = screen.getByText("same").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Edit same" }));
    await user.keyboard("{Enter}");
    expect(renameItem).not.toHaveBeenCalled();
  });
});

describe("InboxView — single to-do ▶ Focus", () => {
  it("clicking ▶ Focus ensures the focus step and navigates to the timer", async () => {
    const { ensureFocusStep } = await import("@/app/actions/braindump");
    (ensureFocusStep as ReturnType<typeof vi.fn>).mockResolvedValue("step-7");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "s1", text: "focusable todo", status: "triaged" })]}
        settings={settings}
      />,
    );
    const row = screen.getByText("focusable todo").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "▶ Focus" }));
    expect(ensureFocusStep).toHaveBeenCalledWith("s1");
    expect(push).toHaveBeenCalledWith("/focus/step-7");
  });

  it("does not navigate when no step id comes back", async () => {
    const { ensureFocusStep } = await import("@/app/actions/braindump");
    (ensureFocusStep as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "s1", text: "focusable todo", status: "triaged" })]}
        settings={settings}
      />,
    );
    const row = screen.getByText("focusable todo").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "▶ Focus" }));
    expect(push).not.toHaveBeenCalled();
  });
});

describe("InboxView — saved-for-later inline sorting options", () => {
  const saved = () =>
    makeItem({
      id: "sv1",
      text: "stored thing",
      snoozedUntil: new Date(Date.now() + 60 * 60_000),
    });

  it("clicking a saved row reveals the sorting options; clicking again hides them", async () => {
    const user = userEvent.setup();
    render(<InboxView initialItems={[saved()]} settings={settings} />);
    const row = screen.getByText("stored thing").closest("li")!;
    expect(within(row).queryByRole("button", { name: /Break into steps/ })).not.toBeInTheDocument();

    await user.click(within(row).getByRole("button", { name: "stored thing" }));
    expect(within(row).getByRole("button", { name: /Break into steps/ })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Add to-do" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Complete" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Delete" })).toBeInTheDocument();

    await user.click(within(row).getByRole("button", { name: "stored thing" }));
    expect(within(row).queryByRole("button", { name: /Break into steps/ })).not.toBeInTheDocument();
  });

  it("'Review now' swaps to the full review-row button set (Review now disappears) — no triage", async () => {
    const { triageBrainDumpItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[saved()]} settings={settings} />);
    const row = screen.getByText("stored thing").closest("li")!;
    expect(row.className).toContain("opacity-70"); // idle = dimmed

    await user.click(within(row).getByRole("button", { name: "Review now" }));
    for (const name of [/Break into steps/, "Add to-do", "Save for later", "Complete", "Move to…", "Delete"]) {
      expect(within(row).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(within(row).queryByRole("button", { name: "Review now" })).not.toBeInTheDocument();
    expect(row.className).not.toContain("opacity-70"); // reviewing = looks active
    expect(triageBrainDumpItem).not.toHaveBeenCalled();

    // Collapse via the row title — back to idle.
    await user.click(within(row).getByRole("button", { name: "stored thing" }));
    expect(within(row).getByRole("button", { name: "Review now" })).toBeInTheDocument();
  });

  it("'Save for later' in the open options re-snoozes and puts the row back to sleep", async () => {
    const { snoozeBrainDumpItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[saved()]} settings={settings} />);
    const row = screen.getByText("stored thing").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Review now" }));
    await user.click(within(row).getByRole("button", { name: "Save for later" }));
    expect(snoozeBrainDumpItem).toHaveBeenCalledWith("sv1", 60);
    expect(within(row).getByRole("button", { name: "Review now" })).toBeInTheDocument();
  });

  it("the revealed options dispatch the same actions as a review row", async () => {
    const { keepAsTask } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[saved()]} settings={settings} />);
    const row = screen.getByText("stored thing").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "stored thing" }));
    await user.click(within(row).getByRole("button", { name: "Add to-do" }));
    expect(keepAsTask).toHaveBeenCalledWith("sv1");
  });

  it("Delete in the options uses the two-step confirm", async () => {
    const { deleteBrainDumpItem: del } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[saved()]} settings={settings} />);
    const row = screen.getByText("stored thing").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "stored thing" }));
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(del).not.toHaveBeenCalled(); // first click only reveals confirm
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(del).toHaveBeenCalledWith("sv1");
  });
});

describe("InboxView — 📅 row scheduling (Task 5)", () => {
  const connected = { configured: true, connected: true, needsReconnect: false };

  it("multi-step row with steps: 📅 pushes steps via pushStepsToGoogleTasks(taskId)", async () => {
    const { pushStepsToGoogleTasks } = await import("@/app/actions/google-schedule");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeMultiStep()]} settings={settings} google={connected} />);
    const row = screen.getByText("plan trip").closest("li")!;
    expect(within(row).getByRole("button", { name: /schedule/i })).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: /schedule/i }));
    expect(pushStepsToGoogleTasks).toHaveBeenCalledWith("t1");
  });

  it("single-task row: 📅 opens the popover; picking 30 min calls scheduleSingleTask(itemId, 30)", async () => {
    const { scheduleSingleTask } = await import("@/app/actions/google-schedule");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "st1", text: "single todo", status: "triaged" })]}
        settings={settings}
        google={connected}
      />,
    );
    const row = screen.getByText("single todo").closest("li")!;
    await user.click(within(row).getByRole("button", { name: /schedule/i }));
    await user.click(within(row).getByRole("button", { name: /^30 min$/i }));
    expect(scheduleSingleTask).toHaveBeenCalledWith("st1", 30);
  });

  it("an awaiting-breakdown (0-step) multi-step row uses the duration popover, not pushSteps", async () => {
    const { scheduleSingleTask, pushStepsToGoogleTasks } = await import("@/app/actions/google-schedule");
    const user = userEvent.setup();
    const awaiting = makeItem({
      id: "aw1",
      text: "needs a plan",
      status: "triaged",
      breakdownRequestedAt: new Date(),
      stepsTotal: 0,
    });
    render(<InboxView initialItems={[awaiting]} settings={settings} google={connected} />);
    const row = screen.getByText("needs a plan").closest("li")!;
    await user.click(within(row).getByRole("button", { name: /schedule/i }));
    await user.click(within(row).getByRole("button", { name: /^15 min$/i }));
    expect(scheduleSingleTask).toHaveBeenCalledWith("aw1", 15);
    expect(pushStepsToGoogleTasks).not.toHaveBeenCalled();
  });

  it("v5 NEW: a needs-review row is now schedulable — 📅 opens the popover; picking 30 min calls scheduleSingleTask(itemId, 30)", async () => {
    const { scheduleSingleTask } = await import("@/app/actions/google-schedule");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "n1", text: "capture me" })]}
        settings={settings}
        google={connected}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    expect(within(row).getByRole("button", { name: /schedule/i })).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: /schedule/i }));
    await user.click(within(row).getByRole("button", { name: /^30 min$/i }));
    expect(scheduleSingleTask).toHaveBeenCalledWith("n1", 30);
  });

  it("v5 NEW: a needs-review row's 📅 failure shows an inline error, same as other rows", async () => {
    const { scheduleSingleTask } = await import("@/app/actions/google-schedule");
    (scheduleSingleTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: "no_reclaim_list",
    });
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "n1", text: "capture me" })]}
        settings={settings}
        google={connected}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: /schedule/i }));
    await user.click(within(row).getByRole("button", { name: /^30 min$/i }));
    expect(await within(row).findByText(/Reclaim-synced Google Tasks list/i)).toBeInTheDocument();
  });

  it("google={null} (guest): no Schedule control on any row", () => {
    render(
      <InboxView
        initialItems={[makeMultiStep(), makeItem({ id: "st1", text: "single todo", status: "triaged" })]}
        settings={settings}
        google={null}
      />,
    );
    expect(screen.queryByRole("button", { name: /schedule/i })).toBeNull();
  });

  it("needsReconnect: rows show the Reconnect link instead of the 📅 button", () => {
    const needsReconnect = { configured: true, connected: false, needsReconnect: true };
    render(
      <InboxView
        initialItems={[makeMultiStep(), makeItem({ id: "st1", text: "single todo", status: "triaged" })]}
        settings={settings}
        google={needsReconnect}
      />,
    );
    expect(screen.queryByRole("button", { name: /schedule/i })).toBeNull();
    expect(screen.getAllByRole("link", { name: /reconnect google/i })).toHaveLength(2);
  });

  it("not configured: rows show the Connect link instead of the 📅 button", () => {
    const notConfigured = { configured: false, connected: false, needsReconnect: false };
    render(
      <InboxView
        initialItems={[makeItem({ id: "st1", text: "single todo", status: "triaged" })]}
        settings={settings}
        google={notConfigured}
      />,
    );
    expect(screen.getByRole("link", { name: /connect google/i })).toBeInTheDocument();
  });

  it("a reconnect_required push failure swaps the row's control to the Reconnect link", async () => {
    const { pushStepsToGoogleTasks } = await import("@/app/actions/google-schedule");
    (pushStepsToGoogleTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: "reconnect_required",
    });
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeMultiStep()]} settings={settings} google={connected} />);
    const row = screen.getByText("plan trip").closest("li")!;
    await user.click(within(row).getByRole("button", { name: /schedule/i }));
    expect(await within(row).findByRole("link", { name: /reconnect google/i })).toBeInTheDocument();
  });

  it("a scheduleSingleTask failure shows an inline error message under the row", async () => {
    const { scheduleSingleTask } = await import("@/app/actions/google-schedule");
    (scheduleSingleTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: "no_reclaim_list",
    });
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "st1", text: "single todo", status: "triaged" })]}
        settings={settings}
        google={connected}
      />,
    );
    const row = screen.getByText("single todo").closest("li")!;
    await user.click(within(row).getByRole("button", { name: /schedule/i }));
    await user.click(within(row).getByRole("button", { name: /^30 min$/i }));
    expect(await within(row).findByText(/Reclaim-synced Google Tasks list/i)).toBeInTheDocument();
  });

  it("prefers the action's own message over the generic dictionary copy (Task 6 controller fix)", async () => {
    const { pushStepsToGoogleTasks } = await import("@/app/actions/google-schedule");
    (pushStepsToGoogleTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: "no_reclaim_list",
      message: 'Couldn\'t find a Google Tasks list matching "Reclaim". Available: Personal, Work.',
    });
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeMultiStep()]} settings={settings} google={connected} />);
    const row = screen.getByText("plan trip").closest("li")!;
    await user.click(within(row).getByRole("button", { name: /schedule/i }));
    // The detailed "available lists" message wins over the generic dictionary
    // copy for the same reason ("Couldn't find your Reclaim-synced...").
    expect(await within(row).findByText(/Available: Personal, Work/)).toBeInTheDocument();
    expect(within(row).queryByText(/Couldn't find your Reclaim-synced/)).not.toBeInTheDocument();
  });
});

describe("InboxView — needs-review rows adopt the v5 inline-actions frame", () => {
  it("renders Break into steps, Add as single to-do, Save for later, and Complete inline (no ▾ needed)", () => {
    render(<InboxView initialItems={[makeItem({ id: "n1", text: "capture me" })]} settings={settings} />);
    const row = screen.getByText("capture me").closest("li")!;
    expect(within(row).getByRole("button", { name: /Break into steps/ })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Add to-do" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Save for later" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Complete" })).toBeInTheDocument();
  });

  it("clicking Add as single to-do (Keep-as-task) fires directly, no menu involved", async () => {
    const { keepAsTask } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "n1", text: "capture me" })]} settings={settings} />);
    const row = screen.getByText("capture me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Add to-do" }));
    expect(keepAsTask).toHaveBeenCalledWith("n1");
  });

  it("clicking Save for later is a direct MOVE to the Saved bucket via the shared dispatcher", async () => {
    const { snoozeBrainDumpItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "n1", text: "capture me" })]} settings={settings} />);
    const row = screen.getByText("capture me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Save for later" }));
    // The move went through moveItemToBucket → dropPlan(needsReview → savedLater)…
    expect(dropPlan).toHaveBeenCalledWith("needsReview", "savedLater");
    // …whose savedLater action lands the item in the Saved bucket
    // (ACTION_FOR_BUCKET.savedLater — snooze is how Saved membership is stored).
    expect(snoozeBrainDumpItem).toHaveBeenCalledWith("n1", 60);
  });

  it("the ▾ menu's Save for later duplicate dispatches the same Saved-bucket move", async () => {
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "n1", text: "capture me" })]} settings={settings} />);
    const row = screen.getByText("capture me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    // Two "Save for later" buttons exist now (inline + ▾ duplicate); click the duplicate.
    const duplicates = within(row).getAllByRole("button", { name: "Save for later" });
    expect(duplicates).toHaveLength(2);
    await user.click(duplicates[1]);
    expect(dropPlan).toHaveBeenCalledWith("needsReview", "savedLater");
  });

  it("delete is inline in the end cluster and still requires a two-step confirm", async () => {
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "n1", text: "capture me" })]} settings={settings} />);
    const row = screen.getByText("capture me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(deleteBrainDumpItem).toHaveBeenCalledWith("n1");
  });

  it("▾ All options duplicates the inline actions plus Move to… (pinned first), Snooze 1h, and Edit", async () => {
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "n1", text: "capture me" })]} settings={settings} />);
    const row = screen.getByText("capture me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    const menuButtons = within(row).getAllByRole("button");
    const moveToIndex = menuButtons.findIndex((b) => b.textContent === "Move to…");
    expect(moveToIndex).toBeGreaterThan(-1);
    // Move to… is the first entry inside the popover (everything before it on
    // the row is the always-visible inline/end-cluster controls).
    expect(menuButtons[moveToIndex + 1]).toHaveTextContent(/Break into steps/);
    expect(within(row).getByRole("button", { name: "Snooze 1h" })).toBeInTheDocument();
    expect(within(row).getAllByRole("button", { name: "Edit capture me" })).toHaveLength(2);
  });

  it("Snooze 1h in the ▾ menu is a SEPARATE direct snooze — it does not go through the move dispatcher", async () => {
    const { snoozeBrainDumpItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "n1", text: "capture me" })]} settings={settings} />);
    const row = screen.getByText("capture me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(within(row).getByRole("button", { name: "Snooze 1h" }));
    expect(snoozeBrainDumpItem).toHaveBeenCalledWith("n1", 60);
    expect(dropPlan).not.toHaveBeenCalled();
  });
});
