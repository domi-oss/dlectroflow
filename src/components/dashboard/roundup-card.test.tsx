// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
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
// Stand-in for the real permission store: reads are live and a successful
// request notifies subscribers, exactly like src/lib/notifications.ts.
let permissionValue: NotificationPermission | "unsupported" = "granted";
const permissionListeners = new Set<() => void>();
vi.mock("@/lib/notifications", () => ({
  registerServiceWorker: vi.fn().mockResolvedValue(null),
  notificationPermission: () => permissionValue,
  subscribeNotificationPermission: (listener: () => void) => {
    permissionListeners.add(listener);
    return () => permissionListeners.delete(listener);
  },
  requestNotificationPermission: vi.fn(async () => {
    permissionValue = "granted";
    permissionListeners.forEach((listener) => listener());
    return "granted";
  }),
  showReminder: (title: string, body: string) => showReminder(title, body),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.clearAllMocks();
  permissionValue = "granted";
  permissionListeners.clear();
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

// #23 safety net: the permission prompt used to be mirrored into component
// state by a mount effect; it now reads the shared notifications store.
describe("RoundupCard notification-permission prompt", () => {
  const enableButton = () =>
    screen.queryByRole("button", { name: /enable a workday-end desktop/i });

  it("offers the enable-reminders prompt only while permission is 'default'", () => {
    permissionValue = "default";
    render(
      <RoundupCard
        initialRollup={null}
        settings={settings(true)}
        emailConfigured={false}
      />,
    );
    expect(enableButton()).toBeInTheDocument();
  });

  it("hides the prompt once permission has been granted", () => {
    permissionValue = "granted";
    render(
      <RoundupCard
        initialRollup={null}
        settings={settings(true)}
        emailConfigured={false}
      />,
    );
    expect(enableButton()).toBeNull();
  });

  it("drops the prompt after the user grants permission", async () => {
    permissionValue = "default";
    const user = userEvent.setup();
    render(
      <RoundupCard
        initialRollup={null}
        settings={settings(true)}
        emailConfigured={false}
      />,
    );
    await user.click(enableButton()!);
    await waitFor(() => expect(enableButton()).toBeNull());
  });
});

/**
 * #261 — `roundupDemoOverride` is gone. It made the round-up auto-fire ~4s after
 * mount and skipped the once-a-day localStorage guard so a demo could be re-run,
 * and the talk it existed for has happened.
 *
 * What replaces the two specs it had is the assertion that the card is now
 * governed by the workday clock alone. #23's mount-clock refactor is still
 * pinned, from the other side: the card must NOT fire on mount.
 */
describe("RoundupCard workday-end firing (#261 — no demo override)", () => {
  it("does not auto-fire on mount; waits for the workday-end time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 9, 0, 0));
    render(
      <RoundupCard
        initialRollup={null}
        settings={settings(false)}
        emailConfigured={false}
      />,
    );
    expect(triggerRollup).not.toHaveBeenCalled();

    // Well past the ~4s the demo override used to fire at, and past several
    // 5s poll ticks. 23:59 has not arrived, so nothing is due.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(triggerRollup).not.toHaveBeenCalled();
  });

  it("fires once the clock passes the workday-end time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 16, 59, 55));
    render(
      <RoundupCard
        initialRollup={null}
        settings={{ ...settings(false), workdayEndTime: "17:00" }}
        emailConfigured={false}
      />,
    );
    expect(triggerRollup).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(triggerRollup).toHaveBeenCalledTimes(1);
  });

  it("renders no demo note in the settings disclosure", () => {
    render(
      <RoundupCard
        initialRollup={null}
        settings={settings(false)}
        emailConfigured={false}
      />,
    );
    expect(screen.queryByText(/demo: auto-fires on load/)).toBeNull();
    expect(screen.queryByLabelText(/demo/i)).toBeNull();
  });
});
