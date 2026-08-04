// @vitest-environment jsdom
//
// #163 — the inbox drag surface, driven through @atlaskit/pragmatic-drag-and-drop.
//
// Two things make this its own file rather than more cases in
// `inbox-view.test.tsx`:
//
//  1. **jsdom implements neither `DragEvent` nor `DOMRect`**
//     (https://github.com/jsdom/jsdom/issues/2913), and pragmatic-drag-and-drop
//     is built on the platform's own drag and drop, so it needs both. The two
//     imports below are Atlassian's polyfills and they are side-effecting
//     globals — scoping them to the one file that needs them keeps them out of
//     every other suite.
//  2. The accessibility half of this migration is the part most likely to
//     regress silently. dnd-kit shipped screen-reader announcements for free;
//     pragmatic-drag-and-drop deliberately does not
//     (https://atlassian.design/components/pragmatic-drag-and-drop/accessibility-guidelines
//     — "the core package does not enable accessible controls automatically").
//     Every announcement is therefore ours to write and ours to pin.
import "@atlaskit/pragmatic-drag-and-drop-unit-testing/drag-event-polyfill";
import "@atlaskit/pragmatic-drag-and-drop-unit-testing/dom-rect-polyfill";

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
  pushStepsToGoogleTasks: vi.fn().mockResolvedValue({ ok: true }),
  scheduleSingleTask: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/app/actions/ics-schedule", () => ({
  scheduleViaIcs: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/download-ics", () => ({ downloadIcs: vi.fn() }));

vi.mock("@/lib/notifications", () => ({
  notificationPermission: () => "default",
  subscribeNotificationPermission: () => () => {},
  requestNotificationPermission: vi.fn().mockResolvedValue("default"),
  registerServiceWorker: vi.fn().mockResolvedValue(null),
  showReminder: vi.fn().mockResolvedValue(undefined),
}));

// Passthrough spy: `dropPlan` keeps its real behaviour but its calls become
// observable, which is how "drag and the Move to… menu still share ONE
// dispatcher" (#163's acceptance criteria) is asserted rather than assumed.
vi.mock("@/components/inbox/move-dispatch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/inbox/move-dispatch")>();
  return { ...actual, dropPlan: vi.fn(actual.dropPlan) };
});

import {
  completeItem,
  moveToReview,
  snoozeBrainDumpItem,
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

function renderInbox(items: Item[]) {
  return render(
    <InboxView
      now={Date.now()}
      initialItems={items}
      settings={settings}
      welcomeVisible={false}
      resumeStep={null}
    />,
  );
}

/** The grip is a pointer-only affordance, so it has no accessible role to
 * query by — `data-drag-grip` is its test hook, the same way `data-bucket`
 * already is for the drop zones. */
function gripFor(container: HTMLElement, itemId: string): HTMLElement {
  const grip = container.querySelector<HTMLElement>(
    `[data-drag-grip="${itemId}"]`,
  );
  if (!grip) throw new Error(`no drag grip for ${itemId}`);
  return grip;
}

function bucket(container: HTMLElement, id: string): HTMLElement {
  const zone = container.querySelector<HTMLElement>(`[data-bucket="${id}"]`);
  if (!zone) throw new Error(`no bucket ${id}`);
  return zone;
}

function announcer(): HTMLElement {
  return screen.getByTestId("move-announcer");
}

/** pragmatic-drag-and-drop defers `onDragStart` to the animation frame after
 * the native `dragstart`, so a test that asserts on lift has to let one
 * frame pass. (A later `drop` flushes it, but the lift assertions cannot
 * wait for that.) */
async function nextFrame() {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
}

/**
 * A whole drag, in the event sequence a real browser produces.
 *
 * `dragover` is not decoration here (Duo review). pragmatic-drag-and-drop binds
 * it on `window` and repurposes it as its `drag` event, and its listener calls
 * the SAME `onUpdateEvent` that `dragenter` does — "we need to regularly
 * calculate the drop targets in order to allow dynamic `canDrop()` checks" and
 * re-read `getData()` (`dist/esm/ledger/lifecycle-manager.js`). A sequence that
 * jumps `dragenter` → `drop` therefore exercises only the entry-time
 * evaluation, and would miss a regression in the continuous one.
 */
async function dragOnto(grip: HTMLElement, target: HTMLElement) {
  fireEvent.dragStart(grip);
  await nextFrame();
  fireEvent.dragEnter(target);
  await nextFrame();
  // Throttled to at most once per frame by the library, so this needs its own.
  fireEvent.dragOver(target);
  await nextFrame();
  await act(async () => {
    fireEvent.drop(target);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Unwind any drag left open by a failing assertion so it cannot leak into
  // the next test (Atlassian's own testing guidance).
  fireEvent.dragEnd(window);
  fireEvent.pointerMove(window);
  cleanup();
});

describe("#163 drag dispatch", () => {
  it("dropping a review row on Completed completes it through the shared dispatcher", async () => {
    const { container } = renderInbox([
      makeItem({ id: "d1", text: "buy oat milk" }),
    ]);

    await dragOnto(gripFor(container, "d1"), bucket(container, "completed"));

    expect(dropPlan).toHaveBeenCalledWith("needsReview", "completed");
    expect(completeItem).toHaveBeenCalledWith("d1");
  });

  it("dropping on Saved for later snoozes, so the destination — not the gesture — picks the action", async () => {
    const { container } = renderInbox([
      makeItem({ id: "d2", text: "read the spec" }),
    ]);

    await dragOnto(gripFor(container, "d2"), bucket(container, "savedLater"));

    expect(snoozeBrainDumpItem).toHaveBeenCalledWith("d2", 60);
  });

  it("dropping a row back on its own bucket changes nothing", async () => {
    const { container } = renderInbox([
      makeItem({ id: "d3", text: "stay put" }),
    ]);

    await dragOnto(gripFor(container, "d3"), bucket(container, "needsReview"));

    expect(dropPlan).toHaveBeenCalledWith("needsReview", "needsReview");
    expect(completeItem).not.toHaveBeenCalled();
    expect(moveToReview).not.toHaveBeenCalled();
  });

  it("highlights the bucket the drag is over, and clears it on drop", async () => {
    const { container } = renderInbox([
      makeItem({ id: "d4", text: "highlight me" }),
    ]);
    const target = bucket(container, "completed");

    fireEvent.dragStart(gripFor(container, "d4"));
    await nextFrame();
    fireEvent.dragEnter(target);
    await nextFrame();
    expect(target.className).toMatch(/ring-2/);

    await act(async () => {
      fireEvent.drop(target);
    });
    expect(target.className).not.toMatch(/ring-2/);
  });

  it("dims the row being dragged and undims it when the drag ends", async () => {
    const { container } = renderInbox([makeItem({ id: "d5", text: "dim me" })]);
    const row = () => screen.getByText("dim me").closest("li")!;

    expect(row().className).not.toMatch(/opacity-40/);
    fireEvent.dragStart(gripFor(container, "d5"));
    await nextFrame();
    expect(row().className).toMatch(/opacity-40/);

    await act(async () => {
      fireEvent.dragEnd(gripFor(container, "d5"));
    });
    expect(row().className).not.toMatch(/opacity-40/);
  });
});

describe("#62 the drag preview is our own element, not the grip's box", () => {
  // The original fault: dnd-kit's `DragOverlay` sized its wrapper to the
  // measured rect of the *draggable* node, and the draggable ref lived on the
  // 28×44 grip — so the ghost was grip-sized and the title collapsed into a
  // vertical sliver. pragmatic-drag-and-drop has no equivalent coupling:
  // `setCustomNativeDragPreview` mounts a container of OUR making and the
  // browser photographs that, so the grip's rect never enters the calculation.
  // What this can assert in jsdom is that the ghost really is rendered from
  // our own component during `dragstart` (real-browser pixels still need a
  // device — see the MR).
  it("renders the ghost row into a preview container while the drag starts, then takes it away", async () => {
    const { container } = renderInbox([
      makeItem({ id: "p1", text: "Test de UI-elementen in de checkout flow" }),
    ]);

    // The container's whole life is one tick of `dragstart` plus the frame the
    // lift completes on. `act` flushes React's portal into it; the frame after
    // that, `setCustomNativeDragPreview` removes it.
    await act(async () => {
      fireEvent.dragStart(gripFor(container, "p1"));
    });

    const ghost = document.body.querySelector("[data-drag-ghost]");
    expect(ghost, "no preview was mounted").not.toBeNull();
    expect(ghost!.textContent).toContain(
      "Test de UI-elementen in de checkout flow",
    );
    // …rendered outside the row, which is the point: the browser photographs
    // this element, so nothing about the 28×44 grip's box can shape it.
    expect(container.contains(ghost)).toBe(false);

    await nextFrame();
    expect(document.body.querySelector("[data-drag-ghost]")).toBeNull();
  });
});

describe("#163 screen-reader announcements", () => {
  // The live region must exist and be EMPTY before the first move: assistive
  // technology only announces a change to a region that was already in the
  // accessibility tree, so one that is inserted along with its first message
  // is silent.
  it("renders an empty polite live region up front", () => {
    renderInbox([makeItem({ id: "a0", text: "quiet" })]);
    const region = announcer();
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveTextContent("");
  });

  it("announces the lift, naming the item and the list it came from", async () => {
    const { container } = renderInbox([
      makeItem({ id: "a1", text: "buy oat milk" }),
    ]);

    fireEvent.dragStart(gripFor(container, "a1"));
    await nextFrame();

    expect(announcer()).toHaveTextContent(/buy oat milk/);
    expect(announcer()).toHaveTextContent(/Needs review/);
  });

  it("announces the destination while the drag is over it", async () => {
    const { container } = renderInbox([
      makeItem({ id: "a2", text: "buy oat milk" }),
    ]);

    fireEvent.dragStart(gripFor(container, "a2"));
    await nextFrame();
    fireEvent.dragEnter(bucket(container, "completed"));
    await nextFrame();

    expect(announcer()).toHaveTextContent(/Completed/);
  });

  it("announces the completed move, naming both lists", async () => {
    const { container } = renderInbox([
      makeItem({ id: "a3", text: "buy oat milk" }),
    ]);

    await dragOnto(gripFor(container, "a3"), bucket(container, "completed"));

    expect(announcer()).toHaveTextContent(/buy oat milk/);
    expect(announcer()).toHaveTextContent(/Needs review/);
    expect(announcer()).toHaveTextContent(/Completed/);
  });

  it("does not claim a move when the drop changed nothing", async () => {
    const { container } = renderInbox([
      makeItem({ id: "a4", text: "buy oat milk" }),
    ]);

    await dragOnto(gripFor(container, "a4"), bucket(container, "needsReview"));

    expect(announcer()).toHaveTextContent(/not moved|still in/i);
  });

  it("announces a cancelled drag", async () => {
    const { container } = renderInbox([
      makeItem({ id: "a5", text: "buy oat milk" }),
    ]);

    fireEvent.dragStart(gripFor(container, "a5"));
    await nextFrame();
    await act(async () => {
      fireEvent.dragEnd(gripFor(container, "a5"));
    });

    expect(announcer()).toHaveTextContent(/cancel/i);
  });

  // The point of one dispatcher is one outcome; the point of announcing from
  // inside it is one *description* of that outcome. A menu move that stayed
  // silent would be the regression this migration is most likely to ship.
  it("announces a menu move in exactly the same words as the equivalent drop", async () => {
    const user = userEvent.setup();
    renderInbox([makeItem({ id: "a6", text: "buy oat milk" })]);

    const row = screen.getByText("buy oat milk").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Move to" }));
    await user.click(
      await within(row).findByRole("menuitem", { name: /^Completed$/ }),
    );

    expect(announcer()).toHaveTextContent(/buy oat milk/);
    expect(announcer()).toHaveTextContent(/Needs review/);
    expect(announcer()).toHaveTextContent(/Completed/);
  });
});

describe("#163 the keyboard path", () => {
  // pragmatic-drag-and-drop has no keyboard adapter and Atlassian explicitly
  // recommends against arrow-key dragging, so the "Move to" control is not a
  // fallback any more — it IS the keyboard and assistive-technology path, and
  // it is what makes the drag surface satisfy WCAG 2.1.1 (Keyboard) and 2.5.7
  // (Dragging Movements). Every draggable row must carry one.
  it("gives every row with a grip a move control that is not a drag", () => {
    const { container } = renderInbox([
      makeItem({ id: "k1", text: "review row" }),
      makeItem({ id: "k2", text: "todo row", status: "triaged" }),
      makeItem({
        id: "k3",
        text: "saved row",
        snoozedUntil: new Date(Date.now() + 60 * 60 * 1000),
      }),
      makeItem({
        id: "k4",
        text: "done row",
        status: "triaged",
        completedAt: new Date(),
      }),
    ]);

    const grips = container.querySelectorAll("[data-drag-grip]");
    expect(grips.length).toBeGreaterThan(0);
    for (const grip of Array.from(grips)) {
      const row = grip.closest("li");
      expect(row, "a grip outside a row").not.toBeNull();
      expect(
        within(row as HTMLElement).queryByRole("button", { name: "Move to" }),
      ).not.toBeNull();
    }
  });

  it("moves an item with the keyboard alone", async () => {
    const user = userEvent.setup();
    renderInbox([makeItem({ id: "k5", text: "keyboard row" })]);

    const row = screen.getByText("keyboard row").closest("li")!;
    const trigger = within(row).getByRole("button", { name: "Move to" });
    trigger.focus();
    expect(trigger).toHaveFocus();

    // ArrowDown on a menu button opens the menu with its first entry
    // highlighted; walking with the arrow keys rather than clicking is what
    // makes this a keyboard proof and not a pointer one.
    await user.keyboard("{ArrowDown}");
    const target = await within(row).findByRole("menuitem", {
      name: /^Completed$/,
    });
    // Bounded so a menu that never highlights fails instead of hanging. The
    // cap is 2× the four entries a needs-review row offers, which is enough
    // for the roving cursor to wrap; exhausting it means the arrow keys are
    // not moving the cursor at all, and the message has to say that rather
    // than "expected element to have attribute" (Duo review).
    const MAX_ARROWS = 8;
    let presses = 0;
    while (!target.matches("[data-highlighted]") && presses < MAX_ARROWS) {
      await user.keyboard("{ArrowDown}");
      presses += 1;
    }
    expect(
      target.matches("[data-highlighted]"),
      `ArrowDown never reached "Completed": ${presses} of a maximum ${MAX_ARROWS} presses. ` +
        `Highlighted instead: ${
          within(row)
            .queryAllByRole("menuitem")
            .filter((el) => el.matches("[data-highlighted]"))
            .map((el) => el.textContent)
            .join(", ") || "nothing"
        }.`,
    ).toBe(true);
    await user.keyboard("{Enter}");

    expect(completeItem).toHaveBeenCalledWith("k5");
    // Focus must come back to the row, not be stranded on a detached popup.
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  // The grip used to be a `<button aria-label="Drag …">` because dnd-kit's
  // KeyboardSensor needed a focusable activator. There is no keyboard drag any
  // more, so leaving it in the tab order would put a control in front of a
  // screen-reader user that advertises something it cannot do.
  it("keeps the grip out of the tab order and out of the accessibility tree", () => {
    const { container } = renderInbox([
      makeItem({ id: "k6", text: "grip row" }),
    ]);

    expect(
      screen.queryByRole("button", { name: /^Drag /i }),
    ).not.toBeInTheDocument();

    const grip = gripFor(container, "k6");
    expect(grip).toHaveAttribute("aria-hidden", "true");
    expect(grip).not.toHaveAttribute("tabindex");
    expect(grip.tagName).not.toBe("BUTTON");
  });
});
