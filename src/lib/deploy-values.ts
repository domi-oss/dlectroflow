/**
 * Deploy-value hygiene (#61): a chart value that production never passes is a
 * feature that shipped switched off.
 *
 * `charts/dlectroflow/values.yaml` defaults `focus.catalogOrigin` to `""`, and
 * `templates/secret.yaml` omits the key entirely when it is empty — a good
 * default, because an unset store means the bundled ten tracks and a focus
 * session that is never silent. The cost of that design is that a MISSING flag
 * and a DELIBERATELY EMPTY one look identical from inside the cluster, so the
 * whole of #61 could merge, deploy green, and play the same ten tracks it always
 * had. It did: `!256` shipped the feature and `deploy_production` passed nothing,
 * so the code sat inert with every test passing and no log line to read.
 *
 * That is the class this guard exists for. Nothing else in the repo can see it:
 * `env-drift` compares `.env.example` against `process.env` reads, and the
 * `.env.prod.example`-vs-chart pair compares the two CONFIG SURFACES — both are
 * satisfied by a value that is declared everywhere and passed nowhere.
 *
 * What it cannot prove is the other half: whether the CI/CD variable behind the
 * flag actually holds anything. Protected variables are not readable from an MR
 * pipeline by design, so "the flag is present and points at a variable" is the
 * strongest statement available here. The remaining half is a deploy-time check
 * (`docs/deploy-runbook.md` §9b).
 *
 * Kept free of `fs` so the parsing is unit-testable on synthetic YAML, matching
 * `ci-job-deps`, `ci-docs-only` and `dockerfile-hygiene`; the caller reads the
 * file.
 */

import { jobBlock } from "./ci-job-deps";
import { stripShellComments } from "./source-text";

/** One `--set` / `--set-string` pair from a `helm upgrade` invocation. */
export interface HelmValue {
  /** The chart path, e.g. `focus.catalogOrigin` or `legacyHosts[0]`. */
  key: string;
  /** The literal right of `=`, with any wrapping double quotes removed. */
  value: string;
  /** `true` for `--set-string`, which suppresses helm's type coercion. */
  stringly: boolean;
}

/**
 * Chart values whose absence degrades production SILENTLY, listed explicitly.
 *
 * Explicit rather than discovered, for the same reason as `ci-job-deps`'
 * `TEARDOWN_JOBS`: most chart values fail loudly when they go missing — a pod
 * without `secrets.postgresPassword` crash-loops and the deploy rolls back — and
 * a guard that asserted on all of them would be an inventory of the helm command
 * rather than a statement about risk. Every entry here is one where the app
 * keeps serving, the pipeline stays green, and the only symptom is a feature
 * quietly not being there.
 *
 * Add an entry when a value's failure mode is a working app with the feature
 * off. Say which feature, so a future reader can tell whether removing the flag
 * is a regression or a decision.
 */
export const SILENTLY_DEGRADING_VALUES = [
  {
    key: "focus.catalogOrigin",
    /** Unset → the player falls back to the ten tracks in the image (#61). */
    feature: "the streamed lo-fi catalog",
  },
] as const;

/**
 * Every chart value a job's script passes to helm, in the order written.
 *
 * Returns `null` when the job is not in the file at all, which a caller should
 * treat as a failure rather than as "no values" — a renamed job must not read as
 * a job that configures nothing.
 *
 * Comments are stripped first, and that is load-bearing rather than tidiness: a
 * `# --set-string x=1` left behind by someone switching a flag OFF would
 * otherwise be read back as the flag being on, which is the precise inversion
 * this module exists to catch. `stripShellComments` is reused because the helm
 * invocation is a shell command inside YAML and both languages agree on where a
 * comment starts — at a `#` beginning a word, outside quotes — so a `#` inside a
 * quoted URL survives.
 */
export function parseHelmValues(
  gitlabCiYml: string,
  job: string,
): HelmValue[] | null {
  const body = jobBlock(gitlabCiYml, job);
  if (!body) return null;

  const script = stripShellComments(body.join("\n"));
  const values: HelmValue[] = [];

  // Three quoting shapes appear in the live file and all three mean the same
  // thing: `key=value`, `key="value"` and `"key=value"` — the last wrapping the
  // WHOLE pair in one set of quotes, which is how the `legacyHosts[0]=…` lines
  // are written and how the shell keeps the brackets off globbing. The value is
  // captured to the closing quote or the end of the token, so an `=` inside it
  // survives.
  const FLAG =
    /--set(-string)?\s+(?:"([^"=]+)=([^"]*)"|([^\s"=]+)=(?:"([^"]*)"|(\S+)))/g;

  for (const m of script.matchAll(FLAG)) {
    const [, stringly, quotedKey, quotedPairValue, bareKey, quotedValue, bare] =
      m;
    const key = quotedKey ?? bareKey;
    // `??` rather than `||`: an empty value is a real, deliberate setting
    // ("explicitly blank"), and `||` would fall through it to the next branch.
    const value = quotedPairValue ?? quotedValue ?? bare ?? "";
    values.push({ key, value, stringly: stringly !== undefined });
  }

  return values;
}

/**
 * The value a job passes for one chart path, or `null` if it passes none.
 *
 * The LAST occurrence wins, because that is what helm itself does with a
 * repeated `--set` — a guard that reported the first would disagree with the
 * cluster.
 */
export function helmValue(
  gitlabCiYml: string,
  job: string,
  key: string,
): string | null {
  const values = parseHelmValues(gitlabCiYml, job);
  if (!values) return null;
  const matches = values.filter((v) => v.key === key);
  return matches.length ? matches[matches.length - 1].value : null;
}
