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
