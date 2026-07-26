import type { LLMProvider } from "./types";
import { createAnthropicProvider } from "./anthropic";

let cached: LLMProvider | undefined;

export function getLLM(): LLMProvider {
  if (cached) return cached;
  const provider = process.env.LLM_PROVIDER ?? "anthropic";
  // Task 6 adds the "openai-compatible" branch here.
  cached = createAnthropicProvider();
  if (provider !== "anthropic" && provider !== "openai-compatible") {
    // Unknown value → fall back to the safe default, but make it visible.
    console.error(`[llm] unknown LLM_PROVIDER="${provider}", defaulting to anthropic`);
  }
  return cached;
}

export function _resetLLMForTest(): void {
  cached = undefined;
}

export type { LLMProvider } from "./types";
