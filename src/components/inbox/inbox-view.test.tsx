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
import {
  InboxView,
  dragEndToMove,
  DragGhostRow,
} from "@/components/inbox/inbox-view";
import type { Item } from "@/components/inbox/bucket";
import { SchedulePriority, ScheduleHours } from "@/lib/scheduling/types";
import type { AgingSettings } from "@/lib/aging";
import { UserRole } from "@/lib/constants";
import { VoiceProvider } from "@/components/voice-provider";

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
// #44 — the rows mount the note disclosure, so its actions must exist.
vi.mock("@/app/actions/task-notes", () => ({
  updateTaskNotes: vi
    .fn()
    .mockImplementation(async (_id: string, notes: string | null) => ({
      ok: true,
      notes,
    })),
}));
vi.mock("@/app/actions/step-notes", () => ({
  updateStepNotes: vi
    .fn()
    .mockImplementation(async (_id: string, notes: string | null) => ({
      ok: true,
      notes,
    })),
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

beforeEach(async () => {
  vi.clearAllMocks();
  // #168 — re-arm the two Google actions from scratch, because
  // `vi.clearAllMocks()` clears recorded calls but NOT the
  // `mockResolvedValueOnce` queue. Any spec that queues a once-value and then
  // fails to trigger the call leaves it behind, and the NEXT spec to touch that
  // mock consumes it instead of its own. That is what turned one dropped press
  // into two red specs on ccbc8dc: the second failure reported a Reconnect link
  // for a response it had mocked as `no_reclaim_list`, which sends anyone
  // reading it to the wrong test. `mockReset()` is the part that drops the
  // queue; the defaults then have to be restored, since it clears those too.
  const { pushStepsToGoogleTasks, scheduleSingleTask } =
    await import("@/app/actions/google-schedule");
  const push = pushStepsToGoogleTasks as ReturnType<typeof vi.fn>;
  const single = scheduleSingleTask as ReturnType<typeof vi.fn>;
  push.mockReset();
  push.mockResolvedValue({ ok: true, scheduled: 1, listTitle: "Reclaim" });
  single.mockReset();
  single.mockResolvedValue({ ok: true });
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
  //
  // #163 changed what the grip *is* — no longer a `<button>`, because there is
  // no keyboard drag for it to activate — but not its size, which is a pointer
  // concern (2.5.8) and unaffected. Queried by `data-drag-grip` for that
  // reason; why it left the accessibility tree is pinned in
  // `inbox-view.drag.test.tsx`.
  it("design revision: the drag grip stays an adequate hit target (≥24px wide, 44px tall)", () => {
    const { container } = render(
      <InboxView
        now={Date.now()}
        initialItems={[makeItem({ id: "g1", text: "grip row" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const grip = container.querySelector<HTMLElement>('[data-drag-grip="g1"]');
    expect(grip, "no drag grip rendered").not.toBeNull();
    expect(grip!.className).toContain("min-h-11"); // 44px tall
    expect(grip!.className).toContain("w-7"); // 28px wide (≥ WCAG-AA 24px min)
  });

  // #52 — the age/status pill moves off the title line down to the metadata
  // line, sitting alongside "captured x ago" (not competing with the title).
  it("#52: the age/status pill sits on the metadata line with captured-ago, not on the title line", () => {
    render(
      <InboxView
        now={Date.now()}
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

  // #57 a11y: the aging "captured x ago" label uses the AA-tuned per-theme
  // amber pairing (matching status-pill's aging tier), not the flat
  // `text-amber-600` that dropped to 3:1 on the #40 warm light background. This
  // only renders once a row ages — surfaced by the axe scan of a stale row that
  // now carries the #57 nudge (the gate otherwise scans only fresh items).
  it("#57: an aging row's captured-ago label uses AA-tuned amber (not sub-AA text-amber-600)", () => {
    render(
      <InboxView
        now={Date.now()}
        initialItems={[
          makeItem({
            id: "age1",
            text: "aging thing",
            createdAt: new Date(Date.now() - 100 * 3600_000), // aging
          }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const captured = screen.getByText(/captured/);
    expect(captured.className).toContain("text-amber-700");
    expect(captured.className).toContain("dark:text-amber-400");
    expect(captured.className).not.toContain("text-amber-600");
  });

  // #57 a11y: the NavBadge "· N aging 🟡" count shares the same flat-amber-600
  // AA failure (2.77:1 on bg-secondary) as the captured-ago label — fixed to
  // the same AA-tuned per-theme pairing. Also only visible with aging items.
  it("#57: the NavBadge aging count uses AA-tuned amber (not sub-AA text-amber-600)", () => {
    render(
      <InboxView
        now={Date.now()}
        initialItems={[
          makeItem({
            id: "age2",
            text: "aging thing",
            createdAt: new Date(Date.now() - 100 * 3600_000), // aging + untriaged
          }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const agingCount = screen.getByText(/aging 🟡/);
    // amber-800 in light here (the badge sits on the more saturated
    // bg-secondary, where amber-700 is only 4.36:1); dark:amber-400 as elsewhere.
    expect(agingCount.className).toContain("text-amber-800");
    expect(agingCount.className).toContain("dark:text-amber-400");
    expect(agingCount.className).not.toContain("text-amber-600");
  });

  // #57 (follow-up to #50) — the stale-reminder is now a tinted "notification
  // chip": a compact rounded row with a soft aging/amber tint + subtle border
  // and a clock icon, so it reads as a notification instead of the muted
  // background-noise text #50 left behind. It must stay subordinate to the
  // text-lg title (no heavy hardcoded-hex box — the #50 lesson) and keep
  // Still-need-it / Dismiss as ≥44px keyboard-operable hit targets.
  it("#57: the stale-reminder is a tinted amber notification chip (clock icon + readable text), still subordinate + keyboard-usable", () => {
    render(
      <InboxView
        now={Date.now()}
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
    const chip = prompt.closest("div")!;
    // Tinted notification chip: reuses the #40 aging/amber token family (the
    // same bg/border/ink the resume-step banner + focus callouts use) in BOTH
    // themes — no invented colors, and none of the old loud hardcoded hex.
    expect(chip.className).toContain("bg-amber-50");
    expect(chip.className).toContain("dark:bg-amber-950/20");
    expect(chip.className).toContain("border-amber-500/40");
    expect(chip.getAttribute("style") ?? "").not.toContain("#c0392b");
    expect(chip.getAttribute("style") ?? "").not.toContain("#fff5f5");
    // Readable, not muted-to-invisible (the #50 over-correction): the nudge
    // carries the amber ink, not text-muted-foreground.
    expect(chip.className).toContain("text-amber-800");
    expect(chip.className).toContain("dark:text-amber-300");
    expect(prompt.className).not.toContain("text-muted-foreground");
    // A clock icon is the notification signal — decorative (aria-hidden), since
    // the text already conveys the meaning (icon/colour is never the only cue).
    const icon = chip.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden", "true");
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
        now={Date.now()}
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

// #111 — the OTHER empty inbox. "Inbox zero" congratulates you for clearing a
// queue; an account that never had one must not be told that something it never
// had is gone. `newAccount` is the resolved identity or null, mirroring
// <AuthActions> — a boolean would let this state render without the account it
// exists to name.
describe("InboxView — brand-new account empty state (#111)", () => {
  const IDENTITY = {
    label: "ada",
    provider: "GitLab",
    role: UserRole.Owner,
  };

  function renderNew(
    props: Partial<React.ComponentProps<typeof InboxView>> = {},
  ) {
    return render(
      <InboxView
        now={Date.now()}
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
        newAccount={IDENTITY}
        {...props}
      />,
    );
  }

  it("names the account instead of congratulating it on inbox zero", () => {
    renderNew();
    expect(
      screen.getByText(
        "Nothing here yet — this is a new account (ada, signed in with GitLab)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Inbox zero. Nothing to review."),
    ).not.toBeInTheDocument();
  });

  it("is voice-aware — playful gets the playful lead, same account clause", () => {
    render(
      <VoiceProvider voice="playful">
        <InboxView
          now={Date.now()}
          initialItems={[]}
          settings={settings}
          welcomeVisible={false}
          resumeStep={null}
          newAccount={IDENTITY}
        />
      </VoiceProvider>,
    );
    expect(
      screen.getByText(
        "🍳 Nothing here yet — this account is brand new (ada, signed in with GitLab)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("🎉 Inbox zero! Nothing to review."),
    ).not.toBeInTheDocument();
  });

  // A GUEST has no account to name and already gets the sandbox banner, so the
  // issue is explicit that their copy is unchanged. `newAccount` is null for
  // them — and null is also what an omitted prop means, so every existing call
  // site keeps today's behaviour.
  it("a guest (newAccount null) keeps the existing inbox.zero copy", () => {
    renderNew({ newAccount: null });
    expect(
      screen.getByText("Inbox zero. Nothing to review."),
    ).toBeInTheDocument();
  });

  // The server only sets `newAccount` for a workspace with nothing in it, but
  // the client can get ahead of the server: capture something and the optimistic
  // re-render has rows while the prop is still set. "This is a new account"
  // alongside the thing you just captured would be nonsense, so the component
  // re-checks rather than trusting the prop alone.
  it("stops claiming 'new account' as soon as the client has any item", () => {
    renderNew({ initialItems: [makeItem({ text: "first ever capture" })] });
    expect(screen.queryByText(/this is a new account/)).not.toBeInTheDocument();
  });

  // The needs-review bucket can be empty while other buckets are not. That is
  // an emptied REVIEW QUEUE on an account with plenty in it — the case
  // inbox.zero is exactly right for.
  it("an account with triaged to-dos and an empty review queue still reads inbox zero", () => {
    renderNew({
      initialItems: [
        makeItem({ id: "t-1", status: "triaged", triagedAt: new Date() }),
      ],
    });
    expect(
      screen.getByText("Inbox zero. Nothing to review."),
    ).toBeInTheDocument();
  });

  // Colour is never the only cue and the node must stay a plain readable
  // paragraph: same element, same tokens as the string it replaces, so the
  // zero-tolerance color-contrast gate sees no new pairing (#90, #99).
  it("reuses the existing empty-state paragraph, tokens and all", () => {
    renderNew();
    const p = screen.getByText(/this is a new account/);
    expect(p.tagName).toBe("P");
    expect(p.className).toContain("text-muted-foreground");
    expect(p.className).toContain("border-dashed");
  });

  // The four bucket placeholders below stay the neutral "Nothing here yet" —
  // repeating the account name five times down one screen would be noise, and
  // "yet" already reads correctly on a new account.
  it("names the account exactly once", () => {
    renderNew();
    expect(screen.getAllByText(/signed in with GitLab/)).toHaveLength(1);
  });
});

describe("InboxView — settings panel moved to /settings", () => {
  it("no longer renders the aging & reminder settings panel on the inbox", () => {
    render(
      <InboxView
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
        initialItems={[makeMultiStep()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    expect(screen.getByText(/3 steps · 1 done/)).toBeInTheDocument();
  });

  // #27 follow-up — task total remaining + (when a step is paused/in
  // progress) that step's own remaining time, shown as a persisted snapshot.
  it("shows the task-total remaining (not-done steps' full estimates, no open session)", () => {
    render(
      <InboxView
        now={Date.now()}
        initialItems={[makeMultiStep()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    // makeMultiStep: s1 done (10m, excluded), s2 not-done 20m, s3 not-done
    // 5m — no open session on either, so the total is their full estimates:
    // 20 + 5 = 25.
    expect(screen.getByText(/≈25\s*min left/)).toBeInTheDocument();
    expect(screen.queryByText(/min on step/)).not.toBeInTheDocument();
  });

  it("a paused/in-progress step's row shows BOTH the shrunk task total and the active-step remaining", () => {
    const paused = makeMultiStep();
    paused.steps = paused.steps.map((s) =>
      s.id === "s2" ? { ...s, openRemainingSec: 6 * 60 } : s,
    ); // s2: 20m estimate, paused with 6m left
    render(
      <InboxView
        now={Date.now()}
        initialItems={[paused]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("plan trip").closest("li")!;
    // Total = 6 (paused s2) + 5 (s3's full estimate) = 11, not the raw 25.
    expect(within(row).getByText(/≈11\s*min left/)).toBeInTheDocument();
    expect(within(row).getByText(/≈6\s*min on step/)).toBeInTheDocument();
  });

  it("expands the inline step list when the row body is tapped", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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

describe("DragGhostRow — mobile drag preview (#62)", () => {
  // Regression coverage note: the real bug is a *browser layout* bug, which
  // jsdom cannot reproduce since getBoundingClientRect always returns zeroes
  // here. These assertions pin the two things we CAN verify statically: the
  // ghost renders the full row text (not just a fragment), and its markup
  // never constrains itself to a fixed narrow width that would force
  // character-by-character wrapping. Final confirmation that the on-screen
  // ghost is no longer clipped needs a real mobile device (see MR).
  //
  // #163 removed the *cause* rather than the symptom. The clipping came from
  // dnd-kit's `DragOverlay` sizing its wrapper to the measured rect of the
  // draggable node — the 28×44 grip, not the row — which the component worked
  // around with an explicit `style={{ width: "auto", height: "auto" }}`. There
  // is no wrapper to size any more: `setCustomNativeDragPreview` mounts this
  // component into a container of its own and the browser photographs that, so
  // the grip's rect is not in the calculation at all. The test that pinned the
  // override went with it; that the preview is a separate, self-sized element
  // is pinned in `inbox-view.drag.test.tsx` instead.
  it("renders the full item text, not truncated", () => {
    render(
      <DragGhostRow text="Test de UI-elementen in de checkout flow grondig" />,
    );
    expect(
      screen.getByText("Test de UI-elementen in de checkout flow grondig"),
    ).toBeInTheDocument();
  });

  it("lets the title wrap normally instead of being squeezed into a fixed narrow column", () => {
    const { container } = render(<DragGhostRow text="A long dragged title" />);
    const card = container.firstElementChild as HTMLElement;
    // Must not carry a fixed/narrow width utility (e.g. the grip's own
    // `w-7`) — that's exactly what crushed the title into a vertical pill.
    expect(card.className).not.toMatch(/\bw-7\b/);
    const title = screen.getByText("A long dragged title");
    // `min-w-0 flex-1` lets the text span take the row's available width
    // instead of shrinking to its content's minimum (one word/char per
    // line); `break-words` allows wrapping only when genuinely needed.
    expect(title.className).toMatch(/min-w-0/);
    expect(title.className).toMatch(/flex-1/);
    expect(title.className).toMatch(/break-words/);
  });
});

describe("InboxView — Move to… menu dispatch", () => {
  it("a single-task 'Move to Completed' completes the item", async () => {
    const { completeItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
        initialItems={[makeItem({ id: "s1", text: "todo", status: "triaged" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("todo").closest("li")!;
    // Move to… now lives inside the row's ⋯ overflow menu.
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(
      await within(row).findByRole("button", { name: "Move to…" }),
    );
    await user.click(
      await within(row).findByRole("menuitem", { name: /Completed/ }),
    );
    expect(completeItem).toHaveBeenCalledWith("s1");
  });

  it("a single-task 'Move to Needs review' un-triages via moveToReview", async () => {
    const { moveToReview } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
        initialItems={[makeItem({ id: "s1", text: "todo", status: "triaged" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("todo").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(
      await within(row).findByRole("button", { name: "Move to…" }),
    );
    await user.click(
      await within(row).findByRole("menuitem", { name: /Needs review/ }),
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
        now={Date.now()}
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
      await within(row).findByRole("menuitem", { name: /Single-task/ }),
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
        now={Date.now()}
        initialItems={[makeItem({ id: "n1", text: "big thing" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("big thing").closest("li")!;
    // Move to… now lives inside the needs-review row's ⋯ overflow menu too.
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(
      await within(row).findByRole("button", { name: "Move to…" }),
    );
    await user.click(
      await within(row).findByRole("menuitem", { name: /Multi-step/ }),
    );
    expect(requestBreakdown).toHaveBeenCalledWith("n1");
    // The editor only opens from the row's "Break into steps now?" CTA.
    expect(startBreakdown).not.toHaveBeenCalled();
    // Dismiss the row's own 🔽 popover first — since #92 it is a `dialog`, so
    // leaving it open would make the "no editor opened" check below pass or
    // fail for the wrong reason.
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
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
        now={Date.now()}
        initialItems={[done]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("finished big thing").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Move to" }));
    await user.click(
      await within(row).findByRole("menuitem", { name: /Multi-step/ }),
    );
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
        initialItems={[awaiting()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("needs a plan").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(
      await within(row).findByRole("button", { name: "Move to…" }),
    );
    await user.click(
      await within(row).findByRole("menuitem", { name: /Single-task/ }),
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
        initialItems={[saved()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("stored thing").closest("li")!;
    // #56: the idle dim lives on the title line, not the row/CTA.
    const titleLine = within(row)
      .getByRole("button", { name: "stored thing" })
      .closest("div")!;
    expect(titleLine.className).toContain("opacity-70"); // idle = title dimmed
    expect(row.className).not.toContain("opacity-70"); // …never the row/CTA

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
    // reviewing = looks active: the title dim is lifted too.
    expect(
      within(row).getByRole("button", { name: "stored thing" }).closest("div")!
        .className,
    ).not.toContain("opacity-70");
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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

describe("InboxView — saved-for-later idle CTA contrast (#56)", () => {
  const saved = () =>
    makeItem({
      id: "sv1",
      text: "stored thing",
      snoozedUntil: new Date(Date.now() + 60 * 60_000),
    });

  // #56: the idle saved-for-later row was dimmed with `opacity-70` on the whole
  // <li>, which composited the bg-primary "Review now" CTA below WCAG-AA
  // (~3.3:1 light / ~3.6:1 dark against its background; needs 4.5:1). The fix
  // moves the dim onto the title/metadata line only, so the CTA keeps its full
  // 5.41:1 (light) / 6.32:1 (dark). jsdom can't compute real contrast (no
  // CSS-variable resolution — see library-tab-pill.test.tsx), so the WCAG
  // number itself is asserted in the axe gate (e2e/a11y-contrast.spec.ts, on a
  // seeded saved-later idle row); this test locks the DOM contract so the
  // failing row-level opacity can't come back.
  it("keeps the idle 'Review now' CTA free of any ancestor opacity dim", () => {
    render(
      <InboxView
        now={Date.now()}
        initialItems={[saved()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const cta = screen.getByRole("button", { name: "Review now" });
    // Walk from the CTA up to its bucket <ul>: no element on the path may carry
    // an `opacity-*` utility, which would composite the accent CTA below AA.
    // (`hover:opacity-90` on the CTA itself is fine — it is not a static dim,
    // and the leading `:` means it never matches this whitespace-anchored regex.)
    for (
      let el: HTMLElement | null = cta;
      el && el.tagName !== "UL";
      el = el.parentElement
    ) {
      expect(el.className).not.toMatch(/(^|\s)opacity-\d/);
    }
    // …and it still carries the full-contrast brand-token pairing.
    expect(cta.className).toContain("bg-primary");
    expect(cta.className).toContain("text-primary-foreground");
  });

  it("still dims the idle title line so the row reads as 'asleep'", () => {
    render(
      <InboxView
        now={Date.now()}
        initialItems={[saved()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const titleLine = screen
      .getByRole("button", { name: "stored thing" })
      .closest("div")!;
    expect(titleLine.className).toContain("opacity-70");
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
        now={Date.now()}
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
    // No `scheduleIntents` prop here, so the row keeps its pre-#106 immediate
    // behaviour: undefined is the absence of a choice, and the action falls back
    // to the shared defaults. The menu path is covered in row-actions.test.tsx
    // and end to end in e2e/smoke/schedule-menu.spec.ts.
    expect(pushStepsToGoogleTasks).toHaveBeenCalledWith("t1", undefined);
  });

  // #106 — the primary surface: with the page's server-resolved prefill in hand,
  // 📅 asks first and the push carries what the owner chose.
  it("multi-step row with a resolved intent: 📅 opens the Schedule menu and pushes the choice", async () => {
    const { pushStepsToGoogleTasks } =
      await import("@/app/actions/google-schedule");
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
        initialItems={[makeMultiStep()]}
        settings={settings}
        google={connected}
        scheduleIntents={{
          t1: {
            dueAt: new Date(Date.now() + 3 * 24 * 60 * 60_000),
            priority: SchedulePriority.Critical,
            hours: ScheduleHours.Personal,
            busy: true,
            units: [
              { id: "s1", order: 1, total: 1, text: "book", estMinutes: 10 },
            ],
          },
        }}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("plan trip").closest("li")!;
    await user.click(within(row).getByRole("button", { name: /schedule/i }));

    // Portaled into the row, so a row-scoped query still finds it.
    const dialog = within(row).getByRole("dialog", { name: /plan trip/i });
    expect(pushStepsToGoogleTasks).not.toHaveBeenCalled();
    expect(within(dialog).getByLabelText(/priority/i)).toHaveValue("critical");
    expect(
      within(dialog).getByRole("radio", { name: /personal/i }),
    ).toBeChecked();

    await user.click(
      within(dialog).getByRole("button", { name: /^schedule$/i }),
    );
    expect(pushStepsToGoogleTasks).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ priority: "critical", hours: "personal" }),
    );
  });

  it("single-task row: 📅 opens the popover; picking 30 min calls scheduleSingleTask(itemId, 30)", async () => {
    const { scheduleSingleTask } =
      await import("@/app/actions/google-schedule");
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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

  it("holds only the scheduling row's own control while its push is in flight (#169)", async () => {
    // The spec !265 landed, turned round. That one pinned the shared flag as
    // OBSERVED behaviour and said so in as many words — "not as correct
    // behaviour — #169" — so fixing #169 means inverting it, not deleting it:
    // the same scenario, the opposite expectation, and the #168 trap it
    // documented removed at the source rather than merely renamed.
    //
    // What survives unchanged is the guard the prop was written for. Row A's
    // own control is still held while row A's push is in flight, which is all
    // double-submit protection ever needed. What goes is the reach: `pending`
    // used to come from ONE `useTransition` shared by every action in the list,
    // so 20 call sites through the generic `run()` — rename, complete, snooze,
    // delete, dismissPrompt — disabled every Schedule button in the list.
    //
    // Holding the action's promise unresolved makes the in-flight window real
    // rather than a race (the technique !237, !264 and !265 used).
    const { scheduleSingleTask, pushStepsToGoogleTasks } =
      await import("@/app/actions/google-schedule");
    let release!: (value: { ok: true }) => void;
    (scheduleSingleTask as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise<{ ok: true }>((resolve) => {
        release = resolve;
      }),
    );
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
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
    const rowA = screen.getByText("single todo").closest("li")!;
    const rowB = screen.getByText("plan trip").closest("li")!;
    const scheduleB = within(rowB).getByRole("button", { name: /schedule/i });
    expect(scheduleB).toBeEnabled();

    await user.click(within(rowA).getByRole("button", { name: /schedule/i }));
    await user.click(within(rowA).getByRole("button", { name: /^30 min$/i }));

    // Row A's own control: held, and it says why rather than going quietly
    // grey — a disabled button swallows a press with no error and no toast.
    const scheduleA = within(rowA).getByRole("button", { name: /schedule/i });
    expect(scheduleA).toBeDisabled();
    expect(scheduleA).toHaveAccessibleName(/already in progress for this row/i);

    // Row B: never a party to row A's push, so its press must land.
    expect(scheduleB).toBeEnabled();
    await user.click(scheduleB);
    expect(pushStepsToGoogleTasks).toHaveBeenCalledWith("t1", undefined);

    // Settle the transition before returning. An unresolved action outliving
    // the spec fires its state update during or after `afterEach(cleanup)`,
    // which is the same class of nondeterminism this file is removing — raised
    // by GitLab Duo on !264 and it applies verbatim here. The control becoming
    // live again is the observable end of the transition, so waiting on it
    // needs no arbitrary timeout.
    release({ ok: true });
    await waitFor(() => expect(scheduleA).toBeEnabled());
  });

  it("renaming a row disables no Schedule control at all — the live half of #169", async () => {
    // The production defect, driven through the exact path a user takes.
    //
    // `pending` came from one `useTransition` shared by every action in the
    // list while ONLY the Schedule controls read it, so renaming a row — which
    // has nothing to do with scheduling, and no workspace-wide argument covers
    // — greyed out the 📅 button on that row AND on every other row for the
    // length of the round trip. A press landing in that window was discarded
    // with no error, no toast and no visual explanation beyond a briefly grey
    // control the user probably was not looking at. Completing, snoozing,
    // deleting and dismissing a freshness prompt all did the same.
    //
    // Rename is the case with no defensible reading whatsoever, which is why it
    // is the one pinned here.
    const { renameItem } = await import("@/app/actions/braindump");
    const { pushStepsToGoogleTasks } =
      await import("@/app/actions/google-schedule");
    let release!: () => void;
    (renameItem as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = () => resolve();
      }),
    );
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
        initialItems={[
          makeItem({ id: "r1", text: "old name" }),
          makeMultiStep(),
        ]}
        settings={settings}
        google={connected}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const rowB = screen.getByText("plan trip").closest("li")!;
    const scheduleB = within(rowB).getByRole("button", { name: /schedule/i });
    expect(scheduleB).toBeEnabled();

    const rowA = screen.getByText("old name").closest("li")!;
    await user.click(
      within(rowA).getByRole("button", { name: "Edit old name" }),
    );
    const input = screen.getByRole("textbox", { name: "Edit title" });
    await user.clear(input);
    await user.type(input, "new name{Enter}");
    expect(renameItem).toHaveBeenCalledWith("r1", "new name");

    // The rename is still in flight. No Schedule control is a party to it —
    // not the renaming row's, and certainly not another row's. (The title
    // itself still reads "old name": there is no optimistic update, the row
    // re-reads from the server on `router.refresh()`.)
    const renamingRow = screen.getByText("old name").closest("li")!;
    expect(
      within(renamingRow).getByRole("button", { name: /schedule/i }),
    ).toBeEnabled();
    expect(scheduleB).toBeEnabled();

    // And the press that used to vanish now lands.
    await user.click(scheduleB);
    expect(pushStepsToGoogleTasks).toHaveBeenCalledWith("t1", undefined);

    // Settle the held rename before returning, for the !264 reason above.
    await act(async () => {
      release();
    });
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
        now={Date.now()}
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
    const scheduleB = within(rowB).getByRole("button", { name: /schedule/i });
    // This used to be `await waitFor(() => expect(scheduleB).toBeEnabled())`,
    // carrying a long comment about row A's in-flight action disabling row B's
    // button through ONE shared `useTransition`. **#169 deleted that behaviour**,
    // so the comment described a world that no longer exists and the `waitFor`
    // resolved on its first tick — a guard that guarded nothing, wearing the
    // explanation of a real bug. Raised by an independent review of !278.
    //
    // Inverted into the assertion the fix actually earns: row B is enabled
    // ALREADY, with no waiting, because row A's schedule is none of its
    // business. A plain `expect` rather than a `waitFor` on purpose — `waitFor`
    // would pass again if the shared flag ever came back, and being unable to
    // regress silently is the whole point.
    expect(scheduleB).toBeEnabled();
    await user.click(scheduleB);
    // One `waitFor` for both halves, deliberately: row A's now-stale error must
    // not sit beside a Reconnect prompt, and a bare `queryByText(...).not.
    // toBeInTheDocument()` cannot tell "already cleared" from "not rendered
    // yet". Wrapping only the negative half would not help either — it passes
    // on the first tick whether or not the clear has happened. Asserting the
    // Reconnect link's presence and the error's absence in the SAME callback is
    // what makes the absence mean something: it is retried until both hold at
    // one instant (#168).
    await waitFor(() => {
      expect(
        within(rowB).getByRole("link", { name: /reconnect google/i }),
      ).toBeInTheDocument();
      expect(
        within(rowA).queryByText(/Reclaim-synced Google Tasks list/i),
      ).not.toBeInTheDocument();
    });
  });

  // #169's `finally` is the reason a rejected schedule does not strand the row
  // disabled forever, and nothing tested it — `mockRejected` appears in 34
  // files across `src/` and zero times in this one, so both `catch` blocks the
  // fix introduced had no coverage at all. Raised by an independent review of
  // !278. A THROWN action, not an `{ ok: false }` result: the resolved-but-failed
  // path is already covered below, and it never reaches the `catch`.
  it("re-enables the row after a schedule that throws, not just one that fails", async () => {
    const { scheduleSingleTask } =
      await import("@/app/actions/google-schedule");
    (scheduleSingleTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("network died mid-push"),
    );
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
        initialItems={[
          makeItem({ id: "thr1", text: "single todo", status: "triaged" }),
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

    // The control comes back. Without the `finally` this row would be dead for
    // the rest of the session with no error and no way to retry — strictly
    // worse than the bug #169 fixed, because that one at least cleared.
    await waitFor(() =>
      expect(
        within(row).getByRole("button", { name: /schedule/i }),
      ).toBeEnabled(),
    );

    // And it is genuinely usable again, not merely un-disabled.
    await user.click(within(row).getByRole("button", { name: /schedule/i }));
    expect(
      within(row).getByRole("button", { name: /^30 min$/i }),
    ).toBeInTheDocument();
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
        now={Date.now()}
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
        now={Date.now()}
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
    //
    // Both halves in one `waitFor`, for the reason spelled out on the
    // reconnect_required spec above: the two strings are alternatives for the
    // same slot, so "the generic copy is absent" only carries information at an
    // instant where the specific one is present (#168).
    await waitFor(() => {
      expect(
        within(row).getByText(/Available: Personal, Work/),
      ).toBeInTheDocument();
      expect(
        within(row).queryByText(/Couldn't find your Reclaim-synced/),
      ).not.toBeInTheDocument();
    });
  });
});

describe("InboxView — ICS 'Add to calendar' (S0 #29)", () => {
  it("guest single-task row shows an enabled 'Add to calendar' that schedules via ICS + downloads", async () => {
    render(
      <InboxView
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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
        now={Date.now()}
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

// ── #44 — the note affordance at the TASK grain in the Inbox ────────────────
//
// The Inbox got step notes with #44's first pass (through the expanded
// <TaskSteps>) and no task note. Same class of gap the owner found in the
// Library: a surface that renders a task and offers no way to annotate it.
// A component test cannot see this — only a test that renders the SURFACE can.
describe("InboxView — the task note (#44)", () => {
  const render1 = (item: Item) =>
    render(
      <InboxView
        now={Date.now()}
        initialItems={[item]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );

  it("offers a note on a task-backed to-do row, named after the task", () => {
    render1(
      makeItem({
        id: "s1",
        text: "Renew the passport",
        status: "triaged",
        triagedAt: new Date(),
        taskId: "t1",
      }),
    );
    expect(
      screen.getByRole("button", { name: "Note for Renew the passport" }),
    ).toBeTruthy();
  });

  it("offers no note on an untriaged item with no Task behind it", () => {
    // A brain-dump item in Needs review has no `Task` row yet, so there is no
    // `notes` column to write to. Absent rather than present-and-failing.
    render1(makeItem({ id: "n1", text: "raw thought", taskId: null }));
    expect(screen.queryByRole("button", { name: /^note for/i })).toBeNull();
  });
});

// ── #183 — the capture input had no accessible name ─────────────────────────
//
// The app's most-used control was an <input> with a placeholder and nothing
// else: no <label>, no aria-label, no aria-labelledby. A placeholder is not a
// name — support varies, and it VANISHES on the first keystroke, so anyone who
// tabs away mid-capture and back has a field full of text and no way to re-read
// what it was for. WCAG 4.1.2, and it undermines 3.3.2.
//
// Every assertion below goes through `getByRole(..., { name })`, which computes
// the name with `dom-accessibility-api` — the same engine screen readers'
// behaviour is modelled on. An attribute-level check would have passed on all
// three of the mangled-name bugs this codebase produced in one day, including
// one in #44's own note control ("Add notefor Ship the thing").
describe("InboxView — the capture input's accessible name (#183)", () => {
  const renderCapture = () =>
    render(
      <InboxView
        now={Date.now()}
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );

  it("has a computed accessible name, not merely a placeholder", () => {
    renderCapture();
    expect(
      screen.getByRole("textbox", { name: "Brain dump" }),
    ).toBeInTheDocument();
  });

  it("keeps the name once the placeholder is gone", async () => {
    // The regression that matters. The placeholder disappears the moment you
    // type; the name must not.
    const user = userEvent.setup();
    renderCapture();
    await user.type(screen.getByRole("textbox", { name: "Brain dump" }), "x");
    expect(screen.getByRole("textbox", { name: "Brain dump" })).toHaveValue(
      "x",
    );
  });

  it("keeps the placeholder as supplementary text, never as the name", () => {
    renderCapture();
    const input = screen.getByRole("textbox", { name: "Brain dump" });
    expect(input.getAttribute("placeholder")).toBe(
      "Brain dump anything… (Enter to save)",
    );
    // Not welded into the name — the failure mode this project has hit twice.
    expect(input.getAttribute("aria-label")).toBe("Brain dump");
  });

  it("announces the hint as the field's DESCRIPTION, not orphaned text", () => {
    renderCapture();
    const input = screen.getByRole("textbox", { name: "Brain dump" });
    const describedBy = input.getAttribute("aria-describedby") as string;
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy)?.textContent).toContain(
      "Press Enter to capture instantly",
    );
  });
});

describe("InboxView — row action group target size (#184)", () => {
  // Every control in a row's action group is a 44x44 target, on the app's own
  // convention — not on a WCAG requirement, and the difference matters for how
  // this gets described and prioritised:
  //
  //   - 2.5.8 Target Size (Minimum) is **AA** and asks for 24x24. "▶ Start
  //     Focus" measured exactly 24px, so it PASSED, with zero margin.
  //   - 2.5.5 Target Size (Enhanced) is **AAA** and asks for 44x44. That is the
  //     one it failed, and the project's stated bar is AA.
  //
  // So nothing here was non-conformant, and any comment or report saying "a
  // 2.5.8 failure" is wrong. It is fixed anyway for two reasons specific to
  // this app. Sitting exactly on the threshold means any change to font size,
  // line height or a Tailwind padding default silently drops it below and
  // nothing catches it — this spec is that "nothing". And the primary call to
  // action on every row was the smallest thing in the row while the
  // end-cluster icons beside it were all 44px, in a tool for people with ADHD
  // used mostly on a phone, where a mis-tap costs the thread you were holding.
  //
  // Asserted over the WHOLE group rather than one control, because that is the
  // shape the gap hid in: !270 measured only the note trigger and the buttons
  // either side of it were 24px. jsdom computes no layout, so this checks the
  // classes that produce the box; the pixel measurement at 390px lives in
  // e2e/smoke/row-menu-viewport-fit.spec.ts, which measures the same group.
  const expectFullTargets = (scope: HTMLElement) => {
    const groups = scope.querySelectorAll<HTMLElement>("[data-row-actions]");
    expect(groups.length).toBeGreaterThan(0);
    for (const group of Array.from(groups)) {
      const controls = group.querySelectorAll<HTMLElement>("button, a");
      expect(controls.length).toBeGreaterThan(0);
      for (const control of Array.from(controls)) {
        const name = control.getAttribute("aria-label") ?? control.textContent;
        expect(control.className, `"${name}" is under 44px tall`).toContain(
          "min-h-11",
        );
        expect(control.className, `"${name}" is under 44px wide`).toContain(
          "min-w-11",
        );
      }
    }
  };

  it("sizes every control in every bucket's action group", () => {
    const { container } = render(
      <InboxView
        now={Date.now()}
        initialItems={[
          // One row per frame that renders its own `inline` array.
          makeItem({ id: "t184a", text: "review row" }),
          makeMultiStep(),
          makeItem({
            id: "t184b",
            text: "awaiting breakdown",
            status: "triaged",
            taskId: "t184bt",
            breakdownRequestedAt: new Date(),
          }),
          makeItem({ id: "t184c", text: "single todo", status: "triaged" }),
          // The Done bucket, which hand-rolls its action line rather than
          // rendering <RowActions>. Without a completed item here the bucket
          // never mounts, so neither its `data-row-actions` marker nor its
          // Reopen button was ever measured — the marker was added by this MR
          // precisely because the line was invisible to this guard, and adding
          // it while leaving it unexercised proves nothing. Raised by an
          // independent review of !278.
          makeItem({
            id: "t184d",
            text: "finished thing",
            status: "triaged",
            completedAt: new Date(),
          }),
        ]}
        settings={settings}
        google={{ configured: true, connected: true, needsReconnect: false }}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    expectFullTargets(container);
  });

  it("sizes the saved-for-later options too, which only render once opened", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <InboxView
        now={Date.now()}
        initialItems={[
          makeItem({
            id: "t184d",
            text: "stored thing",
            snoozedUntil: new Date(Date.now() + 60 * 60_000),
          }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    await user.click(screen.getByRole("button", { name: "stored thing" }));
    expect(
      screen.getByRole("button", { name: /Break into steps/ }),
    ).toBeInTheDocument();
    expectFullTargets(container);
  });
});
