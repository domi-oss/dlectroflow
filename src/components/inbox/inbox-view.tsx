"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
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
} from "@/app/actions/braindump";
import { startBreakdown } from "@/app/actions/breakdown";
import { StatusPill } from "@/components/inbox/status-pill";
import { TaskSteps } from "@/components/breakdown/task-steps";
import { bucketItems, bucketOfItem, isBucketId, type Item, type BucketId } from "@/components/inbox/bucket";
import { dropPlan } from "@/components/inbox/move-dispatch";
import { MoveToMenu } from "@/components/inbox/move-to-menu";
import { MultiStepDropPrompt } from "@/components/inbox/multi-step-drop-prompt";
import { t } from "@/lib/strings";
import { useVoice } from "@/components/voice-provider";
import type { Voice } from "@/lib/strings";
import {
  notificationPermission,
  requestNotificationPermission,
  registerServiceWorker,
  showReminder,
} from "@/lib/notifications";

/** Map a dnd-kit drop onto a bucket to a move intent (null when dropped nowhere). */
export function dragEndToMove(
  activeId: string,
  overId: string | null,
): { itemId: string; target: BucketId } | null {
  if (!overId || !isBucketId(overId)) return null;
  return { itemId: activeId, target: overId };
}

// Deep-link targets for each section's "see all →" link (Library, Task 10+).
const SEE_ALL = {
  singleTask: "/library?tab=plated",
  multiStep: "/library?tab=sorted",
  savedLater: "/library?tab=pantry",
} as const;

export function InboxView({
  initialItems,
  settings,
}: {
  initialItems: Item[];
  settings: AgingSettings;
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

  // Tick so relative ages + aging state recompute live.
  const [, setTick] = useState(0);
  useEffect(() => {
    const ms = Math.min(effectiveAgingMs(settings), 15_000);
    const id = setInterval(() => setTick((t) => t + 1), Math.max(1000, ms / 4));
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

  // Notifications: register the service worker + track permission.
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >("default");
  const notifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    registerServiceWorker();
    setPermission(notificationPermission());
  }, []);

  const enableReminders = () =>
    requestNotificationPermission().then((p) => setPermission(p));

  const now = Date.now();
  const { needsReview, singleTask, multiStep, savedLater, completed, completedTodayCount } =
    bucketItems(initialItems, now);

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
  }, [needsReview, permission, settings, router]);

  const run = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      await fn();
      router.refresh();
    });

  const breakdown = (id: string) =>
    startTransition(async () => {
      const taskId = await startBreakdown(id);
      if (taskId) router.push(`/tasks/${taskId}`);
    });

  // Drag (dnd-kit) + the "Move to…" menu share this single dispatcher so the
  // two paths can never diverge (Task 10).
  const [pendingBreakdown, setPendingBreakdown] = useState<
    { item: Item; reopenFirst: boolean } | null
  >(null);
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor));
  const itemsById = new Map(initialItems.map((i) => [i.id, i]));

  const moveItemToBucket = (itemId: string, target: BucketId) => {
    const item = itemsById.get(itemId);
    if (!item) return;
    const plan = dropPlan(bucketOfItem(item, now), target);
    if (plan.kind === "noop") return;

    if (plan.prompt) {
      // Multi-step target: ask break-now vs save first. The reopen (needed
      // when the source is Completed, so it leaves Completed) is deferred
      // into the prompt's own confirm handlers so Cancel/Escape is a true
      // no-op instead of reopening the item before the user decides.
      setPendingBreakdown({ item, reopenFirst: plan.reopenFirst });
      return;
    }

    run(async () => {
      if (plan.reopenFirst) await reopenItem(itemId, undefined);
      switch (plan.action) {
        case "moveToReview": await moveToReview(itemId); break;
        case "triage":       await triageBrainDumpItem(itemId); break;
        case "snooze":       await snoozeBrainDumpItem(itemId, 60); break;
        case "complete":     await completeItem(itemId); break;
        // "breakdown" is handled by the prompt branch above.
      }
    });
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const move = dragEndToMove(String(e.active.id), e.over ? String(e.over.id) : null);
    if (move) moveItemToBucket(move.itemId, move.target);
  };

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

  return (
    <div className="space-y-6">
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
          placeholder="Brain dump anything… (Enter to save, / to focus)"
          className="border-input bg-background focus-visible:ring-ring w-full rounded-lg border px-4 py-3 text-base shadow-sm outline-none focus-visible:ring-2"
          autoFocus
        />
        <p className="text-muted-foreground px-1 text-xs">
          No fields required. Press Enter to capture instantly.
        </p>
        {justCaptured && (
          <p role="status" className="px-1 text-xs text-emerald-600">
            {t("capture.confirm", voice)}
          </p>
        )}
      </div>

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        {/* Needs review */}
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
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
                {needsReview.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    settings={settings}
                    voice={voice}
                    onBreakdown={() => breakdown(item.id)}
                    onKeep={() => run(() => keepAsTask(item.id))}
                    onSnooze={() => run(() => snoozeBrainDumpItem(item.id, 60))}
                    onComplete={() => run(() => completeItem(item.id))}
                    confirmingDelete={confirmDeleteId === item.id}
                    onRequestDelete={() => requestDelete(item.id)}
                    onConfirmDelete={() => confirmDelete(item.id)}
                    onCancelDelete={cancelDelete}
                    onFreshen={() => run(() => freshenItem(item.id))}
                    onDismissPrompt={() => run(() => dismissPrompt(item.id))}
                    moveMenu={
                      <MoveToMenu
                        currentBucket={bucketOfItem(item, now)}
                        voice={voice}
                        onMove={(target) => moveItemToBucket(item.id, target)}
                      />
                    }
                    dragGrip={<DragGrip id={item.id} label={item.text} />}
                  />
                ))}
              </ul>
            )}
          </DroppableBucket>
        </section>

        {/* To-Do board — four always-visible buckets (Phase B) */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold">{t("section.toDo", voice)}</h2>

          {/* Multi-step */}
          <div>
            <SubHeader label={t("section.multiStep", voice)} count={multiStep.length} seeAllHref={SEE_ALL.multiStep} voice={voice} />
            <DroppableBucket id="multiStep">
              {/* Spec: the drop prompt is anchored to the drop — it renders inside
                  this bucket so it appears where the user just dropped. */}
              {pendingBreakdown && (
                <div className="mb-2">
                  <MultiStepDropPrompt
                    itemText={pendingBreakdown.item.text}
                    voice={voice}
                    onBreakNow={() => {
                      const { item, reopenFirst } = pendingBreakdown;
                      setPendingBreakdown(null);
                      startTransition(async () => {
                        if (reopenFirst) await reopenItem(item.id, undefined);
                        const taskId = await startBreakdown(item.id);
                        if (taskId) router.push(`/tasks/${taskId}`);
                      });
                    }}
                    onSaveLater={() => {
                      const { item, reopenFirst } = pendingBreakdown;
                      setPendingBreakdown(null);
                      run(async () => {
                        if (reopenFirst) await reopenItem(item.id, undefined);
                        await snoozeBrainDumpItem(item.id, 60);
                      });
                    }}
                    onCancel={() => setPendingBreakdown(null)}
                  />
                </div>
              )}
              {multiStep.length === 0 ? (
                <EmptyBucket voice={voice} />
              ) : (
                <ul className={cn("space-y-2", pending && "opacity-70")}>
                  {multiStep.map((item) => {
                    /* multi-step row — extended in Task 9 (step count + expand) and Task 10 (drag/menu) */
                    const expanded = expandedId === item.id;
                    return (
                      <li key={item.id} className="rounded-lg border px-4 py-2 text-sm">
                        <div className="flex items-center justify-between gap-3">
                          <DragGrip id={item.id} label={item.text} />
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => setExpandedId(expanded ? null : item.id)}
                            className="min-w-0 flex-1 break-words text-left hover:underline"
                          >
                            {item.text}
                          </button>
                          <span className="flex shrink-0 items-center gap-2 text-xs">
                            <span className="text-muted-foreground">
                              {item.stepsTotal} steps · {item.stepsDone} {t("progress.done", voice)}
                            </span>
                            <MoveToMenu
                              currentBucket={bucketOfItem(item, now)}
                              voice={voice}
                              onMove={(target) => moveItemToBucket(item.id, target)}
                            />
                            <button className="hover:bg-accent rounded-md border px-2.5 py-1" onClick={() => run(() => completeItem(item.id))}>
                              {t("action.complete", voice)}
                            </button>
                          </span>
                        </div>
                        {expanded && item.taskId && (
                          <div className="mt-2">
                            <TaskSteps
                              taskId={item.taskId}
                              steps={item.steps.map((s) => ({
                                id: s.id,
                                order: s.order,
                                total: item.stepsTotal,
                                text: s.text,
                                subtaskEmoji: s.subtaskEmoji,
                                estMinutes: s.estMinutes,
                                done: s.done,
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
            <SubHeader label={t("section.singleTask", voice)} count={singleTask.length} seeAllHref={SEE_ALL.singleTask} voice={voice} />
            <DroppableBucket id="singleTask">
              {singleTask.length === 0 ? (
                <EmptyBucket voice={voice} />
              ) : (
                <ul className={cn("space-y-2", pending && "opacity-70")}>
                  {singleTask.map((item) => (
                    <li key={item.id} className="flex items-center justify-between rounded-lg border px-4 py-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <DragGrip id={item.id} label={item.text} />
                        <span className="text-primary shrink-0 text-xs font-medium">{t("pill.toDo", voice)}</span>
                        <span className="break-words">{item.text}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-xs">
                        <MoveToMenu
                          currentBucket={bucketOfItem(item, now)}
                          voice={voice}
                          onMove={(target) => moveItemToBucket(item.id, target)}
                        />
                        <button className="hover:bg-accent rounded-md border px-2.5 py-1" onClick={() => run(() => completeItem(item.id))}>
                          {t("action.complete", voice)}
                        </button>
                        {confirmDeleteId === item.id ? (
                          <span className="flex items-center gap-2">
                            <button className="text-destructive font-medium" onClick={() => confirmDelete(item.id)}>{t("action.delete", voice)}</button>
                            <span className="text-muted-foreground">·</span>
                            <button className="text-muted-foreground hover:text-foreground" onClick={cancelDelete}>{t("action.cancel", voice)}</button>
                          </span>
                        ) : (
                          <button className="text-muted-foreground hover:text-destructive" onClick={() => requestDelete(item.id)}>{t("action.delete", voice)}</button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </DroppableBucket>
          </div>

          {/* Saved for later */}
          <div>
            <SubHeader label={t("section.savedLater", voice)} count={savedLater.length} seeAllHref={SEE_ALL.savedLater} voice={voice} />
            <DroppableBucket id="savedLater">
              {savedLater.length === 0 ? (
                <EmptyBucket voice={voice} />
              ) : (
                <ul className="space-y-2 opacity-70">
                  {savedLater.map((item) => (
                    <li key={item.id} className="flex items-center justify-between rounded-lg border px-4 py-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <DragGrip id={item.id} label={item.text} />
                        <span className="break-words">{item.text}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <MoveToMenu
                          currentBucket={bucketOfItem(item, now)}
                          voice={voice}
                          onMove={(target) => moveItemToBucket(item.id, target)}
                        />
                        <button className="text-muted-foreground hover:text-foreground shrink-0 text-xs underline" onClick={() => run(() => triageBrainDumpItem(item.id))}>
                          wake now
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </DroppableBucket>
          </div>

          {/* Completed */}
          <div>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              {t("section.completed", voice)}
              <span className="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-xs">
                {t("section.completedToday", voice)}: {completedTodayCount}
              </span>
              <a href="/library?tab=done" className="text-muted-foreground hover:text-foreground ml-auto text-xs font-normal">
                {t("link.seeAll", voice)}
              </a>
            </h2>
            <DroppableBucket id="completed">
              {completed.length === 0 ? (
                <EmptyBucket voice={voice} />
              ) : (
                <ul className="space-y-2 opacity-80">
                  {completed.map((item) => (
                    <li key={item.id} className="flex items-center justify-between rounded-lg border px-4 py-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <DragGrip id={item.id} label={item.text} />
                        <span className="break-words line-through">{item.text}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <MoveToMenu
                          currentBucket={bucketOfItem(item, now)}
                          voice={voice}
                          onMove={(target) => moveItemToBucket(item.id, target)}
                        />
                        <button className="text-muted-foreground hover:text-foreground shrink-0 text-xs underline" onClick={() => run(() => reopenItem(item.id, undefined))}>
                          {t("action.reopen", voice)}
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </DroppableBucket>
          </div>
        </section>
      </DndContext>
    </div>
  );
}

/** Drop zone wrapper around a bucket's body — used by both the To-Do buckets
 * and the Needs-review region so drag has a target everywhere the menu does. */
function DroppableBucket({ id, children }: { id: BucketId; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} data-bucket={id} className={cn("rounded-lg", isOver && "ring-primary ring-2")}>
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
      className="text-muted-foreground hover:text-foreground shrink-0 cursor-grab px-1 text-xs"
    >
      ⠿
    </button>
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

/** Sub-bucket heading: label + count badge + a "see all →" deep-link. */
function SubHeader({
  label,
  count,
  seeAllHref,
  voice,
}: {
  label: string;
  count: number;
  seeAllHref: string;
  voice: Voice;
}) {
  return (
    <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
      <span>{label}</span>
      <span className="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-xs">
        {count}
      </span>
      <a
        href={seeAllHref}
        className="text-muted-foreground hover:text-foreground ml-auto text-xs font-normal"
      >
        {t("link.seeAll", voice)}
      </a>
    </div>
  );
}

function ItemRow({
  item,
  settings,
  voice,
  onBreakdown,
  onKeep,
  onSnooze,
  onComplete,
  confirmingDelete,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  onFreshen,
  onDismissPrompt,
  moveMenu,
  dragGrip,
}: {
  item: Item;
  settings: AgingSettings;
  voice: Voice;
  onBreakdown: () => void;
  onKeep: () => void;
  onSnooze: () => void;
  onComplete: () => void;
  confirmingDelete: boolean;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onFreshen: () => void;
  onDismissPrompt: () => void;
  moveMenu?: React.ReactNode;
  dragGrip?: React.ReactNode;
}) {
  const aging = isAging(item.createdAt, settings);
  const tier = freshnessTier(item.createdAt, item.freshenedAt, settings);
  const showStillNeededPrompt = shouldPrompt24h(
    item.createdAt,
    item.freshenedAt,
    item.promptDismissedAt,
    settings,
  );
  return (
    <li className="rounded-lg border px-4 py-3">
      <div className="flex items-start gap-3">
        {dragGrip}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <StatusPill tier={tier} voice={voice} />
            <span className="break-words">{item.text}</span>
          </div>
          <AgeLabel createdAt={item.createdAt} aging={aging} />
        </div>
      </div>
      {showStillNeededPrompt && (
        <div
          className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs"
          style={{ backgroundColor: "#fff5f5", borderColor: "#c0392b", color: "#c0392b" }}
        >
          <span>{t("prompt.stillNeeded", voice)}</span>
          <span className="flex shrink-0 items-center gap-2">
            <button
              onClick={onFreshen}
              className="rounded-md border px-2 py-1 font-medium"
              style={{ borderColor: "#c0392b", color: "#c0392b" }}
            >
              {t("action.stillNeeded", voice)}
            </button>
            <button
              onClick={onDismissPrompt}
              className="rounded-md border px-2 py-1 font-medium"
              style={{ borderColor: "#c0392b", color: "#c0392b" }}
            >
              {t("action.dismiss", voice)}
            </button>
          </span>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <button
          onClick={onBreakdown}
          className="bg-primary text-primary-foreground hover:opacity-90 rounded-md px-2.5 py-1 font-medium"
        >
          {t("action.breakdown", voice)} →
        </button>
        <button
          onClick={onKeep}
          className="hover:bg-accent rounded-md border px-2.5 py-1"
        >
          {t("action.addTodo", voice)}
        </button>
        <button
          onClick={onSnooze}
          className="hover:bg-accent rounded-md border px-2.5 py-1"
        >
          {t("action.saveForLater", voice)}
        </button>
        <button
          onClick={onComplete}
          className="hover:bg-accent rounded-md border px-2.5 py-1"
        >
          {t("action.complete", voice)}
        </button>
        {moveMenu}
        {confirmingDelete ? (
          <span className="ml-auto flex items-center gap-2">
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
        ) : (
          <button
            onClick={onRequestDelete}
            className="text-muted-foreground hover:text-destructive ml-auto rounded-md px-2.5 py-1"
          >
            {t("action.delete", voice)}
          </button>
        )}
      </div>
    </li>
  );
}

function AgeLabel({ createdAt, aging }: { createdAt: Date; aging: boolean }) {
  const ms = Date.now() - new Date(createdAt).getTime();
  const label = formatAgo(ms);
  return (
    <p className={cn("text-xs", aging ? "text-amber-600" : "text-muted-foreground")}>
      captured {label}
    </p>
  );
}

function formatAgo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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
        {agingCount > 0 && (
          <span className="text-amber-600"> · {agingCount} aging 🟡</span>
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
