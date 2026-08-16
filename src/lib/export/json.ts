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
 * **The four account records did NOT bump it, and the reasoning is worth keeping
 * because it is the obvious thing to query.** `accountRecords` is a new top-level
 * key and `account` gained six fields, but nothing was renamed, removed, retyped
 * or moved, so no reader that ignores unknown fields is made wrong — the rule
 * above applies to a new object exactly as it applies to a new column.
 *
 * The one genuine wrinkle, stated rather than glossed: a `schemaVersion: 1` file
 * written BEFORE that change has no `accountRecords` key at all, and one written
 * after has the key with possibly-null members, so a reader cannot tell "old
 * export, records unknown" from "new export, this account has none". That is a
 * real ambiguity and it is accepted rather than missed, for two reasons — there
 * is no importer yet (`readme.ts` says so in as many words), so nothing today
 * consumes the distinction; and bumping for an addition would contradict the
 * documented rule directly above, which is itself a decision. If an importer is
 * ever built, it should treat an absent `accountRecords` as unknown rather than
 * empty, and THAT is the moment this constant earns a bump.
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
    /**
     * The invitation (`note` included), the AI meter and the calendar feed's
     * timestamps. Next to `account` because that is what they are about, and
     * all three are `null` for a guest sandbox.
     *
     * The feed's `token` is NOT here and cannot be: `getOwnFeedTimestamps` never
     * selects the column, so the credential is absent by construction rather
     * than by this serialiser dropping a field.
     */
    accountRecords: snapshot.accountRecords,
    /** Metadata only — the credential table is excluded entirely (README.md). */
    integrations: snapshot.integrations,
    settings: snapshot.settings,
    tasks: snapshot.tasks.map(jsonTask),
    inbox: snapshot.inbox,
    focusSessions: snapshot.focusSessions,
    focusPlaylists: snapshot.focusPlaylists,
    shoppingItems: snapshot.shoppingItems,
    /**
     * #269 — the medication regimen and its dose history.
     *
     * ⚠️ **Nothing mechanical requires these two keys to be here.**
     * `__tests__/model-coverage.test.ts` reads `collect.ts` and `types.ts` and
     * has no `read("json.ts")` assertion at all, so a model can satisfy the guard
     * while being absent from the only lossless tier — which is precisely the
     * `FocusPlaylist` failure the guard was built for, one file further along.
     * `json.test.ts` carries the assertions instead; if that block is ever
     * deleted, this comment is the only thing left saying it mattered.
     *
     * `medsDoseLogs` holds `taken` and `skipped` rows and nothing else. **A
     * `missed` dose appears here as an ABSENCE**, because that is what it is: the
     * state is derived from a gap plus the clock (`src/lib/meds.ts`), and
     * materialising it into the archive would hand the reader a health record
     * they never created.
     */
    medications: snapshot.medications,
    medsDoseLogs: snapshot.medsDoseLogs,
    gamification: snapshot.gamification,
  };
  // Two-space indent: a person will open this file too, and a single-line
  // document is not diffable, greppable or reviewable.
  return JSON.stringify(document, null, 2) + "\n";
}
