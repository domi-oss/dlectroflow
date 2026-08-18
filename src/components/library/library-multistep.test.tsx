// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react";
import { LibraryMultistep } from "./library-multistep";
import type { Item } from "@/components/inbox/bucket";
import type { AgingSettings } from "@/lib/aging";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock("@/app/actions/braindump", () => ({
  bulkBrainDumpAction: vi.fn().mockResolvedValue({ count: 1 }),
}));
// TaskSteps is heavy (its own server actions) — stub it; we only assert it mounts for the open row.
vi.mock("@/components/breakdown/task-steps", () => ({
  TaskSteps: ({ taskId }: { taskId: string }) => (
    <div data-testid="task-steps">{taskId}</div>
  ),
}));

const settings: AgingSettings = {
  agingHours: 24,
  overdueHours: 48,
  wayOverdueHours: 72,
};
const mk = (id: string, createdAt: Date): Item => ({
  id,
  text: `task ${id}`,
  createdAt,
  status: "triaged",
  triagedAt: null,
  remindedAt: null,
  snoozedUntil: null,
  taskId: `T${id}`,
  freshenedAt: null,
  promptDismissedAt: null,
  breakdownRequestedAt: null,
  stepsTotal: 2,
  stepsDone: 0,
  taskStatus: "active",
  completedAt: null,
  scheduledAt: null,
  estMinutes: null,
  steps: [
    {
      id: `${id}a`,
      order: 1,
      text: "first",
      done: false,
      estMinutes: 10,
      subtaskEmoji: "🍳",
      resumable: false,
    },
    {
      id: `${id}b`,
      order: 2,
      text: "second",
      done: false,
      estMinutes: 5,
      subtaskEmoji: null,
      resumable: false,
    },
  ],
});
const items = [
  mk("new", new Date("2026-07-18")),
  mk("old", new Date("2026-07-01")),
]; // newest first

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("LibraryMultistep", () => {
  it("opens the latest (first) row by default and shows its steps", () => {
    render(
      <LibraryMultistep
        items={items}
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    expect(screen.getByTestId("task-steps")).toHaveTextContent("Tnew");
  });
  // #51 — the title is the dominant row text across the Library hub, matching
  // the plated tab + the inbox rows (not just font-medium at the small row size).
  it("#51: the row title is the dominant text (text-base font-semibold)", () => {
    render(
      <LibraryMultistep
        items={items}
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    const title = screen.getByRole("button", { name: "task old" });
    expect(title.className).toMatch(/text-base/);
    expect(title.className).toMatch(/font-semibold/);
  });

  it("single-open: opening another row collapses the first", () => {
    render(
      <LibraryMultistep
        items={items}
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "task old" }));
    expect(screen.getByTestId("task-steps")).toHaveTextContent("Told");
  });
  it("shows next-step + estimate meta on a collapsed row", () => {
    render(
      <LibraryMultistep
        items={items}
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    // The collapsed "old" row shows its next step preview. Scope to the "old"
    // row specifically — "first" is the next-step text for the collapsed row,
    // but a broad query could also match text inside the expanded "new" row's
    // stubbed TaskSteps subtree, so scope with within(row).
    const oldRow = screen
      .getByRole("button", { name: "task old" })
      .closest("li")!;
    expect(within(oldRow).getByText("first", { selector: "*" })).toBeTruthy();
    // Both of "old"'s steps are not-done (10 + 5 min), so the collapsed row's
    // estimate pill reads "≈15 min left" (lib.minLeft) — assert it renders on
    // this row, scoped with within() so it can't match another row's pill.
    expect(within(oldRow).getByText(/≈15\s*min left/)).toBeTruthy();
    // No open session on either step → no active-step pill (lib.minOnStep).
    expect(within(oldRow).queryByText(/min on step/)).toBeNull();
  });

  // #27 follow-up — a step with an open FocusSession shows a SECOND pill for
  // its own remaining time, and the task-total pill shrinks to reflect it
  // (not the raw estimate sum).
  it("a paused/in-progress step's row shows BOTH the (shrunk) task total and the active-step remaining", () => {
    const paused = [
      {
        ...mk("p", new Date("2026-07-20")),
        steps: [
          {
            id: "pa",
            order: 1,
            text: "first",
            done: false,
            estMinutes: 10,
            subtaskEmoji: "🍳",
            resumable: true,
            openRemainingSec: 4 * 60, // paused with 4m left (of a 10m estimate)
          },
          {
            id: "pb",
            order: 2,
            text: "second",
            done: false,
            estMinutes: 5,
            subtaskEmoji: null,
            resumable: false,
          },
        ],
      },
    ];
    render(
      <LibraryMultistep
        items={paused}
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    // Collapse the auto-opened row so the collapsed-row meta (pills) render.
    fireEvent.click(screen.getByRole("button", { name: /^collapse all$/i }));
    const row = screen.getByRole("button", { name: "task p" }).closest("li")!;
    // Total = 4 (paused step's remaining) + 5 (not-started step) = 9, not the
    // raw 10 + 5 = 15 the old estimate-sum would have shown.
    expect(within(row).getByText(/≈9\s*min left/)).toBeTruthy();
    expect(within(row).getByText(/≈4\s*min on step/)).toBeTruthy();
  });
  it("playful voice shows the row's emoji anchor (first not-done step's subtaskEmoji)", () => {
    render(
      <LibraryMultistep
        items={items}
        voice="playful"
        now={Date.now()}
        settings={settings}
      />,
    );
    // rowEmoji() picks the first not-done step's subtaskEmoji — for both fixture
    // rows that's step "a" ("🍳"). Scope to one row so this can't accidentally
    // match the sibling row's identical emoji.
    const newRow = screen
      .getByRole("button", { name: "task new" })
      .closest("li")!;
    expect(within(newRow).getByText("🍳")).toBeTruthy();
  });
  it("plain voice renders no emoji anchor", () => {
    render(
      <LibraryMultistep
        items={items}
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    expect(screen.queryByText("🍳")).toBeNull();
  });
  it("select mode: tapping a row's title toggles its checkbox instead of expanding it", () => {
    render(
      <LibraryMultistep
        items={items}
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^select$/i }));
    // "old" starts collapsed (only "new" opens by default) — tap its title.
    const oldRow = screen
      .getByRole("button", { name: "task old" })
      .closest("li")!;
    fireEvent.click(within(oldRow).getByRole("button", { name: "task old" }));
    expect(
      within(oldRow).getByRole("checkbox", { name: /task old/i }),
    ).toBeChecked();
    expect(within(oldRow).queryByTestId("task-steps")).toBeNull();
  });
  it("row title button exposes aria-expanded + aria-controls in normal mode, but not while selecting", () => {
    render(
      <LibraryMultistep
        items={items}
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    const newTitle = screen.getByRole("button", { name: "task new" });
    const oldTitle = screen.getByRole("button", { name: "task old" });
    // "new" opens by default — expanded, with aria-controls pointing at its panel.
    expect(newTitle).toHaveAttribute("aria-expanded", "true");
    expect(newTitle).toHaveAttribute("aria-controls", "lib-steps-new");
    expect(document.getElementById("lib-steps-new")).toBe(
      screen.getByTestId("task-steps").parentElement,
    );
    // "old" starts collapsed.
    expect(oldTitle).toHaveAttribute("aria-expanded", "false");

    // Entering select mode suppresses the disclosure semantics entirely —
    // it's not announced as expandable while a tap just toggles selection.
    fireEvent.click(screen.getByRole("button", { name: /^select$/i }));
    expect(
      screen.getByRole("button", { name: "task new" }),
    ).not.toHaveAttribute("aria-expanded");
    expect(
      screen.getByRole("button", { name: "task old" }),
    ).not.toHaveAttribute("aria-expanded");
  });
  it("select mode: Select → tick a row → Delete calls bulkBrainDumpAction", async () => {
    const { bulkBrainDumpAction } = await import("@/app/actions/braindump");
    render(
      <LibraryMultistep
        items={items}
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^select$/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /task new/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i })); // bar → confirm
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i })); // confirm
    expect(bulkBrainDumpAction).toHaveBeenCalledWith(["new"], "delete");
  });

  it("'Open task' sits in the header (not the panel) when a row is expanded, arrow-free, and carries ?from=library so the task page's back link can return to the Library (#8 follow-up, !83 header move)", () => {
    render(
      <LibraryMultistep
        items={items}
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    // "new" is expanded by default (it's the latest row) — the header link
    // points at it, with no "→" (owner's no-icons-in-text-buttons call).
    const openTaskLink = screen.getByRole("link", { name: /^open task$/i });
    expect(openTaskLink).toHaveAttribute("href", "/tasks/Tnew?from=library");
    expect(openTaskLink.textContent).toBe("Open task");
    // It's not inside the expanded row's panel — that panel is just the
    // stubbed TaskSteps.
    const panel = screen.getByTestId("task-steps").parentElement!;
    expect(
      within(panel).queryByRole("link", { name: /open task/i }),
    ).toBeNull();
  });

  it("'Open task' is absent from the header when nothing is expanded", () => {
    render(
      <LibraryMultistep
        items={items}
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^collapse all$/i }));
    expect(screen.queryByRole("link", { name: /open task/i })).toBeNull();
  });

  it("'Collapse all' collapses the currently-expanded row (TaskSteps unmounts)", () => {
    render(
      <LibraryMultistep
        items={items}
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    // "new" is expanded by default.
    expect(screen.getByTestId("task-steps")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^collapse all$/i }));
    expect(screen.queryByTestId("task-steps")).toBeNull();
    // Also collapses the row's aria-expanded state.
    expect(screen.getByRole("button", { name: "task new" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("header toggle reads 'Collapse all' when a row is open and flips to 'Expand all' once collapsed", () => {
    render(
      <LibraryMultistep
        items={items}
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    // "new" opens by default, so the toggle offers to collapse.
    expect(
      screen.getByRole("button", { name: /^collapse all$/i }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^expand all$/i })).toBeNull();
    // Collapse it → the same control flips to "Expand all".
    fireEvent.click(screen.getByRole("button", { name: /^collapse all$/i }));
    expect(screen.getByRole("button", { name: /^expand all$/i })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /^collapse all$/i }),
    ).toBeNull();
  });

  it("'Expand all' re-opens only the latest (first) row — single-open is preserved, not every row", () => {
    render(
      <LibraryMultistep
        items={items}
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^collapse all$/i }));
    expect(screen.queryByTestId("task-steps")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^expand all$/i }));
    // Exactly one row re-opens (single-open), and it's the latest ("new").
    const panels = screen.getAllByTestId("task-steps");
    expect(panels).toHaveLength(1);
    expect(panels[0]).toHaveTextContent("Tnew");
    // The toggle is back to offering "Collapse all".
    expect(
      screen.getByRole("button", { name: /^collapse all$/i }),
    ).toBeTruthy();
  });

  it("'Open task' sits to the LEFT of the expand/collapse toggle in the header (shared cluster, earlier in DOM order)", () => {
    render(
      <LibraryMultistep
        items={items}
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    const openTask = screen.getByRole("link", { name: /^open task$/i });
    const toggle = screen.getByRole("button", { name: /^collapse all$/i });
    // Same header cluster…
    expect(openTask.parentElement).toBe(toggle.parentElement);
    // …with "Open task" before the toggle (to its left).
    expect(
      openTask.compareDocumentPosition(toggle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

// ── #44 — the note affordance at the TASK grain on a multi-step row ─────────
//
// Its steps already reach their own notes through the expanded step list. The
// task's own note is a different thing — context for the whole task — and had
// no route here either.
describe("LibraryMultistep — the task note (#44)", () => {
  it("offers a note named after the task, not after one of its steps", () => {
    render(
      <LibraryMultistep
        items={[mk("new", new Date("2026-07-18"))]}
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Note for task new" }),
    ).toBeTruthy();
  });

  it("shows an existing task note as text", () => {
    const item = { ...mk("new", new Date("2026-07-18")), notes: "ring ahead" };
    render(
      <LibraryMultistep
        items={[item]}
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    expect(screen.getByTestId("note-text").textContent).toBe("ring ahead");
  });
});

/**
 * #205 (folded into #253) — the Multi-step hub's header controls carry the shared
 * 44px floor. The second and last of the two files #205's audit found carrying
 * **zero** `touchTarget`.
 *
 * Citation, stated as `row-menu-viewport-fit.spec.ts` and `note-field.tsx` state
 * it because inverting it is a documented error here: 44x44 is **2.5.5 Target
 * Size (Enhanced), AAA**; **2.5.8 (Minimum) is the AA one, at 24x24**, which
 * these already met. A house convention (`touchTarget` in `@/lib/utils`), not a
 * conformance fix.
 *
 * ⚠️ Two corrections to #205's table, both measured against this file rather than
 * inherited from it:
 *
 *  1. It lists "5 `<button>`" — but the fifth is the ROW TITLE, a full-width
 *     disclosure that is not a header control, and it is deliberately excluded
 *     (see the reason written into `library-multistep.tsx`). So four buttons.
 *  2. It misses "Open task", which is a `<Link>` and not a `<button>` — yet it is
 *     a bordered pill sitting in the same header cluster, at the same `py-1`, and
 *     #205's OWN method (grep `py-1`) flags its line. A count keyed to `<button`
 *     cannot see it. Sized, because a control that looks identical to the one
 *     beside it and measures 20px shorter is the visible inconsistency the issue
 *     exists to remove.
 *
 * Both header states are asserted. Select mode REPLACES "Expand all" with
 * "Select all" / "Cancel", so a guard rendering only the resting header leaves
 * two of the four unmeasured — the blind spot #251 hit four times at row level,
 * and the same reason `select-action-bar.test.tsx` measures its armed confirm.
 */
describe("LibraryMultistep — 44px targets (#205 leg)", () => {
  const expect44 = (el: HTMLElement) => {
    expect(el.className, `"${el.textContent}" is not ≥44px tall`).toContain(
      "min-h-11",
    );
    expect(el.className, `"${el.textContent}" is not ≥44px wide`).toContain(
      "min-w-11",
    );
  };

  const renderHub = () =>
    render(
      <LibraryMultistep
        items={items}
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );

  it("the resting header's toggle and Select carry the 44px touch target", () => {
    renderHub();
    for (const name of [/^collapse all$/i, /^select$/i]) {
      expect44(screen.getByRole("button", { name }));
    }
  });

  it("the Open task link carries it too, though it is a Link and not a button", () => {
    renderHub();
    // Shown only while a row is expanded — the latest row opens by default, so
    // it is present on first render. `next/link` is NOT mocked in this file, so
    // this measures the real rendered anchor: the `task-steps.test.tsx` mock that
    // silently dropped `className` is exactly why that matters.
    const open = screen.getByRole("link", { name: "Open task" });
    expect44(open);
    expect(open).toHaveAttribute("href", "/tasks/Tnew?from=library");
  });

  it("select mode's Select all / Cancel pair carries it as well", () => {
    renderHub();
    fireEvent.click(screen.getByRole("button", { name: /^select$/i }));
    for (const name of [/^select all$/i, /^cancel$/i]) {
      expect44(screen.getByRole("button", { name }));
    }
    // Guard the guard: these two are a genuinely different pair, not the ones
    // already measured. `Select` is what they REPLACE, so its absence is the
    // evidence that this state was actually entered.
    expect(screen.queryByRole("button", { name: /^select$/i })).toBeNull();
    // `Open task` is hidden here too, so all four header controls have now been
    // measured across the two states, and none of them twice.
    expect(screen.queryByRole("link", { name: "Open task" })).toBeNull();
    // The expand/collapse toggle is NOT part of the swap — it renders in both
    // states (asserted, because I assumed the opposite and this caught it).
    expect44(screen.getByRole("button", { name: /^collapse all$/i }));
  });

  it("the row title is deliberately NOT squared up, and says so in the file", () => {
    renderHub();
    const title = screen.getByRole("button", { name: "task old" });
    // Sizing this would add ~20px to EVERY collapsed row, which is the opposite
    // of what #253 is doing to this surface — and `touchTarget`'s
    // `justify-center` would centre a title that has to stay left-aligned.
    // Pinned as an assertion rather than left implicit so that "make everything
    // 44px" cannot be applied here without a test going red and pointing at the
    // written reason.
    expect(title.className).not.toContain("min-h-11");
    expect(title.className).toMatch(/text-left/);
    expect(title.className).toMatch(/w-full/);
  });

  it("select mode still suppresses expansion after the class change", () => {
    renderHub();
    fireEvent.click(screen.getByRole("button", { name: /^select$/i }));
    // The title button's onClick branches on `sel.selecting`; the exclusion above
    // means its className expression was left alone, and this pins the behaviour
    // that would break if a later edit reached for `cn` there.
    fireEvent.click(screen.getByRole("button", { name: "task old" }));
    expect(screen.queryByTestId("task-steps")).toBeNull();
  });
});
