// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  RoundupCard,
  type RoundupSettings,
} from "@/components/dashboard/roundup-card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const triggerRollup = vi.fn().mockResolvedValue({
  rollup: null,
  email: { attempted: false },
});
vi.mock("@/app/actions/rollup", () => ({
  triggerRollup: () => triggerRollup(),
}));
vi.mock("@/app/actions/settings", () => ({
  updateRoundupSettings: vi.fn().mockResolvedValue(undefined),
}));

const showReminder = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/notifications", () => ({
  registerServiceWorker: vi.fn().mockResolvedValue(null),
  notificationPermission: () => "granted",
  requestNotificationPermission: vi.fn().mockResolvedValue("granted"),
  showReminder: (title: string, body: string) => showReminder(title, body),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.clearAllMocks();
  // Freeze the wall clock to a fixed morning time so the scheduled workday-end
  // effect (RoundupCard's mount `tick()`) never fires during these tests — it
  // only fires once `Date.now() >= workdayEndTime`. Fake *only* Date so that
  // userEvent and waitFor keep using real setTimeout/setInterval.
  // Regression guard for #42: a "23:59" workday end is in the *past* during the
  // final minute of the day, which made the scheduled path fire an extra
  // notification and flaked the "fires exactly once" assertion.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 0, 15, 9, 0, 0));
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  });
});

const settings = (notifyRoundup: boolean): RoundupSettings => ({
  // Workday end is after the frozen 09:00 test clock, so the scheduled mount
  // tick never fires — these tests exercise only the manual "Trigger now" path.
  workdayEndTime: "23:59",
  roundupDemoOverride: false,
  roundupEmailEnabled: false,
  roundupEmail: null,
  notifyRoundup,
});

describe("RoundupCard notifyRoundup gating", () => {
  it("skips the browser notification when notifyRoundup is false", async () => {
    const user = userEvent.setup();
    render(
      <RoundupCard
        initialRollup={null}
        settings={settings(false)}
        emailConfigured={false}
      />,
    );
    await user.click(screen.getByRole("button", { name: /trigger now/i }));
    await waitFor(() => expect(triggerRollup).toHaveBeenCalled());
    expect(showReminder).not.toHaveBeenCalled();
  });

  it("fires the browser notification when notifyRoundup is true (permission granted)", async () => {
    const user = userEvent.setup();
    render(
      <RoundupCard
        initialRollup={null}
        settings={settings(true)}
        emailConfigured={false}
      />,
    );
    await user.click(screen.getByRole("button", { name: /trigger now/i }));
    await waitFor(() => expect(showReminder).toHaveBeenCalledTimes(1));
  });
});
