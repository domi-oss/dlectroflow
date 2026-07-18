// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BreakdownChat } from "@/components/breakdown/breakdown-chat";
import type { Proposal } from "@/lib/breakdown";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/components/voice-provider", () => ({ useVoice: () => "plain" }));

vi.mock("@/app/actions/breakdown", () => ({
  confirmBreakdown: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/app/actions/braindump", () => ({
  createBrainDumpItem: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/app/actions/reclaim", () => ({
  scheduleTaskInReclaim: vi.fn().mockResolvedValue({ ok: true, scheduled: 0 }),
}));
vi.mock("@/app/actions/google-schedule", () => ({
  pushStepsToGoogleTasks: vi.fn().mockResolvedValue({ ok: true, scheduled: 0 }),
}));

const { scheduleViaIcsMock, downloadIcsMock } = vi.hoisted(() => ({
  scheduleViaIcsMock: vi.fn(),
  downloadIcsMock: vi.fn(),
}));
vi.mock("@/app/actions/ics-schedule", () => ({ scheduleViaIcs: scheduleViaIcsMock }));
vi.mock("@/lib/download-ics", () => ({ downloadIcs: downloadIcsMock }));

const proposal: Proposal = {
  parentEmoji: "🗂️",
  steps: [
    { text: "First step", estMinutes: 10, subtaskEmoji: "🌱" },
    { text: "Second step", estMinutes: 15, subtaskEmoji: "🚀" },
  ],
};

// Fetch mock: return no body so request() bails early after recording the call —
// we only care about the request payload the buttons send.
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ body: null });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderChat() {
  return render(
    <BreakdownChat
      taskId="task-1"
      title="Plan the party"
      initialProposal={proposal}
      reclaimConnected={false}
      google={{ configured: false, connected: false, needsReconnect: false }}
    />,
  );
}

function lastFeedbackKind(): string {
  const call = fetchMock.mock.calls.at(-1)!;
  const body = JSON.parse((call[1] as RequestInit).body as string);
  return body.feedback.kind;
}

describe("BreakdownChat — quick-reply intents (regression: were swapped)", () => {
  it("'Fewer steps' asks to CONSOLIDATE (too_small)", async () => {
    const user = userEvent.setup();
    renderChat();
    await user.click(screen.getByRole("button", { name: "Fewer steps" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastFeedbackKind()).toBe("too_small");
  });

  it("'More steps' asks to SPLIT (too_big)", async () => {
    const user = userEvent.setup();
    renderChat();
    await user.click(screen.getByRole("button", { name: "More steps" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastFeedbackKind()).toBe("too_big");
  });
});

describe("BreakdownChat — manual step editing", () => {
  it("'Add a step' appends a blank editable step row without calling Claude", async () => {
    const user = userEvent.setup();
    renderChat();
    expect(screen.getAllByLabelText("Step text")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Add a step" }));
    expect(screen.getAllByLabelText("Step text")).toHaveLength(3);
    expect(screen.getAllByLabelText("Step text").at(-1)).toHaveValue("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("step rows expose Remove but NOT 'break down further'", () => {
    renderChat();
    expect(screen.getAllByTitle("Remove this step")).toHaveLength(2);
    expect(screen.queryByTitle(/break this step down further/i)).toBeNull();
  });

  it("step rows expose a drag-to-reorder handle", () => {
    renderChat();
    expect(screen.getAllByTitle("Drag to reorder")).toHaveLength(2);
  });

  it("each step row has an emoji picker trigger", () => {
    renderChat();
    expect(screen.getAllByRole("button", { name: /choose emoji/i })).toHaveLength(2);
  });

  it("'Remove step' removes the last step", async () => {
    const user = userEvent.setup();
    renderChat();
    expect(screen.getAllByLabelText("Step text")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Remove step" }));
    const remaining = screen.getAllByLabelText("Step text");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toHaveValue("First step");
  });

  it("'Back to inbox' removes the row and creates a needs-review inbox item", async () => {
    const { createBrainDumpItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    renderChat();
    // Voice-aware per-step eject control (plain voice → "Back to inbox").
    await user.click(screen.getAllByRole("button", { name: "Back to inbox" })[0]);
    expect(createBrainDumpItem).toHaveBeenCalledWith("First step");
    expect(screen.getAllByLabelText("Step text")).toHaveLength(1);
    expect(screen.getByLabelText("Step text")).toHaveValue("Second step");
  });
});
