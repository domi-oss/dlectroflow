import { LlmProvider } from "@/lib/constants";

/**
 * Which adapter id this deploy's `LLM_PROVIDER` names.
 *
 * Extracted from `index.ts` for #177: the key-shape guard in
 * `src/app/actions/account.ts` needs the configured provider and nothing else,
 * and importing `@/lib/llm` for it would pull `@anthropic-ai/sdk` and `openai`
 * into a server action that never calls either. A second hand-rolled read of
 * `LLM_PROVIDER` was the other option, and two of those is how the value ends up
 * being parsed one way here and another way there.
 *
 * `index.ts` delegates to this, so there is still exactly one place that reads
 * the variable.
 *
 * @param warnOnUnknown log an unrecognised value. Off by default: the warning
 * belongs to the path that BUILDS a provider, which happens once per process,
 * not to a settings save that could repeat the line on every keystroke-save.
 */
export function configuredProvider(warnOnUnknown = false): LlmProvider {
  const provider = process.env.LLM_PROVIDER ?? LlmProvider.Anthropic;
  if (provider === LlmProvider.OpenAICompatible) {
    return LlmProvider.OpenAICompatible;
  }
  if (provider !== LlmProvider.Anthropic && warnOnUnknown) {
    // Unknown value → fall back to the safe default, but make it visible.
    console.error(
      `[llm] unknown LLM_PROVIDER="${provider}", defaulting to anthropic`,
    );
  }
  return LlmProvider.Anthropic;
}
