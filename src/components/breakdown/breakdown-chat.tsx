"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import { confirmBreakdown } from "@/app/actions/breakdown";
import { createBrainDumpItem } from "@/app/actions/braindump";
import { pushStepsToGoogleTasks } from "@/app/actions/google-schedule";
import { scheduleViaIcs } from "@/app/actions/ics-schedule";
import { downloadIcs } from "@/lib/download-ics";
import type {
  Feedback,
  Proposal,
  ProposedStep,
  StreamEvent,
} from "@/lib/breakdown";
import { reorder, blankStep } from "@/lib/breakdown";
import {
  ActionTimeoutError,
  isStaleActionError,
  withActionTimeout,
} from "@/lib/server-action-failure";
import { EmojiPicker } from "@/components/breakdown/emoji-picker";
import { ScheduleStatusBanner } from "@/components/breakdown/schedule-status-banner";
import { BackLink } from "@/components/nav/back-link";
import { GoogleAccountHint } from "@/components/integrations/google-account-hint";
import { withFrom } from "@/lib/nav/back";
import { leadSchedulingMethod } from "@/lib/scheduling/providers";
import type { GoogleConnStatus } from "@/lib/scheduling/types";
import { cn } from "@/lib/utils";
import { STATUS_BANNER_TONE } from "@/lib/status-banner-style";
import { t, type StringKey } from "@/lib/strings";
import { useVoice } from "@/components/voice-provider";

type ChatMsg = { role: "assistant" | "user"; text: string };

/**
 * #212 — how long the editor is willing to WAIT for a step's eject before
 * calling it a failure.
 *
 * The third failure mode is silence rather than a rejection — a pod rolling
 * mid-request, a connection that never closes — and from the user's side an
 * un-timed-out `await` is indistinguishable from the bug this fixes: a row that
 * never comes back, with nothing said about it. `createBrainDumpItem` is one
 * Prisma insert plus a streak touch, so ten seconds is already pathological;
 * this matches `CAPTURE_TIMEOUT_MS` in `inbox-view.tsx`,
 * `SHOPPING_ACTION_TIMEOUT_MS` in `shopping-list.tsx` and `ACTION_TIMEOUT_MS` in
 * `focus-timer.tsx` for the same class of call. The request itself carries on (a
 * server action cannot be aborted from the client), so a write that lands late
 * still lands. Exported so the test advances the real value rather than a copy.
 */
export const EJECT_TIMEOUT_MS = 10_000;

/**
 * #212 — a step whose eject did not land.
 *
 * Holds the words as well as the flags, so the notice can quote them. In the
 * common case they are also still in their row — which is the whole remedy here
 * — but the user may delete that row while the notice is up, and then this
 * record is the only copy.
 */
type EjectFailure = {
  /** The trimmed text that was sent, and the identity of the attempt. */
  text: string;
  /**
   * The browser is running a different deployment than the server. Next
   * regenerates server-action ids on every build, so a retry re-posts the same
   * dead id — the ONLY thing that can work is a reload.
   */
  stale: boolean;
  /**
   * The write never answered, so **whether it landed is unknown**. The timeout
   * bounds how long the UI waits, not the request, so the insert may still
   * complete and a retry after it does leaves two identical inbox items. Kept
   * distinct from the generic failure because "couldn't send that" would then be
   * a claim the client cannot support.
   */
  timedOut: boolean;
};

/**
 * Which message a failed eject gets — ordered by how much the user can be told,
 * most-certain first. Mirrors `captureMessageKey` in `inbox-view.tsx`,
 * `writeFailureKey` in `shopping-list.tsx` and `failureMessageKey` in
 * `focus-timer.tsx`: `stale` and `timedOut` both override the generic copy
 * because both change what the user should DO.
 */
function ejectMessageKey(failure: EjectFailure): StringKey {
  if (failure.stale) return "breakdown.eject.stale";
  if (failure.timedOut) return "breakdown.eject.timeout";
  return "breakdown.eject.failed";
}

/**
 * #212 — which row a settled eject is about, or `-1` for none.
 *
 * Proposed steps have no ids (they are an unsaved model proposal — see the
 * comment on the step list below), so the words ARE the identity and `hint` is
 * only the index the press came from. The hint is checked first, because two
 * rows can legitimately say the same thing and removing the one the user
 * actually pressed is the least surprising answer; it is then re-derived from
 * the text, because a reorder or a delete during the round trip has moved it.
 *
 * Answering `-1` matters as much as the other two: the user may have deleted
 * that row themselves while the write was outstanding, and removing whatever
 * happens to sit at the old index would be exactly the data loss this fix is
 * about, wearing a different hat.
 *
 * Pure and exported, so it is unit-testable on synthetic steps rather than only
 * through the component — the shape every hygiene module in `src/lib` uses.
 */
export function ejectedStepIndex(
  steps: readonly ProposedStep[],
  text: string,
  hint: number | null,
): number {
  if (hint !== null && steps[hint]?.text.trim() === text) return hint;
  return steps.findIndex((step) => step.text.trim() === text);
}

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
  scheduled = false,
  from,
}: {
  taskId: string;
  title: string;
  initialProposal: Proposal | null;
  /** Start with one blank step and skip the automatic AI proposal (manual re-plan). */
  startManual?: boolean;
  /**
   * The acting account's own Google status, or `null` when nobody is signed in.
   *
   * #118 Phase C: nullable, and the `isGuest` prop is gone. A null status IS the
   * guest signal — a signed-in member with no connection still gets a status
   * object (`connected: false`) so they see the Connect affordance, and a guest
   * gets nothing, which is also what keeps it out of the RSC payload.
   */
  google: GoogleConnStatus | null;
  /** Persisted ground truth: has this task ever been scheduled (task.scheduledAt)? */
  scheduled?: boolean;
  /** Origin (`?from=`) this task was opened from, so the back links + the
   * Start-focus navigation return the user to where they came from. */
  from?: string;
}) {
  const router = useRouter();
  const voice = useVoice();
  // #128 — the "which Google account" hint the connect/reconnect CTAs below are
  // described by. One id: those two branches are mutually exclusive, so only
  // ever one of them is in the tree.
  const accountHintId = useId();
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

  /**
   * #212 — the ejects whose writes are still outstanding, keyed by the words
   * they are sending.
   *
   * A Set rather than one boolean, and that is #169's lesson applied here: a
   * list-wide flag would make every row's control read busy because one of them
   * is, and it would be cleared by whichever request settled last rather than by
   * the one it was guarding. The words are the key because a proposed step has
   * no id (see `ejectedStepIndex`), and they are also the right key: a second
   * press of the SAME row is the double-submit to refuse, while a press of a
   * different row is an independent insert that should go.
   */
  const [ejecting, setEjecting] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /**
   * The same fact as `ejecting`, held where it can be read synchronously.
   *
   * React 19 flushes discrete events at synchronous priority, so state raised in
   * a click handler has landed before the next click reads it — but that is a
   * scheduling property, not a guarantee this component controls, and the thing
   * it would be guarding is a duplicate inbox item. The ref is the guard; the
   * state is what paints.
   */
  const ejectsInFlight = useRef<Set<string>>(new Set());
  /**
   * The eject that did not land. ONE slot, like the capture bar's (#210) — but
   * the boundary costs much less here, because a displaced notice loses only the
   * announcement. The words of every failed eject are still in their rows, which
   * is the whole point of not removing them; #210's field could hold one draft
   * and so had to choose which failure kept its text.
   */
  const [ejectFailure, setEjectFailure] = useState<EjectFailure | null>(null);
  const ejectErrorId = useId();
  const ejectSendingId = useId();
  const retryEjectRef = useRef<HTMLButtonElement | null>(null);
  const addStepRef = useRef<HTMLButtonElement | null>(null);
  /**
   * Each row's eject control, by index — so focus can be handed to the control
   * that TAKES THE PLACE of one that unmounts (WCAG 2.4.3). Indices shift down
   * on removal, which is exactly the wanted behaviour: index `i` after the
   * removal is the next step's button.
   */
  const ejectButtonRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  /** Where focus goes once a successful eject has re-rendered; `-1` = nowhere
   * left in the list, fall through to "Add a step". */
  const focusAfterEject = useRef<number | null>(null);
  useEffect(() => {
    const at = focusAfterEject.current;
    if (at === null) return;
    focusAfterEject.current = null;
    // In an effect rather than beside the state update: the old button is still
    // mounted then, so focusing anything would be undone by the unmount.
    const refs = ejectButtonRefs.current;
    (refs.get(at) ?? refs.get(at - 1) ?? addStepRef.current)?.focus();
  }, [proposal, ejecting, ejectFailure]);
  /**
   * The current steps, readable from a callback that started renders ago.
   *
   * Only for deciding WHERE focus lands — every decision that changes state goes
   * through a pure `setProposal` updater instead, because an updater that also
   * reported what it decided would have to mutate on the way past and would then
   * run twice under StrictMode.
   */
  const latestSteps = useRef<ProposedStep[]>(proposal?.steps ?? []);
  useEffect(() => {
    latestSteps.current = proposal?.steps ?? [];
  }, [proposal]);

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
    if (userLabel)
      setMessages((m) => [...m, { role: "user", text: userLabel }]);
    setStreaming(true);
    setStreamText("");
    let assistantText = "";
    try {
      const res = await fetch("/api/breakdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // #179 — the task ID, never its note. The server reads `Task.notes`
        // itself, under the session's own workspace, so what reaches the prompt
        // is a value the database vouches for rather than one this client
        // asserted (see `BreakdownRequest.taskId`).
        body: JSON.stringify({
          taskId,
          title,
          currentProposal: proposal,
          feedback,
        }),
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
      p
        ? {
            ...p,
            steps: p.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)),
          }
        : p,
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

  const markEjecting = (text: string, active: boolean) =>
    setEjecting((prev) => {
      // Never mutates the previous Set: React bails out of a re-render when the
      // reference is unchanged, which would strand the row's control busy.
      if (prev.has(text) === active) return prev;
      const next = new Set(prev);
      if (active) next.add(text);
      else next.delete(text);
      return next;
    });

  /**
   * #212 — send one step's words to the inbox, and only THEN take its row away.
   *
   * The old handler did it the other way round and fired the write with an
   * explicit `void`, so a rejection was discarded by design. A proposal's steps
   * are not persisted until the breakdown is confirmed (see the step list's own
   * comment), so that row was the only copy of the words: offline, a hung pod or
   * a deploy mid-session and they were gone, with nothing on screen saying so.
   * Losing text the user typed is this app's most serious failure class.
   *
   * The remedy is the strong one that #210's capture bar and !294's shopping
   * list could not use. Both had to empty a field and then restore it, guessing
   * whether the user had typed over it in the meantime. Here the row IS the
   * user's copy and it is an editable field they are looking at, so it simply
   * stays. Nothing is restored, nothing has to be re-inserted at a remembered
   * position in an ordered list the user may have reordered since, and the words
   * are never held only in a variable.
   *
   * Not navigation, despite the label: this control ejects one step and leaves
   * the user in the editor. The page's actual "go back" is `<BackLink>`.
   */
  const ejectStep = async (
    text: string,
    { hint, fromRetry }: { hint: number | null; fromRetry: boolean },
  ) => {
    if (ejectsInFlight.current.has(text)) return;
    ejectsInFlight.current.add(text);
    markEjecting(text, true);
    try {
      await withActionTimeout(createBrainDumpItem(text), EJECT_TIMEOUT_MS);
      // Read while the pressed control still exists — it is about to unmount
      // with its row, and a focus target read afterwards is read from a button
      // that has already gone.
      const pressed = fromRetry
        ? retryEjectRef.current
        : hint === null
          ? null
          : (ejectButtonRefs.current.get(hint) ?? null);
      if (pressed !== null && pressed === document.activeElement) {
        focusAfterEject.current = ejectedStepIndex(
          latestSteps.current,
          text,
          hint,
        );
      }
      // Pure updater, deciding from the CURRENT steps: a row the user reordered
      // or deleted while this was in flight must not be mistaken for the one
      // this attempt was about.
      setProposal((p) => {
        if (!p) return p;
        const at = ejectedStepIndex(p.steps, text, hint);
        return at < 0 ? p : { ...p, steps: p.steps.filter((_, j) => j !== at) };
      });
      // Only these words clear their own notice. A different eject succeeding
      // says nothing about this one, and clearing it would drop the only
      // announcement that anything went wrong.
      setEjectFailure((prev) => (prev?.text === text ? null : prev));
    } catch (error) {
      // The row is deliberately still there. On a timeout that is also the safe
      // direction: the insert may have landed, so the user can end up with the
      // step in the editor AND in the inbox — a duplicate is one tap to delete,
      // a step nobody wrote down is not recoverable at all.
      setEjectFailure({
        text,
        stale: isStaleActionError(error),
        timedOut: error instanceof ActionTimeoutError,
      });
    } finally {
      // Must run on every exit including a throw: a flag left up is a control
      // that reads permanently busy.
      ejectsInFlight.current.delete(text);
      markEjecting(text, false);
    }
  };

  // Eject a step back to the inbox "needs review" bucket as its own bigger task.
  // (Once confirmed, the working view uses the persisted ejectStepToInbox server
  // action instead — there the row exists on the server, so a failure leaves the
  // data intact and the press repeatable. Here it does not, which is #212.)
  function backToInbox(i: number) {
    const text = proposal?.steps[i]?.text.trim();
    // A blank row has nothing to send and nothing to lose, so it just goes —
    // same as pressing ✕, which is what the user means by ejecting an empty step.
    if (!text) {
      removeStep(i);
      return;
    }
    // `void`: `ejectStep` reports through state and cannot reject.
    void ejectStep(text, { hint: i, fromRetry: false });
  }

  const retryEject = () => {
    if (!ejectFailure || ejecting.has(ejectFailure.text)) return;
    // No index hint: the notice outlives whatever the list has done since, so
    // the row is re-found by its words or not at all.
    void ejectStep(ejectFailure.text, { hint: null, fromRetry: true });
  };

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
        message:
          map[res.reason] ?? res.message ?? "Sending to Google Tasks failed.",
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

  const totalMin =
    proposal?.steps.reduce((n, s) => n + (s.estMinutes || 0), 0) ?? 0;
  const busy = streaming || confirmPending;

  // Route the Google-vs-ICS control choice through the seam (S1, #34): the
  // "Schedule onto your calendar" (Google Tasks) section is offered to any
  // signed-in account (#118 Phase C — members have their own connection now);
  // a caller with no account only ever gets the universal ICS export above it.
  //
  // The explicit `google != null` is what narrows the type for the
  // `google.configured` dereference below — `leadSchedulingMethod` returning
  // "googleTasks" implies non-null logically, but TypeScript cannot see it.
  const showGoogleSection =
    google != null && leadSchedulingMethod(google) === "googleTasks";

  if (confirmed) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">
          {proposal?.parentEmoji} {title}
        </h1>
        {/* #109 — the tone (and with it the `dark:` partner this never had) now
            comes from the shared table; the colour sits on the tinted wrapper so
            the <p> inherits it rather than restating it. */}
        <div className={cn("rounded-lg border p-4", STATUS_BANNER_TONE.ok)}>
          <p className="font-medium">
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
            Download an .ics with each step as a timed event — import into
            Google, Apple, or Outlook. No account needed.
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
                    Google needs reconnecting — your access expired or was
                    revoked.
                  </p>
                  {/* #128 — on the reconnect path too: an administrator can
                      start blocking an app that connected fine before, and a
                      revoked token is exactly when someone re-picks an
                      account. */}
                  <GoogleAccountHint id={accountHintId} className="text-xs" />
                  <a
                    href="/api/google/oauth/start"
                    aria-describedby={accountHintId}
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
                  {/* #128 — the inline connect path README names alongside
                      Settings → Integrations, so it carries the same guidance
                      about which account to pick. */}
                  <GoogleAccountHint id={accountHintId} className="text-xs" />
                  <a
                    href="/api/google/oauth/start"
                    aria-describedby={accountHintId}
                    className="bg-primary text-primary-foreground inline-block rounded-md px-3 py-2 font-medium"
                  >
                    Connect Google Tasks →
                  </a>
                </div>
              ) : gsched.status === "done" ? (
                // #109 — no tint behind this one, so it keeps green-700 (4.65:1
                // on the light --background) and gains the dark partner it was
                // missing: green-700 is only 3.97:1 in dark, green-400 is 11.06:1.
                <p className="font-medium text-green-700 dark:text-green-400">
                  ✅ Sent {gsched.count} task{gsched.count === 1 ? "" : "s"} to
                  your &quot;{gsched.message}&quot; list.
                </p>
              ) : (
                <div className="space-y-2">
                  <p className="text-muted-foreground">
                    Send these steps to your Google Tasks list — a
                    Reclaim-synced list is scheduled automatically.
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
                      {/* #109 — untinted, so red-700 stays (6.04:1 light) and
                          gains the dark partner: red-700 is 3.06:1 in dark. */}
                      <p className="text-red-700 dark:text-red-400">
                        {gsched.message}
                      </p>
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
                Set <code>GOOGLE_CLIENT_ID</code> /{" "}
                <code>GOOGLE_CLIENT_SECRET</code> to schedule into Google Tasks
                (see the README). The calendar download above works without any
                integration — steps are saved either way.
              </p>
            )}
          </div>
        )}

        <div className="flex items-center gap-4">
          {/* full navigation so the server renders the focusable steps view */}
          <a
            href={withFrom(`/tasks/${taskId}`, from)}
            className="bg-primary text-primary-foreground inline-block rounded-md px-4 py-2 text-sm font-medium"
          >
            {t("action.startFocus", voice)}
          </a>
          <BackLink from={from} voice={voice} />
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
        <BackLink from={from} voice={voice} />
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
        <div
          className={cn(
            "rounded-lg border p-3 text-sm",
            STATUS_BANNER_TONE.warn,
          )}
        >
          {fallbackNote}
        </div>
      )}

      {error && (
        <div
          className={cn(
            "rounded-lg border p-3 text-sm",
            STATUS_BANNER_TONE.error,
          )}
        >
          {error}{" "}
          <button
            className="underline"
            onClick={() => request({ kind: "propose" })}
          >
            Try again
          </button>
        </div>
      )}

      {/* ── #212: a step that could not be sent to the inbox ─────────────────
          Above the list rather than inside a row, because the row it is about
          may have been deleted since — and because one notice for the surface
          is the shape `inbox-view.tsx` and `shopping-list.tsx` already use.

          `role="alert"` (assertive), and nothing polite nested inside it: a
          `role="status"` within an assertive region is undefined enough in
          practice that "will it announce" has no answer, and reproducing that
          shape is #218. The in-flight line rides `aria-describedby` off the
          pressed button instead.

          Focus is NOT moved here. The user is still in the editor with every
          row where they left it, so taking focus would interrupt them
          mid-sentence (WCAG 3.2.2). The alert announces without stealing.
          Focus IS moved when a row unmounts under it — see `focusAfterEject`.

          Colour: the failure is carried by the icon and the words, never by the
          red alone (WCAG 1.4.1). `text-destructive` / `border-destructive/40` /
          `bg-destructive/5` is the token pairing globals.css documents as AA in
          both themes and the one the other two notices already use. Neither
          control sets `outline-none`, so the UA focus ring draws and WCAG
          2.4.11 is satisfied without a bespoke indicator. */}
      {ejectFailure && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-start sm:justify-between"
        >
          <p
            id={ejectErrorId}
            className="text-destructive flex min-w-0 items-start gap-1.5 text-sm font-medium"
          >
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span className="break-words">
              {t(ejectMessageKey(ejectFailure), voice)}{" "}
              <strong>&ldquo;{ejectFailure.text}&rdquo;</strong>
            </span>
          </p>
          <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
            {ejectFailure.stale ? (
              // Retrying re-posts the same action id the running deployment has
              // already forgotten, so a reload is the ONLY thing on offer.
              <button
                type="button"
                aria-describedby={ejectErrorId}
                onClick={() => window.location.reload()}
                className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-4 text-sm font-medium"
              >
                <RefreshCw aria-hidden="true" className="h-4 w-4 shrink-0" />
                {t("breakdown.eject.reload", voice)}
              </button>
            ) : (
              <button
                ref={retryEjectRef}
                type="button"
                // While a retry runs, the reason AND the wait are both reachable
                // from the control.
                aria-describedby={
                  ejecting.has(ejectFailure.text)
                    ? `${ejectErrorId} ${ejectSendingId}`
                    : ejectErrorId
                }
                aria-disabled={ejecting.has(ejectFailure.text)}
                onClick={retryEject}
                className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-4 text-sm font-medium aria-disabled:opacity-50"
              >
                <RotateCcw aria-hidden="true" className="h-4 w-4 shrink-0" />
                {t("breakdown.eject.retry", voice)}
              </button>
            )}
            {/* The wait rides the two mechanisms that DO have a defined
                announcement: the pressed button's `aria-disabled` state change,
                which a screen reader reports because focus is on it, and the
                `aria-describedby` above, which picks this node up while it
                shows. Sighted users see the identical text either way. */}
            {ejecting.has(ejectFailure.text) && (
              <p id={ejectSendingId} className="text-muted-foreground text-xs">
                {t("breakdown.eject.sending", voice)}
              </p>
            )}
          </div>
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
            {/* #44 — NO note affordance in the editor, deliberately. These
                rows are an UNSAVED model proposal: they have no `Step` ids
                until the breakdown is confirmed, so a per-step note would have
                nowhere to be written. The task's own note is one click away in
                the working view, which is where a task is read rather than
                re-planned. */}
            {proposal.steps.map((s, i) => (
              <li
                key={i}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null && dragIndex !== i)
                    moveStep(dragIndex, i);
                  setDragIndex(null);
                }}
                className={cn(
                  // #63: cramming grip/emoji/text/minutes/actions onto one
                  // fixed row left the text input with almost no width on
                  // narrow viewports (and no `min-w-0`, so it couldn't shrink
                  // at all — forcing the whole row to overflow). Stack the
                  // primary (grip+order+emoji+text) and secondary
                  // (minutes+actions) groups on mobile, and go back to a
                  // single row at `sm:` — matching the mobile-first
                  // breakpoint convention already used elsewhere (see
                  // dashboard's `grid-cols-2 sm:grid-cols-4`).
                  "flex flex-col gap-2 rounded-lg border px-3 py-2 sm:flex-row sm:items-start",
                  dragIndex === i && "opacity-50",
                )}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span
                    draggable
                    onDragStart={() => setDragIndex(i)}
                    onDragEnd={() => setDragIndex(null)}
                    title="Drag to reorder"
                    aria-label="Drag to reorder"
                    className="text-muted-foreground hover:text-foreground shrink-0 cursor-grab text-xs select-none active:cursor-grabbing"
                  >
                    ⠿
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {i + 1}/{proposal.steps.length}
                  </span>
                  <EmojiPicker
                    value={s.subtaskEmoji}
                    onSelect={(emoji) => updateStep(i, { subtaskEmoji: emoji })}
                  />
                  <input
                    value={s.text}
                    onChange={(e) => updateStep(i, { text: e.target.value })}
                    className="border-input min-w-0 flex-1 rounded-md border px-2 py-1 text-sm"
                    aria-label="Step text"
                  />
                </div>
                <div className="flex items-center justify-between gap-2 sm:justify-start">
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
                  <div className="flex items-center gap-1 sm:flex-col sm:items-stretch">
                    {/* #212 — busy while THIS row's write is outstanding.
                        `aria-disabled`, never `disabled`: a disabled element
                        cannot hold focus, so the browser would drop the user to
                        <body> the moment they pressed it (WCAG 2.4.3). The press
                        is refused in `ejectStep` instead, so a double-tap still
                        cannot post twice. `aria-busy` is the machine-readable
                        half, and the visible label changes with the accessible
                        name so WCAG 2.5.3 (Label in Name) still holds — #169's
                        harm was a press that produced nothing visible for as
                        long as the request hung. */}
                    <button
                      ref={(el) => {
                        // Block body: a concise arrow would RETURN the Map, and
                        // React 19 reads a ref callback's return value as a
                        // cleanup function.
                        if (el) ejectButtonRefs.current.set(i, el);
                        else ejectButtonRefs.current.delete(i);
                      }}
                      type="button"
                      title="Send back to the inbox as its own item to re-break-down"
                      aria-label={
                        ejecting.has(s.text.trim())
                          ? `Back to inbox — ${t("breakdown.eject.sending", voice)}`
                          : "Back to inbox"
                      }
                      aria-disabled={ejecting.has(s.text.trim())}
                      aria-busy={ejecting.has(s.text.trim())}
                      onClick={() => {
                        if (!ejecting.has(s.text.trim())) backToInbox(i);
                      }}
                      className="text-muted-foreground hover:text-foreground hover:bg-accent rounded border px-1.5 py-0.5 text-xs whitespace-nowrap aria-disabled:opacity-50"
                    >
                      {ejecting.has(s.text.trim())
                        ? t("breakdown.eject.sending", voice)
                        : t("action.backToInbox", voice)}
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
          onClick={() => request({ kind: "too_big" }, "More, smaller steps ⬆️")}
          disabled={busy || !proposal}
          className="hover:bg-accent rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {t("action.moreSteps", voice)}
        </button>
        {/* #212 — also the last-resort focus target when an ejected row (and
            with it the control that was pressed) unmounts: it is the one control
            here that is always mounted whatever the list does. */}
        <button
          ref={addStepRef}
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
      {typing &&
        (!text ? "…thinking" : <span className="animate-pulse">▍</span>)}
    </div>
  );
}
