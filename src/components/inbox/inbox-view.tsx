"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { BrainDumpStatus } from "@/lib/constants";
import { isAging, effectiveAgingMs, type AgingSettings } from "@/lib/aging";
import {
  createBrainDumpItem,
  triageBrainDumpItem,
  snoozeBrainDumpItem,
  deleteBrainDumpItem,
  keepAsTask,
  markReminded,
} from "@/app/actions/braindump";
import { startBreakdown } from "@/app/actions/breakdown";
import { SettingsPanel } from "@/components/inbox/settings-panel";
import { t } from "@/lib/strings";
import { useVoice } from "@/components/voice-provider";
import type { Voice } from "@/lib/strings";
import {
  notificationPermission,
  requestNotificationPermission,
  registerServiceWorker,
  showReminder,
} from "@/lib/notifications";

type Item = {
  id: string;
  text: string;
  createdAt: Date;
  status: string;
  triagedAt: Date | null;
  remindedAt: Date | null;
  snoozedUntil: Date | null;
  taskId: string | null;
  freshenedAt: Date | null;
  promptDismissedAt: Date | null;
  stepsTotal: number;
  stepsDone: number;
  taskStatus: string | null;
};

export function InboxView({
  initialItems,
  settings,
  isOwner,
  breakdownModel,
  // SSR seed value from the layout; the live source of truth is useVoice()
  // (context), so at runtime we read `voice` below. voiceProp only forwards the
  // initial value to SettingsPanel.
  voice: voiceProp,
}: {
  initialItems: Item[];
  settings: AgingSettings;
  isOwner: boolean;
  breakdownModel: string | null;
  voice: Voice;
}) {
  const router = useRouter();
  const voice = useVoice();
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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
  const isInbox = (i: Item) => i.status === BrainDumpStatus.Inbox;
  const isSnoozed = (i: Item) =>
    i.snoozedUntil != null && new Date(i.snoozedUntil).getTime() > now;

  const needsTriage = initialItems
    .filter((i) => isInbox(i) && !isSnoozed(i))
    .sort((a, b) => {
      const aa = isAging(a.createdAt, settings) ? 1 : 0;
      const ba = isAging(b.createdAt, settings) ? 1 : 0;
      if (aa !== ba) return ba - aa; // aging first
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  const snoozed = initialItems.filter((i) => isInbox(i) && isSnoozed(i));
  const triaged = initialItems
    .filter((i) => i.status === BrainDumpStatus.Triaged)
    .sort(
      (a, b) =>
        new Date(b.triagedAt ?? b.createdAt).getTime() -
        new Date(a.triagedAt ?? a.createdAt).getTime(),
    );

  const untriagedCount = needsTriage.length;
  const agingCount = needsTriage.filter((i) =>
    isAging(i.createdAt, settings),
  ).length;

  // Fire a desktop reminder once per aging, not-yet-reminded item, then persist
  // remindedAt so it doesn't repeat (guarded client-side by notifiedRef too).
  useEffect(() => {
    if (permission !== "granted") return;
    const due = needsTriage.filter(
      (i) =>
        isAging(i.createdAt, settings) &&
        i.remindedAt == null &&
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
  }, [needsTriage, permission, settings, router]);

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

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    run(() => createBrainDumpItem(value));
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
      </div>

      <SettingsPanel settings={settings} isOwner={isOwner} breakdownModel={breakdownModel} voice={voiceProp} />

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
        {needsTriage.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm">
            Inbox zero 🎉 Nothing to triage.
          </p>
        ) : (
          <ul className={cn("space-y-2", pending && "opacity-70")}>
            {needsTriage.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                settings={settings}
                voice={voice}
                onBreakdown={() => breakdown(item.id)}
                onKeep={() => run(() => keepAsTask(item.id))}
                onSnooze={() => run(() => snoozeBrainDumpItem(item.id, 60))}
                onDelete={() => run(() => deleteBrainDumpItem(item.id))}
              />
            ))}
          </ul>
        )}
      </section>

      {snoozed.length > 0 && (
        <section>
          <h2 className="text-muted-foreground mb-2 text-sm font-semibold">
            💤 Snoozed ({snoozed.length})
          </h2>
          <ul className="space-y-2 opacity-60">
            {snoozed.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between rounded-lg border px-4 py-2 text-sm"
              >
                <span>{item.text}</span>
                <button
                  className="text-muted-foreground hover:text-foreground text-xs underline"
                  onClick={() => run(() => triageBrainDumpItem(item.id))}
                >
                  wake now
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Triaged (collapsible) */}
      {triaged.length > 0 && (
        <details className="group">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer list-none text-sm font-semibold">
            <span className="group-open:hidden">▸</span>
            <span className="hidden group-open:inline">▾</span> Triaged (
            {triaged.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {triaged.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between rounded-lg border px-4 py-2 text-sm"
              >
                <span className="flex items-center gap-2">
                  <StatusPill kind="triaged" /> {item.text}
                </span>
                <button
                  className="text-muted-foreground hover:text-destructive text-xs"
                  onClick={() => run(() => deleteBrainDumpItem(item.id))}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
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
  onDelete,
}: {
  item: Item;
  settings: AgingSettings;
  voice: Voice;
  onBreakdown: () => void;
  onKeep: () => void;
  onSnooze: () => void;
  onDelete: () => void;
}) {
  const aging = isAging(item.createdAt, settings);
  return (
    <li className="rounded-lg border px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <StatusPill kind={aging ? "aging" : "untriaged"} voice={voice} />
            <span className="break-words">{item.text}</span>
          </div>
          <AgeLabel createdAt={item.createdAt} aging={aging} />
        </div>
      </div>
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
          onClick={onDelete}
          className="text-muted-foreground hover:text-destructive ml-auto rounded-md px-2.5 py-1"
        >
          Delete
        </button>
      </div>
    </li>
  );
}

function StatusPill({ kind, voice = "plain" }: { kind: "untriaged" | "aging" | "triaged"; voice?: Voice }) {
  const map: Record<"untriaged" | "aging" | "triaged", { dot: string; label: string; cls: string }> = {
    untriaged: { dot: "🔴", label: "Untriaged", cls: "text-red-600" },
    aging: { dot: "🟡", label: t("freshness.aging", voice), cls: "text-amber-600" },
    triaged: { dot: "🟢", label: "Triaged", cls: "text-green-600" },
  };
  const { dot, label, cls } = map[kind];
  return (
    <span className={cn("shrink-0 text-xs font-medium", cls)}>
      {dot} {label}
    </span>
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
