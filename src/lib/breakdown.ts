// Shared breakdown types + prompt helpers. No SDK imports, so this is safe to
// import from client components (types) and the server route (prompt builder).

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

/** Build the user-turn prompt carrying task + current proposal + feedback. */
export function buildUserPrompt(req: BreakdownRequest): string {
  const lines: string[] = [`Task: ${req.title}`];
  if (req.currentProposal && req.currentProposal.steps.length > 0) {
    lines.push(
      `Current proposed steps (JSON): ${JSON.stringify(req.currentProposal)}`,
    );
  } else {
    lines.push("No steps proposed yet.");
  }
  lines.push(
    `Feedback: ${feedbackInstruction(req.feedback, req.currentProposal)}`,
  );
  return lines.join("\n");
}
