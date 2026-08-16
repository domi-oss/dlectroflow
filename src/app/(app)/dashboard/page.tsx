import Link from "next/link";
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
      <BackLink from={from} voice={voice} />

      <h1 className="text-2xl font-semibold">{t("nav.dashboard", voice)}</h1>

      <SparkCard initial={spark.quote} />

      {/* #142 — the quiet way onward. This page is where the focus flow lands
          when the queue is empty, and the spark above is the reward for getting
          there; without a way out it would be a cul-de-sac. Deliberately the
          Library and not the Inbox: the Inbox is the fullest screen in the app,
          and landing on a pile straight after clearing your queue swaps the
          reward for a demand. Always shown rather than gated on `?from=focus` —
          "find something else" is a fair offer on any visit, and a link that
          appears only sometimes is a link nobody learns is there. */}
      <Link
        href="/library"
        className="text-muted-foreground hover:text-foreground inline-flex min-h-[44px] items-center text-sm hover:underline"
      >
        {t("focus.done.findSomethingElse", voice)}
      </Link>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label={t("stat.pointsToday", voice)}
          value={data.todayPoints}
          // #109 — the points value is 24px semibold, so WCAG's large-scale 3:1
          // allowance applies and `text-amber-600` measured 3.00:1: it did not
          // pass, it landed exactly ON the threshold, which is not a margin
          // anyone should rely on. amber-700/amber-400 is 4.75:1 / 11.44:1, past
          // even the stricter normal-text bar, so the question stops being close.
          accent="text-amber-700 dark:text-amber-400"
        />
        <Stat
          label={t("stat.currentStreak", voice)}
          value={`${data.currentStreak}${data.currentStreak > 0 && voice === "playful" ? " 🔥" : ""}`}
        />
        <Stat
          label={t("stat.focusMinsToday", voice)}
          value={data.focusMinToday}
        />
        <Stat label={t("stat.stepsToday", voice)} value={data.stepsDoneToday} />
      </div>

      <RoundupCard
        initialRollup={rollup}
        settings={{
          workdayEndTime: settings.workdayEndTime,
          roundupEmailEnabled: settings.roundupEmailEnabled,
          roundupEmail: settings.roundupEmail,
          notifyRoundup: settings.notifyRoundup,
        }}
        emailConfigured={emailConfigured()}
      />

      {/* Best streaks */}
      <section className="rounded-xl border p-4">
        <h2 className="mb-2 text-sm font-semibold">
          {t("heading.bestStreaks", voice)}
        </h2>
        {data.topStreaks.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No completed streaks yet — finish a step on a working day to start
            one.
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
