// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { TaskSchedule } from "./task-schedule";

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
vi.mock("@/app/actions/ics-schedule", () => ({ scheduleViaIcs: scheduleViaIcsMock }));
vi.mock("@/lib/download-ics", () => ({ downloadIcs: downloadIcsMock }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const connected = { configured: true, connected: true, needsReconnect: false };

describe("TaskSchedule — scheduled indicator (driven by scheduledAt)", () => {
  it("shows 'Scheduled ✓' when scheduledAt is set", () => {
    render(<TaskSchedule taskId="t1" scheduledAt={new Date()} google={connected} voice="plain" />);
    expect(screen.getByText("Scheduled ✓")).toBeInTheDocument();
  });

  it("shows 'Not scheduled yet' when scheduledAt is null", () => {
    render(<TaskSchedule taskId="t1" scheduledAt={null} google={connected} voice="plain" />);
    expect(screen.getByText("Not scheduled yet")).toBeInTheDocument();
  });
});

describe("TaskSchedule — owner with Google connected", () => {
  it("renders the ready_steps 📅 control and pushes the task's steps via pushStepsToGoogleTasks(taskId)", async () => {
    const { pushStepsToGoogleTasks } = await import("@/app/actions/google-schedule");
    (pushStepsToGoogleTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      scheduled: 2,
      listTitle: "Reclaim",
    });
    render(<TaskSchedule taskId="t1" scheduledAt={null} google={connected} voice="plain" />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    await waitFor(() => expect(pushStepsToGoogleTasks).toHaveBeenCalledWith("t1"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("shows an inline error on a non-reconnect failure", async () => {
    const { pushStepsToGoogleTasks } = await import("@/app/actions/google-schedule");
    (pushStepsToGoogleTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: "no_reclaim_list",
    });
    render(<TaskSchedule taskId="t1" scheduledAt={null} google={connected} voice="plain" />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    expect(await screen.findByText(/Reclaim-synced Google Tasks list/i)).toBeInTheDocument();
  });

  it("reconnect_required swaps the control to the Reconnect link instead of showing an error", async () => {
    const { pushStepsToGoogleTasks } = await import("@/app/actions/google-schedule");
    (pushStepsToGoogleTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: "reconnect_required",
    });
    render(<TaskSchedule taskId="t1" scheduledAt={null} google={connected} voice="plain" />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    expect(await screen.findByRole("link", { name: /reconnect google/i })).toHaveAttribute(
      "href",
      "/api/google/oauth/start",
    );
  });
});

describe("TaskSchedule — owner without a finished Google connection", () => {
  it("renders a Connect Google link when not configured (no live 📅)", () => {
    render(
      <TaskSchedule
        taskId="t1"
        scheduledAt={null}
        google={{ configured: false, connected: false, needsReconnect: false }}
        voice="plain"
      />,
    );
    expect(screen.getByRole("link", { name: /connect google/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /schedule/i })).toBeNull();
  });

  it("renders a Reconnect Google link when needsReconnect", () => {
    render(
      <TaskSchedule
        taskId="t1"
        scheduledAt={null}
        google={{ configured: true, connected: false, needsReconnect: true }}
        voice="plain"
      />,
    );
    expect(screen.getByRole("link", { name: /reconnect google/i })).toBeInTheDocument();
  });
});

describe("TaskSchedule — guest / no Google (google=null)", () => {
  it("renders the ICS 'Add to calendar' control, schedules via scheduleViaIcs(taskId), then downloads", async () => {
    scheduleViaIcsMock.mockResolvedValue({ ok: true, ics: "ICSDATA", icsFilename: "task.ics" });
    render(<TaskSchedule taskId="t1" scheduledAt={null} google={null} voice="plain" />);
    fireEvent.click(screen.getByRole("button", { name: /add to calendar/i }));
    await waitFor(() => expect(scheduleViaIcsMock).toHaveBeenCalledWith("t1"));
    await waitFor(() => expect(downloadIcsMock).toHaveBeenCalledWith("ICSDATA", "task.ics"));
  });

  it("shows an inline error on ICS failure", async () => {
    scheduleViaIcsMock.mockResolvedValue({ ok: false, reason: "not_found" });
    render(<TaskSchedule taskId="t1" scheduledAt={null} google={null} voice="plain" />);
    fireEvent.click(screen.getByRole("button", { name: /add to calendar/i }));
    expect(await screen.findByText(/couldn't build the calendar file/i)).toBeInTheDocument();
  });
});
