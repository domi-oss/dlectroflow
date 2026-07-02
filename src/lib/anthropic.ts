import Anthropic from "@anthropic-ai/sdk";

// Server-only Claude client. The key is read from the environment
// (ANTHROPIC_API_KEY) and never reaches the browser. Lazy so a missing key
// doesn't blow up `next build` — it only errors when a request actually runs.
let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Provide it in the environment (local dev: source it into your shell; CI/deploy: GitLab Secrets Manager).",
      );
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

// Verified current (see the claude-api reference): adaptive thinking only on
// Opus 4.8; budget_tokens would 400.
export const BREAKDOWN_MODEL = "claude-opus-4-8";
