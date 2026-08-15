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
 * For every model holding personal data — see {@link coveredModels} for the
 * predicate — the export must READ it (`collect.ts`) and SERIALISE it (`json.ts`,
 * the only lossless tier). Text matching on the source, deliberately: running the
 * real `collectExport` would need a database and would prove only that the models
 * it already knows about come back.
 *
 * ── The predicate was WORKSPACE-ONLY, and that is how four records escaped ──
 *
 * Until this file was widened, the predicate was exactly `declares workspaceId`,
 * borrowed from `scoping.harness.test.ts` so the two guards would agree about what
 * "user content" means. Borrowing it was the defect. The scoping harness is asking
 * *"can this query reach another tenant's rows?"*, and workspace is the tenancy
 * root, so `workspaceId` is the right axis for that question. This file is asking
 * *"is the archive missing personal data?"*, and personal data also hangs off
 * `User` — so `Allowlist`, `UserAiUsage` and `CalendarFeed` were **structurally
 * invisible here**, and all three were duly absent from the export while
 * `/privacy` disclosed holding them. The guard reported full coverage the whole
 * time, which is the failure mode that matters: a green that means nothing was
 * looked at.
 *
 * It is worth being precise about what the old docblock got wrong, because it
 * *did* name `User` and `GoogleAuth` as account rows "handled explicitly" and then
 * concluded that widening the predicate "would demand entries for tables that must
 * not have one". Two errors in one sentence. The list was incomplete — written
 * before `CalendarFeed` (#154) existed and never revisited, so it never mentioned
 * `CalendarFeed`, `Allowlist` or `UserAiUsage` at all. And "must not have one" was
 * true of exactly one table, `GoogleAuth`, which is a credential store; the other
 * five it now catches either were already exported or should have been.
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
 *  3. **`Step` and `BreakdownTurn`.** Neither carries `workspaceId` nor a `User`
 *     relation: both are reached through the scoped `Task` read as an `include`,
 *     which is this codebase's existing idiom.
 *  4. **`GuestAiUsage` and `GuestDailyActivity`.** Both are keyed on a salted IP
 *     hash with no link to a workspace or an account, so there is no data subject
 *     for `collectExport` to return them to — it takes a workspace id and a user
 *     id, and neither reaches these rows. /privacy discloses them separately.
 *
 * ── Three registries, because the reasons are not interchangeable ───────────
 *
 * A model in the predicate that is not read directly by `collect.ts` needs an
 * entry in exactly one of:
 *
 *  - {@link DELIBERATELY_EXCLUDED} — held back because it carries nothing the
 *    archive does not already have. An exclusion argued in review, not a way to
 *    quiet the test.
 *  - {@link CREDENTIAL_TABLES} — held back because handing it over would HARM the
 *    reader. A different and much higher bar, kept separate so that "this is
 *    bookkeeping" can never be used to smuggle in "this is a secret", or the
 *    reverse.
 *  - {@link VIA_PINNED_MODULE} — exported, but read through a named module
 *    instead of by `collect.ts`, because `scoping.harness.test.ts` confines the
 *    whole `prisma.<model>` surface to one file.
 *
 * `json.test.ts` asserts the absence of everything in the first two registries
 * from the rendered archive as well, because an entry here says "we meant to
 * leave it out" and only that assertion says "it is actually out".
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

/**
 * Models withheld because handing them over would HARM the reader, keyed by model
 * name and valued by the reason.
 *
 * **Separate from {@link DELIBERATELY_EXCLUDED} on purpose, and the separation is
 * the point rather than tidiness.** That registry's bar is "the archive already
 * carries everything this row would add" — a claim about redundancy, arguable in
 * review, and cheap to get wrong in the reader's favour. This one's bar is "a copy
 * of this in a file the reader might forward to somebody is worse for them than
 * not having it", which is a claim about a credential. Collapsing the two would
 * let a future exclusion borrow the wrong justification in either direction: a
 * secret waved through as bookkeeping, or bookkeeping defended as if it were a
 * secret.
 *
 * The distinction has a live consequence in this very file. `CalendarFeed` is NOT
 * here — it is exported, because its timestamps are ordinary audit data — while
 * its `token` column is withheld under exactly this reasoning. So the credential
 * rule is applied at COLUMN grain there and at TABLE grain here, and only a
 * separate registry can say that without contradicting itself.
 */
const CREDENTIAL_TABLES: Record<string, string> = {
  googleAuth:
    "the Google OAuth access and refresh tokens. Third-party credentials: a leak " +
    "reaches past this database into the reader's Google account, which is what " +
    "distinguishes them from the calendar feed token that IS argued about at " +
    "column grain. `getGoogleStatus` gives the export three booleans and no way " +
    "to reach the columns at all, so `collect.ts` cannot export this row even by " +
    "accident. The archive's README says the connection is not included, because " +
    "a reader must not infer that restoring it reconnects their Google account. " +
    "json.test.ts asserts accessToken and refreshToken are absent from the " +
    "rendered output.",
};

/**
 * Models that ARE exported but are not read by `collect.ts`, because
 * `scoping.harness.test.ts` confines the entire `prisma.<model>` surface to one
 * module. Keyed by model, valued by that module.
 *
 * **This registry exists because the two guards gave contradictory orders.**
 * Widening the predicate above made this file demand `prisma.calendarFeed.` and
 * `prisma.userAiUsage.` in `collect.ts`, while the scoping harness's "only the
 * named module touches a user-keyed model" rule forbids those exact strings in any
 * file but `src/lib/calendar-feed.ts` and `src/lib/user-quota.ts`. Satisfying both
 * literally is impossible; picking one and suppressing the other would have thrown
 * away a real control.
 *
 * The harness is the one that wins on substance — it is a compensating control
 * against an IDOR on a credential row, and confining the blast radius to one file
 * per model is worth more than this file's convenience. So the export reads these
 * through the pinned module, which is not a workaround but the idiom `collect.ts`
 * ALREADY used for `GoogleAuth` via `getGoogleStatus` for exactly this reason. What
 * this registry adds is that the indirection stays checkable: the pinned module
 * must really exist, must really query the model, and `collect.ts` must really
 * import from it. A model listed here is still required to be in `types.ts` and in
 * `json.ts`, so the completeness property is unchanged — only the location of the
 * query moves.
 */
const VIA_PINNED_MODULE: Record<string, string> = {
  userAiUsage: "src/lib/user-quota.ts",
  calendarFeed: "src/lib/calendar-feed.ts",
};

/**
 * Models the export must account for, camelCased as the client exposes them.
 *
 * Two arms, because personal data in this schema hangs off two roots:
 *
 *  - **`workspaceId`** — workspace content. The axis `scoping.harness.test.ts`
 *    uses, and everything #199 originally covered.
 *  - **a relation field pointing at `User`, or `User` itself** — account-scoped
 *    data. This is the arm that was missing.
 *
 * The second arm is expressed as a RELATION rather than as a `userId` column, and
 * that distinction is load-bearing: `Allowlist` links to `User` through
 * `claimedById`, not `userId`, so a column-name predicate would have missed the
 * single most sensitive of the four records — the invitation note somebody else
 * wrote about the reader. `scoping.harness.test.ts`'s `userKeyedModels()` does key
 * on the column name, which is correct for its own question (a `userId` in a
 * `where` clause is what confines a query) and is why `Allowlist` is invisible to
 * that harness too.
 */
function coveredModels(): string[] {
  return Prisma.dmmf.datamodel.models
    .filter(
      (m) =>
        m.name === "User" ||
        m.fields.some(
          (f) =>
            f.name === "workspaceId" ||
            (f.kind === "object" && f.type === "User"),
        ),
    )
    .map((m) => m.name[0].toLowerCase() + m.name.slice(1))
    .sort();
}

const read = (file: string) => readFileSync(join(EXPORT_DIR, file), "utf8");

/**
 * `collect.ts`'s `User` read, narrowed to its own `select` block.
 *
 * The column check below used to search the WHOLE file for `<column>: true`, and
 * column names are NOT unique across that file's reads: `id`, `createdAt` and
 * `lastSeenAt` are also selected on `Workspace`, and `provider` on `Allowlist`.
 * So a column dropped from the User select was still reported as covered — by a
 * different model's string.
 *
 * Measured rather than theorised, on this branch: with `provider: true` deleted
 * from the User select and nothing else touched, **the whole suite passed** —
 * 341 files, 6817 tests — while `/privacy` went on publishing "Nothing else is
 * held back". `collect.integration.test.ts` did not cover it either; its
 * "every User column the schema has" case asserts a hand-written six, not the
 * `Prisma.dmmf` list, so it caught a dropped `lastSeenAt` and was blind to
 * `provider`.
 *
 * That is this file's own subject one level further down — a guard reporting
 * coverage it did not have — so the search is scoped to the block that actually
 * governs what the export selects. The risk is live, not hypothetical: `kind`,
 * `note`, `expiresAt`, `identity`, `invitedAt`, `claimedAt` and `isOwnerSeed`
 * are all already present in the file as `<name>: true` from the `Workspace` and
 * `Allowlist` selects, so a future `User` column called any of them would be
 * born invisible to the unscoped check.
 *
 * Brace-counted rather than pattern-matched: the block carries nested objects and
 * comments, and `regexp-source-hygiene` (#234) forbids assembling a `RegExp` from
 * anything but a file-level literal in any case.
 */
function userSelectBlock(collect: string): string {
  const userRead = collect.indexOf("prisma.user.findUnique(");
  if (userRead === -1) {
    throw new Error(
      "collect.ts no longer reads prisma.user, so this guard is pointing at nothing",
    );
  }
  const open = collect.indexOf("select: {", userRead);
  if (open === -1) {
    throw new Error(
      "collect.ts's User read no longer uses an explicit select; the column-grain check assumes one",
    );
  }
  let depth = 0;
  for (let i = collect.indexOf("{", open); i < collect.length; i += 1) {
    if (collect[i] === "{") depth += 1;
    else if (collect[i] === "}") {
      depth -= 1;
      if (depth === 0) return collect.slice(open, i + 1);
    }
  }
  throw new Error("collect.ts's User select block never closes");
}

/** Read directly by `collect.ts`, i.e. everything the guard expects to find a
 *  `prisma.<model>.` call for. */
const readsDirectly = (models: string[]) =>
  models.filter(
    (m) =>
      !(m in DELIBERATELY_EXCLUDED) &&
      !(m in CREDENTIAL_TABLES) &&
      !(m in VIA_PINNED_MODULE),
  );

/** Required to be in the archive, however it is read. */
const mustBeExported = (models: string[]) =>
  models.filter(
    (m) => !(m in DELIBERATELY_EXCLUDED) && !(m in CREDENTIAL_TABLES),
  );

describe("the data export covers every model holding personal data (#199)", () => {
  const models = coveredModels();

  // Guards the guard: an empty or one-element list here would make every
  // assertion below vacuously true, which is the "nothing found" failure mode
  // (a zero that means nothing was looked at).
  it("finds the covered models from the live schema", () => {
    expect(models.length).toBeGreaterThan(5);
    expect(models).toContain("brainDumpItem");
    expect(models).toContain("shoppingItem");
  });

  // The second arm, proved separately. Without this, reverting the predicate to
  // `workspaceId`-only would leave every assertion in the file passing — the
  // four records would simply stop being asked about, which is precisely the
  // state that shipped. One name per newly-caught root, and `allowlist` is the
  // one that only a relation-based predicate finds.
  it("the account-scoped arm catches the models that escaped the workspace one", () => {
    for (const model of [
      "user",
      "allowlist",
      "userAiUsage",
      "calendarFeed",
      "googleAuth",
      "workspace",
    ]) {
      expect(
        models,
        `${model} is not caught by the predicate, so nothing below asks about it`,
      ).toContain(model);
    }
    // And that the arm is genuinely additive rather than the whole list: the
    // workspace arm must still be doing its own work.
    expect(models).toContain("focusPlaylist");
  });

  it.each(readsDirectly(models))("collect.ts reads %s", (model) => {
    // `prisma.<model>.` rather than the bare name: the model name appears in
    // prose in that file's doc comment, and a substring match on the name alone
    // would report coverage that a comment provided.
    expect(read("collect.ts")).toContain(`prisma.${model}.`);
  });

  it.each(mustBeExported(models))(
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

  it("every credential table names a real model and states the harm", () => {
    // Same contract as the exclusions above, and the same reason for the
    // model-name check: an entry for a table that no longer exists is a stale
    // exemption that reads like considered coverage.
    for (const [model, reason] of Object.entries(CREDENTIAL_TABLES)) {
      expect(models, `${model} is not a covered model`).toContain(model);
      expect(reason.length).toBeGreaterThan(40);
      // The two registries must stay disjoint, or a table could be withheld
      // under whichever reason is easier to defend on the day.
      expect(
        DELIBERATELY_EXCLUDED[model],
        `${model} is in both registries; the reasons are not interchangeable`,
      ).toBeUndefined();
    }
  });

  it.each(Object.entries(VIA_PINNED_MODULE))(
    "%s is read through its pinned module, which really queries it",
    (model, modulePath) => {
      // Without this the registry would be a plain suppression: an entry would
      // excuse `collect.ts` from reading the model and nothing would check that
      // anybody else does. Three claims, each asserted rather than trusted.
      const src = readFileSync(join(process.cwd(), modulePath), "utf8");
      expect(
        src,
        `${modulePath} does not query ${model}, so nothing reads it for the export`,
      ).toContain(`prisma.${model}.`);

      // `collect.ts` must actually depend on that module, or the read could have
      // been dropped from the export while the module carried on serving other
      // callers — which is the original defect wearing a different hat.
      const collect = read("collect.ts");
      const specifier = modulePath.replace(/^src\//, "@/").replace(/\.ts$/, "");
      expect(collect, `collect.ts does not import from ${specifier}`).toContain(
        specifier,
      );

      // And the pinned module must be the one the scoping harness pins, not a
      // path invented here. If that registry moves, this fails rather than
      // silently describing a rule that no longer exists.
      const harness = readFileSync(
        join(process.cwd(), "src/lib/__tests__/scoping.harness.test.ts"),
        "utf8",
      );
      expect(
        harness,
        `${modulePath} is not in the harness's USER_KEYED_OWNERS, so the ` +
          `indirection this registry exists for is not actually required`,
      ).toContain(`"${modulePath}"`);
    },
  );

  // ── The column grain, which is the level the four records escaped at ───────
  //
  // Everything above counts MODELS. `User` passed the model-level check the whole
  // time — `collect.ts` has always read it — while four of its columns
  // (`providerSub`, `status`, `lastSeenAt`, `revokedAt`) were absent from the
  // select, plus `llmProvider` and `purgeAfter` found while fixing those. A guard
  // that counts tables cannot see a missing column, so it reported coverage it
  // did not have. Same defect one level down, so it gets a guard one level down.
  //
  // `User` only, deliberately, rather than every model: every other exported row
  // is spread wholesale into `export.json`, so a new column on `Task` appears in
  // the archive the day it appears in the schema and needs no guard. `User` is the
  // ONE model read through an explicit `select` — which is itself a security
  // decision worth keeping (`llmKeyEnc` is one careless spread away from a
  // reader's own API key) — and an explicit select is exactly what silently omits
  // a column. The narrowness is the point: this asserts the cost of that decision
  // is paid, not that spreads are audited.
  it("collect.ts selects every User column except the withheld credential", () => {
    const user = Prisma.dmmf.datamodel.models.find((m) => m.name === "User");
    if (!user) throw new Error("the User model is gone from the schema");

    // Scalars only: relation fields are not columns, and the rows they point at
    // are covered by the model-level assertions above.
    const columns = user.fields
      .filter((f) => f.kind === "scalar")
      .map((f) => f.name);
    // The control. A predicate returning nothing would make the check below
    // vacuous, and this file has already shipped one guard that passed by
    // looking at nothing.
    expect(columns.length).toBeGreaterThan(10);
    expect(columns).toContain("llmKeyEnc");

    // Plain substring search, NOT a regex assembled from `c`. Two rules in this
    // repo forbid the regex form — `regexp-source-hygiene` (#234), which requires
    // every `new RegExp` to build its pattern from a file-level literal, and
    // semgrep's `non-literal-regexp`, flagged on !175 — and the scoping harness
    // solves the identical problem the identical way. `provider: true` does not
    // match inside `providerSub: true`, because the character after the prefix
    // differs, so the two columns are still told apart.
    const collect = read("collect.ts");
    const userSelect = userSelectBlock(collect);
    // Controls on the narrowing itself. A slice that silently grabbed the whole
    // file would restore the collision this scoping exists to remove, and one
    // that grabbed nothing would red every column at once and read as a broken
    // guard rather than a passing one, so both directions are pinned.
    expect(userSelect.length).toBeLessThan(collect.length);
    expect(userSelect).toContain("providerSub: true");
    // `expiresAt` is selected on `Workspace` and is not a `User` column, so it
    // marks the boundary: finding it in here means the slice ran past the read it
    // is supposed to describe. The assertion above it keeps the marker honest if
    // the schema ever gives `User` a column by that name.
    expect(columns).not.toContain("expiresAt");
    expect(userSelect).not.toContain("expiresAt: true");

    const missing = columns.filter(
      (c) => c !== "llmKeyEnc" && !userSelect.includes(`${c}: true`),
    );
    expect(
      missing,
      `collect.ts does not select these User columns, so they are held and not ` +
        `exported. /privacy claims the only exclusions are credentials, so ` +
        `either export them or argue for them as a credential — do not just ` +
        `leave them out.`,
    ).toEqual([]);

    // The other direction, which matters just as much: the withheld column must
    // STAY withheld. Without this, satisfying the check above by selecting the
    // whole row would pass.
    expect(
      collect,
      "collect.ts selects llmKeyEnc — the encrypted per-user LLM key",
    ).not.toContain("llmKeyEnc: true");
  });

  // The mechanism, proved against a name that is NOT in the export, so an empty
  // `DELIBERATELY_EXCLUDED` cannot make this file a test that passes by looking
  // at nothing.
  it("would fail for a model the export does not read", () => {
    expect(read("collect.ts")).not.toContain("prisma.guestAiUsage.");
  });
});
