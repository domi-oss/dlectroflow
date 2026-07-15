/**
 * Minimal in-process observability for Anthropic API failures (#21 P4).
 *
 * Before this, an Anthropic outage silently degraded every breakdown to the
 * canned fallback — indistinguishable from normal operation in the logs.
 * `recordAnthropicFailure` gives each failure one structured, greppable log
 * line (`tag: "anthropic_failure"`) and bumps a per-pod counter surfaced on
 * /api/livez, so both `kubectl logs` and the uptime probe can see fallback
 * mode. Counter is per-process by design — at this scale (2 replicas) that's
 * enough signal; no external metrics stack to run.
 */

let failures = 0;

export function anthropicFailureCount(): number {
  return failures;
}

export function _resetAnthropicFailuresForTest(): void {
  failures = 0;
}

export function recordAnthropicFailure(route: string, err: unknown): void {
  failures += 1;
  try {
    const e = err as { message?: unknown; status?: unknown } | undefined;
    console.error(
      JSON.stringify({
        tag: "anthropic_failure",
        route,
        message: typeof e?.message === "string" ? e.message : String(err),
        // Anthropic SDK APIError carries the HTTP status; absent for network errors.
        status: typeof e?.status === "number" ? e.status : undefined,
        count: failures,
        ts: new Date().toISOString(),
      }),
    );
  } catch {
    // Observability must never take the request down with it.
  }
}
