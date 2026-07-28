import type { LLMCredentials, LLMProvider } from "./types";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAICompatibleProvider } from "./openai-compatible";

let cached: LLMProvider | undefined;

/** The adapter ids `LLM_PROVIDER` (and a user's `llmProvider`) may name. */
const PROVIDER_IDS = ["anthropic", "openai-compatible"] as const;

type ProviderId = (typeof PROVIDER_IDS)[number];

/** The deploy's own provider, with the "unknown value" warning it always had. */
function instanceProvider(warnOnUnknown: boolean): ProviderId {
  const provider = process.env.LLM_PROVIDER ?? "anthropic";
  if (provider === "openai-compatible") return "openai-compatible";
  if (provider !== "anthropic" && warnOnUnknown) {
    // Unknown value → fall back to the safe default, but make it visible.
    console.error(
      `[llm] unknown LLM_PROVIDER="${provider}", defaulting to anthropic`,
    );
  }
  return "anthropic";
}

function build(provider: ProviderId, creds?: LLMCredentials): LLMProvider {
  return provider === "openai-compatible"
    ? createOpenAICompatibleProvider(creds)
    : createAnthropicProvider(creds);
}

/**
 * The LLM provider for this request.
 *
 * With no arguments this is the instance's own provider, memoized exactly as
 * before.
 *
 * With `creds` (#35 Phase B — an account that brought its own key) it returns a
 * FRESH provider bound to that key and deliberately does NOT touch the cache:
 * memoizing a credentialed provider would leak one account's key into the next
 * request served by the same pod, which is the whole ball game. The caller's
 * `provider` selects the adapter when it names a known one; anything else —
 * including `null`, the "use the instance default" value — falls back to
 * `LLM_PROVIDER` rather than guessing.
 */
export function getLLM(creds?: LLMCredentials): LLMProvider {
  if (creds) {
    const named = PROVIDER_IDS.find((id) => id === creds.provider);
    return build(named ?? instanceProvider(false), creds);
  }
  if (cached) return cached;
  cached = build(instanceProvider(true));
  return cached;
}

export function _resetLLMForTest(): void {
  cached = undefined;
}

export type { LLMCredentials, LLMProvider } from "./types";
