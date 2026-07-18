// Pure decision logic for the Phase 6 daily-review nudge. No browser APIs here
// so it unit-tests cleanly; the client component (review-nudge.tsx) supplies
// `now` + the localStorage day-key state and performs the actual Notification.

/** Validate a strict zero-padded "HH:mm" 24h time string (00-23 : 00-59). */
export function isValidHHmm(s: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

/** localStorage day-key guarding one nudge per calendar day (mirrors round-up). */
export function reviewNudgeDayKey(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `dlectroflow-review-nudge-fired-${y}-${mo}-${da}`;
}

/**
 * Fire / don't-fire decision for the daily-review nudge.
 * Fires only when the preference is on, it hasn't already fired today, and the
 * clock has reached the configured nudge time. Malformed times fall back to
 * 17:00 (NaN-safe, mirroring roundup-card's parser).
 */
export function shouldFireReviewNudge(input: {
  now: Date;
  dailyReviewNudgeTime: string;
  notifyDailyReview: boolean;
  alreadyFiredToday: boolean;
}): boolean {
  const { now, dailyReviewNudgeTime, notifyDailyReview, alreadyFiredToday } =
    input;
  if (!notifyDailyReview) return false;
  if (alreadyFiredToday) return false;
  const m = /^(\d{1,2}):(\d{2})$/.exec(dailyReviewNudgeTime);
  const h = m ? Number(m[1]) : 17;
  const min = m ? Number(m[2]) : 0;
  const target = new Date(now);
  target.setHours(h, min, 0, 0);
  return now.getTime() >= target.getTime();
}
