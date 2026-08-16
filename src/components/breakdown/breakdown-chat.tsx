"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Info, RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
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
import { cn, touchTarget } from "@/lib/utils";
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
 * this matches `CAPTURE_FLUSH_TIMEOUT_MS` in `use-capture-queue.ts`,
 * `SHOPPING_ACTION_TIMEOUT_MS` in `shopping-list.tsx` and `ACTION_TIMEOUT_MS` in
 * `focus-timer.tsx` for the same class of call. The request itself carries on (a
 * server action cannot be aborted from the client), so a write that lands late
 * still lands. Exported so the test advances the real value rather than a copy.
 */
export const EJECT_TIMEOUT_MS = 10_000;

/**
 * #212 (!304 review) — a proposal row, plus the identity `ProposedStep` cannot
 * carry.
 *
 * The first cut used the row's WORDS as its identity, because a proposed step
 * genuinely has no id: the rows are an unsaved model proposal and no `Step`
 * exists until the breakdown is confirmed. Duo's review found the two things
 * that costs, and both are the same fact seen from different sides — **the
 * words are not stable and they are not unique**:
 *
 *   • Edit a row while its own eject is in the air and its key changes out from
 *     under the outstanding write. Its control stops reading busy, the guard
 *     that refuses a double-submit no longer recognises it, and a second press
 *     inserts the row a second time.
 *   • Two rows can legitimately say the same thing ("Email the venue" twice, a
 *     week apart), and then they are ONE row as far as every eject decision is
 *     concerned: pressing either busies both, the second press is refused
 *     outright, and one row's success clears the other's failure notice.
 *
 * The remedy is the one the words were standing in for: mint an id when the row
 * enters the editor. It is a CLIENT-side identity and it stays there — see
 * `toProposal`, which strips it before anything crosses the wire.
 */
type EditorStep = ProposedStep & { key: string };
type EditorProposal = { parentEmoji: string; steps: EditorStep[] };

/**
 * A monotonic counter rather than `crypto.randomUUID()`.
 *
 * Uniqueness only has to hold within one browsing session's editor, a counter
 * is trivially collision-free at that scope, and `randomUUID` is unavailable
 * outside a secure context — which would make the whole editor depend on HTTPS
 * for something no user can see. Module-scoped, so two editors mounted at once
 * still cannot collide.
 */
let stepKeySeq = 0;
const withKey = (step: ProposedStep): EditorStep => ({
  ...step,
  key: `step-${++stepKeySeq}`,
});
const withKeys = (p: Proposal): EditorProposal => ({
  ...p,
  steps: p.steps.map(withKey),
});

/**
 * Drop the client-side identity on the way out.
 *
 * Not tidiness. `buildUserPrompt` splices the proposal into the model's turn
 * with `JSON.stringify`, so a key riding along would be spent tokens on every
 * refinement AND an identifier inside a payload that is deliberately free of
 * them (see the privacy note on `BreakdownContext`). `confirmBreakdown` maps
 * the three real fields explicitly and would ignore a fourth, but relying on
 * that would leave the prompt leak standing.
 */
function toProposal(p: EditorProposal): Proposal {
  return {
    parentEmoji: p.parentEmoji,
    steps: p.steps.map(({ text, estMinutes, subtaskEmoji }) => ({
      text,
      estMinutes,
      subtaskEmoji,
    })),
  };
}

/**
 * #212 — how a settled eject ended, from the row's point of view.
 *
 * One enum rather than the pair of booleans this started as, because the fourth
 * member is not a failure at all and must suppress the others rather than sit
 * alongside them: `edited` means the write LANDED. Booleans made that
 * expressible-but-wrong; a union makes it unrepresentable.
 */
type EjectOutcome =
  /** The write rejected for a reason a retry can plausibly fix. */
  | "failed"
  /**
   * The browser is running a different deployment than the server. Next
   * regenerates server-action ids on every build, so a retry re-posts the same
   * dead id — the ONLY thing that can work is a reload.
   */
  | "stale"
  /**
   * The write never answered, so **whether it landed is unknown**. The timeout
   * bounds how long the UI waits, not the request, so the insert may still
   * complete and a retry after it does leaves two identical inbox items. Kept
   * distinct from the generic failure because "couldn't send that" would then be
   * a claim the client cannot support.
   */
  | "timedOut"
  /**
   * The write landed, but the user edited the row while it was in the air, so
   * the inbox holds the earlier wording and the row holds theirs. Both are kept
   * — dropping the row would destroy the words they typed while waiting, which
   * is #212's own data loss with the hands swapped — so all that is left is to
   * say so.
   */
  | "edited";

/**
 * #212 — the eject the notice above the list is about.
 *
 * Holds the words as well as the outcome, so the notice can quote them. In the
 * common case they are also still in their row — which is the whole remedy here
 * — but the user may delete that row while the notice is up, and then this
 * record is the only copy. The `key` is what the notice is ABOUT: a Retry has to
 * re-target the same row, and a later eject of some other row must not clear it.
 */
type EjectNotice = {
  /** The row this attempt was about — never its text (see `EditorStep`). */
  key: string;
  /** The trimmed text that was sent. */
  text: string;
  outcome: EjectOutcome;
};

/**
 * Which message an eject notice gets. Mirrors `captureMessageKey` in
 * `inbox-view.tsx`, `writeFailureKey` in `shopping-list.tsx` and
 * `failureMessageKey` in `focus-timer.tsx` — a total map now the outcomes are an
 * enum, so adding one without its copy is a type error rather than a fall
 * through to "couldn't send that".
 */
const EJECT_MESSAGE: Record<EjectOutcome, StringKey> = {
  failed: "breakdown.eject.failed",
  stale: "breakdown.eject.stale",
  timedOut: "breakdown.eject.timeout",
  edited: "breakdown.eject.edited",
};

/** Which row a settled eject is about, and what should happen to it. */
export type SettledEject =
  /** The row is still there and still says what was sent — take it away. */
  | { kind: "remove"; at: number }
  /** The row is there but says something else now — keep it, and say so. */
  | { kind: "edited"; at: number }
  /** No such row: the user deleted it themselves while the write was out. */
  | { kind: "gone" };

/**
 * #212 (!304 review) — what a settled eject should do to the list.
 *
 * Keyed lookup, never a text match. The text is still compared, but only to
 * separate "this row is unchanged" from "the user has typed into it since" —
 * never to FIND the row, because two rows can say the same thing and removing
 * the wrong one is unrecoverable.
 *
 * `gone` matters as much as the other two, and is deliberately distinct from
 * `edited`: deleting the row is exactly what the user asked for, so it passes in
 * silence, while an edited row is a divergence they cannot see and have to be
 * told about. The words-only predecessor could not tell those two apart — both
 * came back `-1` — which is why the divergence was silent.
 *
 * Pure and exported, so it is unit-testable on synthetic steps rather than only
 * through the component — the shape every hygiene module in `src/lib` uses.
 */
export function settledEject(
  steps: readonly Pick<EditorStep, "key" | "text">[],
  key: string,
  sentText: string,
): SettledEject {
  const at = steps.findIndex((step) => step.key === key);
  if (at < 0) return { kind: "gone" };
  return steps[at].text.trim() === sentText
    ? { kind: "remove", at }
    : { kind: "edited", at };
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
  const [proposal, setProposal] = useState<EditorProposal | null>(() =>
    initialProposal
      ? withKeys(initialProposal)
      : startManual
        ? { parentEmoji: "🗂️", steps: [withKey(blankStep())] }
        : null,
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
   * #212 — the ejects whose writes are still outstanding, by row key.
   *
   * A Set rather than one boolean, and that is #169's lesson applied here: a
   * list-wide flag would make every row's control read busy because one of them
   * is, and it would be cleared by whichever request settled last rather than by
   * the one it was guarding.
   *
   * Keyed by the ROW (!304 review), not by the words it is sending. "A second
   * press of the same row is the double-submit to refuse, a press of a different
   * row is an independent insert that should go" was always the intent; with the
   * words as the key it was neither, in both directions at once — an edit
   * mid-flight let the same row through twice, and two rows saying the same
   * thing could not both go. See `EditorStep`.
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
   * #212 (!304 review) — is the plan itself in flight: being saved, or being
   * re-planned?
   *
   * The mirror of `ejectsInFlight`, and the direction the earlier rounds left
   * open. `confirm` and `request` both wait for an outstanding eject; neither an
   * eject nor the notice's Retry was asking whether one of THEM was already out,
   * and nothing on screen stopped them — `busy` reaches the re-plan controls,
   * "Add a step" and "Remove step", and neither eject affordance. Both halves
   * produce #212's own duplicate from the other end:
   *
   *   - confirm first: `confirmBreakdown` was handed a snapshot with the row in
   *     it before the press, so the eject sends the identical words to the inbox
   *     while the plan is being written with them. The saved view then replaces
   *     the editor, so the removal and any notice land on a list nobody is
   *     looking at — nothing is said;
   *   - re-plan first: the row is in the snapshot the model was shown (that IS
   *     #212's fix), so it comes back in the answer under a fresh key moments
   *     after the eject took it away. Silent by construction, because a
   *     successful eject is silent by design.
   *
   * A boolean where its sibling is a keyed Set, and that asymmetry is the truth
   * rather than a shortcut: there is one plan and only ever one operation on it
   * at a time — `request` returns early on `streaming`, and a confirm that lands
   * replaces the editor outright — so there is nothing to key by. #169's lesson
   * (a list-wide flag cleared by whichever request settled last) does not apply
   * where the list is one.
   *
   * On the ref rather than `busy`, for the reason `ejecting` gives: the state is
   * what paints, the ref is what decides. Raised synchronously in each handler
   * BEFORE its first await, so a press arriving in the gap cannot read a flag
   * that has not gone up yet, and lowered in a `finally` so a rejected save or a
   * failed stream lifts the hold rather than stranding it.
   */
  const planInFlight = useRef(false);
  /**
   * The eject the notice is about. ONE slot, like the capture bar's (#210) — but
   * the boundary costs much less here, because a displaced notice loses only the
   * announcement. The words of every failed eject are still in their rows, which
   * is the whole point of not removing them; #210's field could hold one draft
   * and so had to choose which failure kept its text.
   */
  const [ejectNotice, setEjectNotice] = useState<EjectNotice | null>(null);
  const ejectErrorId = useId();
  const ejectSendingId = useId();
  const ejectHeldId = useId();
  /** The mirror of `ejectHeldId`, for the hold pointing the other way. */
  const planHeldId = useId();
  /**
   * The notice's Retry control, **and the row that notice was about**.
   *
   * Keyed by row, like `ejectButtonRefs` below and for a related reason (!304
   * review) — except the single slot makes this one sharper rather than softer.
   * There is one Retry button because there is one notice, and the
   * failure branch of `setEjectNotice` takes that slot **unconditionally** — by
   * design, see its comment. So another row's eject can fail while this one's
   * retry is still in the air, and because the button is re-rendered rather than
   * remounted, a bare `useRef<HTMLButtonElement>` still resolves to it and it
   * still holds focus. It is simply somebody else's Retry by then.
   *
   * Reading that as "the control the user pressed" and handing focus onwards
   * moves them off a live Retry — the only thing on screen that can resend words
   * which never arrived — because a row left the list somewhere else (WCAG
   * 3.2.2). Storing the key makes "is this still mine?" answerable at the only
   * moment it matters: after the await.
   */
  const retryEjectRef = useRef<{
    key: string;
    el: HTMLButtonElement;
  } | null>(null);
  const addStepRef = useRef<HTMLButtonElement | null>(null);
  /**
   * Each row's eject control, **by row key** — so focus can be handed to the
   * control that TAKES THE PLACE of one that unmounts (WCAG 2.4.3).
   *
   * By key rather than by index (!304 review). The index version leaned on
   * "indices shift down on removal, so index `i` afterwards is the next step's
   * button", which is true of the list and not of this Map: every row re-runs
   * its inline ref callback on every render, so with indices as keys a removal
   * has one row detaching index `i` while another attaches it, and the answer
   * depends on the order React happens to commit them in. Row keys are stable
   * for the row's whole life, so a detach and an attach can never name the same
   * entry unless they are the same row.
   */
  const ejectButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  /**
   * Where focus goes once the control the user was standing on has unmounted.
   *
   * `null` means leave focus alone — the overwhelmingly common case, including
   * every eject the user did not have focus on. A `rowKey` of `null` is the
   * other thing: focus SHOULD move, but no row is left to take it, so it falls
   * through to "Add a step".
   *
   * Three arms, all WCAG 2.4.3 and all the same shape — a control is DESTROYED
   * rather than merely held, which is the half no `aria-disabled` choice can
   * reach (that is why the row controls, the Retry and "Looks right" all carry
   * one, and why it was not enough on its own). `task-steps.tsx` took the same
   * route for the same reason in #215:
   *
   *   - a successful eject removes the row, taking the pressed control with it
   *     → the row that takes its place, or the list ran out;
   *   - "Got it" withdraws the `edited` notice it lives inside (!304 review)
   *     → the row that notice named. That row is kept precisely so the words
   *       typed while waiting survive, and its own eject control is the SAME
   *       action, so focus has not wandered somewhere unrelated;
   *   - a retry landing on a row the user deleted meanwhile settles `gone`,
   *     which clears the notice and takes the Retry with it (!304 review)
   *     → nothing replaced the row, so "Add a step".
   *
   * The case that looks like a fourth and is not: a retry settling `edited`
   * swaps Retry for "Got it" in the same slot, and React updates that one
   * `<button>` in place rather than remounting it. Focus never leaves, and
   * arming a hand-off there would move it for no reason (WCAG 3.2.2).
   *
   * One slot rather than the keyed Set `task-steps.tsx` uses, because these
   * cannot overlap: every arm is paired with a state change that this effect
   * depends on, so each is drained on the very next commit.
   */
  const focusAfterUnmount = useRef<{ rowKey: string | null } | null>(null);
  useEffect(() => {
    const target = focusAfterUnmount.current;
    if (target === null) return;
    focusAfterUnmount.current = null;
    // In an effect rather than beside the state update: the old button is still
    // mounted then, so focusing anything would be undone by the unmount.
    const refs = ejectButtonRefs.current;
    const landing = target.rowKey === null ? null : refs.get(target.rowKey);
    (landing ?? addStepRef.current)?.focus();
  }, [proposal, ejecting, ejectNotice]);
  /**
   * The current steps, readable from a callback that started renders ago.
   *
   * Only for deciding WHERE focus lands — every decision that changes state goes
   * through a pure `setProposal` updater instead, because an updater that also
   * reported what it decided would have to mutate on the way past and would then
   * run twice under StrictMode.
   */
  const latestSteps = useRef<EditorStep[]>(proposal?.steps ?? []);
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
    /**
     * #212 (!304 review) — never across an outstanding eject either, and this is
     * the sibling of `confirm`'s gate rather than a second idea.
     *
     * `request` writes nothing, which is exactly why the first cut left it alone
     * (see `ejectPending`, whose note used to say so). It is still the same bug,
     * because of what it does instead: it shows the model **a snapshot of the
     * plan** and then **replaces the plan with the answer**. A row mid-eject is
     * deliberately still in that snapshot — that IS #212's fix — so the model
     * plans around it and hands it back, under a fresh key, moments after the
     * eject took it away. The step is then in the inbox and in the plan, and the
     * next confirm persists both. `confirm`'s own gate cannot see it: by then
     * the eject has long settled and the row is, as far as the editor knows, an
     * ordinary one.
     *
     * Nothing announces it. A successful eject is silent by design — the row
     * simply goes — so from the user's side a row they ejected vanishes and then
     * reappears, and the two copies only ever meet in front of them, later.
     *
     * At the door rather than on each control, so every route in is covered by
     * one guard: the two quick replies, the free-text form, the error banner's
     * "Try again", and the mount-time propose (where the set is always empty).
     * On the REF, not the state, for the reason `ejectStep` and `confirm` give.
     * A wait, not a refusal — `ejectStep`'s `finally` drains the set on every
     * exit including a throw, so a failed eject leaves the row in the plan where
     * re-planning around it is the truth, and the gate lifts either way.
     */
    if (ejectsInFlight.current.size > 0) return;
    // Raised here — past both gates, before the fetch — so an eject pressed
    // while this stream is open reads it. See `planInFlight`.
    planInFlight.current = true;
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
        // `toProposal`: the editor's row keys are a client-side identity and
        // this body is spliced into the model's prompt verbatim. See its docs.
        body: JSON.stringify({
          taskId,
          title,
          currentProposal: proposal && toProposal(proposal),
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
            // Fresh keys: a re-proposal is a new list of rows, even where the
            // words coincide with the ones it replaced. Minted here rather than
            // inside the updater, which must stay pure — see `latestSteps`.
            setProposal(withKeys(ev.data));
          } else if (ev.type === "fallback") {
            setProposal(withKeys(ev.data));
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
      // Lowered beside `setStreaming(false)`, and on every exit including the
      // catch above: a stream that failed still leaves the plan as it was, so
      // the row is once again the only copy and its eject must be pressable.
      planInFlight.current = false;
      setStreaming(false);
      setStreamText("");
    }
  }

  function updateStep(i: number, patch: Partial<ProposedStep>) {
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

  const markEjecting = (key: string, active: boolean) =>
    setEjecting((prev) => {
      // Never mutates the previous Set: React bails out of a re-render when the
      // reference is unchanged, which would strand the row's control busy.
      if (prev.has(key) === active) return prev;
      const next = new Set(prev);
      if (active) next.add(key);
      else next.delete(key);
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
    key: string,
    text: string,
    { fromRetry }: { fromRetry: boolean },
  ) => {
    if (ejectsInFlight.current.has(key)) return;
    /**
     * #212 (!304 review) — nor while the plan itself is out, which is the same
     * duplicate approached from the other end (see `planInFlight`).
     *
     * At the door, the shape `request`'s gate settled on, so both routes in are
     * covered by one guard rather than each caller remembering: the row's own
     * control and the notice's Retry. A wait, not a refusal — both holders lower
     * the flag in a `finally`, so the gate lifts on a rejected save and a failed
     * stream as readily as on a successful one.
     */
    if (planInFlight.current) return;
    ejectsInFlight.current.add(key);
    markEjecting(key, true);
    try {
      await withActionTimeout(createBrainDumpItem(text), EJECT_TIMEOUT_MS);
      // Read while the pressed control still exists — it is about to unmount
      // with its row, and a focus target read afterwards is read from a button
      // that has already gone.
      //
      // For a retry that also means asking WHOSE Retry the one slot is showing
      // now (!304 review): another row's failure may have taken it while this
      // write was out, and the button is re-rendered rather than remounted, so
      // both the ref and `document.activeElement` still point at it. `null` here
      // is the whole remedy — no pressed control means no focus move, and the
      // user stays on the live Retry they are actually looking at.
      const retry = retryEjectRef.current;
      const pressed = fromRetry
        ? retry?.key === key
          ? retry.el
          : null
        : (ejectButtonRefs.current.get(key) ?? null);
      // Decided ONCE, from the last committed steps, and then used for all
      // three of focus, removal and the notice. Deriving it twice from two
      // sources is how they come to disagree; the removal below is by key, so
      // it stays correct even if the list moved under this in the meantime.
      const steps = latestSteps.current;
      const settled = settledEject(steps, key, text);
      // Both branches ask the same question first — is the control about to be
      // destroyed the one the user is standing on? — because that, and not the
      // press, is what WCAG 2.4.3 is about. A press whose control never held
      // focus (Safari does not focus a button on click) has nothing to hand on,
      // and moving focus anyway would be 3.2.2's harm instead.
      const handOff = pressed !== null && pressed === document.activeElement;
      if (settled.kind === "remove") {
        if (handOff) {
          // The row that will occupy this one's place: the next one down, or
          // the one above when this was the last. A key, not an index — by the
          // time the effect runs the indices have all moved.
          const successor = steps[settled.at + 1] ?? steps[settled.at - 1];
          focusAfterUnmount.current = { rowKey: successor?.key ?? null };
        }
        // Pure updater, and removing by key: a row the user reordered while
        // this was in flight is still the same row, and one that merely says
        // the same words never was.
        setProposal((p) =>
          p ? { ...p, steps: p.steps.filter((s) => s.key !== key) } : p,
        );
      } else if (settled.kind === "gone" && handOff) {
        // The retry-after-delete path (!304 review, and the focus half of the
        // answer to "should a retry check its row still exists?" — it should
        // not; see `retryEject`). `pressed` can only be the notice's own Retry
        // here: an ordinary eject's row control was unregistered when the user
        // deleted the row, and the identity guard above has already ruled out
        // somebody else's Retry. The updater below then clears this notice, so
        // that button is on its way out — and nothing took the deleted row's
        // place, so the last-resort landing spot is the only one left.
        focusAfterUnmount.current = { rowKey: null };
      }
      setEjectNotice((prev) => {
        // The write landed on words the row no longer says. Neither copy can be
        // dropped — the inbox item cannot be unsent, and removing the row would
        // destroy what the user typed while waiting — so the only thing left is
        // to tell them, or they get an item they never saw arrive.
        if (settled.kind === "edited") {
          // …but only into a free slot or this row's own (!311 review). The
          // branch below already holds that a notice belongs to the row it
          // names; writing this one without reading `prev` broke that in the
          // one direction that costs the user an action, because the notice it
          // displaced could be another row's unresolved failure — the only
          // thing on screen carrying that row's Retry. What is given up the
          // other way is an announcement about something already over: both
          // copies of the words are safe and this notice's only control
          // dismisses it. That asymmetry is what decides the single slot
          // (#210's boundary, and see `ejectNotice`'s own note).
          return prev === null || prev.key === key
            ? { key, text, outcome: "edited" }
            : prev;
        }
        // Otherwise only THIS row clears its own notice. A different eject
        // succeeding says nothing about this one, and clearing it would drop
        // the only announcement that anything went wrong — including when the
        // other row happens to say exactly the same thing (!304 review).
        return prev?.key === key ? null : prev;
      });
    } catch (error) {
      // The row is deliberately still there. On a timeout that is also the safe
      // direction: the insert may have landed, so the user can end up with the
      // step in the editor AND in the inbox — a duplicate is one tap to delete,
      // a step nobody wrote down is not recoverable at all.
      //
      // Unconditional, unlike the `edited` branch above, and for the reason
      // that branch is not (!311 review): this is a live failure of a press the
      // user just made. Yielding the slot to an older notice would leave that
      // press with nothing visible to show for it, which is #169's harm exactly
      // — and the displaced failure's words are still in their row, with that
      // row's own control able to send them again.
      setEjectNotice({
        key,
        text,
        outcome: isStaleActionError(error)
          ? "stale"
          : error instanceof ActionTimeoutError
            ? "timedOut"
            : "failed",
      });
    } finally {
      // Must run on every exit including a throw: a flag left up is a control
      // that reads permanently busy.
      ejectsInFlight.current.delete(key);
      markEjecting(key, false);
    }
  };

  // Eject a step back to the inbox "needs review" bucket as its own bigger task.
  // (Once confirmed, the working view uses the persisted ejectStepToInbox server
  // action instead — there the row exists on the server, so a failure leaves the
  // data intact and the press repeatable. Here it does not, which is #212.)
  function backToInbox(i: number) {
    const step = proposal?.steps[i];
    if (!step) return;
    const text = step.text.trim();
    // A blank row has nothing to send and nothing to lose, so it just goes —
    // same as pressing ✕, which is what the user means by ejecting an empty step.
    if (!text) {
      // The one branch `ejectStep`'s door cannot answer for (!304 review): it
      // removes the row without a write, so it never reaches that gate. Asked
      // here, and ONLY here, so the door stays the single guard on everything
      // that writes — otherwise the control would paint `aria-disabled` while
      // this branch quietly carried on, which is the ARIA equivalent of the
      // silent refusal #169 is about.
      if (planInFlight.current) return;
      removeStep(i);
      return;
    }
    // `void`: `ejectStep` reports through state and cannot reject.
    void ejectStep(step.key, text, { fromRetry: false });
  }

  const retryEject = () => {
    if (!ejectNotice || ejectNotice.outcome === "edited") return;
    if (ejecting.has(ejectNotice.key)) return;
    // The notice carries the row it was about, so a retry re-targets that row
    // however the list has been rearranged since — or, if the user deleted it,
    // lands in the inbox and quietly changes nothing here.
    //
    // Deliberately NOT gated on the row still existing (!304 review asked). Once
    // the row is deleted the notice holds the ONLY copy of those words — the
    // failure branch keeps the row, so a user who removes it anyway has the
    // notice and nothing else — and a Retry that refused for lack of a row would
    // destroy them, with no other control on offer to save them. That is #212's
    // harm exactly, wearing the other hat. What the ungated version can produce
    // is an inbox item for a step no longer in the plan, from two deliberate
    // presses asking for precisely that; `settledEject`'s `gone` then leaves the
    // list alone and clears the notice in silence.
    void ejectStep(ejectNotice.key, ejectNotice.text, { fromRetry: true });
  };

  // Manual "Add a step" — appends a blank, editable row. No Claude call; the
  // list is rebuilt from the controlled state, so numbering stays 0-based.
  function addStep() {
    // Minted outside the updater, so StrictMode's second pass reuses this row's
    // key rather than burning a new one and remounting the row.
    const step = withKey(blankStep());
    setProposal((p) =>
      p
        ? { ...p, steps: [...p.steps, step] }
        : { parentEmoji: "🗂️", steps: [step] },
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
    /**
     * #212 (!304 review) — never across an outstanding eject.
     *
     * The two halves of this file each look right alone and duplicate a step
     * together. `confirmBreakdown` persists **every** row that has text, and
     * #212's whole fix is that an ejecting row STAYS until its write lands — so
     * confirming in the gap writes that step into the plan while the identical
     * words are on their way to the inbox. Two records, in two places nothing
     * links, from one press.
     *
     * Worse than a duplicate the user can see, because by the time the write
     * settles the editor has been replaced by the saved view: the removal lands
     * on a list that is no longer rendered, and so does every notice that would
     * have said a word about any of it. Nothing is announced, and the two copies
     * only ever meet in front of the user, later.
     *
     * Gated on the in-flight set the eject path already keeps rather than a
     * second mechanism, and on the REF rather than the state for the same reason
     * `ejectStep` guards on the ref: the state is what paints, the ref is what
     * decides. It is a wait, not a refusal — `ejectStep`'s `finally` drains the
     * set on every exit including a throw, so the gate lifts the moment the
     * write settles either way, and a failed eject leaves the row in the plan
     * where it is now the only copy.
     */
    if (ejectsInFlight.current.size > 0) return;
    // And the reverse of it (!304 review). Raised before `startConfirm` rather
    // than inside the transition, because the snapshot below is taken from the
    // plan as it stands right now: from this line on, an eject would be sending
    // to the inbox words this save is already committing to the plan.
    planInFlight.current = true;
    startConfirm(async () => {
      try {
        await confirmBreakdown(taskId, toProposal(proposal));
        setConfirmed(true);
      } finally {
        // A save that rejects leaves the plan unsaved and every row still the
        // only copy of its words, so the hold has to lift with it.
        planInFlight.current = false;
      }
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
  /**
   * Is any row's eject still outstanding? The paint half of the gate —
   * `ejectsInFlight` decides, this is the same fact as state so the controls can
   * say it.
   *
   * It used to read "deliberately not folded into `busy`, because the re-plan
   * controls write nothing a pending eject could duplicate". The second half of
   * that was wrong and the review found it (!304): a re-plan does not write, it
   * SHOWS the model the plan and then replaces it, which brings an ejecting row
   * back under a fresh key. See `request`'s gate.
   *
   * Still deliberately not folded into `busy`: that is a `disabled` flag where
   * this one has to stay focusable, and the two controls it drives that this
   * does not — "Add a step" and "Remove step" — genuinely do not need holding.
   * Removing a row mid-eject is the same act as pressing ✕ on it, which is a
   * thing the user is allowed to mean; `settledEject`'s `gone` already answers
   * it, in silence and on purpose.
   */
  const ejectPending = ejecting.size > 0;
  /**
   * The held line, composed rather than templated: `strings.ts` is a flat table
   * with no interpolation (#86), so a count reaches the user the way
   * `shoppingSummaryLabel` does it — `<count> <counted noun> <invariant tail>`.
   *
   * `ejecting.size`, the same fact the gate is read from, so the sentence cannot
   * come to disagree with the controls it explains.
   */
  const ejectHeldLine = `${ejecting.size} ${t(
    ejecting.size === 1 ? "breakdown.stepOne" : "breakdown.stepMany",
    voice,
  )} ${t("breakdown.ejectHeld", voice)}`;
  /**
   * #212 (!304 review) — the reverse hold, painted: is the plan out, AND is
   * there a row (or a notice) for that to be about?
   *
   * #238 widened what it governs without changing what it MEANS. It used to
   * hold the two eject affordances; it now holds every control inside a row as
   * well — the emoji, the step text, the minutes, the ✕ and the drag grip —
   * because a re-plan replaces the step list wholesale with an answer computed
   * from a snapshot taken when the request went out, so an edit made in the gap
   * is overwritten with nothing said. Those five were the only controls in the
   * editor that were not already waiting; the seven around the list have read
   * `busy` since before #212. The name kept `eject` because renaming it would
   * churn `!304`'s specs for no behavioural difference, and the second clause
   * below is why it still reads correctly: it asks whether there is anything on
   * screen for the hold to be ABOUT, and a row is exactly that.
   *
   * `busy` is the same fact as `planInFlight`, held as state — the ref decides,
   * this paints, exactly the split `ejectsInFlight`/`ejecting` uses. It is read
   * off `busy` rather than a fourth piece of state because `streaming` and
   * `confirmPending` already ARE that fact and a second copy could only drift
   * from them.
   *
   * The second clause is not belt-and-braces. The mount-time propose raises
   * `streaming` before any row exists, and a sentence explaining why "Back to
   * inbox" is waiting, on a screen with no "Back to inbox" on it, is a stray
   * announcement rather than an explanation — the notice's Retry is the other
   * affordance it can be about, and that one outlives its row on purpose.
   */
  const ejectHeldByPlan =
    busy && ((proposal?.steps.length ?? 0) > 0 || ejectNotice !== null);

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
                        <>
                          {/* #128 — the THIRD connect control in this file, and
                              the one that shipped without the caveat while the
                              two above it carried it. Found while #253 audited
                              every connect entry point in the tree, because it
                              moved the row's control out of that set and had to
                              show the obligation still held everywhere else.
                              This one is reached mid-flow, from a failed push
                              (`reconnect_required`) rather than from a resting
                              "not connected" state — which is exactly when
                              someone re-picks an account, and therefore exactly
                              when a managed account gets chosen again and
                              refused with nothing to report. Same wiring as its
                              two siblings: the sentence above the link, pointed
                              at with `aria-describedby`. */}
                          <GoogleAccountHint
                            id={accountHintId}
                            className="text-xs"
                          />
                          <a
                            href="/api/google/oauth/start"
                            aria-describedby={accountHintId}
                            className="bg-primary text-primary-foreground inline-block rounded-md px-3 py-2 font-medium"
                          >
                            Reconnect Google →
                          </a>
                        </>
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
          // Ask BEFORE emptying the box (!304 review). `request` holds the
          // authoritative gate, so no caller can route round it — but a handler
          // that had already cleared the field would answer that refusal by
          // destroying words the user typed, with nothing on screen offering
          // them back. That is #212's own harm, one control along. The duplicate
          // guard exists only to keep the text, and reads the same ref for the
          // same reason: the state is what paints, the ref is what decides.
          if (ejectsInFlight.current.size > 0) return;
          setFreeText("");
          request({ kind: "free", text: v }, `✍️ ${v}`);
        }}
        className="flex gap-2"
      >
        {/* Not held: typing is not the thing a pending eject collides with, and
            taking the field away mid-sentence would be the worse trade. */}
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
          // Held, and `aria-disabled` rather than `disabled`, for the reason
          // spelled out on "Looks right" below. The description it points at is
          // the shared held line at the foot of the panel: one sentence covering
          // every control the same event holds, rather than the same words
          // repeated beside each of them.
          aria-disabled={ejectPending}
          aria-describedby={ejectPending ? ejectHeldId : undefined}
          className="hover:bg-accent rounded-md border px-3 py-2 text-sm aria-disabled:opacity-50 disabled:opacity-50"
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
          {/* Held too, and the most destructive of the three if it were not: a
              bare `propose` replaces the whole list, so a row on its way to the
              inbox comes back with everything else. */}
          <button
            className="underline aria-disabled:opacity-50"
            aria-disabled={ejectPending}
            aria-describedby={ejectPending ? ejectHeldId : undefined}
            onClick={() => request({ kind: "propose" })}
          >
            Try again
          </button>
        </div>
      )}

      {/* ── #212: how a step's eject to the inbox ended ──────────────────────
          Above the list rather than inside a row, because the row it is about
          may have been deleted since — and because one notice for the surface
          is the shape `inbox-view.tsx` and `shopping-list.tsx` already use.

          Two live-region roles, by outcome, and NEVER nested (which is #218's
          shape — a `role="status"` inside an assertive region is undefined
          enough in practice that "will it announce" has no answer). The three
          failures are `role="alert"`; `edited` is `role="status"`, because
          nothing failed there — the write landed and the notice is reporting a
          divergence, so interrupting whatever a screen reader is mid-way
          through would overstate it. The in-flight line rides
          `aria-describedby` off the pressed button in both.

          Focus is NOT moved when this appears. The user is still in the editor
          with every row where they left it, so taking focus would interrupt
          them mid-sentence (WCAG 3.2.2). The notice announces without
          stealing. It IS moved when something the user is standing on unmounts
          — a row leaving the list, or one of this notice's own controls taking
          the notice with it (WCAG 2.4.3). See `focusAfterUnmount`.

          Colour: the outcome is carried by the icon and the words, never by the
          hue alone (WCAG 1.4.1). `text-destructive` / `border-destructive/40` /
          `bg-destructive/5` is the token pairing globals.css documents as AA in
          both themes and the one the other two notices already use; `edited`
          takes `STATUS_BANNER_TONE.warn` — "attention, not alarm", measured AA
          over its own tint in both themes by #109, and never re-spelled here
          (see that module's "do not re-hardcode a banner tone"). Neither
          control sets `outline-none`, so the UA focus ring draws and WCAG
          2.4.7 Focus Visible is satisfied without a bespoke indicator. */}
      {ejectNotice && (
        <div
          role={ejectNotice.outcome === "edited" ? "status" : "alert"}
          className={cn(
            "flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-start sm:justify-between",
            ejectNotice.outcome === "edited"
              ? STATUS_BANNER_TONE.warn
              : "border-destructive/40 bg-destructive/5",
          )}
        >
          <p
            id={ejectErrorId}
            className={cn(
              "flex min-w-0 items-start gap-1.5 text-sm font-medium",
              // The warn tone puts its colour on the wrapper, so this inherits
              // it; the destructive pairing does not, so it says so here.
              ejectNotice.outcome !== "edited" && "text-destructive",
            )}
          >
            {ejectNotice.outcome === "edited" ? (
              <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0"
              />
            )}
            <span className="break-words">
              {t(EJECT_MESSAGE[ejectNotice.outcome], voice)}{" "}
              <strong>&ldquo;{ejectNotice.text}&rdquo;</strong>
            </span>
          </p>
          <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
            {ejectNotice.outcome === "edited" ? (
              // Nothing to retry — the write landed. Without an acknowledgement
              // this notice has no way to end, because the thing it reports is
              // already over; the three failures all resolve themselves through
              // the action they offer.
              //
              // …which makes it the one control here whose whole job is to
              // destroy itself, so `aria-disabled` has nothing to say and the
              // hand-off does it all (!304 review). See `focusAfterUnmount`.
              <button
                type="button"
                aria-describedby={ejectErrorId}
                onClick={(e) => {
                  // `currentTarget`, read synchronously: this is the button, and
                  // the question is only whether the user is standing on it.
                  if (e.currentTarget === document.activeElement) {
                    focusAfterUnmount.current = { rowKey: ejectNotice.key };
                  }
                  setEjectNotice(null);
                }}
                className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-4 text-sm font-medium"
              >
                {t("breakdown.eject.dismiss", voice)}
              </button>
            ) : ejectNotice.outcome === "stale" ? (
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
                ref={(el) => {
                  // Block body: a concise arrow would RETURN the assignment,
                  // and React 19 reads a ref callback's return value as a
                  // cleanup function. Same shape as the row controls' Map.
                  //
                  // Re-runs on every render, which is what keeps the key
                  // honest: the slot can change rows without the button being
                  // remounted, and this is the commit that sees it.
                  if (el) retryEjectRef.current = { key: ejectNotice.key, el };
                  else retryEjectRef.current = null;
                }}
                type="button"
                // While a retry runs, the reason AND the wait are both reachable
                // from the control — and so is the OTHER wait (!304 review),
                // the one where the plan is out and this resend would duplicate
                // into it. The notice's own reason is never dropped for either:
                // a Retry that cannot say what it is retrying is worse than one
                // that cannot say why it is waiting.
                aria-describedby={
                  ejecting.has(ejectNotice.key)
                    ? `${ejectErrorId} ${ejectSendingId}`
                    : ejectHeldByPlan
                      ? `${ejectErrorId} ${planHeldId}`
                      : ejectErrorId
                }
                aria-disabled={ejecting.has(ejectNotice.key) || ejectHeldByPlan}
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
            {ejecting.has(ejectNotice.key) && (
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
                // The row's own key, never its index (!304 review). With
                // indices, ejecting row 0 hands row 0's DOM — and anything
                // living in it, an open `EmojiPicker`, a caret, an IME
                // composition — to what was row 1, because React sees one list
                // that changed its contents rather than one row that left.
                key={s.key}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  // #238 — the drop half of the hold. Guarding only the grip
                  // would leave a drag STARTED before the stream able to land
                  // after it: `dragIndex` survives the transition, and the drop
                  // is what actually calls `moveStep`. Both ends, or neither.
                  if (
                    !ejectHeldByPlan &&
                    dragIndex !== null &&
                    dragIndex !== i
                  ) {
                    moveStep(dragIndex, i);
                  }
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
                  {/* #238 — held while the plan is out, like everything else in
                      this row. `draggable={false}` is the mechanism: the
                      element is not focusable and has no key handling, so there
                      is no press to refuse the way the ✕ below refuses one, and
                      no state a keyboard user could land on to read a reason
                      from. `aria-disabled` is still set, because a pointer user
                      on a screen reader can route to it and the grab cursor
                      going away is the only other signal it has. */}
                  <span
                    draggable={!ejectHeldByPlan}
                    onDragStart={() => setDragIndex(i)}
                    onDragEnd={() => setDragIndex(null)}
                    title="Drag to reorder"
                    aria-label="Drag to reorder"
                    aria-disabled={ejectHeldByPlan}
                    className={cn(
                      "text-muted-foreground shrink-0 text-xs select-none",
                      ejectHeldByPlan
                        ? "opacity-50"
                        : "hover:text-foreground cursor-grab active:cursor-grabbing",
                    )}
                  >
                    ⠿
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {i + 1}/{proposal.steps.length}
                  </span>
                  {/* #238 — the three that carry the user's own content, all
                      held on the same fact as the seven controls around the
                      list, and all with plain `disabled` to match them.

                      `disabled` rather than the `aria-disabled` its ✕ neighbour
                      takes, and the difference is not inconsistency: a disabled
                      element cannot hold focus, which is the whole reason the
                      eject controls refuse `disabled` — the browser would drop
                      the user to <body> mid-press. None of these three can be
                      pressed at all. Every route into a stream (the two quick
                      replies, the free-text form, the error banner's "Try
                      again", the mount-time propose) puts focus on the control
                      that started it, so no caret is ever inside one of these
                      when the hold arrives, and nothing is dropped anywhere.
                      What a keyboard user gets instead is these three leaving
                      the tab order while the ✕ stays in it carrying the reason,
                      which is one reachable explanation per row rather than
                      four. */}
                  <EmojiPicker
                    value={s.subtaskEmoji}
                    onSelect={(emoji) => updateStep(i, { subtaskEmoji: emoji })}
                    disabled={ejectHeldByPlan}
                  />
                  <input
                    value={s.text}
                    onChange={(e) => updateStep(i, { text: e.target.value })}
                    disabled={ejectHeldByPlan}
                    className="border-input min-w-0 flex-1 rounded-md border px-2 py-1 text-sm disabled:opacity-50"
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
                      disabled={ejectHeldByPlan}
                      className="border-input w-16 rounded-md border px-1 py-1 text-right text-sm disabled:opacity-50"
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
                        long as the request hung.

                        Read off the row's key, not its words (!304 review).
                        Keyed by text, this state belonged to the CHARACTERS: it
                        fell off the row the moment the user typed into it, and
                        it was shared by any other row that happened to say the
                        same thing. */}
                    <button
                      ref={(el) => {
                        // Block body: a concise arrow would RETURN the Map, and
                        // React 19 reads a ref callback's return value as a
                        // cleanup function.
                        if (el) ejectButtonRefs.current.set(s.key, el);
                        else ejectButtonRefs.current.delete(s.key);
                      }}
                      type="button"
                      title="Send back to the inbox as its own item to re-break-down"
                      aria-label={
                        ejecting.has(s.key)
                          ? `Back to inbox — ${t("breakdown.eject.sending", voice)}`
                          : "Back to inbox"
                      }
                      // Two holds, one control (!304 review). This row's own
                      // write is one; the plan being saved or re-planned is the
                      // other, and they are mutually exclusive by construction —
                      // each gate stops the other from starting — so the
                      // description below is never ambiguous about which.
                      aria-disabled={ejecting.has(s.key) || ejectHeldByPlan}
                      // `aria-busy` stays this row's fact alone: the plan being
                      // out says nothing about THIS control having work in
                      // flight, and the label below stays "Back to inbox"
                      // accordingly (WCAG 2.5.3).
                      aria-busy={ejecting.has(s.key)}
                      aria-describedby={
                        ejectHeldByPlan ? planHeldId : undefined
                      }
                      onClick={() => {
                        if (!ejecting.has(s.key)) backToInbox(i);
                      }}
                      // #205 / WCAG 2.5.8 — this was 86.3x22px, BELOW the AA
                      // floor of 24x24, so unlike the rest of #205's sweep this
                      // is a conformance fix rather than a house-convention one.
                      // (#205's body says these controls "already meet" AA; they
                      // did not, and that sentence is corrected there.)
                      //
                      // `justify-start` AFTER `touchTarget`: that constant carries
                      // `justify-center` and `cn` is `twMerge`, so order decides —
                      // reversed, this label would centre inside its 44px box.
                      className={cn(
                        touchTarget,
                        "justify-start",
                        "text-muted-foreground hover:text-foreground hover:bg-accent rounded border px-1.5 py-0.5 text-xs whitespace-nowrap aria-disabled:opacity-50",
                      )}
                    >
                      {ejecting.has(s.key)
                        ? t("breakdown.eject.sending", voice)
                        : t("action.backToInbox", voice)}
                    </button>
                    {/* #238 — held on the same fact as "Back to inbox" above
                        it, and by the same mechanism, because until now this
                        was the odd one out in its own control group: its
                        neighbour has waited for the plan since `!304` and this
                        one, one line away, took the press and had it undone by
                        the answer.

                        `aria-disabled`, never `disabled`, for the reason that
                        neighbour gives — the control has to stay focusable or
                        the reason below is unreachable, and a keyboard user
                        meeting a greyed ✕ with no explanation is #169's harm.
                        It is also the one control in this row that keeps the
                        reason for all five: the other four leave the tab order,
                        so this is where a keyboard user arrives to be told why
                        the row has gone quiet. The press is refused in the
                        handler, so nothing slips through. */}
                    <button
                      title="Remove this step"
                      aria-label="Remove this step"
                      aria-disabled={ejectHeldByPlan}
                      aria-describedby={
                        ejectHeldByPlan ? planHeldId : undefined
                      }
                      onClick={() => {
                        if (!ejectHeldByPlan) removeStep(i);
                      }}
                      // #205 / WCAG 2.5.8 — the worst of the pair at 86.3x16px:
                      // `px-1 text-xs` gave it no vertical padding at all, and it
                      // DELETES a step. Bare `touchTarget`, no `justify-start`: a
                      // centred glyph should stay centred in its 44px box.
                      className={cn(
                        touchTarget,
                        "text-muted-foreground hover:text-destructive rounded px-1 text-xs aria-disabled:opacity-50",
                      )}
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
          // #212 (!304 review) — held while a row is still on its way to the
          // inbox, or the same step is saved into the plan AND lands in the
          // inbox.
          //
          // `aria-disabled`, not `disabled`, and for a reason the three
          // conditions beside it do not have: this one has something to SAY.
          // A `disabled` button is out of the tab order, so a keyboard user
          // cannot land on it to be told why — and they are exactly the users
          // who did not see the row's own control change to "Sending…". They
          // would find a greyed control, no reason, and no way to ask for one.
          // Keeping it focusable keeps the reason below reachable, which is the
          // same call the row controls above make (WCAG 2.4.3); the press is
          // refused in `confirm` instead, so nothing can slip through.
          //
          // The `disabled` conditions are left as they are. They are not this
          // fix's to change, and none of them is a wait the user is meant to sit
          // through — this one clears in a single round trip.
          aria-disabled={ejectPending}
          // The refusal is not silent (#169): the reason rides
          // `aria-describedby` off this button, the mechanism the notice's Retry
          // already uses for its in-flight line, rather than a second live
          // region (#218).
          aria-describedby={ejectPending ? ejectHeldId : undefined}
          className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium aria-disabled:opacity-50 disabled:opacity-50"
        >
          {confirmPending ? "Saving…" : t("breakdown.looksRight", voice)}
        </button>
        {/* The two re-plan controls, held on the same fact and saying the same
            reason (!304 review). They do not write, but they replace the plan
            with an answer computed from a snapshot that still carries the
            ejecting row — see `request`'s gate. */}
        <button
          onClick={() =>
            request({ kind: "too_small" }, "Fewer, bigger steps ⬇️")
          }
          disabled={busy || !proposal}
          aria-disabled={ejectPending}
          aria-describedby={ejectPending ? ejectHeldId : undefined}
          className="hover:bg-accent rounded-md border px-3 py-1.5 text-sm aria-disabled:opacity-50 disabled:opacity-50"
        >
          {t("action.fewerSteps", voice)}
        </button>
        <button
          onClick={() => request({ kind: "too_big" }, "More, smaller steps ⬆️")}
          disabled={busy || !proposal}
          aria-disabled={ejectPending}
          aria-describedby={ejectPending ? ejectHeldId : undefined}
          className="hover:bg-accent rounded-md border px-3 py-1.5 text-sm aria-disabled:opacity-50 disabled:opacity-50"
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

      {/* #212 (!304 review) — why "Looks right", the two re-plan controls, the
          free-text Send and the error banner's "Try again" are not taking the
          press. Rendered as a sibling of the button row rather than inside it,
          so the wrapping flex row does not try to lay a sentence out as a
          control.

          ONE paragraph for all five. They are held by the same event and lift on
          it together, so five copies of one sentence would be five things to
          re-read rather than five explanations. The two furthest from it — the
          Send above the conversation and the "Try again" inside the error banner
          — reach it by `aria-describedby` like the rest, and carry their own
          local signal in the meantime by greying out the moment the hold starts.

          Deliberately NOT a live region. It appears as a consequence of a press
          the user just made on a row's own control, which already announces
          itself through that control's `aria-disabled`/`aria-busy` and its
          changed label — a third announcement for one press is noise, and a
          second live region beside the eject notice is #218's shape. It is
          `aria-describedby`'d off the held controls instead, which is where a
          user who tries the press will meet it. */}
      {ejectPending && (
        <p id={ejectHeldId} className="text-muted-foreground text-sm">
          {ejectHeldLine}
        </p>
      )}

      {/* #212 (!304 review) — the same explanation for the hold pointing the
          other way: why a row's "Back to inbox" and the notice's Retry are not
          taking the press while the plan is being saved or re-planned.

          Beside its sibling rather than next to the controls it describes, and
          for the same reason that one is: `aria-describedby` does not care
          where the node lives, the controls it serves are scattered across the
          list and the notice, and one paragraph for all of them beats a copy
          per row. Never both at once — the two holds each stop the other from
          starting — so this is not a second sentence competing with the first.

          Not a live region either, and this one has less claim to be than its
          sibling: it appears while something the user just started is visibly
          running, next to a "Saving…" label or a streaming reply. */}
      {ejectHeldByPlan && (
        <p id={planHeldId} className="text-muted-foreground text-sm">
          {t("breakdown.planHeld", voice)}
        </p>
      )}
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
