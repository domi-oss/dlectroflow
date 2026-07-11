import { describe, it, expect, vi, afterEach } from "vitest";
import {
  subscribeNotificationPermission,
  requestNotificationPermission,
} from "./notifications";

// The node test env has no Notification API; stub just enough of it. The
// subscription exists so React can read Notification.permission through
// useSyncExternalStore and re-render after our own permission requests —
// the platform has no reliable cross-browser change event.
function stubNotification(result: NotificationPermission) {
  const notification = {
    permission: result,
    requestPermission: vi.fn().mockResolvedValue(result),
  };
  vi.stubGlobal("Notification", notification);
  vi.stubGlobal("window", { Notification: notification });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("subscribeNotificationPermission", () => {
  it("notifies subscribers after a permission request resolves; unsubscribe stops that", async () => {
    stubNotification("granted");
    const listener = vi.fn();
    const unsubscribe = subscribeNotificationPermission(listener);

    await requestNotificationPermission();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await requestNotificationPermission();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify when notifications are unsupported (nothing changed)", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNotificationPermission(listener);
    await requestNotificationPermission(); // no window in the node env
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
