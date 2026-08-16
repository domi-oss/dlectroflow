import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId, currentUser } from "@/lib/workspace";
import { getGoogleStatus } from "@/lib/google";
import { identityFor } from "@/lib/identity";
import {
  emptyInboxIsNewAccount,
  workspaceHasHistory,
} from "@/lib/workspace-history";
import { BrainDumpStatus } from "@/lib/constants";
import { InboxView } from "@/components/inbox/inbox-view";
import { firstResumableStep } from "@/components/inbox/resume-step";
import { openSessionRemainingSec } from "@/lib/focus-timer-clock";
import { mergePersistedIntent } from "@/lib/scheduling/intent";
import type { ScheduleIntent } from "@/lib/scheduling/types";
import { shoppingSummaryVisible } from "@/lib/shopping-summary";
import { STATUS_BANNER_TONE } from "@/lib/status-banner-style";
import { cn } from "@/lib/utils";

// DB-backed, always fresh.
export const dynamic = "force-dynamic";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{
    google?: string;
    reason?: string;
  }>;
}) {
  const workspaceId = await currentWorkspaceId();
  // One request-time clock — also snapshots each step's persisted remaining
  // time (#27 follow-up), matching the Library page's same-request approach.
  // eslint-disable-next-line react-hooks/purity -- async Server Component: this runs once per request on the server, not in a compiler-memoised client render.
  const now = Date.now();
  // #118 — ONE identity resolution, awaited inside the batch. isOwnerRequest()
  // is implemented in terms of currentUser(), so this is the same query it made,
  // and chaining the status off it keeps page-load latency flat.
  const mePromise = currentUser();
  // #199 — resolved as its own promise so the shopping-summary reads can be chained
  // off it INSIDE the batch, exactly as `googleStatus` is chained off `mePromise`
  // below and for the same stated reason: page-load latency stays flat. Chaining
  // after the whole `Promise.all` would have made those reads wait on
  // `brainDumpItem.findMany` and its nested task/step/session includes, which they do
  // not depend on — a real sequential round-trip added to every request for a
  // workspace with the feature on (Duo review, !295).
  const settingsPromise = getSettings(workspaceId);
  const [rawItems, settings, sp, me, googleStatus, shoppingSummary] =
    await Promise.all([
      prisma.brainDumpItem.findMany({
        where: { workspaceId, status: { not: BrainDumpStatus.Archived } },
        orderBy: { createdAt: "desc" },
        include: {
          task: {
            include: {
              steps: {
                orderBy: { order: "asc" },
                // #27 follow-up — fetch ANY open session (paused or actively
                // running); `resumable` is derived from `pausedAt` below
                // (an open-but-never-paused session is stale — e.g. a closed
                // tab mid-countdown — and isn't offered as resumable), and the
                // full row also feeds the step's effective remaining time
                // (task-remaining.ts) for the row's total + active-step pills.
                // Batched by Prisma into one query per relation, so this is
                // not a per-step N+1.
                include: {
                  focusSessions: {
                    where: { endedAt: null },
                    orderBy: { startedAt: "desc" },
                    take: 1,
                    select: {
                      startedAt: true,
                      pausedAt: true,
                      accumulatedPausedMs: true,
                      plannedMin: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
      settingsPromise,
      searchParams,
      mePromise,
      // Resolved for the ACTING user, in parallel so page-load latency stays flat
      // (Duo review: this was once a serial round-trip after the Promise.all). A
      // guest/anonymous caller is passed null, which short-circuits before any
      // query at all — getAuth() used to be an upsert, so an anonymous page load
      // MATERIALISED the credential row (#118).
      mePromise.then((u) => getGoogleStatus(u ? u.id : null)),
      // #199 — the shopping-list summary line.
      //
      // Two reads, and only when the feature is on AND this is not the first-run
      // preview (Duo review, !295 — the result used to be computed and then thrown
      // away one branch later). An ordinary workspace pays nothing for a feature it has
      // not switched on, which is the whole promise of the toggle; and the preview shows
      // the inbox as a brand-new workspace would see it, so a brand-new workspace's
      // shopping list is empty by definition and the answer cannot change anything. The
      // same page short-circuits `workspaceHasHistory()` on `firstRunPreview` for that
      // reason.
      //
      // The COUNT is read from the items, not from the summary row — the row stores
      // whether to show a summary and never how many, so a missed sync can only ever
      // hide the line, never mis-state it. `shoppingSummaryVisible` folds the four
      // reasons to show nothing into one nullable answer.
      settingsPromise.then(async (st) => {
        if (!st.shoppingList || st.firstRunPreview) return null;
        const [row, remaining] = await Promise.all([
          prisma.shoppingSummary.findUnique({ where: { workspaceId } }),
          prisma.shoppingItem.count({
            where: { workspaceId, done: false, savedForLater: false },
          }),
        ]);
        return shoppingSummaryVisible({ row, remaining });
      }),
    ]);
  // #118 Phase C — the ACTING ACCOUNT's own status, resolved once at the server
  // boundary (S1 seam, #34). Was `owner ? googleStatus : null`, which is what
  // made a member's 📅 fall back to .ics even when they had their own
  // connection. getGoogleStatus() already returns the not-connected shape
  // without a query for a caller with no account, so `null` here means exactly
  // one thing: nobody is signed in.
  const google = me ? googleStatus : null;

  const items = rawItems.map(({ task, ...item }) => ({
    ...item,
    stepsTotal: task?.steps.length ?? 0,
    stepsDone: task?.steps.filter((s) => s.done).length ?? 0,
    taskStatus: task?.status ?? null,
    // #44 — the task's own note, for the row-level disclosure. `task` is the
    // workspace-scoped relation already loaded here, so this costs no query.
    notes: task?.notes ?? null,
    // #186 — the ITEM's own note, which is a different column and live at a
    // different time: it is what an untriaged row carries (written at capture by
    // #179's inline syntax) until triage copies it onto the task.
    //
    // Named apart from `notes` rather than merged, and the spread above is
    // exactly why: `...item` already brings `BrainDumpItem.notes` in under the
    // name `notes`, which the line above then OVERWRITES with the task's. One
    // name for two columns meant the item's was silently unreachable here.
    // `liveNote` is what decides between them at the point of use.
    itemNotes: item.notes,
    completedAt: item.completedAt,
    scheduledAt: task?.scheduledAt ?? null,
    estMinutes: item.estMinutes,
    steps:
      task?.steps.map((s) => {
        const session = s.focusSessions[0] ?? null;
        return {
          id: s.id,
          order: s.order,
          text: s.text,
          done: s.done,
          estMinutes: s.estMinutes,
          subtaskEmoji: s.subtaskEmoji,
          // #44 — this row expands into the same <TaskSteps> the task page
          // renders, so the note travels with the step rather than the two
          // surfaces disagreeing about whether a step has one.
          notes: s.notes,
          resumable: session?.pausedAt != null,
          openRemainingSec: openSessionRemainingSec(session, now),
        };
      }) ?? [],
  }));

  // #106 — the Schedule menu's prefill for every row that can open it, built
  // HERE rather than fetched per row: `rawItems` already carries each task's
  // three intent columns and its steps, so the alternative is one server-action
  // round trip per multi-step row on every inbox load. Only tasks WITH steps can
  // reach `ready_steps`, so nothing else needs an entry.
  //
  // Gated on `me`, mirroring `google` above rather than on the role: #118 Phase C
  // gave members their own Google connection, so a member reaches the Schedule
  // menu too and needs the same prefill. Keeping this owner-only would have left
  // a member's menu opening on the defaults while their choice sat in the
  // database. A guest has no account, so never sees the Google control at all.
  //
  // Built on the same mergePersistedIntent as loadScheduleIntent, so "what the
  // menu opens with" has one definition, not two that agree today.
  const scheduleIntents: Record<string, ScheduleIntent> = {};
  if (me) {
    for (const { task } of rawItems) {
      if (!task || task.steps.length === 0) continue;
      scheduleIntents[task.id] = mergePersistedIntent(
        task.steps.map((s) => ({
          id: s.id,
          order: s.order,
          total: task.steps.length,
          text: s.text,
          emoji: s.subtaskEmoji,
          estMinutes: s.estMinutes,
          dueAt: null,
        })),
        task,
        new Date(now),
      );
    }
  }

  // Phase 5 (#8): the demo/first-run preview override shows the Inbox as a
  // brand-new workspace would see it (empty, welcome card, no resume banner)
  // without touching real data. welcomeVisible otherwise reflects whether the
  // workspace has ever dismissed the welcome card.
  const firstRun = settings.firstRunPreview;
  const welcomeVisible = firstRun || settings.welcomeDismissedAt == null;

  // #111 — "this is a new account", not "you emptied this". The header half of
  // #100 named the account on every page; this is the same obligation in the
  // place the alarming version of the question gets asked, which is a blank
  // inbox rather than a header.
  //
  // Gated on `me` for the same reason `google` above is: a guest has no account
  // to name, already gets the sandbox banner, and keeps today's copy unchanged.
  //
  // Gated on the item count as well, so the four-table probe in
  // workspaceHasHistory() only runs on the ONE request where its answer can
  // change anything. An ordinary load with rows on screen never reaches it, and
  // the first-run preview (#8) answers `true` from `firstRunPreview` alone
  // without touching the database — which is why the `hasHistory` argument is
  // allowed to be a placeholder `false` in that branch.
  const visibleItems = firstRun ? 0 : items.length;
  const newAccount =
    me !== null &&
    visibleItems === 0 &&
    emptyInboxIsNewAccount({
      visibleItems,
      hasHistory: firstRun ? false : await workspaceHasHistory(workspaceId),
      firstRunPreview: firstRun,
    })
      ? identityFor(me)
      : null;
  // Most-recent resumable, NOT-done step (open focus session) for the resume
  // banner — see resume-step.ts for why the !done guard matters.
  const resumeStep = firstResumableStep(items);

  return (
    <div className="space-y-4">
      {/* #109 — both banners hard-coded a `-700` text colour with no `dark:`
          partner, so they read 3.97:1 (green) and 3.06:1 (red) on the dark
          --background, and only ever render on the OAuth return redirect. The
          tone now comes from the one shared table, which also fixes the light
          half nobody had measured: the banner's own `/10` tint lifts the
          background toward the text, so green-700 was 4.16:1 there, not the
          4.65:1 the bare token gives. See status-banner-style.ts. */}
      {sp.google === "connected" && (
        <div
          className={cn(
            "rounded-lg border px-4 py-2 text-sm font-medium",
            STATUS_BANNER_TONE.ok,
          )}
        >
          ✅ Google Tasks connected — task breakdowns can now sync into Reclaim
          via your Google Tasks list.
        </div>
      )}
      {sp.google === "error" && (
        <div
          className={cn(
            "rounded-lg border px-4 py-2 text-sm",
            STATUS_BANNER_TONE.error,
          )}
        >
          Google Tasks connection failed{sp.reason ? `: ${sp.reason}` : ""}. Try
          again from a task breakdown.
        </div>
      )}
      <InboxView
        initialItems={firstRun ? [] : items}
        settings={{
          agingHours: settings.agingHours,
          overdueHours: settings.overdueHours,
          wayOverdueHours: settings.wayOverdueHours,
        }}
        google={google}
        scheduleIntents={scheduleIntents}
        welcomeVisible={welcomeVisible}
        resumeStep={firstRun ? null : resumeStep}
        newAccount={newAccount}
        notifyAging={settings.notifyAging}
        // #199 — already null in the first-run preview, because the read above is
        // gated on it rather than the result being discarded here. ONE gate: two
        // would be two things that could come to disagree, and the one that skips
        // the query is the one that is also cheaper.
        shoppingSummary={shoppingSummary}
        // #175 — the offline capture queue needs to know whose captures these
        // are: `localStorage` is scoped to the origin, not to a session, so
        // without it a second person signing in on the same browser would read
        // the first one's unsaved words. Resolved on the server here for the same
        // reason `now` is — a client component cannot reach it, and this repo has
        // no `NEXT_PUBLIC_*` variables at all.
        workspaceId={workspaceId}
        // #105 — the same request-time clock used above, handed to the client
        // component so its FIRST render matches this one. Without it InboxView
        // read the wall clock again at hydration time, and any row younger than
        // a minute renders "Ns ago" from two different seconds: a text mismatch,
        // React error #418, and a regeneration from the root that silently
        // stripped the pre-hydration `dark` class off <html>.
        now={now}
      />
    </div>
  );
}
