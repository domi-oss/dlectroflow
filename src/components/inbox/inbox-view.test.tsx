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
}));

vi.mock("@/app/actions/breakdown", () => ({
  startBreakdown: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/notifications", () => ({
  notificationPermission: () => "default",
  requestNotificationPermission: vi.fn().mockResolvedValue("default"),
  registerServiceWorker: vi.fn().mockResolvedValue(null),
  showReminder: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/components/breakdown/task-steps", () => ({
  TaskSteps: ({ steps }: { steps: { id: string; text: string }[] }) => (
    <ol data-testid="inline-steps">{steps.map((s) => <li key={s.id}>{s.text}</li>)}</ol>
  ),
}));

import {
  createBrainDumpItem,
  deleteBrainDumpItem,
  dismissPrompt,
  freshenItem,
} from "@/app/actions/braindump";

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

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    // Cancel dismisses the confirm without deleting.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();

    // Click delete again, then confirm.
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

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
  it("a needs-review row has a Complete button that calls completeItem", async () => {
    const { completeItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "n1", text: "do it" })]} settings={settings} />);
    const row = screen.getByText("do it").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Complete" }));
    expect(completeItem).toHaveBeenCalledWith("n1");
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
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(within(row).getByRole("menuitem", { name: /Completed/ }));
    expect(completeItem).toHaveBeenCalledWith("s1");
  });

  it("a single-task 'Move to Needs review' un-triages via moveToReview", async () => {
    const { moveToReview } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "s1", text: "todo", status: "triaged" })]} settings={settings} />);
    const row = screen.getByText("todo").closest("li")!;
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

  it("moving an item to Multi-step opens the prompt (no action yet)", async () => {
    const { startBreakdown } = await import("@/app/actions/breakdown");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "n1", text: "big thing" })]} settings={settings} />);
    const row = screen.getByText("big thing").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(within(row).getByRole("menuitem", { name: /Multi-step/ }));
    expect(screen.getByRole("button", { name: "Break into steps now" })).toBeInTheDocument();
    expect(startBreakdown).not.toHaveBeenCalled();
  });

  it("choosing 'Break into steps now' in the prompt calls startBreakdown", async () => {
    const { startBreakdown } = await import("@/app/actions/breakdown");
    (startBreakdown as ReturnType<typeof vi.fn>).mockResolvedValue("t9");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "n1", text: "big thing" })]} settings={settings} />);
    const row = screen.getByText("big thing").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(within(row).getByRole("menuitem", { name: /Multi-step/ }));
    await user.click(screen.getByRole("button", { name: "Break into steps now" }));
    expect(startBreakdown).toHaveBeenCalledWith("n1");
  });

  it("choosing 'Save for later' in the prompt snoozes the item", async () => {
    const { snoozeBrainDumpItem, reopenItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "n1", text: "big thing" })]} settings={settings} />);
    const row = screen.getByText("big thing").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(within(row).getByRole("menuitem", { name: /Multi-step/ }));
    // Scoped to the prompt dialog: the needs-review row keeps its own
    // (identically-labeled) "Save for later" snooze button while the prompt
    // is open, since the item hasn't moved yet.
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save for later" }));
    expect(snoozeBrainDumpItem).toHaveBeenCalledWith("n1", 60);
    // Non-completed source → reopenFirst is false, so reopen must not fire.
    expect(reopenItem).not.toHaveBeenCalled();
  });

  it("moving a Completed item to Multi-step then Cancel is a true no-op (does not reopen)", async () => {
    const { reopenItem } = await import("@/app/actions/braindump");
    const { startBreakdown } = await import("@/app/actions/breakdown");
    const user = userEvent.setup();
    const done = makeItem({ id: "d1", text: "finished big thing", status: "triaged", completedAt: new Date() });
    render(<InboxView initialItems={[done]} settings={settings} />);
    const row = screen.getByText("finished big thing").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(within(row).getByRole("menuitem", { name: /Multi-step/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(reopenItem).not.toHaveBeenCalled();
    expect(startBreakdown).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("moving a Completed item to Multi-step then 'Break into steps now' reopens it first", async () => {
    const { reopenItem } = await import("@/app/actions/braindump");
    const { startBreakdown } = await import("@/app/actions/breakdown");
    const user = userEvent.setup();
    const done = makeItem({ id: "d1", text: "finished big thing", status: "triaged", completedAt: new Date() });
    render(<InboxView initialItems={[done]} settings={settings} />);
    const row = screen.getByText("finished big thing").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(within(row).getByRole("menuitem", { name: /Multi-step/ }));
    await user.click(screen.getByRole("button", { name: "Break into steps now" }));

    expect(reopenItem).toHaveBeenCalledWith("d1", undefined);
    expect(startBreakdown).toHaveBeenCalledWith("d1");
  });
});
