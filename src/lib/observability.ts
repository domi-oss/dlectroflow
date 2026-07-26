/**
 * Minimal in-process observability for LLM provider failures (#21 P4, #59).
 *
 * Before this, a provider outage silently degraded every breakdown to the
 * canned fallback — indistinguishable from normal operation in the logs.
 * `recordLLMFailure` gives each failure one structured, greppable log line
 * (`tag: "llm_failure"`, carrying which provider failed) and bumps a per-pod
 * counter surfaced on /api/livez, so both `kubectl logs` and the uptime probe
 * can see fallback mode. Counter is per-process by design — at this scale (2
 * replicas) that's enough signal; no external metrics stack to run.
 *
 * `recordAnthropicFailure`/`anthropicFailureCount`/`_resetAnthropicFailuresForTest`
 * are deprecated aliases kept for one release while callers migrate to the
 * provider-agnostic names (#59 generalized the LLM layer beyond
 * Anthropic-only).
 */

let failures = 0;

export function llmFailureCount(): number {
  return failures;
}

export function _resetLLMFailuresForTest(): void {
  failures = 0;
}

export function recordLLMFailure(
  provider: string,
  route: string,
  err: unknown,
): void {
  failures += 1;
  try {
    const e = err as { message?: unknown; status?: unknown } | undefined;
    console.error(
      JSON.stringify({
        tag: "llm_failure",
        provider,
        route,
        message: typeof e?.message === "string" ? e.message : String(err),
        // Provider SDKs (Anthropic, OpenAI-compatible) carry the HTTP status
        // on their APIError; absent for network errors.
        status: typeof e?.status === "number" ? e.status : undefined,
        count: failures,
        ts: new Date().toISOString(),
      }),
    );
  } catch {
    // Observability must never take the request down with it.
  }
}

/** @deprecated Use {@link llmFailureCount}. Kept for one release (#59). */
export const anthropicFailureCount = llmFailureCount;

/** @deprecated Use {@link _resetLLMFailuresForTest}. Kept for one release (#59). */
export const _resetAnthropicFailuresForTest = _resetLLMFailuresForTest;

/** @deprecated Use {@link recordLLMFailure}. Kept for one release (#59). */
export function recordAnthropicFailure(route: string, err: unknown): void {
  recordLLMFailure("anthropic", route, err);
}
