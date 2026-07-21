import { getDashboardData } from "@/lib/rewards";
import { getTodaySpark } from "@/lib/spark";
import { getTodayRollup } from "@/lib/rollup";
import { getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { emailConfigured } from "@/lib/email";
import { SparkCard } from "@/components/dashboard/spark-card";
import { RoundupCard } from "@/components/dashboard/roundup-card";
import { BadgeGrid } from "@/components/dashboard/badge-grid";
import { BackLink } from "@/components/nav/back-link";
import { t, type Voice } from "@/lib/strings";

export const dynamic = "force-dynamic";

const MEDALS = ["🥇", "🥈", "🥉"];

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const workspaceId = await currentWorkspaceId();
  const { from } = await searchParams;
  const [data, spark, rollup, settings] = await Promise.all([
    getDashboardData(workspaceId),
    getTodaySpark(workspaceId),
    getTodayRollup(workspaceId),
    getSettings(workspaceId),
  ]);

  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">{t("nav.dashboard", voice)}</h1>

      <SparkCard initial={spark.quote} />

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t("stat.pointsToday", voice)} value={data.todayPoints} accent="text-amber-600" />
        <Stat
          label={t("stat.currentStreak", voice)}
          value={`${data.currentStreak}${data.currentStreak > 0 && voice === "playful" ? " 🔥" : ""}`}
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
          notifyRoundup: settings.notifyRoundup,
        }}
        emailConfigured={emailConfigured()}
      />

      {/* Best streaks */}
      <section className="rounded-xl border p-4">
        <h2 className="mb-2 text-sm font-semibold">{t("heading.bestStreaks", voice)}</h2>
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

      {/* Badges — the seven named badges, earned + not-earned-yet */}
      <BadgeGrid voice={voice} earned={data.badges} />

      <p className="text-muted-foreground text-xs">
        {t("stat.totalPoints", voice)}: {data.totalPoints}
      </p>

      <BackLink from={from} voice={voice} />
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
