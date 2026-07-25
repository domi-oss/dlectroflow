// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LibraryRows } from "@/components/library/library-rows";
import type { Item } from "@/components/inbox/bucket";
import type { AgingSettings } from "@/lib/aging";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

// Reuse the Inbox's real, workspace-scoped server actions — mocked here so the
// wiring (which action fires + refresh/navigation) is observable.
vi.mock("@/app/actions/braindump", () => ({
  ensureFocusStep: vi.fn().mockResolvedValue(null),
  completeItem: vi.fn().mockResolvedValue(undefined),
  deleteBrainDumpItem: vi.fn().mockResolvedValue(undefined),
  bulkBrainDumpAction: vi.fn().mockResolvedValue({ count: 1 }),
  setItemEstimate: vi.fn().mockResolvedValue(undefined),
}));

import {
  ensureFocusStep,
  completeItem,
  deleteBrainDumpItem,
  bulkBrainDumpAction,
  setItemEstimate,
} from "@/app/actions/braindump";

const settings: AgingSettings = {
  agingThresholdMinutes: 60,
  demoOverrideSeconds: null,
  agingHours: 24,
  overdueHours: 48,
  wayOverdueHours: 72,
};

function makeItem(overrides: Partial<Item> & { id: string }): Item {
  return {
    text: overrides.id,
    createdAt: new Date(Date.now() - 3600_000),
    status: "triaged",
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

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

const NOW = Date.now();

describe("LibraryRows — per-row actions (reuses Inbox wiring)", () => {
  it("Start focusing ensures a step, then navigates to the focus timer", async () => {
    vi.mocked(ensureFocusStep).mockResolvedValue("step-9");
    const user = userEvent.setup();
    render(
      <LibraryRows
        items={[makeItem({ id: "plated-1" })]}
        tab="plated"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start focusing" }));

    await waitFor(() =>
      expect(ensureFocusStep).toHaveBeenCalledWith("plated-1"),
    );
    expect(push).toHaveBeenCalledWith("/focus/step-9");
  });

  it("Complete marks the item done and refreshes", async () => {
    const user = userEvent.setup();
    render(
      <LibraryRows
        items={[makeItem({ id: "plated-1" })]}
        tab="plated"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );

    await user.click(screen.getByRole("button", { name: "✓ Complete" }));

    await waitFor(() => expect(completeItem).toHaveBeenCalledWith("plated-1"));
    expect(refresh).toHaveBeenCalled();
  });

  it("Delete is a two-step confirm (first tap arms, second tap deletes)", async () => {
    const user = userEvent.setup();
    render(
      <LibraryRows
        items={[makeItem({ id: "plated-1" })]}
        tab="plated"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );

    // First tap: arms the confirm — nothing deleted yet, Cancel now visible.
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    // Second tap on the confirming Delete actually deletes.
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(deleteBrainDumpItem).toHaveBeenCalledWith("plated-1"),
    );
  });

  it("Cancel aborts the delete without calling the action", async () => {
    const user = userEvent.setup();
    render(
      <LibraryRows
        items={[makeItem({ id: "plated-1" })]}
        tab="plated"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    // Back to the armed-again state: the 🗑 Delete control is present once more.
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("the same actions are available on Saved-for-later (pantry) rows", async () => {
    const user = userEvent.setup();
    render(
      <LibraryRows
        items={[
          makeItem({
            id: "pantry-1",
            status: "inbox",
            snoozedUntil: new Date(Date.now() + 86_400_000),
          }),
        ]}
        tab="pantry"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Start focusing" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "✓ Complete" }));
    await waitFor(() => expect(completeItem).toHaveBeenCalledWith("pantry-1"));
  });

  it("pantry rows show no Select button, meta, or estimate pill (unchanged behavior)", () => {
    render(
      <LibraryRows
        items={[
          makeItem({
            id: "pantry-1",
            status: "inbox",
            snoozedUntil: new Date(Date.now() + 86_400_000),
          }),
        ]}
        tab="pantry"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );
    expect(screen.queryByRole("button", { name: /^select$/i })).toBeNull();
    expect(screen.queryByText(/≈\d+ min/)).toBeNull();
    expect(screen.getByText(/wakes/i)).toBeInTheDocument();
  });
});

describe("LibraryRows (plated) — meta, editable estimate, select mode", () => {
  it("shows a 5-min default estimate that persists on edit", () => {
    render(
      <LibraryRows
        items={[makeItem({ id: "a", text: "todo a", estMinutes: null })]}
        tab="plated"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );
    expect(screen.getByText(/≈5 min/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /edit estimate/i }));
    const input = screen.getByRole("spinbutton", { name: /edit estimate/i });
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.blur(input);

    expect(setItemEstimate).toHaveBeenCalledWith("a", 20);
  });

  it("entering a non-numeric or empty value does not persist an estimate", () => {
    render(
      <LibraryRows
        items={[makeItem({ id: "a", text: "todo a", estMinutes: null })]}
        tab="plated"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /edit estimate/i }));
    const input = screen.getByRole("spinbutton", { name: /edit estimate/i });

    // A type="number" input sanitizes an invalid string to "" before onChange
    // fires, so "abc" ends up as val = 0 (Number("") = 0) here too — the
    // val > 0 guard blocks it regardless of whether it arrives as 0 or NaN.
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.blur(input);
    expect(setItemEstimate).not.toHaveBeenCalled();

    // Re-open and clear the field entirely — same "" → 0 path, should not
    // persist a "0 min" estimate.
    fireEvent.click(screen.getByRole("button", { name: /edit estimate/i }));
    const input2 = screen.getByRole("spinbutton", { name: /edit estimate/i });
    fireEvent.change(input2, { target: { value: "" } });
    fireEvent.blur(input2);
    expect(setItemEstimate).not.toHaveBeenCalled();
  });

  // #51 — the title is the dominant row text (larger + heavier); metadata
  // (age/estimate) recedes to text-xs, matching the inbox treatment.
  it("#51: the task title is the dominant row text (text-base font-semibold)", () => {
    render(
      <LibraryRows
        items={[makeItem({ id: "a", text: "todo a" })]}
        tab="plated"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );
    const title = screen.getByText("todo a");
    expect(title.className).toMatch(/text-base/);
    expect(title.className).toMatch(/font-semibold/);
  });

  it("select mode → complete calls bulkBrainDumpAction with the ticked ids", async () => {
    render(
      <LibraryRows
        items={[
          makeItem({ id: "a", text: "todo a", estMinutes: null }),
          makeItem({ id: "b", text: "todo b", estMinutes: 10 }),
        ]}
        tab="plated"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^select$/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /todo a/i }));
    fireEvent.click(screen.getByRole("button", { name: /^✓ complete$/i }));

    await waitFor(() =>
      expect(bulkBrainDumpAction).toHaveBeenCalledWith(["a"], "complete"),
    );
  });
});
