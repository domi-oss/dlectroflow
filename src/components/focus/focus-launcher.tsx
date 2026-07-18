import Link from "next/link";
import { t, type Voice } from "@/lib/strings";
import type { FocusableStep } from "@/lib/focus-launcher";

/**
 * Presentational list for the /focus launcher. Each row is the next incomplete
 * step of an in-progress task and links into the existing /focus/[stepId]
 * timer; resumable (paused) rows carry a ⏸ badge. When there are no focusable
 * steps (the new-user case) it renders a friendly empty state pointing at the
 * Inbox. Pure presentational — no state, no data access — so it renders in a
 * Server Component and is testable in isolation.
 */
export function FocusLauncher({
  entries,
  voice,
}: {
  entries: FocusableStep[];
  voice: Voice;
}) {
  if (entries.length === 0) {
    return (
      <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
        <p className="text-muted-foreground text-sm">{t("focus.launcher.empty", voice)}</p>
        <Link href="/inbox" className="inline-block text-sm underline">
          {t("nav.inbox", voice)}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">{t("focus.launcher.intro", voice)}</p>
      <ul className="space-y-2">
        {entries.map((e) => (
          <li key={e.stepId}>
            <Link
              href={`/focus/${e.stepId}`}
              className="hover:bg-accent flex flex-col gap-1 rounded-lg border px-3 py-2.5"
            >
              <span className="text-muted-foreground text-xs">{e.taskTitle}</span>
              <span className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 break-words font-medium">
                  {e.subtaskEmoji ? `${e.subtaskEmoji} ` : ""}
                  {e.stepText}
                </span>
                {e.resumable && (
                  <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700">
                    {t("focus.paused", voice)}
                  </span>
                )}
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {e.estMinutes}m
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
