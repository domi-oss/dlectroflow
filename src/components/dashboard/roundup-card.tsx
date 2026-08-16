"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { triggerRollup } from "@/app/actions/rollup";
import { updateRoundupSettings } from "@/app/actions/settings";
import type { Rollup } from "@/lib/rollup";
import {
  notificationPermission,
  requestNotificationPermission,
  subscribeNotificationPermission,
  registerServiceWorker,
  showReminder,
} from "@/lib/notifications";

export type RoundupSettings = {
  workdayEndTime: string;
  roundupEmailEnabled: boolean;
  roundupEmail: string | null;
  // Phase 6 — gates the round-up's *browser notification* (the in-app recap is
  // unaffected). Permission still gates delivery on top of this.
  notifyRoundup: boolean;
};

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** Parse "HH:mm" into today's Date; NaN-safe fallback to 17:00. */
function targetTimeToday(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  const h = m ? Number(m[1]) : 17;
  const min = m ? Number(m[2]) : 0;
  const d = new Date();
  d.setHours(h, min, 0, 0);
  return d.getTime();
}

export function RoundupCard({
  initialRollup,
  settings,
  emailConfigured,
}: {
  initialRollup: Rollup | null;
  settings: RoundupSettings;
  emailConfigured: boolean;
}) {
  const router = useRouter();
  const [rollup, setRollup] = useState<Rollup | null>(initialRollup);
  const [pending, startTransition] = useTransition();
  const [emailNote, setEmailNote] = useState<string | null>(null);

  // Notifications (shared helpers with the inbox). #23 — permission is read
  // through the shared subscription (notified after our own requests) rather
  // than copied into state by a mount effect, matching inbox-view and the
  // settings notifications section.
  const permission = useSyncExternalStore(
    subscribeNotificationPermission,
    notificationPermission,
    () => "default" as const,
  );
  useEffect(() => {
    registerServiceWorker();
  }, []);

  const run = (force: boolean) =>
    startTransition(async () => {
      const res = await triggerRollup({ force });
      setRollup(res.rollup);
      if (res.email.attempted) {
        setEmailNote(
          res.email.ok
            ? "✉️ Round-up emailed."
            : res.email.reason === "disabled"
              ? "Email is enabled but Resend isn't configured on the server."
              : res.email.reason === "no-recipient"
                ? "Add an email address to receive the round-up."
                : "Couldn't send the email — check the Resend key.",
        );
      } else {
        setEmailNote(null);
      }
      router.refresh();
    });

  const fireNow = async () => {
    if (permission === "granted" && settings.notifyRoundup) {
      await showReminder(
        "🌇 Time to wrap up",
        "Here's how your day went — take a look before you clock off.",
      );
    }
    run(true);
  };

  // Workday-end firing: once, when the clock passes the workday-end time,
  // guarded per day via localStorage.
  //
  // #261 — `roundupDemoOverride` used to sit in front of both halves of that
  // sentence, firing ~4s after mount and skipping the daily guard so a demo
  // could be re-run. Both branches are gone with the column, which is what
  // leaves `mountedAt` with no reader: the mount clock existed ONLY to measure
  // the demo countdown from (#23 moved it out of the render for purity, it did
  // not give it a second job).
  const firedRef = useRef(false);
  useEffect(() => {
    const dayKey = `dlectroflow-roundup-fired-${ymd(new Date())}`;
    if (localStorage.getItem(dayKey)) {
      firedRef.current = true;
      return;
    }
    const tick = () => {
      if (firedRef.current) return;
      if (Date.now() < targetTimeToday(settings.workdayEndTime)) return;
      firedRef.current = true;
      localStorage.setItem(dayKey, "1");
      (async () => {
        if (notificationPermission() === "granted" && settings.notifyRoundup) {
          await showReminder(
            "🌇 Time to wrap up",
            "Your end-of-day round-up is ready on the dashboard.",
          );
        }
        // scheduled delivery path: build if missing, email once/day if opted in
        const res = await triggerRollup({ force: false });
        setRollup(res.rollup);
        router.refresh();
      })();
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [settings.workdayEndTime, settings.notifyRoundup, router]);

  return (
    <section className="rounded-xl border bg-gradient-to-br from-orange-50 to-amber-50 p-5 dark:from-orange-950/20 dark:to-amber-950/20">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">🌇 End-of-day round-up</h2>
        <button
          onClick={fireNow}
          disabled={pending}
          className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-xs font-medium hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Writing…" : rollup ? "Regenerate" : "Trigger now"}
        </button>
      </div>

      {rollup ? (
        <div className="space-y-3">
          {rollup.narrative.split(/\n{2,}/).map((p, i) => (
            <p key={i} className="text-[15px] leading-relaxed text-pretty">
              {p}
            </p>
          ))}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>✅ {rollup.stepsDone} steps</span>
            <span>⏱️ {rollup.focusMin} focus mins</span>
            <span>🎯 {rollup.sessions} sessions</span>
            <span>⭐ {rollup.points} points</span>
            {rollup.streakDay > 0 && (
              <span>🔥 {rollup.streakDay}-day streak</span>
            )}
          </div>
          <p className="text-sm text-muted-foreground italic">
            ✨ {rollup.spark}
          </p>
          <Link
            href="/"
            className="inline-block text-sm font-medium text-amber-700 hover:underline dark:text-amber-400"
          >
            Plan tomorrow →
          </Link>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          Your warm recap appears here at {settings.workdayEndTime} — or hit{" "}
          <strong>Trigger now</strong> to preview it.
        </p>
      )}

      {emailNote && (
        <p className="mt-3 text-xs text-muted-foreground">{emailNote}</p>
      )}

      {permission === "default" && (
        <button
          onClick={() => {
            void requestNotificationPermission();
          }}
          className="hover:bg-accent mt-3 w-full rounded-lg border border-dashed px-3 py-2 text-xs"
        >
          🔔 Enable a workday-end desktop reminder
        </button>
      )}

      <RoundupSettingsPanel
        settings={settings}
        emailConfigured={emailConfigured}
      />
    </section>
  );
}

function RoundupSettingsPanel({
  settings,
  emailConfigured,
}: {
  settings: RoundupSettings;
  emailConfigured: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [endTime, setEndTime] = useState(settings.workdayEndTime);
  const [emailOn, setEmailOn] = useState(settings.roundupEmailEnabled);
  const [email, setEmail] = useState(settings.roundupEmail ?? "");

  const save = () =>
    startTransition(async () => {
      await updateRoundupSettings({
        workdayEndTime: endTime,
        roundupEmailEnabled: emailOn,
        roundupEmail: email.trim() || null,
      });
      router.refresh();
    });

  return (
    <details className="mt-4 border-t pt-3 text-sm">
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer list-none text-xs">
        ⚙️ Round-up settings
      </summary>
      <div className="mt-3 space-y-3">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">Workday end</span>
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="border-input rounded-md border px-2 py-1"
            />
          </label>
        </div>

        <div className="space-y-1">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={emailOn}
              onChange={(e) => setEmailOn(e.target.checked)}
              disabled={!emailConfigured}
            />
            Also email me the round-up
          </label>
          {emailOn && (
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={!emailConfigured}
              className="border-input w-64 rounded-md border px-2 py-1 text-sm disabled:opacity-50"
            />
          )}
          {!emailConfigured && (
            <p className="text-muted-foreground text-xs">
              Email is off until <code>RESEND_API_KEY</code> is set on the
              server. In-app + desktop round-up work regardless.
            </p>
          )}
        </div>

        <button
          onClick={save}
          disabled={pending}
          className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </details>
  );
}
