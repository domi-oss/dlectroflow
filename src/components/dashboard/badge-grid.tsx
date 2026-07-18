import { t, type Voice, type StringKey } from "@/lib/strings";
import { DASHBOARD_BADGE_KEYS, type BadgeKey } from "@/lib/constants";

// Every BadgeKey maps to its voice-aware label. The dashboard shows the set in
// DASHBOARD_BADGE_KEYS (the 7 wireframe badges + the 2 legacy badges surfaced
// per the owner decision on !82).
const BADGE_STRING_KEY: Record<BadgeKey, StringKey> = {
  first_breakdown: "badge.first_breakdown",
  first_schedule: "badge.first_schedule",
  first_focus: "badge.first_focus",
  task_complete: "badge.task_complete",
  streak_5: "badge.streak_5",
  ten_steps_day: "badge.ten_steps_day",
  beat_best_streak: "badge.beat_best_streak",
  inbox_zero: "badge.inbox_zero",
  comeback: "badge.comeback",
};

/**
 * The dashboard badge set (7 wireframe badges + 2 surfaced legacy badges),
 * each shown earned or not-earned-yet. Status is conveyed by more than colour
 * (a 🔒 glyph + reduced opacity + an aria-label / title) per the COGA
 * accessibility baseline.
 */
export function BadgeGrid({ voice, earned }: { voice: Voice; earned: string[] }) {
  const earnedSet = new Set(earned);
  return (
    <section className="rounded-xl border p-4">
      <h2 className="mb-2 text-sm font-semibold">
        Badges{" "}
        <span className="text-muted-foreground text-xs font-normal">
          · faded = not earned yet
        </span>
      </h2>
      <div className="flex flex-wrap gap-2">
        {DASHBOARD_BADGE_KEYS.map((key) => {
          const isEarned = earnedSet.has(key);
          const label = t(BADGE_STRING_KEY[key], voice);
          return (
            <span
              key={key}
              data-badge={key}
              data-earned={isEarned}
              title={isEarned ? "Earned" : "Not earned yet"}
              aria-label={`${label} — ${isEarned ? "earned" : "not earned yet"}`}
              className={
                "rounded-full px-3 py-1 text-xs font-medium " +
                (isEarned
                  ? "bg-secondary text-secondary-foreground"
                  : "bg-secondary/40 text-muted-foreground opacity-50")
              }
            >
              {isEarned ? label : `🔒 ${label}`}
            </span>
          );
        })}
      </div>
    </section>
  );
}
