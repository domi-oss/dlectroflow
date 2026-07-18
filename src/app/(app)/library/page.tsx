import Link from "next/link";
import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { BrainDumpStatus } from "@/lib/constants";
import { libraryBuckets, type Item, type LibraryBuckets } from "@/components/inbox/bucket";
import { t, type StringKey, type Voice } from "@/lib/strings";
import { cn } from "@/lib/utils";

// DB-backed, always fresh (mirrors the Inbox — reads live workspace data).
export const dynamic = "force-dynamic";

// The four hub tabs, in the wireframe's left-to-right order. `param` is the
// `?tab=` value the Inbox "see all →" deep-links already point at
// (plated / pantry / sorted / done); `bucket` names the LibraryBuckets field.
const TABS = [
  { param: "plated", bucket: "singleTask", labelKey: "lib.tab.singleTask", hintKey: "lib.plated.hint" },
  { param: "pantry", bucket: "savedLater", labelKey: "section.savedLater", hintKey: "lib.pantry.hint" },
  { param: "sorted", bucket: "multiStep", labelKey: "lib.tab.multiStep", hintKey: "lib.sorted.hint" },
  { param: "done", bucket: "done", labelKey: "nav.done", hintKey: "lib.done.hint" },
] as const satisfies ReadonlyArray<{
  param: string;
  bucket: keyof LibraryBuckets;
  labelKey: StringKey;
  hintKey: StringKey;
}>;

type TabParam = (typeof TABS)[number]["param"];

function isTabParam(v: string | undefined): v is TabParam {
  return TABS.some((tab) => tab.param === v);
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const workspaceId = await currentWorkspaceId();
  const [settings, { tab }, rawItems] = await Promise.all([
    getSettings(workspaceId),
    searchParams,
    // Workspace-scoped: only this workspace's items are ever read (owner + guests).
    prisma.brainDumpItem.findMany({
      where: { workspaceId, status: { not: BrainDumpStatus.Archived } },
      orderBy: { createdAt: "desc" },
      include: { task: { include: { steps: { orderBy: { order: "asc" } } } } },
    }),
  ]);
  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";

  const items: Item[] = rawItems.map(({ task, ...item }) => ({
    ...item,
    stepsTotal: task?.steps.length ?? 0,
    stepsDone: task?.steps.filter((s) => s.done).length ?? 0,
    taskStatus: task?.status ?? null,
    scheduledAt: task?.scheduledAt ?? null,
    steps:
      task?.steps.map((s) => ({
        id: s.id,
        order: s.order,
        text: s.text,
        done: s.done,
        estMinutes: s.estMinutes,
        subtaskEmoji: s.subtaskEmoji,
        resumable: false,
      })) ?? [],
  }));

  // One request-time clock, threaded down so bucketing (savedLater = snoozed
  // into the future) and the "added Xh ago" labels agree (matches layout.tsx).
  const now = Date.now();
  const buckets = libraryBuckets(items, now);
  const active = isTabParam(tab) ? tab : "plated";
  const activeTab = TABS.find((it) => it.param === active)!;
  const rows = buckets[activeTab.bucket];

  return (
    <div className="space-y-4">
      <Link
        href="/inbox"
        className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
      >
        {t("action.back", voice)}
      </Link>

      <div>
        <h1 className="text-xl font-semibold">{t("nav.everything", voice)}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("lib.intro", voice)}</p>
      </div>

      {/* Tabs — Links that set ?tab=, so each tab is deep-linkable (the Inbox's
          "see all →" links land straight on the matching one). */}
      <nav aria-label="Library tabs" className="flex flex-wrap gap-2">
        {TABS.map((it) => {
          const isActive = it.param === active;
          const count = buckets[it.bucket].length;
          return (
            <Link
              key={it.param}
              href={`/library?tab=${it.param}`}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm",
                isActive
                  ? "bg-primary text-primary-foreground border-primary"
                  : "hover:bg-accent",
              )}
            >
              <span>{t(it.labelKey, voice)}</span>
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-xs",
                  isActive
                    ? "bg-primary-foreground/20"
                    : "bg-secondary text-secondary-foreground",
                )}
              >
                {count}
              </span>
            </Link>
          );
        })}
      </nav>

      <section aria-labelledby="lib-panel-heading" className="space-y-3">
        <p id="lib-panel-heading" className="text-muted-foreground text-xs">
          {t(activeTab.hintKey, voice)}
        </p>
        {rows.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm">
            {t("bucket.empty", voice)}
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((item) => (
              <LibraryRow key={item.id} item={item} tab={active} voice={voice} now={now} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** A single hub row. Rows that back a Task link into its breakdown ("whole rows
 * reopen the breakdown"); the trailing meta/pill matches the tab. */
function LibraryRow({
  item,
  tab,
  voice,
  now,
}: {
  item: Item;
  tab: TabParam;
  voice: Voice;
  now: number;
}) {
  const meta = <RowMeta item={item} tab={tab} voice={voice} now={now} />;
  const title = (
    <span className="min-w-0 flex-1 break-words">
      {item.text}
      {tab === "done" && item.stepsTotal === 0 && (
        <span className="text-muted-foreground text-xs"> · {t("lib.aToDo", voice)}</span>
      )}
    </span>
  );
  const body = (
    <div className={cn("flex items-center justify-between gap-3", tab === "done" && "opacity-70")}>
      {title}
      {meta}
    </div>
  );

  // A row backed by a Task opens its breakdown; otherwise it's a static row.
  return (
    <li className="rounded-lg border px-4 py-3 text-sm">
      {item.taskId ? (
        <Link href={`/tasks/${item.taskId}`} className="block hover:underline">
          {body}
        </Link>
      ) : (
        body
      )}
    </li>
  );
}

/** Trailing indicator per tab: age (plated), wake time (pantry), or a progress
 * pill (sorted / done). */
function RowMeta({
  item,
  tab,
  voice,
  now,
}: {
  item: Item;
  tab: TabParam;
  voice: Voice;
  now: number;
}) {
  if (tab === "plated") {
    return (
      <span className="text-muted-foreground shrink-0 text-xs">
        {t("lib.added", voice)} {formatAgo(now - new Date(item.createdAt).getTime())}
      </span>
    );
  }
  if (tab === "pantry") {
    return (
      <span className="text-muted-foreground shrink-0 text-xs">
        {item.snoozedUntil
          ? `${t("lib.wakes", voice)} ${formatWake(item.snoozedUntil)}`
          : null}
      </span>
    );
  }
  if (tab === "sorted") {
    const notScheduled = item.scheduledAt == null;
    return (
      <span
        className={cn(
          "shrink-0 rounded-full border px-2 py-0.5 text-xs",
          notScheduled ? "text-muted-foreground" : "border-green-700 text-green-700",
        )}
      >
        {item.stepsDone}/{item.stepsTotal} {t("progress.done", voice)}
        {notScheduled && <> · {t("lib.notScheduled", voice)}</>}
      </span>
    );
  }
  // done
  return (
    <span className="shrink-0 rounded-full border border-green-700 px-2 py-0.5 text-xs text-green-700">
      {item.stepsTotal > 0
        ? `✅ ${item.stepsDone}/${item.stepsTotal} ${t("progress.done", voice)}`
        : `✅ ${t("progress.done", voice)}`}
    </span>
  );
}

/** Compact relative age, e.g. "2h ago". Mirrors the Inbox's formatter. */
function formatAgo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Wake time for a saved-for-later row, e.g. "Mon 08:00". */
function formatWake(when: Date): string {
  return new Date(when).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
