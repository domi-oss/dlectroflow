// Client-side Web Notifications helpers (browser only).

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (!notificationsSupported()) return "unsupported";
  return Notification.permission;
}

// Listeners notified when Notification.permission may have changed. The
// platform has no reliable cross-browser change event, so we emit after our
// own permission requests; React reads the value via useSyncExternalStore.
const permissionListeners = new Set<() => void>();

export function subscribeNotificationPermission(listener: () => void): () => void {
  permissionListeners.add(listener);
  return () => {
    permissionListeners.delete(listener);
  };
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return "denied";
  const result = await Notification.requestPermission();
  permissionListeners.forEach((listener) => listener());
  return result;
}

/** Register the service worker (idempotent). Returns the registration or null. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

/**
 * Show a reminder. Prefers the service-worker registration (more reliable,
 * survives tab focus changes); falls back to a plain Notification.
 */
export async function showReminder(title: string, body: string) {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  const options: NotificationOptions = {
    body,
    icon: "/favicon.ico",
    tag: "dlectroflow-reminder",
  };
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, options);
      return;
    }
  } catch {
    // fall through to plain Notification
  }
  new Notification(title, options);
}
