/**
 * #157 — pure helpers for asserting that the repo's statements about production
 * log retention still agree with each other.
 *
 * ── What these can and cannot see ────────────────────────────────────────────
 * They cannot see whether logs are actually being kept. Nothing in CI can: the
 * deploy authenticates to the cluster through the GitLab Kubernetes agent, and
 * there is no Google Cloud credential anywhere in `.gitlab-ci.yml` — no
 * `gcloud`, no `cloud-sdk` image, no `GOOGLE_APPLICATION_CREDENTIALS`. Proving
 * retention needs the provider API, so it lives in
 * `scripts/check-log-retention.sh`, which an operator runs and the weekly digest
 * calls; where it cannot look it reports **undetermined**, never clean.
 *
 * What CI *can* enforce, with no credential at all, is the property whose
 * absence caused the incident: **two surfaces stating the same fact must state
 * the same fact.** The runbook tells an operator to set a retention window; the
 * check asserts one. If those drift apart the check reports "not retained"
 * forever and the instinct is to relax it, which is precisely how a guard stops
 * guarding while still reading as coverage.
 *
 * Kept free of `fs` so the parsing is unit-testable on synthetic input — the
 * split `manifest-hygiene`, `lockfile-hygiene`, `backup-hygiene` and
 * `override-hygiene` all use; `log-retention.test.ts` reads the real files.
 *
 * Both helpers are string scans rather than regexes built from their arguments.
 * A `new RegExp(name)` here would be the "Regular expression with non-literal
 * value" SAST finding !254 removed from `override-hygiene`, and this repo now
 * treats that rule one way everywhere.
 */
import { stripShellComments } from "./source-text";

const EXPORT_PREFIX = "export ";

/**
 * The default in a shell `NAME="${NAME:-value}"` binding, or `null`.
 *
 * `null` for anything that is not that exact shape — `NAME="$NAME"`, a binding
 * that only exists inside a comment, a name that is not bound at all. Returning
 * `null` rather than guessing is what stops the consistency test passing
 * vacuously when someone renames the variable: an absent default fails the
 * "declares a default retention window" assertion loudly instead of comparing
 * two things that are both missing.
 */
export function shellDefault(source: string, name: string): string | null {
  const marker = "${" + name + ":-";
  for (const raw of stripShellComments(source).split("\n")) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    let lhs = line.slice(0, eq).trim();
    if (lhs.startsWith(EXPORT_PREFIX)) {
      lhs = lhs.slice(EXPORT_PREFIX.length).trim();
    }
    if (lhs !== name) continue;

    let rhs = line.slice(eq + 1).trim();
    // One layer of matching quotes, if present. Both spellings occur in this
    // repo's scripts and neither changes what the default is.
    const first = rhs.charAt(0);
    if (
      rhs.length >= 2 &&
      (first === '"' || first === "'") &&
      rhs.endsWith(first)
    ) {
      rhs = rhs.slice(1, -1);
    }
    if (!rhs.startsWith(marker) || !rhs.endsWith("}")) continue;
    return rhs.slice(marker.length, -1);
  }
  return null;
}

/**
 * Every `--retention-days` value in a block of text, in order, for both
 * spellings `gcloud` accepts (`=30` and ` 30`).
 *
 * Used against the runbook, where the number appears in a command an operator
 * will paste. A literal regex: the pattern is fixed, so there is no non-literal
 * `RegExp` to flag, and the quantifiers are sequential rather than nested.
 */
const RETENTION_DAYS_FLAG = /--retention-days[= ](\d+)/g;

export function retentionDaysFlags(source: string): number[] {
  return [...source.matchAll(RETENTION_DAYS_FLAG)].map((m) => Number(m[1]));
}
