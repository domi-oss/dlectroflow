// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { LibraryMultistep } from "./library-multistep";
import type { Item } from "@/components/inbox/bucket";
import type { AgingSettings } from "@/lib/aging";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock("@/app/actions/braindump", () => ({ bulkBrainDumpAction: vi.fn().mockResolvedValue({ count: 1 }) }));
// TaskSteps is heavy (its own server actions) — stub it; we only assert it mounts for the open row.
vi.mock("@/components/breakdown/task-steps", () => ({
  TaskSteps: ({ taskId }: { taskId: string }) => <div data-testid="task-steps">{taskId}</div>,
}));

const settings: AgingSettings = { agingThresholdMinutes: 60, demoOverrideSeconds: null, agingHours: 24, overdueHours: 48, wayOverdueHours: 72 };
const mk = (id: string, createdAt: Date): Item => ({
  id, text: `task ${id}`, createdAt, status: "triaged", triagedAt: null, remindedAt: null,
  snoozedUntil: null, taskId: `T${id}`, freshenedAt: null, promptDismissedAt: null,
  breakdownRequestedAt: null, stepsTotal: 2, stepsDone: 0, taskStatus: "active",
  completedAt: null, scheduledAt: null, estMinutes: null,
  steps: [
    { id: `${id}a`, order: 1, text: "first", done: false, estMinutes: 10, subtaskEmoji: "🍳", resumable: false },
    { id: `${id}b`, order: 2, text: "second", done: false, estMinutes: 5, subtaskEmoji: null, resumable: false },
  ],
});
const items = [mk("new", new Date("2026-07-18")), mk("old", new Date("2026-07-01"))]; // newest first

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("LibraryMultistep", () => {
  it("opens the latest (first) row by default and shows its steps", () => {
    render(<LibraryMultistep items={items} voice="plain" now={Date.now()} settings={settings} />);
    expect(screen.getByTestId("task-steps")).toHaveTextContent("Tnew");
  });
  it("single-open: opening another row collapses the first", () => {
    render(<LibraryMultistep items={items} voice="plain" now={Date.now()} settings={settings} />);
    fireEvent.click(screen.getByRole("button", { name: /task old/i }));
    expect(screen.getByTestId("task-steps")).toHaveTextContent("Told");
  });
  it("shows next-step + estimate meta on a collapsed row", () => {
    render(<LibraryMultistep items={items} voice="plain" now={Date.now()} settings={settings} />);
    // The collapsed "old" row shows its next step preview. Scope to the "old"
    // row specifically — "first" is the next-step text for the collapsed row,
    // but a broad query could also match text inside the expanded "new" row's
    // stubbed TaskSteps subtree, so scope with within(row).
    const oldRow = screen.getByRole("button", { name: /task old/i }).closest("li")!;
    expect(within(oldRow).getByText("first", { selector: "*" })).toBeTruthy();
    // Both of "old"'s steps are not-done (10 + 5 min), so the collapsed row's
    // estimate pill reads "≈15 min left" (lib.minLeft) — assert it renders on
    // this row, scoped with within() so it can't match another row's pill.
    expect(within(oldRow).getByText(/≈15\s*min left/)).toBeTruthy();
  });
  it("playful voice shows the row's emoji anchor (first not-done step's subtaskEmoji)", () => {
    render(<LibraryMultistep items={items} voice="playful" now={Date.now()} settings={settings} />);
    // rowEmoji() picks the first not-done step's subtaskEmoji — for both fixture
    // rows that's step "a" ("🍳"). Scope to one row so this can't accidentally
    // match the sibling row's identical emoji.
    const newRow = screen.getByRole("button", { name: /task new/i }).closest("li")!;
    expect(within(newRow).getByText("🍳")).toBeTruthy();
  });
  it("plain voice renders no emoji anchor", () => {
    render(<LibraryMultistep items={items} voice="plain" now={Date.now()} settings={settings} />);
    expect(screen.queryByText("🍳")).toBeNull();
  });
  it("select mode: Select → tick a row → Delete calls bulkBrainDumpAction", async () => {
    const { bulkBrainDumpAction } = await import("@/app/actions/braindump");
    render(<LibraryMultistep items={items} voice="plain" now={Date.now()} settings={settings} />);
    fireEvent.click(screen.getByRole("button", { name: /^select$/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /task new/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));       // bar → confirm
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));       // confirm
    expect(bulkBrainDumpAction).toHaveBeenCalledWith(["new"], "delete");
  });
});
