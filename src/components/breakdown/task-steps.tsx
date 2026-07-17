"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { extractStepToInbox } from "@/app/actions/breakdown";
import { completeStep, renameStep, updateStepEstimate } from "@/app/actions/focus";
import { CompleteButton } from "@/components/inbox/complete-button";
import { RowActions } from "@/components/inbox/row-actions";
import { useVoice } from "@/components/voice-provider";
import { t, type Voice } from "@/lib/strings";
import { cn } from "@/lib/utils";

export type TaskStepRow = {
  id: string;
  order: number;
  total: number;
  text: string;
  subtaskEmoji: string | null;
  estMinutes: number;
  done: boolean;
  /** True when the step has an unfinished FocusSession (started, never ended) —
   * surfaces "Resume Focus" instead of "Start Focus". NOTE: this is the
   * "unfinished session" heuristic, not a true pause/resume (see #25). */
  resumable: boolean;
};

/**
 * Interactive working-view step list. Each NOT-done row mirrors the inbox
 * ItemRow: a title line (order/total + emoji + text + estimate) above an action
 * line (Complete · Start/Resume Focus · a 🔽 dropdown of every option), reusing
 * the shared CompleteButton + RowActions v6 pattern. Sending a step "back to
 * review" extracts it to the inbox as its own bigger task; extracting the last
 * step empties the task, so we surface a chooser (re-plan with AI / manually /
 * keep as a single to-do) instead of leaving an empty task.
 */
export function TaskSteps({
  taskId,
  steps,
  voice: voiceProp,
}: {
  taskId: string;
  steps: TaskStepRow[];
  /** Resolved voice. Inbox passes its own; the tasks-page subtree resolves it
   * from the layout's VoiceProvider via `useVoice()` below. */
  voice?: Voice;
}) {
  const contextVoice = useVoice();
  const voice = voiceProp ?? contextVoice;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [emptied, setEmptied] = useState(false);
  // At most one step edits its title / estimate inline at a time.
  const [editTitleId, setEditTitleId] = useState<string | null>(null);
  const [editEstId, setEditEstId] = useState<string | null>(null);

  function sendToReview(stepId: string) {
    start(async () => {
      const res = await extractStepToInbox(stepId);
      if (!res) return;
      if (res.remaining === 0) setEmptied(true);
      else router.refresh();
    });
  }

  const complete = (stepId: string) =>
    start(async () => {
      await completeStep(stepId);
      router.refresh();
    });

  const rename = (stepId: string, title: string) =>
    start(async () => {
      await renameStep(stepId, title);
      router.refresh();
    });

  const updateEstimate = (stepId: string, minutes: number) =>
    start(async () => {
      await updateStepEstimate(stepId, minutes);
      router.refresh();
    });

  if (emptied) {
    return (
      <div className="space-y-3 rounded-lg border border-dashed p-4">
        <p className="text-sm font-medium">
          That was the last step — this task is empty now. What next?
        </p>
        <div className="flex flex-wrap gap-2 text-sm">
          <button
            onClick={() => router.push(`/tasks/${taskId}`)}
            className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 font-medium"
          >
            Re-plan with AI
          </button>
          <button
            onClick={() => router.push(`/tasks/${taskId}?edit=1&manual=1`)}
            className="hover:bg-accent rounded-md border px-3 py-1.5"
          >
            Re-plan manually
          </button>
          <button
            onClick={() => router.push("/inbox")}
            className="hover:bg-accent rounded-md border px-3 py-1.5"
          >
            Keep as single to-do
          </button>
        </div>
      </div>
    );
  }

  return (
    <ol className={cn("space-y-2", pending && "opacity-70")}>
      {steps.map((s) => {
        if (s.done) {
          // Done steps keep the completed state (strikethrough + ✓) with no
          // focus/complete actions.
          return (
            <li
              key={s.id}
              className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm"
            >
              <span className="text-muted-foreground w-8 text-xs tabular-nums">
                {s.order}/{s.total}
              </span>
              <span className="text-muted-foreground flex-1 line-through">
                {s.subtaskEmoji ? `${s.subtaskEmoji} ` : ""}
                {s.text}
              </span>
              <span className="text-muted-foreground text-xs">{s.estMinutes}m</span>
              <span className="text-green-600" title="done" aria-label="done">
                ✓
              </span>
            </li>
          );
        }

        const editingTitle = editTitleId === s.id;
        const editingEst = editEstId === s.id;
        const focusLabel = t(s.resumable ? "step.resumeFocus" : "step.startFocus", voice);
        const focusMenuLabel = t(
          s.resumable ? "step.resumeFocusTimer" : "step.startFocusTimer",
          voice,
        );
        return (
          <li key={s.id} className="rounded-lg border px-3 py-2 text-sm">
            {/* Title line — mirrors the inbox ItemRow's title row. */}
            <div className="flex items-center gap-3">
              <span className="text-muted-foreground w-8 shrink-0 text-xs tabular-nums">
                {s.order}/{s.total}
              </span>
              {editingTitle ? (
                <StepTitleInput
                  initial={s.text}
                  onSave={(value) => {
                    setEditTitleId(null);
                    if (value && value !== s.text) rename(s.id, value);
                  }}
                  onCancel={() => setEditTitleId(null)}
                />
              ) : (
                <span className="min-w-0 flex-1 break-words">
                  {s.subtaskEmoji ? `${s.subtaskEmoji} ` : ""}
                  {s.text}{" "}
                  <button
                    type="button"
                    aria-label={`Edit ${s.text}`}
                    onClick={() => {
                      setEditEstId(null);
                      setEditTitleId(s.id);
                    }}
                    className="text-muted-foreground hover:text-foreground shrink-0 px-1 text-xs"
                  >
                    ✏️
                  </button>
                </span>
              )}
              {editingEst ? (
                <StepEstimateInput
                  initial={s.estMinutes}
                  onSave={(minutes) => {
                    setEditEstId(null);
                    if (Number.isFinite(minutes)) updateEstimate(s.id, minutes);
                  }}
                  onCancel={() => setEditEstId(null)}
                />
              ) : (
                <span className="text-muted-foreground shrink-0 text-xs">{s.estMinutes}m</span>
              )}
            </div>
            {/* Action line — shared v6 RowActions: Complete + Start/Resume Focus
                inline, everything (state-dependent) in the 🔽 dropdown. */}
            <RowActions
              inline={[
                <Link
                  key="focus"
                  href={`/focus/${s.id}`}
                  className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 font-medium hover:opacity-90"
                >
                  {focusLabel}
                </Link>,
                <CompleteButton key="complete" voice={voice} onClick={() => complete(s.id)} />,
              ]}
              menu={[
                <Link
                  key="focus-m"
                  href={`/focus/${s.id}`}
                  className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                >
                  {focusMenuLabel}
                </Link>,
                <button
                  key="complete-m"
                  type="button"
                  onClick={() => complete(s.id)}
                  className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                >
                  {t("step.complete", voice)}
                </button>,
                <button
                  key="edit-est-m"
                  type="button"
                  onClick={() => {
                    setEditTitleId(null);
                    setEditEstId(s.id);
                  }}
                  className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                >
                  {t("step.editEstimate", voice)}
                </button>,
                <button
                  key="edit-title-m"
                  type="button"
                  onClick={() => {
                    setEditEstId(null);
                    setEditTitleId(s.id);
                  }}
                  className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                >
                  {t("step.editTitle", voice)}
                </button>,
                <button
                  key="review-m"
                  type="button"
                  onClick={() => sendToReview(s.id)}
                  className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                >
                  {t("step.sendToReview", voice)}
                </button>,
              ]}
            />
          </li>
        );
      })}
    </ol>
  );
}

/** Inline step-title editor — mirrors inbox-view's EditTitleInput. Enter saves
 * (trimmed), Escape cancels. */
function StepTitleInput({
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
      aria-label="Edit step title"
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

/** Inline time-estimate editor — a 1..480 number input. Enter saves (server
 * rounds + clamps), Escape cancels. */
function StepEstimateInput({
  initial,
  onSave,
  onCancel,
}: {
  initial: number;
  onSave: (minutes: number) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(String(initial));
  return (
    <input
      autoFocus
      type="number"
      min={1}
      max={480}
      step={1}
      value={value}
      aria-label="Edit time estimate"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          // Empty / non-positive input → cancel, don't save. `Number("")` is 0
          // and passes isFinite, which would otherwise be clamped to 1 (Duo review).
          const n = Number(value);
          if (value.trim() === "" || !Number.isFinite(n) || n < 1 || n > 480) onCancel();
          else onSave(n);
        }
        if (e.key === "Escape") onCancel();
      }}
      className="border-input bg-background focus-visible:ring-ring w-16 rounded-md border px-2 py-1 text-xs outline-none focus-visible:ring-2"
    />
  );
}
