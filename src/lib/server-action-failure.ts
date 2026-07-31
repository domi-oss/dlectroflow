/**
 * #137 — telling apart the ways a server action can fail, so the UI can offer
 * something that might actually work.
 *
 * Pure module, no React and no `next/*` import, so it is unit-testable in the
 * node environment and safe to pull into any client component.
 *
 * The production incident: the focus timer sat on "Claude is re-estimating…"
 * forever because `proposeNewEstimate` rejected and nothing caught it. What
 * rejected, from the pod log:
 *
 *     Error: Failed to find Server Action "40bef5efc6c8…".
 *     This request might be from an older or newer deployment.
 *
 * Next regenerates server-action ids on every build, so a tab left open across
 * a deploy posts an id the running deployment no longer has. That case is
 * worth separating from every other failure, because **"try again" can never
 * succeed against a stale bundle** — the retry posts the same dead id. Only a
 * reload can fix it, so only a reload should be offered.
 */

/**
 * Why not Next's own `unstable_isUnrecognizedActionError`?
 *
 * It exists (exported from `next/navigation` in 16.x) and it is the right idea,
 * but it is an `instanceof` check against a class in Next's client bundle. That
 * gives three problems here: it is client-only, so importing it would stop this
 * module being a plain node-testable helper; it is `unstable_`-prefixed, so it
 * is explicitly not a compatibility promise; and `instanceof` fails the moment
 * the error has crossed a boundary that dropped its prototype.
 *
 * So this asserts on the DURABLE signals Next itself sets, all three of which
 * survive minification and serialisation — and
 * `server-action-failure.test.ts` pins the first of them against the real
 * `UnrecognizedActionError` from the installed Next, so an upgrade that changes
 * the shape fails the suite instead of silently disabling the detection.
 */
const STALE_ACTION_NAME = "UnrecognizedActionError";

/**
 * Next's own error codes for this case. `E715` is thrown client-side by the
 * server-action reducer when the response carries `x-nextjs-action-not-found`;
 * `E975` is the server-side throw for the same condition on the non-fetch
 * (MPA form post) path.
 */
const STALE_ACTION_CODES = new Set(["E715", "E975"]);

/**
 * The wordings Next uses. Both are matched because the client and the server
 * phrase it differently, and a reverse proxy that strips the
 * `x-nextjs-action-not-found` header sends the client down the generic
 * invalid-response path, where the 404's `text/plain` body — "Server action not
 * found." — becomes the message.
 */
const STALE_ACTION_MESSAGES = [
  /failed to find server action/i,
  /server action\b.*\bwas not found/i,
  /^server action not found\.?$/i,
];

/** Cause chains are short in practice; this only has to refuse to loop. */
const MAX_CAUSE_DEPTH = 5;

/** Our own marker for "the action never answered at all". */
export class ActionTimeoutError extends Error {
  constructor(ms: number) {
    super(`Server action did not respond within ${ms}ms`);
    this.name = "ActionTimeoutError";
  }
}

function looksStale(error: object): boolean {
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    __NEXT_ERROR_CODE?: unknown;
  };
  if (candidate.name === STALE_ACTION_NAME) return true;
  if (
    typeof candidate.__NEXT_ERROR_CODE === "string" &&
    STALE_ACTION_CODES.has(candidate.__NEXT_ERROR_CODE)
  ) {
    return true;
  }
  const { message } = candidate;
  return (
    typeof message === "string" &&
    STALE_ACTION_MESSAGES.some((pattern) => pattern.test(message))
  );
}

/**
 * Did this failure happen because the browser is running an older (or newer)
 * deployment than the server?
 *
 * True means **do not offer a retry** — offer a reload. False means the action
 * itself failed and a retry is worth having, so a false positive costs the user
 * a reload they did not need. Everything unrecognised therefore answers false.
 */
export function isStaleActionError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== "object" || current === null) return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if (looksStale(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * `promise`, but rejecting with `ActionTimeoutError` if it has not settled
 * within `ms`.
 *
 * #137's third failure mode is silence rather than rejection — a pod rolling
 * mid-request, a connection that never closes — and from the user's side an
 * un-timed-out `await` is indistinguishable from the original hang. A server
 * action cannot be aborted from the client, so the request itself carries on;
 * this bounds how long the UI is willing to *wait* on it, which is the part the
 * user experiences. Any write it eventually performs is unaffected, which is
 * why the timeout is generous rather than tight.
 */
export function withActionTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ActionTimeoutError(ms)), ms);
  });
  // `race` attaches a handler to BOTH, so a losing promise that rejects later
  // does not surface as an unhandled rejection.
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}
