// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LibraryRows } from "@/components/library/library-rows";
import type { Item } from "@/components/inbox/bucket";

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
}));

import {
  ensureFocusStep,
  completeItem,
  deleteBrainDumpItem,
} from "@/app/actions/braindump";

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
    render(<LibraryRows items={[makeItem({ id: "plated-1" })]} tab="plated" voice="plain" now={NOW} />);

    await user.click(screen.getByRole("button", { name: "Start focusing" }));

    await waitFor(() => expect(ensureFocusStep).toHaveBeenCalledWith("plated-1"));
    expect(push).toHaveBeenCalledWith("/focus/step-9");
  });

  it("Complete marks the item done and refreshes", async () => {
    const user = userEvent.setup();
    render(<LibraryRows items={[makeItem({ id: "plated-1" })]} tab="plated" voice="plain" now={NOW} />);

    await user.click(screen.getByRole("button", { name: "Complete" }));

    await waitFor(() => expect(completeItem).toHaveBeenCalledWith("plated-1"));
    expect(refresh).toHaveBeenCalled();
  });

  it("Delete is a two-step confirm (first tap arms, second tap deletes)", async () => {
    const user = userEvent.setup();
    render(<LibraryRows items={[makeItem({ id: "plated-1" })]} tab="plated" voice="plain" now={NOW} />);

    // First tap: arms the confirm — nothing deleted yet, Cancel now visible.
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    // Second tap on the confirming Delete actually deletes.
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteBrainDumpItem).toHaveBeenCalledWith("plated-1"));
  });

  it("Cancel aborts the delete without calling the action", async () => {
    const user = userEvent.setup();
    render(<LibraryRows items={[makeItem({ id: "plated-1" })]} tab="plated" voice="plain" now={NOW} />);

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
        items={[makeItem({ id: "pantry-1", status: "inbox", snoozedUntil: new Date(Date.now() + 86_400_000) })]}
        tab="pantry"
        voice="plain"
        now={NOW}
      />,
    );

    expect(screen.getByRole("button", { name: "Start focusing" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Complete" }));
    await waitFor(() => expect(completeItem).toHaveBeenCalledWith("pantry-1"));
  });
});
