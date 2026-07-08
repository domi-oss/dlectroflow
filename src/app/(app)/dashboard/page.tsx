import Link from "next/link";
import { getDashboardData } from "@/lib/rewards";
import { getTodaySpark } from "@/lib/spark";
import { getTodayRollup } from "@/lib/rollup";
import { getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { emailConfigured } from "@/lib/email";
import { SparkCard } from "@/components/dashboard/spark-card";
import { RoundupCard } from "@/components/dashboard/roundup-card";
import { t, type Voice } from "@/lib/strings";

export const dynamic = "force-dynamic";

const BADGE_LABELS: Record<string, string> = {
  first_breakdown: "🧩 First breakdown",
  first_schedule: "📅 First schedule",
  streak_5: "🔥 5-day streak",
  ten_steps_day: "🔟 10 steps in a day",
  beat_best_streak: "🏆 Beat your best streak",
};

const MEDALS = ["🥇", "🥈", "🥉"];

export default async function DashboardPage() {
  const workspaceId = await currentWorkspaceId();
  const [data, spark, rollup, settings] = await Promise.all([
    getDashboardData(workspaceId),
    getTodaySpark(workspaceId),
    getTodayRollup(workspaceId),
    getSettings(workspaceId),
  ]);

  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Dashboard</h1>

      <SparkCard initial={spark.quote} />

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t("stat.pointsToday", voice)} value={data.todayPoints} accent="text-amber-600" />
        <Stat
          label={t("stat.currentStreak", voice)}
          value={`${data.currentStreak}${data.currentStreak > 0 ? " 🔥" : ""}`}
        />
        <Stat label={t("stat.focusMinsToday", voice)} value={data.focusMinToday} />
        <Stat label={t("stat.stepsToday", voice)} value={data.stepsDoneToday} />
      </div>

      <RoundupCard
        initialRollup={rollup}
        settings={{
          workdayEndTime: settings.workdayEndTime,
          roundupDemoOverride: settings.roundupDemoOverride,
          roundupEmailEnabled: settings.roundupEmailEnabled,
          roundupEmail: settings.roundupEmail,
        }}
        emailConfigured={emailConfigured()}
      />

      {/* Best streaks */}
      <section className="rounded-xl border p-4">
        <h2 className="mb-2 text-sm font-semibold">🏆 Best streaks</h2>
        {data.topStreaks.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No completed streaks yet — finish a step on a working day to start one.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {data.topStreaks.map((s, i) => (
              <li key={i} className="flex items-center gap-2">
                <span>{MEDALS[i] ?? "•"}</span>
                <span className="font-medium">{s.length} days</span>
                <span className="text-muted-foreground text-xs">
                  · ended {s.endedAt.toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Badges */}
      {data.badges.length > 0 && (
        <section className="rounded-xl border p-4">
          <h2 className="mb-2 text-sm font-semibold">Badges</h2>
          <div className="flex flex-wrap gap-2">
            {data.badges.map((b) => (
              <span
                key={b}
                className="bg-secondary text-secondary-foreground rounded-full px-3 py-1 text-xs font-medium"
              >
                {BADGE_LABELS[b] ?? b}
              </span>
            ))}
          </div>
        </section>
      )}

      <p className="text-muted-foreground text-xs">
        {t("stat.totalPoints", voice)}: {data.totalPoints}
      </p>

      <Link href="/inbox" className="text-muted-foreground inline-block text-sm hover:underline">
        ← inbox
      </Link>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border p-3">
      <div className={`text-2xl font-semibold ${accent ?? ""}`}>{value}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}
