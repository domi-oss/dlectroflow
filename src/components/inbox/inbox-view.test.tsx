// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  act,
  fireEvent,
  cleanup,
  within,
  waitFor,
} from "@testing-library/react";
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

// InboxView renders <WelcomeCard> (Task 3, #8) which itself calls into these
// server actions on click — mocked here the same way welcome-card.test.tsx does.
vi.mock("@/app/actions/settings", () => ({
  dismissWelcome: vi.fn().mockResolvedValue(undefined),
  updateVoice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/app/actions/google-schedule", () => ({
  pushStepsToGoogleTasks: vi
    .fn()
    .mockResolvedValue({ ok: true, scheduled: 1, listTitle: "Reclaim" }),
  scheduleSingleTask: vi.fn().mockResolvedValue({ ok: true }),
}));

const { scheduleViaIcsMock, downloadIcsMock } = vi.hoisted(() => ({
  scheduleViaIcsMock: vi.fn(),
  downloadIcsMock: vi.fn(),
}));
vi.mock("@/app/actions/ics-schedule", () => ({
  scheduleViaIcs: scheduleViaIcsMock,
}));
vi.mock("@/lib/download-ics", () => ({ downloadIcs: downloadIcsMock }));

vi.mock("@/lib/notifications", () => ({
  notificationPermission: () => "default",
  subscribeNotificationPermission: () => () => {},
  requestNotificationPermission: vi.fn().mockResolvedValue("default"),
  registerServiceWorker: vi.fn().mockResolvedValue(null),
  showReminder: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/components/breakdown/task-steps", () => ({
  TaskSteps: ({ steps }: { steps: { id: string; text: string }[] }) => (
    <ol data-testid="inline-steps">
      {steps.map((s) => (
        <li key={s.id}>{s.text}</li>
      ))}
    </ol>
  ),
}));

// Passthrough spy on the shared move dispatcher: dropPlan keeps its REAL
// behavior, but its calls become observable — so tests can assert an action
// was routed through moveItemToBucket (e.g. the review row's "Save for
// later" = a direct move to the Saved bucket) versus a direct server-action
// call that bypasses the dispatcher (e.g. "Snooze 1h").
vi.mock("@/components/inbox/move-dispatch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/inbox/move-dispatch")>();
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
    scheduledAt: null,
    estMinutes: null,
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
      {
        id: "s1",
        order: 1,
        text: "book",
        done: true,
        estMinutes: 10,
        subtaskEmoji: null,
        resumable: false,
      },
      {
        id: "s2",
        order: 2,
        text: "pack",
        done: false,
        estMinutes: 20,
        subtaskEmoji: null,
        resumable: false,
      },
      {
        id: "s3",
        order: 3,
        text: "go",
        done: false,
        estMinutes: 5,
        subtaskEmoji: null,
        resumable: false,
      },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  scheduleViaIcsMock.mockResolvedValue({
    ok: true,
    ics: "BEGIN:VCALENDAR",
    icsFilename: "dlectroflow-x.ics",
  });
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
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const input = screen.getByPlaceholderText(/Brain dump/i);
    await user.type(input, "buy milk{enter}");

    expect(await screen.findByText("captured ✓")).toBeInTheDocument();
    expect(createBrainDumpItem).toHaveBeenCalledWith("buy milk");
  });

  // #40 phase 1: --background moved from a near-white gray to a warm-tinted
  // #fdf6fa, dropping plain emerald-600 to 3.43:1 (fails AA-normal 4.5:1).
  // Mirrors the same AA-tuned per-theme emerald pairing already used by
  // row-actions.test.tsx's "Scheduled ✓" indicator.
  it("a11y: 'captured ✓' uses AA-tuned per-theme emerald (not the sub-AA emerald-600)", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const input = screen.getByPlaceholderText(/Brain dump/i);
    await user.type(input, "buy milk{enter}");

    const el = await screen.findByText("captured ✓");
    expect(el.className).toContain("text-emerald-700");
    expect(el.className).toContain("dark:text-emerald-400");
    expect(el.className).not.toContain("text-emerald-600");
  });

  it("clears the captured indicator after ~1.5s", async () => {
    vi.useFakeTimers();
    render(
      <InboxView
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
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
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    // v5: Delete lives inline in the row's end cluster (no menu needed).
    const row = screen.getByText("delete me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    expect(
      within(row).getByRole("button", { name: "Cancel" }),
    ).toBeInTheDocument();

    // Cancel dismisses the confirm without deleting.
    await user.click(within(row).getByRole("button", { name: "Cancel" }));
    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    expect(
      within(row).queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();

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
        welcomeVisible={false}
        resumeStep={null}
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
    render(
      <InboxView
        initialItems={[stale]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );

    const row = screen.getByText("keep this").closest("li")!;
    await user.click(
      within(row).getByRole("button", { name: "Still need it" }),
    );
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
        welcomeVisible={false}
        resumeStep={null}
      />,
    );

    expect(
      screen.queryByText("This has been sitting a while — still needed?"),
    ).not.toBeInTheDocument();
  });
});

describe("InboxView — row hierarchy (#50/#51/#52)", () => {
  // #51 — the title is the dominant text in its row (larger + heavier), so it
  // no longer fades into the small metadata size. Owner design revision bumped
  // the inbox row title another step to text-lg.
  it("#51: the task title is the dominant row text (text-lg font-semibold)", () => {
    render(
      <InboxView
        initialItems={[makeItem({ id: "h1", text: "buy oat milk" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const title = screen.getByText("buy oat milk");
    expect(title.className).toMatch(/text-lg/);
    expect(title.className).toMatch(/font-semibold/);
    // …and the metadata (captured-ago) recedes to text-xs.
    expect(screen.getByText(/captured/).className).toMatch(/text-xs/);
  });

  // Owner design revision: the drag grip was tucked into a narrower gutter
  // (44px square → 28px wide) so the title sits closer to the left edge. The
  // grip keeps a full 44px height and stays ≥ the WCAG-AA 24px minimum width.
  it("design revision: the drag grip stays an adequate hit target (≥24px wide, 44px tall)", () => {
    render(
      <InboxView
        initialItems={[makeItem({ id: "g1", text: "grip row" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const grip = screen.getByRole("button", { name: "Drag grip row" });
    expect(grip.className).toContain("min-h-11"); // 44px tall
    expect(grip.className).toContain("w-7"); // 28px wide (≥ WCAG-AA 24px min)
  });

  // #52 — the age/status pill moves off the title line down to the metadata
  // line, sitting alongside "captured x ago" (not competing with the title).
  it("#52: the age/status pill sits on the metadata line with captured-ago, not on the title line", () => {
    render(
      <InboxView
        initialItems={[
          makeItem({
            id: "h2",
            text: "buy oat milk",
            createdAt: new Date(Date.now() - 100 * 3600_000), // wayOverdue
          }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const status = screen.getByText(/Way overdue/);
    const captured = screen.getByText(/captured/);
    // Pill + captured-ago share one metadata line.
    const metaLine = status.closest("div")!;
    expect(metaLine).toContainElement(captured);
    // The pill is NOT on the title line.
    const titleLine = screen.getByText("buy oat milk").closest("div")!;
    expect(titleLine).not.toContainElement(status);
  });

  // #50 — the stale-reminder is right-sized to a quiet inline nudge instead of
  // a loud bordered/hardcoded-hex box that outweighed the title.
  it("#50: the stale-reminder is a quiet inline nudge (no heavy hardcoded box), keeping Still-need-it/Dismiss as adequate hit targets", () => {
    render(
      <InboxView
        initialItems={[
          makeItem({
            id: "h3",
            text: "old thing",
            createdAt: new Date(Date.now() - 25 * 3600_000),
          }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const prompt = screen.getByText(
      "This has been sitting a while — still needed?",
    );
    const box = prompt.closest("div")!;
    // The loud red box is gone: no bordered/padded box, no hardcoded hex.
    expect(box.className).not.toContain("border");
    expect(box.getAttribute("style") ?? "").not.toContain("#c0392b");
    expect(box.getAttribute("style") ?? "").not.toContain("#fff5f5");
    // Actions stay keyboard-usable + adequately hit-targeted (≥44px). Scope to
    // the row — "Dismiss" also names the NavBadge ✕ at the top of the inbox.
    const row = prompt.closest("li")!;
    expect(
      within(row).getByRole("button", { name: "Still need it" }),
    ).toHaveClass("min-h-11");
    expect(within(row).getByRole("button", { name: "Dismiss" })).toHaveClass(
      "min-h-11",
    );
  });
});

describe("InboxView — inbox zero copy", () => {
  it("renders the voice-aware inbox.zero string with no items", () => {
    render(
      <InboxView
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    expect(
      screen.getByText("Inbox zero. Nothing to review."),
    ).toBeInTheDocument();
  });
});

describe("InboxView — settings panel moved to /settings", () => {
  it("no longer renders the aging & reminder settings panel on the inbox", () => {
    render(
      <InboxView
        initialItems={[makeItem()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
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
    render(
      <InboxView
        initialItems={[makeItem({ id: "n1", text: "do it" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("do it").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "✓ Complete" }));
    expect(completeItem).toHaveBeenCalledWith("n1");
  });

  it("a single-task row's Complete button (v5: inline) calls completeItem", async () => {
    const { completeItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[
          makeItem({ id: "st1", text: "single todo", status: "triaged" }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("single todo").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "✓ Complete" }));
    expect(completeItem).toHaveBeenCalledWith("st1");
  });

  it("a multi-step row's Complete button calls completeItem", async () => {
    const { completeItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeMultiStep()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("plan trip").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "✓ Complete" }));
    expect(completeItem).toHaveBeenCalledWith("m1");
  });

  it("renders the Completed section with a today count and Undo", async () => {
    const { reopenItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    const done = makeItem({
      id: "d1",
      text: "finished",
      status: "triaged",
      completedAt: new Date(),
    });
    render(
      <InboxView
        initialItems={[done]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
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
        {
          id: "s1",
          order: 1,
          text: "book",
          done: true,
          estMinutes: 10,
          subtaskEmoji: null,
          resumable: false,
        },
        // Emoji on purpose: it must stay decorative (aria-hidden), so the
        // checkbox's accessible name is still exactly "pack".
        {
          id: "s2",
          order: 2,
          text: "pack",
          done: true,
          estMinutes: 20,
          subtaskEmoji: "🧳",
          resumable: false,
        },
        {
          id: "s3",
          order: 3,
          text: "go",
          done: true,
          estMinutes: 5,
          subtaskEmoji: null,
          resumable: false,
        },
      ],
    });

  it("Reopen on a completed multi-step opens the step picker instead of reopening", async () => {
    const { reopenItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[doneMulti()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("finished trip").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Reopen" }));
    expect(reopenItem).not.toHaveBeenCalled();
    expect(
      within(row).getByText("Which steps still need doing?"),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole("checkbox", { name: "pack" }),
    ).toBeInTheDocument();
  });

  it("reopens only the checked steps", async () => {
    const { reopenItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[doneMulti()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("finished trip").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Reopen" }));
    await user.click(within(row).getByRole("checkbox", { name: "pack" }));
    await user.click(
      within(row).getByRole("button", { name: "Reopen selected" }),
    );
    expect(reopenItem).toHaveBeenCalledWith("dm1", ["s2"]);
  });

  it("confirm is disabled with nothing checked; Reopen all resets every step", async () => {
    const { reopenItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[doneMulti()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("finished trip").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Reopen" }));
    expect(
      within(row).getByRole("button", { name: "Reopen selected" }),
    ).toBeDisabled();
    await user.click(within(row).getByRole("button", { name: "Reopen all" }));
    expect(reopenItem).toHaveBeenCalledWith("dm1", undefined);
  });

  it("Cancel closes the picker without reopening", async () => {
    const { reopenItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[doneMulti()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("finished trip").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Reopen" }));
    await user.click(within(row).getByRole("button", { name: "Cancel" }));
    expect(reopenItem).not.toHaveBeenCalled();
    expect(
      within(row).queryByText("Which steps still need doing?"),
    ).not.toBeInTheDocument();
  });

  it("Escape closes the picker without reopening (matches MoveToMenu)", async () => {
    const { reopenItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[doneMulti()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("finished trip").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Reopen" }));
    await user.keyboard("{Escape}");
    expect(reopenItem).not.toHaveBeenCalled();
    expect(
      within(row).queryByText("Which steps still need doing?"),
    ).not.toBeInTheDocument();
  });
});

describe("InboxView — always-visible bucket board", () => {
  it("shows all four To-Do buckets with empty states when there are no to-dos", () => {
    render(
      <InboxView
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    // Section headers present even when empty
    expect(screen.getByText("Multi-step to-dos")).toBeInTheDocument();
    expect(screen.getByText("Single-task to-dos")).toBeInTheDocument();
    expect(screen.getByText("Saved for later")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    // "Nothing here yet" appears for the empty buckets (at least the 3 non-completed)
    expect(
      screen.getAllByText("Nothing here yet").length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("does not show the empty helper for a bucket that has items", () => {
    const todo = makeItem({ id: "t1", text: "a todo", status: "triaged" });
    render(
      <InboxView
        initialItems={[todo]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const single = screen
      .getByText("a todo")
      .closest<HTMLElement>("section, div")!;
    expect(
      within(single).queryByText("Nothing here yet"),
    ).not.toBeInTheDocument();
  });
});

describe("InboxView — multi-step step count + expand", () => {
  it("shows a step-count indicator", () => {
    render(
      <InboxView
        initialItems={[makeMultiStep()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    expect(screen.getByText(/3 steps · 1 done/)).toBeInTheDocument();
  });

  it("expands the inline step list when the row body is tapped", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeMultiStep()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    expect(screen.queryByTestId("inline-steps")).not.toBeInTheDocument();
    // Exact match (not a substring regex): Task 10 adds a "Drag plan trip" grip
    // button alongside this title button, so a loose /plan trip/ match would be
    // ambiguous between the two.
    await user.click(screen.getByRole("button", { name: "plan trip" }));
    expect(screen.getByTestId("inline-steps")).toBeInTheDocument();
  });
});

describe("InboxView — multi-step ▾ menu: view list + focus (v6)", () => {
  it("'View multi-step task list' expands the inline step list", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeMultiStep()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("plan trip").closest("li")!;
    expect(screen.queryByTestId("inline-steps")).not.toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(
      within(row).getByRole("button", { name: "View multi-step task list" }),
    );
    expect(screen.getByTestId("inline-steps")).toBeInTheDocument();
  });

  it("'Start visual focus timer' opens the task page", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeMultiStep()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("plan trip").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(
      within(row).getByRole("button", { name: "Start visual focus timer" }),
    );
    expect(push).toHaveBeenCalledWith("/tasks/t1");
  });

  it("awaiting-breakdown rows omit both entries (nothing to view/focus yet)", async () => {
    const user = userEvent.setup();
    const awaiting = makeItem({
      id: "aw1",
      text: "needs a plan",
      status: "triaged",
      breakdownRequestedAt: new Date(),
      stepsTotal: 0,
    });
    render(
      <InboxView
        initialItems={[awaiting]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("needs a plan").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    expect(
      within(row).queryByRole("button", { name: "View multi-step task list" }),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByRole("button", { name: "Start visual focus timer" }),
    ).not.toBeInTheDocument();
  });
});

describe("InboxView — tap multi-step row body to expand (v6)", () => {
  it("tapping a non-button part of the row (the step-count meta) expands the inline step list", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeMultiStep()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("plan trip").closest("li")!;
    expect(within(row).queryByTestId("inline-steps")).not.toBeInTheDocument();
    await user.click(within(row).getByText(/steps ·/));
    expect(within(row).getByTestId("inline-steps")).toBeInTheDocument();
  });
});

describe("InboxView — multi-step row primary CTA (v6 fix)", () => {
  it("a multi-step row with steps shows ▶ Focus + Complete; ▶ Focus opens the next unfinished step's timer", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeMultiStep()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("plan trip").closest("li")!;
    expect(
      within(row).getByRole("button", { name: "▶ Start Focus" }),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: "✓ Complete" }),
    ).toBeInTheDocument();
    await user.click(
      within(row).getByRole("button", { name: "▶ Start Focus" }),
    );
    // makeMultiStep: s1 done, s2 is the first unfinished step.
    expect(push).toHaveBeenCalledWith("/focus/s2");
  });

  it("an awaiting-breakdown multi-step row keeps the red CTA, not ▶ Focus", () => {
    const awaiting = makeItem({
      id: "aw1",
      text: "needs a plan",
      status: "triaged",
      breakdownRequestedAt: new Date(),
      stepsTotal: 0,
    });
    render(
      <InboxView
        initialItems={[awaiting]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("needs a plan").closest("li")!;
    expect(
      within(row).getByRole("button", { name: "Break into steps now?" }),
    ).toBeInTheDocument();
    expect(
      within(row).queryByRole("button", { name: "▶ Start Focus" }),
    ).not.toBeInTheDocument();
  });
});

describe("dragEndToMove (pure)", () => {
  it("maps an over-a-bucket drop to { itemId, target }", () => {
    expect(dragEndToMove("item-1", "completed")).toEqual({
      itemId: "item-1",
      target: "completed",
    });
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
    render(
      <InboxView
        initialItems={[makeItem({ id: "s1", text: "todo", status: "triaged" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
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
    render(
      <InboxView
        initialItems={[makeItem({ id: "s1", text: "todo", status: "triaged" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("todo").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(
      within(row).getByRole("menuitem", { name: /Needs review/ }),
    );
    expect(moveToReview).toHaveBeenCalledWith("s1");
  });

  it("moving a Completed item to Single-task reopens it first", async () => {
    const { reopenItem, triageBrainDumpItem } =
      await import("@/app/actions/braindump");
    const user = userEvent.setup();
    const done = makeItem({
      id: "d1",
      text: "done item",
      status: "triaged",
      completedAt: new Date(),
    });
    render(
      <InboxView
        initialItems={[done]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("done item").closest("li")!;
    // v6: completed rows' Move-to is the 📥 icon (aria "Move to").
    await user.click(within(row).getByRole("button", { name: "Move to" }));
    await user.click(
      within(row).getByRole("menuitem", { name: /Single-task/ }),
    );
    expect(reopenItem).toHaveBeenCalledWith("d1", undefined);
    expect(triageBrainDumpItem).toHaveBeenCalledWith("d1");
  });

  it("moving an item to Multi-step moves immediately via requestBreakdown (no prompt)", async () => {
    const { requestBreakdown } = await import("@/app/actions/braindump");
    const { startBreakdown } = await import("@/app/actions/breakdown");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "n1", text: "big thing" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
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
    const { reopenItem, requestBreakdown } =
      await import("@/app/actions/braindump");
    const user = userEvent.setup();
    const done = makeItem({
      id: "d1",
      text: "finished big thing",
      status: "triaged",
      completedAt: new Date(),
    });
    render(
      <InboxView
        initialItems={[done]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("finished big thing").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Move to" }));
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
    render(
      <InboxView
        initialItems={[awaiting()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("needs a plan").closest("li")!;
    expect(row.closest('[data-bucket="multiStep"]')).not.toBeNull();
    expect(
      within(row).getByRole("button", { name: "Break into steps now?" }),
    ).toBeInTheDocument();
    // No step count on an awaiting row.
    expect(within(row).queryByText(/steps ·/)).not.toBeInTheDocument();
  });

  it("clicking the CTA starts the breakdown and navigates to the editor", async () => {
    const { startBreakdown } = await import("@/app/actions/breakdown");
    (startBreakdown as ReturnType<typeof vi.fn>).mockResolvedValue("t9");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[awaiting()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Break into steps now?" }),
    );
    expect(startBreakdown).toHaveBeenCalledWith("aw1");
    expect(push).toHaveBeenCalledWith("/tasks/t9");
  });

  it("not clicking the CTA blocks nothing: the row still moves elsewhere via Move to…", async () => {
    const { triageBrainDumpItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[awaiting()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("needs a plan").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(
      within(row).getByRole("menuitem", { name: /Single-task/ }),
    );
    expect(triageBrainDumpItem).toHaveBeenCalledWith("aw1");
  });
});

describe("InboxView — ✎ edit title", () => {
  it("pencil → input → Enter renames the item (review row)", async () => {
    const { renameItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "r1", text: "old name" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    // v5: the ✎ pencil sits beside the title again — no menu needed.
    const row = screen.getByText("old name").closest("li")!;
    await user.click(
      within(row).getByRole("button", { name: "Edit old name" }),
    );
    const input = screen.getByRole("textbox", { name: "Edit title" });
    await user.clear(input);
    await user.type(input, "new name{Enter}");
    expect(renameItem).toHaveBeenCalledWith("r1", "new name");
  });

  it("Escape cancels without renaming", async () => {
    const { renameItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "r1", text: "old name" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("old name").closest("li")!;
    await user.click(
      within(row).getByRole("button", { name: "Edit old name" }),
    );
    await user.keyboard("{Escape}");
    expect(renameItem).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("textbox", { name: "Edit title" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("old name")).toBeInTheDocument();
  });

  it("every bucket row has a pencil beside its title (v5: no menu needed)", () => {
    const items = [
      makeItem({ id: "r1", text: "review item" }),
      makeItem({ id: "s1", text: "single item", status: "triaged" }),
      makeMultiStep(),
      makeItem({
        id: "v1",
        text: "saved item",
        snoozedUntil: new Date(Date.now() + 3_600_000),
      }),
      makeItem({
        id: "d1",
        text: "done item",
        status: "triaged",
        completedAt: new Date(),
      }),
    ];
    render(
      <InboxView
        initialItems={items}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    for (const text of [
      "review item",
      "single item",
      "plan trip",
      "saved item",
      "done item",
    ]) {
      expect(
        screen.getByRole("button", { name: `Edit ${text}` }),
      ).toBeInTheDocument();
    }
  });

  it("v6: the ▾ menu carries an 'Edit task title' entry; the title keeps its single ✏️ pencil", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "r1", text: "review item" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("review item").closest("li")!;
    expect(
      within(row).getAllByRole("button", { name: "Edit review item" }),
    ).toHaveLength(1);
    await user.click(within(row).getByRole("button", { name: "All options" }));
    // Still one ✏️ pencil (the title-line affordance); the menu adds a text entry.
    expect(
      within(row).getAllByRole("button", { name: "Edit review item" }),
    ).toHaveLength(1);
    expect(
      within(row).getByRole("button", { name: "Edit task title" }),
    ).toBeInTheDocument();
  });

  it("unchanged text does not fire the action", async () => {
    const { renameItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "r1", text: "same" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
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
        initialItems={[
          makeItem({ id: "s1", text: "focusable todo", status: "triaged" }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("focusable todo").closest("li")!;
    await user.click(
      within(row).getByRole("button", { name: "▶ Start Focus" }),
    );
    expect(ensureFocusStep).toHaveBeenCalledWith("s1");
    expect(push).toHaveBeenCalledWith("/focus/step-7");
  });

  it("does not navigate when no step id comes back", async () => {
    const { ensureFocusStep } = await import("@/app/actions/braindump");
    (ensureFocusStep as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[
          makeItem({ id: "s1", text: "focusable todo", status: "triaged" }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("focusable todo").closest("li")!;
    await user.click(
      within(row).getByRole("button", { name: "▶ Start Focus" }),
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("v6: the ▾ menu's focus entry reads 'Start visual focus timer' and navigates to the timer", async () => {
    const { ensureFocusStep } = await import("@/app/actions/braindump");
    (ensureFocusStep as ReturnType<typeof vi.fn>).mockResolvedValue("step-9");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[
          makeItem({ id: "s1", text: "focusable todo", status: "triaged" }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("focusable todo").closest("li")!;
    // Inline stays the short "▶ Focus"; the dropdown carries the full label.
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(
      within(row).getByRole("button", { name: "Start visual focus timer" }),
    );
    expect(ensureFocusStep).toHaveBeenCalledWith("s1");
    expect(push).toHaveBeenCalledWith("/focus/step-9");
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
    render(
      <InboxView
        initialItems={[saved()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("stored thing").closest("li")!;
    expect(
      within(row).queryByRole("button", { name: /Break into steps/ }),
    ).not.toBeInTheDocument();

    await user.click(within(row).getByRole("button", { name: "stored thing" }));
    expect(
      within(row).getByRole("button", { name: /Break into steps/ }),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: "Add to-do" }),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: "✓ Complete" }),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: "Delete" }),
    ).toBeInTheDocument();

    await user.click(within(row).getByRole("button", { name: "stored thing" }));
    expect(
      within(row).queryByRole("button", { name: /Break into steps/ }),
    ).not.toBeInTheDocument();
  });

  it("'Review now' swaps to the full review-row button set (Review now disappears) — no triage", async () => {
    const { triageBrainDumpItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[saved()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("stored thing").closest("li")!;
    expect(row.className).toContain("opacity-70"); // idle = dimmed

    await user.click(within(row).getByRole("button", { name: "Review now" }));
    // v6: short inline buttons + icon end-cluster (📥 "Move to", 🗑 "Delete").
    for (const name of [
      /Break into steps/,
      "Add to-do",
      "Save",
      "✓ Complete",
      "Move to",
      "Delete",
    ]) {
      expect(within(row).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(
      within(row).queryByRole("button", { name: "Review now" }),
    ).not.toBeInTheDocument();
    expect(row.className).not.toContain("opacity-70"); // reviewing = looks active
    expect(triageBrainDumpItem).not.toHaveBeenCalled();

    // Collapse via the row title — back to idle.
    await user.click(within(row).getByRole("button", { name: "stored thing" }));
    expect(
      within(row).getByRole("button", { name: "Review now" }),
    ).toBeInTheDocument();
  });

  it("the inline 'Save' in the open options re-snoozes and puts the row back to sleep", async () => {
    const { snoozeBrainDumpItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[saved()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("stored thing").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Review now" }));
    await user.click(within(row).getByRole("button", { name: "Save" }));
    expect(snoozeBrainDumpItem).toHaveBeenCalledWith("sv1", 60);
    expect(
      within(row).getByRole("button", { name: "Review now" }),
    ).toBeInTheDocument();
  });

  it("the revealed options dispatch the same actions as a review row", async () => {
    const { keepAsTask } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[saved()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("stored thing").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "stored thing" }));
    await user.click(within(row).getByRole("button", { name: "Add to-do" }));
    expect(keepAsTask).toHaveBeenCalledWith("sv1");
  });

  it("Delete in the options uses the two-step confirm", async () => {
    const { deleteBrainDumpItem: del } =
      await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[saved()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("stored thing").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "stored thing" }));
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(del).not.toHaveBeenCalled(); // first click only reveals confirm
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(del).toHaveBeenCalledWith("sv1");
  });
});

describe("InboxView — 📅 row scheduling (Task 5)", () => {
  const connected = {
    configured: true,
    connected: true,
    needsReconnect: false,
  };

  it("multi-step row with steps: 📅 pushes steps via pushStepsToGoogleTasks(taskId)", async () => {
    const { pushStepsToGoogleTasks } =
      await import("@/app/actions/google-schedule");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeMultiStep()]}
        settings={settings}
        google={connected}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("plan trip").closest("li")!;
    expect(
      within(row).getByRole("button", { name: /schedule/i }),
    ).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: /schedule/i }));
    expect(pushStepsToGoogleTasks).toHaveBeenCalledWith("t1");
  });

  it("single-task row: 📅 opens the popover; picking 30 min calls scheduleSingleTask(itemId, 30)", async () => {
    const { scheduleSingleTask } =
      await import("@/app/actions/google-schedule");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[
          makeItem({ id: "st1", text: "single todo", status: "triaged" }),
        ]}
        settings={settings}
        google={connected}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("single todo").closest("li")!;
    await user.click(within(row).getByRole("button", { name: /schedule/i }));
    await user.click(within(row).getByRole("button", { name: /^30 min$/i }));
    expect(scheduleSingleTask).toHaveBeenCalledWith("st1", 30);
  });

  it("an awaiting-breakdown (0-step) multi-step row uses the duration popover, not pushSteps", async () => {
    const { scheduleSingleTask, pushStepsToGoogleTasks } =
      await import("@/app/actions/google-schedule");
    const user = userEvent.setup();
    const awaiting = makeItem({
      id: "aw1",
      text: "needs a plan",
      status: "triaged",
      breakdownRequestedAt: new Date(),
      stepsTotal: 0,
    });
    render(
      <InboxView
        initialItems={[awaiting]}
        settings={settings}
        google={connected}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("needs a plan").closest("li")!;
    await user.click(within(row).getByRole("button", { name: /schedule/i }));
    await user.click(within(row).getByRole("button", { name: /^15 min$/i }));
    expect(scheduleSingleTask).toHaveBeenCalledWith("aw1", 15);
    expect(pushStepsToGoogleTasks).not.toHaveBeenCalled();
  });

  it("v5 NEW: a needs-review row is now schedulable — 📅 opens the popover; picking 30 min calls scheduleSingleTask(itemId, 30)", async () => {
    const { scheduleSingleTask } =
      await import("@/app/actions/google-schedule");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "n1", text: "capture me" })]}
        settings={settings}
        google={connected}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    expect(
      within(row).getByRole("button", { name: /schedule/i }),
    ).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: /schedule/i }));
    await user.click(within(row).getByRole("button", { name: /^30 min$/i }));
    expect(scheduleSingleTask).toHaveBeenCalledWith("n1", 30);
  });

  it("v5 NEW: a needs-review row's 📅 failure shows an inline error, same as other rows", async () => {
    const { scheduleSingleTask } =
      await import("@/app/actions/google-schedule");
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
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: /schedule/i }));
    await user.click(within(row).getByRole("button", { name: /^30 min$/i }));
    expect(
      await within(row).findByText(/Reclaim-synced Google Tasks list/i),
    ).toBeInTheDocument();
  });

  it("S0 guest (google={null}): rows show an ENABLED 'Add to calendar' control per row (not hidden, not disabled)", () => {
    render(
      <InboxView
        initialItems={[
          makeMultiStep(),
          makeItem({ id: "st1", text: "single todo", status: "triaged" }),
        ]}
        settings={settings}
        google={null}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    // S0 (#29): guests now schedule via .ics (no Google needed) — there's no
    // "Schedule" control at all; every schedulable row exposes an enabled
    // "Add to calendar" affordance instead of the old guest-locked 📅.
    expect(screen.queryByRole("button", { name: /^schedule$/i })).toBeNull();
    const icsButtons = screen.getAllByRole("button", {
      name: /add to calendar/i,
    });
    expect(icsButtons.length).toBeGreaterThanOrEqual(2); // one 📅 per row (menus closed)
    icsButtons.forEach((b) => expect(b).toBeEnabled());
  });

  it("S0 guest: the ▾ dropdown also carries an 'Add to calendar' entry (enabled)", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[
          makeItem({ id: "st1", text: "single todo", status: "triaged" }),
        ]}
        settings={settings}
        google={null}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("single todo").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    const icsEntries = within(row).getAllByRole("button", {
      name: /add to calendar/i,
    });
    expect(icsEntries).toHaveLength(2); // inline 📅 + full-text menu mirror
    icsEntries.forEach((b) => expect(b).toBeEnabled());
  });

  it("needsReconnect: rows show the Reconnect link instead of the 📅 button", () => {
    const needsReconnect = {
      configured: true,
      connected: false,
      needsReconnect: true,
    };
    render(
      <InboxView
        initialItems={[
          makeMultiStep(),
          makeItem({ id: "st1", text: "single todo", status: "triaged" }),
        ]}
        settings={settings}
        google={needsReconnect}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    expect(screen.queryByRole("button", { name: /schedule/i })).toBeNull();
    expect(
      screen.getAllByRole("link", { name: /reconnect google/i }),
    ).toHaveLength(2);
  });

  it("not configured: rows show the Connect link instead of the 📅 button", () => {
    const notConfigured = {
      configured: false,
      connected: false,
      needsReconnect: false,
    };
    render(
      <InboxView
        initialItems={[
          makeItem({ id: "st1", text: "single todo", status: "triaged" }),
        ]}
        settings={settings}
        google={notConfigured}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    expect(
      screen.getByRole("link", { name: /connect google/i }),
    ).toBeInTheDocument();
  });

  it("Duo fix: configured but NOT connected → Connect link, not a live 📅 button", () => {
    const configuredNotConnected = {
      configured: true,
      connected: false,
      needsReconnect: false,
    };
    render(
      <InboxView
        initialItems={[
          makeItem({ id: "st1", text: "single todo", status: "triaged" }),
        ]}
        settings={settings}
        google={configuredNotConnected}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    expect(
      screen.getByRole("link", { name: /connect google/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /schedule/i })).toBeNull();
  });

  it("a reconnect_required push failure swaps the row's control to the Reconnect link", async () => {
    const { pushStepsToGoogleTasks } =
      await import("@/app/actions/google-schedule");
    (pushStepsToGoogleTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: "reconnect_required",
    });
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeMultiStep()]}
        settings={settings}
        google={connected}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("plan trip").closest("li")!;
    await user.click(within(row).getByRole("button", { name: /schedule/i }));
    expect(
      await within(row).findByRole("link", { name: /reconnect google/i }),
    ).toBeInTheDocument();
  });

  it("a reconnect_required response clears a stale schedule error left on another row (Duo review)", async () => {
    const { scheduleSingleTask, pushStepsToGoogleTasks } =
      await import("@/app/actions/google-schedule");
    (scheduleSingleTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: "no_reclaim_list",
    });
    (pushStepsToGoogleTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: "reconnect_required",
    });
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[
          makeItem({ id: "st1", text: "single todo", status: "triaged" }),
          makeMultiStep(),
        ]}
        settings={settings}
        google={connected}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    // Row A (single to-do) fails with an inline error.
    const rowA = screen.getByText("single todo").closest("li")!;
    await user.click(within(rowA).getByRole("button", { name: /schedule/i }));
    await user.click(within(rowA).getByRole("button", { name: /^30 min$/i }));
    expect(
      await within(rowA).findByText(/Reclaim-synced Google Tasks list/i),
    ).toBeInTheDocument();
    // Row B (multi-step) then hits the workspace-wide reconnect_required condition.
    const rowB = screen.getByText("plan trip").closest("li")!;
    await user.click(within(rowB).getByRole("button", { name: /schedule/i }));
    await within(rowB).findByRole("link", { name: /reconnect google/i });
    // Row A's now-stale error must not sit beside a Reconnect prompt.
    expect(
      within(rowA).queryByText(/Reclaim-synced Google Tasks list/i),
    ).not.toBeInTheDocument();
  });

  it("a scheduleSingleTask failure shows an inline error message under the row", async () => {
    const { scheduleSingleTask } =
      await import("@/app/actions/google-schedule");
    (scheduleSingleTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: "no_reclaim_list",
    });
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[
          makeItem({ id: "st1", text: "single todo", status: "triaged" }),
        ]}
        settings={settings}
        google={connected}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("single todo").closest("li")!;
    await user.click(within(row).getByRole("button", { name: /schedule/i }));
    await user.click(within(row).getByRole("button", { name: /^30 min$/i }));
    expect(
      await within(row).findByText(/Reclaim-synced Google Tasks list/i),
    ).toBeInTheDocument();
  });

  it("prefers the action's own message over the generic dictionary copy (Task 6 controller fix)", async () => {
    const { pushStepsToGoogleTasks } =
      await import("@/app/actions/google-schedule");
    (pushStepsToGoogleTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: "no_reclaim_list",
      message:
        'Couldn\'t find a Google Tasks list matching "Reclaim". Available: Personal, Work.',
    });
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeMultiStep()]}
        settings={settings}
        google={connected}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("plan trip").closest("li")!;
    await user.click(within(row).getByRole("button", { name: /schedule/i }));
    // The detailed "available lists" message wins over the generic dictionary
    // copy for the same reason ("Couldn't find your Reclaim-synced...").
    expect(
      await within(row).findByText(/Available: Personal, Work/),
    ).toBeInTheDocument();
    expect(
      within(row).queryByText(/Couldn't find your Reclaim-synced/),
    ).not.toBeInTheDocument();
  });
});

describe("InboxView — ICS 'Add to calendar' (S0 #29)", () => {
  it("guest single-task row shows an enabled 'Add to calendar' that schedules via ICS + downloads", async () => {
    render(
      <InboxView
        initialItems={[
          makeItem({
            id: "s1",
            text: "Call dentist",
            status: "triaged",
            taskId: "t-s1",
            stepsTotal: 0,
          }),
        ]}
        settings={settings}
        google={null}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const user = userEvent.setup();
    const btn = screen.getByRole("button", { name: /add to calendar/i });
    expect(btn).toBeEnabled();
    await user.click(btn);
    await user.click(screen.getByRole("button", { name: /^30 min$/i }));
    await waitFor(() =>
      expect(scheduleViaIcsMock).toHaveBeenCalledWith("t-s1", {
        durationMin: 30,
      }),
    );
    expect(downloadIcsMock).toHaveBeenCalledWith(
      "BEGIN:VCALENDAR",
      "dlectroflow-x.ics",
    );
  });

  it("owner ▾ menu offers 'Add to calendar (.ics)' as an alternative to Google", async () => {
    render(
      <InboxView
        initialItems={[
          makeItem({
            id: "s1",
            status: "triaged",
            taskId: "t-s1",
            stepsTotal: 0,
          }),
        ]}
        settings={settings}
        google={{ configured: true, connected: true, needsReconnect: false }}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "All options" }));
    expect(
      screen.getByRole("button", { name: /add to calendar/i }),
    ).toBeInTheDocument();
  });

  it("shows a 'Scheduled ✓' indicator on a row whose task has been scheduled", () => {
    render(
      <InboxView
        initialItems={[
          makeItem({
            id: "s1",
            status: "triaged",
            taskId: "t-s1",
            stepsTotal: 0,
            scheduledAt: new Date(),
          }),
        ]}
        settings={settings}
        google={null}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    expect(screen.getByText(/scheduled ✓/i)).toBeInTheDocument();
  });
  it("no 'Scheduled ✓' indicator when scheduledAt is null", () => {
    render(
      <InboxView
        initialItems={[
          makeItem({
            id: "s1",
            status: "triaged",
            taskId: "t-s1",
            stepsTotal: 0,
          }),
        ]}
        settings={settings}
        google={null}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    expect(screen.queryByText(/scheduled ✓/i)).toBeNull();
  });
});

describe("InboxView — needs-review rows adopt the v6 inline-actions frame", () => {
  it("renders SHORT inline buttons: Break into steps, Add to-do, Save, Complete (full labels live in ▾)", () => {
    render(
      <InboxView
        initialItems={[makeItem({ id: "n1", text: "capture me" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    expect(
      within(row).getByRole("button", { name: /Break into steps/ }),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: "Add to-do" }),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: "Save" }),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: "✓ Complete" }),
    ).toBeInTheDocument();
    // The full "Save for later" is the dropdown mirror, not an inline button.
    expect(
      within(row).queryByRole("button", { name: "Save for later" }),
    ).not.toBeInTheDocument();
  });

  it("v6: shows a 📥 Move-to icon (aria 'Move to') in the end cluster, distinct from the ▾ 'Move to…' entry", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "n1", text: "capture me" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    expect(
      within(row).getByRole("button", { name: "Move to" }),
    ).toBeInTheDocument();
    expect(
      within(row).queryByRole("button", { name: "Move to…" }),
    ).not.toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "All options" }));
    expect(
      within(row).getByRole("button", { name: "Move to…" }),
    ).toBeInTheDocument();
  });

  it("v6: with Google connected, the ▾ menu adds a full-text 'Schedule' entry alongside the 📅 icon", async () => {
    const user = userEvent.setup();
    const connected = {
      configured: true,
      connected: true,
      needsReconnect: false,
    };
    render(
      <InboxView
        initialItems={[makeItem({ id: "n1", text: "capture me" })]}
        settings={settings}
        google={connected}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    expect(
      within(row).getAllByRole("button", { name: "Schedule" }),
    ).toHaveLength(1); // 📅 icon only
    await user.click(within(row).getByRole("button", { name: "All options" }));
    expect(
      within(row).getAllByRole("button", { name: "Schedule" }),
    ).toHaveLength(2); // + full-text menu entry
  });

  it("clicking Add as single to-do (Keep-as-task) fires directly, no menu involved", async () => {
    const { keepAsTask } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "n1", text: "capture me" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Add to-do" }));
    expect(keepAsTask).toHaveBeenCalledWith("n1");
  });

  it("clicking the inline 'Save' is a direct MOVE to the Saved bucket via the shared dispatcher", async () => {
    const { snoozeBrainDumpItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "n1", text: "capture me" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Save" }));
    // The move went through moveItemToBucket → dropPlan(needsReview → savedLater)…
    expect(dropPlan).toHaveBeenCalledWith("needsReview", "savedLater");
    // …whose savedLater action lands the item in the Saved bucket
    // (ACTION_FOR_BUCKET.savedLater — snooze is how Saved membership is stored).
    expect(snoozeBrainDumpItem).toHaveBeenCalledWith("n1", 60);
  });

  it("the ▾ menu's full-label 'Save for later' dispatches the same Saved-bucket move as the inline 'Save'", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "n1", text: "capture me" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    // Inline short button is "Save"; the dropdown carries the full "Save for later".
    expect(
      within(row).getByRole("button", { name: "Save" }),
    ).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(
      within(row).getByRole("button", { name: "Save for later" }),
    );
    expect(dropPlan).toHaveBeenCalledWith("needsReview", "savedLater");
  });

  it("delete is inline in the end cluster and still requires a two-step confirm", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "n1", text: "capture me" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(deleteBrainDumpItem).toHaveBeenCalledWith("n1");
  });

  it("▾ All options mirrors the actions in full: Move to… (pinned first), full labels, Snooze 1h, Edit task title", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "n1", text: "capture me" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    const menuButtons = within(row).getAllByRole("button");
    const moveToIndex = menuButtons.findIndex(
      (b) => b.textContent === "Move to…",
    );
    expect(moveToIndex).toBeGreaterThan(-1);
    // Move to… is pinned first; the next entry is the FULL-label breakdown.
    expect(menuButtons[moveToIndex + 1]).toHaveTextContent(
      /Break into smaller steps/,
    );
    expect(
      within(row).getByRole("button", { name: "Snooze 1h" }),
    ).toBeInTheDocument();
    // v6: the dropdown edit entry is the text "Edit task title"; the ✏️ pencil
    // beside the title stays (aria-label "Edit capture me").
    expect(
      within(row).getByRole("button", { name: "Edit task title" }),
    ).toBeInTheDocument();
    expect(
      within(row).getAllByRole("button", { name: "Edit capture me" }),
    ).toHaveLength(1);
  });

  it("Snooze 1h in the ▾ menu is a SEPARATE direct snooze — it does not go through the move dispatcher", async () => {
    const { snoozeBrainDumpItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        initialItems={[makeItem({ id: "n1", text: "capture me" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(within(row).getByRole("button", { name: "Snooze 1h" }));
    expect(snoozeBrainDumpItem).toHaveBeenCalledWith("n1", 60);
    expect(dropPlan).not.toHaveBeenCalled();
  });
});

// Task 3 (Phase 5, #8) — first-run welcome card + resume banner, wired from
// the Inbox page's computed welcomeVisible/resumeStep props.
describe("InboxView — welcome card (Task 3, #8)", () => {
  it("welcomeVisible=true renders the WelcomeCard above the rest of the inbox", () => {
    render(
      <InboxView
        initialItems={[]}
        settings={settings}
        welcomeVisible={true}
        resumeStep={null}
      />,
    );
    expect(screen.getByRole("region", { name: "Welcome" })).toBeInTheDocument();
    expect(
      screen.getByText(/Welcome to dlectroflow, you are in the inbox/),
    ).toBeInTheDocument();
  });

  it("welcomeVisible=false renders no WelcomeCard", () => {
    render(
      <InboxView
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    expect(
      screen.queryByRole("region", { name: "Welcome" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("👋 Welcome to dlectroflow"),
    ).not.toBeInTheDocument();
  });
});

describe("InboxView — resume banner (Task 3, #8)", () => {
  it("resumeStep set renders a status banner with the step text + a resume link to /focus/<id>", () => {
    render(
      <InboxView
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={{ id: "step-42", text: "draft the outline" }}
      />,
    );
    // dnd-kit's own live region also has role="status", so scope from the
    // resume link (unique) up to its containing banner rather than
    // getByRole("status") directly.
    const link = screen.getByRole("link", { name: /resume/i });
    expect(link).toHaveAttribute("href", "/focus/step-42");
    const banner = link.closest('[role="status"]');
    expect(banner).not.toBeNull();
    expect(banner).toHaveTextContent(/draft the outline/);
    expect(banner).toHaveTextContent(/Paused focus step/);
  });

  it("resumeStep=null renders no resume banner", () => {
    render(
      <InboxView
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    expect(screen.queryByText(/Paused focus step/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /resume/i }),
    ).not.toBeInTheDocument();
  });
});
