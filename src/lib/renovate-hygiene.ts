/**
 * #243 — a pure helper for asserting that `.gitlab/renovate.json` sets no
 * concurrency limit or schedule under `vulnerabilityAlerts`. Kept free of `fs` so
 * the parsing is unit-testable on synthetic config (the manifest-hygiene,
 * lockfile-hygiene and override-hygiene modules follow the same split); the
 * caller reads the file.
 *
 * WHY A LIMIT SET THERE IS NOT A CONTROL
 *   #243 read five stale Renovate MRs sitting at a saturated `prConcurrentLimit`
 *   and proposed `"vulnerabilityAlerts": { "prConcurrentLimit": 0 }` so a security
 *   fix could never queue behind routine digest bumps. It is a no-op. Renovate's
 *   docs say so twice — under `prConcurrentLimit`, "Renovate always creates
 *   security PRs, even if the concurrent PR limit is already reached", and under
 *   `vulnerabilityAlerts`, "it ignores settings like `branchConcurrentLimit`,
 *   `commitHourlyLimit`, `prConcurrentLimit`, `prHourlyLimit`, or `schedule` […]
 *   vulnerability alerts 'skip the line'." The implementation agrees: every limit
 *   gate is `&& !config.isVulnerabilityAlert`, and vulnerability upgrades sort
 *   ahead of everything else.
 *
 *   So the key would neither help nor harm — which is exactly why it is worth
 *   stopping. A setting that restates a guarantee reads like the thing holding the
 *   guarantee up, and the next person to raise the concurrency cap would keep it
 *   out of a fear of reopening something that was never open.
 *
 *   `renovate-config-validator` cannot catch this: it accepts the key (while
 *   rejecting a typo of it), so nothing else in the toolchain will tell you the
 *   key does nothing. Hence a test.
 *
 * The rest of the reasoning — why the block cannot fire on GitLab at all, and
 * what enabling `osvVulnerabilityAlerts` would cost — lives in #243's
 * description, and deliberately not here.
 */

/** The subset of `.gitlab/renovate.json` this helper reads. */
export type RenovateConfigShape = {
  vulnerabilityAlerts?: {
    description?: string;
    labels?: string[];
  } & Record<string, unknown>;
};

/**
 * The keys Renovate documents as ignored when it raises a vulnerability-fix PR,
 * quoted from the `vulnerabilityAlerts` note verbatim and in its order. Taken
 * from the docs rather than chosen here, so the list is not a judgement call that
 * drifts — if Renovate ever starts honouring one of these, the docs sentence
 * changes and so does this constant.
 */
export const IGNORED_FOR_VULNERABILITY_ALERTS = [
  "branchConcurrentLimit",
  "commitHourlyLimit",
  "prConcurrentLimit",
  "prHourlyLimit",
  "schedule",
] as const;

/**
 * Which of those keys a `vulnerabilityAlerts` block sets, in the documented
 * order. Empty is the healthy answer.
 *
 * Presence is what is reported, not value: `prConcurrentLimit: 0` genuinely does
 * mean "no limit", so the key is not *wrong* — it is simply never consulted on
 * this path, which makes `0` and `5` equally inert and equally misleading.
 * Reporting on presence is therefore the only reading that catches the mistake
 * #243 was about to make.
 */
export function ignoredKeysUnderVulnerabilityAlerts(
  block: Record<string, unknown> | undefined,
): string[] {
  // `in` throws a TypeError on a primitive ("Cannot use 'in' operator to search
  // for 'x' in a string"), and this reads a JSON file whose shape nothing has
  // validated at the point of the call. A non-object block sets no keys, so [] is
  // both safe and true. Arrays are excluded too: `0 in ["x"]` is real, but index
  // membership is not a Renovate option being set.
  if (block === null || typeof block !== "object" || Array.isArray(block))
    return [];
  return IGNORED_FOR_VULNERABILITY_ALERTS.filter((key) => key in block);
}
