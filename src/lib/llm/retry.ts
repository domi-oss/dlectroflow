// Bounded retry for provider-agnostic LLM calls (#59 Task 8).
//
// Only wrap calls that are safe to replay: a `generate()` request and a
// stream's ESTABLISHMENT call. Never wrap stream iteration — once text has
// started flowing to the caller, a mid-stream failure can't be retried
// without re-sending output that's already gone out over the wire.

import type { LLMError } from "./types";

/**
 * Retries `fn` while it rejects with `{ retryable: true }` (rate limits,
 * 5xx, network blips — see `LLMError`), backing off exponentially
 * (~200ms, ~400ms, ...). A non-retryable error (auth, bad_request) throws
 * immediately: retrying those just adds latency to a failure that will
 * never succeed.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  tries = 2,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const e = err as Partial<LLMError> | undefined;
      if (!e?.retryable || attempt >= tries) throw err;
      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      attempt++;
    }
  }
}
