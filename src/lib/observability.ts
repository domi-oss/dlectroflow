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

/**
 * One structured, greppable line per failed sign-in (#174).
 *
 * Diagnosing #174 took an ingress access log and a `referer` field, because the
 * app itself said nothing at all when a sign-in failed — every `fail()` branch
 * redirected to `/login?error=…` and logged nothing. `host` is the field that
 * would have answered it alone: a callback arriving on a hostname other than
 * `PUBLIC_ORIGIN`'s is the entire bug, and nothing was recording it.
 *
 * Deliberately **not** counted like {@link recordLLMFailure}. That counter is
 * surfaced on /api/livez and means "the LLM provider is down and every
 * breakdown is falling back". A wrong password or a stale state cookie is not
 * a health signal, and folding it in would make the probe lie.
 *
 * `warn`, not `error`: every branch here is a *handled* outcome the user is
 * told about, and printing handled outcomes at error level is what #158 is
 * about.
 */
export type AuthFailure = {
  /** Machine-readable branch name, e.g. `missing_oauth_params`. */
  reason: string;
  /** The `Host` the request actually arrived on, or null if absent. */
  host: string | null;
  hadState?: boolean;
  hadVerifier?: boolean;
  /**
   * The user chose this — they pressed Cancel on the provider's consent
   * screen. Emits `auth_declined` at `info` instead of `auth_failure` at
   * `warn`.
   *
   * Raised in review on !280: on a public instance, declining consent is a
   * normal and frequent action, and logging it identically to a genuine
   * expiry or state mismatch dilutes the signal this diagnostic was added to
   * surface. A grep for `auth_failure` has to mean "something went wrong",
   * or nobody will keep grepping for it.
   */
  declined?: boolean;
};

export function recordAuthFailure(failure: AuthFailure): void {
  try {
    const line = JSON.stringify({
      tag: failure.declined ? "auth_declined" : "auth_failure",
      reason: failure.reason,
      host: failure.host ?? null,
      hadState: failure.hadState,
      hadVerifier: failure.hadVerifier,
      ts: new Date().toISOString(),
    });
    // Still recorded, because "how many people bail at the consent screen" is
    // a real question — just not at a level that competes with faults.
    if (failure.declined) console.info(line);
    else console.warn(line);
  } catch {
    // Observability must never take the request down with it. Notably: the
    // caller controls these values, so an unserialisable one must not turn a
    // failed sign-in into a 500 on top of it.
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
