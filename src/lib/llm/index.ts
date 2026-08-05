import type { LLMCredentials, LLMProvider } from "./types";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAICompatibleProvider } from "./openai-compatible";
import { configuredProvider } from "./configured-provider";
import { LlmProvider } from "@/lib/constants";

let cached: LLMProvider | undefined;

/**
 * The adapter ids `LLM_PROVIDER` (and a user's `llmProvider`) may name.
 *
 * #118 Phase C — derived from the constant rather than restated, because
 * `User.llmProvider` is now constrained in the database against the same set
 * (`User_llmProvider_check`, mirroring `LlmProvider` in constants.ts). Two
 * hand-maintained lists of the same adapter ids is how the column ends up
 * accepting a value no adapter can serve.
 */
const PROVIDER_IDS = [
  LlmProvider.Anthropic,
  LlmProvider.OpenAICompatible,
] as const;

type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * The deploy's own provider, with the "unknown value" warning it always had.
 *
 * #177 moved the body to `./configured-provider`, which imports nothing but the
 * constants: the key-shape guard in `saveOwnLlmKey` needs this answer and would
 * otherwise drag both vendor SDKs into a server action that calls neither. The
 * read still happens in exactly one place.
 */
const instanceProvider = (warnOnUnknown: boolean): ProviderId =>
  configuredProvider(warnOnUnknown);

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
