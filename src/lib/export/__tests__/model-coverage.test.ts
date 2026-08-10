import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";

/**
 * #199 — the export's missing-model guard.
 *
 * `collectExport` (`../collect.ts`) names every table by hand, and until this
 * file existed **nothing failed when a model was left out of it**. That is not
 * hypothetical: `FocusPlaylist` (#185) reached `main` on 2026-08-07 absent from
 * all three export files, and every test in the suite stayed green. A user
 * exercising UK GDPR Art. 15/20 would have received an archive silently missing a
 * table, and the only way to notice was to remember.
 *
 * The scoping invariant has the same shape of obligation and solved it
 * structurally: `src/lib/__tests__/scoping.harness.test.ts` derives the list of
 * workspace-scoped models from `Prisma.dmmf` **at runtime**, so declaring
 * `workspaceId` enrols a new model with no registry entry to forget. This does
 * the same for the export.
 *
 * ── What it checks, precisely ───────────────────────────────────────────────
 *
 * For every model carrying a `workspaceId` column — the same predicate the
 * scoping harness uses, so the two guards cannot disagree about what "user
 * content" means — the export must READ it (`collect.ts`) and SERIALISE it
 * (`json.ts`, the only lossless tier). Text matching on the source, deliberately:
 * running the real `collectExport` would need a database and would prove only
 * that the models it already knows about come back.
 *
 * ── What it deliberately does NOT check ─────────────────────────────────────
 *
 *  1. **The CSV and Markdown tiers.** Those drop things on purpose (`README.md`
 *     says so) — CSV cannot nest, Markdown cannot be parsed reliably. Requiring
 *     every model in every tier would make the guard wrong rather than strict.
 *  2. **That the values are correct.** `collect.integration.test.ts` proves the
 *     rows come back and that one workspace's strings never appear in another's
 *     archive. This proves the table is not FORGOTTEN, which is the failure a
 *     value assertion cannot see because there is nothing to assert about.
 *  3. **Models with no `workspaceId`.** `Step` and `BreakdownTurn` are reached
 *     through the scoped `Task` read as an `include`, and `User`/`GoogleAuth` are
 *     account rather than workspace rows and are handled explicitly (the Google
 *     credential table is excluded ON PURPOSE and `README.md` says so). Widening
 *     the predicate would demand entries for tables that must not have one.
 *
 * ── The deliberate exclusion, named rather than left implicit ───────────────
 *
 * A scoped model that must stay OUT of the export belongs in
 * {@link DELIBERATELY_EXCLUDED} with the reason — an exclusion argued in review,
 * not a way to quiet the test. There is exactly one today (#199's summary row) and
 * `json.test.ts` asserts its absence from the rendered archive as well, because an
 * entry here says "we meant to leave it out" and only that assertion says "it is
 * actually out".
 */

const EXPORT_DIR = join(process.cwd(), "src/lib/export");

/**
 * Scoped models the export must NOT carry, keyed by model name and valued by the
 * reason. Same contract as `SESSION_ONLY_WRITERS` in
 * `revalidation-hygiene.test.ts` and `REVIEWED_DYNAMIC_HOSTS` in
 * `fetch-host-hygiene.test.ts`: an entry is a decision, not a suppression.
 */
const DELIBERATELY_EXCLUDED: Record<string, string> = {
  shoppingSummary:
    "#199 — app-generated bookkeeping for the inbox's shopping-list line, not " +
    "content the user typed. It holds one nullable timestamp saying whether the " +
    "line is currently dismissed, and NO count and no text (the count is derived " +
    "from ShoppingItem at render time), so there is nothing in it that the " +
    "exported ShoppingItem rows do not already carry — an importer can recreate " +
    "it from those rows alone. Excluding it is therefore not withholding personal " +
    "data, which is the only reason an exclusion could be wrong here; the actual " +
    "shopping list IS exported in full, ticked and saved-for-later rows included. " +
    "json.test.ts asserts the absence, so this entry cannot become a claim that " +
    "quietly stops being true.",
};

/** Prisma model names camelCased as the client exposes them — the same
 *  derivation `scoping.harness.test.ts` uses, so both guards agree on what
 *  counts as workspace content. */
function scopedModels(): string[] {
  return Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === "workspaceId"))
    .map((m) => m.name[0].toLowerCase() + m.name.slice(1))
    .sort();
}

const read = (file: string) => readFileSync(join(EXPORT_DIR, file), "utf8");

describe("the data export covers every workspace-scoped model (#199)", () => {
  const models = scopedModels();

  // Guards the guard: an empty or one-element list here would make every
  // assertion below vacuously true, which is the "nothing found" failure mode
  // (a zero that means nothing was looked at).
  it("finds the scoped models from the live schema", () => {
    expect(models.length).toBeGreaterThan(5);
    expect(models).toContain("brainDumpItem");
    expect(models).toContain("shoppingItem");
  });

  it.each(models.filter((m) => !(m in DELIBERATELY_EXCLUDED)))(
    "collect.ts reads %s",
    (model) => {
      // `prisma.<model>.` rather than the bare name: the model name appears in
      // prose in that file's doc comment, and a substring match on the name alone
      // would report coverage that a comment provided.
      expect(read("collect.ts")).toContain(`prisma.${model}.`);
    },
  );

  it.each(models.filter((m) => !(m in DELIBERATELY_EXCLUDED)))(
    "the ExportSnapshot type declares somewhere for %s to go",
    (model) => {
      // The snapshot's field names are not mechanically derivable from the model
      // names (`brainDumpItem` is carried as `inbox`, and the gamification models
      // are nested), so this asserts the model is MENTIONED in types.ts — which
      // is enough to fail when a model is added and the type is not touched at
      // all, and does not pretend to know what the field should be called.
      const declared = read("types.ts").toLowerCase();
      expect(declared).toContain(model.toLowerCase());
    },
  );

  it("every exclusion carries a reason", () => {
    for (const [model, reason] of Object.entries(DELIBERATELY_EXCLUDED)) {
      expect(models, `${model} is not a scoped model`).toContain(model);
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  // The mechanism, proved against a name that is NOT in the export, so an empty
  // `DELIBERATELY_EXCLUDED` cannot make this file a test that passes by looking
  // at nothing.
  it("would fail for a model the export does not read", () => {
    expect(read("collect.ts")).not.toContain("prisma.guestAiUsage.");
  });
});
