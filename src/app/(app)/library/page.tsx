import Link from "next/link";
import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { BrainDumpStatus } from "@/lib/constants";
import {
  libraryBuckets,
  type Item,
  type LibraryBuckets,
} from "@/components/inbox/bucket";
import { t, type StringKey, type Voice } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { DonePill } from "@/components/completion/done-pill";
import { LibraryRows } from "@/components/library/library-rows";
import { LibraryMultistep } from "@/components/library/library-multistep";
import { BackLink } from "@/components/nav/back-link";

// DB-backed, always fresh (mirrors the Inbox — reads live workspace data).
export const dynamic = "force-dynamic";

// The four hub tabs, in the wireframe's left-to-right order. `param` is the
// `?tab=` value the Inbox "see all →" deep-links already point at
// (plated / pantry / sorted / done); `bucket` names the LibraryBuckets field.
const TABS = [
  {
    param: "plated",
    bucket: "singleTask",
    labelKey: "lib.tab.singleTask",
    hintKey: "lib.plated.hint",
  },
  {
    param: "sorted",
    bucket: "multiStep",
    labelKey: "lib.tab.multiStep",
    hintKey: "lib.sorted.hint",
  },
  {
    param: "pantry",
    bucket: "savedLater",
    labelKey: "section.savedLater",
    hintKey: "lib.pantry.hint",
  },
  {
    param: "done",
    bucket: "done",
    labelKey: "nav.done",
    hintKey: "lib.done.hint",
  },
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
  searchParams: Promise<{ tab?: string; from?: string }>;
}) {
  const workspaceId = await currentWorkspaceId();
  const [settings, { tab, from }, rawItems] = await Promise.all([
    getSettings(workspaceId),
    searchParams,
    // Workspace-scoped: only this workspace's items are ever read (owner + guests).
    prisma.brainDumpItem.findMany({
      where: { workspaceId, status: { not: BrainDumpStatus.Archived } },
      orderBy: { createdAt: "desc" },
      include: {
        task: {
          include: {
            steps: {
              orderBy: { order: "asc" },
              // A step is "resumable" if it has an unfinished focus session
              // (started, never ended). Mirrors inbox/page.tsx — batched by
              // Prisma into one query per relation, not a per-step N+1.
              include: {
                focusSessions: {
                  where: { endedAt: null },
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
        },
      },
    }),
  ]);
  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";

  const items: Item[] = rawItems.map(({ task, ...item }) => ({
    ...item,
    stepsTotal: task?.steps.length ?? 0,
    stepsDone: task?.steps.filter((s) => s.done).length ?? 0,
    taskStatus: task?.status ?? null,
    scheduledAt: task?.scheduledAt ?? null,
    estMinutes: item.estMinutes,
    steps:
      task?.steps.map((s) => ({
        id: s.id,
        order: s.order,
        text: s.text,
        done: s.done,
        estMinutes: s.estMinutes,
        subtaskEmoji: s.subtaskEmoji,
        resumable: s.focusSessions.length > 0,
      })) ?? [],
  }));

  // One request-time clock, threaded down so bucketing (savedLater = snoozed
  // into the future) and the "added Xh ago" labels agree (matches layout.tsx).
  const now = Date.now();
  const buckets = libraryBuckets(items, now);
  const active = isTabParam(tab) ? tab : "plated";
  const activeTab = TABS.find((it) => it.param === active)!;
  const rows = buckets[activeTab.bucket];
  // Mirrors the Inbox's own AgingSettings slice (inbox/page.tsx) — the same
  // five fields, threaded down to both LibraryRows and LibraryMultistep so
  // "added Xh ago" aging agrees everywhere in the hub.
  const agingSettings = {
    agingThresholdMinutes: settings.agingThresholdMinutes,
    demoOverrideSeconds: settings.demoOverrideSeconds,
    agingHours: settings.agingHours,
    overdueHours: settings.overdueHours,
    wayOverdueHours: settings.wayOverdueHours,
  };

  return (
    <div className="space-y-4">
      <BackLink from={from} voice={voice} />

      <div>
        <h1 className="text-xl font-semibold">{t("nav.everything", voice)}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {t("lib.intro", voice)}
        </p>
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
                  // #48: on the active (magenta) tab the count chip must stay
                  // WCAG-AA. The old translucent `bg-primary-foreground/20`
                  // lightened the magenta toward the inherited white text
                  // (3.90:1 light / 4.44:1 dark — both < AA 4.5:1). Reuse the
                  // #40 brand tokens as a SOLID pairing instead — opaque
                  // `bg-primary-foreground` with explicit `text-primary`
                  // (5.41:1 light / 6.32:1 dark), mirroring the inactive chip's
                  // solid `secondary` pairing. No new colors introduced.
                  isActive
                    ? "bg-primary-foreground text-primary"
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
        ) : active === "plated" || active === "pantry" ? (
          // In-flight rows are interactive: Start focusing / Complete / Delete,
          // reusing the Inbox's action wiring (see LibraryRows).
          <LibraryRows
            items={rows}
            tab={active}
            voice={voice}
            now={now}
            settings={agingSettings}
          />
        ) : active === "sorted" ? (
          // Multi-step rows inline-expand into their full step breakdown —
          // the whole hub, not just /tasks/[id], can drive focus/complete.
          <LibraryMultistep
            items={rows}
            voice={voice}
            now={now}
            settings={agingSettings}
          />
        ) : (
          // Done is a closure view — the whole row reopens the breakdown.
          <ul className="space-y-2">
            {rows.map((item) => (
              <LibraryRow
                key={item.id}
                item={item}
                tab={active}
                voice={voice}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** A closure-view hub row (Done). Rows that back a Task link into their
 * breakdown ("whole rows reopen the breakdown"); the trailing pill shows step
 * progress. The other tabs render via client components instead: Single-task /
 * Saved for later via <LibraryRows>, Multi-step via <LibraryMultistep>. */
function LibraryRow({
  item,
  tab,
  voice,
}: {
  item: Item;
  tab: "done";
  voice: Voice;
}) {
  const title = (
    <span className="min-w-0 flex-1 break-words">
      {item.text}
      {tab === "done" && item.stepsTotal === 0 && (
        <span className="text-muted-foreground text-xs">
          {" "}
          · {t("lib.aToDo", voice)}
        </span>
      )}
    </span>
  );
  const body = (
    <div
      className={cn(
        "flex items-center justify-between gap-3",
        tab === "done" && "opacity-70",
      )}
    >
      {title}
      <ProgressPill item={item} voice={voice} />
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

/** Step-progress pill for the Done closure view. */
function ProgressPill({ item, voice }: { item: Item; voice: Voice }) {
  return (
    <DonePill voice={voice} done={item.stepsDone} total={item.stepsTotal} />
  );
}
