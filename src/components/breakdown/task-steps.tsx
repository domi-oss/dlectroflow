"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { extractStepToInbox } from "@/app/actions/breakdown";
import { cn } from "@/lib/utils";

export type TaskStepRow = {
  id: string;
  order: number;
  total: number;
  text: string;
  subtaskEmoji: string | null;
  estMinutes: number;
  done: boolean;
};

/**
 * Interactive working-view step list. Each row can be focused (▶) or sent back
 * to the inbox "needs review" bucket (↗) as its own bigger task. Extracting the
 * last step empties the task, so we surface a chooser (re-plan with AI /
 * manually / keep as a single-task to-do) instead of leaving an empty task.
 */
export function TaskSteps({
  taskId,
  steps,
}: {
  taskId: string;
  steps: TaskStepRow[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [emptied, setEmptied] = useState(false);

  function sendToReview(stepId: string) {
    start(async () => {
      const res = await extractStepToInbox(stepId);
      if (!res) return;
      if (res.remaining === 0) setEmptied(true);
      else router.refresh();
    });
  }

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
      {steps.map((s) => (
        <li
          key={s.id}
          className="flex items-center gap-3 rounded-lg border px-3 py-2"
        >
          <span className="text-muted-foreground w-8 text-xs tabular-nums">
            {s.order}/{s.total}
          </span>
          <span className={s.done ? "flex-1 text-muted-foreground line-through" : "flex-1"}>
            {s.subtaskEmoji ? `${s.subtaskEmoji} ` : ""}
            {s.text}
          </span>
          <span className="text-muted-foreground text-xs">{s.estMinutes}m</span>
          <button
            title="Send to review"
            aria-label="Send to review"
            disabled={pending}
            onClick={() => sendToReview(s.id)}
            className="text-muted-foreground hover:text-foreground rounded px-1 text-sm disabled:opacity-40"
          >
            ↗
          </button>
          {s.done ? (
            <span className="text-green-600" title="done">
              ✓
            </span>
          ) : (
            <Link
              href={`/focus/${s.id}`}
              className="bg-primary text-primary-foreground rounded-md px-3 py-1 text-sm font-medium"
            >
              ▶ Focus
            </Link>
          )}
        </li>
      ))}
    </ol>
  );
}
