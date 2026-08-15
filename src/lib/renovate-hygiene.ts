/**
 * #243 — pure helpers for asserting three properties of `.gitlab/renovate.json`.
 * Kept free of `fs` so the parsing is unit-testable on synthetic config (the
 * manifest-hygiene, lockfile-hygiene and override-hygiene modules follow the same
 * split); the caller reads the file.
 *
 * The three come from the same issue and share one cause — a Renovate setting can
 * be wrong in a way that no tool in the chain reports, and `renovate-config-validator`
 * does not run in this repo's CI at all:
 *
 *   1. No concurrency limit or schedule under `vulnerabilityAlerts`, because
 *      Renovate ignores every one of them on that path. Reasoning below.
 *   2. A `schedule` window, written with a wildcard cron minute. Renovate runs on
 *      two pipeline schedules here and the window is the only thing that keeps the
 *      frequent one from opening update MRs of its own.
 *   3. A `logLevelRemap` entry promoting the automerge-arming failure to `warn`,
 *      because Renovate logs it at `debug` and swallows it.
 *
 * 2 and 3 are the fix for the lost automerge; their reasoning is in the second
 * half of this file, at the point where the constants are defined.
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
  /** `schedule` — Renovate accepts a string or an array of strings. */
  schedule?: unknown;
  /** `logLevelRemap` — an array of `{ matchMessage, newLogLevel }`. */
  logLevelRemap?: unknown;
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

/* ── #243, part two: the lost automerge ─────────────────────────────────────
 *
 * Five Renovate MRs opened on 2026-08-10 with `automerge: true` and none of them
 * armed it. The mechanism, read out of `renovate/renovate:43-full`'s own source
 * at the digest this repo pins (43.288.0):
 *
 *   - `tryPrAutomerge` is reached from exactly two places in the GitLab platform:
 *     `createPr`, and `reattemptPlatformAutomerge`. The branch worker calls the
 *     second one ONLY when that run pushed a new commit to the branch. So an
 *     existing, unchanged MR whose arming attempt failed is never re-armed.
 *   - Every failure inside it is logged at `debug` and swallowed — the loop
 *     catches, logs `Automerge on PR creation failed. Retrying <n>`, and moves on.
 *     The job runs at `info`, so five MRs that never armed produced no output.
 *   - What DOES recover it is Renovate's own automerge, the fallback the docs
 *     promise for when "native automerge is unavailable": on a later run with the
 *     branch unchanged the branch worker calls `checkAutoMerge`, which merges once
 *     the branch status is green. It is reachable out of `schedule` too, because
 *     an existing branch + PR falls through the schedule gate to "will update if
 *     necessary". Measured on `!316`'s head sha: GitLab reports the merge-request
 *     pipeline's jobs as commit statuses on the source sha, all green and none
 *     `allow_failure`, which is exactly what that check reads.
 *
 * So the recovery path already existed and was simply never given a second run —
 * the schedule was weekly. The two guards below hold up the fix for that: a
 * `schedule` window (so the extra runs cannot open MRs of their own) and a
 * `logLevelRemap` entry (so the next lost arming attempt is not silent).
 */

/**
 * The two messages Renovate's GitLab platform emits when it cannot arm platform
 * automerge — one per call site in `tryPrAutomerge`'s retry loop and its outer
 * catch. Both are checked, so a pattern that only covers the numbered form cannot
 * pass while leaving the final give-up line invisible.
 */
export const AUTOMERGE_FAILURE_LOG_MESSAGES = [
  "Automerge on PR creation failed. Retrying 1",
  "Automerge on PR creation failed",
] as const;

/**
 * The levels Renovate keeps as **repository problems**, and therefore the levels
 * that reach somebody without anybody opening a job log.
 *
 * Not a taste call: Renovate registers its problems stream at `level: 'warn'`,
 * and the Dependency Dashboard reprints whatever lands there under a
 * `## Repository Problems` heading on the dashboard issue. `info` would show up
 * in the job log and nowhere else, which is the same amount of attention `debug`
 * got — so `info` is deliberately not in this list.
 */
export const PROBLEM_LOG_LEVELS = ["warn", "error", "fatal"] as const;

/**
 * Renovate's `newLogLevel` enum, in ascending order of severity.
 *
 * Checked here rather than left to tooling because tooling does not check it.
 * Measured against `renovate-config-validator --no-global --strict` at 43.288.0:
 * a `newLogLevel` of `"loud"` **validates clean, exit 0**, while the same
 * validator rejects a typo'd option name and a cron minute that is not `*`. So
 * this is the same trap as the `vulnerabilityAlerts` limit above — an entry that
 * every tool in the chain calls valid and Renovate then ignores, leaving the
 * failure it was meant to surface exactly as silent as before.
 */
const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;

/**
 * Renovate's default `schedule`. Writing it out means the same as leaving
 * `schedule` off, so both have to read as "no window" or the guard would accept a
 * config that bounds nothing.
 */
const SCHEDULE_ANY_TIME = "at any time";

/**
 * The windows in which Renovate may create branches — `[]` when it may do so at
 * any time.
 *
 * `schedule` takes a string or an array of strings, and Renovate documents the
 * option as "define times of the day, week or month when you are willing to allow
 * Renovate to create branches". Anything that is neither string nor array of
 * strings is reported as no window rather than trusted: this reads a JSON file
 * nothing has shape-validated, and a `schedule` Renovate would reject is not a
 * bound either.
 */
export function branchCreationWindows(
  config: { schedule?: unknown } | undefined,
): string[] {
  const schedule = config?.schedule;
  const raw =
    typeof schedule === "string"
      ? [schedule]
      : Array.isArray(schedule)
        ? schedule
        : [];
  return raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && entry !== SCHEDULE_ANY_TIME);
}

/** Minute, hour and day-of-month: cron gives these no names, only numbers. */
const CRON_NUMERIC_FIELD = /^[*\d,\-/]+$/;

/**
 * Month and day-of-week, which additionally accept names — `JAN`, `MON`.
 *
 * Split from the numeric fields rather than loosening one pattern for all five
 * (Duo review). Letting letters into every position would make a five-word
 * Later-syntax phrase parse as cron, and there is a real one: "after 10pm and
 * before 5am" is exactly five whitespace-separated tokens. Keeping the minute
 * field numeric-only is what tells the two apart, and it is also just what cron
 * says — so the narrower rule is the more correct one, not merely the safer one.
 */
const CRON_NAMED_FIELD = /^[*\d,\-/A-Za-z]+$/;

/**
 * Which of `windows` are cron expressions whose minute field is not `*`.
 *
 * Renovate's `schedule` docs put this as a hard requirement — "you _must_ use the
 * `*` wildcard for the minutes value, as Renovate doesn't support minute
 * granularity" — and the plausible mistake is specific: the GitLab pipeline
 * schedule that runs Renovate is written `0 7 * * 1`, so pasting that string here
 * is the obvious thing to do and it is invalid. Nothing in this repo's CI runs
 * `renovate-config-validator`, so the next Monday's run would be the first thing
 * to notice.
 *
 * Named day and month fields count as cron, so `0 7 * * MON` is caught and not
 * quietly skipped. That was a real hole: the first version required every field to
 * be numeric, which meant a window written with a name — valid cron, and just as
 * invalid on its minute field — fell through the structural check and out of the
 * guard entirely, in the one helper whose whole job is to catch that class.
 *
 * Later-syntax phrases ("before 5:00am") are still left alone: they are deprecated
 * but accepted, and they have no minute field to be wrong about. Detecting cron
 * structurally rather than by exclusion keeps this from becoming a claim about
 * English.
 */
export function cronWindowsWithoutWildcardMinute(
  windows: readonly string[],
): string[] {
  return windows.filter((window) => {
    const fields = window.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
    const numericOk = [minute, hour, dayOfMonth].every((field) =>
      CRON_NUMERIC_FIELD.test(field),
    );
    const namedOk = [month, dayOfWeek].every((field) =>
      CRON_NAMED_FIELD.test(field),
    );
    if (!numericOk || !namedOk) return false;
    return minute !== "*";
  });
}

/** One `logLevelRemap` entry, as far as this module reads one. */
type LogLevelRemapEntry = {
  matchMessage?: unknown;
  newLogLevel?: unknown;
};

function remapEntries(remap: unknown): LogLevelRemapEntry[] {
  if (!Array.isArray(remap)) return [];
  return remap.map((entry) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as LogLevelRemapEntry)
      : {},
  );
}

/**
 * Renovate's own test for the regex form of a `matchMessage`, reproduced:
 * `getRegexOrGlobPredicate` treats a pattern as a regex when it starts with `/`
 * or `!/` and ends with `/` or `/i`, and falls back to minimatch otherwise.
 */
const REGEX_FORM_START = /^!?\//;
const REGEX_FORM_END = /\/i?$/;

function compileMatchMessage(
  matchMessage: unknown,
): { test: (message: string) => boolean } | null {
  if (typeof matchMessage !== "string") return null;
  if (
    !REGEX_FORM_START.test(matchMessage) ||
    !REGEX_FORM_END.test(matchMessage)
  )
    return null;
  const source = matchMessage
    .replace(REGEX_FORM_START, "")
    .replace(REGEX_FORM_END, "");
  // `!/…/` is a NEGATED match in Renovate. Getting this wrong would be the worst
  // kind of guard failure here — it would read an entry that excludes the
  // automerge message as one that promotes it, and report the fix as in place.
  const negated = matchMessage.startsWith("!");
  try {
    const regex = new RegExp(source, matchMessage.endsWith("i") ? "i" : "");
    return {
      test: (message: string) => {
        const matched = regex.test(message);
        return negated ? !matched : matched;
      },
    };
  } catch {
    // An uncompilable pattern is reported by `unevaluatableMatchMessages`, which
    // the colocated test asserts is empty — so this cannot silently swallow one.
    return null;
  }
}

/**
 * Every `matchMessage` in `remap` that this module cannot evaluate: not a string,
 * not in `/…/` form, or a regex that does not compile.
 *
 * **This is stricter than Renovate, on purpose.** Renovate also accepts a
 * minimatch glob, so an entry can be entirely valid to Renovate and still land in
 * this list. The point is that `remappedLogLevelFor` below is only trustworthy
 * for the forms it actually parses; without this list, a config written in globs
 * would make that function return `null` and the guard would report "the fix is
 * missing" when it was present, or — worse, in a future entry — miss that it had
 * stopped reading half the file.
 *
 * Reported as strings so a failure names the offending pattern; a missing
 * `matchMessage` reports as `""`.
 */
export function unevaluatableMatchMessages(remap: unknown): string[] {
  return remapEntries(remap)
    .filter((entry) => compileMatchMessage(entry.matchMessage) === null)
    .map((entry) =>
      entry.matchMessage === undefined ? "" : String(entry.matchMessage),
    );
}

/**
 * The level `message` would be logged at under `remap`, or `null` if no entry
 * applies.
 *
 * First match wins, because that is what Renovate's `getRemappedLevel` does — it
 * returns on the first matching entry rather than the most specific one. A helper
 * that reported the best match would pass a config Renovate reads differently.
 */
export function remappedLogLevelFor(
  message: string,
  remap: unknown,
): string | null {
  for (const entry of remapEntries(remap)) {
    const matcher = compileMatchMessage(entry.matchMessage);
    if (!matcher?.test(message)) continue;
    const level = entry.newLogLevel;
    if (typeof level !== "string") return null;
    return (LOG_LEVELS as readonly string[]).includes(level) ? level : null;
  }
  return null;
}
