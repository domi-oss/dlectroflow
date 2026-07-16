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

const {
  confirmBreakdownMock,
  createBrainDumpItemMock,
  scheduleTaskInReclaimMock,
  pushStepsToGoogleTasksMock,
} = vi.hoisted(() => ({
  confirmBreakdownMock: vi.fn(),
  createBrainDumpItemMock: vi.fn(),
  scheduleTaskInReclaimMock: vi.fn(),
  pushStepsToGoogleTasksMock: vi.fn(),
}));

vi.mock("@/app/actions/breakdown", () => ({ confirmBreakdown: confirmBreakdownMock }));
vi.mock("@/app/actions/braindump", () => ({ createBrainDumpItem: createBrainDumpItemMock }));
vi.mock("@/app/actions/reclaim", () => ({ scheduleTaskInReclaim: scheduleTaskInReclaimMock }));
vi.mock("@/app/actions/google-schedule", () => ({
  pushStepsToGoogleTasks: pushStepsToGoogleTasksMock,
}));

const proposal: Proposal = {
  parentEmoji: "🗂️",
  steps: [{ text: "Only step", estMinutes: 10, subtaskEmoji: "🌱" }],
};

type GoogleProp = { configured: boolean; connected: boolean; needsReconnect: boolean };

beforeEach(() => {
  vi.clearAllMocks();
  confirmBreakdownMock.mockResolvedValue(undefined);
  scheduleTaskInReclaimMock.mockResolvedValue({ ok: true, scheduled: 0 });
  pushStepsToGoogleTasksMock.mockResolvedValue({
    ok: true,
    scheduled: 0,
    listTitle: "🗓 Reclaim",
  });
});
afterEach(cleanup);

/** Minimal props for BreakdownChat, then drive it into the confirmed (schedule) view. */
async function renderChat(
  overrides: { google?: Partial<GoogleProp>; reclaimConnected?: boolean; isGuest?: boolean } = {},
) {
  const google: GoogleProp = {
    configured: false,
    connected: false,
    needsReconnect: false,
    ...overrides.google,
  };
  render(
    <BreakdownChat
      taskId="task-1"
      title="Plan the party"
      initialProposal={proposal}
      reclaimConnected={overrides.reclaimConnected ?? false}
      google={google}
      isGuest={overrides.isGuest ?? false}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Looks right" }));
  await waitFor(() =>
    expect(screen.getByText(/schedule onto your calendar/i)).toBeInTheDocument(),
  );
}

describe("BreakdownChat — schedule section (Google-first wording, #22)", () => {
  it("shows a reconnect CTA when Google needs reconnecting", async () => {
    await renderChat({ google: { configured: true, connected: false, needsReconnect: true } });
    const link = screen.getByRole("link", { name: /reconnect google/i });
    expect(link).toHaveAttribute("href", "/api/google/oauth/start");
  });

  it("uses Google-first wording on the send button", async () => {
    await renderChat({ google: { configured: true, connected: true, needsReconnect: false } });
    expect(screen.getByRole("button", { name: /send to google tasks/i })).toBeInTheDocument();
  });

  it("connect copy mentions Reclaim only via the auto-schedule phrase", async () => {
    await renderChat({ google: { configured: true, connected: false, needsReconnect: false } });
    expect(
      screen.getByText(
        /Connect Google Tasks — steps land in your task list, and a Reclaim-synced list is scheduled automatically\./i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /connect google tasks/i })).toHaveAttribute(
      "href",
      "/api/google/oauth/start",
    );
  });

  it("sent-confirmation drops the 'sync into Reclaim' framing", async () => {
    pushStepsToGoogleTasksMock.mockResolvedValue({
      ok: true,
      scheduled: 3,
      listTitle: "🗓 Reclaim",
    });
    await renderChat({ google: { configured: true, connected: true, needsReconnect: false } });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /send to google tasks/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/Sent 3 tasks to your "🗓 Reclaim" list\./),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/sync into reclaim shortly/i)).toBeNull();
  });

  it("push failure with reason reconnect_required shows the reconnect link", async () => {
    pushStepsToGoogleTasksMock.mockResolvedValue({ ok: false, reason: "reconnect_required" });
    await renderChat({ google: { configured: true, connected: true, needsReconnect: false } });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /send to google tasks/i }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /reconnect google/i })).toHaveAttribute(
        "href",
        "/api/google/oauth/start",
      ),
    );
  });
});
