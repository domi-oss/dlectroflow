import { LlmProvider } from "@/lib/constants";

/**
 * #177 step 1 — is this key unmistakably somebody ELSE's?
 *
 * A member being onboarded on 2026-08-05 pasted the wrong provider's key into
 * Settings. It saved, it decrypted, it went to Anthropic, and Anthropic
 * answered `401 invalid x-api-key`. `/api/breakdown` fails soft by design, so
 * the app served its canned fallback and Settings went on reporting the key as
 * present — presence is not validity. The only record was a pod log line.
 *
 * THE CHECK IS ASYMMETRIC, AND THAT IS THE ENTIRE DESIGN. It answers "does this
 * unmistakably match a DIFFERENT known provider's format", never "does this
 * conform to the configured provider's format".
 *
 *   fail-open on unknown, fail-closed on known-foreign.
 *
 * The conformance version is the tempting one and it is a trap. Providers
 * change key formats; a "must start `sk-ant-`" rule turns a valid new-format
 * key into a key that cannot be stored at all, and unlike the silent 401 this
 * issue is fixing, that failure has no workaround — the user cannot bring their
 * key by any route. So an unrecognised shape is ACCEPTED, and step 2 of #177
 * (one authenticated probe at save time) is what closes the remaining gap.
 * `key-shape.test.ts` pins the accepts as hard as the rejects for that reason.
 *
 * Pure and I/O-free on purpose, the same split every `*-hygiene.ts` module
 * uses: the table is unit-testable on synthetic input with no database and no
 * provider. It reads no env — the caller resolves the configured provider and
 * passes it in.
 *
 * NOTHING DERIVED FROM THE KEY IS RETURNED. The result is rendered in the
 * account panel, and `src/app/actions/account.ts` is deliberately built so no
 * part of a key reaches a client component or an RSC payload. Every string
 * below is a fixed label from this file; the key only ever decides WHICH one.
 */

/** A confident identification of the provider a pasted key belongs to. */
export type ForeignProviderKey = {
  /** Display name of the provider whose format the key matches. */
  looksLike: string;
  /** Display name of the provider the key would have been used with. */
  expectedProvider: string;
  /** That provider's issued prefix, or `null` when it has no fixed one. */
  expectedPrefix: string | null;
};

type Shape = { looksLike: string; prefixes: readonly string[] };

/**
 * How each configured provider describes ITSELF in a rejection message.
 *
 * `openai-compatible` has a null prefix and says so rather than inventing one:
 * it covers self-hosted models and third-party gateways whose tokens are
 * arbitrary strings, so there is no prefix that would be true.
 */
const NATIVE: Record<LlmProvider, { label: string; prefix: string | null }> = {
  [LlmProvider.Anthropic]: { label: "Anthropic", prefix: "sk-ant-" },
  [LlmProvider.OpenAICompatible]: { label: "OpenAI-compatible", prefix: null },
};

/**
 * The prefixes that identify a key as belonging to someone else, PER CONFIGURED
 * PROVIDER. The two lists are wildly different lengths, and that asymmetry is
 * the point rather than an omission.
 *
 * Entry bar: the prefix must be one the configured provider could never itself
 * issue. A bare `sk-` fails that bar twice over — it is the legacy OpenAI shape,
 * but it is also what a future Anthropic key or a self-hosted token may look
 * like — so it is deliberately absent. Matching is case-sensitive: API keys are,
 * so a case-folded match could only ever fire on a key that is already broken.
 */
const FOREIGN: Record<LlmProvider, readonly Shape[]> = {
  // An Anthropic deploy talks to exactly one endpoint, so a key carrying
  // another vendor's issued prefix cannot work, and saying so beats a 401 the
  // user never sees.
  [LlmProvider.Anthropic]: [
    // The three qualified OpenAI prefixes only. Plain `sk-` is ambiguous with
    // `sk-ant-` itself and with every format not yet invented.
    { looksLike: "OpenAI", prefixes: ["sk-proj-", "sk-svcacct-", "sk-admin-"] },
    { looksLike: "OpenRouter", prefixes: ["sk-or-v1-"] },
    { looksLike: "Google AI", prefixes: ["AIza"] },
    { looksLike: "Groq", prefixes: ["gsk_"] },
    { looksLike: "xAI", prefixes: ["xai-"] },
    { looksLike: "Hugging Face", prefixes: ["hf_"] },
  ],
  // ONE entry, and it is not an oversight. `openai-compatible` points at
  // whatever base URL the owner configured, and OpenRouter, Groq, Google AI,
  // Hugging Face and xAI all expose OpenAI-compatible endpoints — their keys
  // are NATIVE here. Listing them would reject working configurations, which is
  // the failure mode this module exists to avoid.
  [LlmProvider.OpenAICompatible]: [
    { looksLike: "Anthropic", prefixes: ["sk-ant-"] },
  ],
};

/**
 * The provider `key` unmistakably belongs to when that is NOT `provider`, or
 * `null` — which means "nothing can be asserted", not "this key is valid".
 *
 * Trims internally as well as at the call site: `saveOwnLlmKey` already trims a
 * pasted key, but a prefix check that one leading space defeats would depend on
 * call order for its correctness.
 */
export function detectForeignProviderKey(
  key: string,
  provider: LlmProvider,
): ForeignProviderKey | null {
  const candidate = key.trim();
  if (!candidate) return null;

  const shape = FOREIGN[provider].find((entry) =>
    entry.prefixes.some((prefix) => candidate.startsWith(prefix)),
  );
  if (!shape) return null;

  const native = NATIVE[provider];
  return {
    looksLike: shape.looksLike,
    expectedProvider: native.label,
    expectedPrefix: native.prefix,
  };
}
