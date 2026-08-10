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
} from "@testing-library/react";
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
  keepAsTask,
  renameItem,
} from "@/app/actions/braindump";
import { INBOX_ACTION_TIMEOUT_MS } from "@/components/inbox/inbox-view";

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
    screen
      .getByRole("button", { name: new RegExp(`^edit ${rowText}$`, "i") })
      .click();
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
      makeItem({ id: "a", text: "alpha" }),
      makeItem({ id: "b", text: "bravo" }),
    ]);

    await act(async () => {
      screen.getAllByRole("button", { name: COMPLETE })[0].click();
      await flushTicks();
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/alpha/);

    await act(async () => {
      screen.getAllByRole("button", { name: COMPLETE })[1].click();
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

    await press(/^delete$/i);
    await press(/^delete$/i); // the inline confirm
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // The user is standing on the Retry that is about to be taken away.
    screen.getByRole("button", { name: RETRY }).focus();

    rerender(
      <InboxView
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

    await act(async () => {
      screen.getByRole("button", { name: /^delete$/i }).click();
      await flushTicks();
    });
    await act(async () => {
      screen.getByRole("button", { name: /^delete$/i }).click(); // the inline confirm
      await flushTicks();
    });
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

    await act(async () => {
      screen.getByRole("button", { name: /add to-?do/i }).click();
      await flushTicks();
    });
    await act(async () => {
      screen.getByRole("button", { name: /add to-?do/i }).click();
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
    renderInbox([makeItem({ id: "a" }), makeItem({ id: "b" })]);

    await act(async () => {
      screen.getAllByRole("button", { name: COMPLETE })[0].click();
      await flushTicks();
    });
    await act(async () => {
      screen.getAllByRole("button", { name: COMPLETE })[1].click();
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
      screen.getAllByRole("button", { name: COMPLETE })[0].click();
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
      makeItem({ id: "a", text: "alpha" }),
      makeItem({ id: "b", text: "bravo" }),
    ]);
    // Re-queried every time rather than held: the notice mounting and unmounting
    // above the board re-renders the rows, and a stale node would make
    // `toHaveFocus` fail for a reason that is not the one under test.
    const completeOn = (row: 0 | 1) =>
      screen.getAllByRole("button", { name: COMPLETE })[row];

    // Bravo's write is still in flight when alpha's fails, so the notice on
    // screen is alpha's while bravo's success is still to come.
    completeOn(1).focus();
    await act(async () => {
      completeOn(1).click();
      await flushTicks();
    });
    completeOn(0).focus();
    await act(async () => {
      completeOn(0).click();
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
      completeOn(0).click();
      await flushTicks();
    });

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(capture).toHaveFocus();
    expect(completeOn(1)).not.toHaveFocus();
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
      makeItem({ id: "a", text: "alpha" }),
      makeItem({ id: "b", text: "bravo" }),
    ]);
    const completeOn = (row: 0 | 1) =>
      screen.getAllByRole("button", { name: COMPLETE })[row];

    completeOn(1).focus();
    await act(async () => {
      completeOn(1).click();
      await flushTicks();
    });
    completeOn(0).focus();
    await act(async () => {
      completeOn(0).click();
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
      completeOn(1).click();
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
});
