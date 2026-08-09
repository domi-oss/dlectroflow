import type { ExportSnapshot, ExportTask } from "./types";

/**
 * #129 — `export.json`, the only round-trippable tier.
 *
 * It answers *"can I get it back in?"*. The three human tiers each drop something
 * on purpose (CSV cannot nest, Markdown cannot be parsed reliably, ICS is only
 * the scheduled subset); this one drops nothing, and carries the version number
 * that lets a future importer know what it is holding.
 *
 * ## Bump `EXPORT_SCHEMA_VERSION` when the SHAPE changes
 *
 * Not when a column is added. Rows are spread wholesale (see below), so a new
 * column appears in the output the day it appears in the schema, and a reader
 * that ignores unknown fields is unaffected. The version is for changes that
 * would make an old reader wrong: a renamed or removed field, a retyped value, a
 * moved nesting level.
 *
 * ## Rows are spread, not mapped field by field
 *
 * `{ ...task }` rather than a hand-written list of every column, deliberately: a
 * mapped list silently omits any column added later, so the file would quietly
 * stop being lossless and nothing would fail. The cost of the spread is that a
 * future SENSITIVE column would be swept in the same way, which is why
 * `json.test.ts` carries a tripwire asserting that no key matching
 * `enc|token|secret|password|credential` appears anywhere in the output. That is
 * the trade this repo already makes elsewhere (`src/lib/env-drift.ts`,
 * `src/lib/lockfile-hygiene.ts`): pin the claim with a test that fails when the
 * claim stops being true.
 *
 * The one thing the spread cannot do is fix a column whose TYPE is a lie —
 * `Step.estimateHistory` and `BreakdownTurn.proposedSteps` hold JSON inside a
 * `String`. Those are expanded, because handing over a JSON document with a JSON
 * document quoted inside it makes every consumer re-parse a field whose type
 * says it should not have to.
 *
 * `JSON.stringify` renders every `Date` through `Date.prototype.toJSON`, which is
 * `toISOString()` — ISO-8601 in UTC with an explicit `Z`, i.e. exactly what
 * `isoStamp` produces for the other tiers. Nullable timestamps stay `null`, which
 * is the right answer in JSON (unlike CSV, where empty is).
 */
export const EXPORT_SCHEMA_VERSION = 1;

/**
 * Parse a column that holds a JSON array as text.
 *
 * A malformed value returns `[]` and the raw text is preserved alongside it under
 * `<field>Raw`. Throwing would cost somebody their whole export because of one
 * bad cell, and silently dropping the text would lose data an export exists to
 * hand over.
 */
function expandJsonArray<T>(raw: string | null): { value: T[]; raw?: string } {
  if (raw == null) return { value: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return { value: parsed as T[] };
    return { value: [], raw };
  } catch {
    return { value: [], raw };
  }
}

function jsonTask(task: ExportTask) {
  return {
    ...task,
    steps: task.steps.map((step) => {
      const history = expandJsonArray<number>(step.estimateHistory);
      return {
        ...step,
        estimateHistory: history.value,
        ...(history.raw != null ? { estimateHistoryRaw: history.raw } : {}),
      };
    }),
    turns: task.turns.map((turn) => {
      if (turn.proposedSteps == null) {
        // Null stays null here, unlike estimateHistory's empty array: "the model
        // proposed nothing" and "this turn was not a proposal" are different
        // facts, and every `user` turn is the second one.
        return { ...turn, proposedSteps: null };
      }
      const proposed = expandJsonArray<unknown>(turn.proposedSteps);
      return {
        ...turn,
        proposedSteps: proposed.value,
        ...(proposed.raw != null ? { proposedStepsRaw: proposed.raw } : {}),
      };
    }),
  };
}

export function exportJson(snapshot: ExportSnapshot): string {
  const document = {
    // Version and provenance FIRST, so `head export.json` answers "what is this?"
    // without reading the whole file.
    app: "dlectroflow",
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: snapshot.exportedAt,
    workspace: snapshot.workspace,
    account: snapshot.account,
    /** Metadata only — the credential table is excluded entirely (README.md). */
    integrations: snapshot.integrations,
    settings: snapshot.settings,
    tasks: snapshot.tasks.map(jsonTask),
    inbox: snapshot.inbox,
    focusSessions: snapshot.focusSessions,
    focusPlaylists: snapshot.focusPlaylists,
    shoppingItems: snapshot.shoppingItems,
    gamification: snapshot.gamification,
  };
  // Two-space indent: a person will open this file too, and a single-line
  // document is not diffable, greppable or reviewable.
  return JSON.stringify(document, null, 2) + "\n";
}
