// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { TaskSchedule } from "./task-schedule";
import { GOOGLE_ACCOUNT_HINT } from "@/components/integrations/google-account-hint";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

vi.mock("@/app/actions/google-schedule", () => ({
  pushStepsToGoogleTasks: vi.fn(),
}));

const { scheduleViaIcsMock, downloadIcsMock } = vi.hoisted(() => ({
  scheduleViaIcsMock: vi.fn(),
  downloadIcsMock: vi.fn(),
}));
vi.mock("@/app/actions/ics-schedule", () => ({
  scheduleViaIcs: scheduleViaIcsMock,
}));
vi.mock("@/lib/download-ics", () => ({ downloadIcs: downloadIcsMock }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const connected = { configured: true, connected: true, needsReconnect: false };

describe("TaskSchedule — scheduled indicator (driven by scheduledAt)", () => {
  it("shows 'Scheduled ✓' when scheduledAt is set", () => {
    render(
      <TaskSchedule
        taskId="t1"
        taskTitle="Ship the thing"
        scheduledAt={new Date()}
        google={connected}
        voice="plain"
      />,
    );
    expect(screen.getByText("Scheduled ✓")).toBeInTheDocument();
  });

  it("shows 'Not scheduled yet' when scheduledAt is null", () => {
    render(
      <TaskSchedule
        taskId="t1"
        taskTitle="Ship the thing"
        scheduledAt={null}
        google={connected}
        voice="plain"
      />,
    );
    expect(screen.getByText("Not scheduled yet")).toBeInTheDocument();
  });

  // #109 — a NINTH instance of the bare-`-600` class, found by
  // a11y-class-hygiene rather than by #109's own inventory, which is exactly the
  // argument for having the gate. `text-emerald-600` is 3.45:1 at 14px on the
  // light --background; 14px is normal text, so 4.5:1 applies and it failed.
  // emerald-700/emerald-400 is 5.05:1 / 10.16:1 — the pair row-actions.tsx and
  // inbox-view.tsx already use for the same "scheduled" semantic.
  it("paints the scheduled label with the AA-tuned emerald pair", () => {
    render(
      <TaskSchedule
        taskId="t1"
        taskTitle="Ship the thing"
        scheduledAt={new Date()}
        google={connected}
        voice="plain"
      />,
    );
    const label = screen.getByText("Scheduled ✓");
    expect(label.className).toContain("text-emerald-700");
    expect(label.className).toContain("dark:text-emerald-400");
    expect(label.className).not.toContain("text-emerald-600");
  });
});

describe("TaskSchedule — owner with Google connected", () => {
  it("renders the ready_steps 📅 control and pushes the task's steps via pushStepsToGoogleTasks(taskId)", async () => {
    const { pushStepsToGoogleTasks } =
      await import("@/app/actions/google-schedule");
    (pushStepsToGoogleTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      scheduled: 2,
      listTitle: "Reclaim",
    });
    render(
      <TaskSchedule
        taskId="t1"
        taskTitle="Ship the thing"
        scheduledAt={null}
        google={connected}
        voice="plain"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    // No `scheduleIntent` prop, so 📅 keeps its pre-#106 immediate behaviour and
    // the action falls back to the defaults — the second argument is the absence
    // of a choice, not a choice.
    await waitFor(() =>
      expect(pushStepsToGoogleTasks).toHaveBeenCalledWith("t1", undefined),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("shows an inline error on a non-reconnect failure", async () => {
    const { pushStepsToGoogleTasks } =
      await import("@/app/actions/google-schedule");
    (pushStepsToGoogleTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: "no_reclaim_list",
    });
    render(
      <TaskSchedule
        taskId="t1"
        taskTitle="Ship the thing"
        scheduledAt={null}
        google={connected}
        voice="plain"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    expect(
      await screen.findByText(/Reclaim-synced Google Tasks list/i),
    ).toBeInTheDocument();
  });

  it("reconnect_required swaps the control to the Reconnect link instead of showing an error", async () => {
    const { pushStepsToGoogleTasks } =
      await import("@/app/actions/google-schedule");
    (pushStepsToGoogleTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: "reconnect_required",
    });
    render(
      <TaskSchedule
        taskId="t1"
        taskTitle="Ship the thing"
        scheduledAt={null}
        google={connected}
        voice="plain"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    expect(
      await screen.findByRole("link", { name: /reconnect google/i }),
    ).toHaveAttribute("href", "/api/google/oauth/start");
  });
});

describe("TaskSchedule — owner without a finished Google connection", () => {
  it("renders a Connect Google link when not configured (no live 📅)", () => {
    render(
      <TaskSchedule
        taskId="t1"
        taskTitle="Ship the thing"
        scheduledAt={null}
        google={{ configured: false, connected: false, needsReconnect: false }}
        voice="plain"
      />,
    );
    expect(
      screen.getByRole("link", { name: /connect google/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /schedule/i })).toBeNull();
  });

  it("renders a Reconnect Google link when needsReconnect", () => {
    render(
      <TaskSchedule
        taskId="t1"
        taskTitle="Ship the thing"
        scheduledAt={null}
        google={{ configured: true, connected: false, needsReconnect: true }}
        voice="plain"
      />,
    );
    expect(
      screen.getByRole("link", { name: /reconnect google/i }),
    ).toBeInTheDocument();
  });
});

describe("TaskSchedule — guest / no Google (google=null)", () => {
  it("renders the ICS 'Add to calendar' control, schedules via scheduleViaIcs(taskId), then downloads", async () => {
    scheduleViaIcsMock.mockResolvedValue({
      ok: true,
      ics: "ICSDATA",
      icsFilename: "task.ics",
    });
    render(
      <TaskSchedule
        taskId="t1"
        taskTitle="Ship the thing"
        scheduledAt={null}
        google={null}
        voice="plain"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /add to calendar/i }));
    await waitFor(() => expect(scheduleViaIcsMock).toHaveBeenCalledWith("t1"));
    await waitFor(() =>
      expect(downloadIcsMock).toHaveBeenCalledWith("ICSDATA", "task.ics"),
    );
  });

  it("shows the SCHEDULE_ERROR_MESSAGES dictionary copy for a known failure reason (not the generic fallback)", async () => {
    scheduleViaIcsMock.mockResolvedValue({ ok: false, reason: "not_found" });
    render(
      <TaskSchedule
        taskId="t1"
        taskTitle="Ship the thing"
        scheduledAt={null}
        google={null}
        voice="plain"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /add to calendar/i }));
    // "not_found" → SCHEDULE_ERROR_MESSAGES.not_found, mirroring the Google
    // branch above and inbox-view's own ICS failure path — not the generic
    // "Couldn't build the calendar file." fallback.
    expect(
      await screen.findByText("This task couldn't be found."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/couldn't build the calendar file/i)).toBeNull();
  });

  it("falls back to the generic message for a reason with no dictionary entry", async () => {
    scheduleViaIcsMock.mockResolvedValue({
      ok: false,
      reason: "some_unmapped_reason",
    });
    render(
      <TaskSchedule
        taskId="t1"
        taskTitle="Ship the thing"
        scheduledAt={null}
        google={null}
        voice="plain"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /add to calendar/i }));
    expect(
      await screen.findByText(/couldn't build the calendar file/i),
    ).toBeInTheDocument();
  });
});

// ── #128 — which Google account to connect ───────────────────────────────────
// The task working view renders a single connect control (not one per row), so
// the guidance is visible here — but the control is wrapped in a bordered pill,
// so this surface renders the hint outside it and hands the id to the control.
describe("TaskSchedule — the pick-your-account hint (#128)", () => {
  const hintFor = (link: HTMLElement) =>
    document.getElementById(link.getAttribute("aria-describedby") ?? "");

  it("describes the Connect link with a visible hint", () => {
    render(
      <TaskSchedule
        taskId="t1"
        taskTitle="Ship the thing"
        scheduledAt={null}
        google={{ configured: true, connected: false, needsReconnect: false }}
        voice="plain"
      />,
    );
    const link = screen.getByRole("link", { name: /connect google/i });
    expect(hintFor(link)).toHaveTextContent(GOOGLE_ACCOUNT_HINT);
  });

  it("describes the Reconnect link too", () => {
    render(
      <TaskSchedule
        taskId="t1"
        taskTitle="Ship the thing"
        scheduledAt={null}
        google={{ configured: true, connected: false, needsReconnect: true }}
        voice="plain"
      />,
    );
    const link = screen.getByRole("link", { name: /reconnect google/i });
    expect(hintFor(link)).toHaveTextContent(GOOGLE_ACCOUNT_HINT);
  });

  it("keeps the hint out of the pill so the bordered control stays a control", () => {
    render(
      <TaskSchedule
        taskId="t1"
        taskTitle="Ship the thing"
        scheduledAt={null}
        google={{ configured: true, connected: false, needsReconnect: false }}
        voice="plain"
      />,
    );
    const link = screen.getByRole("link", { name: /connect google/i });
    const hint = screen.getByText(GOOGLE_ACCOUNT_HINT);
    expect(link.closest("span.rounded-md.border")).not.toContainElement(hint);
  });

  it("appears when a mid-flight reconnect_required swaps the control to a link", async () => {
    const { pushStepsToGoogleTasks } =
      await import("@/app/actions/google-schedule");
    (pushStepsToGoogleTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: "reconnect_required",
    });
    render(
      <TaskSchedule
        taskId="t1"
        taskTitle="Ship the thing"
        scheduledAt={null}
        google={connected}
        voice="plain"
      />,
    );
    expect(screen.queryByText(GOOGLE_ACCOUNT_HINT)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    const link = await screen.findByRole("link", { name: /reconnect google/i });
    expect(hintFor(link)).toHaveTextContent(GOOGLE_ACCOUNT_HINT);
  });

  it("says nothing about accounts on the guest .ics control", () => {
    render(
      <TaskSchedule
        taskId="t1"
        taskTitle="Ship the thing"
        scheduledAt={null}
        google={null}
        voice="plain"
      />,
    );
    expect(screen.queryByText(GOOGLE_ACCOUNT_HINT)).toBeNull();
  });

  it("says nothing about accounts once Google is connected", () => {
    render(
      <TaskSchedule
        taskId="t1"
        taskTitle="Ship the thing"
        scheduledAt={null}
        google={connected}
        voice="plain"
      />,
    );
    expect(screen.queryByText(GOOGLE_ACCOUNT_HINT)).toBeNull();
  });
});
