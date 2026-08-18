// @vitest-environment jsdom
/**
 * #225 — the nineteen inbox row writes that failed silently.
 *
 * Its own file rather than more of `inbox-view.test.tsx` (4300 lines already),
 * following the split `inbox-view.drag.test.tsx` and `inbox-view.hydration.test.tsx`
 * established. The mock block is duplicated because a Vitest `vi.mock` factory is
 * per-file; that is the cost of the split and it is the same cost those two pay.
 *
 * Several of these specs exist because !294 paid for them over six review rounds
 * on the identical defect on the shopping list. They are named for the lesson
 * rather than for the mechanism, so a future refactor that reintroduces the
 * mechanism fails on a sentence that says what went wrong.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  act,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InboxView } from "@/components/inbox/inbox-view";
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

vi.mock("@/app/actions/ics-schedule", () => ({
  scheduleViaIcs: vi
    .fn()
    .mockResolvedValue({ ok: true, ics: "", icsFilename: "x.ics" }),
}));
vi.mock("@/lib/download-ics", () => ({ downloadIcs: vi.fn() }));

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

import {
  completeItem,
  deleteBrainDumpItem,
  ensureFocusStep,
  keepAsTask,
  renameItem,
  snoozeBrainDumpItem,
} from "@/app/actions/braindump";
import { startBreakdown } from "@/app/actions/breakdown";
import { INBOX_ACTION_TIMEOUT_MS } from "@/components/inbox/inbox-view";

const settings: AgingSettings = {
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

/** What Next 16's client throws when the action id came from another build. */
function staleActionError() {
  return Object.assign(
    new Error(
      'Server Action "40bef5efc6c80527f80d35d95a902c7e0bc4056eb0" was not found on the server.',
    ),
    { name: "UnrecognizedActionError" },
  );
}

function renderInbox(initialItems: Item[]) {
  const view = render(
    <InboxView
      workspaceId="ws-test"
      now={Date.now()}
      initialItems={initialItems}
      settings={settings}
      welcomeVisible={false}
      resumeStep={null}
    />,
  );
  return view;
}

/**
 * `fireEvent` and a fixed microtask budget rather than `userEvent`, matching the
 * #210 specs in `inbox-view.test.tsx`: two of these drive fake timers, and
 * userEvent's own timer plumbing has to be wired to them separately.
 */
async function flushTicks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Press a control by accessible name and let the write settle. */
async function press(name: RegExp) {
  await act(async () => {
    screen.getByRole("button", { name }).click();
    await flushTicks();
  });
}

/**
 * Open a row's ✎ editor and submit `next` through it.
 *
 * `rowText` is the title the ROW still shows, which is not necessarily the last
 * thing submitted: the list only changes when `router.refresh()` brings new
 * `initialItems`, and a write still in flight has not refreshed anything. That
 * gap is the whole setting for the mid-flight specs below.
 */
async function editTitle(rowText: string, next: string) {
  await act(async () => {
    // An exact STRING match rather than a built regex. Testing Library treats a
    // string `name` as the whole accessible name, which is exactly what the
    // pencil's `aria-label={`Edit ${item.text}`}` gives — so the regex bought
    // nothing, and building one from an interpolated value is what SAST flags as
    // a non-literal `RegExp` (CWE-1333). It was the one live scanner finding on
    // this branch; removing the construct is better than triaging it, since a
    // dismissal has to be re-argued every time the fingerprint moves.
    screen.getByRole("button", { name: `Edit ${rowText}` }).click();
    await flushTicks();
  });
  const editor = screen.getByRole("textbox", { name: /^edit title$/i });
  fireEvent.change(editor, { target: { value: next } });
  await act(async () => {
    fireEvent.keyDown(editor, { key: "Enter" });
    await flushTicks();
  });
}

const COMPLETE = /complete/i;
const RETRY = /try again/i;
const DELETE = /^delete$/i;
/**
 * #253 relabelled two of the controls these specs press, and both are now only
 * reachable from a row's ▾ list. Exact strings rather than regexes, matching the
 * ▾-entry convention in `inbox-view.test.tsx`: `t()` returns the whole accessible
 * name, so a substring pattern would also match a longer future sibling.
 *
 * `Add as single-task to-do` (`action.addTodoFull`) replaces the inline short
 * "Add to-do" (`action.addTodo`) the row used to carry — and #253 renamed it again,
 * to name the bucket the row lands in (`section.singleTask`) rather than to describe
 * the gesture.
 *
 * `SAVE_FOR_LATER` is the row's other bucket MOVE, and it replaced a `MOVE_TO`
 * constant naming the nested "Move to…" picker. That picker is gone: the ▾ names its
 * destinations directly, so a submenu offering the same four buckets was a second
 * route one tap deeper. What the specs below need from it is a move dispatched
 * through `moveItemToBucket` — the only entries that reach `movedAnnouncement` — and
 * on a Needs-review row this is one. `Mark as completed` beside it is NOT: it calls
 * `completeItem` directly and announces nothing.
 */
const ADD_TODO = "Add as single-task to-do";
const SAVE_FOR_LATER = "Save for later";

/**
 * #255 — two-row fixtures whose ORDER is decided here rather than by the clock.
 *
 * Needs-review sorts newest-first on a millisecond `createdAt` (`bucket.ts`'s
 * `freshnessKey`), and `makeItem()`'s default is `new Date()`. Two rows built one
 * line apart therefore either TIE — `Array.prototype.sort` is stable, so they
 * render in the order written — or straddle a millisecond tick and render
 * REVERSED. Which of the two happened was decided by how loaded the machine was,
 * so a spec that named a row by its position in `getAllByRole(...)` was reading
 * the OTHER row about one full run in five.
 *
 * These two stamps pin it, and pin it to the arrangement that used to break: the
 * row written SECOND is the newer of the pair, so it renders FIRST. The specs
 * below therefore always run what used to be the rare interleaving.
 */
const RENDERS_SECOND = new Date(Date.now() - 2_000);
const RENDERS_FIRST = new Date(Date.now() - 1_000);

/**
 * The `<li>` that holds `itemText` — the one lookup #255 and #253 must agree on.
 *
 * ⚠️ This exists so the two fixes below cannot drift apart, and both of them are
 * load-bearing:
 *   • #255 — a row must be named by its ITEM, never by where it landed in the
 *     list. Needs-review sorts newest-first on a millisecond `createdAt`, so a
 *     positional `getAllByRole(...)[n]` read the other row about one run in five.
 *   • #253 — a row's Delete / Move to… / Add-as-single-task entries are behind
 *     the ▾ now, so reaching one means opening THAT row's ▾ first
 *     ({@link openRowMenu}).
 * A site that needs both — the right row, and its menu open — composes them
 * through this function. Reintroducing a positional lookup for either reason
 * breaks the other, which is why the row lookup is one function and not two.
 *
 * The ✎ pencil is the anchor because its `aria-label={`Edit ${item.text}`}` is the
 * one per-row unique accessible name in the markup, which is why {@link editTitle}
 * above already leans on it. It sits on the row's TITLE line, not in the ▾ list, so
 * it stays reachable with the menu shut — #253 moved other controls into the popup
 * but deliberately not this one, and that is what keeps this anchor usable.
 *
 * #253 also deleted the ▾ list's own "Edit task title" entry (`editMenuItem`),
 * which fired the identical `setEditingId`. That STRENGTHENS this anchor rather
 * than threatening it: `Edit ${itemText}` was two controls per row with the menu
 * open and is now exactly one, whichever state the popup is in.
 *
 * Re-queried on every call rather than held: the notice mounting and unmounting
 * above the board re-renders the rows, and a stale node would fail an assertion
 * for a reason that is not the one under test.
 */
function rowFor(itemText: string): HTMLElement {
  const row = screen
    .getByRole("button", { name: `Edit ${itemText}` })
    .closest("li");
  if (!(row instanceof HTMLElement))
    throw new Error(`no row markup around "${itemText}"`);
  return row;
}

/**
 * A row's ✓ Complete control, reached through the row that holds the item rather
 * than by where that row landed in the list (#255).
 *
 * Every ✓ Complete in the board shares one accessible name, so the row is the only
 * thing that tells two of them apart.
 */
function completeOnRow(itemText: string): HTMLElement {
  return within(rowFor(itemText)).getByRole("button", { name: COMPLETE });
}

/**
 * Open a row's ▾ list, so a #253 menu entry is reachable.
 *
 * Same contract as `openRowMenu` in `inbox-view.test.tsx` — the trigger is found
 * by the accessible name "All options", scoped to the row — but driven with this
 * file's `act` + `.click()` + {@link flushTicks} idiom rather than `userEvent`,
 * for the reason {@link flushTicks} already records: two specs here run on fake
 * timers, and userEvent deadlocks under them unless its own timer plumbing is
 * wired up separately. Per-file local helpers are the convention for this one
 * anyway — `inbox-view.drag.test.tsx` declares its own too.
 *
 * The popup is portaled into the trigger's own wrapper rather than to `<body>`
 * (`container={menuRef}` in row-actions.tsx), so its entries stay inside the row
 * and {@link menuEntryOnRow} can keep scoping to it.
 */
async function openRowMenu(itemText: string) {
  await act(async () => {
    within(rowFor(itemText))
      .getByRole("button", { name: "All options" })
      .click();
    await flushTicks();
  });
}

/**
 * A control inside a row's ▾ list, with the list already open (#253).
 *
 * Scoped to the row rather than to the popup: the armed Delete confirm replaces
 * the entry that opened it and both halves live in the same popup, but a caller
 * asserting on the row's other controls in the same breath wants one scope, not
 * two — and the popup is inside the row either way.
 */
function menuEntryOnRow(itemText: string, name: RegExp | string): HTMLElement {
  return within(rowFor(itemText)).getByRole("button", { name });
}

/**
 * Press a #253 ▾ entry on a named row: open the list, then press the entry.
 *
 * The row-scoping half is {@link rowFor}'s (#255) and the menu-opening half is
 * {@link openRowMenu}'s (#253) — see rowFor's note on why they are composed
 * rather than reimplemented per site.
 */
async function pressInRowMenu(itemText: string, name: RegExp | string) {
  await openRowMenu(itemText);
  await act(async () => {
    menuEntryOnRow(itemText, name).click();
    await flushTicks();
  });
}

/**
 * Delete a row through the ▾ list's two-step confirm.
 *
 * #253 moved the resting Delete into the list. The armed `Delete · Cancel` pair
 * REPLACES that entry in place rather than opening anything new — one
 * `confirmDeleteId`, `deleteControl` in inbox-view.tsx — so the popup stays open
 * across both presses and only one control is named "Delete" at a time. That is
 * why the second press is a re-query and not a held node, and why it needs no
 * second {@link openRowMenu}.
 */
async function confirmDeleteOnRow(itemText: string) {
  await pressInRowMenu(itemText, DELETE);
  await act(async () => {
    menuEntryOnRow(itemText, DELETE).click(); // the armed confirm
    await flushTicks();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(completeItem).mockReset();
  vi.mocked(completeItem).mockResolvedValue(undefined);
  vi.mocked(deleteBrainDumpItem).mockReset();
  vi.mocked(deleteBrainDumpItem).mockResolvedValue(undefined);
  vi.mocked(keepAsTask).mockReset();
  vi.mocked(keepAsTask).mockResolvedValue(undefined);
  vi.mocked(renameItem).mockReset();
  vi.mocked(renameItem).mockResolvedValue(undefined);
  vi.mocked(ensureFocusStep).mockReset();
  vi.mocked(ensureFocusStep).mockResolvedValue(null);
  vi.mocked(startBreakdown).mockReset();
  vi.mocked(startBreakdown).mockResolvedValue(null);
  push.mockReset();
  refresh.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("InboxView — a row write that does not land (#225)", () => {
  it("says so, and names the item, when the write rejects", async () => {
    vi.mocked(completeItem).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem({ text: "water the plants" })]);

    await press(COMPLETE);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn't save that/i);
    expect(alert).toHaveTextContent(/water the plants/);
  });

  it("does not refresh the list when the write failed — there is nothing new to fetch", async () => {
    vi.mocked(completeItem).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem()]);

    await press(COMPLETE);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("offers Retry, and Retry re-posts the same write", async () => {
    vi.mocked(completeItem).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem()]);
    await press(COMPLETE);

    await press(RETRY);

    expect(vi.mocked(completeItem).mock.calls).toEqual([
      ["item-1"],
      ["item-1"],
    ]);
  });

  it("a successful Retry clears the notice and refreshes", async () => {
    vi.mocked(completeItem).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem()]);
    await press(COMPLETE);

    await press(RETRY);

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(refresh).toHaveBeenCalled();
  });

  /**
   * !294's round-6 finding, which is the expensive one. The shopping list keyed
   * "this write has now succeeded" on the held closure's IDENTITY, and every
   * ordinary control builds a fresh closure on every render — so only the
   * notice's own Retry could ever match. Pressing the row's own button again
   * left the stale banner up beside the write that had just landed, and its
   * Retry then re-posted the OLD call with the OLD arguments.
   */
  it("a fresh press of the row's own control clears the notice — identity is the target, not the closure", async () => {
    vi.mocked(completeItem).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem()]);
    await press(COMPLETE);
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    // NOT the notice's Retry: the row's own button, which is a different closure.
    await press(COMPLETE);

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("a write to a DIFFERENT row does not answer this row's failure", async () => {
    vi.mocked(completeItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    renderInbox([
      makeItem({ id: "a", text: "alpha", createdAt: RENDERS_SECOND }),
      makeItem({ id: "b", text: "bravo", createdAt: RENDERS_FIRST }),
    ]);

    await act(async () => {
      completeOnRow("alpha").click();
      await flushTicks();
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/alpha/);

    await act(async () => {
      completeOnRow("bravo").click();
      await flushTicks();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/alpha/);
  });

  it("a stale bundle offers a reload, never a retry that cannot work", async () => {
    vi.mocked(completeItem).mockRejectedValueOnce(staleActionError());
    renderInbox([makeItem()]);

    await press(COMPLETE);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /the app updated while this was open/i,
    );
    expect(
      screen.getByRole("button", { name: /reload the page/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
  });

  it("a write that never answers says the outcome is unknown rather than claiming failure", async () => {
    vi.useFakeTimers();
    vi.mocked(completeItem).mockReturnValueOnce(new Promise<void>(() => {}));
    renderInbox([makeItem()]);

    await act(async () => {
      screen.getByRole("button", { name: COMPLETE }).click();
      await flushTicks();
    });
    await act(async () => {
      vi.advanceTimersByTime(INBOX_ACTION_TIMEOUT_MS);
      await flushTicks();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      /no answer from the server/i,
    );
    // The instruction half, asserted here so the precedence below cannot be
    // widened by accident: while the row is STILL on the list, sending the user
    // to look at it is exactly right, and a Retry is offered to act on what they
    // find. That pairing is what the vanished-row spec deliberately breaks.
    expect(screen.getByRole("alert")).toHaveTextContent(
      /check your inbox before trying again/i,
    );
    expect(screen.getByRole("button", { name: RETRY })).toBeInTheDocument();
  });

  /**
   * The failure names a row the rendered list no longer holds. `initialItems`
   * comes from the dynamic page, so its losing the row IS the server saying the
   * row has gone — and a Retry that can only ever be refused again is worse than
   * no button at all.
   */
  it("withdraws Retry when the failed row is no longer in the list", async () => {
    vi.mocked(deleteBrainDumpItem).mockRejectedValueOnce(new Error("offline"));
    const { rerender } = renderInbox([makeItem({ text: "water the plants" })]);

    await confirmDeleteOnRow("water the plants");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // The user is standing on the Retry that is about to be taken away.
    screen.getByRole("button", { name: RETRY }).focus();

    rerender(
      <InboxView
        workspaceId="ws-test"
        now={Date.now()}
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      /not in your inbox any more/i,
    );
    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
    // …and does not leave the user on <body> when it does. Withdrawing the
    // control the user was standing on is a context change like any other
    // unmount (WCAG 2.4.3), so the message itself takes the hand-off.
    await waitFor(() =>
      expect(screen.getByRole("alert")).toContainElement(
        document.activeElement as HTMLElement,
      ),
    );
  });

  /**
   * !306, Duo review — the two halves of the notice disagreed about the same
   * pair of facts.
   *
   * `writeFailureKey` puts `timedOut` above `rowGone`, which is right: a timeout
   * cannot support "nothing changed", because the row may be absent BECAUSE the
   * write it is unsure about landed. `writeFailureRemedy` puts `rowGone` first,
   * which is also right: `initialItems` excludes only archived rows, so a row
   * missing from it is deleted or archived server-side and every one of these
   * `findFirst`-then-write actions matches nothing, for good.
   *
   * Both are right and together they were incoherent — "check your inbox before
   * trying again" printed above no button to try again with. The copy is the half
   * that had to move, because the button is the half that cannot: retrying a row
   * that is gone either re-posts a write that already landed or matches nothing,
   * and both settle as a silent success that clears the notice — a false "saved
   * this time" is worse than the dead end it replaces.
   *
   * So the copy stops sending the user to check a list the page has already
   * checked for them, keeps the timeout's honesty about an unknown verdict, and
   * accounts for the withdrawn Retry the way `inbox.errorSaveGone` does.
   */
  it("a timed-out write on a row that has since gone does not tell the user to try again — there is nothing left to press", async () => {
    vi.useFakeTimers();
    vi.mocked(deleteBrainDumpItem).mockReturnValueOnce(
      new Promise<void>(() => {}),
    );
    const { rerender } = renderInbox([makeItem({ text: "water the plants" })]);

    await confirmDeleteOnRow("water the plants");
    await act(async () => {
      vi.advanceTimersByTime(INBOX_ACTION_TIMEOUT_MS);
      await flushTicks();
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      /check your inbox before trying again/i,
    );

    // The refresh that took the row off the list is not this write's — the
    // failure path never refreshes — so it is the page observing, independently,
    // that the row is no longer there.
    await act(async () => {
      rerender(
        <InboxView
          workspaceId="ws-test"
          now={Date.now()}
          initialItems={[]}
          settings={settings}
          welcomeVisible={false}
          resumeStep={null}
        />,
      );
      await flushTicks();
    });

    const alert = screen.getByRole("alert");
    // Still says what it does not know: the write may well have landed, and this
    // is the one message that must never harden into "nothing changed".
    expect(alert).toHaveTextContent(/no answer from the server/i);
    expect(alert).not.toHaveTextContent(/nothing changed/i);
    // …and stops promising a control it withdraws in the same breath.
    expect(alert).not.toHaveTextContent(/trying again/i);
    expect(alert).toHaveTextContent(/not in your inbox any more/i);
    expect(alert).toHaveTextContent(/water the plants/);
    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /reload the page/i }),
    ).toBeNull();
  });
});

describe("InboxView — the double-press guard (#225)", () => {
  /**
   * The harm this exists for is specific: a failed write is indistinguishable
   * from a press that did not register, so the natural response is to press
   * again. `keepAsTask` is the one where that costs data — it CREATES a Task and
   * then points the item at it, so two in flight leave an orphaned Task row that
   * nothing can reach.
   */
  it("absorbs a second press at the same target while the first is still in flight", async () => {
    let settle!: () => void;
    vi.mocked(keepAsTask).mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        settle = () => resolve(undefined);
      }),
    );
    renderInbox([makeItem()]);

    // #253 — both presses land on the ▾ entry, which is where the only Add-as-
    // single-task control lives now. The list stays open across them (the entry
    // is a plain button in a Popover, not a menuitem that dismisses), so the
    // second press reaches the same control the user's would.
    await pressInRowMenu("sample item", ADD_TODO);
    await act(async () => {
      menuEntryOnRow("sample item", ADD_TODO).click();
      await flushTicks();
    });

    expect(vi.mocked(keepAsTask)).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle();
      await flushTicks();
    });
  });

  it("does not block a press on a different row", async () => {
    let settle!: () => void;
    vi.mocked(completeItem)
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      )
      .mockResolvedValue(undefined);
    // Distinct titles, because the row is what tells the two ✓ Complete controls
    // apart and two rows reading "sample item" cannot be told apart at all —
    // which is how this spec came to identify them by list position (#255).
    renderInbox([
      makeItem({ id: "a", text: "alpha", createdAt: RENDERS_SECOND }),
      makeItem({ id: "b", text: "bravo", createdAt: RENDERS_FIRST }),
    ]);

    await act(async () => {
      completeOnRow("alpha").click();
      await flushTicks();
    });
    await act(async () => {
      completeOnRow("bravo").click();
      await flushTicks();
    });

    expect(vi.mocked(completeItem).mock.calls).toEqual([["a"], ["b"]]);
    await act(async () => {
      settle();
      await flushTicks();
    });
  });

  it("the notice's Retry cannot be double-fired either", async () => {
    let settle!: () => void;
    vi.mocked(completeItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      );
    renderInbox([makeItem()]);
    await press(COMPLETE);

    await act(async () => {
      screen.getByRole("button", { name: RETRY }).click();
      await flushTicks();
    });
    await act(async () => {
      screen.getByRole("button", { name: RETRY }).click();
      await flushTicks();
    });

    expect(vi.mocked(completeItem)).toHaveBeenCalledTimes(2);
    await act(async () => {
      settle();
      await flushTicks();
    });
  });
});

/**
 * Every live region in a tree that has another live region as an ancestor.
 *
 * A polite live region nested inside an assertive one is not reliably handled:
 * the outer region's `aria-live` applies to the whole subtree, so whether the
 * inner text is announced politely, assertively, twice, or not at all is
 * implementation-dependent. The failure has no visual symptom, which is how it
 * reached `main` in the first place and why `!290` had to catch itself copying
 * the shape.
 *
 * Here as a constraint on the NEW notice this MR adds, not as a fix to anything:
 * a second notice modelled on the first is exactly how the shape spreads. A
 * detector rather than a handful of `querySelector` assertions, so it covers
 * whatever the inbox renders — including the note field, the schedule menu and
 * the step list, which are other components mounted inside these rows — instead
 * of only the nodes somebody remembered to look at.
 */
const LIVE_REGION =
  '[role="status"],[role="alert"],[role="log"],[aria-live]:not([aria-live="off"])';

function nestedLiveRegions(root: ParentNode): Element[] {
  return [...root.querySelectorAll(LIVE_REGION)].filter(
    (el) => el.parentElement?.closest(LIVE_REGION) != null,
  );
}

describe("nestedLiveRegions (the detector itself)", () => {
  /**
   * Built with DOM calls rather than `innerHTML`: the string form is a
   * hard-coded literal and could not carry untrusted input, but it trips the
   * scanners' XSS rule anyway, and a finding that has to be dismissed every
   * pipeline is a worse trade than four extra lines.
   */
  function node(
    tag: string,
    attrs: Record<string, string>,
    text?: string,
  ): HTMLElement {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text !== undefined) el.textContent = text;
    return el;
  }

  /**
   * A guard reporting zero is only worth something if the same query returns
   * non-zero somewhere. Two shapes, because the attribute form and the role form
   * are the two ways the repo writes a live region.
   */
  it("finds a polite region nested inside an assertive one", () => {
    const root = document.createElement("div");
    const outer = node("div", { role: "alert" });
    outer.append(
      node("p", {}, "reason"),
      node("p", { role: "status" }, "trying again"),
    );
    root.append(outer);

    expect(nestedLiveRegions(root).map((el) => el.textContent)).toEqual([
      "trying again",
    ]);
  });

  it("finds the aria-live spelling too, and passes genuine siblings", () => {
    const root = document.createElement("div");
    const outer = node("div", { "aria-live": "assertive" });
    outer.append(node("span", { "aria-live": "polite" }, "inner"));
    root.append(outer, node("div", { role: "status" }, "sibling"));

    expect(nestedLiveRegions(root).map((el) => el.textContent)).toEqual([
      "inner",
    ]);
  });
});

describe("InboxView — the write notice's accessibility (#225)", () => {
  /**
   * `!290` established the correct pattern for the capture notice and this MR
   * adds a second notice beside it, so the risk worth guarding is the shape
   * spreading rather than any existing instance. Asserted over the whole
   * rendered tree, in the state that has the most live regions mounted at once.
   */
  it("mounts no live region inside another, anywhere in the inbox", async () => {
    vi.mocked(completeItem).mockRejectedValueOnce(new Error("offline"));
    const { container } = renderInbox([
      makeItem({ id: "a", text: "water the plants" }),
      makeItem({
        id: "b",
        text: "plan trip",
        status: "triaged",
        taskId: "t1",
        stepsTotal: 2,
        stepsDone: 1,
      }),
      makeItem({ id: "c", text: "old thing", completedAt: new Date() }),
    ]);

    // The two notices, the "captured ✓" confirmation and the drag/move
    // announcement region can all be on screen at once; put the write notice up
    // and check the whole document, since the notice is rendered in place rather
    // than portalled.
    await act(async () => {
      completeOnRow("water the plants").click();
      await flushTicks();
    });
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    // Assert the tree HAS live regions before asserting none of them nest —
    // otherwise a render that mounted none at all would report the same clean
    // zero as a render that got it right.
    expect(
      container.querySelectorAll(LIVE_REGION).length,
    ).toBeGreaterThanOrEqual(2);
    expect(nestedLiveRegions(container).map((el) => el.outerHTML)).toEqual([]);
  });

  /**
   * Renamed at !306's Duo review, because the old name ("rather than nesting a
   * live region") described the whole answer and is now only half of it. Not
   * nesting is still the rule the spec below pins; the wait now ALSO has a real
   * region beside the notice, which the next spec covers. Kept as its own case so
   * the description channel cannot quietly disappear: it is the one that serves a
   * notice mounting with a retry already in flight.
   */
  it("keeps the reason and the wait both reachable from the button, without nesting a live region", async () => {
    let settle!: () => void;
    vi.mocked(completeItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      );
    renderInbox([makeItem()]);
    await press(COMPLETE);

    const notice = screen.getByRole("alert");
    await act(async () => {
      screen.getByRole("button", { name: RETRY }).click();
      await flushTicks();
    });

    expect(notice.querySelector('[role="status"]')).toBeNull();
    const retry = screen.getByRole("button", { name: RETRY });
    const described = (retry.getAttribute("aria-describedby") ?? "").split(" ");
    const waitText = described
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(waitText).toMatch(/saving/i);

    await act(async () => {
      settle();
      await flushTicks();
    });
  });

  /**
   * !306, Duo review — this notice shipped round 8's shape, and `!303` had
   * already found that shape to be half a fix (#218, its own round 16). Not
   * nesting the polite region inside the `role="alert"` was right. Leaving
   * `aria-describedby` to carry the wait ALONE was not: a description is computed
   * when focus LANDS on a control, and Retry is pressed on a control that already
   * holds focus and keeps it by design (`aria-disabled`, not `disabled`). The
   * description gaining `writeSavingId` mid-flight is a change nothing goes back
   * to re-read, so the hole was moved onto the button rather than closed.
   *
   * A live region is the one channel defined for content that changes while the
   * user is stationary. Same shape as `focus-timer.tsx` and the capture notice
   * above, deliberately: polite, `sr-only`, a SIBLING of the alert rather than a
   * descendant, mounted with the notice and EMPTY until there is something to say
   * — a region that arrives together with its first message is silent, which the
   * move announcer at the foot of `inbox-view.tsx` already documents.
   *
   * NOT verified against a screen reader. This asserts the DOM contract only.
   */
  it("announces the wait through a polite live region beside the notice, not by changing a description under held focus", async () => {
    let settle!: () => void;
    vi.mocked(completeItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      );
    renderInbox([makeItem()]);
    await press(COMPLETE);

    // Present and empty BEFORE the press — that ordering is the whole point of
    // rendering it with the notice rather than with the message.
    const announcer = screen.getByTestId("write-saving-announcer");
    expect(announcer).toBeEmptyDOMElement();
    expect(screen.getByRole("alert")).not.toContainElement(announcer);

    await act(async () => {
      screen.getByRole("button", { name: RETRY }).click();
      await flushTicks();
    });

    expect(announcer).toHaveTextContent(/saving/i);
    expect(announcer).toHaveAttribute("role", "status");
    expect(announcer).toHaveAttribute("aria-live", "polite");
    expect(announcer).toHaveClass("sr-only");
    expect(screen.getByRole("alert")).not.toContainElement(announcer);

    // Exactly one node carries the sentence to the accessibility tree: the
    // visible line stays where it was, on screen, and is hidden from AT.
    const visible = screen.getByTestId("write-saving-visible");
    expect(screen.getByRole("alert")).toContainElement(visible);
    expect(visible).toHaveAttribute("aria-hidden", "true");
    expect(visible).not.toHaveClass("sr-only");

    await act(async () => {
      settle();
      await flushTicks();
    });
  });

  it("keeps Retry in the tab order while it is busy (aria-disabled, not disabled)", async () => {
    let settle!: () => void;
    vi.mocked(completeItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      );
    renderInbox([makeItem()]);
    await press(COMPLETE);

    await act(async () => {
      screen.getByRole("button", { name: RETRY }).click();
      await flushTicks();
    });

    const retry = screen.getByRole("button", { name: RETRY });
    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(retry).not.toBeDisabled();

    await act(async () => {
      settle();
      await flushTicks();
    });
  });

  /**
   * The notice is one slot at the top of a list that scrolls, so a sighted user
   * standing on a row far down would otherwise never see it. Moving focus is what
   * puts the message AND the focused control on screen together — the browser
   * scrolls a focused element into view, and leaving focus on an off-screen
   * control would fail WCAG 2.4.7 as well as hiding the error.
   */
  it("moves focus to the notice so the message and the focus ring are on screen together", async () => {
    vi.mocked(completeItem).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem()]);

    const trigger = screen.getByRole("button", { name: COMPLETE });
    trigger.focus();
    await act(async () => {
      trigger.click();
      await flushTicks();
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: RETRY })).toHaveFocus(),
    );
  });

  it("hands focus back to the control that started the write once it lands", async () => {
    vi.mocked(completeItem).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem()]);

    const trigger = screen.getByRole("button", { name: COMPLETE });
    trigger.focus();
    await act(async () => {
      trigger.click();
      await flushTicks();
    });
    await press(RETRY);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: COMPLETE })).toHaveFocus(),
    );
  });

  /**
   * !306, Duo review — the hand-off used to be armed by ANY write that landed
   * while the notice's control held focus, including one about a different row.
   * Twenty independent row controls means two writes overlap routinely, and the
   * one that lands second is not necessarily the one the notice is about: the ref
   * ended up holding the other row's button, and spent it on whatever finally did
   * clear the notice.
   */
  it("a write that lands at another row does not become this notice's hand-off target", async () => {
    let settleBravo!: () => void;
    let alphaAttempts = 0;
    vi.mocked(completeItem).mockImplementation((id: string) => {
      if (id === "b")
        return new Promise<void>((resolve) => {
          settleBravo = resolve;
        });
      alphaAttempts += 1;
      return alphaAttempts === 1
        ? Promise.reject(new Error("offline"))
        : Promise.resolve();
    });
    renderInbox([
      makeItem({ id: "a", text: "alpha", createdAt: RENDERS_SECOND }),
      makeItem({ id: "b", text: "bravo", createdAt: RENDERS_FIRST }),
    ]);

    // Bravo's write is still in flight when alpha's fails, so the notice on
    // screen is alpha's while bravo's success is still to come. Which row the
    // press lands on is named by the ITEM, never by a list position — #255, where
    // the list rendering in the other order pressed these two the other way
    // round and left the spec asserting the reverse of what it says.
    completeOnRow("bravo").focus();
    await act(async () => {
      completeOnRow("bravo").click();
      await flushTicks();
    });
    completeOnRow("alpha").focus();
    await act(async () => {
      completeOnRow("alpha").click();
      await flushTicks();
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: RETRY })).toHaveFocus(),
    );

    await act(async () => {
      settleBravo();
      await flushTicks();
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/alpha/);

    // Bravo landing stranded nobody — the notice is still up and the user is
    // still standing on its Retry — so no hand-off may be pending. They give up
    // on it, go back to the capture field, and clear the notice from alpha's own
    // control. Nothing in that sequence sends focus anywhere, so nothing may move
    // it. (jsdom's `click()` leaves focus where it is, which is also what the
    // WebKit press two specs down does.)
    const capture = screen.getByPlaceholderText(/Brain dump/i);
    capture.focus();
    await act(async () => {
      completeOnRow("alpha").click();
      await flushTicks();
    });

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(capture).toHaveFocus();
    expect(completeOnRow("bravo")).not.toHaveFocus();
  });

  /**
   * A control can be activated without being focused — assistive technology does
   * it through the accessibility API, and `HTMLElement.click()` is that same
   * gesture. So the write that clears the notice is not always the one the notice
   * was raised from, and the hand-off belongs to the notice: it exists to undo the
   * pull the notice performed, which was away from the row's own control and not
   * away from whatever happened to clear it.
   */
  it("returns focus to the control the notice was raised from, not to whatever cleared it", async () => {
    vi.mocked(completeItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    renderInbox([makeItem()]);

    const trigger = screen.getByRole("button", { name: COMPLETE });
    trigger.focus();
    await act(async () => {
      trigger.click();
      await flushTicks();
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: RETRY })).toHaveFocus(),
    );

    // Focus stays on the Retry across this press, so the write that clears the
    // notice was started from a control that is itself about to be unmounted.
    await act(async () => {
      screen.getByRole("button", { name: COMPLETE }).click();
      await flushTicks();
    });

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("button", { name: COMPLETE })).toHaveFocus();
  });

  /**
   * The same defect from the other side. Here the hand-off is armed for the right
   * notice, and then a second failure takes that notice's PLACE before it can
   * unmount: React re-uses the control the user is standing on rather than
   * removing it, so nothing is stranded and there is nothing to hand back — but
   * the ref was still armed, and the next notice to clear spent it.
   */
  it("a notice that replaces another voids the hand-off armed for the first", async () => {
    let rejectBravo!: (reason: unknown) => void;
    let settleAlphaRetry!: () => void;
    let alphaAttempts = 0;
    let bravoAttempts = 0;
    vi.mocked(completeItem).mockImplementation((id: string) => {
      if (id === "b") {
        bravoAttempts += 1;
        return bravoAttempts === 1
          ? new Promise<void>((_, reject) => {
              rejectBravo = reject;
            })
          : Promise.resolve();
      }
      alphaAttempts += 1;
      return alphaAttempts === 1
        ? Promise.reject(new Error("offline"))
        : new Promise<void>((resolve) => {
            settleAlphaRetry = resolve;
          });
    });
    renderInbox([
      makeItem({ id: "a", text: "alpha", createdAt: RENDERS_SECOND }),
      makeItem({ id: "b", text: "bravo", createdAt: RENDERS_FIRST }),
    ]);

    completeOnRow("bravo").focus();
    await act(async () => {
      completeOnRow("bravo").click();
      await flushTicks();
    });
    completeOnRow("alpha").focus();
    await act(async () => {
      completeOnRow("alpha").click();
      await flushTicks();
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: RETRY })).toHaveFocus(),
    );
    await act(async () => {
      screen.getByRole("button", { name: RETRY }).click();
      await flushTicks();
    });

    // Alpha's retry lands and bravo's write fails in the same flush, so the
    // notice is replaced rather than removed and the Retry keeps focus.
    await act(async () => {
      settleAlphaRetry();
      rejectBravo(new Error("offline"));
      await flushTicks();
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/bravo/);

    // The user gives up on the notice and goes back to the capture field, then
    // clears bravo's notice from bravo's own control. Nothing here sends focus
    // anywhere, so nothing may move it.
    const capture = screen.getByPlaceholderText(/Brain dump/i);
    capture.focus();
    await act(async () => {
      completeOnRow("bravo").click();
      await flushTicks();
    });

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(capture).toHaveFocus();
  });

  /**
   * Not every browser focuses a `<button>` when it is clicked, so not every press
   * leaves an origin behind. Measured in Playwright's WebKit (Safari's engine):
   * click a `<button>` while a text field holds focus and `document.activeElement`
   * ends up on `<body>` — the mousedown blurs the field, and nothing takes its
   * place. Chromium reports the button for the same gesture. So on WebKit the
   * ordinary mouse press through this whole file has `origin === null`.
   *
   * The notice still takes focus there, through the arm that exists for a user
   * already stranded on `<body>` — so its unmount still takes focus away from
   * someone, and there is no pressed control to give it back to. The capture field
   * is the fallback, the same one a removed row gets, rather than `<body>`
   * (WCAG 2.4.3).
   */
  it("hands focus to the capture field when the press left no control to return to", async () => {
    vi.mocked(completeItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    renderInbox([makeItem()]);

    // The page loads with the capture field focused (`autoFocus`). jsdom's
    // `click()` models half of WebKit's press — it never focuses the button — so
    // the other half, the blur every engine performs on mousedown, is spelled out.
    screen.getByPlaceholderText(/Brain dump/i).blur();
    expect(document.activeElement).toBe(document.body);
    await press(COMPLETE);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: RETRY })).toHaveFocus(),
    );
    await press(RETRY);

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByPlaceholderText(/Brain dump/i)).toHaveFocus();
  });

  /**
   * The capture field is where the user is typing, and #210 argues at length that
   * the capture notice must not steal focus from it. A row write is the opposite
   * case — the press came from a button — but the guard has to hold when the two
   * overlap: if the user has moved focus since pressing, the notice does not take it.
   */
  it("does not steal focus from wherever the user moved it while the write was in flight", async () => {
    let reject!: (reason: unknown) => void;
    vi.mocked(completeItem).mockReturnValueOnce(
      new Promise<void>((_, r) => {
        reject = r;
      }),
    );
    renderInbox([makeItem()]);

    const trigger = screen.getByRole("button", { name: COMPLETE });
    trigger.focus();
    await act(async () => {
      trigger.click();
      await flushTicks();
    });

    const capture = screen.getByPlaceholderText(/Brain dump/i);
    capture.focus();
    await act(async () => {
      reject(new Error("offline"));
      await flushTicks();
    });

    expect(capture).toHaveFocus();
  });
});

describe("InboxView — a failed rename (#225)", () => {
  it("quotes the NEW words, which are the ones at stake", async () => {
    vi.mocked(renameItem).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem({ text: "old title" })]);

    await act(async () => {
      screen.getByRole("button", { name: /edit old title/i }).click();
      await flushTicks();
    });
    const editor = screen.getByDisplayValue("old title");
    fireEvent.change(editor, { target: { value: "new title" } });
    await act(async () => {
      fireEvent.keyDown(editor, { key: "Enter" });
      await flushTicks();
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/new title/);
  });

  /**
   * !306's Duo review, and the sharpest form of this issue's own bug: the
   * double-press guard was DROPPING a second, different edit while the editor
   * closed as though it had saved. A silent write failure wearing a success is
   * the exact class #225 exists to remove, and it does not become acceptable
   * for arriving from the new guard rather than from a missing one.
   *
   * `renameItem` is the one write on this board that carries words, so two
   * submissions against one row are two DIFFERENT requests — not the "you are
   * asking for something that is already happening" the guard is written for.
   */
  it("a second edit submitted while the first is still in flight is not dropped behind a closed editor", async () => {
    let settle!: () => void;
    vi.mocked(renameItem).mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        settle = () => resolve(undefined);
      }),
    );
    renderInbox([makeItem({ text: "old title" })]);

    await editTitle("old title", "first edit");
    await editTitle("old title", "second edit");

    // Applied, in submission order. Next serialises server actions through the
    // app router's action queue, so the words the user typed last are the words
    // the row is left holding.
    expect(vi.mocked(renameItem).mock.calls).toEqual([
      ["item-1", "first edit"],
      ["item-1", "second edit"],
    ]);
    // The other half of the assertion, and the reason the spec is named for a
    // closed editor: the editor is gone, so "applied" is the ONLY outcome that
    // is not silent. Had the write been refused instead, this is where the
    // refusal would have to be visible.
    expect(screen.queryByRole("textbox", { name: /^edit title$/i })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      settle();
      await flushTicks();
    });
  });

  /**
   * !306's Duo review, and the mirror of the guard that was already here: the
   * sequence number stopped a late SUCCESS clearing a fresher failure, but
   * nothing stopped a late FAILURE overwriting one.
   *
   * The spec above is what makes this reachable rather than theoretical —
   * `writeGuardKey` keys a rename on its words as well as its row, so two edits
   * of one row to DIFFERENT text are two in-flight writes at the same
   * `{ id, field: "text" }` target and can settle in either order. When the
   * older one settles last, the user is shown the wrong words and the wrong
   * reason, and Retry re-posts an edit they have already superseded.
   */
  it("an OLDER failure settling late does not replace the fresher notice on screen", async () => {
    let failFirst!: () => void;
    let failSecond!: () => void;
    vi.mocked(renameItem)
      .mockReturnValueOnce(
        new Promise<undefined>((_resolve, reject) => {
          failFirst = () => reject(new Error("offline"));
        }),
      )
      .mockReturnValueOnce(
        new Promise<undefined>((_resolve, reject) => {
          failSecond = () => reject(new Error("offline"));
        }),
      );
    renderInbox([makeItem({ text: "old title" })]);

    await editTitle("old title", "first edit");
    await editTitle("old title", "second edit");

    // The NEWER attempt fails first, so its words are what the notice is about.
    await act(async () => {
      failSecond();
      await flushTicks();
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/second edit/);

    // The older, slower one loses the race and settles into a notice that has
    // already moved on.
    await act(async () => {
      failFirst();
      await flushTicks();
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/second edit/);
    expect(alert).not.toHaveTextContent(/first edit/);
  });

  /**
   * The same defect with the two failures settling in ONE tick, which is what
   * going offline actually looks like: both requests give up together.
   *
   * Kept as its own spec because it is the one that says WHERE the guard has to
   * live. Testing the notice's own record inside `setWriteFailure` passes the
   * spec above and fails this one — `displayedFailure` is a mirror kept in an
   * effect, so when both failures land before React commits it still reads
   * `null` and the older attempt sails through. The claim has to be staked
   * synchronously, which is why it is `writeSettledAt` and not the record.
   */
  it("holds even when both failures settle before the notice has rendered", async () => {
    let failFirst!: () => void;
    let failSecond!: () => void;
    vi.mocked(renameItem)
      .mockReturnValueOnce(
        new Promise<undefined>((_resolve, reject) => {
          failFirst = () => reject(new Error("offline"));
        }),
      )
      .mockReturnValueOnce(
        new Promise<undefined>((_resolve, reject) => {
          failSecond = () => reject(new Error("offline"));
        }),
      );
    renderInbox([makeItem({ text: "old title" })]);

    await editTitle("old title", "first edit");
    await editTitle("old title", "second edit");

    await act(async () => {
      failSecond();
      failFirst();
      await flushTicks();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/second edit/);
  });

  /**
   * The other side of the same line, so the fix above cannot be read as "renames
   * are simply unguarded". Identical words really are the double-press the guard
   * is for, and re-submitting them while the first is in flight asks for
   * something that is already happening.
   */
  it("still absorbs a resubmission of the SAME words — that is a double-press", async () => {
    let settle!: () => void;
    vi.mocked(renameItem).mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        settle = () => resolve(undefined);
      }),
    );
    renderInbox([makeItem({ text: "old title" })]);

    await editTitle("old title", "same edit");
    await editTitle("old title", "same edit");

    expect(vi.mocked(renameItem).mock.calls).toEqual([["item-1", "same edit"]]);

    await act(async () => {
      settle();
      await flushTicks();
    });
  });

  /**
   * !306's Duo review. The retry flag was raised and dropped on a TARGET match
   * alone, and the comment beside it argued no sequence test was needed because
   * "a record for this target can only be showing `retrying` because THIS retry
   * raised it". `writeGuardKey` is what falsifies that: a rename is guarded on
   * its words too, so two retries of one row to DIFFERENT text are two writes in
   * flight at the same `{ id, field: "text" }` target, and the older one's
   * cleanup was putting the newer one's notice back to idle while its own write
   * was still running.
   *
   * The damage is this issue's own bug one step further on. A Retry that reads
   * idle invites a press, and that press is then absorbed by the double-press
   * guard — correctly, because the words really are still in flight — so the
   * user gets a silent no-op from a control that just told them it was free.
   */
  it("an older retry settling does not put a DIFFERENT retry's notice back to idle", async () => {
    let failFirstRetry!: () => void;
    let settleSecondRetry!: () => void;
    vi.mocked(renameItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(
        new Promise<undefined>((_resolve, reject) => {
          failFirstRetry = () => reject(new Error("offline"));
        }),
      )
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(
        new Promise<undefined>((resolve) => {
          settleSecondRetry = () => resolve(undefined);
        }),
      );
    renderInbox([makeItem({ text: "old title" })]);

    // A failed rename, retried — that retry is still in flight for the rest of
    // the spec and is the one whose cleanup runs last.
    await editTitle("old title", "first edit");
    await press(RETRY);

    // A second edit of the same row fails and takes the notice over, and it too
    // is retried. Two retries, one target, different words.
    await editTitle("old title", "second edit");
    expect(screen.getByRole("alert")).toHaveTextContent(/second edit/);
    await press(RETRY);
    expect(screen.getByRole("button", { name: RETRY })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    await act(async () => {
      failFirstRetry();
      await flushTicks();
    });

    // The notice on screen is still the second edit's, and its retry has not
    // finished, so the control has to keep saying so.
    const retry = screen.getByRole("button", { name: RETRY });
    expect(screen.getByRole("alert")).toHaveTextContent(/second edit/);
    expect(retry).toHaveAttribute("aria-disabled", "true");

    await act(async () => {
      settleSecondRetry();
      await flushTicks();
    });
  });
});

/**
 * #225 — the title's own claim, tested as a claim.
 *
 * "Every inbox row write says so when it does not land" is the promise, and two
 * separate things can break it: a write path that never reaches `run()` at all,
 * and a write that reaches it but leaves an EARLIER, contradicting sentence
 * standing in another live region. Both are the silent-failure class this issue
 * removes, so both belong beside the specs above rather than in a follow-up.
 */
describe("InboxView — every row write reaches the notice (#225)", () => {
  it("does not leave the move announcer claiming the item moved when the move failed", async () => {
    const user = userEvent.setup();
    vi.mocked(snoozeBrainDumpItem).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem({ id: "m1", text: "buy oat milk" })]);

    // #253 — one press, on an ordinary ▾ entry. This used to open the nested
    // "Move to…" picker and pick `Completed` from it; the picker is gone, so the move
    // is `Save for later` and the write it fails is `snoozeBrainDumpItem`
    // (`dropPlan(needsReview → savedLater)` → `snooze`).
    await openRowMenu("buy oat milk");
    const row = rowFor("buy oat milk");
    await user.click(within(row).getByRole("button", { name: SAVE_FOR_LATER }));

    // The write is the thing that decides, so the assertion waits for its
    // verdict rather than for a paint.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn't save that/i);

    // `movedAnnouncement` is documented as "a move that actually happened"
    // (drag-announce.ts) and the dispatcher's own comment says announcing the
    // INTENT "would tell a screen reader an item had moved when it had not".
    // Announced before the write, that is exactly what it does — and now that a
    // failure is assertive, a screen reader gets both sentences about one
    // gesture. The polite one must never have been the lie.
    expect(screen.getByTestId("move-announcer")).not.toHaveTextContent(
      /moved/i,
    );
  });

  it("still announces a move that did land", async () => {
    const user = userEvent.setup();
    renderInbox([makeItem({ id: "m2", text: "buy rye bread" })]);

    await openRowMenu("buy rye bread");
    const row = rowFor("buy rye bread");
    await user.click(within(row).getByRole("button", { name: SAVE_FOR_LATER }));

    await waitFor(() =>
      expect(screen.getByTestId("move-announcer")).toHaveTextContent(
        /moved .*buy rye bread.* to Saved for later/i,
      ),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when ▶ Start Focus cannot create the step it needs", async () => {
    vi.mocked(ensureFocusStep).mockRejectedValueOnce(new Error("offline"));
    renderInbox([
      makeItem({
        id: "f1",
        text: "book the dentist",
        status: "triaged",
        triagedAt: new Date(),
      }),
    ]);

    await press(/start focus/i);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn't save that/i);
    expect(alert).toHaveTextContent(/book the dentist/);
    // It creates a Task and a Step, so it must not navigate off a write that
    // never happened.
    expect(push).not.toHaveBeenCalled();
  });

  it("says so when Break into steps cannot create the task it needs", async () => {
    vi.mocked(startBreakdown).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem({ id: "b1", text: "plan the loft" })]);

    await press(/break into steps/i);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn't save that/i);
    expect(alert).toHaveTextContent(/plan the loft/);
    expect(push).not.toHaveBeenCalled();
  });

  it("absorbs a second press of ▶ Start Focus rather than creating a second task", async () => {
    let settle = () => {};
    vi.mocked(ensureFocusStep).mockImplementation(
      () =>
        new Promise<string | null>(
          (resolve) => (settle = () => resolve("step-1")),
        ),
    );
    renderInbox([
      makeItem({
        id: "f2",
        text: "book the optician",
        status: "triaged",
        triagedAt: new Date(),
      }),
    ]);

    await press(/start focus/i);
    await press(/start focus/i);

    // `ensureFocusStep` creates a Task when the item has none, which is the
    // duplicate-row class `keepAsTask` was guarded against in this same MR.
    expect(vi.mocked(ensureFocusStep)).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle();
      await flushTicks();
    });
  });
});

/**
 * #225 — the claims the suite was asserting in prose only.
 *
 * Every spec here exists because a mutation to the line it is about left the
 * suite green (!306, substitute review, by mutation testing the real source).
 * A documented invariant with no spec is a comment, and this file has been the
 * place those get turned into tests since !294.
 */
describe("InboxView — invariants that were documented but unpinned (#225)", () => {
  it("carries a navigating write's outcome through the retry", async () => {
    // `7877e2f`'s own headline: "a retry that saved the row and left the user on
    // the inbox would be the press vanishing again." Dropping `onLanded` from
    // `retryWrite` left the whole suite green.
    vi.mocked(startBreakdown).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem({ id: "r1", text: "plan the loft" })]);

    await press(/break into steps/i);
    expect(await screen.findByRole("alert")).toHaveTextContent(/plan the loft/);

    vi.mocked(startBreakdown).mockResolvedValueOnce("task-9");
    await press(RETRY);

    expect(push).toHaveBeenCalledWith("/tasks/task-9");
  });

  it("does not absorb Break into steps behind an Add to-do already in flight", async () => {
    // The stated reason `"breakdown"` and `"focus"` are their own `WriteField`s
    // rather than a share of `"triage"`: the second press asks to be TAKEN
    // somewhere, which the first does not do, so absorbing it would be a silent
    // no-op. Pointing both at `"triage"` left the suite green.
    let releaseKeep = () => {};
    vi.mocked(keepAsTask).mockImplementation(
      () =>
        new Promise<string | undefined>(
          (resolve) => (releaseKeep = () => resolve(undefined)),
        ),
    );
    vi.mocked(startBreakdown).mockResolvedValue("task-3");
    renderInbox([makeItem({ id: "g1", text: "plan the loft" })]);

    // Add-as-single-task is a ▾ entry after #253; Break into steps is still an
    // inline button on the row, which is the point — the two writes are reached
    // from different surfaces and must still not absorb one another.
    await pressInRowMenu("plan the loft", ADD_TODO);
    await press(/break into steps/i);

    expect(vi.mocked(keepAsTask)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startBreakdown)).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseKeep();
      await flushTicks();
    });
  });

  it("keeps the reload offer when a stale write's row has also gone", async () => {
    // `stale` outranks `rowGone` in both `writeFailureKey` and
    // `writeFailureRemedy`, because a reload is the only thing that can work and
    // withdrawing it would leave a notice with no remedy at all. Inverting the
    // precedence in both places left the suite green.
    vi.mocked(completeItem).mockRejectedValueOnce(staleActionError());
    const view = renderInbox([
      makeItem({ id: "s1", text: "water the plants" }),
    ]);

    await press(COMPLETE);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/the app updated while this was open/i);

    // The refresh lands and the row is gone — which for any other failure would
    // withdraw every control.
    await act(async () => {
      view.rerender(
        <InboxView
          workspaceId="ws-test"
          now={Date.now()}
          initialItems={[]}
          settings={settings}
          welcomeVisible={false}
          resumeStep={null}
        />,
      );
      await flushTicks();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      /the app updated while this was open/i,
    );
    expect(
      screen.getByRole("button", { name: /reload the page/i }),
    ).toBeInTheDocument();
  });

  it("does not report a lost write when only the refresh threw", async () => {
    // !290 round 8, documented on this path and until now verified only on the
    // capture path: the row IS written, so a refresh that throws is a stale list,
    // never a lost write. Moving `router.refresh()` inside the inner `try` left
    // the suite green.
    refresh.mockImplementationOnce(() => {
      throw new Error("refresh blew up");
    });
    renderInbox([makeItem({ text: "water the plants" })]);

    await press(COMPLETE);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(vi.mocked(completeItem)).toHaveBeenCalledTimes(1);
  });

  it("announces the wait even when the row vanished and took the Retry with it", async () => {
    // The polite region sits OUTSIDE the `writeRemedy !== "none"` gate on
    // purpose: a row can vanish mid-retry, which withdraws the control and the
    // sighted line with it, while the write is still running. Moving it inside
    // the gate left the suite green.
    vi.mocked(deleteBrainDumpItem).mockRejectedValueOnce(new Error("offline"));
    const view = renderInbox([
      makeItem({ id: "v1", text: "water the plants" }),
    ]);

    await confirmDeleteOnRow("water the plants");
    await screen.findByRole("alert");

    let releaseRetry = () => {};
    vi.mocked(deleteBrainDumpItem).mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseRetry = () => resolve())),
    );
    await press(RETRY);

    await act(async () => {
      view.rerender(
        <InboxView
          workspaceId="ws-test"
          now={Date.now()}
          initialItems={[]}
          settings={settings}
          welcomeVisible={false}
          resumeStep={null}
        />,
      );
      await flushTicks();
    });

    // No control left to describe, and the retry is still running, so the region
    // is the only channel that can say so.
    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
    expect(screen.getByTestId("write-saving-announcer")).toHaveTextContent(
      /saving/i,
    );

    await act(async () => {
      releaseRetry();
      await flushTicks();
    });
  });
});

/**
 * #225 — the deadline itself, from both sides.
 *
 * `INBOX_ACTION_TIMEOUT_MS` is exported "so the test advances the real value
 * rather than a copy of it", and every existing spec advances exactly that — so
 * the deadline was only ever bounded from ABOVE. Replacing the constant at the
 * call site with a hard-coded `2_000` left the whole suite green (!306,
 * substitute review), which means a silent five-fold reduction — giving up on a
 * write that was merely slow — was invisible. Ten seconds is a decision, and a
 * decision with no lower bound is not tested.
 */
describe("InboxView — the row write's deadline (#225)", () => {
  it("is still waiting one tick before the deadline, and gives up on it", async () => {
    vi.useFakeTimers();
    vi.mocked(completeItem).mockReturnValueOnce(new Promise<void>(() => {}));
    renderInbox([makeItem({ text: "water the plants" })]);

    await act(async () => {
      screen.getByRole("button", { name: COMPLETE }).click();
      await flushTicks();
    });
    await act(async () => {
      vi.advanceTimersByTime(INBOX_ACTION_TIMEOUT_MS - 1);
      await flushTicks();
    });

    // A write still inside its budget has not failed, and saying it has is the
    // false report this whole notice exists to avoid — pointing the other way.
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await flushTicks();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      /no answer from the server/i,
    );
  });
});

/**
 * #225 — where focus goes after a RETRY lands, which the code argues about at
 * length and nothing pinned.
 *
 * `retryWrite` passes `origin: writeFailure.origin` — the control the ORIGINAL
 * press came from — with a comment explaining that the Retry button itself is
 * about to unmount, "and handing focus back to it would be handing it to
 * nothing". Replacing that with `focusOrigin()` left the suite green (!306,
 * substitute review), and the consequence is a WCAG 2.4.3 failure: the user is
 * returned to the capture field rather than to the row control they were sent
 * away from.
 */
describe("InboxView — focus after a retry that lands (#225)", () => {
  it("returns focus to the control the first press came from, not the capture field", async () => {
    // TWO failures before the success, and that is what makes this spec
    // discriminate. A retry that lands first time arms the hand-off from the
    // NOTICE's record, so `retryWrite`'s own `origin` never gets read — the
    // argument only becomes the record's origin when the retry itself fails. So
    // the mutation this pins (`origin: focusOrigin()`, which at that moment is
    // the Retry button) is invisible until a second notice is built from it.
    vi.mocked(completeItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline again"))
      .mockResolvedValueOnce(undefined);
    renderInbox([makeItem({ id: "f9", text: "water the plants" })]);

    const complete = screen.getByRole("button", { name: COMPLETE });
    complete.focus();
    await press(COMPLETE);

    // The notice took focus, which is the point of the hand-off existing.
    expect(screen.getByRole("button", { name: RETRY })).toHaveFocus();

    // Fails again, so the record is rebuilt — carrying the ORIGINAL origin, not
    // the Retry button the user is standing on.
    await press(RETRY);
    expect(screen.getByRole("button", { name: RETRY })).toHaveFocus();

    await press(RETRY);

    // Back to the row's own control. Had the record been rebuilt from the Retry
    // button, that button has since unmounted, so the hand-off would have found
    // a disconnected node and dropped the user in the capture field — somewhere
    // they never were (WCAG 2.4.3).
    expect(complete).toHaveFocus();
  });
});
