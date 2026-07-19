"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { ensureFocusStep, completeItem } from "@/app/actions/braindump";
import { completeStep } from "@/app/actions/focus";
import { t, type Voice } from "@/lib/strings";
import type { SingleFocusable, FocusableStep } from "@/lib/focus-launcher";

/** ≥44px inline ✓ quick-complete — glyph + text accessible name (a11y: status
 * not colour-only). */
function QuickComplete({ voice, onClick }: { voice: Voice; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={t("action.complete", voice)}
      title={t("action.complete", voice)}
      onClick={onClick}
      className="hover:bg-accent inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md border"
    >
      ✓
    </button>
  );
}

/** Single-task to-dos lane: ▶ Start (ensureFocusStep → route) + optimistic ✓. */
export function SingleTaskLane({ items, voice }: { items: SingleFocusable[]; voice: Voice }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<Set<string>>(new Set());
  const visible = items.filter((i) => !done.has(i.itemId));

  const start = (itemId: string) =>
    startTransition(async () => {
      const stepId = await ensureFocusStep(itemId);
      if (stepId) router.push(`/focus/${stepId}`);
    });

  const complete = (itemId: string) => {
    setDone((prev) => new Set(prev).add(itemId)); // optimistic: row leaves the lane
    startTransition(async () => {
      await completeItem(itemId);
      router.refresh();
    });
  };

  return (
    <ul className={cn("space-y-2", pending && "opacity-70")}>
      {visible.map((s) => (
        <li key={s.itemId} className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm">
          <span className="min-w-0 flex-1 break-words">{s.text}</span>
          {s.estMinutes > 0 && (
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{s.estMinutes}m</span>
          )}
          <button
            type="button"
            onClick={() => start(s.itemId)}
            className="bg-primary text-primary-foreground inline-flex min-h-[44px] shrink-0 items-center rounded-md px-3 font-medium hover:opacity-90"
          >
            {t("focus.lane.start", voice)}
          </button>
          <QuickComplete voice={voice} onClick={() => complete(s.itemId)} />
        </li>
      ))}
    </ul>
  );
}

/** Multi-step to-dos lane: ▶ Open (route straight to the shown step) + optimistic
 * ✓ that completes that step (completeStep). */
export function MultiStepLane({ items, voice }: { items: FocusableStep[]; voice: Voice }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<Set<string>>(new Set());
  const visible = items.filter((e) => !done.has(e.stepId));

  const complete = (stepId: string) => {
    setDone((prev) => new Set(prev).add(stepId)); // optimistic
    startTransition(async () => {
      await completeStep(stepId);
      router.refresh();
    });
  };

  return (
    <ul className={cn("space-y-2", pending && "opacity-70")}>
      {visible.map((e) => (
        <li key={e.stepId} className="flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-sm">
          <span className="text-muted-foreground text-xs">{e.taskTitle}</span>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 break-words font-medium">
              {e.subtaskEmoji ? `${e.subtaskEmoji} ` : ""}
              {e.stepText}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {e.stepsDone}/{e.stepsTotal}
            </span>
            {e.estMinutes > 0 && (
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{e.estMinutes}m</span>
            )}
            <button
              type="button"
              onClick={() => router.push(`/focus/${e.stepId}`)}
              className="bg-primary text-primary-foreground inline-flex min-h-[44px] shrink-0 items-center rounded-md px-3 font-medium hover:opacity-90"
            >
              {t("focus.lane.open", voice)}
            </button>
            <QuickComplete voice={voice} onClick={() => complete(e.stepId)} />
          </div>
        </li>
      ))}
    </ul>
  );
}
