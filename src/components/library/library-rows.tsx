"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { RowActions } from "@/components/inbox/row-actions";
import { CompleteButton } from "@/components/inbox/complete-button";
import {
  ensureFocusStep,
  completeItem,
  deleteBrainDumpItem,
} from "@/app/actions/braindump";
import { t, type Voice } from "@/lib/strings";
import type { Item } from "@/components/inbox/bucket";

/**
 * Interactive rows for the Library hub's in-flight tabs (Single-task / Saved
 * for later). Deliberately reuses the Inbox's `RowActions` layout + the same
 * workspace-scoped server actions (`ensureFocusStep` / `completeItem` /
 * `deleteBrainDumpItem`) rather than reinventing them, so the hub and the Inbox
 * share one code path and can't drift. Each action refreshes the current route
 * so the hub re-reads live data (the actions revalidate the Inbox, not here).
 *
 * The two-step delete confirm mirrors the Inbox's row pattern exactly: the
 * first tap reveals "Delete · Cancel"; only the confirming tap deletes.
 */
export function LibraryRows({
  items,
  tab,
  voice,
  now,
}: {
  items: Item[];
  tab: "plated" | "pantry";
  voice: Voice;
  now: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const run = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      await fn();
      router.refresh();
    });

  // ▶ Start focusing — ensure the item has a one-step task, then open the timer.
  const focusOnItem = (id: string) =>
    startTransition(async () => {
      const stepId = await ensureFocusStep(id);
      if (stepId) router.push(`/focus/${stepId}`);
    });

  // Two-step delete confirm — one shared `confirmDeleteId` drives both the
  // end-cluster 🗑 icon and the ▾-menu entry, so confirming/cancelling either
  // keeps the other in sync (matches the Inbox rows).
  const deleteControl = (
    id: string,
    key: string,
    { fullWidth = false, icon = false }: { fullWidth?: boolean; icon?: boolean } = {},
  ) =>
    confirmDeleteId === id ? (
      <span key={key} className="flex items-center gap-2">
        <button
          className="text-destructive rounded-md px-2.5 py-1 font-medium"
          onClick={() => {
            setConfirmDeleteId(null);
            run(() => deleteBrainDumpItem(id));
          }}
        >
          {t("action.delete", voice)}
        </button>
        <span className="text-muted-foreground">·</span>
        <button
          className="text-muted-foreground hover:text-foreground rounded-md px-2.5 py-1"
          onClick={() => setConfirmDeleteId(null)}
        >
          {t("action.cancel", voice)}
        </button>
      </span>
    ) : icon ? (
      <button
        key={key}
        aria-label={t("action.delete", voice)}
        title={t("action.delete", voice)}
        className="text-muted-foreground hover:text-destructive rounded-md px-2.5 py-1"
        onClick={() => setConfirmDeleteId(id)}
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
        onClick={() => setConfirmDeleteId(id)}
      >
        {t("action.delete", voice)}
      </button>
    );

  return (
    <ul className={cn("space-y-2", pending && "opacity-70")}>
      {items.map((item) => (
        <li key={item.id} className="rounded-lg border px-4 py-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 flex-1 break-words">{item.text}</span>
            <span className="text-muted-foreground shrink-0 text-xs">
              {tab === "plated"
                ? `${t("lib.added", voice)} ${formatAgo(now - new Date(item.createdAt).getTime())}`
                : item.snoozedUntil
                  ? `${t("lib.wakes", voice)} ${formatWake(item.snoozedUntil)}`
                  : null}
            </span>
          </div>
          <RowActions
            inline={[
              <button
                key="focus"
                type="button"
                onClick={() => focusOnItem(item.id)}
                className="bg-primary text-primary-foreground hover:opacity-90 rounded-md px-2.5 py-1 font-medium"
              >
                {t("action.startFocus", voice)}
              </button>,
              <CompleteButton
                key="complete"
                voice={voice}
                onClick={() => run(() => completeItem(item.id))}
              />,
            ]}
            del={deleteControl(item.id, "delete", { icon: true })}
            menu={[
              <button
                key="focus-m"
                type="button"
                className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                onClick={() => focusOnItem(item.id)}
              >
                {t("step.startFocusTimer", voice)}
              </button>,
              <button
                key="complete-m"
                type="button"
                className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                onClick={() => run(() => completeItem(item.id))}
              >
                {t("action.completeFull", voice)}
              </button>,
              deleteControl(item.id, "delete-m", { fullWidth: true }),
            ]}
          />
        </li>
      ))}
    </ul>
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
