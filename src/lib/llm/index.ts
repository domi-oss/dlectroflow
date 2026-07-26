import type { LLMProvider } from "./types";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAICompatibleProvider } from "./openai-compatible";

let cached: LLMProvider | undefined;

export function getLLM(): LLMProvider {
  if (cached) return cached;
  const provider = process.env.LLM_PROVIDER ?? "anthropic";
  if (provider === "openai-compatible") {
    cached = createOpenAICompatibleProvider();
    return cached;
  }
  if (provider !== "anthropic") {
    // Unknown value → fall back to the safe default, but make it visible.
    console.error(
      `[llm] unknown LLM_PROVIDER="${provider}", defaulting to anthropic`,
    );
  }
  cached = createAnthropicProvider();
  return cached;
}

export function _resetLLMForTest(): void {
  cached = undefined;
}

export type { LLMProvider } from "./types";
