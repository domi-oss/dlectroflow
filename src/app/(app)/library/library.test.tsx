// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import LibraryPage from "./page";
import { LIB_PANEL_HEADING_ID } from "@/components/library/library-done-delete";

// Hoisted so the vi.mock factory (which runs before imports) can close over them.
const { findMany, getSettingsMock, currentWorkspaceIdMock } = vi.hoisted(
  () => ({
    findMany: vi.fn(),
    getSettingsMock: vi.fn(),
    currentWorkspaceIdMock: vi.fn(),
  }),
);

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));
vi.mock("@/lib/db", () => ({
  prisma: { brainDumpItem: { findMany } },
  getSettings: getSettingsMock,
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
}));
// The in-flight tabs (plated/pantry) render the interactive <LibraryRows>,
// which needs a router + the (mocked) server actions to mount in jsdom.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/app/actions/braindump", () => ({
  ensureFocusStep: vi.fn().mockResolvedValue(null),
  completeItem: vi.fn().mockResolvedValue(undefined),
  deleteBrainDumpItem: vi.fn().mockResolvedValue(undefined),
  bulkBrainDumpAction: vi.fn().mockResolvedValue({ count: 0 }),
}));
// The Multi-step tab's <LibraryMultistep> auto-opens its latest row into
// <TaskSteps>, which pulls in its own server actions (breakdown/focus) — stub
// it like the sibling component test does; we only need it to mount.
vi.mock("@/components/breakdown/task-steps", () => ({
  TaskSteps: ({ taskId }: { taskId: string }) => (
    <div data-testid="task-steps">{taskId}</div>
  ),
}));

const DAY = 86_400_000;

// Minimal raw `brainDumpItem` (findMany with `include: { task: { steps } }` shape).
function raw(
  overrides: Partial<{
    id: string;
    text: string;
    createdAt: Date;
    status: string;
    snoozedUntil: Date | null;
    completedAt: Date | null;
    breakdownRequestedAt: Date | null;
    taskId: string | null;
    task: unknown;
  }> & { id: string },
) {
  return {
    text: overrides.id,
    createdAt: new Date(Date.now() - 2 * 3600_000),
    status: "triaged",
    triagedAt: null,
    remindedAt: null,
    snoozedUntil: null,
    freshenedAt: null,
    promptDismissedAt: null,
    completedAt: null,
    breakdownRequestedAt: null,
    taskId: null,
    workspaceId: "owner",
    estMinutes: null,
    task: null,
    ...overrides,
  };
}

const step = (done: boolean, order: number) => ({
  id: `s${order}`,
  order,
  text: `step ${order}`,
  done,
  estMinutes: 10,
  subtaskEmoji: null,
  // Matches the `include: { focusSessions: { where: { endedAt: null }, ... } }`
  // shape the query now asks for (mirrors inbox/page.tsx) — no open session by
  // default, so `resumable` computes to false.
  focusSessions: [] as { id: string }[],
});

// One item per tab (+ the graduation edge cases).
const FIXTURE = [
  // plated (Single-task): triaged, no steps
  raw({ id: "Reply to Sam's email", text: "Reply to Sam's email" }),
  // pantry (Saved for later): inbox, snoozed into the future
  raw({
    id: "Book dentist",
    text: "Book dentist",
    status: "inbox",
    snoozedUntil: new Date(Date.now() + DAY),
  }),
  // sorted (Multi-step): partial progress, not scheduled → stays in Multi-step
  raw({
    id: "Plan the offsite",
    text: "Plan the offsite",
    taskId: "t-sorted",
    task: {
      status: "active",
      scheduledAt: null,
      steps: [step(true, 0), step(false, 1), step(false, 2)],
    },
  }),
  // done (graduated): all steps done → graduates out of Multi-step into Done
  raw({
    id: "Sort the tax docs",
    text: "Sort the tax docs",
    taskId: "t-done",
    task: {
      status: "active",
      scheduledAt: new Date(),
      steps: [step(true, 0), step(true, 1)],
    },
  }),
  // done (completed to-do): explicitly completed single item, no steps
  raw({
    id: "Reply to recruiter",
    text: "Reply to recruiter",
    completedAt: new Date(),
  }),
];

beforeEach(() => {
  findMany.mockResolvedValue(FIXTURE);
  getSettingsMock.mockResolvedValue({ voice: "plain" });
  currentWorkspaceIdMock.mockResolvedValue("owner");
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderTab = async (tab?: string) =>
  render(
    await LibraryPage({ searchParams: Promise.resolve(tab ? { tab } : {}) }),
  );

describe("LibraryPage — tabs render their correct set", () => {
  it("Single-task (plated) lists only single-task to-dos", async () => {
    await renderTab("plated");
    expect(screen.getByText("Reply to Sam's email")).toBeInTheDocument();
    expect(screen.queryByText("Plan the offsite")).not.toBeInTheDocument();
    expect(screen.queryByText("Book dentist")).not.toBeInTheDocument();
    expect(screen.queryByText("Sort the tax docs")).not.toBeInTheDocument();
  });

  it("Saved for later (pantry) lists snoozed items with a wake time", async () => {
    await renderTab("pantry");
    expect(screen.getByText("Book dentist")).toBeInTheDocument();
    // "wakes <time>" row meta (not the hint sentence that ends "…wakes.")
    expect(screen.getByText(/wakes \w/)).toBeInTheDocument();
    expect(screen.queryByText("Reply to Sam's email")).not.toBeInTheDocument();
  });

  it("Multi-step (sorted) lists in-progress tasks, auto-opening the latest into its breakdown", async () => {
    await renderTab("sorted");
    expect(screen.getByText("Plan the offsite")).toBeInTheDocument();
    // It's the only (=latest) Multi-step row, so <LibraryMultistep> auto-opens
    // it into its step breakdown (stubbed <TaskSteps>) rather than a static pill.
    expect(screen.getByTestId("task-steps")).toHaveTextContent("t-sorted");
    // graduated + completed items are NOT here
    expect(screen.queryByText("Sort the tax docs")).not.toBeInTheDocument();
  });

  it("orders the tabs Single-task · Multi-step · Saved for later · Done", async () => {
    await renderTab("plated");
    const nav = screen.getByRole("navigation", { name: /Library tabs/i });
    const labels = within(nav)
      .getAllByRole("link")
      .map((a) => a.textContent ?? "");
    expect(labels).toEqual([
      expect.stringContaining("Single-task"),
      expect.stringContaining("Multi-step"),
      expect.stringContaining("Saved for later"),
      expect.stringContaining("Done"),
    ]);
  });

  it("defaults to the Single-task tab when ?tab is absent/invalid", async () => {
    await renderTab(undefined);
    expect(screen.getByText("Reply to Sam's email")).toBeInTheDocument();
    cleanup();
    await renderTab("bogus");
    expect(screen.getByText("Reply to Sam's email")).toBeInTheDocument();
  });
});

describe("LibraryPage — Done graduation", () => {
  it("shows all-steps-done tasks AND completed to-dos, but not partial ones", async () => {
    await renderTab("done");
    expect(screen.getByText("Sort the tax docs")).toBeInTheDocument(); // all steps done
    expect(screen.getByText("Reply to recruiter")).toBeInTheDocument(); // completed to-do
    expect(screen.getByText(/2\/2 done/)).toBeInTheDocument();
    // partial multi-step must NOT have graduated
    expect(screen.queryByText("Plan the offsite")).not.toBeInTheDocument();
  });
});

// ── #251 — Done gained a delete, and nothing else ──────────────────────────
//
// `LibraryRow` was a read-only server component with no controls at all, so a
// completed to-do could not be removed from the hub. What went in is one client
// island, not `<LibraryRows>`: that renders ▶ Start focusing, Complete, an
// estimate editor, an editable note and select mode, and none of those mean
// anything on a closed row. These assert the affordance is there, that the row
// did NOT gain the rest of them, and that the hand-off target the island focuses
// is actually rendered — the one coupling that would otherwise fail silently by
// returning focus to <body>.
describe("LibraryPage — deleting a Done row (#251)", () => {
  it("gives every Done row a delete control", async () => {
    await renderTab("done");
    const rows = screen.getAllByRole("listitem");
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(
        within(row).getByRole("button", { name: "Delete" }),
      ).toBeInTheDocument();
    }
  });

  it("adds no in-flight affordance to a closed row", async () => {
    await renderTab("done");
    const row = screen.getByText("Reply to recruiter").closest("li")!;
    // The whole reason for the narrow island rather than <LibraryRows>.
    expect(
      within(row).queryByRole("button", { name: /Start focusing/i }),
    ).toBeNull();
    expect(within(row).queryByRole("button", { name: /Complete/i })).toBeNull();
    expect(within(row).queryByRole("button", { name: /estimate/i })).toBeNull();
  });

  it("renders the panel heading the delete hands focus back to, focusable", async () => {
    await renderTab("done");
    const heading = document.getElementById(LIB_PANEL_HEADING_ID);
    expect(heading).not.toBeNull();
    // `tabIndex={-1}` or the hand-off silently does nothing and the user is left
    // on <body> — the WCAG 2.4.3 fault the hand-off exists to avoid.
    expect(heading).toHaveAttribute("tabindex", "-1");
  });

  it("leaves the in-flight tabs' own delete alone", async () => {
    // `plated` renders <LibraryRows>, which has had a delete since Task 7. The
    // Done island must not have grown a second one into it.
    await renderTab("plated");
    const row = screen.getByText("Reply to Sam's email").closest("li")!;
    expect(within(row).getAllByRole("button", { name: "Delete" })).toHaveLength(
      1,
    );
  });
});

describe("LibraryPage — workspace scoping", () => {
  it("only ever reads items for the current workspace", async () => {
    currentWorkspaceIdMock.mockResolvedValue("guest-42");
    await renderTab("plated");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "guest-42" }),
      }),
    );
  });
});

describe("LibraryPage — voice-aware", () => {
  it("uses the playful tab labels when the voice is playful", async () => {
    getSettingsMock.mockResolvedValue({ voice: "playful" });
    await renderTab("plated");
    expect(screen.getByText("😋 Quick bites")).toBeInTheDocument();
    expect(screen.getByText("🥫 Pantry")).toBeInTheDocument();
  });
});

// ── #44 — the note reaches the row through the PAGE, not just the component ─
//
// The gap the owner found on the review app was invisible to every component
// test, because a component test cannot see a surface that never mounts the
// component. These render the real page against a fake `findMany` and assert
// the note arrives — which also pins that the query selects the column, since
// a row mapper that drops `task.notes` fails here and nowhere else.
describe("LibraryPage — the note reaches every task-bearing tab (#44)", () => {
  it("Single-task rows offer the note and show an existing one", async () => {
    findMany.mockResolvedValue([
      raw({
        id: "Reply to Sam's email",
        text: "Reply to Sam's email",
        taskId: "t-plated",
        task: {
          status: "active",
          scheduledAt: null,
          notes: "his reply is in the archive",
          steps: [],
        },
      }),
    ]);
    await renderTab("plated");
    expect(screen.getByTestId("note-text").textContent).toBe(
      "his reply is in the archive",
    );
    expect(
      screen.getByRole("button", {
        name: "Note for Reply to Sam's email",
      }),
    ).toBeTruthy();
  });

  it("Multi-step rows offer the TASK's note, named after the task", async () => {
    await renderTab("sorted");
    expect(
      screen.getByRole("button", { name: "Note for Plan the offsite" }),
    ).toBeTruthy();
  });

  it("Saved-for-later rows offer it once they are task-backed", async () => {
    findMany.mockResolvedValue([
      raw({
        id: "Book dentist",
        text: "Book dentist",
        status: "inbox",
        snoozedUntil: new Date(Date.now() + DAY),
        taskId: "t-pantry",
        task: { status: "active", scheduledAt: null, notes: null, steps: [] },
      }),
    ]);
    await renderTab("pantry");
    expect(
      screen.getByRole("button", { name: "Note for Book dentist" }),
    ).toBeTruthy();
  });

  it("Done rows show the note read-only — no control, nothing hidden", async () => {
    findMany.mockResolvedValue([
      raw({
        id: "Sort the tax docs",
        text: "Sort the tax docs",
        taskId: "t-done",
        task: {
          status: "active",
          scheduledAt: new Date(),
          notes: "receipts are in the blue folder",
          steps: [step(true, 0), step(true, 1)],
        },
      }),
    ]);
    await renderTab("done");
    expect(screen.getByTestId("note-text").textContent).toBe(
      "receipts are in the blue folder",
    );
    expect(screen.queryByRole("button", { name: /note/i })).toBeNull();
  });
});
