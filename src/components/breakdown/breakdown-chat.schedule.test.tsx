// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BreakdownChat } from "@/components/breakdown/breakdown-chat";
import { GOOGLE_ACCOUNT_HINT } from "@/components/integrations/google-account-hint";
import type { Proposal } from "@/lib/breakdown";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/components/voice-provider", () => ({ useVoice: () => "plain" }));

const {
  confirmBreakdownMock,
  createBrainDumpItemMock,
  pushStepsToGoogleTasksMock,
} = vi.hoisted(() => ({
  confirmBreakdownMock: vi.fn(),
  createBrainDumpItemMock: vi.fn(),
  pushStepsToGoogleTasksMock: vi.fn(),
}));

vi.mock("@/app/actions/breakdown", () => ({
  confirmBreakdown: confirmBreakdownMock,
}));
vi.mock("@/app/actions/braindump", () => ({
  createBrainDumpItem: createBrainDumpItemMock,
}));
vi.mock("@/app/actions/google-schedule", () => ({
  pushStepsToGoogleTasks: pushStepsToGoogleTasksMock,
}));

const { scheduleViaIcsMock, downloadIcsMock } = vi.hoisted(() => ({
  scheduleViaIcsMock: vi.fn(),
  downloadIcsMock: vi.fn(),
}));
vi.mock("@/app/actions/ics-schedule", () => ({
  scheduleViaIcs: scheduleViaIcsMock,
}));
vi.mock("@/lib/download-ics", () => ({ downloadIcs: downloadIcsMock }));

const proposal: Proposal = {
  parentEmoji: "🗂️",
  steps: [{ text: "Only step", estMinutes: 10, subtaskEmoji: "🌱" }],
};

type GoogleProp = {
  configured: boolean;
  connected: boolean;
  needsReconnect: boolean;
};

beforeEach(() => {
  vi.clearAllMocks();
  confirmBreakdownMock.mockResolvedValue(undefined);
  pushStepsToGoogleTasksMock.mockResolvedValue({
    ok: true,
    scheduled: 0,
    listTitle: "🗓 Reclaim",
  });
  scheduleViaIcsMock.mockResolvedValue({
    ok: true,
    ics: "BEGIN:VCALENDAR",
    icsFilename: "dlectroflow-plan-the-party.ics",
  });
});
afterEach(cleanup);

/**
 * Minimal props for BreakdownChat, then drive it into the confirmed (schedule)
 * view.
 *
 * #118 Phase C — `google` is nullable and the `isGuest` prop is GONE: a null
 * status IS the "no signed-in account" signal, so the two can no longer disagree
 * about who is looking. Pass `google: null` to render as a guest.
 */
async function renderChat(
  overrides: {
    google?: Partial<GoogleProp> | null;
    scheduled?: boolean;
  } = {},
) {
  const google: GoogleProp | null =
    overrides.google === null
      ? null
      : {
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
      google={google}
      scheduled={overrides.scheduled ?? false}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Looks right" }));
  // The universal .ics export is in the confirmed view for everyone, so it is
  // what "we got there" is asserted on — the Google section is the thing under
  // test and may legitimately be absent.
  await waitFor(() =>
    expect(screen.getByText(/add to your calendar/i)).toBeInTheDocument(),
  );
}

describe("BreakdownChat — schedule section (Google-first wording, #22)", () => {
  it("shows a reconnect CTA when Google needs reconnecting", async () => {
    await renderChat({
      google: { configured: true, connected: false, needsReconnect: true },
    });
    const link = screen.getByRole("link", { name: /reconnect google/i });
    expect(link).toHaveAttribute("href", "/api/google/oauth/start");
  });

  it("uses Google-first wording on the send button", async () => {
    await renderChat({
      google: { configured: true, connected: true, needsReconnect: false },
    });
    expect(
      screen.getByRole("button", { name: /send to google tasks/i }),
    ).toBeInTheDocument();
  });

  it("connect copy mentions Reclaim only via the auto-schedule phrase", async () => {
    await renderChat({
      google: { configured: true, connected: false, needsReconnect: false },
    });
    expect(
      screen.getByText(
        /Connect Google Tasks — steps land in your task list, and a Reclaim-synced list is scheduled automatically\./i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /connect google tasks/i }),
    ).toHaveAttribute("href", "/api/google/oauth/start");
  });

  it("sent-confirmation drops the 'sync into Reclaim' framing", async () => {
    pushStepsToGoogleTasksMock.mockResolvedValue({
      ok: true,
      scheduled: 3,
      listTitle: "🗓 Reclaim",
    });
    await renderChat({
      google: { configured: true, connected: true, needsReconnect: false },
    });
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /send to google tasks/i }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Sent 3 tasks to your "🗓 Reclaim" list\./),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/sync into reclaim shortly/i)).toBeNull();
  });

  it("push failure with reason reconnect_required shows the reconnect link", async () => {
    pushStepsToGoogleTasksMock.mockResolvedValue({
      ok: false,
      reason: "reconnect_required",
    });
    await renderChat({
      google: { configured: true, connected: true, needsReconnect: false },
    });
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /send to google tasks/i }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: /reconnect google/i }),
      ).toHaveAttribute("href", "/api/google/oauth/start"),
    );
  });

  it("with Google unconfigured, shows the GOOGLE_CLIENT_ID hint and NO Reclaim controls (#36)", async () => {
    await renderChat({
      google: { configured: false, connected: false, needsReconnect: false },
    });
    expect(
      screen.getByText(/to schedule into Google Tasks/i),
    ).toBeInTheDocument();
    expect(screen.getByText("GOOGLE_CLIENT_ID")).toBeInTheDocument();
    // Reclaim OAuth/MCP scheduling has been removed entirely.
    expect(screen.queryByRole("link", { name: /connect reclaim/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /schedule in reclaim/i }),
    ).toBeNull();
  });

  it("re-routes 'Download calendar (.ics)' through scheduleViaIcs (uniform reward) + downloads", async () => {
    await renderChat({
      google: { configured: true, connected: true, needsReconnect: false },
    });
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /download calendar/i }),
    );
    await waitFor(() =>
      expect(scheduleViaIcsMock).toHaveBeenCalledWith("task-1"),
    );
    expect(downloadIcsMock).toHaveBeenCalledWith(
      "BEGIN:VCALENDAR",
      "dlectroflow-plan-the-party.ics",
    );
  });
});

describe("BreakdownChat — confirmed banner reflects ground truth (not optimistic)", () => {
  it("a freshly-confirmed, never-scheduled task shows the 'not scheduled yet' banner", async () => {
    await renderChat();
    expect(
      screen.getByText(/not scheduled yet — connect a calendar/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/these steps are on your calendar/i)).toBeNull();
  });

  it("a persisted-scheduled task shows the 'scheduled' banner on reopen", async () => {
    await renderChat({ scheduled: true });
    expect(
      screen.getByText(/scheduled — these steps are on your calendar/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not scheduled yet/i)).toBeNull();
  });

  it("flips to 'scheduled' after an in-session Google send succeeds", async () => {
    pushStepsToGoogleTasksMock.mockResolvedValue({
      ok: true,
      scheduled: 1,
      listTitle: "🗓 Reclaim",
    });
    await renderChat({
      google: { configured: true, connected: true, needsReconnect: false },
    });
    expect(screen.getByText(/not scheduled yet/i)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /send to google tasks/i }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/scheduled — these steps are on your calendar/i),
      ).toBeInTheDocument(),
    );
  });
});

// ── #118 Phase C — a nullable status replaces the isGuest prop ─────────────
describe("BreakdownChat — a null status is the guest signal (#118)", () => {
  it("renders no Google section when there is no status", async () => {
    await renderChat({ google: null });
    expect(screen.queryByText(/schedule onto your calendar/i)).toBeNull();
    // The universal .ics export is still there — it needs no integration.
    expect(screen.getByText(/add to your calendar/i)).toBeInTheDocument();
  });

  it("renders the Connect affordance for a member who has not connected", async () => {
    // A signed-in member with no connection gets a status OBJECT
    // (connected: false), not null — which is exactly what makes the Connect
    // affordance reachable for them instead of the silent .ics fallback.
    await renderChat({
      google: { configured: true, connected: false, needsReconnect: false },
    });
    expect(
      screen.getByRole("link", { name: /connect google tasks/i }),
    ).toHaveAttribute("href", "/api/google/oauth/start");
  });
});

// ── #128 — which Google account to connect ───────────────────────────────────
// The inline connect path README names alongside Settings → Integrations, so it
// carries the same guidance: a managed work account can be refused by its own
// administrator at Google's consent step, and we never see it happen.
describe("BreakdownChat — the pick-your-account hint (#128)", () => {
  const hintFor = (link: HTMLElement) =>
    document.getElementById(link.getAttribute("aria-describedby") ?? "");

  it("describes the inline Connect link with the hint", async () => {
    await renderChat({
      google: { configured: true, connected: false, needsReconnect: false },
    });
    const link = screen.getByRole("link", { name: /connect google tasks/i });
    expect(hintFor(link)).toHaveTextContent(GOOGLE_ACCOUNT_HINT);
  });

  it("describes the Reconnect link too", async () => {
    await renderChat({
      google: { configured: true, connected: false, needsReconnect: true },
    });
    const link = screen.getByRole("link", { name: /reconnect google/i });
    expect(hintFor(link)).toHaveTextContent(GOOGLE_ACCOUNT_HINT);
  });

  it("says nothing about accounts once connected", async () => {
    await renderChat({
      google: { configured: true, connected: true, needsReconnect: false },
    });
    expect(screen.queryByText(GOOGLE_ACCOUNT_HINT)).toBeNull();
  });

  it("says nothing about accounts to a guest, who has no Google section at all", async () => {
    await renderChat({ google: null });
    expect(screen.queryByText(GOOGLE_ACCOUNT_HINT)).toBeNull();
  });
});
