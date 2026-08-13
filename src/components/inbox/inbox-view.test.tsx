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
  CAPTURE_TIMEOUT_MS,
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

/**
 * #253 — Move to, Schedule, Add to calendar and Delete are ▾-list entries now.
 * The trailing icon cluster that carried them inline is gone, so a test that
 * reached one of them directly has to open the row's list first — which is the
 * route a user takes too. A named helper rather than an inlined click, so the
 * reason appears once instead of at every call site.
 *
 * Deliberately NOT used for the Completed bucket: that line is hand-rolled (it
 * needs Reopen where the primary CTA goes) rather than a `RowActions` row, so its
 * 🗑 was never in the cluster and stays inline.
 */
const openRowMenu = (
  user: ReturnType<typeof userEvent.setup>,
  row: HTMLElement,
) => user.click(within(row).getByRole("button", { name: "All options" }));

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

/**
 * #210 — the capture bar used to clear the input and render "captured ✓"
 * unconditionally, before the write had resolved and regardless of whether it
 * ever did. Capture is the only irreversible loss in the app: every other
 * action works on an `id` that exists because the server already has the row,
 * so a failure there can be retried against data that is still present. Here
 * the words existed nowhere else.
 *
 * Every other spec in this file mocks `createBrainDumpItem` as resolving, which
 * is exactly why this survived — so these drive the mock the other way.
 */
describe("InboxView — a capture that fails (#210)", () => {
  /**
   * #168's hazard, from the other end: `vi.clearAllMocks()` in the global
   * beforeEach drops recorded calls but NOT a queued `mockRejectedValueOnce`.
   * These specs queue one every time, so reset the queue and restore the
   * module-level default rather than leaving a rejection for whichever spec
   * runs next.
   */
  beforeEach(() => {
    vi.mocked(createBrainDumpItem).mockReset();
    vi.mocked(createBrainDumpItem).mockResolvedValue(undefined);
  });

  /** What Next 16's client throws when the action id is from another build. */
  function staleActionError() {
    return Object.assign(
      new Error(
        'Server Action "40bef5efc6c80527f80d35d95a902c7e0bc4056eb0" was not found on the server.',
      ),
      { name: "UnrecognizedActionError" },
    );
  }

  function renderInbox(initialItems: Item[] = []) {
    render(
      <InboxView
        now={Date.now()}
        initialItems={initialItems}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    return screen.getByPlaceholderText(/Brain dump/i) as HTMLInputElement;
  }

  /**
   * `fireEvent` rather than `userEvent`: two of these specs drive fake timers
   * (the action timeout, the confirm window) and userEvent's own timer plumbing
   * has to be wired to them separately. The "clears the captured indicator
   * after ~1.5s" spec above sets the same precedent.
   */
  async function capture(input: HTMLInputElement, value: string) {
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();
  }

  /**
   * The notice's Retry, on the same flush budget as `capture` above.
   *
   * Duo review round 1: the click-then-flush block was inlined four times with
   * the tick count drifting between two and four, so a spec could have passed
   * for having flushed enough rather than for the behaviour it names. One helper
   * with one budget, and it moves in one place if the async hop count changes.
   */
  async function clickRetry() {
    await act(async () => {
      screen.getByRole("button", { name: /try again/i }).click();
      await flushTicks();
    });
  }

  /** Flush the microtask queue driving the startTransition/async action. */
  async function flush() {
    await act(async () => {
      await flushTicks();
    });
  }

  async function flushTicks() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it("does not claim 'captured ✓' when the write rejected", async () => {
    vi.mocked(createBrainDumpItem).mockRejectedValueOnce(new Error("offline"));
    const input = renderInbox();

    await capture(input, "buy milk");

    expect(screen.queryByText("captured ✓")).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't save that/i,
    );
  });

  it("keeps the typed words recoverable in the input", async () => {
    vi.mocked(createBrainDumpItem).mockRejectedValueOnce(new Error("offline"));
    const input = renderInbox();

    await capture(input, "buy milk");

    expect(input).toHaveValue("buy milk");
  });

  it("names the words it could not save, so they survive even if the field has moved on", async () => {
    vi.mocked(createBrainDumpItem).mockRejectedValueOnce(new Error("offline"));
    const input = renderInbox();

    await capture(input, "buy milk");

    expect(await screen.findByRole("alert")).toHaveTextContent(/buy milk/);
  });

  it("offers Retry, and Retry re-posts the same words", async () => {
    vi.mocked(createBrainDumpItem).mockRejectedValueOnce(new Error("offline"));
    const input = renderInbox();
    await capture(input, "buy milk");

    await clickRetry();

    expect(vi.mocked(createBrainDumpItem).mock.calls).toEqual([
      ["buy milk"],
      ["buy milk"],
    ]);
  });

  it("a successful Retry clears both the notice and the text it restored", async () => {
    vi.mocked(createBrainDumpItem).mockRejectedValueOnce(new Error("offline"));
    const input = renderInbox();
    await capture(input, "buy milk");

    await clickRetry();

    // The row is on the server now, so leaving the words in the field would
    // invite a duplicate on the next Enter.
    expect(input).toHaveValue("");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("captured ✓")).toBeInTheDocument();
  });

  // The restore must never be a second kind of data loss: a slow failure gives
  // the user time to type their next thought, and overwriting THAT would be the
  // same bug wearing the other hat.
  it("does not clobber words typed while the failed capture was still in flight", async () => {
    let rejectWrite!: (reason: unknown) => void;
    vi.mocked(createBrainDumpItem).mockReturnValueOnce(
      new Promise<void>((_, reject) => {
        rejectWrite = reject;
      }),
    );
    const input = renderInbox();
    await capture(input, "buy milk");

    fireEvent.change(input, { target: { value: "call mum" } });
    await act(async () => {
      rejectWrite(new Error("offline"));
      await flushTicks();
    });

    expect(input).toHaveValue("call mum");
    // "buy milk" is not lost — the notice is holding it, with a Retry.
    expect(await screen.findByRole("alert")).toHaveTextContent(/buy milk/);
  });

  it("a stale deployment offers a reload and no Retry, which could never work", async () => {
    vi.mocked(createBrainDumpItem).mockRejectedValueOnce(staleActionError());
    const input = renderInbox();

    await capture(input, "buy milk");

    expect(await screen.findByRole("alert")).toHaveTextContent(/app updated/i);
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    // Still recoverable: the reload cannot happen without the user pressing it,
    // and the words are on screen either way.
    expect(input).toHaveValue("buy milk");
  });

  // The third failure mode is silence, not a rejection: a pod rolling
  // mid-request leaves the write hanging, and an un-timed-out await looks
  // exactly like the bug from the user's side — cleared field, no confirmation,
  // no error, no words.
  it("surfaces a write that never answers, once CAPTURE_TIMEOUT_MS elapses", async () => {
    vi.useFakeTimers();
    vi.mocked(createBrainDumpItem).mockReturnValueOnce(
      new Promise<void>(() => {}),
    );
    const input = renderInbox();
    await capture(input, "buy milk");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("captured ✓")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS);
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(input).toHaveValue("buy milk");
  });

  /**
   * Duo review round 2: a timeout is the one failure whose verdict is genuinely
   * unknown. `withActionTimeout` bounds how long the UI waits, not the request —
   * a server action cannot be aborted from the client — so the write may still
   * land, and a retry after it does creates a duplicate. "Couldn't save that"
   * would be a claim the client cannot make, and it is the same class of
   * unverifiable confirmation as the `captured ✓` this issue is about, just
   * pointing the other way.
   */
  it("says a timed-out capture MAY have saved, rather than asserting it did not", async () => {
    vi.useFakeTimers();
    vi.mocked(createBrainDumpItem).mockReturnValueOnce(
      new Promise<void>(() => {}),
    );
    const input = renderInbox();
    await capture(input, "buy milk");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS);
    });

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent(/may already have saved/i);
    expect(notice).toHaveTextContent(/check your inbox/i);
    expect(notice).not.toHaveTextContent(/couldn't save that/i);
    // Retry is still offered: a duplicate item is one tap to delete, an
    // unwritten thought is not recoverable at all, so the choice is the user's
    // and the notice gives them what they need to make it.
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
    expect(input).toHaveValue("buy milk");
  });

  /**
   * Duo review round 2, and the reason `schedulingIds` is keyed per row rather
   * than being one boolean (#169): a shared in-flight flag belongs to whichever
   * request settles last, not to the one it is guarding.
   *
   * A capture the user starts while a retry is outstanding is deliberately not
   * gated (independent inserts, and firing thoughts in a row is the point of the
   * control) — so it WILL settle inside the retry's window, and a shared flag
   * would hand the Retry button back while its own request was still in flight.
   */
  it("scopes the Retry guard to the retry, so an unrelated capture settling cannot unblock it", async () => {
    let rejectFirst!: (reason: unknown) => void;
    let resolveOther!: () => void;
    vi.mocked(createBrainDumpItem)
      // the original capture, failed on demand so the field can be typed into
      // first — that is what makes the second capture a genuinely unrelated
      // thought rather than one that supersedes the notice
      .mockReturnValueOnce(
        new Promise<void>((_, reject) => {
          rejectFirst = reject;
        }),
      )
      // its retry, which never answers
      .mockReturnValueOnce(new Promise<void>(() => {}))
      // the unrelated capture, resolved on demand
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveOther = resolve;
        }),
      );
    const input = renderInbox();
    await capture(input, "buy milk");
    fireEvent.change(input, { target: { value: "call mum" } });
    await act(async () => {
      rejectFirst(new Error("offline"));
      await flushTicks();
    });

    await clickRetry();
    expect(screen.getByRole("button", { name: /try again/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    fireEvent.keyDown(input, { key: "Enter" });
    await flush();
    await act(async () => {
      resolveOther();
      await flushTicks();
    });

    // "buy milk"'s retry is still outstanding, so Retry must still be blocked —
    // and a press must not post it a second time.
    expect(screen.getByRole("button", { name: /try again/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await clickRetry();
    expect(vi.mocked(createBrainDumpItem).mock.calls).toEqual([
      ["buy milk"],
      ["buy milk"],
      ["call mum"],
    ]);
  });

  /**
   * Duo review round 3 — WCAG 2.4.3, on the far side of the press. Keeping the
   * notice mounted stops focus dropping to `<body>` while the retry runs; a
   * retry that SUCCEEDS then unmounts the button the user is standing on, which
   * is the same failure the `aria-disabled` decision was written to avoid, one
   * step later. The capture input is where they want to be anyway.
   */
  it("hands focus back to the capture input when a successful Retry unmounts the notice", async () => {
    vi.mocked(createBrainDumpItem).mockRejectedValueOnce(new Error("offline"));
    const input = renderInbox();
    await capture(input, "buy milk");

    screen.getByRole("button", { name: /try again/i }).focus();
    await clickRetry();

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(input).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  // …but only from the notice's own button. Focus is the user's, and pulling it
  // out of wherever they have moved to would be a different WCAG problem (3.2.2)
  // dressed as a fix for this one.
  it("does not pull focus off whatever the user moved to before the retry landed", async () => {
    vi.mocked(createBrainDumpItem).mockRejectedValueOnce(new Error("offline"));
    const input = renderInbox([makeItem({ id: "abc", text: "delete me" })]);
    await capture(input, "buy milk");

    // Any focusable control on another row will do; #253 moved Delete into the ▾
    // list, so the inline CTA is the nearest stable one that needs no interaction
    // to reach (opening a popup would move focus itself and confuse the subject).
    const elsewhere = within(
      screen.getByText("delete me").closest("li")!,
    ).getByRole("button", { name: /Break into steps/ });
    elsewhere.focus();
    await clickRetry();

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(elsewhere).toHaveFocus();
  });

  /**
   * Duo review round 3 — the notice is cleared by the words landing, so editing
   * the restored text and pressing Enter used to leave a stale alert beside the
   * fresh "captured ✓", inviting a Retry that would post a near-duplicate.
   *
   * The discriminator is whether the words are IN THE FIELD: if they are, the
   * user has seen them and replaced them, so this capture supersedes the notice.
   * If they are not, the notice is the only copy of them, and the spec below pins
   * that it survives.
   */
  it("clears the notice when the user edits the restored words and captures the edit", async () => {
    vi.mocked(createBrainDumpItem).mockRejectedValueOnce(new Error("offline"));
    const input = renderInbox();
    await capture(input, "buy milk");
    expect(input).toHaveValue("buy milk");

    fireEvent.change(input, { target: { value: "buy oat milk" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("captured ✓")).toBeInTheDocument();
    expect(vi.mocked(createBrainDumpItem).mock.calls).toEqual([
      ["buy milk"],
      ["buy oat milk"],
    ]);
  });

  it("keeps a notice whose words it could NOT restore, even once a later capture succeeds", async () => {
    let rejectWrite!: (reason: unknown) => void;
    vi.mocked(createBrainDumpItem).mockReturnValueOnce(
      new Promise<void>((_, reject) => {
        rejectWrite = reject;
      }),
    );
    const input = renderInbox();
    await capture(input, "buy milk");

    fireEvent.change(input, { target: { value: "call mum" } });
    await act(async () => {
      rejectWrite(new Error("offline"));
      await flushTicks();
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/buy milk/);

    // The field never held "buy milk", so this is a different thought and the
    // notice is still the only copy of the first one.
    await capture(input, "call mum");

    expect(screen.getByText("captured ✓")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/buy milk/);
  });

  /**
   * capture-failure-pile-up — Duo review round 7, and the correction that came
   * out of writing these.
   *
   * Duo flagged that the single notice slot can drop an earlier failure's only
   * copy of its words. Real. Writing the specs then falsified the comment that
   * was defending it: it claimed the notice and the field between them hold two
   * outstanding failures, and **they do not.** Submitting anything empties the
   * field, so a second failure both takes the notice AND repopulates the field
   * with its own words. There is no arrangement in which both survive.
   *
   * These pin that boundary rather than leaving it as a claim nothing checks —
   * which is precisely how the wrong claim survived. It is #175's to close: the
   * issue scopes "a real offline session" there, and consecutive failures ARE
   * one. Every fix available inside this issue trades the loss for a different
   * silence (keeping the older record leaves the newer failure unannounced;
   * rescuing the older words into the field puts text the user did not just type
   * where they are looking). A queue needs neither.
   */
  describe("two failures outstanding, one notice slot (#210 → #175)", () => {
    /** Two captures that both fail, the second typed while the first is in flight. */
    async function twoFailures(input: HTMLInputElement) {
      let rejectFirst!: (reason: unknown) => void;
      vi.mocked(createBrainDumpItem)
        .mockReturnValueOnce(
          new Promise<void>((_, reject) => {
            rejectFirst = reject;
          }),
        )
        .mockRejectedValueOnce(new Error("offline"));
      await capture(input, "buy milk");
      fireEvent.change(input, { target: { value: "call mum" } });
      await act(async () => {
        rejectFirst(new Error("offline"));
        await flushTicks();
      });
      // The field was occupied, so "buy milk" went to the notice only.
      expect(screen.getByRole("alert")).toHaveTextContent("“buy milk”");
      expect(input).toHaveValue("call mum");

      fireEvent.keyDown(input, { key: "Enter" });
      await flush();
    }

    it("lets the second failure displace the first, whose words were only in the notice", async () => {
      const input = renderInbox();
      await twoFailures(input);

      expect(screen.getByRole("alert")).toHaveTextContent("“call mum”");
      expect(screen.getByRole("alert")).not.toHaveTextContent("buy milk");
      // The honest statement of the cost, executable rather than asserted in
      // prose: "buy milk" is now in neither place.
      expect(input).not.toHaveValue("buy milk");
    });

    /**
     * Duo review round 9 — the same slot, from the other direction, and the
     * asymmetry it names is real: the SUCCESS path refuses to clear a record
     * whose own attempt is unsettled, while the catch writes unconditionally. So
     * an older retry failing late takes the notice from a newer failure.
     *
     * Deferred with the rest, not overlooked. The asymmetry cannot be removed by
     * making the catch match the success path, because the two are answering
     * different questions: a success may decline the slot (its words are safe on
     * the server), whereas a failure that declines it reports nothing at all.
     * Whichever record wins, the other is unannounced. What is verified here is
     * the part that matters — the loser's WORDS are still in the field, so the
     * cost is a missing notice rather than missing text.
     */
    it("lets a late retry failure take the notice, leaving the newer words in the field", async () => {
      let rejectRetry!: (reason: unknown) => void;
      vi.mocked(createBrainDumpItem)
        .mockRejectedValueOnce(new Error("offline"))
        .mockReturnValueOnce(
          new Promise<void>((_, reject) => {
            rejectRetry = reject;
          }),
        )
        .mockRejectedValueOnce(new Error("offline"));
      const input = renderInbox();
      await capture(input, "buy milk");
      await clickRetry();

      // A newer, unrelated capture fails while that retry is still outstanding.
      fireEvent.change(input, { target: { value: "call mum" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await flush();
      expect(screen.getByRole("alert")).toHaveTextContent("“call mum”");
      expect(input).toHaveValue("call mum");

      await act(async () => {
        rejectRetry(new Error("still offline"));
        await flushTicks();
      });

      // The older retry took the slot back…
      expect(screen.getByRole("alert")).toHaveTextContent("“buy milk”");
      // …but "call mum" is not lost — it is in the field, which is the guarantee
      // that holds however many fail.
      expect(input).toHaveValue("call mum");
    });

    it("is never silent about the failure it does hold", async () => {
      const input = renderInbox();
      await twoFailures(input);

      // Whatever it drops, the state it leaves is always the honest one: an
      // alert naming words that did not save, those words in the field, and a
      // Retry. Never an empty field and a false confirmation, which is #210.
      const notice = screen.getByRole("alert");
      expect(notice).toHaveTextContent(/couldn't save that/i);
      expect(notice).toHaveTextContent("“call mum”");
      expect(input).toHaveValue("call mum");
      expect(
        within(notice).getByRole("button", { name: /try again/i }),
      ).toBeInTheDocument();
      expect(screen.queryByText("captured ✓")).not.toBeInTheDocument();
    });
  });

  /**
   * Duo review round 8 — the `try` must govern the WRITE, not everything after
   * it. `router.refresh()` sat inside it, so a refresh that threw would run the
   * catch and tell the user a capture had failed when the row was already
   * written: #210's lie, produced by the code fixing #210.
   */
  it("does not report a capture as failed when only the list refresh threw", async () => {
    const input = renderInbox();
    refresh.mockImplementationOnce(() => {
      throw new Error("refresh blew up");
    });

    await capture(input, "buy milk");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("captured ✓")).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  /**
   * Duo review round 8 — nested live regions are the question it raised, and the
   * answer is not to have one. A `role="status"` inside a `role="alert"` is a
   * polite region inside an assertive one, which is undefined enough in practice
   * that "will it announce" cannot be answered.
   *
   * So the wait is carried by the two mechanisms that ARE defined: the pressed
   * button's own `aria-disabled` state change, and its `aria-describedby`, which
   * picks up the "Saving…" text while it is showing. Sighted users see exactly
   * the same thing.
   */
  it("carries the retry's wait on the button rather than nesting a live region", async () => {
    vi.mocked(createBrainDumpItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(new Promise<void>(() => {}));
    const input = renderInbox();
    await capture(input, "buy milk");
    await clickRetry();

    const notice = screen.getByRole("alert");
    expect(within(notice).queryByRole("status")).toBeNull();
    expect(notice).toHaveTextContent(/saving/i);

    const retry = within(notice).getByRole("button", { name: /try again/i });
    const ids = retry.getAttribute("aria-describedby")!.trim().split(/\s+/);
    expect(ids).toHaveLength(2);
    const described = ids
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(described).toMatch(/couldn't save that/i);
    expect(described).toMatch(/saving/i);
  });

  /**
   * #218 / Duo round 16 on `!303` — round 8's answer was half of one. Not
   * nesting the live region was right; leaving `aria-describedby` to carry the
   * wait on its own was not. A description is computed when focus LANDS on a
   * control, and this control already has focus and deliberately keeps it, so
   * the value gaining `captureSavingId` mid-flight is not something a screen
   * reader goes back and re-reads. The nested-region hole was moved, not closed.
   *
   * A live region is the one spec-defined channel for content that changes
   * while the user is stationary, so the wait gets a real one — polite,
   * visually hidden, and a SIBLING of the `role="alert"`. Mounted empty with the
   * notice, for the reason the move announcer below already documents: a region
   * that arrives together with its first message is silent. The visible copy
   * stays exactly where it was and goes `aria-hidden`, so the sentence reaches
   * a screen reader once rather than also re-reading the assertive notice.
   *
   * Kept identical to `focus-timer.tsx`'s notice on purpose — the two have
   * drifted once already, which is what produced this round.
   */
  it("announces the wait through a polite live region beside the notice, not by changing a description under held focus", async () => {
    vi.mocked(createBrainDumpItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(new Promise<void>(() => {}));
    const input = renderInbox();
    await capture(input, "buy milk");

    const announcer = screen.getByTestId("capture-saving-announcer");
    expect(announcer).toBeEmptyDOMElement();
    expect(screen.getByRole("alert")).not.toContainElement(announcer);

    await clickRetry();

    expect(announcer).toHaveTextContent(/saving/i);
    expect(announcer).toHaveAttribute("role", "status");
    expect(announcer).toHaveAttribute("aria-live", "polite");
    expect(announcer).toHaveClass("sr-only");
    expect(screen.getByRole("alert")).not.toContainElement(announcer);

    const visible = screen.getByTestId("capture-saving-visible");
    expect(screen.getByRole("alert")).toContainElement(visible);
    expect(visible).toHaveAttribute("aria-hidden", "true");
    expect(visible).not.toHaveClass("sr-only");
  });

  /**
   * Duo review round 4 — the superseding rule, reached from the one path the
   * round-3 specs did not walk: a **retry that fails again**.
   *
   * A retry does not clear the field (only success does), so on the second
   * failure the words are already sitting there untouched. Deciding "were these
   * words put back in the field?" by asking "was the field empty?" answered no,
   * and the notice then refused to be superseded — leaving a stale alert beside
   * a fresh "captured ✓" after the user had visibly typed over those words and
   * captured the edit. Which is #210's own bug, from a different door.
   */
  it("still supersedes the notice after a retry that failed again", async () => {
    vi.mocked(createBrainDumpItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("still offline"));
    const input = renderInbox();
    await capture(input, "buy milk");
    await clickRetry();

    // The words are back where the user can see them, twice over.
    expect(input).toHaveValue("buy milk");
    expect(screen.getByRole("alert")).toHaveTextContent(/buy milk/);

    fireEvent.change(input, { target: { value: "buy oat milk" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("captured ✓")).toBeInTheDocument();
  });

  /**
   * Duo review round 5 — `submit()` is deliberately ungated, because firing
   * thoughts in a row is the point of the control and they are independent
   * inserts. The exception is the words a Retry is already resubmitting: those
   * are not an independent insert, they are the same request by a second route,
   * and the field is holding them precisely because the notice put them back.
   */
  it("ignores an Enter that would re-post the words a Retry is already resubmitting", async () => {
    vi.mocked(createBrainDumpItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(new Promise<void>(() => {}));
    const input = renderInbox();
    await capture(input, "buy milk");
    await clickRetry();
    expect(input).toHaveValue("buy milk");

    fireEvent.keyDown(input, { key: "Enter" });
    await flush();

    expect(vi.mocked(createBrainDumpItem)).toHaveBeenCalledTimes(2);
    // Not a silent discard — #169's other harm. The notice is on screen saying a
    // save for these exact words is in flight, and Retry reads busy.
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent(/saving/i);
    expect(
      within(notice).getByRole("button", { name: /try again/i }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(input).toHaveValue("buy milk");
  });

  /**
   * Duo review round 5 — superseding means "the user has seen how this attempt
   * ended and replaced its words". While a retry is still in flight they have
   * seen no such thing, so clearing the notice would be clearing it out from
   * under a request whose outcome nobody knows yet — and a later failure would
   * then look like a notice resurrecting itself from nothing.
   *
   * The answer is to leave the notice up, not to suppress the failure. A write
   * the client knows did not land and says nothing about is the silence this
   * whole issue exists to remove.
   */
  it("does not let a capture supersede a failure whose retry has not answered yet", async () => {
    let rejectRetry!: (reason: unknown) => void;
    vi.mocked(createBrainDumpItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(
        new Promise<void>((_, reject) => {
          rejectRetry = reject;
        }),
      )
      .mockResolvedValueOnce(undefined);
    const input = renderInbox();
    await capture(input, "buy milk");
    await clickRetry();

    fireEvent.change(input, { target: { value: "buy oat milk" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();

    expect(screen.getByRole("alert")).toHaveTextContent("“buy milk”");

    await act(async () => {
      rejectRetry(new Error("still offline"));
      await flushTicks();
    });

    // It failed, and the notice never left — so this is a report, not a
    // resurrection. The words go back into the field the other capture emptied.
    expect(screen.getByRole("alert")).toHaveTextContent("“buy milk”");
    expect(input).toHaveValue("buy milk");
  });

  /**
   * Duo review round 6 — the same hazard through the remaining door. `supersedes`
   * is decided when a capture is SUBMITTED; a Retry pressed between that press
   * and its response makes the outcome unknown again, and the stale decision
   * would still have cleared the record on arrival.
   *
   * So the invariant is enforced where the record is written rather than only
   * where the decision is taken: **a record whose own attempt is unsettled is
   * never cleared by anything except that attempt.**
   */
  it("does not clear a record mid-retry, even when an earlier submit had marked it superseded", async () => {
    let resolveOther!: () => void;
    let rejectRetry!: (reason: unknown) => void;
    vi.mocked(createBrainDumpItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveOther = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<void>((_, reject) => {
          rejectRetry = reject;
        }),
      );
    const input = renderInbox();
    await capture(input, "buy milk");

    // Typed over the restored words and captured, so this submit decides
    // `supersedes = "buy milk"` — while its own request is still in flight.
    fireEvent.change(input, { target: { value: "call mum" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();

    // …and only THEN is Retry pressed, after the decision was taken.
    await clickRetry();
    await act(async () => {
      resolveOther();
      await flushTicks();
    });

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("“buy milk”");
    expect(
      within(notice).getByRole("button", { name: /try again/i }),
    ).toHaveAttribute("aria-disabled", "true");

    await act(async () => {
      rejectRetry(new Error("still offline"));
      await flushTicks();
    });
    expect(screen.getByRole("alert")).toHaveTextContent("“buy milk”");
  });

  /**
   * WCAG 2.4.3 — the finding `focus-timer.tsx:1252` documents: a native
   * `disabled` attribute cannot hold focus, so the browser drops the focused
   * element to `<body>` the moment the retry starts. `aria-disabled` plus a
   * guarded handler keeps the press point where it is.
   */
  it("marks Retry aria-disabled rather than disabled while it is in flight", async () => {
    vi.mocked(createBrainDumpItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(new Promise<void>(() => {}));
    const input = renderInbox();
    await capture(input, "buy milk");

    screen.getByRole("button", { name: /try again/i }).focus();
    await clickRetry();

    const after = screen.getByRole("button", { name: /try again/i });
    expect(after).toHaveAttribute("aria-disabled", "true");
    expect(after).not.toHaveAttribute("disabled");
    expect(after).toHaveFocus();
    expect(after.className).toMatch(/min-h-\[44px\]/);
  });

  it("does not fire a second write when Retry is pressed mid-flight", async () => {
    vi.mocked(createBrainDumpItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(new Promise<void>(() => {}));
    const input = renderInbox();
    await capture(input, "buy milk");

    await clickRetry();
    await clickRetry();

    // once for the original attempt, once for the retry — not three times
    expect(vi.mocked(createBrainDumpItem)).toHaveBeenCalledTimes(2);
  });

  /**
   * WCAG 3.2.2 On Input, and the deliberate divergence from `focus-timer.tsx`:
   * there, the pressed control unmounted, so focus HAD to be handed somewhere.
   * Here the capture input never unmounts and is where the user is still
   * typing, so moving focus to the notice would interrupt them and fight the
   * restored text. `role="alert"` announces the failure without taking focus.
   */
  it("leaves focus in the capture input rather than taking it to the notice", async () => {
    vi.mocked(createBrainDumpItem).mockRejectedValueOnce(new Error("offline"));
    const input = renderInbox();
    input.focus();

    await capture(input, "buy milk");

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  /**
   * Two live regions must never contradict each other. A confirmation from an
   * earlier capture is on screen for 1.5s, so a failure landing inside that
   * window would render "captured ✓" and "couldn't save that" together — and a
   * screen reader would hear both.
   */
  it("clears a still-showing 'captured ✓' when the next capture fails", async () => {
    const input = renderInbox();
    await capture(input, "first thought");
    expect(screen.getByText("captured ✓")).toBeInTheDocument();

    vi.mocked(createBrainDumpItem).mockRejectedValueOnce(new Error("offline"));
    await capture(input, "second thought");

    expect(screen.queryByText("captured ✓")).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't save that/i,
    );
  });

  it("a11y: the notice reads as an error and its control describes the reason", async () => {
    vi.mocked(createBrainDumpItem).mockRejectedValueOnce(new Error("offline"));
    const input = renderInbox();
    await capture(input, "buy milk");

    const notice = await screen.findByRole("alert");
    const retry = screen.getByRole("button", { name: /try again/i });
    const describedBy = retry.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const message = document.getElementById(describedBy!)!;

    // The state is carried by the text, never by the red alone (WCAG 1.4.1),
    // and the reason is reachable from the control — whichever announcement
    // wins, the user gets both.
    expect(notice.textContent).toMatch(/couldn't save that/i);
    expect(message).toHaveTextContent(/couldn't save that/i);

    // Duo review round 1: this spec's comment claimed `text-destructive` was
    // under test while only the border was asserted, so a non-AA text colour
    // would have passed it. Duo's own patch put the assertion on the notice,
    // which would have failed — the token is on the MESSAGE, and the notice
    // carries the surface pair. Both are asserted, on the elements that have
    // them. `text-destructive` on --background/--card is the pairing globals.css
    // documents as AA in both themes (5.2:1+); a raw palette shade is what
    // dropped the emerald confirmation below 4.5:1 on the warm-tinted
    // --background in #40.
    expect(message.className).toContain("text-destructive");
    expect(notice.className).toContain("border-destructive/40");
    expect(notice.className).toContain("bg-destructive/5");
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
    // #253: Delete is reached from the row's ▾ list. The armed confirm still
    // renders in place of the entry, so the two-step behaviour is unchanged.
    const row = screen.getByText("delete me").closest("li")!;
    await openRowMenu(user, row);
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
    await user.click(within(row).getByRole("button", { name: "Complete" }));
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
    await user.click(within(row).getByRole("button", { name: "Complete" }));
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
    await user.click(within(row).getByRole("button", { name: "Complete" }));
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

// ── #251 — a completed item could not be removed ───────────────────────────
//
// Completing an item moved it into the Done bucket and took away every way of
// getting rid of it: that bucket hand-rolls its action line (see the comment
// beside it in inbox-view.tsx) and offered only Reopen and Move to…, so a demo
// item completed while showing the app off stayed in the list for good.
//
// The server action was never the blocker — `deleteBrainDumpItem` carries no
// `completedAt` guard and is workspace-scoped already (its own tests cover
// that). What is new here is the affordance, that it keeps the same two-step
// confirm as every other bucket, and where focus goes once the control it was
// pressed in has been unmounted.
describe("InboxView — deleting a completed item (#251)", () => {
  const completed = () =>
    makeItem({
      id: "d251",
      text: "demo item",
      status: "triaged",
      completedAt: new Date(),
    });

  const renderCompleted = () =>
    render(
      <InboxView
        now={Date.now()}
        initialItems={[completed()]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );

  it("offers Delete in the Completed bucket's action line, beside Reopen", () => {
    renderCompleted();
    const row = screen.getByText("demo item").closest("li")!;
    const group = row.querySelector<HTMLElement>("[data-row-actions]")!;
    expect(group).toBeTruthy();
    // In the action group, not loose in the row — the group is what the
    // target-size guards measure and what a reader treats as the row's controls.
    expect(
      within(group).getByRole("button", { name: "Delete" }),
    ).toBeInTheDocument();
    expect(
      within(group).getByRole("button", { name: "Reopen" }),
    ).toBeInTheDocument();
  });

  it("requires the two-step confirm before deleting a completed item", async () => {
    const user = userEvent.setup();
    renderCompleted();
    const row = screen.getByText("demo item").closest("li")!;

    // First press arms the confirm and deletes nothing.
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    expect(
      within(row).getByRole("button", { name: "Cancel" }),
    ).toBeInTheDocument();

    // The confirming press is the one that writes.
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(deleteBrainDumpItem).toHaveBeenCalledWith("d251"),
    );
  });

  it("Cancel disarms without deleting", async () => {
    const user = userEvent.setup();
    renderCompleted();
    const row = screen.getByText("demo item").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await user.click(within(row).getByRole("button", { name: "Cancel" }));
    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    // Back to the resting 🗑 control, so a second attempt is still possible.
    expect(
      within(row).getByRole("button", { name: "Delete" }),
    ).toBeInTheDocument();
  });

  it("keeps the armed confirm pair at the house 44px minimum", async () => {
    // The pair replaces the 🗑 that opened it, and that button is already 44px.
    // At 24px the action line shrank under the pointer at exactly the moment a
    // mis-tap deletes something. `expectFullTargets` below cannot see this: it
    // measures the resting state and never opens a confirm.
    const user = userEvent.setup();
    renderCompleted();
    const row = screen.getByText("demo item").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    for (const name of ["Delete", "Cancel"]) {
      const control = within(row).getByRole("button", { name });
      expect(control.className, `"${name}" is under 44px tall`).toContain(
        "min-h-11",
      );
      expect(control.className, `"${name}" is under 44px wide`).toContain(
        "min-w-11",
      );
    }
  });

  it("hands focus to the capture field instead of dropping it on <body>", async () => {
    const user = userEvent.setup();
    renderCompleted();
    const row = screen.getByText("demo item").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    // The confirming button unmounts with the press and the row goes with the
    // refresh, so the browser has already put focus on <body> (WCAG 2.4.3).
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "Brain dump" }),
      ),
    );
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

  /**
   * #253 — `Add as single-task to-do` is hidden on a Multi-step row that HAS steps,
   * and kept on one awaiting a breakdown. Asserted as two exact ordered lists rather
   * than a presence check, because the claim is conditional and a presence check
   * cannot see which state it is in.
   *
   * On a steps-bearing row the entry never worked. It dispatches
   * `moveItemToBucket(id, "singleTask")` → `triage`, which clears
   * `breakdownRequestedAt` — but `bucketItems` keeps the row in Multi-step on
   * `stepsTotal > 1` alone (`bucket.ts`), so the row does not move. It was a dead
   * option that still fired `movedAnnouncement`, telling a screen-reader user the
   * item had moved to Single-task when it had not.
   *
   * On an awaiting row (`stepsTotal === 0`) it is the whole point: `awaitsBreakdown`
   * is `stepsTotal === 0 && breakdownRequestedAt != null`, so clearing the stamp does
   * move the row out. Gate too broadly and the second case below reds.
   */
  it("a steps-bearing Multi-step row's ▾ omits the dead Single-task entry", async () => {
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
    const popup = within(row).getByRole("dialog", { name: "All options" });
    expect(
      within(popup)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      "Send back to review",
      "Save for later",
      "View multi-step task list",
      "Start visual focus timer",
      "Mark as completed",
      "Add to calendar (.ics)",
      "Delete",
    ]);
    expect(
      within(popup).queryByRole("button", {
        name: "Add as single-task to-do",
      }),
      "the dead Single-task entry is back on a steps-bearing row",
    ).toBeNull();
  });

  it("an awaiting-breakdown Multi-step row KEEPS it, because there it works", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
        initialItems={[
          makeItem({
            id: "aw2",
            text: "needs a plan",
            status: "triaged",
            breakdownRequestedAt: new Date(),
            stepsTotal: 0,
          }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("needs a plan").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    const popup = within(row).getByRole("dialog", { name: "All options" });
    expect(
      within(popup)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      "Send back to review",
      "Add as single-task to-do",
      "Save for later",
      "Break down in the editor",
      "Mark as completed",
      "Add to calendar (.ics)",
      "Delete",
    ]);
  });

  it("the kept entry still dispatches the move that works", async () => {
    const { triageBrainDumpItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
        initialItems={[
          makeItem({
            id: "aw3",
            text: "needs a plan",
            status: "triaged",
            breakdownRequestedAt: new Date(),
            stepsTotal: 0,
          }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("needs a plan").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    const popup = within(row).getByRole("dialog", { name: "All options" });
    await user.click(
      within(popup).getByRole("button", { name: "Add as single-task to-do" }),
    );
    expect(triageBrainDumpItem).toHaveBeenCalledWith("aw3");
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
      within(row).getByRole("button", { name: "Complete" }),
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
    // #253 — the nested picker is gone; the ▾ names its destinations directly, so
    // this is one press instead of two. The dispatch under test is unchanged.
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(
      await within(row).findByRole("button", { name: "Mark as completed" }),
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
    // #253 — `needsReview` is the one bucket the canonical entries did NOT already
    // name, so removing the picker without this entry would have stripped the route.
    // `action.sendToReview` is that entry, and it dispatches through the same
    // `moveItemToBucket` the picker used.
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(
      await within(row).findByRole("button", { name: "Send back to review" }),
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
        initialItems={[
          makeItem({ id: "n1", text: "big thing", status: "triaged" }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("big thing").closest("li")!;
    // ⚠️ #253 — a SINGLE-TASK row, not a Needs-review one, and the change of fixture
    // is the finding rather than a convenience. Removing the nested picker meant
    // naming each destination as an entry, and the two rows spell "Multi-step"
    // differently on purpose:
    //   • single-task → `moveItemToBucket(id, "multiStep")` → `requestBreakdown`,
    //     which PARKS the row in Multi-step with a "Break into steps now?" CTA —
    //     exactly what `Move to… → Multi-step` always did from here, so this spec's
    //     subject survives intact;
    //   • needs-review → `startBreakdown`, which navigates into the editor.
    // Both land in the same bucket, which is what the shared label names; the
    // difference in what happens next predates this change, and the owner's call
    // on #253 is to keep the split rather than reopen a settled interaction.
    //
    // The consequence, scoped precisely because the loose version of this sentence
    // contradicted a sibling spec: parking a Needs-review row **in MULTI-STEP**
    // without navigating is now drag-only. Parking one generally is NOT — its ▾
    // still carries `Save for later`, which is `dropPlan(needsReview →
    // savedLater)` and navigates nowhere. `inbox-view.drag.test.tsx` presses
    // exactly that entry, so an unqualified "parking is drag-only" here would have
    // been contradicted by the same MR one file over.
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(
      await within(row).findByRole("button", {
        name: "Add as multi-step to-do",
      }),
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

  it("not clicking the CTA blocks nothing: the row still moves elsewhere from the ▾", async () => {
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
    // #253 — the multi-step row's own destination entry, replacing the nested
    // picker. Same dispatcher, same `triage` action, one press fewer.
    await user.click(within(row).getByRole("button", { name: "All options" }));
    await user.click(
      await within(row).findByRole("button", {
        name: "Add as single-task to-do",
      }),
    );
    expect(triageBrainDumpItem).toHaveBeenCalledWith("aw1");
  });

  /**
   * #253 — an awaiting-breakdown row must still be completable.
   *
   * This state nulls out three of its own controls: `view-list-m` and
   * `focus-list-m` have nothing to point at with no steps yet, and the inline
   * cluster collapses to the single red `Break into steps now?` CTA. Group 2's
   * entry was written as `awaitingBreakdown ? break-now-m : complete-m`, so
   * `Mark as completed` was the fourth casualty — and unlike the other three it
   * has nothing to do with whether steps exist.
   *
   * With the nested picker gone (it used to offer `completed` from this row) that
   * left the state with NO route to complete: not in the ▾, not inline. The
   * reachable sequence is ordinary — drag an item into Multi-step, then realise
   * you have already done it — and the way out was to break it into steps you do
   * not want in order to reach a Complete you do.
   *
   * `break-now-m` stays first: it is the primary CTA for the state, and the twin
   * of the inline red button. Complete is added beside it, not in place of it.
   */
  it("an awaiting-breakdown row can still be completed from the ▾", async () => {
    const { completeItem } = await import("@/app/actions/braindump");
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
    // Scoped to the popup, because the inline red CTA carries the SAME label and
    // an unscoped query matches both — which is the whole reason this state was
    // able to lose its Complete unnoticed.
    const popup = within(row).getByRole("dialog", { name: "All options" });
    // Both entries are present in this state — the CTA twin AND Complete.
    // `action.breakNow`, the imperative — the ▾ entry no longer shares the card
    // CTA's question mark (#253 F1 split the key).
    expect(
      within(popup).getByRole("button", {
        name: "Break down in the editor",
      }),
    ).toBeInTheDocument();
    await user.click(
      within(popup).getByRole("button", { name: "Mark as completed" }),
    );
    expect(completeItem).toHaveBeenCalledWith("aw1");
  });

  it("the CTA twin is still the FIRST of the two, not displaced by Complete", async () => {
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
    const popup = within(row).getByRole("dialog", { name: "All options" });
    const labels = within(popup)
      .getAllByRole("button")
      .map((b) => b.textContent?.trim());
    expect(labels).toContain("Break down in the editor");
    expect(labels.indexOf("Break down in the editor")).toBeLessThan(
      labels.indexOf("Mark as completed"),
    );
  });

  it("a row WITH steps still shows Complete and no CTA twin", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
        initialItems={[
          makeItem({
            id: "st1",
            text: "has a plan",
            status: "triaged",
            breakdownRequestedAt: new Date(),
            stepsTotal: 3,
          }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("has a plan").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    const popup = within(row).getByRole("dialog", { name: "All options" });
    // Guard the guard: proves the fix did not simply render both entries in both
    // states, which would pass the two specs above while breaking this one.
    expect(
      within(popup).getByRole("button", { name: "Mark as completed" }),
    ).toBeInTheDocument();
    expect(
      within(popup).queryByRole("button", {
        name: "Break down in the editor",
      }),
    ).toBeNull();
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

  // #253 — the ▾ list's "Edit task title" entry is GONE, and the ✏️ pencil on the
  // title line is the whole edit affordance. The entry fired the identical
  // `setEditingId(item.id)`, and the survivor's name is strictly clearer because it
  // names the row ("Edit review item" against "Edit task title") — which is the
  // condition #253 puts on dropping a duplicate.
  //
  // Asserted both ways round, and the SECOND half is the load-bearing one: !337's
  // row lookup for #255 anchors on `Edit <item text>` being the row's one unique
  // accessible name, so a second control answering to it — or a rename of this one
  // — reintroduces a measured ~20% flake in the write-failure specs. The count is
  // pinned with the menu open, which is the state that used to hold two edit
  // controls per row.
  it("the ▾ list has no Edit entry; the ✏️ pencil is the row's single edit route and still opens the editor", async () => {
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
    const popup = within(row).getByRole("dialog", { name: "All options" });
    expect(
      within(popup).queryByText("Edit task title"),
      "the ▾ Edit mirror is back",
    ).toBeNull();
    // Still exactly one, with the popup open — the anchor !337 depends on.
    expect(
      within(row).getAllByRole("button", { name: "Edit review item" }),
    ).toHaveLength(1);
    // And it is the working route, not just the surviving name.
    await user.keyboard("{Escape}");
    await user.click(
      within(row).getByRole("button", { name: "Edit review item" }),
    );
    expect(within(row).getByRole("textbox")).toHaveValue("review item");
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
    // #253 — BOTH routes, because the ▾ list is the row's canonical action list and
    // the inline bar a shortcut subset of it. A pass mid-issue deleted this entry as
    // a duplicate of the inline CTA; it is back, and the two really do call the same
    // expression (`focusOnItem(item.id, item.text)`) — which is now the point.
    //
    // Asserted independently rather than "one of them fired", so a regression that
    // wires the entry to nothing cannot hide behind the button beside it.
    await user.click(
      within(row).getByRole("button", { name: "▶ Start Focus" }),
    );
    expect(ensureFocusStep).toHaveBeenCalledWith("s1");
    expect(push).toHaveBeenCalledWith("/focus/step-9");

    (ensureFocusStep as ReturnType<typeof vi.fn>).mockClear();
    push.mockClear();
    await openRowMenu(user, row);
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
    // #253 — four inline actions (main CTA, Save, Complete, Note), and they keep
    // the SHORT register: an inline button is space-constrained and read with the
    // row around it, so "Save" is named "Save". The full "Save for later" is the ▾
    // entry's, which is what the two registers are for.
    expect(
      within(row).getByRole("button", { name: "Save" }),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: "Complete" }),
    ).toBeInTheDocument();
    await openRowMenu(user, row);
    for (const name of ["Add as single-task to-do", "Delete"]) {
      expect(within(row).getByRole("button", { name })).toBeInTheDocument();
    }
    await user.keyboard("{Escape}");

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
    // #253 — four inline actions (main CTA, Save, Complete, Note), each named by
    // its short visible label; the full-label twins live in the ▾ list.
    for (const name of [/Break into steps/, "Save", "Complete"]) {
      expect(within(row).getByRole("button", { name })).toBeInTheDocument();
    }
    for (const name of ["Add to-do", "Move to"]) {
      expect(
        within(row).queryByRole("button", { name }),
      ).not.toBeInTheDocument();
    }
    await openRowMenu(user, row);
    // #253 — `Send back to review` replaces the nested picker here: it was the one
    // destination this frame's own four entries did not already name.
    for (const name of [
      "Add as single-task to-do",
      "Send back to review",
      "Delete",
    ]) {
      expect(within(row).getByRole("button", { name })).toBeInTheDocument();
    }
    await user.keyboard("{Escape}");
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
    // #253 — named "Save", by its own visible text. A mid-issue pass gave it an
    // `aria-label` of the full "Save for later" to stand in for a dropped ▾ entry;
    // that entry is restored, so this row would otherwise hold TWO controls
    // answering to "Save for later" — an ambiguous voice-control target, and a row
    // no query can pick either of them out of.
    const save = within(row).getByRole("button", { name: "Save" });
    // The full wording survives as the hover text, where it cannot enter the
    // accessible name (a `title` only names an element that has no other name).
    expect(save).toHaveAttribute("title", "Save for later");
    await user.click(save);
    expect(snoozeBrainDumpItem).toHaveBeenCalledWith("sv1", 60);
    expect(
      within(row).getByRole("button", { name: "Review now" }),
    ).toBeInTheDocument();
  });

  // The other register, on the same row and the same write: the ▾ entry spells it
  // out. Both routes are asserted because #253 restored this one as a deliberate
  // duplicate — the ▾ list is the row's canonical set — so "the inline button works"
  // is no longer evidence that the entry does.
  it("the ▾ 'Save for later' entry re-snoozes and closes the review frame", async () => {
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
    await openRowMenu(user, row);
    await user.click(
      within(row).getByRole("button", { name: "Save for later" }),
    );
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
    await openRowMenu(user, row);
    await user.click(
      within(row).getByRole("button", { name: "Add as single-task to-do" }),
    );
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
    await openRowMenu(user, row);
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
    await openRowMenu(user, row);
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
    // #253 — reached from the ▾ list now that the 📅 icon is gone. This is the
    // spec that proves the layout change did not delete #106: the entry has to
    // open the dialog, not fall back to pushing the server-resolved defaults.
    await openRowMenu(user, row);
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
    // #253 — the ▾ entry's presets expand in normal flow inside the list column
    // (see ScheduleControl's `menu` variant), rather than in an anchored popover.
    await openRowMenu(user, row);
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
    await openRowMenu(user, row);
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
    await openRowMenu(user, row);
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
    await openRowMenu(user, row);
    await user.click(within(row).getByRole("button", { name: /schedule/i }));
    await user.click(within(row).getByRole("button", { name: /^30 min$/i }));
    expect(
      await within(row).findByText(/Reclaim-synced Google Tasks list/i),
    ).toBeInTheDocument();
  });

  it("S0 guest (google={null}): rows show an ENABLED 'Add to calendar' control per row (not hidden, not disabled)", async () => {
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
    //
    // #253 — that affordance is a ▾ entry rather than an inline icon, so the rows
    // are opened one at a time. Still "one per row", which is the claim: a
    // per-row loop cannot pass by finding two on the same row.
    const user = userEvent.setup();
    expect(screen.queryByRole("button", { name: /^schedule$/i })).toBeNull();
    for (const text of ["plan trip", "single todo"]) {
      const row = screen.getByText(text).closest("li")!;
      await openRowMenu(user, row);
      const ics = within(row).getAllByRole("button", {
        name: /add to calendar/i,
      });
      expect(ics, `no Add to calendar on the "${text}" row`).toHaveLength(1);
      expect(ics[0]).toBeEnabled();
      await user.keyboard("{Escape}");
    }
  });

  it("S0 guest: the ▾ dropdown carries the 'Add to calendar' entry (enabled)", async () => {
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
    // #253 — ONE entry, not two. The pair was the inline 📅 plus its own full-text
    // mirror; the icon went with the end cluster, so the mirror became the control.
    const icsEntries = within(row).getAllByRole("button", {
      name: /add to calendar/i,
    });
    expect(icsEntries).toHaveLength(1);
    icsEntries.forEach((b) => expect(b).toBeEnabled());
  });

  it("needsReconnect: rows show the Reconnect link instead of the 📅 button", async () => {
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
    // #253 — the row's ▾ carries ONE entry for an unusable Google path, and it
    // NAVIGATES to the Integrations settings section rather than starting OAuth. The
    // label names the destination and then why it cannot happen yet, so the row still
    // says which state it is in — which is what this spec has always been about.
    //
    // Opened per row so "per row" is what is actually measured.
    const user = userEvent.setup();
    for (const text of ["plan trip", "single todo"]) {
      const row = screen.getByText(text).closest("li")!;
      await openRowMenu(user, row);
      const entries = within(row).getAllByRole("link", {
        name: "Schedule to calendar (reconnect needed)",
      });
      expect(entries, `no reconnect entry on the "${text}" row`).toHaveLength(
        1,
      );
      expect(entries[0]).toHaveAttribute(
        "href",
        "/settings#settings-integrations",
      );
      await user.keyboard("{Escape}");
    }
    // No row is a connect control any more — the assertion that lets #128's caveat
    // consolidate at the settings/breakdown/task-schedule controls that are.
    expect(
      document.querySelectorAll('a[href="/api/google/oauth/start"]'),
    ).toHaveLength(0);
  });

  it("not configured: rows show the Connect link instead of the 📅 button", async () => {
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
    const user = userEvent.setup();
    await openRowMenu(user, screen.getByText("single todo").closest("li")!);
    // #253 — a navigation entry into settings, not an OAuth link. Same information,
    // one 44px row, and the row stops being a connect control (see #128).
    const entry = screen.getByRole("link", {
      name: "Schedule to calendar (not connected)",
    });
    expect(entry).toHaveAttribute("href", "/settings#settings-integrations");
  });

  it("Duo fix: configured but NOT connected → the not-connected entry, not a live 📅 button", async () => {
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
    const user = userEvent.setup();
    await openRowMenu(user, screen.getByText("single todo").closest("li")!);
    expect(
      screen.getByRole("link", {
        name: "Schedule to calendar (not connected)",
      }),
    ).toHaveAttribute("href", "/settings#settings-integrations");
    // The original point of this spec, unchanged: `connected: false` must not render
    // a live Schedule control that would fail on press.
    expect(
      screen.queryByRole("button", {
        name: "Schedule to calendar (send to Google Tasks)",
      }),
    ).toBeNull();
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
    await openRowMenu(user, row);
    await user.click(
      within(row).getByRole("button", {
        name: "Schedule to calendar (send to Google Tasks)",
      }),
    );
    // #253 — the swap still happens and is still visible on the row; what it swaps
    // TO is the navigation entry rather than an inline OAuth link.
    expect(
      await within(row).findByRole("link", {
        name: "Schedule to calendar (reconnect needed)",
      }),
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
    // #253 — Schedule is a ▾ entry now, so each row's list is opened in turn.
    // Escape rather than clicking elsewhere: an outside press would dismiss the
    // OTHER row's popup and unmount the control this spec is holding a handle to.
    const rowA = screen.getByText("single todo").closest("li")!;
    const rowB = screen.getByText("plan trip").closest("li")!;
    await openRowMenu(user, rowB);
    expect(
      within(rowB).getByRole("button", { name: /schedule/i }),
    ).toBeEnabled();
    await user.keyboard("{Escape}");

    await openRowMenu(user, rowA);
    await user.click(within(rowA).getByRole("button", { name: /schedule/i }));
    await user.click(within(rowA).getByRole("button", { name: /^30 min$/i }));

    // Row A's own control: held, and it says why rather than going quietly
    // grey — a disabled button swallows a press with no error and no toast.
    const scheduleA = within(rowA).getByRole("button", { name: /schedule/i });
    expect(scheduleA).toBeDisabled();
    expect(scheduleA).toHaveAccessibleName(/already in progress for this row/i);
    await user.keyboard("{Escape}");

    // Row B: never a party to row A's push, so its press must land.
    await openRowMenu(user, rowB);
    const scheduleB = within(rowB).getByRole("button", { name: /schedule/i });
    expect(scheduleB).toBeEnabled();
    await user.click(scheduleB);
    expect(pushStepsToGoogleTasks).toHaveBeenCalledWith("t1", undefined);
    await user.keyboard("{Escape}");

    // Settle the transition before returning. An unresolved action outliving
    // the spec fires its state update during or after `afterEach(cleanup)`,
    // which is the same class of nondeterminism this file is removing — raised
    // by GitLab Duo on !264 and it applies verbatim here. The control becoming
    // live again is the observable end of the transition, so waiting on it
    // needs no arbitrary timeout.
    release({ ok: true });
    await openRowMenu(user, rowA);
    await waitFor(() =>
      expect(
        within(rowA).getByRole("button", { name: /schedule/i }),
      ).toBeEnabled(),
    );
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
    // #253 — Schedule is a ▾ entry; Escape closes rather than an outside press,
    // which would dismiss the popup this spec still needs.
    const rowB = screen.getByText("plan trip").closest("li")!;
    await openRowMenu(user, rowB);
    expect(
      within(rowB).getByRole("button", { name: /schedule/i }),
    ).toBeEnabled();
    await user.keyboard("{Escape}");

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
    await openRowMenu(user, renamingRow);
    expect(
      within(renamingRow).getByRole("button", { name: /schedule/i }),
    ).toBeEnabled();
    await user.keyboard("{Escape}");

    await openRowMenu(user, rowB);
    const scheduleB = within(rowB).getByRole("button", { name: /schedule/i });
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
    await openRowMenu(user, rowA);
    await user.click(within(rowA).getByRole("button", { name: /schedule/i }));
    await user.click(within(rowA).getByRole("button", { name: /^30 min$/i }));
    expect(
      await within(rowA).findByText(/Reclaim-synced Google Tasks list/i),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    // Row B (multi-step) then hits the workspace-wide reconnect_required condition.
    // #253 — the error itself is NOT in the popup: it renders under the row, so it
    // stays readable with every list closed. That is what lets this spec assert
    // both halves at one instant below.
    const rowB = screen.getByText("plan trip").closest("li")!;
    await openRowMenu(user, rowB);
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
        // #253 — the reconnect prompt is a navigation entry into settings now, so
        // the row is not a connect control. What this spec asserts is unchanged:
        // the workspace-wide reconnect condition reaches row B.
        within(rowB).getByRole("link", {
          name: "Schedule to calendar (reconnect needed)",
        }),
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
    await openRowMenu(user, row);
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
    await openRowMenu(user, row);
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
    await openRowMenu(user, row);
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
    await openRowMenu(user, screen.getByText("Call dentist").closest("li")!);
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
  // #253 — the frame that replaced v6's. Asserted as the EXACT list of controls
  // on the resting row, not as four presence checks: the whole claim is that the
  // row carries four actions and a ▾, and a presence check cannot see a fifth.
  it("renders exactly four inline actions plus the ▾ trigger", () => {
    render(
      <InboxView
        now={Date.now()}
        initialItems={[
          makeItem({ id: "n1", text: "capture me", taskId: "t-n1" }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    const group = row.querySelector<HTMLElement>("[data-row-actions]")!;
    expect(
      Array.from(group.querySelectorAll<HTMLElement>("button")).map(
        (b) => b.getAttribute("aria-label") ?? b.textContent,
      ),
    ).toEqual([
      "Break into steps →",
      // Short, by decision: an inline button is space-constrained and read with the
      // row's context around it, so it stays "Save". The full "Save for later" is
      // the ▾ entry's register — #253 keeps the two apart deliberately, because
      // putting the long labels inline is exactly what makes the row too tall at
      // 360px, which is the issue.
      "Save",
      "Complete",
      "Note for capture me",
      "All options",
    ]);
    // None of the three cluster icons survives anywhere on the resting row.
    for (const name of ["Move to", "Schedule", "Delete", "Add to-do"]) {
      expect(
        within(row).queryByRole("button", { name }),
        `"${name}" is still on the row`,
      ).not.toBeInTheDocument();
    }
  });

  // Every action the cluster carried is still reachable, and reachable by
  // KEYBOARD — the ▾ trigger is a button and the entries are ordinary buttons in
  // a dialog, so nothing here is gesture-only (#253's Bar).
  it("the move, Schedule and Delete routes are all reachable from the ▾ list", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
        initialItems={[makeItem({ id: "n1", text: "capture me" })]}
        settings={settings}
        google={{ configured: true, connected: true, needsReconnect: false }}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    await openRowMenu(user, row);
    // #253 — not "Move to…": the nested picker is gone and the entries name its
    // destinations directly. `Save for later` is asserted here because it is a bucket
    // MOVE dispatched through the same `moveItemToBucket` the picker used, so it is
    // the honest replacement for "the move route survives".
    for (const name of [
      "Save for later",
      "Schedule to calendar (send to Google Tasks)",
      "Delete",
    ]) {
      expect(
        within(row).getByRole("button", { name }),
        `"${name}" is not reachable from the ▾ list`,
      ).toBeInTheDocument();
    }
  });

  it("with Google connected, the ▾ list is where the Schedule entry lives", async () => {
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
    // #253 — ONE Schedule control, in the ▾ list. It was two (the 📅 icon plus its
    // full-text mirror) until the icon went with the end cluster.
    //
    // The label names the DESTINATION now, not the verb: the Google path posts to
    // `tasks.googleapis.com` into the Reclaim-synced list (`lib/google.ts`), which
    // is the one row action nobody could predict the effect of. Matched exactly, so
    // a silent revert to the bare "Schedule" fails here.
    const SCHEDULE = "Schedule to calendar (send to Google Tasks)";
    expect(
      within(row).queryByRole("button", { name: SCHEDULE }),
    ).not.toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "All options" }));
    expect(within(row).getAllByRole("button", { name: SCHEDULE })).toHaveLength(
      1,
    );
  });

  it("Add as single-task to-do (Keep-as-task) fires from the ▾ list", async () => {
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
    // #253 — Add to-do moved off the row into the ▾ list, under a label that names
    // the bucket it lands in (`section.singleTask`, "Single-task to-dos").
    await openRowMenu(user, row);
    await user.click(
      within(row).getByRole("button", { name: "Add as single-task to-do" }),
    );
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
    // #253 — named "Save", short register, and that is the whole name (see the
    // resting-frame spec above for why the mid-issue `aria-label` came off).
    await user.click(within(row).getByRole("button", { name: "Save" }));
    // The move went through moveItemToBucket → dropPlan(needsReview → savedLater)…
    expect(dropPlan).toHaveBeenCalledWith("needsReview", "savedLater");
    // …whose savedLater action lands the item in the Saved bucket
    // (ACTION_FOR_BUCKET.savedLater — snooze is how Saved membership is stored).
    expect(snoozeBrainDumpItem).toHaveBeenCalledWith("n1", 60);
  });

  // #253 — "Snooze 1h" is GONE from the ▾ list, by the owner's decision, and this
  // spec is what stops that being a silent loss of a write.
  //
  // The entry's own comment claimed it was "a SEPARATE action from Save for later"
  // — the literal one-hour timer against a bucket move. Only the PATH differed:
  // `ACTION_FOR_BUCKET.savedLater` is `"snooze"` (move-dispatch.ts), so the move
  // dispatcher runs the identical `snoozeBrainDumpItem(id, 60)`. What the entry
  // skipped was the dispatcher's no-op guard and its move announcement, which made
  // it the worse of the two routes for a screen-reader user.
  //
  // So the assertion is in two halves: the control is absent, AND the write it used
  // to reach still lands from the ▾ entry that replaces it.
  it("the ▾ list has no Snooze 1h, and its 60-minute write is still reachable from 'Save for later'", async () => {
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
    await openRowMenu(user, row);
    const popup = within(row).getByRole("dialog", { name: "All options" });
    expect(within(popup).queryByText("Snooze 1h")).toBeNull();
    await user.click(
      within(popup).getByRole("button", { name: "Save for later" }),
    );
    expect(dropPlan).toHaveBeenCalledWith("needsReview", "savedLater");
    expect(snoozeBrainDumpItem).toHaveBeenCalledWith("n1", 60);
  });

  it("delete is a ▾ entry and still requires a two-step confirm", async () => {
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
    await openRowMenu(user, row);
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(deleteBrainDumpItem).toHaveBeenCalledWith("n1");
  });

  /**
   * #253 — THE order spec, and the sequence in it is the owner's, judged from a
   * rendered 360px screenshot rather than agreed on paper (the previous ordering was
   * agreed on paper and read badly).
   *
   * `Delete` is the destructive answer and stays last. Before it, the actions that
   * reshape the item in the order they escalate — break it up, keep it whole, park
   * it, finish it — then the calendar pair.
   *
   * ⚠️ The nested `Move to…` picker LED this list until the owner saw it rendered.
   * It is gone, and these four entries are why: they ARE the four buckets it offered
   * from this row (`ACTION_FOR_BUCKET` minus `needsReview`, which is the row's own),
   * so it was a second route to the same places one tap deeper — and the only nested
   * popup left in the list.
   *
   * Four of these are TWINS of inline buttons, deliberately. The list is the row's
   * canonical, complete action set and the inline bar a shortcut subset of it, so a
   * duplicate is the design rather than clutter — and it costs no row height,
   * because the list is behind a trigger. A mid-issue pass deleted all four; this
   * exact-list assertion is what stops that happening again by accident in either
   * direction.
   *
   * Asserted as an exact ordered list rather than as presence checks, because the
   * claim is about sequence and completeness and a presence check can see neither.
   */
  it("the ▾ list is the row's canonical actions, in the owner's order", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
        initialItems={[makeItem({ id: "n1", text: "capture me" })]}
        settings={settings}
        google={{ configured: true, connected: true, needsReconnect: false }}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    const popup = within(row).getByRole("dialog", { name: "All options" });
    expect(
      within(popup)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      // #253 F1 — TWO break-up entries, because they are genuinely different acts
      // and this row previously offered neither honestly. `Break into steps`
      // navigates into the editor (`startBreakdown`); `Add as multi-step to-do`
      // PARKS the item in that bucket (`moveItemToBucket(…, "multiStep")` →
      // `requestBreakdown`), which is a legitimate permanent resting state —
      // `bucketOfItem` keeps an item there on `breakdownRequestedAt` alone and
      // nothing reaps that stamp.
      //
      // The navigating entry stays FIRST so behaviour-by-position is preserved: a
      // user who pressed the first entry before this change still gets the editor.
      "Break down in the editor",
      "Add as multi-step to-do",
      "Add as single-task to-do",
      "Save for later",
      "Mark as completed",
      "Schedule to calendar (send to Google Tasks)",
      "Add to calendar (.ics)",
      "Delete",
    ]);
    // Named individually so a revert to either superseded wording fails here rather
    // than only shifting the list. "Snooze 1h" is the owner's deletion; the other
    // three are the labels the destination-naming rule replaced.
    for (const gone of [
      "Snooze 1h",
      "Break into smaller steps",
      "Add as single task to do",
      "Edit task title",
      // #253 — the nested picker. These four entries ARE the four buckets it offered
      // from this row (`ACTION_FOR_BUCKET` minus `needsReview`, which is this row's
      // own), so it was a second route to the same places one tap deeper — and the
      // only nested popup left in the list.
      "Move to…",
    ]) {
      expect(
        within(popup).queryByText(gone),
        `"${gone}" is back in the ▾ list`,
      ).toBeNull();
    }
    // The ✏️ pencil beside the title is NOT in the list and stays on the row.
    expect(
      within(row).getAllByRole("button", { name: "Edit capture me" }),
    ).toHaveLength(1);
  });

  /**
   * The same exact list in PLAYFUL voice, because a label can be renamed in one
   * voice and left behind in the other — and nothing in this suite rendered a ▾ list
   * in playful at all until #253's review, so the longer of the two variants was
   * entirely unmeasured.
   *
   * `Delete` is deliberately identical across voices (`action.delete`), as is
   * `Add to calendar (.ics)`'s 📅. The two break-up entries share 🍿 on purpose: the
   * playful column is frozen while #86 decides whether that voice survives, so a new
   * key carries the existing emoji onto new words and invents no new metaphor.
   */
  it("the ▾ list keeps the same order and completeness in playful voice", async () => {
    const user = userEvent.setup();
    render(
      <VoiceProvider voice="playful">
        <InboxView
          now={Date.now()}
          initialItems={[makeItem({ id: "n1", text: "capture me" })]}
          settings={settings}
          google={{ configured: true, connected: true, needsReconnect: false }}
          welcomeVisible={false}
          resumeStep={null}
        />
      </VoiceProvider>,
    );
    const row = screen.getByText("capture me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    const popup = within(row).getByRole("dialog", { name: "All options" });
    expect(
      within(popup)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      "🍿 Break down in the editor",
      "🍿 Add as multi-step to-do",
      "🍽️ Add as single-task to-do",
      "🥫 Save for later",
      "✅ Mark as completed",
      "🗓️ Schedule to calendar (send to Google Tasks)",
      "📅 Add to calendar (.ics)",
      "Delete",
    ]);
    // The card's inline prompt keeps its question mark and its own wording. Pinned
    // here because the ▾ entry and that CTA shared ONE key until this change, and
    // the whole point of splitting them is that they now diverge.
    expect(within(popup).queryByText("🍿 Snack-size it now?")).toBeNull();
  });

  /**
   * The two break-up entries must dispatch DIFFERENT writes. Same-label,
   * same-destination entries were the defect; two distinctly-labelled entries that
   * both call `startBreakdown` would be the same defect with better copy.
   */
  it("the two break-up entries dispatch different writes", async () => {
    const { startBreakdown } = await import("@/app/actions/breakdown");
    const { requestBreakdown } = await import("@/app/actions/braindump");
    (startBreakdown as ReturnType<typeof vi.fn>).mockResolvedValue("t7");
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
    const popup = within(row).getByRole("dialog", { name: "All options" });

    // The PARK entry: through `moveItemToBucket`, so `dropPlan`'s
    // `ACTION_FOR_BUCKET.multiStep` picks `requestBreakdown` — byte-identical to the
    // drag path, no navigation.
    await user.click(
      within(popup).getByRole("button", {
        name: "Add as multi-step to-do",
      }),
    );
    expect(requestBreakdown).toHaveBeenCalledWith("n1");
    expect(startBreakdown).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("the navigating entry opens the editor and does not park", async () => {
    const { startBreakdown } = await import("@/app/actions/breakdown");
    const { requestBreakdown } = await import("@/app/actions/braindump");
    (startBreakdown as ReturnType<typeof vi.fn>).mockResolvedValue("t7");
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
    const popup = within(row).getByRole("dialog", { name: "All options" });
    await user.click(
      within(popup).getByRole("button", {
        name: "Break down in the editor",
      }),
    );
    expect(startBreakdown).toHaveBeenCalledWith("n1");
    expect(push).toHaveBeenCalledWith("/tasks/t7");
    expect(requestBreakdown).not.toHaveBeenCalled();
  });

  /**
   * #253 — the groups are VISIBLE, not just implied by sequence. The owner's second
   * complaint was that the column had "no thoughtful ordering at all", and half of
   * that was the absence of any structure the eye could use: nine identical 44px
   * rows read as a wall whatever order they are in.
   *
   * Asserted on the popup's own children in document order, because that is the only
   * way to see WHERE the rules fall. A count of separators would pass on three rules
   * stacked at the bottom.
   *
   * They must also be invisible to assistive technology and to the target-size
   * guards: no role, no accessible name, nothing announced as a menu entry. The
   * button count either side of this assertion is what proves they are not entries.
   */
  it("the ▾ list draws its three intent groups with decorative separators", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
        initialItems={[makeItem({ id: "n1", text: "capture me" })]}
        settings={settings}
        google={{ configured: true, connected: true, needsReconnect: false }}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    const popup = within(row).getByRole("dialog", { name: "All options" });
    // "sep" wherever a rule sits, the entry's own text everywhere else.
    expect(
      Array.from(popup.children).map((el) =>
        el.getAttribute("aria-hidden") === "true" && !el.textContent
          ? "sep"
          : el.textContent,
      ),
    ).toEqual([
      // #253 F1 — the navigating entry leads; the park entry follows it.
      "Break down in the editor",
      "Add as multi-step to-do",
      "Add as single-task to-do",
      "Save for later",
      "Mark as completed",
      "sep",
      "Schedule to calendar (send to Google Tasks)",
      "Add to calendar (.ics)",
      "sep",
      "Delete",
    ]);
    // Decoration, not content: nothing here has a role, so the seven buttons above
    // are still the whole list as far as AT and the 44px guard are concerned.
    // 8 since #253 F1 added the park entry beside the navigating one.
    expect(within(popup).getAllByRole("button")).toHaveLength(8);
    // Scoped to the popup's own children — belt-and-braces now that the nested
    // picker and its `aria-hidden` disclosure chevron have gone: a group rule is a
    // direct child of the popup, an entry's own decoration is not.
    expect(
      popup.querySelectorAll(":scope > [aria-hidden='true']"),
    ).toHaveLength(2);
  });

  /**
   * A workspace with no Google connection renders ONE calendar control, not two:
   * `schedule` becomes the .ics one and `icsMenu` is null. So the group is a single
   * entry — and the assertion that matters is that it still gets exactly one rule
   * above it and one below, rather than an empty band.
   *
   * This is the case `groupedRowMenu` exists for. Written inline, the separators
   * would be unconditional and a guest row would paint a rule against nothing.
   */
  it("with no Google connection the calendar group collapses to one entry and no stray rule", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
        initialItems={[makeItem({ id: "n1", text: "capture me" })]}
        settings={settings}
        google={null}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    const popup = within(row).getByRole("dialog", { name: "All options" });
    expect(
      within(popup)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      // #253 F1 — the navigating entry leads; the park entry follows it.
      "Break down in the editor",
      "Add as multi-step to-do",
      "Add as single-task to-do",
      "Save for later",
      "Mark as completed",
      // The Google entry is absent, so this row's Schedule control IS the .ics one —
      // `scheduleMenuLabel` picks the label off the state, and there is exactly one.
      "Add to calendar (.ics)",
      "Delete",
    ]);
    expect(
      popup.querySelectorAll(":scope > [aria-hidden='true']"),
    ).toHaveLength(2);
  });

  // Every ▾ entry carries the 44px minimum (`rowMenuEntry`) — including the four
  // restored twins, whose inline siblings do not exempt them: a person operating the
  // list has no shortcut bar under their thumb. Height only, since a full-width entry
  // is already well past 44px wide. jsdom computes no layout, so the classes are what
  // is checked.
  it("every ▾ entry carries the 44px minimum height", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
        initialItems={[makeItem({ id: "n1", text: "capture me" })]}
        settings={settings}
        google={{ configured: true, connected: true, needsReconnect: false }}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("capture me").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "All options" }));
    const entries = within(
      within(row).getByRole("dialog", { name: "All options" }),
    ).getAllByRole("button");
    // 8 since #253 F1 added the park entry beside the navigating one.
    expect(entries).toHaveLength(8);
    for (const entry of entries) {
      expect(entry.className, `"${entry.textContent}"`).toContain("min-h-11");
    }
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

  it("NOW offers a note on an untriaged item — #186 gave it a column", () => {
    // This assertion used to be its inverse, and #44 was right at the time: a
    // brain-dump item in Needs review has no `Task` row, so there was no `notes`
    // column and the control could only render as nothing. #186 added
    // `BrainDumpItem.notes` and #179 writes it at CAPTURE, which makes this the
    // bucket where a note is now MOST likely to already exist. Rewritten rather
    // than deleted, so the reversal reads as a decision with a reason.
    render1(makeItem({ id: "n1", text: "raw thought", taskId: null }));
    expect(
      screen.getByRole("button", { name: "Note for raw thought" }),
    ).toBeTruthy();
  });

  // The null-`itemId` branch is deliberately NOT tested from here — a test that
  // claimed to and did not is what this replaces (review, `!281`). It rendered the
  // same item as the case above, asserted the control WAS present (the opposite of
  // its own title), and could not have done otherwise: `InboxView` always passes
  // `itemId={item.id}` to `TaskNoteRow`, so there is no route through this surface
  // that reaches a null item id. The branch is only reachable from Library rows.
  //
  // Its real coverage lives where the branch is reachable, at the component's own
  // grain: `task-note.test.tsx` → "still renders nothing when there is no row to
  // write to at all", which renders `<TaskNoteRow taskId={null} itemId={null}>` and
  // asserts the render prop receives `{ trigger: null, body: null }` while the
  // caller's own placeholder still mounts. That is the behaviour that matters, and
  // asserting it here would have been a second, weaker copy of it.
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

  it("sizes the ARMED delete confirm, in both factories that render one", async () => {
    // #251 review — the blind spot this guard has, closed rather than only
    // diagnosed. `expectFullTargets` measures every control in every
    // `[data-row-actions]` group and never opens a confirm, so the armed
    // "Delete · Cancel" pair was unmeasured in all four copies of it. #251 sized
    // three and added confirm-opening tests for two, which left `ItemRow`'s own
    // factory — the one rendered for every untriaged row, the app's busiest
    // surface — at 24px on exactly the press where a mis-tap deletes something
    // (WCAG 2.5.5).
    //
    // `confirmDeleteId` is list-wide, so arming one row disarms the other: the
    // rows are armed and measured one at a time rather than together.
    const user = userEvent.setup();
    const { container } = render(
      <InboxView
        now={Date.now()}
        initialItems={[
          // `ItemRow`'s own `deleteControl` — the untriaged review row.
          makeItem({ id: "t251f4a", text: "review row" }),
          // `InboxView`'s `deleteControl`, via the Done bucket's action line.
          makeItem({
            id: "t251f4b",
            text: "finished thing",
            status: "triaged",
            completedAt: new Date(),
          }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );

    // #253 — the review row's Delete is a ▾ entry; the Done bucket hand-rolls its
    // action line and keeps its inline 🗑, so only one of the two needs opening.
    for (const text of ["review row", "finished thing"]) {
      const row = screen.getByText(text).closest("li")!;
      if (text === "review row") await openRowMenu(user, row);
      await user.click(within(row).getByRole("button", { name: "Delete" }));
      // Really armed, so a pass cannot come from having measured the resting
      // state twice.
      expect(
        within(row).getByRole("button", { name: "Cancel" }),
      ).toBeInTheDocument();
      expectFullTargets(container);
    }
  });

  it("hides the confirm's decorative separator from assistive technology", async () => {
    // #251 hid this `·` in both Library factories and neither inbox one, so the
    // same armed confirm reads as "Delete · Cancel" here and "Delete Cancel"
    // there. It is punctuation between two buttons and carries no meaning.
    //
    // The confirm has to be OPENED to see it — the first version of this spec
    // asserted over the resting markup and passed against the unfixed code,
    // because the separator only exists in the armed branch and the `·` it found
    // in `container.innerHTML` belonged to an unrelated, already-hidden row meta.
    // A vacuous pass on a guard for an invisible element is the whole reason this
    // fold exists, so it is worth naming here.
    const user = userEvent.setup();
    const { container } = render(
      <InboxView
        now={Date.now()}
        initialItems={[
          makeItem({ id: "t251f4c", text: "review row" }),
          makeItem({
            id: "t251f4d",
            text: "finished thing",
            status: "triaged",
            completedAt: new Date(),
          }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    for (const text of ["review row", "finished thing"]) {
      const row = screen.getByText(text).closest("li")!;
      // #253 — see the note on the spec above: only the `RowActions` row moved.
      if (text === "review row") await openRowMenu(user, row);
      await user.click(within(row).getByRole("button", { name: "Delete" }));
      const pair = within(row)
        .getByRole("button", { name: "Cancel" })
        .closest("span")!;
      const separators = Array.from(
        pair.querySelectorAll<HTMLElement>("span"),
      ).filter((s) => s.textContent === "·");
      // The non-zero control, per row: the separator is really in this pair, so
      // the loop below cannot be checking an empty list.
      expect(
        separators,
        `no separator in the armed pair for "${text}"`,
      ).toEqual([expect.anything()]);
      expect(separators[0]).toHaveAttribute("aria-hidden", "true");
    }
    expect(container).toBeTruthy();
  });
});
// ── #186 — the "add note" affordance on both brain-dump fields ──────────────
//
// #179 shipped the inline note syntax with nothing on screen announcing it, and
// `{`/`}` are two or three taps deep in a phone's symbol keyboard. The button's
// own behaviour (where the caret lands, both branches) is covered in
// `add-note-button.test.tsx`; what is asserted here is that it is MOUNTED on
// both fields and named after the right one — the capture bar and an open row
// editor are on screen together, so two buttons called "Add note" would be two
// controls a screen-reader or voice-control user cannot tell apart.
describe("InboxView — the inline-note affordance (#186)", () => {
  const renderInbox = (items: Item[] = []) =>
    render(
      <InboxView
        now={Date.now()}
        initialItems={items}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );

  it("puts a button on the capture bar, named after that field", () => {
    renderInbox();
    expect(
      screen.getByRole("button", { name: "Add note for Brain dump" }),
    ).toBeTruthy();
  });

  it("inserts the braces into the capture field", async () => {
    const user = userEvent.setup();
    renderInbox();
    const input = screen.getByRole("textbox", { name: "Brain dump" });
    await user.type(input, "buy milk");
    await user.click(
      screen.getByRole("button", { name: "Add note for Brain dump" }),
    );
    await waitFor(() => expect(input).toHaveValue("buy milk {}"));
  });

  it("teaches the syntax in the capture field's DESCRIPTION", () => {
    // The hint is the only thing that says the rule is "at the END" — someone
    // who learns only the braces meets a refusal (`fix the {foo} handler`) and
    // reads it as a bug. Associated with the field rather than left as orphaned
    // text, which is the #183 obligation this paragraph already carried.
    renderInbox();
    const input = screen.getByRole("textbox", { name: "Brain dump" });
    const describedBy = input.getAttribute("aria-describedby") as string;
    expect(document.getElementById(describedBy)?.textContent).toContain(
      "Put a note in {curly braces} at the end.",
    );
  });

  it("puts a button on the ✎ row editor, named after that row", async () => {
    const user = userEvent.setup();
    renderInbox([makeItem({ id: "r1", text: "water the plants" })]);
    const row = screen.getByText("water the plants").closest("li")!;
    await user.click(
      within(row).getByRole("button", { name: "Edit water the plants" }),
    );
    expect(
      screen.getByRole("button", { name: "Add note for water the plants" }),
    ).toBeTruthy();
    // And the capture bar's is still there, under its own name — the two are
    // distinguishable, which is the whole reason `subject` exists.
    expect(
      screen.getByRole("button", { name: "Add note for Brain dump" }),
    ).toBeTruthy();
  });

  it("carries the composed string through to renameItem", async () => {
    const { renameItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    renderInbox([makeItem({ id: "r1", text: "water the plants" })]);
    const row = screen.getByText("water the plants").closest("li")!;
    await user.click(
      within(row).getByRole("button", { name: "Edit water the plants" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Add note for water the plants" }),
    );
    const editor = screen.getByRole("textbox", { name: "Edit title" });
    await waitFor(() => expect(editor).toHaveFocus());
    await user.keyboard("can under sink{Enter}");
    expect(renameItem).toHaveBeenCalledWith(
      "r1",
      "water the plants {can under sink}",
    );
  });

  it("describes the row editor with the same rule, for a screen reader", () => {
    // The row editor has no room for a visible hint line, and repeating one per
    // row would be noise on a dense list. A referenced `hidden` node contributes
    // its text to the description without rendering, which is the dialect
    // `MOVE_INSTRUCTIONS` already uses on this surface.
    renderInbox([makeItem({ id: "r1", text: "water the plants" })]);
    const row = screen.getByText("water the plants").closest("li")!;
    fireEvent.click(
      within(row).getByRole("button", { name: "Edit water the plants" }),
    );
    const editor = screen.getByRole("textbox", { name: "Edit title" });
    const describedBy = editor.getAttribute("aria-describedby") as string;
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy)?.textContent).toContain(
      "Put a note in {curly braces} at the end.",
    );
  });
});

// ── #179 / #186 — the captured note, on the row and in the ✎ editor ─────────
//
// A note split off at capture has to be readable, or an inline capture is
// indistinguishable from text that went missing. And the ✎ field is pre-filled
// with the RECONSTRUCTION (`text {note}`) rather than the bare text, which is
// what makes an unchanged save a no-op instead of eroding the text one brace
// group at a time.
describe("InboxView — the captured inline note (#179/#186)", () => {
  const renderInbox = (items: Item[]) =>
    render(
      <InboxView
        now={Date.now()}
        initialItems={items}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );

  it("shows an untriaged row's note without anyone expanding anything", () => {
    renderInbox([
      makeItem({
        id: "r1",
        text: "water the plants",
        itemNotes: "can under sink",
      }),
    ]);
    expect(
      screen.getAllByTestId("note-text").map((n) => n.textContent),
    ).toContain("can under sink");
  });

  it("offers the note control on a Needs-review row, named after it", () => {
    // The absence !270 documented was correct then and is wrong now: #186 gave
    // `BrainDumpItem` its own `notes` column, so the save can succeed.
    renderInbox([makeItem({ id: "r1", text: "water the plants" })]);
    expect(
      screen.getByRole("button", { name: "Note for water the plants" }),
    ).toBeTruthy();
  });

  it("shows a Saved-for-later row's note without opening the row", async () => {
    // Parked rows are untriaged as well, so a note that vanished because somebody
    // moved a row to the pantry would be the same defect in a quieter place.
    //
    // READING it costs nothing; EDITING it follows the row's own design, where the
    // action group stays hidden until you engage with the row (a sleeping pantry
    // row shows only "Review now"). Deliberately not special-cased: a note
    // trigger permanently visible on a dimmed row would be the only control that
    // ignored that rule.
    const user = userEvent.setup();
    renderInbox([
      makeItem({
        id: "v1",
        text: "book the dentist",
        itemNotes: "before the 20th",
        snoozedUntil: new Date(Date.now() + 3_600_000),
      }),
    ]);
    expect(
      screen.getAllByTestId("note-text").map((n) => n.textContent),
    ).toContain("before the 20th");
    // Collapsed: no trigger yet.
    expect(
      screen.queryByRole("button", { name: "Note for book the dentist" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "book the dentist" }));
    expect(
      screen.getByRole("button", { name: "Note for book the dentist" }),
    ).toBeTruthy();
  });

  it("pre-fills the ✎ editor with the RECONSTRUCTION, not the bare text", async () => {
    const user = userEvent.setup();
    renderInbox([
      makeItem({
        id: "r1",
        text: "water the plants",
        itemNotes: "can under sink",
      }),
    ]);
    const row = screen.getByText("water the plants").closest("li")!;
    await user.click(
      within(row).getByRole("button", { name: "Edit water the plants" }),
    );
    expect(screen.getByRole("textbox", { name: "Edit title" })).toHaveValue(
      "water the plants {can under sink}",
    );
  });

  it("an unchanged save never reaches the server at all", async () => {
    // Belt as well as braces: `resolveInlineNoteEdit` makes the SAVE a no-op, and
    // this makes the round trip not happen. Before the reconstruction the field
    // held `water the plants`, which differed from nothing and so always did.
    const { renameItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    renderInbox([
      makeItem({
        id: "r1",
        text: "water the plants",
        itemNotes: "can under sink",
      }),
    ]);
    const row = screen.getByText("water the plants").closest("li")!;
    await user.click(
      within(row).getByRole("button", { name: "Edit water the plants" }),
    );
    await user.keyboard("{Enter}");
    expect(renameItem).not.toHaveBeenCalled();
  });

  it("carries the note back with an edit to the text half", async () => {
    const { renameItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    renderInbox([
      makeItem({
        id: "r1",
        text: "water the plants",
        itemNotes: "can under sink",
      }),
    ]);
    const row = screen.getByText("water the plants").closest("li")!;
    await user.click(
      within(row).getByRole("button", { name: "Edit water the plants" }),
    );
    const editor = screen.getByRole("textbox", { name: "Edit title" });
    await user.clear(editor);
    // `{{` is user-event's escape for a literal brace — the syntax under test is
    // made of the one character its keyboard API reserves.
    await user.type(editor, "water the office plants {{can under sink}{Enter}");
    expect(renameItem).toHaveBeenCalledWith(
      "r1",
      "water the office plants {can under sink}",
    );
  });

  it("the Add-note button lands in the note the row already has", async () => {
    // Where the two halves meet. The reconstruction puts the existing note in the
    // field, so `inlineNoteInsertion` finds a trailing group and the caret goes
    // INSIDE it — appending would promote a new group to note and demote this one
    // to text.
    const user = userEvent.setup();
    renderInbox([
      makeItem({
        id: "r1",
        text: "water the plants",
        itemNotes: "can under sink",
      }),
    ]);
    const row = screen.getByText("water the plants").closest("li")!;
    await user.click(
      within(row).getByRole("button", { name: "Edit water the plants" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Add note for water the plants" }),
    );
    const editor = screen.getByRole("textbox", {
      name: "Edit title",
    }) as HTMLInputElement;
    await waitFor(() => expect(editor).toHaveFocus());
    expect(editor.selectionStart).toBe(
      "water the plants {can under sink".length,
    );
    await user.keyboard(" — rinse it");
    expect(editor).toHaveValue("water the plants {can under sink — rinse it}");
  });

  it("leaves a task-backed row reading its TASK note, not the leftover copy", () => {
    // The grain rule, at the surface. Triage copies the item note onto the task;
    // showing the item's copy afterwards would resurrect whatever it held when
    // triage ran, including a note since deleted.
    renderInbox([
      makeItem({
        id: "s1",
        text: "single item",
        status: "triaged",
        taskId: "t1",
        notes: "live task note",
        itemNotes: "stale item copy",
      }),
    ]);
    const shown = screen.getAllByTestId("note-text").map((n) => n.textContent);
    expect(shown).toContain("live task note");
    expect(shown).not.toContain("stale item copy");
  });
});

/**
 * #201 — auto-closing the note brace as it is typed.
 *
 * The rule itself is unit-tested in `braindump-note-syntax.test.ts`; these are
 * the wiring: that the two fields carrying note syntax are bound to it, that the
 * caret ends up where the rule said, and that a capture is never intercepted.
 *
 * `fireEvent.keyDown` rather than `userEvent.type`: jsdom performs no default
 * text insertion for a key event, so this exercises exactly the handler's own
 * output — which is what a controlled input renders in a real browser too, since
 * the handler calls `preventDefault`.
 */
describe("InboxView — auto-closing the note brace (#201)", () => {
  /**
   * Press `key` and report whether the handler CLAIMED the keystroke.
   *
   * `fireEvent.keyDown` returns `!defaultPrevented`, and that return value is the
   * only thing separating "the rule declined" from "the rule is not wired up at
   * all" (!306, substitute review). jsdom performs no default text insertion for
   * a key event, so on the negative branches an unchanged value is exactly what a
   * MISSING handler produces too — three specs below passed with
   * `handleNoteBraceKey` deleted. Asserting `claimed` is what makes them discriminate.
   */
  async function typeBrace(
    el: HTMLInputElement,
    key: string,
    init: Record<string, unknown> = {},
  ): Promise<{ claimed: boolean }> {
    let notPrevented = true;
    await act(async () => {
      notPrevented = fireEvent.keyDown(el, { key, ...init });
      await Promise.resolve();
    });
    return { claimed: !notPrevented };
  }

  function captureField() {
    return screen.getByPlaceholderText(/Brain dump/i) as HTMLInputElement;
  }

  it("inserts the closing brace and leaves the caret between the pair", async () => {
    render(
      <InboxView
        now={Date.now()}
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const input = captureField();
    fireEvent.change(input, { target: { value: "water the plants " } });
    input.setSelectionRange(17, 17);

    await typeBrace(input, "{");

    expect(input).toHaveValue("water the plants {}");
    expect(input.selectionStart).toBe(18);
    expect(input.selectionEnd).toBe(18);
  });

  it("wraps a selection instead of replacing it", async () => {
    render(
      <InboxView
        now={Date.now()}
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const input = captureField();
    fireEvent.change(input, { target: { value: "water the plants" } });
    input.setSelectionRange(6, 16);

    await typeBrace(input, "{");

    expect(input).toHaveValue("water {the plants}");
  });

  it("types over the closing brace rather than producing `}}`", async () => {
    render(
      <InboxView
        now={Date.now()}
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const input = captureField();
    fireEvent.change(input, { target: { value: "buy milk {oat}" } });
    input.setSelectionRange(13, 13);

    await typeBrace(input, "}");

    expect(input).toHaveValue("buy milk {oat}");
    expect(input.selectionStart).toBe(14);
  });

  it("backspacing the opening brace takes the pair with it", async () => {
    render(
      <InboxView
        now={Date.now()}
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const input = captureField();
    fireEvent.change(input, { target: { value: "buy milk {}" } });
    input.setSelectionRange(10, 10);

    await typeBrace(input, "Backspace");

    expect(input).toHaveValue("buy milk ");
    expect(input.selectionStart).toBe(9);
  });

  // #179 Decision 1: only the LAST group is the note, so a second one would
  // silently reassign which text becomes the note.
  it("refuses when the field already ends in a brace group", async () => {
    render(
      <InboxView
        now={Date.now()}
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const input = captureField();
    fireEvent.change(input, { target: { value: "fix {foo}" } });
    input.setSelectionRange(9, 9);

    const { claimed } = await typeBrace(input, "{");

    // Unchanged: the browser is left to type the `{` literally, which is what
    // the parser expects of a group that is not the last one. `claimed` is what
    // distinguishes that from the handler being absent — see `typeBrace`.
    expect(claimed).toBe(false);
    expect(input).toHaveValue("fix {foo}");
  });

  it("never intercepts the Enter that captures", async () => {
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
    const input = captureField();

    await user.type(input, "buy milk{enter}");

    expect(createBrainDumpItem).toHaveBeenCalledWith("buy milk");
  });

  it("leaves an IME composition alone", async () => {
    render(
      <InboxView
        now={Date.now()}
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const input = captureField();
    fireEvent.change(input, { target: { value: "note " } });
    input.setSelectionRange(5, 5);

    const { claimed } = await typeBrace(input, "{", { isComposing: true });

    // Not merely "the value did not change" — that is also what no handler at
    // all looks like in jsdom. The handler must have let the keystroke through.
    expect(claimed).toBe(false);
    expect(input).toHaveValue("note ");
  });

  it("leaves a Cmd/Ctrl chord alone, so undo still reaches the browser", async () => {
    render(
      <InboxView
        now={Date.now()}
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const input = captureField();
    fireEvent.change(input, { target: { value: "buy milk {}" } });
    input.setSelectionRange(10, 10);

    const { claimed } = await typeBrace(input, "Backspace", { metaKey: true });

    expect(claimed).toBe(false);
    expect(input).toHaveValue("buy milk {}");
  });

  /**
   * The positive counterpart to the three `claimed: false` assertions above, and
   * the reason they mean anything: the same channel reads `true` when the rule
   * fires (!306, substitute review). Without this, "claimed is false" could be a
   * `fireEvent` return value that is always false and nobody would know.
   */
  it("claims the keystroke when the rule does fire", async () => {
    render(
      <InboxView
        now={Date.now()}
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const input = captureField();
    fireEvent.change(input, { target: { value: "buy milk " } });
    input.setSelectionRange(9, 9);

    const { claimed } = await typeBrace(input, "{");

    expect(claimed).toBe(true);
    expect(input).toHaveValue("buy milk {}");
  });

  // The ✎ editor is the other field the parser reads, so it gets the same rule.
  // Its pre-fill is the reconstruction (`text {note}`), which already ends in a
  // group — so the interesting case is a row with NO note.
  it("applies to the ✎ row title editor too", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
        initialItems={[makeItem({ text: "water the plants" })]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /edit water the plants/i }),
    );
    const editor = screen.getByDisplayValue(
      "water the plants",
    ) as HTMLInputElement;
    editor.setSelectionRange(16, 16);

    await typeBrace(editor, "{");

    expect(editor).toHaveValue("water the plants{}");
  });
});

/**
 * #253 — the `stepsTotal` suppression is actually WIRED on both rows that render
 * `MoveToMenu`. The prop existing is not the fix; a prop no caller passes is inert,
 * which is the shape #213 was written against and which this MR deleted three other
 * props for.
 *
 * Both rows can hold a steps-bearing item, and the Done row is the MORE reachable of
 * the two:
 *
 *  • **Done row — two presses.** Complete a multi-step task; it lands here with its
 *    steps intact. `dropPlan` sets `reopenFirst` for a completed source, and
 *    `reopenItem` guarantees ≥1 not-done step, so after the reopen the item is
 *    triaged with `stepsTotal > 1` → `bucketOfItem` returns `multiStep`, never
 *    `singleTask`.
 *  • **Saved row — four presses.** Send a Multi-step row back to review (which
 *    retains the Task and its steps), then Save for later.
 */
describe("InboxView — MoveToMenu's Single-task suppression is wired (#253)", () => {
  const openMoveMenu = async (
    row: HTMLElement,
    user: ReturnType<typeof userEvent.setup>,
  ) => {
    await user.click(within(row).getByRole("button", { name: "Move to" }));
    return screen.findByRole("menu");
  };

  it("the idle SAVED row hides Single-task for a steps-bearing item", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
        initialItems={[
          makeItem({
            id: "sv-steps",
            text: "saved multi",
            snoozedUntil: new Date(Date.now() + 60 * 60_000),
            taskId: "tsv",
            stepsTotal: 3,
            stepsDone: 0,
          }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("saved multi").closest("li")!;
    await openMoveMenu(row, user);
    expect(
      screen.queryByRole("menuitem", { name: /Single-task/ }),
    ).not.toBeInTheDocument();
    // Control on the same surface: the other targets still render, so this is a
    // suppression rather than a menu that failed to open.
    expect(
      await screen.findByRole("menuitem", { name: /Multi-step/ }),
    ).toBeInTheDocument();
  });

  it("the idle SAVED row still offers it for a stepless item", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
        initialItems={[
          makeItem({
            id: "sv-plain",
            text: "saved plain",
            snoozedUntil: new Date(Date.now() + 60 * 60_000),
          }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("saved plain").closest("li")!;
    await openMoveMenu(row, user);
    expect(
      await screen.findByRole("menuitem", { name: /Single-task/ }),
    ).toBeInTheDocument();
  });

  it("the DONE row hides Single-task for a completed multi-step task", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
        initialItems={[
          makeItem({
            id: "dn-steps",
            text: "finished multi",
            status: "triaged",
            completedAt: new Date(),
            taskId: "tdn",
            stepsTotal: 3,
            stepsDone: 3,
          }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("finished multi").closest("li")!;
    await openMoveMenu(row, user);
    expect(
      screen.queryByRole("menuitem", { name: /Single-task/ }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("menuitem", { name: /Needs review/ }),
    ).toBeInTheDocument();
  });

  it("the DONE row still offers it for a completed single to-do", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        now={Date.now()}
        initialItems={[
          makeItem({
            id: "dn-plain",
            text: "finished plain",
            status: "triaged",
            completedAt: new Date(),
          }),
        ]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );
    const row = screen.getByText("finished plain").closest("li")!;
    await openMoveMenu(row, user);
    expect(
      await screen.findByRole("menuitem", { name: /Single-task/ }),
    ).toBeInTheDocument();
  });
});
