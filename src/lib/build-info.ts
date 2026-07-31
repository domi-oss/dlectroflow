/**
 * #135 — which commit the running container was assembled from.
 *
 * The project runs two instances: Instance A, the Helm chart on GKE, and
 * Instance B, the Docker Compose stack a self-hoster runs. Their configuration
 * surfaces had drifted and nothing could tell you whether they were even on the
 * same code, because a container cannot read the registry tag it was pulled
 * under. So the SHA is baked in at BUILD time by an `ARG BUILD_SHA` /
 * `ENV BUILD_SHA=$BUILD_SHA` pair in BOTH docker/Dockerfile and
 * docker/Dockerfile.ci (kept in lock-step by dockerfile-hygiene.test.ts), and
 * /api/health reports the short form.
 *
 * CI passes `--build-arg BUILD_SHA=$CI_COMMIT_SHA`; a self-hoster passes
 * `--build-arg BUILD_SHA=$(git rev-parse HEAD)` (docs/self-host-vps.md §2).
 *
 * BUILD_SHA is therefore NOT operator configuration: it is on neither of the
 * two config surfaces the parity check in env-drift.ts compares, and it is in
 * ENV_DRIFT_ALLOWLIST because `.env.example` must not invite anyone to set it.
 */

/**
 * Git's default short-SHA width. Both instances must shorten to the SAME width
 * or `curl a/api/health` and `curl b/api/health` can never be compared, which
 * is the only thing this module exists to make possible. Truncating here rather
 * than at each build site means one place decides.
 */
const SHORT_SHA_LENGTH = 7;

/**
 * A full or already-shortened lower-case hex SHA-1. Anything else is rejected
 * rather than passed through: /api/health is unauthenticated, so its body is
 * reflected to any caller and into whatever scrapes it. A build arg that is a
 * tag name, a shell fragment or markup is a mistake, and echoing it would turn
 * a broken pipeline into an injection surface in someone else's dashboard.
 *
 * The lower bound is SHORT_SHA_LENGTH — anything shorter cannot identify a
 * commit — and the upper bound is 40, the length of a SHA-1.
 *
 * **SHA-1 only, deliberately** (Duo review on !230). GitLab issues SHA-1 today,
 * so a 64-character SHA-256 hash would be rejected and /api/health would answer
 * `sha: null` with nothing saying why. Widening it pre-emptively is the wrong
 * trade: the bound is a validation boundary on a value that gets reflected to any
 * unauthenticated caller, and loosening it to admit a length nothing produces
 * weakens the check to buy nothing. If GitLab migrates, change the 40 to 64 —
 * and this comment is the diagnostic that makes a null answer legible.
 */
const SHA_RE = new RegExp(`^[0-9a-f]{${SHORT_SHA_LENGTH},40}$`);

/**
 * The short build SHA, or `null` when the image carries no usable one (built
 * without the build arg, or with a value that is not a SHA).
 *
 * `raw` defaults to `process.env.BUILD_SHA` and is read on every call, not
 * captured at module load: Next.js keeps route modules alive across requests,
 * and a load-time snapshot would also make this untestable.
 */
/**
 * Values already reported by {@link shortBuildSha}, so a rejected `BUILD_SHA` is
 * logged **once** rather than on every request.
 *
 * Duo review on !230 asked for a warning here and it was the right ask — a silent
 * `null` on the one endpoint whose job is answering "which build is this?" is
 * exactly the kind of quiet failure #147 is about. But the suggested patch warned
 * on every call, and `shortBuildSha` is read per request by /api/health, which a
 * cluster probes continuously: that turns one misconfiguration into an unbounded
 * log stream, and a log nobody can read is no more useful than no log at all.
 *
 * Keyed by value rather than a bare boolean so a test exercising several bad
 * inputs still sees one warning each. In production the set holds at most one
 * entry: `BUILD_SHA` is baked into the image by `ENV`, so it cannot change within
 * a process.
 */
const warnedShaValues = new Set<string>();

export function shortBuildSha(
  raw: string | undefined = process.env.BUILD_SHA,
): string | null {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (!SHA_RE.test(normalized)) {
    // An ABSENT build arg is a normal state (a local `next build`, a self-hoster
    // building their own image), so only a non-empty value that failed
    // validation is worth saying anything about.
    if (normalized.length > 0 && !warnedShaValues.has(normalized)) {
      warnedShaValues.add(normalized);
      // Length only, never the value: this reaches container logs, and a
      // BUILD_SHA that failed validation is by definition not something whose
      // contents we can vouch for.
      console.warn(
        `[build-info] BUILD_SHA is set but is not a valid short-or-full SHA-1 ` +
          `(${normalized.length} chars); /api/health will report sha: null`,
      );
    }
    return null;
  }
  return normalized.slice(0, SHORT_SHA_LENGTH);
}
