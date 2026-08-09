// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotificationsSection } from "@/components/settings/notifications-section";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));

vi.mock("@/app/actions/settings", () => ({
  updateNotificationSettings: vi.fn().mockResolvedValue(undefined),
}));

const requestNotificationPermission = vi.fn().mockResolvedValue("granted");
const notificationPermissionMock = vi.fn(() => "default");
vi.mock("@/lib/notifications", () => ({
  registerServiceWorker: vi.fn().mockResolvedValue(null),
  notificationPermission: () => notificationPermissionMock(),
  requestNotificationPermission: () => requestNotificationPermission(),
  subscribeNotificationPermission: () => () => {},
}));

import { updateNotificationSettings } from "@/app/actions/settings";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  notificationPermissionMock.mockReturnValue("default");
});

const base = {
  notifyRoundup: true,
  notifyAging: true,
  notifyDailyReview: false,
  dailyReviewNudgeTime: "17:00",
  voice: "plain" as const,
};

describe("NotificationsSection", () => {
  it("renders the three per-type toggles seeded from props", () => {
    render(<NotificationsSection {...base} />);
    expect(screen.getByLabelText("End-of-day round-up")).toBeChecked();
    expect(screen.getByLabelText("Aging reminders")).toBeChecked();
    expect(screen.getByLabelText("Daily review nudge")).not.toBeChecked();
  });

  it("toggling round-up off persists the full preference set", async () => {
    const user = userEvent.setup();
    render(<NotificationsSection {...base} />);
    await user.click(screen.getByLabelText("End-of-day round-up"));
    await waitFor(() =>
      expect(updateNotificationSettings).toHaveBeenCalledWith({
        notifyRoundup: false,
        notifyAging: true,
        notifyDailyReview: false,
        dailyReviewNudgeTime: "17:00",
      }),
    );
  });

  it("enabling a toggle while permission is 'default' prompts the browser", async () => {
    const user = userEvent.setup();
    render(<NotificationsSection {...base} />);
    await user.click(screen.getByLabelText("Daily review nudge"));
    await waitFor(() =>
      expect(requestNotificationPermission).toHaveBeenCalled(),
    );
    expect(updateNotificationSettings).toHaveBeenCalledWith({
      notifyRoundup: true,
      notifyAging: true,
      notifyDailyReview: true,
      dailyReviewNudgeTime: "17:00",
    });
  });

  it("does not prompt when granted already", async () => {
    notificationPermissionMock.mockReturnValue("granted");
    const user = userEvent.setup();
    render(<NotificationsSection {...base} />);
    await user.click(screen.getByLabelText("Daily review nudge"));
    await waitFor(() => expect(updateNotificationSettings).toHaveBeenCalled());
    expect(requestNotificationPermission).not.toHaveBeenCalled();
  });

  it("editing the nudge time persists it", async () => {
    const user = userEvent.setup();
    render(<NotificationsSection {...base} notifyDailyReview={true} />);
    const timeInput = screen.getByLabelText("Nudge time");
    await user.clear(timeInput);
    await user.type(timeInput, "08:30");
    await waitFor(() =>
      expect(updateNotificationSettings).toHaveBeenCalledWith(
        expect.objectContaining({ dailyReviewNudgeTime: "08:30" }),
      ),
    );
  });
});

/**
 * #227 — **the switch that stayed flipped on next to the error saying it had
 * not saved.**
 *
 * `persist` already caught and called `markError()`, so this section was half
 * right — and that half is the one that made it worse than silence. `prefs` was
 * never restored, so a rejected write left "couldn't save" sitting beside a
 * switch that still looked on. The user cannot tell which of the two to believe,
 * and the control looks more authoritative than the message.
 *
 * The missing half is a rollback, and it has to be a functional updater guarded
 * on the value THIS attempt set. Unlike the demo and shopping toggles, nothing
 * here disables the control during a save — deliberately, since these are cheap
 * preferences — so two attempts genuinely can interleave, and a slow failure
 * that restored `previous` wholesale would undo a newer success.
 */
describe("NotificationsSection: when a toggle's write fails", () => {
  const roundup = () => screen.getByLabelText("End-of-day round-up");
  const aging = () => screen.getByLabelText("Aging reminders");

  it("puts the switch back where the server still has it", async () => {
    vi.mocked(updateNotificationSettings).mockRejectedValueOnce(
      new Error("offline"),
    );
    const user = userEvent.setup();
    render(<NotificationsSection {...base} />);
    await user.click(roundup()); // true → false, optimistically

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't save/i,
    );
    await waitFor(() => expect(roundup()).toBeChecked());
  });

  it("rolls back the other direction too", async () => {
    vi.mocked(updateNotificationSettings).mockRejectedValueOnce(
      new Error("offline"),
    );
    const user = userEvent.setup();
    render(<NotificationsSection {...base} notifyRoundup={false} />);
    await user.click(roundup()); // false → true, optimistically

    await waitFor(() => expect(roundup()).not.toBeChecked());
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  // One `fireEvent.change` rather than `user.type`: the time field persists on
  // every change event, so typing "08:30" fires several writes and a single
  // `mockRejectedValueOnce` would refuse only the first, letting a later
  // keystroke's success clear the very state under test. A native time picker
  // commits in one change anyway, which is the interaction being modelled.
  it("restores the nudge time, not only the switches", async () => {
    vi.mocked(updateNotificationSettings).mockRejectedValueOnce(
      new Error("offline"),
    );
    render(<NotificationsSection {...base} notifyDailyReview />);
    const timeInput = screen.getByLabelText("Nudge time");
    fireEvent.change(timeInput, { target: { value: "08:30" } });
    expect(timeInput).toHaveValue("08:30");

    await screen.findByRole("alert");
    await waitFor(() => expect(timeInput).toHaveValue("17:00"));
  });

  it("undoes only the field that failed, leaving the others alone", async () => {
    const user = userEvent.setup();
    render(<NotificationsSection {...base} />);

    // Aging off — this one lands.
    await user.click(aging());
    await waitFor(() => expect(aging()).not.toBeChecked());

    // Round-up off — this one is refused.
    vi.mocked(updateNotificationSettings).mockRejectedValueOnce(
      new Error("offline"),
    );
    await user.click(roundup());

    await screen.findByRole("alert");
    await waitFor(() => expect(roundup()).toBeChecked());
    // The successful change must survive the unrelated rollback.
    expect(aging()).not.toBeChecked();
  });

  /**
   * The guard, driven through the UI: a slow FAILING write must not clobber a
   * newer SUCCESSFUL one.
   *
   * Attempt 1 turns round-up off and hangs. Attempt 2 turns it back on and
   * lands. When attempt 1 finally rejects, the field no longer holds the `false`
   * that attempt set, so its rollback must decline to fire. An unguarded
   * `setPrefs(previous)` would flip round-up back off here and leave the page
   * showing the opposite of what the database holds.
   */
  it("lets a newer successful save win over an older failing one", async () => {
    let rejectFirst!: (reason: Error) => void;
    vi.mocked(updateNotificationSettings)
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const user = userEvent.setup();
    render(<NotificationsSection {...base} />);

    await user.click(roundup()); // → false, hangs
    expect(roundup()).not.toBeChecked();
    await user.click(roundup()); // → true, lands
    await waitFor(() => expect(roundup()).toBeChecked());

    rejectFirst(new Error("offline"));

    await screen.findByRole("alert");
    // Still on: the stale rollback owns a `false` nothing is showing any more.
    expect(roundup()).toBeChecked();
  });

  it("says nothing at all when the save works", async () => {
    const user = userEvent.setup();
    render(<NotificationsSection {...base} />);
    await user.click(roundup());

    await waitFor(() => expect(updateNotificationSettings).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(roundup()).not.toBeChecked();
  });
});
