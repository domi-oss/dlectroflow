// Shared breakdown types + prompt helpers. No SDK imports, so this is safe to
// import from client components (types) and the server route (prompt builder).

import type { Voice } from "@/lib/strings";

export type ProposedStep = {
  text: string;
  estMinutes: number;
  subtaskEmoji: string;
};

export type Proposal = {
  parentEmoji: string;
  steps: ProposedStep[];
};

/** A fresh, empty step the user can fill in — used by the editor's "Add a step". */
export function blankStep(): ProposedStep {
  return { text: "", estMinutes: 10, subtaskEmoji: "•" };
}

/**
 * Move an array item from index `from` to index `to`, returning a NEW array.
 * Indices are clamped into range so a drag past either end lands at the edge
 * rather than dropping the item. Used by the editor's drag-to-reorder.
 */
export function reorder<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr];
  const lastFrom = Math.max(0, Math.min(from, next.length - 1));
  const lastTo = Math.max(0, Math.min(to, next.length - 1));
  if (lastFrom === lastTo) return next;
  const [moved] = next.splice(lastFrom, 1);
  next.splice(lastTo, 0, moved);
  return next;
}

/** Quick-reply intents + free text. */
export type Feedback =
  | { kind: "propose" }
  | { kind: "too_big" }
  | { kind: "too_small" }
  | { kind: "split_step"; index: number }
  | { kind: "free"; text: string };

export type BreakdownRequest = {
  title: string;
  currentProposal: Proposal | null;
  feedback: Feedback;
};

// NDJSON stream event shapes (server → client).
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "steps"; data: Proposal }
  | {
      type: "fallback";
      reason: "quota" | "global_cap" | "error";
      data: Proposal;
    }
  | { type: "done" }
  | { type: "error"; message: string };

/** Turn a feedback intent into a natural-language instruction for Claude. */
export function feedbackInstruction(
  fb: Feedback,
  proposal: Proposal | null,
): string {
  switch (fb.kind) {
    case "propose":
      return "Propose an initial breakdown.";
    case "too_big":
      return "These chunks feel too big. Split them into smaller, more concrete steps.";
    case "too_small":
      return "This is too granular / too many steps. Consolidate into fewer, slightly larger steps.";
    case "split_step": {
      const s = proposal?.steps[fb.index];
      return s
        ? `Break this one step down further into smaller sub-steps: "${s.text}". Keep the other steps as they are.`
        : "Break the highlighted step down further.";
    }
    case "free":
      return fb.text;
  }
}

/**
 * Deterministic local breakdown used when Claude is unavailable or a guest is
 * over their allowance. Generic scaffolding steps derived from the task title —
 * intentionally simple; the point is that the app still works without AI.
 */
export function localBreakdown(title: string): Proposal {
  const t = title.trim() || "this task";
  return {
    parentEmoji: "🗂️",
    steps: [
      {
        text: `Write down exactly what "done" looks like for: ${t}`,
        estMinutes: 5,
        subtaskEmoji: "🎯",
      },
      {
        text: "Gather anything you need to start (files, links, tools)",
        estMinutes: 10,
        subtaskEmoji: "🧰",
      },
      {
        text: "Do the smallest first piece for 10 minutes",
        estMinutes: 10,
        subtaskEmoji: "🌱",
      },
      {
        text: "Continue the main work in one focused block",
        estMinutes: 25,
        subtaskEmoji: "🚀",
      },
      {
        text: "Review, tidy up, and mark it complete",
        estMinutes: 10,
        subtaskEmoji: "✅",
      },
    ],
  };
}

// ── #14 — breakdown-coach context ───────────────────────────────────────────
// Two halves, deliberately kept apart:
//   • BREAKDOWN_APP_CONTEXT — STATIC app knowledge, spliced into the SYSTEM
//     prompt. Zero per-request values, so the SYSTEM string stays
//     byte-identical across every request and every workspace (a prerequisite
//     for prompt caching later; nothing is cached today — see #14's spec §5).
//   • buildContextBlock() — the LIVE, per-workspace state, appended to the
//     USER turn. Numbers and one enum only; never free text, never an
//     identifier, never a date. See the privacy note on BreakdownContext.

/**
 * Size cap for the static SYSTEM block. On a tool-less provider the
 * openai-compatible adapter appends `buildStructuredInstruction()` (the whole
 * propose_steps JSON Schema) AFTER our SYSTEM, so every character we add here
 * is a character of extra drift risk for a small local model.
 */
export const MAX_APP_CONTEXT_CHARS = 1_200;

/** Size cap for the dynamic, per-request context block (~150 tokens). */
export const MAX_CONTEXT_CHARS = 600;

export const BREAKDOWN_APP_CONTEXT = `About dlectroflow (the app these steps live in):
- An ADHD-friendly task helper: messy thoughts land in an inbox, then get triaged into a single to-do, broken into steps, or saved for later.
- The steps you propose are what they work from: each becomes a focus-timer block they can start, extend, or mark done.
- Your proposal is an editable starting point, never a verdict: they can reorder, reword, split, merge, delete and re-estimate it.
- Finishing steps earns points and advances a working-day streak, so a small step they will finish beats a tidy-looking big one.
- Confirmed steps can go to their calendar, so honest estimates beat optimistic ones.

Voice setting: the context block names their wording style. "plain" is literal and warm, no decorative emoji. "playful" is light and kitchen/snack-flavoured, still zero pressure. parentEmoji and subtaskEmoji are structured data the app renders, not decoration: always fill them, in both voices.

Using the context block: it is background, not material to talk about. You may acknowledge their momentum warmly at most once, in passing. Never recite the numbers back, never comment on how much is in their inbox, never imply they are behind.`;

/** Shape summary of one previously-kept breakdown: counts and minutes only. */
export type RecentBreakdownShape = {
  stepCount: number;
  minMinutes: number;
  medianMinutes: number;
  maxMinutes: number;
};

/**
 * Live, server-derived state handed to the coach. Every field is a small
 * integer, a boolean, or the `voice` enum — deliberately no free text, no ids,
 * no emails, no dates. Under BYO-LLM (#59) the destination can be a
 * third-party endpoint the owner configured, so this type IS the egress
 * contract: widening it widens what leaves the app.
 */
export type BreakdownContext = {
  voice?: Voice | null;
  streak?: { current: number; activeToday: boolean } | null;
  buckets?: {
    needsReview: number;
    singleTask: number;
    multiStep: number;
    savedLater: number;
  } | null;
  recentBreakdowns?: RecentBreakdownShape[];
};

const CONTEXT_HEADER =
  "--- App context (server-derived; not from the person's message) ---";
const CONTEXT_FOOTER = "--- end app context ---";

/** Clamp anything the DB hands us into a small, renderable non-negative int. */
function clampInt(n: unknown, max: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.min(max, Math.max(0, Math.trunc(n)));
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function momentumLine(ctx: BreakdownContext): string | null {
  const current = clampInt(ctx.streak?.current, 9_999);
  if (!ctx.streak || current < 1) return null;
  const active = ctx.streak.activeToday ? ", active today" : "";
  return `Momentum: ${current}-day working-day streak${active}`;
}

function boardLine(ctx: BreakdownContext): string | null {
  const b = ctx.buckets;
  if (!b) return null;
  const parts: string[] = [];
  const push = (n: number, one: string, many: string) => {
    const v = clampInt(n, 9_999);
    if (v > 0) parts.push(`${v} ${plural(v, one, many)}`);
  };
  push(b.needsReview, "to review", "to review");
  push(b.singleTask, "single to-do", "single to-dos");
  push(b.multiStep, "multi-step", "multi-step");
  push(b.savedLater, "saved for later", "saved for later");
  return parts.length ? `Their board: ${parts.join(", ")}` : null;
}

function shapeSummary(s: RecentBreakdownShape): string | null {
  const count = clampInt(s.stepCount, 999);
  if (count < 1) return null;
  // Re-sort the three minute figures so a malformed row can never render an
  // inverted range like "30–10 min".
  const [lo, mid, hi] = [s.minMinutes, s.medianMinutes, s.maxMinutes]
    .map((m) => clampInt(m, 9_999))
    .sort((a, b) => a - b);
  const steps = `${count} ${plural(count, "step", "steps")}`;
  return lo === hi
    ? `${steps} (${lo} min each)`
    : `${steps} (${lo}–${hi} min, ~${mid} median)`;
}

function historyLine(shapes: RecentBreakdownShape[]): string | null {
  const parts = shapes.map(shapeSummary).filter((s): s is string => s !== null);
  if (!parts.length) return null;
  const label =
    parts.length === 1
      ? "Their last kept breakdown"
      : `Their last ${parts.length} kept breakdowns`;
  return `${label}: ${parts.join("; ")}`;
}

/**
 * Render the live context block appended to the user turn.
 *
 * Returns `""` when nothing is known — a brand-new owner or a fresh guest
 * sandbox then gets a prompt byte-identical to the pre-#14 one.
 *
 * Bounded by `maxChars`. When it overflows, lines are shed in this documented
 * order (cheapest signal first): the history list loses entries one at a time,
 * then the board line, then momentum. The `Voice:` line is NEVER dropped — it
 * is the shortest line and the most user-visible if it goes missing, so the
 * block may exceed `maxChars` in the degenerate case where voice alone does
 * not fit.
 */
export function buildContextBlock(
  ctx: BreakdownContext,
  maxChars: number = MAX_CONTEXT_CHARS,
): string {
  // `voice` reads a plain String column with no CHECK constraint behind it, so
  // treat anything outside the known enum as unknown rather than passing it
  // through into the prompt as free text.
  const voice =
    ctx.voice === "plain" || ctx.voice === "playful"
      ? `Voice: ${ctx.voice}`
      : null;
  const momentum = momentumLine(ctx);
  const board = boardLine(ctx);
  const shapes = (ctx.recentBreakdowns ?? []).slice();

  const render = (
    keepShapes: number,
    keepBoard: boolean,
    keepMomentum: boolean,
  ): string => {
    const body = [
      voice,
      keepMomentum ? momentum : null,
      keepBoard ? board : null,
      historyLine(shapes.slice(0, keepShapes)),
    ].filter((l): l is string => l !== null);
    if (!body.length) return "";
    return [CONTEXT_HEADER, ...body, CONTEXT_FOOTER].join("\n");
  };

  // Drop ladder, most-droppable first.
  for (let keep = shapes.length; keep >= 0; keep--) {
    const out = render(keep, true, true);
    if (out.length <= maxChars) return out;
  }
  const noBoard = render(0, false, true);
  if (noBoard.length <= maxChars) return noBoard;
  return render(0, false, false);
}

/**
 * Build the user-turn prompt carrying task + current proposal + feedback, and
 * (since #14) the live app context.
 *
 * Slot order is deliberate: the context block sits AFTER the proposal and
 * BEFORE the feedback, so the person's own instruction stays the last thing
 * the model reads. With no context the output is byte-identical to the
 * pre-#14 prompt.
 */
export function buildUserPrompt(
  req: BreakdownRequest,
  ctx?: BreakdownContext | null,
): string {
  const lines: string[] = [`Task: ${req.title}`];
  if (req.currentProposal && req.currentProposal.steps.length > 0) {
    lines.push(
      `Current proposed steps (JSON): ${JSON.stringify(req.currentProposal)}`,
    );
  } else {
    lines.push("No steps proposed yet.");
  }
  const block = ctx ? buildContextBlock(ctx) : "";
  if (block) lines.push(block);
  lines.push(
    `Feedback: ${feedbackInstruction(req.feedback, req.currentProposal)}`,
  );
  return lines.join("\n");
}
