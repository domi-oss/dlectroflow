"use client";

import {
  useEffect,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { updateNotificationSettings } from "@/app/actions/settings";
import {
  registerServiceWorker,
  notificationPermission,
  requestNotificationPermission,
  subscribeNotificationPermission,
} from "@/lib/notifications";
import { t, type Voice } from "@/lib/strings";
import {
  useSaveStatus,
  SaveIndicator,
} from "@/components/settings/use-save-status";

type Prefs = {
  notifyRoundup: boolean;
  notifyAging: boolean;
  notifyDailyReview: boolean;
  dailyReviewNudgeTime: string;
};

/**
 * Phase 6 — per-type notification toggles (owner decision: separate, not a
 * single master switch). Each is gated at *delivery* time by the browser
 * Notification permission; enabling one while permission is still "default"
 * prompts for it (same UX as roundup-card). The toggles here only persist the
 * preference — the actual firing lives in roundup-card / inbox-view / the
 * daily-review nudge.
 */
export function NotificationsSection({
  notifyRoundup,
  notifyAging,
  notifyDailyReview,
  dailyReviewNudgeTime,
  voice,
}: Prefs & { voice: Voice }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const { status, markSaving, markSaved, markError } = useSaveStatus();

  const [prefs, setPrefs] = useState<Prefs>({
    notifyRoundup,
    notifyAging,
    notifyDailyReview,
    dailyReviewNudgeTime,
  });

  // Permission is read through the shared subscription (notified after our own
  // requests) so no setState-in-effect is needed to keep the UI in sync — same
  // pattern as inbox-view.
  const permission = useSyncExternalStore(
    subscribeNotificationPermission,
    notificationPermission,
    () => "default" as const,
  );
  useEffect(() => {
    registerServiceWorker();
  }, []);

  const persist = (next: Prefs) =>
    startTransition(async () => {
      markSaving();
      try {
        await updateNotificationSettings(next);
        markSaved();
        router.refresh();
      } catch {
        markError();
      }
    });

  const setToggle = (key: keyof Prefs, value: boolean) => {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    // Enabling any type while permission is still unasked prompts for it; the
    // subscription updates `permission` once the browser responds.
    if (value && permission === "default") {
      void requestNotificationPermission();
    }
    persist(next);
  };

  const setTime = (value: string) => {
    const next = { ...prefs, dailyReviewNudgeTime: value };
    setPrefs(next);
    persist(next);
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">{t("notify.heading", voice)}</h2>
        <SaveIndicator status={status} voice={voice} />
      </div>
      <p className="text-muted-foreground text-sm">
        {t("notify.intro", voice)}
      </p>

      {permission === "default" && (
        <button
          type="button"
          onClick={() => void requestNotificationPermission()}
          className="hover:bg-accent w-full rounded-lg border border-dashed px-3 py-2 text-sm"
        >
          {t("notify.enable", voice)}
        </button>
      )}
      {permission === "denied" && (
        <p className="text-muted-foreground text-xs">
          {t("notify.blocked", voice)}
        </p>
      )}

      <div className="space-y-4">
        <Toggle
          label={t("notify.roundup", voice)}
          hint={t("notify.roundupHint", voice)}
          checked={prefs.notifyRoundup}
          onChange={(v) => setToggle("notifyRoundup", v)}
        />
        <Toggle
          label={t("notify.aging", voice)}
          hint={t("notify.agingHint", voice)}
          checked={prefs.notifyAging}
          onChange={(v) => setToggle("notifyAging", v)}
        />
        <div>
          <Toggle
            label={t("notify.dailyReview", voice)}
            hint={t("notify.dailyReviewHint", voice)}
            checked={prefs.notifyDailyReview}
            onChange={(v) => setToggle("notifyDailyReview", v)}
          />
          <label className="mt-2 flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">
              {t("notify.nudgeTime", voice)}
            </span>
            <input
              type="time"
              value={prefs.dailyReviewNudgeTime}
              disabled={!prefs.notifyDailyReview}
              onChange={(e) => setTime(e.target.value)}
              className="border-input w-32 rounded-md border px-2 py-1 disabled:opacity-50"
            />
          </label>
        </div>
      </div>
    </section>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div>
      <label className="flex items-center gap-2 font-medium">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
      <p className="text-muted-foreground ml-6 text-xs">{hint}</p>
    </div>
  );
}
