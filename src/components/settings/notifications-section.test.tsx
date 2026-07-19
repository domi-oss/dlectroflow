// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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
    await waitFor(() => expect(requestNotificationPermission).toHaveBeenCalled());
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
