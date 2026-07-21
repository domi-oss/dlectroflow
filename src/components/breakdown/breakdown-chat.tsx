"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { confirmBreakdown } from "@/app/actions/breakdown";
import { createBrainDumpItem } from "@/app/actions/braindump";
import { pushStepsToGoogleTasks } from "@/app/actions/google-schedule";
import { scheduleViaIcs } from "@/app/actions/ics-schedule";
import { downloadIcs } from "@/lib/download-ics";
import type { Feedback, Proposal, StreamEvent } from "@/lib/breakdown";
import { reorder, blankStep } from "@/lib/breakdown";
import { EmojiPicker } from "@/components/breakdown/emoji-picker";
import { ScheduleStatusBanner } from "@/components/breakdown/schedule-status-banner";
import { BackToInbox } from "@/components/nav/back-to-inbox";
import { leadSchedulingMethod } from "@/lib/scheduling/providers";
import type { GoogleConnStatus } from "@/lib/scheduling/types";
import { cn } from "@/lib/utils";
import { t } from "@/lib/strings";
import { useVoice } from "@/components/voice-provider";

type ChatMsg = { role: "assistant" | "user"; text: string };
type ScheduleState = {
  status: "idle" | "scheduling" | "done" | "error";
  count?: number;
  message?: string;
  reason?: string;
};

export function BreakdownChat({
  taskId,
  title,
  initialProposal,
  startManual = false,
  google,
  isGuest = false,
  scheduled = false,
}: {
  taskId: string;
  title: string;
  initialProposal: Proposal | null;
  /** Start with one blank step and skip the automatic AI proposal (manual re-plan). */
  startManual?: boolean;
  google: GoogleConnStatus;
  isGuest?: boolean;
  /** Persisted ground truth: has this task ever been scheduled (task.scheduledAt)? */
  scheduled?: boolean;
}) {
  const router = useRouter();
  const voice = useVoice();
  const [gsched, setGsched] = useState<ScheduleState>({ status: "idle" });
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(
    initialProposal ??
      (startManual ? { parentEmoji: "🗂️", steps: [blankStep()] } : null),
  );
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [freeText, setFreeText] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  const [confirmPending, startConfirm] = useTransition();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (!initialProposal && !startManual) void request({ kind: "propose" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function request(feedback: Feedback, userLabel?: string) {
    if (streaming) return;
    setError(null);
    setFallbackNote(null);
    if (userLabel) setMessages((m) => [...m, { role: "user", text: userLabel }]);
    setStreaming(true);
    setStreamText("");
    let assistantText = "";
    try {
      const res = await fetch("/api/breakdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, currentProposal: proposal, feedback }),
      });
      if (!res.body) throw new Error("No response stream.");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as StreamEvent;
          if (ev.type === "text") {
            assistantText += ev.delta;
            setStreamText(assistantText);
          } else if (ev.type === "steps") {
            setProposal(ev.data);
          } else if (ev.type === "fallback") {
            setProposal(ev.data);
            setFallbackNote(
              ev.reason === "quota"
                ? "⚡ You're out of AI breakdowns for now — but here's a solid starter plan you can tweak, and the focus list still works."
                : ev.reason === "global_cap"
                  ? "🚦 The demo's shared AI is maxed out for today — here's a hand-built plan to get you moving. Still fully usable."
                  : "🔌 The AI hiccuped, so here's a reliable starter plan. Edit away and add it to your focus list.",
            );
          } else if (ev.type === "error") {
            setError(ev.message);
          }
        }
      }
      if (assistantText.trim()) {
        setMessages((m) => [...m, { role: "assistant", text: assistantText }]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setStreaming(false);
      setStreamText("");
    }
  }

  function updateStep(i: number, patch: Partial<Proposal["steps"][number]>) {
    setProposal((p) =>
      p ? { ...p, steps: p.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) } : p,
    );
  }

  function removeStep(i: number) {
    setProposal((p) =>
      p ? { ...p, steps: p.steps.filter((_, j) => j !== i) } : p,
    );
  }

  // Manual "Remove step" — drops the last step in the list.
  function removeLastStep() {
    setProposal((p) =>
      p && p.steps.length > 0 ? { ...p, steps: p.steps.slice(0, -1) } : p,
    );
  }

  // Eject a step back to the inbox "needs review" bucket as its own bigger task.
  // In the editor the steps aren't persisted yet, so this just drops the row
  // locally and captures its text as a fresh inbox item. (Once confirmed, the
  // working view uses the persisted ejectStepToInbox server action instead.)
  function backToInbox(i: number) {
    const text = proposal?.steps[i]?.text.trim();
    removeStep(i);
    if (text) void createBrainDumpItem(text);
  }

  // Manual "Add a step" — appends a blank, editable row. No Claude call; the
  // list is rebuilt from the controlled state, so numbering stays 0-based.
  function addStep() {
    setProposal((p) =>
      p
        ? { ...p, steps: [...p.steps, blankStep()] }
        : { parentEmoji: "🗂️", steps: [blankStep()] },
    );
  }

  // Drag-to-reorder: the grip handle is the drag source, each row is a drop
  // target. `reorder` returns a fresh array so state updates cleanly.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  function moveStep(from: number, to: number) {
    setProposal((p) => (p ? { ...p, steps: reorder(p.steps, from, to) } : p));
  }

  function confirm() {
    if (!proposal || proposal.steps.length === 0) return;
    startConfirm(async () => {
      await confirmBreakdown(taskId, proposal);
      setConfirmed(true);
    });
  }

  async function sendToGoogle() {
    setGsched({ status: "scheduling" });
    const res = await pushStepsToGoogleTasks(taskId);
    if (res.ok) {
      setGsched({
        status: "done",
        count: res.scheduled,
        message: res.listTitle,
      });
      router.refresh();
    } else {
      const map: Record<string, string> = {
        not_configured:
          "Google isn't configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).",
        not_connected: "Google Tasks isn't connected.",
        reconnect_required:
          "Google needs reconnecting — your access expired or was revoked.",
        no_steps: "No steps to send.",
      };
      setGsched({
        status: "error",
        message: map[res.reason] ?? res.message ?? "Sending to Google Tasks failed.",
        reason: res.reason,
      });
    }
  }

  const [icsBusy, setIcsBusy] = useState(false);
  async function addToCalendar() {
    setIcsBusy(true);
    try {
      const res = await scheduleViaIcs(taskId);
      if (res.ok) {
        downloadIcs(res.ics, res.icsFilename);
        router.refresh();
      }
    } finally {
      setIcsBusy(false);
    }
  }

  const totalMin = proposal?.steps.reduce((n, s) => n + (s.estMinutes || 0), 0) ?? 0;
  const busy = streaming || confirmPending;

  // Route the Google-vs-ICS control choice through the seam (S1, #34): the
  // "Schedule onto your calendar" (Google Tasks) section is the owner-led method;
  // guests only ever get the universal ICS export above it. `leadSchedulingMethod`
  // maps a null status (guest) to "ics", any status (owner) to "googleTasks" —
  // behaviourally identical to the previous `!isGuest`.
  const showGoogleSection = leadSchedulingMethod(isGuest ? null : google) === "googleTasks";

  if (confirmed) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">
          {proposal?.parentEmoji} {title}
        </h1>
        <div className="rounded-lg border border-green-600/30 bg-green-600/10 p-4">
          <p className="font-medium text-green-700">
            🎉 Saved {proposal?.steps.length} steps ({totalMin} min total).
          </p>
        </div>

        {/* Ground truth: reflects the persisted scheduledAt marker (plus an
            in-session schedule success), never an optimistic assumption. */}
        <ScheduleStatusBanner
          scheduled={scheduled || gsched.status === "done"}
          voice={voice}
        />

        {/* Calendar export — always available, no integrations needed */}
        <div className="space-y-2 rounded-lg border p-4 text-sm">
          <p className="font-medium">📅 Add to your calendar</p>
          <p className="text-muted-foreground">
            Download an .ics with each step as a timed event — import into Google,
            Apple, or Outlook. No account needed.
          </p>
          <button
            type="button"
            onClick={addToCalendar}
            disabled={icsBusy}
            className="bg-primary text-primary-foreground inline-block rounded-md px-3 py-2 font-medium disabled:opacity-50"
          >
            {icsBusy ? "Preparing…" : "⬇️ Download calendar (.ics)"}
          </button>
        </div>

        {showGoogleSection && (
          <div className="space-y-2 rounded-lg border p-4 text-sm">
            <p className="font-medium">📅 Schedule onto your calendar</p>

            {google.configured ? (
              google.needsReconnect ? (
                <div className="space-y-2">
                  <p className="text-muted-foreground">
                    Google needs reconnecting — your access expired or was revoked.
                  </p>
                  <a
                    href="/api/google/oauth/start"
                    className="bg-primary text-primary-foreground inline-block rounded-md px-3 py-2 font-medium"
                  >
                    Reconnect Google →
                  </a>
                </div>
              ) : !google.connected ? (
                <div className="space-y-2">
                  <p className="text-muted-foreground">
                    Connect Google Tasks — steps land in your task list, and a
                    Reclaim-synced list is scheduled automatically.
                  </p>
                  <a
                    href="/api/google/oauth/start"
                    className="bg-primary text-primary-foreground inline-block rounded-md px-3 py-2 font-medium"
                  >
                    Connect Google Tasks →
                  </a>
                </div>
              ) : gsched.status === "done" ? (
                <p className="font-medium text-green-700">
                  ✅ Sent {gsched.count} task{gsched.count === 1 ? "" : "s"} to your
                  &quot;{gsched.message}&quot; list.
                </p>
              ) : (
                <div className="space-y-2">
                  <p className="text-muted-foreground">
                    Send these steps to your Google Tasks list — a Reclaim-synced
                    list is scheduled automatically.
                  </p>
                  <button
                    onClick={sendToGoogle}
                    disabled={gsched.status === "scheduling"}
                    className="bg-primary text-primary-foreground rounded-md px-3 py-2 font-medium disabled:opacity-50"
                  >
                    {gsched.status === "scheduling"
                      ? "Sending…"
                      : "📅 Send to Google Tasks"}
                  </button>
                  {gsched.status === "error" && (
                    <div className="space-y-2">
                      <p className="text-red-700">{gsched.message}</p>
                      {gsched.reason === "reconnect_required" && (
                        <a
                          href="/api/google/oauth/start"
                          className="bg-primary text-primary-foreground inline-block rounded-md px-3 py-2 font-medium"
                        >
                          Reconnect Google →
                        </a>
                      )}
                    </div>
                  )}
                </div>
              )
            ) : (
              <p className="text-muted-foreground">
                Set <code>GOOGLE_CLIENT_ID</code> / <code>GOOGLE_CLIENT_SECRET</code>{" "}
                to schedule into Google Tasks (see the README). The calendar
                download above works without any integration — steps are saved
                either way.
              </p>
            )}
          </div>
        )}

        <div className="flex items-center gap-4">
          {/* full navigation so the server renders the focusable steps view */}
          <a
            href={`/tasks/${taskId}`}
            className="bg-primary text-primary-foreground inline-block rounded-md px-4 py-2 text-sm font-medium"
          >
            {t("action.startFocus", voice)}
          </a>
          <BackToInbox voice={voice} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          {proposal?.parentEmoji ? `${proposal.parentEmoji} ` : "✂️ "}
          {title}
        </h1>
        <BackToInbox voice={voice} />
      </div>

      {/* Conversation */}
      <div className="space-y-3">
        {messages.map((m, i) => (
          <ChatBubble key={i} role={m.role} text={m.text} />
        ))}
        {streaming && <ChatBubble role="assistant" text={streamText} typing />}
      </div>

      {/* Tell Claude how to adjust — sits right under the latest reply */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = freeText.trim();
          if (!v) return;
          setFreeText("");
          request({ kind: "free", text: v }, `✍️ ${v}`);
        }}
        className="flex gap-2"
      >
        <input
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder="Tell Claude how to adjust…"
          disabled={busy}
          className="border-input flex-1 rounded-md border px-3 py-2 text-sm disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy || !freeText.trim()}
          className="hover:bg-accent rounded-md border px-3 py-2 text-sm disabled:opacity-50"
        >
          Send
        </button>
      </form>

      {fallbackNote && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700">
          {fallbackNote}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-600/30 bg-red-600/10 p-3 text-sm text-red-700">
          {error}{" "}
          <button
            className="underline"
            onClick={() => request({ kind: "propose" })}
          >
            Try again
          </button>
        </div>
      )}

      {/* Proposed steps (editable) */}
      {proposal && proposal.steps.length > 0 && (
        <div className="space-y-2">
          <div className="text-muted-foreground flex items-center justify-between text-sm">
            <span className="font-medium">
              {proposal.steps.length} steps · ~{totalMin} min
            </span>
          </div>
          <ol className="space-y-2">
            {proposal.steps.map((s, i) => (
              <li
                key={i}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null && dragIndex !== i) moveStep(dragIndex, i);
                  setDragIndex(null);
                }}
                className={cn(
                  "flex items-start gap-2 rounded-lg border px-3 py-2",
                  dragIndex === i && "opacity-50",
                )}
              >
                <span
                  draggable
                  onDragStart={() => setDragIndex(i)}
                  onDragEnd={() => setDragIndex(null)}
                  title="Drag to reorder"
                  aria-label="Drag to reorder"
                  className="text-muted-foreground hover:text-foreground cursor-grab pt-1.5 text-xs select-none active:cursor-grabbing"
                >
                  ⠿
                </span>
                <span className="text-muted-foreground pt-1.5 text-xs tabular-nums">
                  {i + 1}/{proposal.steps.length}
                </span>
                <EmojiPicker
                  value={s.subtaskEmoji}
                  onSelect={(emoji) => updateStep(i, { subtaskEmoji: emoji })}
                />
                <input
                  value={s.text}
                  onChange={(e) => updateStep(i, { text: e.target.value })}
                  className="border-input flex-1 rounded-md border px-2 py-1 text-sm"
                  aria-label="Step text"
                />
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={1}
                    value={s.estMinutes}
                    onChange={(e) =>
                      updateStep(i, { estMinutes: Number(e.target.value) })
                    }
                    className="border-input w-16 rounded-md border px-1 py-1 text-right text-sm"
                    aria-label="Estimated minutes"
                  />
                  <span className="text-muted-foreground text-xs">min</span>
                </div>
                <div className="flex flex-col items-stretch gap-1">
                  <button
                    title="Send back to the inbox as its own item to re-break-down"
                    aria-label="Back to inbox"
                    onClick={() => backToInbox(i)}
                    className="text-muted-foreground hover:text-foreground hover:bg-accent rounded border px-1.5 py-0.5 text-xs whitespace-nowrap"
                  >
                    {t("action.backToInbox", voice)}
                  </button>
                  <button
                    title="Remove this step"
                    aria-label="Remove this step"
                    onClick={() => removeStep(i)}
                    className="text-muted-foreground hover:text-destructive rounded px-1 text-xs"
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Quick replies */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={confirm}
          disabled={busy || !proposal || proposal.steps.length === 0}
          className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {confirmPending ? "Saving…" : t("breakdown.looksRight", voice)}
        </button>
        <button
          onClick={() =>
            request({ kind: "too_small" }, "Fewer, bigger steps ⬇️")
          }
          disabled={busy || !proposal}
          className="hover:bg-accent rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {t("action.fewerSteps", voice)}
        </button>
        <button
          onClick={() =>
            request({ kind: "too_big" }, "More, smaller steps ⬆️")
          }
          disabled={busy || !proposal}
          className="hover:bg-accent rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {t("action.moreSteps", voice)}
        </button>
        <button
          onClick={addStep}
          disabled={busy}
          className="hover:bg-accent rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {t("action.addStep", voice)}
        </button>
        <button
          onClick={removeLastStep}
          disabled={busy || !proposal || proposal.steps.length === 0}
          className="hover:bg-accent rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {t("action.removeStep", voice)}
        </button>
      </div>

    </div>
  );
}

function ChatBubble({
  role,
  text,
  typing,
}: {
  role: "assistant" | "user";
  text: string;
  typing?: boolean;
}) {
  return (
    <div
      className={cn(
        "max-w-[85%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap",
        role === "assistant"
          ? "bg-secondary text-secondary-foreground"
          : "bg-primary text-primary-foreground ml-auto",
      )}
    >
      {text}
      {typing && (!text ? "…thinking" : <span className="animate-pulse">▍</span>)}
    </div>
  );
}
