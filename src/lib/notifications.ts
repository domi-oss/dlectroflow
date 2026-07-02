// Client-side Web Notifications helpers (browser only).

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (!notificationsSupported()) return "unsupported";
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return "denied";
  return Notification.requestPermission();
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
