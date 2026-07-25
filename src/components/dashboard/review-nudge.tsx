"use client";

import { useEffect, useRef } from "react";
import {
  registerServiceWorker,
  notificationPermission,
  showReminder,
} from "@/lib/notifications";
import {
  reviewNudgeDayKey,
  shouldFireReviewNudge,
} from "@/lib/daily-review-nudge";
import { useVoice } from "@/components/voice-provider";
import { t } from "@/lib/strings";

/**
 * Phase 6 — daily-review nudge. Headless client component (modelled on
 * roundup-card's firing effect) mounted in the app shell so it's active while
 * the app is open. When the preference is on and permission is granted, it
 * fires ONE browser notification per day at/after `dailyReviewNudgeTime`,
 * guarded by a localStorage day-key. The service worker's `notificationclick`
 * handler focuses/opens the app at / (the inbox root). No server job: if the app
 * isn't open
 * at the time, it fires on the next open that day. Renders nothing.
 */
export function ReviewNudge({
  notifyDailyReview,
  dailyReviewNudgeTime,
}: {
  notifyDailyReview: boolean;
  dailyReviewNudgeTime: string;
}) {
  const voice = useVoice();
  const firedRef = useRef(false);

  useEffect(() => {
    registerServiceWorker();
    if (!notifyDailyReview) return;
    firedRef.current = false;

    const tick = () => {
      if (firedRef.current) return;
      const now = new Date();
      const dayKey = reviewNudgeDayKey(now);
      const alreadyFiredToday = localStorage.getItem(dayKey) === "1";
      if (alreadyFiredToday) {
        firedRef.current = true;
        return;
      }
      if (notificationPermission() !== "granted") return;
      if (
        !shouldFireReviewNudge({
          now,
          dailyReviewNudgeTime,
          notifyDailyReview,
          alreadyFiredToday,
        })
      ) {
        return;
      }
      firedRef.current = true;
      localStorage.setItem(dayKey, "1");
      void showReminder(
        t("notify.nudgeTitle", voice),
        t("notify.nudgeBody", voice),
      );
    };

    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [notifyDailyReview, dailyReviewNudgeTime, voice]);

  return null;
}
