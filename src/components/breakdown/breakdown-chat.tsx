"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { confirmBreakdown } from "@/app/actions/breakdown";
import { scheduleTaskInReclaim } from "@/app/actions/reclaim";
import type { Feedback, Proposal, StreamEvent } from "@/lib/breakdown";
import { cn } from "@/lib/utils";

type ChatMsg = { role: "assistant" | "user"; text: string };
type ScheduleState = {
  status: "idle" | "scheduling" | "done" | "error";
  count?: number;
  message?: string;
};

export function BreakdownChat({
  taskId,
  title,
  initialProposal,
  reclaimConnected,
}: {
  taskId: string;
  title: string;
  initialProposal: Proposal | null;
  reclaimConnected: boolean;
}) {
  const router = useRouter();
  const [schedule, setSchedule] = useState<ScheduleState>({ status: "idle" });
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(initialProposal);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [freeText, setFreeText] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [confirmPending, startConfirm] = useTransition();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (!initialProposal) void request({ kind: "propose" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function request(feedback: Feedback, userLabel?: string) {
    if (streaming) return;
    setError(null);
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

  function confirm() {
    if (!proposal || proposal.steps.length === 0) return;
    startConfirm(async () => {
      await confirmBreakdown(taskId, proposal);
      setConfirmed(true);
    });
  }

  async function scheduleNow() {
    setSchedule({ status: "scheduling" });
    const res = await scheduleTaskInReclaim(taskId);
    if (res.ok) {
      setSchedule({ status: "done", count: res.scheduled });
      router.refresh();
    } else {
      setSchedule({
        status: "error",
        message:
          res.reason === "not_connected"
            ? "Reclaim isn't connected."
            : (res.message ?? "Scheduling failed."),
      });
    }
  }

  const totalMin = proposal?.steps.reduce((n, s) => n + (s.estMinutes || 0), 0) ?? 0;
  const busy = streaming || confirmPending;

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

        {/* Reclaim scheduling */}
        <div className="rounded-lg border p-4">
          {!reclaimConnected ? (
            <div className="space-y-2 text-sm">
              <p className="font-medium">📅 Schedule onto your calendar</p>
              <p className="text-muted-foreground">
                Connect Reclaim and Claude will book each step on your calendar
                automatically. Your steps are saved either way.
              </p>
              <a
                href="/api/reclaim/oauth/start"
                className="bg-primary text-primary-foreground inline-block rounded-md px-3 py-2 font-medium"
              >
                Connect Reclaim →
              </a>
            </div>
          ) : schedule.status === "done" ? (
            <p className="text-sm font-medium text-green-700">
              ✅ Sent {schedule.count} task{schedule.count === 1 ? "" : "s"} to
              Reclaim — check your calendar!
            </p>
          ) : (
            <div className="space-y-2 text-sm">
              <p className="font-medium">📅 Schedule onto your calendar</p>
              <p className="text-muted-foreground">
                Claude will create each step as a Reclaim task and let Reclaim
                auto-schedule it.
              </p>
              <button
                onClick={scheduleNow}
                disabled={schedule.status === "scheduling"}
                className="bg-primary text-primary-foreground rounded-md px-3 py-2 font-medium disabled:opacity-50"
              >
                {schedule.status === "scheduling"
                  ? "Scheduling… (Claude is booking your tasks)"
                  : "📅 Schedule in Reclaim"}
              </button>
              {schedule.status === "error" && (
                <p className="text-red-700">{schedule.message}</p>
              )}
            </div>
          )}
        </div>

        <Link
          href="/inbox"
          className="text-muted-foreground inline-block text-sm hover:underline"
        >
          ← Back to inbox
        </Link>
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
        <Link href="/inbox" className="text-muted-foreground text-sm hover:underline">
          ← inbox
        </Link>
      </div>

      {/* Conversation */}
      <div className="space-y-3">
        {messages.map((m, i) => (
          <ChatBubble key={i} role={m.role} text={m.text} />
        ))}
        {streaming && <ChatBubble role="assistant" text={streamText} typing />}
      </div>

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
                className="flex items-start gap-2 rounded-lg border px-3 py-2"
              >
                <span className="text-muted-foreground pt-1.5 text-xs tabular-nums">
                  {i + 1}/{proposal.steps.length}
                </span>
                <input
                  value={s.subtaskEmoji}
                  onChange={(e) => updateStep(i, { subtaskEmoji: e.target.value })}
                  className="w-9 rounded-md border px-1 py-1 text-center"
                  aria-label="Step emoji"
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
                <div className="flex flex-col gap-1">
                  <button
                    title="Break this step down further"
                    disabled={busy}
                    onClick={() =>
                      request(
                        { kind: "split_step", index: i },
                        `Break down step ${i + 1}: "${s.text}"`,
                      )
                    }
                    className="hover:bg-accent rounded px-1 text-xs disabled:opacity-40"
                  >
                    ↳
                  </button>
                  <button
                    title="Remove step"
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
          {confirmPending ? "Saving…" : "👍 Looks right"}
        </button>
        <button
          onClick={() => request({ kind: "too_big" }, "These feel too big ⬇️")}
          disabled={busy || !proposal}
          className="hover:bg-accent rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
        >
          ⬇️ Too big
        </button>
        <button
          onClick={() =>
            request({ kind: "too_small" }, "Too small / too many ⬆️")
          }
          disabled={busy || !proposal}
          className="hover:bg-accent rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
        >
          ⬆️ Too small
        </button>
      </div>

      {/* Free text */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const t = freeText.trim();
          if (!t) return;
          setFreeText("");
          request({ kind: "free", text: t }, `✍️ ${t}`);
        }}
        className="flex gap-2"
      >
        <input
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder="Or tell Claude how to adjust…"
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
