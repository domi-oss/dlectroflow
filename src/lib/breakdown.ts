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
  | { type: "done" }
  | { type: "error"; message: string };

/** Turn a feedback intent into a natural-language instruction for Claude. */
export function feedbackInstruction(fb: Feedback, proposal: Proposal | null): string {
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
  lines.push(`Feedback: ${feedbackInstruction(req.feedback, req.currentProposal)}`);
  return lines.join("\n");
}
