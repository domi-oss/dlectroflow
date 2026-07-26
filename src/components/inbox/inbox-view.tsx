"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Clock } from "lucide-react";
import { cn, touchTarget } from "@/lib/utils";
import { COMPLETE_TEXT } from "@/lib/completion-style";
import { DonePill } from "@/components/completion/done-pill";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  isAging,
  effectiveAgingMs,
  freshnessTier,
  shouldPrompt24h,
  type AgingSettings,
} from "@/lib/aging";
import {
  createBrainDumpItem,
  triageBrainDumpItem,
  snoozeBrainDumpItem,
  deleteBrainDumpItem,
  keepAsTask,
  markReminded,
  freshenItem,
  dismissPrompt,
  completeItem,
  reopenItem,
  moveToReview,
  requestBreakdown,
  ensureFocusStep,
  renameItem,
} from "@/app/actions/braindump";
import { startBreakdown } from "@/app/actions/breakdown";
import {
  pushStepsToGoogleTasks,
  scheduleSingleTask,
} from "@/app/actions/google-schedule";
import { scheduleViaIcs } from "@/app/actions/ics-schedule";
import { downloadIcs } from "@/lib/download-ics";
import type { GoogleConnStatus } from "@/lib/scheduling/types";
import { StatusPill } from "@/components/inbox/status-pill";
import { TaskSteps } from "@/components/breakdown/task-steps";
import {
  bucketItems,
  bucketOfItem,
  isBucketId,
  type Item,
  type BucketId,
} from "@/components/inbox/bucket";
import { itemRemainingMin, activeStepRemainingMin } from "@/lib/task-remaining";
import { dropPlan } from "@/components/inbox/move-dispatch";
import { MoveToMenu } from "@/components/inbox/move-to-menu";
import {
  RowActions,
  ScheduleControl,
  type ScheduleControlProps,
} from "@/components/inbox/row-actions";
import { CompleteButton } from "@/components/inbox/complete-button";
import { WelcomeCard } from "@/components/inbox/welcome-card";
import { SubHeader, SEE_ALL } from "@/components/inbox/sub-header";
import { t } from "@/lib/strings";
import { useVoice } from "@/components/voice-provider";
import type { Voice } from "@/lib/strings";
import {
  notificationPermission,
  requestNotificationPermission,
  registerServiceWorker,
  showReminder,
  subscribeNotificationPermission,
} from "@/lib/notifications";
import { formatAgo } from "@/lib/format";

/** Map a dnd-kit drop onto a bucket to a move intent (null when dropped nowhere). */
export function dragEndToMove(
  activeId: string,
  overId: string | null,
): { itemId: string; target: BucketId } | null {
  if (!overId || !isBucketId(overId)) return null;
  return { itemId: activeId, target: overId };
}

/** Maps a row's connection status + its own "ready" state (what it'd show if
 * Google were connected) onto the 📅 control's actual state — not-configured
 * and needs-reconnect override every row the same way. Exported so other
 * schedule-control call sites (e.g. the task working-view's <TaskSchedule>,
 * #8 follow-up) reuse this exact owner/guest logic instead of reimplementing
 * it. */
export function scheduleState(
  google: GoogleConnStatus,
  ready: ScheduleControlProps["state"],
): ScheduleControlProps["state"] {
  if (!google.configured) return "connect";
  if (google.needsReconnect) return "reconnect";
  // Configured but the owner never completed OAuth → offer Connect, not a live
  // 📅 that would fail (Duo review: the `connected=false` case was missing).
  if (!google.connected) return "connect";
  return ready;
}

// Mirrors the failure-reason copy `breakdown-chat.tsx` already uses for the
// same Google Tasks actions — `reconnect_required` is handled separately
// (swaps the row's control to the Reconnect link instead of showing text).
// Exported for reuse by <TaskSchedule> (#8 follow-up) — same single source
// of truth as `scheduleState` above.
export const SCHEDULE_ERROR_MESSAGES: Record<string, string> = {
  not_configured:
    "Google isn't configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).",
  not_connected: "Google Tasks isn't connected.",
  no_reclaim_list: "Couldn't find your Reclaim-synced Google Tasks list.",
  no_steps: "No steps to send.",
  not_found: "This task couldn't be found.",
};

/** ICS states carry the "Add to calendar" label; Google states carry "Schedule". */
const isIcsState = (s: ScheduleControlProps["state"]) =>
  s === "ics_ready_steps" || s === "ics_needs_duration";
const scheduleMenuLabel = (
  s: ScheduleControlProps["state"],
  voice: Voice,
): string =>
  isIcsState(s)
    ? t("action.addToCalendar", voice)
    : t("action.schedule", voice);

export function InboxView({
  initialItems,
  settings,
  google = null,
  welcomeVisible,
  resumeStep,
  notifyAging = true,
}: {
  initialItems: Item[];
  settings: AgingSettings;
  google?: GoogleConnStatus | null;
  /** First-run welcome card (Phase 5, #8) — shown above everything else until
   * the workspace dismisses it (or while previewing the demo first-run state). */
  welcomeVisible: boolean;
  /** Most-recent resumable step (an open, un-ended focus session), computed
   * server-side by the Inbox page. Null when there's nothing to resume — or
   * while previewing the demo first-run empty state, which never shows it. */
  resumeStep: { id: string; text: string } | null;
  /** Phase 6 — gates the aging→browser-notification firing (permission still applies). */
  notifyAging?: boolean;
}) {
  const router = useRouter();
  const voice = useVoice();
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Transient "captured ✓" indicator shown after a successful capture submit.
  const [justCaptured, setJustCaptured] = useState(false);
  const captureTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (captureTimeoutRef.current) clearTimeout(captureTimeoutRef.current);
    };
  }, []);

  // Per-row inline delete confirm — only one row confirms at a time.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Which multi-step row (if any) has its inline TaskSteps list expanded.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Which saved-for-later row (if any) has its inline sorting options open.
  const [savedOptionsId, setSavedOptionsId] = useState<string | null>(null);

  // Which row (any bucket) is editing its title via the ✎ pencil.
  const [editingId, setEditingId] = useState<string | null>(null);

  // Which completed multi-step row (if any) has its per-step Reopen picker open.
  const [reopenPickerId, setReopenPickerId] = useState<string | null>(null);

  // Live clock for bucketing + relative ages — interval-driven state (rather
  // than Date.now() during render) so ages recompute live AND render stays pure.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const ms = Math.min(effectiveAgingMs(settings), 15_000);
    const id = setInterval(() => setNow(Date.now()), Math.max(1000, ms / 4));
    return () => clearInterval(id);
  }, [settings]);

  // "/" focuses the capture bar (unless already typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Notifications: register the service worker + read permission through a
  // subscription — the store notifies after our own permission requests, so
  // no setState-in-effect is needed to keep the banner in sync.
  const permission = useSyncExternalStore(
    subscribeNotificationPermission,
    notificationPermission,
    () => "default" as const,
  );
  const notifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    registerServiceWorker();
  }, []);

  const enableReminders = () => {
    void requestNotificationPermission();
  };

  const {
    needsReview,
    singleTask,
    multiStep,
    savedLater,
    completed,
    completedTodayCount,
  } = bucketItems(initialItems, now);

  const untriagedCount = needsReview.length;
  const agingCount = needsReview.filter((i) =>
    isAging(i.createdAt, settings),
  ).length;

  // Fire a desktop reminder once per aging, not-yet-reminded item, then persist
  // remindedAt so it doesn't repeat (guarded client-side by notifiedRef too).
  // The inline 24h "still needed?" prompt is the canonical review nudge, so an
  // item whose prompt has been dismissed is excluded here too — dismissing it
  // once means "stop bugging me about this," not just "don't show the banner."
  useEffect(() => {
    if (permission !== "granted") return;
    if (!notifyAging) return; // Phase 6 — per-type notification preference
    const due = needsReview.filter(
      (i) =>
        isAging(i.createdAt, settings) &&
        i.remindedAt == null &&
        i.promptDismissedAt == null &&
        !notifiedRef.current.has(i.id),
    );
    if (due.length === 0) return;
    due.forEach((i) => notifiedRef.current.add(i.id));
    (async () => {
      for (const i of due) {
        await showReminder("🟡 Still needs triage", i.text);
        await markReminded(i.id);
      }
      router.refresh();
    })();
  }, [needsReview, permission, settings, router, notifyAging]);

  const run = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      await fn();
      router.refresh();
    });

  // Per-row 📅 error text (cleared on the row's next attempt); reconnect_required
  // is a workspace-wide condition, so it swaps every row's control to the
  // Reconnect link rather than just showing an error message on one row.
  const [scheduleErrors, setScheduleErrors] = useState<Record<string, string>>(
    {},
  );
  const [reconnectRequired, setReconnectRequired] = useState(false);
  // Already null for guests (owner-gated at the server boundary), so this directly
  // encodes whether these rows lead with Google (owner) or ICS (guest). The
  // needsReconnect override is workspace-wide (see reconnectRequired above).
  const effectiveGoogle: GoogleConnStatus | null = google
    ? { ...google, needsReconnect: google.needsReconnect || reconnectRequired }
    : null;

  const runSchedule = (
    itemId: string,
    fn: () => Promise<
      { ok: true } | { ok: false; reason: string; message?: string }
    >,
  ) =>
    startTransition(async () => {
      setScheduleErrors((prev) => {
        if (!(itemId in prev)) return prev;
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
      const res = await fn();
      if (res.ok) {
        router.refresh();
        return;
      }
      if (res.reason === "reconnect_required") {
        setReconnectRequired(true);
        // Every row's control just swapped to the Reconnect link, so any per-row
        // schedule error left from an earlier attempt is now stale — clear them
        // all rather than show a red error beside a Reconnect prompt (Duo review).
        setScheduleErrors({});
        return;
      }
      setScheduleErrors((prev) => ({
        ...prev,
        // Prefer the action's own message — e.g. pushStepsToGoogleTasks's
        // no_reclaim_list failure lists the available lists, which is more
        // useful than the generic dictionary copy for the same reason.
        [itemId]:
          res.message ??
          SCHEDULE_ERROR_MESSAGES[res.reason] ??
          "Scheduling failed.",
      }));
    });

  // ICS "Add to calendar" runner: builds the .ics server-side (marks + rewards),
  // then downloads it client-side. Guest-allowed (no owner gate) + no reconnect
  // handling (there's no external service to reconnect).
  const runScheduleIcs = (
    itemId: string,
    fn: () => Promise<
      | { ok: true; ics: string; icsFilename: string }
      | { ok: false; reason: string; message?: string }
    >,
  ) =>
    startTransition(async () => {
      setScheduleErrors((prev) => {
        if (!(itemId in prev)) return prev;
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
      const res = await fn();
      if (res.ok) {
        downloadIcs(res.ics, res.icsFilename);
        router.refresh();
        return;
      }
      setScheduleErrors((prev) => ({
        ...prev,
        [itemId]:
          res.message ??
          SCHEDULE_ERROR_MESSAGES[res.reason] ??
          "Couldn't build the calendar file.",
      }));
    });

  // Guest primary control + owner ▾ alternative both use this. State depends
  // on whether the task already has steps (per-step events vs. one timed event).
  const icsProps = (item: Item): ScheduleControlProps => ({
    state: item.stepsTotal > 0 ? "ics_ready_steps" : "ics_needs_duration",
    onScheduleIcs: (minutes?: number) => {
      const tid = item.taskId; // guard, mirroring the multi-step Google wiring
      if (!tid) return;
      runScheduleIcs(item.id, () =>
        scheduleViaIcs(
          tid,
          minutes != null ? { durationMin: minutes } : undefined,
        ),
      );
    },
    pending,
  });

  const breakdown = (id: string) =>
    startTransition(async () => {
      const taskId = await startBreakdown(id);
      if (taskId) router.push(`/tasks/${taskId}`);
    });

  // ▶ Focus on a single to-do — ensures its one-step task exists, then opens
  // the step-based focus timer.
  const focusOnItem = (id: string) =>
    startTransition(async () => {
      const stepId = await ensureFocusStep(id);
      if (stepId) router.push(`/focus/${stepId}`);
    });

  // ▶ Focus a multi-step row: jump straight into the next unfinished step's
  // timer (mirrors the single-task ▶ Focus). Steps already exist, so there's
  // nothing to ensure.
  const focusNextStep = (item: Item) => {
    const next = item.steps.find((s) => !s.done);
    if (next) router.push(`/focus/${next.id}`);
  };

  // ✎ inline title editing — shared by every bucket's rows. Keyed so it's
  // safe to drop directly into a RowActions `overflow` array too.
  const pencil = (item: Item) => (
    <button
      key={`edit-${item.id}`}
      type="button"
      aria-label={`Edit ${item.text}`}
      onClick={() => setEditingId(item.id)}
      className={cn(
        "text-muted-foreground hover:text-foreground shrink-0 px-1 text-xs",
        touchTarget,
      )}
    >
      ✏️
    </button>
  );

  // v6: the ▾ dropdown's edit entry is the full text "Edit task title" (the
  // title-line affordance stays the ✏️ pencil above). Keyed for the menu array.
  const editMenuItem = (item: Item) => (
    <button
      key={`edit-menu-${item.id}`}
      type="button"
      onClick={() => setEditingId(item.id)}
      className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
    >
      {t("action.editTitle", voice)}
    </button>
  );
  const titleEditor = (item: Item) => (
    <EditTitleInput
      initial={item.text}
      onSave={(value) => {
        setEditingId(null);
        if (value && value !== item.text) run(() => renameItem(item.id, value));
      }}
      onCancel={() => setEditingId(null)}
    />
  );

  // Drag (dnd-kit) + the "Move to…" menu share this single dispatcher so the
  // two paths can never diverge (Task 10). Every drop moves immediately —
  // a Multi-step drop parks the item there with a "Break into steps now?"
  // call-to-action (requestBreakdown) instead of a blocking prompt.
  // Mouse/touch split (#26): a bare PointerSensor loses the gesture race to
  // page scrolling on touch screens, so drags never started on mobile.
  // Touch = long-press to lift (the standard mobile list pattern); mouse keeps
  // a 5px threshold (imperceptible, and stops stray clicks becoming drags).
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
    useSensor(KeyboardSensor),
  );
  const itemsById = new Map(initialItems.map((i) => [i.id, i]));

  const moveItemToBucket = (itemId: string, target: BucketId) => {
    const item = itemsById.get(itemId);
    if (!item) return;
    const plan = dropPlan(bucketOfItem(item, now), target);
    if (plan.kind === "noop") return;

    run(async () => {
      if (plan.reopenFirst) await reopenItem(itemId, undefined);
      switch (plan.action) {
        case "moveToReview":
          await moveToReview(itemId);
          break;
        case "triage":
          await triageBrainDumpItem(itemId);
          break;
        case "requestBreakdown":
          await requestBreakdown(itemId);
          break;
        case "snooze":
          await snoozeBrainDumpItem(itemId, 60);
          break;
        case "complete":
          await completeItem(itemId);
          break;
      }
    });
  };

  // Row-follows-finger feedback (#26): DragOverlay floats a copy of the row;
  // rows compare their id against activeDragId to dim themselves (dnd-kit does
  // NOT hide the source automatically). Cleared on drop/cancel.
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const handleDragStart = (e: DragStartEvent) =>
    setActiveDragId(String(e.active.id));
  const handleDragEnd = (e: DragEndEvent) => {
    setActiveDragId(null);
    const move = dragEndToMove(
      String(e.active.id),
      e.over ? String(e.over.id) : null,
    );
    if (move) moveItemToBucket(move.itemId, move.target);
  };
  const activeDragItem = activeDragId
    ? (itemsById.get(activeDragId) ?? null)
    : null;

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    run(() => createBrainDumpItem(value));
    setJustCaptured(true);
    if (captureTimeoutRef.current) clearTimeout(captureTimeoutRef.current);
    captureTimeoutRef.current = setTimeout(() => setJustCaptured(false), 1500);
  };

  // Inline delete confirm: first click reveals Delete/Cancel; the action only
  // fires on the confirming click.
  const requestDelete = (id: string) => setConfirmDeleteId(id);
  const cancelDelete = () => setConfirmDeleteId(null);
  const confirmDelete = (id: string) => {
    setConfirmDeleteId(null);
    run(() => deleteBrainDumpItem(id));
  };

  // v5: 🗑 delete lives inline in every row's end cluster AND (per the "▾
  // lists ALL the row's options including duplicates" rule) a second time
  // inside the ▾ menu — both instances share the same confirmDeleteId state,
  // so confirming/cancelling either one keeps the other in sync. `fullWidth`
  // switches on the menu-entry styling (menu items are left-aligned, full
  // width rows; the end-cluster one is a compact inline button).
  const deleteControl = (
    itemId: string,
    key: string,
    {
      fullWidth = false,
      icon = false,
    }: { fullWidth?: boolean; icon?: boolean } = {},
  ) =>
    confirmDeleteId === itemId ? (
      <span key={key} className="flex items-center gap-2">
        <button
          className="text-destructive rounded-md px-2.5 py-1 font-medium"
          onClick={() => confirmDelete(itemId)}
        >
          {t("action.delete", voice)}
        </button>
        <span className="text-muted-foreground">·</span>
        <button
          className="text-muted-foreground hover:text-foreground rounded-md px-2.5 py-1"
          onClick={cancelDelete}
        >
          {t("action.cancel", voice)}
        </button>
      </span>
    ) : icon ? (
      // v6 end-cluster: 🗑 icon (aria-label carries the meaning; two-step confirm
      // preserved — the first tap swaps to the Delete · Cancel text above).
      <button
        key={key}
        aria-label={t("action.delete", voice)}
        title={t("action.delete", voice)}
        className={cn(
          // End-cluster icon — ghost hover + a slightly bigger glyph, same
          // treatment as 📅/▾/📥 (owner: mobile icons read too tiny).
          "text-muted-foreground hover:bg-accent hover:text-destructive rounded-md px-2 py-1 text-sm",
          touchTarget,
        )}
        onClick={() => requestDelete(itemId)}
      >
        🗑
      </button>
    ) : (
      <button
        key={key}
        className={cn(
          "text-muted-foreground hover:text-destructive rounded-md px-2.5 py-1",
          fullWidth && "hover:bg-accent hover:text-foreground w-full text-left",
        )}
        onClick={() => requestDelete(itemId)}
      >
        {t("action.delete", voice)}
      </button>
    );

  return (
    <div className="space-y-6">
      {welcomeVisible && <WelcomeCard voice={voice} />}
      {resumeStep && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-50 px-4 py-2 text-sm dark:bg-amber-950/20"
        >
          <span className="flex-1">
            {t("focus.pausedBanner", voice)}{" "}
            <strong>&ldquo;{resumeStep.text}&rdquo;</strong>
          </span>
          <Link
            href={`/focus/${resumeStep.id}`}
            className="text-amber-800 hover:underline dark:text-amber-300"
          >
            {t("focus.resumeArrow", voice)}
          </Link>
        </div>
      )}
      <NavBadge untriagedCount={untriagedCount} agingCount={agingCount} />

      {permission === "default" && (
        <button
          onClick={enableReminders}
          className="hover:bg-accent w-full rounded-lg border border-dashed px-3 py-2 text-sm"
        >
          🔔 Enable desktop reminders for aging items
        </button>
      )}
      {permission === "denied" && (
        <p className="text-muted-foreground text-xs">
          Desktop reminders are blocked in your browser settings; items still
          age and re-sort in-app.
        </p>
      )}

      {/* Capture bar */}
      <div className="space-y-1">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Brain dump anything… (Enter to save)"
          className="border-input bg-background focus-visible:ring-ring w-full rounded-lg border px-4 py-3 text-base shadow-sm outline-none focus-visible:ring-2"
          autoFocus
        />
        <p className="text-muted-foreground px-1 text-xs">
          No fields required. Press Enter to capture instantly.
        </p>
        {justCaptured && (
          <p
            role="status"
            className="text-emerald-700 dark:text-emerald-400 px-1 text-xs"
          >
            {t("capture.confirm", voice)}
          </p>
        )}
      </div>

      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragCancel={() => setActiveDragId(null)}
        onDragEnd={handleDragEnd}
      >
        {/* Needs review */}
        <section>
          <h2 className="text-primary mb-2 flex items-center gap-2 text-sm font-semibold">
            {t("section.needsReview", voice)}
            {untriagedCount > 0 && (
              <span className="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-xs">
                {untriagedCount}
              </span>
            )}
          </h2>
          <DroppableBucket id="needsReview">
            {needsReview.length === 0 ? (
              <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm">
                {t("inbox.zero", voice)}
              </p>
            ) : (
              <ul className={cn("space-y-2", pending && "opacity-70")}>
                {needsReview.map((item) => {
                  // v5: review rows are now schedulable — an unclarified
                  // capture has no steps, so 📅 always offers the same
                  // duration popover a Single-task row uses.
                  const schedule: ScheduleControlProps | null = effectiveGoogle
                    ? {
                        state: scheduleState(effectiveGoogle, "needs_duration"),
                        onScheduleSingle: (minutes: number) =>
                          runSchedule(item.id, () =>
                            scheduleSingleTask(item.id, minutes),
                          ),
                        pending,
                      }
                    : icsProps(item);
                  return (
                    <ItemRow
                      isDragging={activeDragId === item.id}
                      key={item.id}
                      item={item}
                      settings={settings}
                      voice={voice}
                      now={now}
                      onBreakdown={() => breakdown(item.id)}
                      onKeep={() => run(() => keepAsTask(item.id))}
                      onSaveForLater={() =>
                        moveItemToBucket(item.id, "savedLater")
                      }
                      onSnooze={() =>
                        run(() => snoozeBrainDumpItem(item.id, 60))
                      }
                      onComplete={() => run(() => completeItem(item.id))}
                      confirmingDelete={confirmDeleteId === item.id}
                      onRequestDelete={() => requestDelete(item.id)}
                      onConfirmDelete={() => confirmDelete(item.id)}
                      onCancelDelete={cancelDelete}
                      onFreshen={() => run(() => freshenItem(item.id))}
                      onDismissPrompt={() => run(() => dismissPrompt(item.id))}
                      schedule={schedule}
                      scheduled={item.scheduledAt != null}
                      icsMenu={
                        effectiveGoogle ? (
                          <ScheduleControl
                            key="ics-m"
                            variant="menu"
                            {...icsProps(item)}
                            label={t("action.addToCalendar", voice)}
                          />
                        ) : null
                      }
                      scheduleError={scheduleErrors[item.id]}
                      moveMenu={
                        <MoveToMenu
                          key="move"
                          currentBucket={bucketOfItem(item, now)}
                          voice={voice}
                          onMove={(target) => moveItemToBucket(item.id, target)}
                        />
                      }
                      moveIcon={
                        <MoveToMenu
                          key="move-icon"
                          compact
                          currentBucket={bucketOfItem(item, now)}
                          voice={voice}
                          onMove={(target) => moveItemToBucket(item.id, target)}
                        />
                      }
                      dragGrip={<DragGrip id={item.id} label={item.text} />}
                      editButton={pencil(item)}
                      editMenuItem={editMenuItem(item)}
                      titleEditor={
                        editingId === item.id ? titleEditor(item) : undefined
                      }
                    />
                  );
                })}
              </ul>
            )}
          </DroppableBucket>
        </section>

        {/* To-Do board — four always-visible buckets (Phase B) */}
        <section className="space-y-4">
          <h2 className="text-primary text-sm font-semibold">
            {t("section.toDo", voice)}
          </h2>

          {/* Multi-step */}
          <div>
            <SubHeader
              label={t("section.multiStep", voice)}
              count={multiStep.length}
              seeAllHref={SEE_ALL.multiStep}
              voice={voice}
            />
            <DroppableBucket id="multiStep">
              {multiStep.length === 0 ? (
                <EmptyBucket voice={voice} />
              ) : (
                <ul className={cn("space-y-2", pending && "opacity-70")}>
                  {multiStep.map((item) => {
                    /* multi-step row — extended in Task 9 (step count + expand) and Task 10 (drag/menu).
                       A 0-step row is awaiting its breakdown (breakdownRequestedAt): instead of a
                       step count it shows a red "Break into steps now?" CTA into the editor. */
                    const expanded = expandedId === item.id;
                    const awaitingBreakdown = item.stepsTotal === 0;
                    // #27 follow-up — task total (shrinks as steps are
                    // paused/completed) + the active step's own remaining
                    // time, if one is open. Both are persisted SNAPSHOTS as
                    // of this page load — no live ticking in the list.
                    const totalRemainingMin = itemRemainingMin(item);
                    const activeRemainingMin = activeStepRemainingMin(item);
                    // No steps yet → nothing to push, so 📅 offers the same
                    // duration popover a single-task row uses. Rows with
                    // steps push them straight to Google Tasks on tap.
                    const schedule: ScheduleControlProps | null =
                      !effectiveGoogle
                        ? icsProps(item)
                        : awaitingBreakdown
                          ? {
                              state: scheduleState(
                                effectiveGoogle,
                                "needs_duration",
                              ),
                              onScheduleSingle: (minutes: number) =>
                                runSchedule(item.id, () =>
                                  scheduleSingleTask(item.id, minutes),
                                ),
                              pending,
                            }
                          : {
                              state: scheduleState(
                                effectiveGoogle,
                                "ready_steps",
                              ),
                              onScheduleSteps: () => {
                                // Guard taskId instead of asserting it — a data
                                // inconsistency should no-op, not POST undefined (Duo review).
                                const tid = item.taskId;
                                if (tid)
                                  runSchedule(item.id, () =>
                                    pushStepsToGoogleTasks(tid),
                                  );
                              },
                              pending,
                            };
                    return (
                      <li
                        key={item.id}
                        className={cn(
                          "rounded-lg border px-4 py-3 text-sm",
                          item.id === activeDragId && "opacity-40",
                        )}
                      >
                        {/* Title line + action row below — mirrors the Needs-review row layout. */}
                        {/* Tapping anywhere on the title line toggles the inline
                            step list (a step-bearing row); the title button keeps
                            aria-expanded for keyboard/AT, and the pencil stops
                            propagation so editing doesn't also toggle. */}
                        <div
                          className={cn(
                            "flex items-start gap-2",
                            !awaitingBreakdown &&
                              editingId !== item.id &&
                              "cursor-pointer",
                          )}
                          onClick={
                            !awaitingBreakdown && editingId !== item.id
                              ? () => setExpandedId(expanded ? null : item.id)
                              : undefined
                          }
                        >
                          <DragGrip id={item.id} label={item.text} />
                          {editingId === item.id ? (
                            titleEditor(item)
                          ) : awaitingBreakdown ? (
                            <span className="min-w-0 flex-1 break-words">
                              <span className="text-lg font-semibold">
                                {item.text}
                              </span>{" "}
                              {pencil(item)}
                            </span>
                          ) : (
                            <span className="min-w-0 flex-1 break-words">
                              <button
                                type="button"
                                aria-expanded={expanded}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedId(expanded ? null : item.id);
                                }}
                                className="text-lg font-semibold break-words text-left hover:underline"
                              >
                                {item.text}
                              </button>{" "}
                              <span onClick={(e) => e.stopPropagation()}>
                                {pencil(item)}
                              </span>
                            </span>
                          )}
                          {editingId !== item.id && !awaitingBreakdown && (
                            <span className="text-muted-foreground shrink-0 text-xs">
                              {item.stepsTotal} steps · {item.stepsDone}{" "}
                              {t("progress.done", voice)}
                            </span>
                          )}
                        </div>
                        {/* #27 follow-up — task total remaining + (when a
                            step is paused/in progress) that step's own
                            remaining time. */}
                        {!awaitingBreakdown && (
                          <p className="text-muted-foreground pl-9 text-xs tabular-nums">
                            ≈{totalRemainingMin} {t("lib.minLeft", voice)}
                            {activeRemainingMin != null &&
                              ` · ≈${activeRemainingMin} ${t("lib.minOnStep", voice)}`}
                          </p>
                        )}
                        <RowActions
                          className="pl-9"
                          scheduled={item.scheduledAt != null}
                          inline={
                            awaitingBreakdown
                              ? [
                                  <button
                                    key="break-now"
                                    type="button"
                                    onClick={() => breakdown(item.id)}
                                    className="bg-destructive text-destructive-foreground rounded-md px-2.5 py-1 font-medium hover:opacity-90"
                                  >
                                    {t("prompt.breakNow", voice)}
                                  </button>,
                                ]
                              : [
                                  // Primary CTA — matches the single-task row (▶ Focus + Complete):
                                  // jumps straight into the next unfinished step's timer.
                                  <button
                                    key="focus"
                                    type="button"
                                    onClick={() => focusNextStep(item)}
                                    className="bg-primary text-primary-foreground hover:opacity-90 rounded-md px-2.5 py-1 font-medium"
                                  >
                                    ▶ Start Focus
                                  </button>,
                                  <CompleteButton
                                    key="complete"
                                    voice={voice}
                                    onClick={() =>
                                      run(() => completeItem(item.id))
                                    }
                                  />,
                                ]
                          }
                          move={
                            <MoveToMenu
                              key="move-icon"
                              compact
                              currentBucket={bucketOfItem(item, now)}
                              voice={voice}
                              onMove={(target) =>
                                moveItemToBucket(item.id, target)
                              }
                            />
                          }
                          schedule={schedule}
                          del={deleteControl(item.id, "delete", { icon: true })}
                          menu={[
                            <MoveToMenu
                              key="move"
                              currentBucket={bucketOfItem(item, now)}
                              voice={voice}
                              onMove={(target) =>
                                moveItemToBucket(item.id, target)
                              }
                            />,
                            // Rows with steps: view the broken-down list (inline
                            // expand) + jump to the task page to focus a step —
                            // above "Mark as completed". Hidden while awaiting.
                            !awaitingBreakdown ? (
                              <button
                                key="view-list-m"
                                type="button"
                                className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                                onClick={() =>
                                  setExpandedId(expanded ? null : item.id)
                                }
                              >
                                View multi-step task list
                              </button>
                            ) : null,
                            !awaitingBreakdown ? (
                              <button
                                key="focus-list-m"
                                type="button"
                                className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                                // Guard rather than assert: a multi-step row's Task always
                                // exists by construction, but a data inconsistency must not
                                // navigate to `/tasks/null` (Duo review).
                                onClick={() =>
                                  item.taskId &&
                                  router.push(`/tasks/${item.taskId}`)
                                }
                              >
                                Start visual focus timer
                              </button>
                            ) : null,
                            awaitingBreakdown ? (
                              <button
                                key="break-now-m"
                                type="button"
                                className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                                onClick={() => breakdown(item.id)}
                              >
                                {t("prompt.breakNow", voice)}
                              </button>
                            ) : (
                              <button
                                key="complete-m"
                                type="button"
                                className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                                onClick={() => run(() => completeItem(item.id))}
                              >
                                {t("action.completeFull", voice)}
                              </button>
                            ),
                            schedule ? (
                              <ScheduleControl
                                key="schedule-m"
                                {...schedule}
                                variant="menu"
                                label={scheduleMenuLabel(schedule.state, voice)}
                              />
                            ) : null,
                            effectiveGoogle ? (
                              <ScheduleControl
                                key="ics-m"
                                variant="menu"
                                {...icsProps(item)}
                                label={t("action.addToCalendar", voice)}
                              />
                            ) : null,
                            editMenuItem(item),
                            deleteControl(item.id, "delete-m", {
                              fullWidth: true,
                            }),
                          ]}
                        />
                        {scheduleErrors[item.id] && (
                          <p className="text-destructive mt-1 text-xs">
                            {scheduleErrors[item.id]}
                          </p>
                        )}
                        {expanded && item.taskId && (
                          <div className="mt-2">
                            <TaskSteps
                              taskId={item.taskId}
                              voice={voice}
                              steps={item.steps.map((s) => ({
                                id: s.id,
                                order: s.order,
                                total: item.stepsTotal,
                                text: s.text,
                                subtaskEmoji: s.subtaskEmoji,
                                estMinutes: s.estMinutes,
                                done: s.done,
                                resumable: s.resumable,
                              }))}
                            />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </DroppableBucket>
          </div>

          {/* Single-task */}
          <div>
            <SubHeader
              label={t("section.singleTask", voice)}
              count={singleTask.length}
              seeAllHref={SEE_ALL.singleTask}
              voice={voice}
            />
            <DroppableBucket id="singleTask">
              {singleTask.length === 0 ? (
                <EmptyBucket voice={voice} />
              ) : (
                <ul className={cn("space-y-2", pending && "opacity-70")}>
                  {singleTask.map((item) => {
                    const schedule: ScheduleControlProps | null =
                      effectiveGoogle
                        ? {
                            state: scheduleState(
                              effectiveGoogle,
                              "needs_duration",
                            ),
                            onScheduleSingle: (minutes: number) =>
                              runSchedule(item.id, () =>
                                scheduleSingleTask(item.id, minutes),
                              ),
                            pending,
                          }
                        : icsProps(item);
                    return (
                      <li
                        key={item.id}
                        className={cn(
                          "rounded-lg border px-4 py-3 text-sm",
                          item.id === activeDragId && "opacity-40",
                        )}
                      >
                        {/* Title line + action row below — mirrors the Needs-review row layout. */}
                        <div className="flex items-start gap-2">
                          <DragGrip id={item.id} label={item.text} />
                          {editingId === item.id ? (
                            titleEditor(item)
                          ) : (
                            <span className="min-w-0 flex-1 break-words">
                              <span className="text-lg font-semibold">
                                {item.text}
                              </span>{" "}
                              {pencil(item)}
                            </span>
                          )}
                          {editingId !== item.id && (
                            <span className="text-muted-foreground shrink-0 text-xs">
                              captured{" "}
                              {formatAgo(
                                now - new Date(item.createdAt).getTime(),
                              )}
                            </span>
                          )}
                        </div>
                        <RowActions
                          className="pl-9"
                          scheduled={item.scheduledAt != null}
                          inline={[
                            <button
                              key="focus"
                              type="button"
                              onClick={() => focusOnItem(item.id)}
                              className="bg-primary text-primary-foreground hover:opacity-90 rounded-md px-2.5 py-1 font-medium"
                            >
                              ▶ Start Focus
                            </button>,
                            <CompleteButton
                              key="complete"
                              voice={voice}
                              onClick={() => run(() => completeItem(item.id))}
                            />,
                          ]}
                          move={
                            <MoveToMenu
                              key="move-icon"
                              compact
                              currentBucket={bucketOfItem(item, now)}
                              voice={voice}
                              onMove={(target) =>
                                moveItemToBucket(item.id, target)
                              }
                            />
                          }
                          schedule={schedule}
                          del={deleteControl(item.id, "delete", { icon: true })}
                          menu={[
                            <MoveToMenu
                              key="move"
                              currentBucket={bucketOfItem(item, now)}
                              voice={voice}
                              onMove={(target) =>
                                moveItemToBucket(item.id, target)
                              }
                            />,
                            <button
                              key="focus-m"
                              type="button"
                              className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                              onClick={() => focusOnItem(item.id)}
                            >
                              Start visual focus timer
                            </button>,
                            <button
                              key="complete-m"
                              type="button"
                              className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                              onClick={() => run(() => completeItem(item.id))}
                            >
                              {t("action.completeFull", voice)}
                            </button>,
                            schedule ? (
                              <ScheduleControl
                                key="schedule-m"
                                {...schedule}
                                variant="menu"
                                label={scheduleMenuLabel(schedule.state, voice)}
                              />
                            ) : null,
                            effectiveGoogle ? (
                              <ScheduleControl
                                key="ics-m"
                                variant="menu"
                                {...icsProps(item)}
                                label={t("action.addToCalendar", voice)}
                              />
                            ) : null,
                            editMenuItem(item),
                            deleteControl(item.id, "delete-m", {
                              fullWidth: true,
                            }),
                          ]}
                        />
                        {scheduleErrors[item.id] && (
                          <p className="text-destructive mt-1 text-xs">
                            {scheduleErrors[item.id]}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </DroppableBucket>
          </div>

          {/* Saved for later */}
          <div>
            <SubHeader
              label={t("section.savedLater", voice)}
              count={savedLater.length}
              seeAllHref={SEE_ALL.savedLater}
              voice={voice}
            />
            <DroppableBucket id="savedLater">
              {savedLater.length === 0 ? (
                <EmptyBucket voice={voice} />
              ) : (
                <ul className="space-y-2">
                  {savedLater.map((item) => {
                    /* Tapping a saved row reveals the same sorting options a
                       review row has — the pantry is "waiting for your review".
                       Idle rows are dimmed; a row under review looks active. */
                    const optionsOpen = savedOptionsId === item.id;
                    return (
                      <li
                        key={item.id}
                        className={cn(
                          "rounded-lg border px-4 py-3 text-sm",
                          item.id === activeDragId && "opacity-40",
                        )}
                      >
                        {/* Title line + action row below — mirrors the Needs-review row layout.
                            An idle row reads as "asleep" by dimming ONLY this title/metadata
                            line — NOT the whole row (#56). Layering opacity-70 over the <li>
                            also composited the bg-primary "Review now" CTA below WCAG-AA
                            (~3.3:1 light / ~3.6:1 dark against its background; needs 4.5:1).
                            Keeping the dim off the CTA lets it stay at its full 5.41:1 (light)
                            / 6.32:1 (dark). The dim lifts once the row is under review
                            (optionsOpen) or being dragged (the <li>'s opacity-40 covers it). */}
                        <div
                          className={cn(
                            "flex items-start gap-2",
                            !optionsOpen &&
                              item.id !== activeDragId &&
                              "opacity-70",
                          )}
                        >
                          <DragGrip id={item.id} label={item.text} />
                          {editingId === item.id ? (
                            titleEditor(item)
                          ) : (
                            <span className="min-w-0 flex-1 break-words">
                              <button
                                type="button"
                                aria-expanded={optionsOpen}
                                onClick={() =>
                                  setSavedOptionsId(
                                    optionsOpen ? null : item.id,
                                  )
                                }
                                className="text-lg font-semibold break-words text-left hover:underline"
                              >
                                {item.text}
                              </button>{" "}
                              {pencil(item)}
                            </span>
                          )}
                        </div>
                        {/* Idle: Review now + 📥 Move. Reviewing: the full v6
                            review-row frame (short buttons + ▾ full mirror);
                            the short "Save" re-snoozes and puts the row back
                            to sleep. */}
                        {optionsOpen ? (
                          <RowActions
                            className="pl-9"
                            inline={[
                              <button
                                key="breakdown"
                                onClick={() => breakdown(item.id)}
                                className="bg-primary text-primary-foreground hover:opacity-90 rounded-md px-2.5 py-1 font-medium"
                              >
                                {t("action.breakdown", voice)} →
                              </button>,
                              <button
                                key="keep"
                                className="hover:bg-accent rounded-md px-2.5 py-1 font-medium"
                                onClick={() => run(() => keepAsTask(item.id))}
                              >
                                {t("action.addTodo", voice)}
                              </button>,
                              <button
                                key="save"
                                className="hover:bg-accent rounded-md px-2.5 py-1 font-medium"
                                onClick={() => {
                                  setSavedOptionsId(null);
                                  run(() => snoozeBrainDumpItem(item.id, 60));
                                }}
                              >
                                {t("action.saveShort", voice)}
                              </button>,
                              <CompleteButton
                                key="complete"
                                voice={voice}
                                onClick={() => run(() => completeItem(item.id))}
                              />,
                            ]}
                            move={
                              <MoveToMenu
                                key="move-icon"
                                compact
                                currentBucket={bucketOfItem(item, now)}
                                voice={voice}
                                onMove={(target) =>
                                  moveItemToBucket(item.id, target)
                                }
                              />
                            }
                            del={deleteControl(item.id, "delete-saved", {
                              icon: true,
                            })}
                            menu={[
                              <MoveToMenu
                                key="move"
                                currentBucket={bucketOfItem(item, now)}
                                voice={voice}
                                onMove={(target) =>
                                  moveItemToBucket(item.id, target)
                                }
                              />,
                              <button
                                key="breakdown-m"
                                onClick={() => breakdown(item.id)}
                                className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                              >
                                {t("action.breakdownFull", voice)}
                              </button>,
                              <button
                                key="keep-m"
                                onClick={() => run(() => keepAsTask(item.id))}
                                className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                              >
                                {t("action.addTodoFull", voice)}
                              </button>,
                              <button
                                key="save-m"
                                onClick={() => {
                                  setSavedOptionsId(null);
                                  run(() => snoozeBrainDumpItem(item.id, 60));
                                }}
                                className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                              >
                                {t("action.saveForLater", voice)}
                              </button>,
                              <button
                                key="complete-m"
                                onClick={() => run(() => completeItem(item.id))}
                                className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                              >
                                {t("action.completeFull", voice)}
                              </button>,
                              editMenuItem(item),
                              deleteControl(item.id, "delete-saved-m", {
                                fullWidth: true,
                              }),
                            ]}
                          />
                        ) : (
                          <div className="mt-2 flex flex-wrap items-center gap-2 pl-9 text-xs">
                            {/* Wakes the item for review IN the bucket — same
                                toggle as pressing the row title. */}
                            <button
                              type="button"
                              aria-expanded={optionsOpen}
                              onClick={() => setSavedOptionsId(item.id)}
                              className="bg-primary text-primary-foreground hover:opacity-90 rounded-md px-2.5 py-1 font-medium"
                            >
                              {t("action.reviewNow", voice)}
                            </button>
                            <span className="flex-1" />
                            <MoveToMenu
                              compact
                              currentBucket={bucketOfItem(item, now)}
                              voice={voice}
                              onMove={(target) =>
                                moveItemToBucket(item.id, target)
                              }
                            />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </DroppableBucket>
          </div>

          {/* Completed */}
          <div>
            <h2 className="text-primary mb-2 flex items-center gap-2 text-sm font-semibold">
              {t("section.completed", voice)}
              <span className="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-xs">
                {t("section.completedToday", voice)}: {completedTodayCount}
              </span>
              <a
                href="/library?tab=done"
                className="text-muted-foreground hover:text-foreground ml-auto text-xs font-normal"
              >
                {t("link.seeAll", voice)}
              </a>
            </h2>
            <DroppableBucket id="completed">
              {completed.length === 0 ? (
                <EmptyBucket voice={voice} />
              ) : (
                <ul className="space-y-2 opacity-80">
                  {completed.map((item) => {
                    /* Multi-step (2+ steps): Reopen opens a per-step picker so
                       only the steps that still need doing come back. Anything
                       simpler reopens whole, as before. */
                    const pickingSteps = reopenPickerId === item.id;
                    return (
                      <li
                        key={item.id}
                        className={cn(
                          "rounded-lg border px-4 py-3 text-sm",
                          item.id === activeDragId && "opacity-40",
                        )}
                      >
                        {/* Title line + action row below — mirrors the Needs-review row layout. */}
                        <div className="flex items-start gap-2">
                          <DragGrip id={item.id} label={item.text} />
                          {editingId === item.id ? (
                            titleEditor(item)
                          ) : (
                            <span className="min-w-0 flex-1 break-words">
                              <span
                                className={cn(
                                  "text-lg font-semibold",
                                  COMPLETE_TEXT,
                                )}
                              >
                                {item.text}
                              </span>{" "}
                              {pencil(item)}
                            </span>
                          )}
                          {editingId !== item.id && (
                            <DonePill
                              voice={voice}
                              done={item.stepsDone}
                              total={item.stepsTotal}
                            />
                          )}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 pl-9 text-xs">
                          <button
                            type="button"
                            className="hover:bg-accent rounded-md px-2.5 py-1 font-medium"
                            onClick={() =>
                              item.stepsTotal > 1
                                ? setReopenPickerId(
                                    pickingSteps ? null : item.id,
                                  )
                                : run(() => reopenItem(item.id, undefined))
                            }
                          >
                            {t("action.reopen", voice)}
                          </button>
                          <span className="flex-1" />
                          <MoveToMenu
                            compact
                            currentBucket={bucketOfItem(item, now)}
                            voice={voice}
                            onMove={(target) =>
                              moveItemToBucket(item.id, target)
                            }
                          />
                        </div>
                        {pickingSteps && (
                          <ReopenStepPicker
                            steps={item.steps}
                            voice={voice}
                            onConfirm={(stepIds) => {
                              setReopenPickerId(null);
                              run(() => reopenItem(item.id, stepIds));
                            }}
                            onCancel={() => setReopenPickerId(null)}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </DroppableBucket>
          </div>
        </section>
        {/* #26: floating copy of the dragged row — the whole card visibly follows
            the finger/pointer during a drag, with a short settle animation on drop.
            #62: dnd-kit's DragOverlay sizes its wrapper to the *draggable* node's
            measured rect (see PositionedOverlay in @dnd-kit/core), and the
            draggable ref lives on the 28×44 DragGrip button, not the row — so
            without the `style` override below the overlay box is grip-sized and
            the title text gets crushed into a vertical sliver on drop. Clearing
            width/height here lets the ghost shrink-to-fit its own content
            (capped to a sensible row width) instead of the grip's box. */}
        <DragOverlay
          dropAnimation={{ duration: 180, easing: "ease-out" }}
          style={{ width: "auto", height: "auto" }}
        >
          {activeDragItem ? <DragGhostRow text={activeDragItem.text} /> : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

/** Inline title editor swapped in for a row's title while its ✎ is active.
 * Enter saves, Escape cancels. */
function EditTitleInput({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      value={value}
      aria-label="Edit title"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSave(value.trim());
        }
        if (e.key === "Escape") onCancel();
      }}
      className="border-input bg-background focus-visible:ring-ring min-w-0 flex-1 rounded-md border px-2 py-1 text-sm outline-none focus-visible:ring-2"
    />
  );
}

/** Inline picker for undoing a completed multi-step item: tick the steps that
 * still need doing. Confirm needs ≥1 ticked; "Reopen all" resets every step
 * (same as the whole-item Undo, stepIds = undefined). */
function ReopenStepPicker({
  steps,
  voice,
  onConfirm,
  onCancel,
}: {
  steps: Item["steps"];
  voice: Voice;
  onConfirm: (stepIds: string[] | undefined) => void;
  onCancel: () => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const ordered = [...steps].sort((a, b) => a.order - b.order);

  // Escape dismisses the picker — same keyboard behaviour as MoveToMenu.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);
  return (
    <div className="mt-2 space-y-2 rounded-md border px-3 py-2 text-xs">
      <p className="font-medium">{t("prompt.reopenWhich", voice)}</p>
      <ul className="space-y-1">
        {ordered.map((s) => (
          <li key={s.id}>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={checked.has(s.id)}
                onChange={() => toggle(s.id)}
              />
              {/* Unticked = stays done, so it keeps the completed strikethrough. */}
              <span
                className={cn(
                  !checked.has(s.id) && `${COMPLETE_TEXT} opacity-70`,
                )}
              >
                {/* Emoji is decoration; keep it out of the accessible name. */}
                {s.subtaskEmoji && (
                  <span aria-hidden="true">{s.subtaskEmoji} </span>
                )}
                {s.text}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={checked.size === 0}
          onClick={() => onConfirm([...checked])}
          className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 font-medium hover:opacity-90 disabled:opacity-50"
        >
          {t("action.reopenSelected", voice)}
        </button>
        <button
          type="button"
          onClick={() => onConfirm(undefined)}
          className="hover:bg-accent rounded-md border px-2.5 py-1"
        >
          {t("action.reopenAll", voice)}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-muted-foreground hover:text-foreground rounded-md px-2.5 py-1"
        >
          {t("action.cancel", voice)}
        </button>
      </div>
    </div>
  );
}

/** Drop zone wrapper around a bucket's body — used by both the To-Do buckets
 * and the Needs-review region so drag has a target everywhere the menu does. */
function DroppableBucket({
  id,
  children,
}: {
  id: BucketId;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      data-bucket={id}
      className={cn("rounded-lg", isOver && "ring-primary ring-2")}
    >
      {children}
    </div>
  );
}

/** Drag handle for a single item card — the pointer/keyboard-accessible grip
 * dnd-kit binds `useDraggable` listeners to. */
function DragGrip({ id, label }: { id: string; label: string }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id });
  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      aria-label={`Drag ${label}`}
      // Narrow gutter (28px wide × 44px tall) so the title tucks in to the left
      // instead of floating past a full 44px-square grip. 28px keeps the target
      // width ≥ the WCAG-AA 24px minimum (2.5.8); full 44px height preserved.
      className="text-muted-foreground hover:text-foreground inline-flex min-h-11 w-7 shrink-0 cursor-grab touch-none items-center justify-center text-xs"
    >
      ⠿
    </button>
  );
}

/** Floating ghost rendered inside the `DragOverlay` while a row is being
 * dragged (#26/#62). Deliberately its own component (rather than inline
 * JSX) so it can be unit-tested in isolation from dnd-kit's drag lifecycle —
 * jsdom can't reproduce the real-browser layout bug (#62) this guards
 * against, but it can assert the markup never relies on a fixed narrow
 * width and lets the title wrap normally instead of one-character-per-line. */
export function DragGhostRow({ text }: { text: string }) {
  return (
    <div className="bg-background ring-primary/40 pointer-events-none flex w-[min(90vw,28rem)] scale-[1.02] items-start gap-2 rounded-lg border px-4 py-3 shadow-lg ring-2">
      <span
        aria-hidden="true"
        className="text-muted-foreground inline-flex w-7 shrink-0 items-center justify-center text-xs"
      >
        ⠿
      </span>
      <span className="min-w-0 flex-1 text-sm break-words">{text}</span>
    </div>
  );
}

/** Empty-state placeholder shown inside a bucket that has no items. */
function EmptyBucket({ voice }: { voice: Voice }) {
  return (
    <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-4 text-center text-xs">
      {t("bucket.empty", voice)}
    </p>
  );
}

function ItemRow({
  item,
  settings,
  voice,
  now,
  isDragging,
  onBreakdown,
  onKeep,
  onSaveForLater,
  onSnooze,
  onComplete,
  confirmingDelete,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  onFreshen,
  onDismissPrompt,
  schedule,
  scheduled = false,
  icsMenu,
  scheduleError,
  moveMenu,
  moveIcon,
  dragGrip,
  editButton,
  editMenuItem,
  titleEditor,
}: {
  item: Item;
  settings: AgingSettings;
  voice: Voice;
  now: number;
  isDragging?: boolean;
  onBreakdown: () => void;
  onKeep: () => void;
  /** "Save for later" — a direct MOVE to the Saved bucket, dispatched through
   * the same `moveItemToBucket` path drag and MoveToMenu use. */
  onSaveForLater: () => void;
  /** "Snooze 1h" (▾-menu only) — the literal-duration snooze action, kept
   * SEPARATE from the Save-for-later bucket move. */
  onSnooze: () => void;
  onComplete: () => void;
  confirmingDelete: boolean;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onFreshen: () => void;
  onDismissPrompt: () => void;
  schedule: ScheduleControlProps | null;
  /** Renders the "Scheduled ✓" indicator when the row's task has a scheduledAt marker. */
  scheduled?: boolean;
  /** Owner-only ▾ "Add to calendar (.ics)" entry, rendered after the schedule
   *  mirror. Null for guests (whose primary control is already the ICS one). */
  icsMenu?: React.ReactNode;
  scheduleError?: string;
  moveMenu?: React.ReactNode;
  /** v6: 📥 Move-to icon for the end cluster (compact MoveToMenu). */
  moveIcon?: React.ReactNode;
  dragGrip?: React.ReactNode;
  editButton?: React.ReactNode;
  /** v6: "Edit task title" text entry for the ▾ dropdown (title line keeps editButton). */
  editMenuItem?: React.ReactNode;
  titleEditor?: React.ReactNode;
}) {
  const aging = isAging(item.createdAt, settings);
  const tier = freshnessTier(item.createdAt, item.freshenedAt, settings);
  const showStillNeededPrompt = shouldPrompt24h(
    item.createdAt,
    item.freshenedAt,
    item.promptDismissedAt,
    settings,
  );
  // v5: 🗑 delete appears twice — once inline in the end cluster, once as a
  // duplicate ▾-menu entry — both driven by the same confirmingDelete state.
  const deleteControl = (
    key: string,
    { fullWidth = false, icon = false } = {},
  ) =>
    confirmingDelete ? (
      <span key={key} className="flex items-center gap-2">
        <button
          onClick={onConfirmDelete}
          className="text-destructive rounded-md px-2.5 py-1 font-medium"
        >
          {t("action.delete", voice)}
        </button>
        <span className="text-muted-foreground">·</span>
        <button
          onClick={onCancelDelete}
          className="text-muted-foreground hover:text-foreground rounded-md px-2.5 py-1"
        >
          {t("action.cancel", voice)}
        </button>
      </span>
    ) : icon ? (
      <button
        key={key}
        aria-label={t("action.delete", voice)}
        title={t("action.delete", voice)}
        className={cn(
          // End-cluster icon — ghost hover + a slightly bigger glyph, same
          // treatment as 📅/▾/📥 (owner: mobile icons read too tiny). Also
          // picks up the ≥44px touchTarget this variant was missing.
          "text-muted-foreground hover:bg-accent hover:text-destructive rounded-md px-2 py-1 text-sm",
          touchTarget,
        )}
        onClick={onRequestDelete}
      >
        🗑
      </button>
    ) : (
      <button
        key={key}
        className={cn(
          "text-muted-foreground hover:text-destructive rounded-md px-2.5 py-1",
          fullWidth && "hover:bg-accent hover:text-foreground w-full text-left",
        )}
        onClick={onRequestDelete}
      >
        {t("action.delete", voice)}
      </button>
    );
  return (
    <li
      className={cn("rounded-lg border px-4 py-3", isDragging && "opacity-40")}
    >
      <div className="flex items-start gap-2">
        {dragGrip}
        <div className="min-w-0 flex-1 space-y-1">
          {/* #51: the title is the dominant text — larger + heavier than the
              metadata line below it. */}
          <div className="flex items-center gap-2">
            {titleEditor ?? (
              <>
                <span className="text-lg font-semibold break-words">
                  {item.text}
                </span>
                {editButton}
              </>
            )}
          </div>
          {/* #52: the age/status pill is demoted off the title line down onto
              the metadata line, left of "captured x ago", at meta size. */}
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <StatusPill tier={tier} voice={voice} size="meta" />
            <span aria-hidden="true" className="text-muted-foreground text-xs">
              ·
            </span>
            <AgeLabel createdAt={item.createdAt} aging={aging} now={now} />
          </div>
          {/* #57 (follow-up to #50): a tinted "notification chip" — a compact
          rounded row with a soft aging/amber tint + subtle border and a clock
          icon, so the stale nudge reads as a notification instead of the muted
          background-noise text #50 left behind. Reuses the #40 aging/amber
          token family (the same bg/border/ink the resume-step banner + focus
          callouts use), so it stays WCAG-AA in light AND dark with no invented
          colours. Sits below the metadata line, above the action row, and stays
          subordinate to the text-lg title (text-sm, compact padding — no heavy
          box, the #50 lesson). Still-need-it / Dismiss keep ≥44px hit targets
          (touchTarget) and full keyboard access; the "Still need it" handler is
          unchanged (onFreshen → freshenItem), likewise Dismiss (dismissPrompt). */}
          {showStillNeededPrompt && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-amber-500/40 bg-amber-50 px-2.5 py-1 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
              <Clock aria-hidden="true" className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                {t("prompt.stillNeeded", voice)}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <button
                  onClick={onFreshen}
                  className={cn(
                    "rounded-md border border-amber-500/40 px-2.5 font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40",
                    touchTarget,
                  )}
                >
                  {t("action.stillNeeded", voice)}
                </button>
                <button
                  onClick={onDismissPrompt}
                  className={cn(
                    "rounded-md px-2 font-medium hover:underline",
                    touchTarget,
                  )}
                >
                  {t("action.dismiss", voice)}
                </button>
              </span>
            </div>
          )}
          <RowActions
            inline={[
              <button
                key="breakdown"
                onClick={onBreakdown}
                className="bg-primary text-primary-foreground hover:opacity-90 rounded-md px-2.5 py-1 font-medium"
              >
                {t("action.breakdown", voice)} →
              </button>,
              <button
                key="keep"
                onClick={onKeep}
                className="hover:bg-accent rounded-md px-2.5 py-1 font-medium"
              >
                {t("action.addTodo", voice)}
              </button>,
              <button
                key="save-for-later"
                onClick={onSaveForLater}
                className="hover:bg-accent rounded-md px-2.5 py-1 font-medium"
              >
                {t("action.saveShort", voice)}
              </button>,
              <CompleteButton
                key="complete"
                voice={voice}
                onClick={onComplete}
              />,
            ]}
            move={moveIcon}
            schedule={schedule}
            scheduled={scheduled}
            del={deleteControl("delete", { icon: true })}
            menu={[
              moveMenu,
              <button
                key="breakdown-m"
                onClick={onBreakdown}
                className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
              >
                {t("action.breakdownFull", voice)}
              </button>,
              <button
                key="keep-m"
                onClick={onKeep}
                className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
              >
                {t("action.addTodoFull", voice)}
              </button>,
              <button
                key="save-for-later-m"
                onClick={onSaveForLater}
                className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
              >
                {t("action.saveForLater", voice)}
              </button>,
              <button
                key="complete-m"
                onClick={onComplete}
                className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
              >
                {t("action.completeFull", voice)}
              </button>,
              // "Snooze 1h" lives only here (▾ menu) — a SEPARATE action from
              // "Save for later": snooze is the literal 1-hour timer
              // (snoozeBrainDumpItem), Save for later is a direct move to the
              // Saved bucket via the shared moveItemToBucket dispatcher.
              <button
                key="snooze-m"
                onClick={onSnooze}
                className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
              >
                Snooze 1h
              </button>,
              schedule ? (
                <ScheduleControl
                  key="schedule-m"
                  {...schedule}
                  variant="menu"
                  label={scheduleMenuLabel(schedule.state, voice)}
                />
              ) : null,
              icsMenu,
              editMenuItem,
              deleteControl("delete-m", { fullWidth: true }),
            ]}
          />
          {scheduleError && (
            <p className="text-destructive mt-1 text-xs">{scheduleError}</p>
          )}
        </div>
      </div>
    </li>
  );
}

function AgeLabel({
  createdAt,
  aging,
  now,
}: {
  createdAt: Date;
  aging: boolean;
  now: number;
}) {
  const ms = now - new Date(createdAt).getTime();
  const label = formatAgo(ms);
  return (
    <p
      className={cn(
        "text-xs",
        // AA-tuned per theme (WCAG 4.5:1 in BOTH light and dark), matching the
        // aging freshness tier in status-pill.tsx. The old flat `text-amber-600`
        // dropped to 3:1 on the #40 warm-tinted light background — a serious
        // color-contrast failure that only surfaces once a row ages (the axe
        // gate scans fresh items), exposed alongside the #57 stale nudge.
        aging ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
      )}
    >
      captured {label}
    </p>
  );
}
/**
 * Persistent "N need triage" badge. Dismissable (✕); once dismissed it stays
 * hidden until a new item is captured or an item crosses into Aging (tracked
 * against the previous counts). Dismissal is not persisted, so it resets on
 * reload — matching the spec.
 */
function NavBadge({
  untriagedCount,
  agingCount,
}: {
  untriagedCount: number;
  agingCount: number;
}) {
  const [dismissed, setDismissed] = useState(false);
  const prev = useRef({ untriaged: untriagedCount, aging: agingCount });

  useEffect(() => {
    if (
      untriagedCount > prev.current.untriaged ||
      agingCount > prev.current.aging
    ) {
      setDismissed(false);
    }
    prev.current = { untriaged: untriagedCount, aging: agingCount };
  }, [untriagedCount, agingCount]);

  if (dismissed || untriagedCount === 0) return null;

  return (
    <div className="bg-secondary flex items-center justify-between rounded-lg px-3 py-2 text-sm">
      <span>
        <strong>{untriagedCount}</strong> need triage
        {/* amber-800 (not -700) in light: this count sits on the more saturated
            `bg-secondary` lavender, where -700 lands at 4.36:1 — just under
            AA-normal. dark:-400 matches the aging tier elsewhere. */}
        {agingCount > 0 && (
          <span className="text-amber-800 dark:text-amber-400">
            {" "}
            · {agingCount} aging 🟡
          </span>
        )}
      </span>
      <button
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        className="text-muted-foreground hover:text-foreground px-1"
      >
        ✕
      </button>
    </div>
  );
}
