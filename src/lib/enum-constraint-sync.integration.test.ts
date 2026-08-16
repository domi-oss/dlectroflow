import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  BrainDumpStatus,
  TaskStatus,
  TaskSource,
  TurnRole,
  FocusOutcome,
  RewardType,
  EngagementKind,
  SparkSource,
  BadgeKey,
  WorkspaceKind,
  FocusTimerStyle,
  FocusSound,
  FocusSoundCategory,
  CompleteTickColor,
  Typeface,
  UserRole,
  UserStatus,
  AiPolicy,
  LlmProvider,
  MedsDoseState,
  MedsNavMode,
} from "@/lib/constants";
// #106 — the scheduling vocabulary lives in its own client-safe module (both the
// server actions and the Schedule menu import it), so these two value sets are
// authoritative from there rather than from constants.ts.
import { SchedulePriority, ScheduleHours } from "@/lib/scheduling/types";
// #44 — the note bound is a product decision, not a SQL literal to re-type
// here. Importing it is what makes task-notes.ts authoritative: raising the
// constant without a matching migration fails the assertion below.
import { TASK_NOTE_MAX_LENGTH } from "@/lib/task-notes";
import { FOCUS_PLAYLIST_NAME_MAX_LENGTH } from "@/lib/focus-playlists";
import { SHOPPING_ITEM_TEXT_MAX_LENGTH } from "@/lib/shopping";

// #38 — keep the DB CHECK constraints (see the
// 20260719171754_add_status_check_constraints migration) in lockstep with the
// pseudo-enum value sets in src/lib/constants.ts.
//
// constants.ts is the single source of truth. This test reads the CHECK
// constraints actually applied to the live test DB (populated by
// `prisma migrate deploy` before the suite runs) and asserts, for every
// managed column, that the constrained value set is EXACTLY the constant's
// value set. It fails if a constant gains/loses a value without a matching
// constraint migration, or if a managed constraint is dropped/added out of
// band. It's an *.integration.test.ts — it needs the real Postgres (CI wires
// one up; locally it uses your DATABASE_URL schema).
//
// #78 — the same registry idea, extended to the schema's one NUMERIC-range
// CHECK constraint (RANGE_REGISTRY, below the enum one). A range bound has no
// constants.ts value set to mirror, so that block asserts the constraint is
// applied and pins the bound its migration declares; the behavioural half —
// that a raw sub-1 insert is actually rejected — lives in
// src/lib/step-est-minutes-check.integration.test.ts.

// Dedicated client so $disconnect() here can't tear the connection out from
// under sibling integration tests.
const prisma = new PrismaClient();

// The bijection between a CHECK constraint and the const object whose values it
// must mirror — constants.ts for most of them, scheduling/types.ts for the two
// #106 scheduling columns. Deriving `values` from the imported constant object
// (not a re-typed literal list) is what makes that module authoritative: adding
// `BrainDumpStatus.Foo` there immediately changes the expected set here.
const REGISTRY: ReadonlyArray<{
  constraint: string;
  table: string;
  column: string;
  values: Readonly<Record<string, string>>;
  nullable: boolean;
}> = [
  {
    constraint: "Workspace_kind_check",
    table: "Workspace",
    column: "kind",
    values: WorkspaceKind,
    nullable: false,
  },
  {
    constraint: "BrainDumpItem_status_check",
    table: "BrainDumpItem",
    column: "status",
    values: BrainDumpStatus,
    nullable: false,
  },
  {
    constraint: "Task_status_check",
    table: "Task",
    column: "status",
    values: TaskStatus,
    nullable: false,
  },
  {
    constraint: "Task_source_check",
    table: "Task",
    column: "source",
    values: TaskSource,
    nullable: false,
  },
  {
    constraint: "BreakdownTurn_role_check",
    table: "BreakdownTurn",
    column: "role",
    values: TurnRole,
    nullable: false,
  },
  {
    constraint: "FocusSession_outcome_check",
    table: "FocusSession",
    column: "outcome",
    values: FocusOutcome,
    nullable: true,
  },
  {
    constraint: "RewardEvent_type_check",
    table: "RewardEvent",
    column: "type",
    values: RewardType,
    nullable: false,
  },
  // #233 — the per-day engagement ledger. A SEPARATE value set from
  // `RewardType` above, and the two are deliberately not derived from each
  // other: `capture` earns a streak day and no points so it has no reward type,
  // while `inbox_zero`, `scheduled` and `session_finished` are rewards that
  // never advance the streak. `EngagementKind`'s docblock in constants.ts has
  // the argument; this entry is what makes it enforceable.
  {
    constraint: "EngagementDay_kind_check",
    table: "EngagementDay",
    column: "kind",
    values: EngagementKind,
    nullable: false,
  },
  {
    constraint: "DailySpark_source_check",
    table: "DailySpark",
    column: "source",
    values: SparkSource,
    nullable: false,
  },
  {
    constraint: "Badge_key_check",
    table: "Badge",
    column: "key",
    values: BadgeKey,
    nullable: false,
  },
  {
    constraint: "Settings_focusTimerStyle_check",
    table: "Settings",
    column: "focusTimerStyle",
    values: FocusTimerStyle,
    nullable: true,
  },
  {
    constraint: "Settings_focusSound_check",
    table: "Settings",
    column: "focusSound",
    values: FocusSound,
    nullable: false,
  },
  {
    constraint: "Settings_completeTickColor_check",
    table: "Settings",
    column: "completeTickColor",
    values: CompleteTickColor,
    nullable: false,
  },
  {
    constraint: "Settings_typeface_check",
    table: "Settings",
    column: "typeface",
    values: Typeface,
    nullable: false,
  },
  // #35 Phase A — accounts identity.
  {
    constraint: "User_role_check",
    table: "User",
    column: "role",
    values: UserRole,
    nullable: false,
  },
  {
    constraint: "User_status_check",
    table: "User",
    column: "status",
    values: UserStatus,
    nullable: false,
  },
  {
    constraint: "User_aiPolicy_check",
    table: "User",
    column: "aiPolicy",
    values: AiPolicy,
    nullable: false,
  },
  // #106 — the Schedule menu's persisted intent. Nullable: a task nobody has
  // scheduled through the menu has no intent, and that "nobody has said yet" is
  // load-bearing (it is what makes defaultIntentFor supply the fallback).
  {
    constraint: "Task_schedulePriority_check",
    table: "Task",
    column: "schedulePriority",
    values: SchedulePriority,
    nullable: true,
  },
  {
    constraint: "Task_scheduleHours_check",
    table: "Task",
    column: "scheduleHours",
    values: ScheduleHours,
    nullable: true,
  },
  {
    // #118 Phase C — the column feeds getLLM()'s adapter choice for an account
    // paying with its own key. NULL = the instance default.
    constraint: "User_llmProvider_check",
    table: "User",
    column: "llmProvider",
    values: LlmProvider,
    nullable: true,
  },
  // #186 — the SAME two pseudo-enums, one grain earlier. `BrainDumpItem` got
  // its own copy of the Schedule menu's intent so an UNTRIAGED item can carry a
  // deadline: an item with no `Task` row had nowhere to persist one, which is
  // why the full menu was only ever reachable from a multi-step task.
  //
  // Listed as two more rows rather than derived from the `Task` pair above, for
  // the reason LENGTH_REGISTRY states for `Step_notes_check`: a registry that
  // generated both grains from one entry would report an agreement it had never
  // checked. Same `values` import, though — the vocabulary is one vocabulary,
  // and mirroring it is the whole point.
  {
    constraint: "BrainDumpItem_schedulePriority_check",
    table: "BrainDumpItem",
    column: "schedulePriority",
    values: SchedulePriority,
    nullable: true,
  },
  {
    constraint: "BrainDumpItem_scheduleHours_check",
    table: "BrainDumpItem",
    column: "scheduleHours",
    values: ScheduleHours,
    nullable: true,
  },
  // #269 — the medication tracker's two pseudo-enums, and they are here for two
  // DIFFERENT reasons rather than one applied twice.
  //
  // `state` has NO SAFE READING for an out-of-set value: the today-strip would
  // have to decide whether an unknown string means a dose was taken, and both
  // answers are wrong about a health record. That is what puts it with the
  // constrained columns rather than with `Settings.voice`, which is the schema's
  // one CHECK-less pseudo-enum precisely because an unrecognised voice degrades
  // harmlessly to plainer copy.
  //
  // `medsNavMode` DOES have a safe reading — fall back to the default mode — so
  // the argument above does not reach it and citing it for both would be a
  // contradiction. It is here on the plain dominant-convention ground: its two
  // nearest analogues, `Settings_typeface_check` and
  // `Settings_focusTimerStyle_check`, both have safe readings and both carry a
  // constraint anyway.
  //
  // ⚠️ These two entries are a REVIEW obligation. The "no missing, no strays"
  // assertion below intersects the live constraint list with this registry's own
  // names before comparing, so a constraint applied and never registered is
  // filtered out and the suite stays green — nothing mechanical would have
  // noticed their absence. The behavioural half is in the identity-rejection
  // block at the foot of this file.
  {
    constraint: "MedsDoseLog_state_check",
    table: "MedsDoseLog",
    column: "state",
    values: MedsDoseState,
    nullable: false,
  },
  {
    constraint: "Settings_medsNavMode_check",
    table: "Settings",
    column: "medsNavMode",
    values: MedsNavMode,
    nullable: false,
  },
];

// #180 — the schema's CHECK constraints over ARRAY columns.
//
// `Settings.focusSoundCategories` holds zero or more category slugs (empty = the
// whole catalogue), so the guard has to be CONTAINMENT — `col <@ ARRAY[…]` —
// rather than the `= ANY` equality the scalar REGISTRY above mirrors. Every
// element must be one of the ten, and holding none must stay legal.
//
// It can reuse `literalsFromDef` because Postgres renders the containment form
// as `CHECK ((col <@ ARRAY['a'::text, 'b'::text]))` — the same single-quoted
// literals, in the same place. What it CANNOT reuse is the nullability field:
// there is no `IS NULL` allowance to look for, and one appearing would be a bug
// rather than a style choice, because `NULL <@ ARRAY[…]` evaluates to NULL and a
// CHECK passes on NULL. A nullable column would therefore accept a NULL that no
// constraint had actually validated, which is why the column is NOT NULL and why
// that is asserted here rather than assumed.
const ARRAY_REGISTRY: ReadonlyArray<{
  constraint: string;
  table: string;
  column: string;
  values: Readonly<Record<string, string>>;
}> = [
  {
    // 20260806100000_settings_focus_sound_categories — replaces the single
    // nullable `focusSoundCategory` (#70) with a multi-select. Behavioural half
    // in src/lib/settings-focus-sound-categories-check.integration.test.ts.
    constraint: "Settings_focusSoundCategories_check",
    table: "Settings",
    column: "focusSoundCategories",
    values: FocusSoundCategory,
  },
];

// #78 — numeric-range CHECK constraints. Unlike the pseudo-enum columns above
// there is no constants.ts object to mirror (the bound is a number, not a
// value set), so the source of truth is the constraint's own migration and
// this table pins it: `min` is the inclusive lower bound the SQL must declare.
// Keeping it here rather than in its own file means one place still answers
// "which CHECK constraints does this schema manage?".
//
// `nullable` mirrors the field of the same name in the enum REGISTRY above: on a
// nullable column the SQL must carry an `IS NULL OR ...` allowance, and on a NOT
// NULL column it must not. Getting that backwards is a real failure mode in both
// directions — a missing allowance makes every estimate-less row unwritable, and
// a stray one on a NOT NULL column means the column went nullable without this
// registry noticing — so it is asserted rather than assumed.
const RANGE_REGISTRY: ReadonlyArray<{
  constraint: string;
  table: string;
  column: string;
  min: number;
  nullable: boolean;
}> = [
  {
    // 20260727194512_step_est_minutes_check — every Step must be at least one
    // whole minute long. Four application writers clamp to this already; the
    // constraint is what stops a fifth from skipping it.
    constraint: "Step_estMinutes_check",
    table: "Step",
    column: "estMinutes",
    min: 1,
    nullable: false,
  },
  {
    // 20260728130000_user_ai_quota_check (#35 Phase B) — the per-user AI
    // allowance became owner-editable, so it is bounded in the DB as well as in
    // updatePersonAiPolicy. Zero is allowed ("no instance-funded AI");
    // negative is not, because it reads as an allowance and behaves as a block.
    constraint: "User_aiQuota_check",
    table: "User",
    column: "aiQuota",
    min: 0,
    nullable: false,
  },
  {
    // 20260731120000_braindump_item_est_minutes_check (#80) — the same >= 1
    // floor as Step.estMinutes, but on a NULLABLE column where null means "no
    // estimate given, use the display default". Hence `IS NULL OR >= 1`: the
    // asymmetry with Step_estMinutes_check is the decision #80 recorded, not an
    // oversight. Behavioural half in
    // src/lib/braindump-item-est-minutes-check.integration.test.ts.
    constraint: "BrainDumpItem_estMinutes_check",
    table: "BrainDumpItem",
    column: "estMinutes",
    min: 1,
    nullable: true,
  },
];

// #44 — text-LENGTH CHECK constraints. A third shape, kept in its own registry
// rather than bolted onto RANGE_REGISTRY: that one asserts a `>= min` on a
// numeric column, and an upper bound measured by a FUNCTION (`char_length`)
// does not fit its assertions at all. The reason it stays in this file is the
// same one the range registry gives — one place still answers "which CHECK
// constraints does this schema manage?".
//
// `max` is the inclusive upper bound the SQL must declare, and `fn` is the
// measuring function it must use. Pinning the function is not pedantry:
// `octet_length` and `char_length` differ by 4x on astral characters, so
// silently swapping one for the other would reject an all-emoji note a quarter
// the length of a Latin one the constraint accepts.
const LENGTH_REGISTRY: ReadonlyArray<{
  constraint: string;
  table: string;
  column: string;
  max: number;
  fn: string;
  nullable: boolean;
}> = [
  {
    // 20260805120000_task_and_step_notes (#44) — the user's freeform note.
    // Bounded because it is threaded into the Google Task `notes` field, which
    // the Tasks API rejects over 8192 characters; the note is one part of that
    // envelope, so it cannot be allowed to fill it alone. Behavioural half in
    // src/lib/notes-length-check.integration.test.ts.
    constraint: "Task_notes_check",
    table: "Task",
    column: "notes",
    max: TASK_NOTE_MAX_LENGTH,
    fn: "char_length",
    nullable: true,
  },
  {
    // The per-step twin, same migration and same bound. Listed separately
    // rather than derived from the entry above so that the two CAN diverge
    // visibly if a future migration changes one — a registry that generated
    // both from one row would report agreement it had not checked.
    constraint: "Step_notes_check",
    table: "Step",
    column: "notes",
    max: TASK_NOTE_MAX_LENGTH,
    fn: "char_length",
    nullable: true,
  },
  {
    // 20260807120000_braindump_item_notes_and_schedule (#186 / #179) — the
    // third grain, and the earliest one: an UNTRIAGED item can now hold a note,
    // either typed into the inbox row or split off a capture's trailing `{…}`
    // group (#179). Same bound and same measuring function as the two above,
    // because the note is COPIED into `Task.notes` when the item is triaged
    // (`brainDumpItemToTaskData`), so a wider bound here would be a value the
    // narrower column then refuses on a routine action.
    // Behavioural half in src/lib/notes-length-check.integration.test.ts.
    constraint: "BrainDumpItem_notes_check",
    table: "BrainDumpItem",
    column: "notes",
    max: TASK_NOTE_MAX_LENGTH,
    fn: "char_length",
    nullable: true,
  },
  {
    // 20260807140000_focus_playlists (#185) — a user-chosen playlist name.
    //
    // ADDED IN REVIEW, and it is the reason this registry earns its keep. The
    // migration's own comment asserted the constraint was "registered in
    // LENGTH_REGISTRY" while `FocusPlaylist` appeared nowhere in this file — so
    // the comment described a safety net that did not exist, and the sentence
    // asserting it was the only thing standing in for the net. `!282` review.
    //
    // `char_length`, never `octet_length`: the two disagree by up to 4x on
    // astral characters, so a byte bound would reject an all-emoji name a
    // quarter the length of a Latin one it accepts. Same argument as the notes
    // bounds above (#44).
    //
    // `nullable: false` — `FocusPlaylist.name` is NOT NULL, so the constraint
    // must carry no `IS NULL` allowance. The lower bound (a name cannot be
    // whitespace-only) is a separate clause in the same CHECK and is proved
    // behaviourally in src/lib/focus-playlist-name-check.integration.test.ts,
    // because this registry pins upper bounds and measuring functions only.
    constraint: "FocusPlaylist_name_check",
    table: "FocusPlaylist",
    column: "name",
    max: FOCUS_PLAYLIST_NAME_MAX_LENGTH,
    fn: "char_length",
    nullable: false,
  },
  {
    // 20260808120000_shopping_items (#199) — a shopping-list entry.
    //
    // `char_length`, never `octet_length`, for the reason the two entries above
    // give: a byte bound would reject an all-emoji entry a quarter the length of
    // a Latin one it accepts.
    //
    // `nullable: false` — `ShoppingItem.text` is NOT NULL, so the constraint must
    // carry no `IS NULL` allowance. The lower bound (an entry cannot be
    // whitespace-only) is a separate clause in the same CHECK and is proved
    // behaviourally in src/lib/shopping-item-text-check.integration.test.ts,
    // because this registry pins upper bounds and measuring functions only.
    constraint: "ShoppingItem_text_check",
    table: "ShoppingItem",
    column: "text",
    max: SHOPPING_ITEM_TEXT_MAX_LENGTH,
    fn: "char_length",
    nullable: false,
  },
];

// The schema the client is connected to (Prisma's `?schema=` param, default
// "public"). We scope the pg_constraint query to it explicitly rather than
// relying on current_schema() / search_path ordering.
function connectedSchema(): string {
  const url = process.env.DATABASE_URL ?? "";
  const m = /[?&]schema=([^&]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : "public";
}

// Extract every single-quoted string literal from a pg_get_constraintdef()
// output. Postgres normalises `col IN ('a','b')` to
// `col = ANY (ARRAY['a'::text, 'b'::text])`, so parse the literals rather than
// the surrounding syntax. `IS NULL` (nullable columns) contributes no literal.
function literalsFromDef(def: string): Set<string> {
  const out = new Set<string>();
  for (const [, lit] of def.matchAll(/'((?:[^']|'')*)'/g)) {
    out.add(lit.replace(/''/g, "'"));
  }
  return out;
}

/**
 * A constraint definition, flattened for substring matching.
 *
 * Postgres re-renders `CHECK (char_length("notes") <= 2000)` as
 * `CHECK (((notes IS NULL) OR (char_length(notes) <= 2000)))` — it adds parens,
 * and it quotes an identifier only when the identifier needs it, which differs
 * between `"estMinutes"` and `notes`. Stripping the identifier quotes and
 * collapsing whitespace makes the comparison one stable string.
 *
 * Substring matching rather than a regex assembled from the registry row, and
 * that is deliberate. Such a regex is harder to read than the string it is
 * looking for, and building one from variables is a pattern SAST flags as a
 * class — correctly, even where the inputs are local constants as they are
 * here. Written out, the comparison is just the SQL. Only double quotes are
 * removed; single-quoted VALUE literals are what `literalsFromDef` reads.
 */
function flatDef(def: string): string {
  return def.replace(/"/g, "").replace(/\s+/g, " ");
}

/**
 * Every function NAME called in a constraint definition, lowercased.
 *
 * Needed because substring matching cannot answer "does this measure with
 * `length`?" — `length(` is a substring of `char_length(`, so a plain
 * `includes` reports the wrong function in every definition that uses the right
 * one. The regex this replaced carried a word boundary that was doing that work
 * invisibly; losing it turned two passing assertions red, which is how it was
 * caught.
 *
 * The regex here is a fixed LITERAL — nothing is interpolated into it — so it
 * carries none of the non-literal-construction risk that motivated the rewrite.
 */
function calledFunctions(def: string): Set<string> {
  return new Set(
    [...flatDef(def).matchAll(/([a-z_][a-z0-9_]*)\s*\(/gi)].map((m) =>
      m[1].toLowerCase(),
    ),
  );
}

type CheckRow = { conname: string; def: string; convalidated: boolean };
let checks: Map<string, string>;
/**
 * Which constraints Postgres has actually VALIDATED against existing rows.
 *
 * ⚠️ **This file could not previously tell.** It read `pg_get_constraintdef`,
 * which renders a `NOT VALID` constraint identically to a validated one — so a
 * constraint added `NOT VALID` and never validated passed every assertion here
 * while **not biting on a single existing row**. That is precisely the failure
 * class this repo keeps meeting: a guard reading green on something it never
 * examined.
 *
 * It became reachable when `20260816120000_meds_tracker` adopted the
 * `NOT VALID` → `VALIDATE CONSTRAINT` pair to avoid an ACCESS EXCLUSIVE lock on
 * a populated `Settings`. That form is only safe if forgetting the second
 * statement is a red build, so this is the assertion that makes it safe — for
 * that migration and for whoever copies the pattern next.
 */
let validated: Map<string, boolean>;

beforeAll(async () => {
  const schema = connectedSchema();
  const rows = await prisma.$queryRawUnsafe<CheckRow[]>(
    `SELECT conname, pg_get_constraintdef(oid) AS def, convalidated
       FROM pg_constraint
      WHERE contype = 'c'
        AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)`,
    schema,
  );
  checks = new Map(rows.map((r) => [r.conname, r.def]));
  validated = new Map(rows.map((r) => [r.conname, r.convalidated]));
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Every managed constraint, across all four registries — the one property that
 * is not about a value set.
 */
describe("every managed CHECK constraint is VALIDATED, not merely declared", () => {
  const everyManaged = [
    ...REGISTRY,
    ...ARRAY_REGISTRY,
    ...RANGE_REGISTRY,
    ...LENGTH_REGISTRY,
  ].map((r) => r.constraint);

  it("finds the managed constraints at all", () => {
    // The non-zero control. An empty list would satisfy the assertion below
    // while proving nothing was looked at — the shape this whole file exists to
    // refuse.
    expect(everyManaged.length).toBeGreaterThan(25);
  });

  it.each(everyManaged)("%s is validated", (constraint) => {
    // ⚠️ A `NOT VALID` constraint applies to FUTURE writes and has never been
    // checked against the rows already stored, so it can sit on a table full of
    // values it forbids. `pg_get_constraintdef` renders it identically to a
    // validated one, so every other assertion in this file passes on it.
    //
    // `20260816120000_meds_tracker` deliberately uses `NOT VALID` →
    // `VALIDATE CONSTRAINT` on `Settings` to avoid an ACCESS EXCLUSIVE lock
    // during a re-validation scan, which is only a safe pattern because
    // forgetting the second statement reds this.
    expect(
      validated.get(constraint),
      `${constraint} exists but is NOT VALID — it does not bite on rows that ` +
        `already existed. Add "ALTER TABLE … VALIDATE CONSTRAINT" to its migration.`,
    ).toBe(true);
  });
});

describe("enum CHECK constraints ↔ constants.ts are in sync", () => {
  it("has exactly the managed CHECK constraints (no missing, no strays)", () => {
    const managedNames = new Set(REGISTRY.map((r) => r.constraint));
    const applied = [...checks.keys()]
      .filter((n) => managedNames.has(n))
      .sort();
    const expected = REGISTRY.map((r) => r.constraint).sort();
    // Equality in BOTH directions: a missing constraint (someone forgot the
    // migration) and a stray/renamed one (drift the test doesn't know about)
    // both fail here.
    expect(applied).toEqual(expected);
  });

  it.each(REGISTRY)(
    "$constraint ($table.$column) matches its constants.ts value set exactly",
    ({ constraint, values, nullable }) => {
      const def = checks.get(constraint);
      expect(
        def,
        `constraint ${constraint} is not applied to the DB`,
      ).toBeDefined();

      const constrained = literalsFromDef(def as string);
      const expected = new Set(Object.values(values));

      // Every constant value must be permitted by the constraint...
      for (const v of expected) {
        expect(
          constrained.has(v),
          `value "${v}" is in constants.ts but NOT in ${constraint} — add a migration to update the constraint`,
        ).toBe(true);
      }
      // ...and the constraint must permit nothing the constants don't define.
      for (const v of constrained) {
        expect(
          expected.has(v),
          `value "${v}" is in ${constraint} but NOT in constants.ts — remove it from the constraint or add the constant`,
        ).toBe(true);
      }
      // Exact set equality (belt-and-braces over the loops above).
      expect([...constrained].sort()).toEqual([...expected].sort());

      // Sanity: nullability of the constraint clause reflects the schema.
      if (nullable) {
        expect(
          /IS NULL/i.test(def as string),
          `${constraint} guards a nullable column but has no "IS NULL" allowance`,
        ).toBe(true);
      } else {
        expect(
          /IS NULL/i.test(def as string),
          `${constraint} guards a non-nullable column but unexpectedly contains an "IS NULL" allowance`,
        ).toBe(false);
      }
    },
  );
});

describe("array containment CHECK constraints ↔ constants.ts are in sync (#180)", () => {
  it("has exactly the managed array CHECK constraints (no missing, no strays)", () => {
    const managedNames = new Set(ARRAY_REGISTRY.map((r) => r.constraint));
    const applied = [...checks.keys()]
      .filter((n) => managedNames.has(n))
      .sort();
    const expected = ARRAY_REGISTRY.map((r) => r.constraint).sort();
    expect(applied).toEqual(expected);
  });

  it.each(ARRAY_REGISTRY)(
    "$constraint ($table.$column) contains exactly its constants.ts value set",
    ({ constraint, column, values }) => {
      const def = checks.get(constraint);
      expect(
        def,
        `constraint ${constraint} is not applied to the DB — add the migration`,
      ).toBeDefined();

      // Containment, not equality. A `= ANY (…)` here would mean the column had
      // silently gone back to holding one slug, which the whole point of #180 is
      // that it does not. The column name is quoted by Postgres when it is
      // mixed-case, so the pattern tolerates both renderings; it is a literal
      // that CAPTURES the name rather than one built around it, because a
      // dynamically constructed pattern is a SAST finding even here.
      const contained = /"?(\w+)"?\s*<@\s*ARRAY\[/.exec(def as string);
      expect(
        contained?.[1],
        `${constraint} is not a containment (<@) check on "${column}" — its definition is: ${def}`,
      ).toBe(column);

      const constrained = literalsFromDef(def as string);
      const expectedValues = new Set(Object.values(values));
      for (const v of expectedValues) {
        expect(
          constrained.has(v),
          `value "${v}" is in constants.ts but NOT in ${constraint} — add a migration to update the constraint`,
        ).toBe(true);
      }
      for (const v of constrained) {
        expect(
          expectedValues.has(v),
          `value "${v}" is in ${constraint} but NOT in constants.ts — remove it from the constraint or add the constant`,
        ).toBe(true);
      }
      expect([...constrained].sort()).toEqual([...expectedValues].sort());

      // See the registry comment: an `IS NULL` allowance on a containment check
      // is not a widening, it is a hole — `NULL <@ ARRAY[…]` is NULL and a CHECK
      // passes on NULL, so the column would accept an unvalidated NULL.
      expect(
        /IS NULL/i.test(def as string),
        `${constraint} carries an "IS NULL" allowance; the column must be NOT NULL, because a NULL array passes containment unchecked`,
      ).toBe(false);
    },
  );
});

describe("numeric-range CHECK constraints are applied (#78)", () => {
  it("has exactly the managed range CHECK constraints (no missing, no strays)", () => {
    const managedNames = new Set(RANGE_REGISTRY.map((r) => r.constraint));
    const applied = [...checks.keys()]
      .filter((n) => managedNames.has(n))
      .sort();
    const expected = RANGE_REGISTRY.map((r) => r.constraint).sort();
    expect(applied).toEqual(expected);
  });

  it.each(RANGE_REGISTRY)(
    "$constraint pins $table.$column >= $min",
    ({ constraint, column, min, nullable }) => {
      const def = checks.get(constraint);
      expect(
        def,
        `constraint ${constraint} is not applied to the DB — add the migration`,
      ).toBeDefined();

      // Postgres normalises `CHECK ("estMinutes" >= 1)` to
      // `CHECK (("estMinutes" >= 1))`; match the comparison, not the parens.
      // #180 reached the same place from the other direction, with a literal
      // capturing pattern. This file now has TWO bound assertions (`>= min`
      // here, `<= max` below), so they share one idiom rather than each
      // carrying its own — `flatDef` normalises the quoting and whitespace and
      // the comparison is then just the SQL, with no pattern built from a
      // variable for SAST to flag.
      expect(
        flatDef(def as string).includes(`${column} >= ${min}`),
        `${constraint} does not pin "${column}" >= ${min} — its definition is: ${def}`,
      ).toBe(true);

      if (nullable) {
        // #80 — on a nullable column the bound alone is not the invariant: a
        // plain `>= 1` would reject every row that legitimately has no
        // estimate, so the NULL allowance is load-bearing and pinned here.
        expect(
          /IS NULL/i.test(def as string),
          `${constraint} guards a nullable column but has no "IS NULL" allowance — a plain >= ${min} would reject rows whose estimate is legitimately absent`,
        ).toBe(true);
      } else {
        // A NOT NULL column needs no NULL allowance; one appearing here would
        // mean the column went nullable without this registry noticing.
        expect(
          /IS NULL/i.test(def as string),
          `${constraint} guards a non-nullable column but unexpectedly contains an "IS NULL" allowance`,
        ).toBe(false);
      }
    },
  );
});

describe("text-length CHECK constraints are applied (#44)", () => {
  it("has exactly the managed length CHECK constraints (no missing, no strays)", () => {
    const managedNames = new Set(LENGTH_REGISTRY.map((r) => r.constraint));
    const applied = [...checks.keys()]
      .filter((n) => managedNames.has(n))
      .sort();
    const expected = LENGTH_REGISTRY.map((r) => r.constraint).sort();
    expect(applied).toEqual(expected);
  });

  it.each(LENGTH_REGISTRY)(
    "$constraint pins $column <= $max, measured with $fn",
    ({ constraint, column, max, fn, nullable }) => {
      const def = checks.get(constraint);
      expect(
        def,
        `constraint ${constraint} is not applied to the DB — add the migration`,
      ).toBeDefined();

      // Matched against the flattened definition, so the parens and quoting
      // Postgres chooses for itself cannot break the assertion.
      expect(
        flatDef(def as string).includes(`${fn}(${column}) <= ${max}`),
        `${constraint} does not pin ${fn}("${column}") <= ${max} — its definition is: ${def}`,
      ).toBe(true);

      // The measuring function is pinned above; this catches the swap in the
      // other direction, where a second call to the wrong one is added rather
      // than the right one replaced.
      const otherFns = ["octet_length", "length", "bit_length"].filter(
        (f) => f !== fn,
      );
      const called = calledFunctions(def as string);
      expect(
        called.has(fn),
        `${constraint} does not call ${fn} at all — its definition is: ${def}`,
      ).toBe(true);
      for (const other of otherFns) {
        expect(
          called.has(other),
          `${constraint} measures with ${other}, which disagrees with ${fn} on multi-byte text — its definition is: ${def}`,
        ).toBe(false);
      }

      if (nullable) {
        // Without the allowance a plain `char_length(col) <= n` is UNKNOWN for
        // NULL, which a CHECK treats as satisfied — so this one is belt rather
        // than braces, and it is asserted because the day the column goes NOT
        // NULL the allowance becomes wrong and nothing else would notice.
        expect(
          /IS NULL/i.test(def as string),
          `${constraint} guards a nullable column but has no "IS NULL" allowance`,
        ).toBe(true);
      } else {
        expect(
          /IS NULL/i.test(def as string),
          `${constraint} guards a non-nullable column but unexpectedly contains an "IS NULL" allowance`,
        ).toBe(false);
      }
    },
  );
});

// #35 Phase A — the sync test above proves the constraint *definitions* match
// constants.ts. It does NOT prove Postgres enforces them: a constraint that was
// added `NOT VALID`, or dropped by a later out-of-band migration, would still
// have to be re-added for the sync test to pass, but a test that never sees a
// rejection is a test nobody has watched fail. These insert a genuinely
// out-of-set value through raw SQL (bypassing Prisma's types, which is the only
// way this reaches the DB) and require the write to be rejected.
describe("identity CHECK constraints actually reject out-of-set values", () => {
  const cases: ReadonlyArray<{ column: string; bad: string; sql: string }> = [
    {
      column: "User.role",
      bad: "admin",
      sql: `INSERT INTO "User" (id, provider, "providerSub", role) VALUES ('check-bite-role','gitlab','check-bite-1','admin')`,
    },
    {
      column: "User.status",
      bad: "suspended",
      sql: `INSERT INTO "User" (id, provider, "providerSub", status) VALUES ('check-bite-status','gitlab','check-bite-2','suspended')`,
    },
    {
      column: "User.aiPolicy",
      bad: "free_for_all",
      sql: `INSERT INTO "User" (id, provider, "providerSub", "aiPolicy") VALUES ('check-bite-policy','gitlab','check-bite-3','free_for_all')`,
    },
    {
      column: "Workspace.kind",
      bad: "shared",
      sql: `INSERT INTO "Workspace" (id, kind) VALUES ('check-bite-ws','shared')`,
    },
    {
      // #35 Phase B — the range constraint's behavioural half. A negative quota
      // reads as an allowance and behaves as a permanent block, so the DB
      // refuses it even though `updatePersonAiPolicy` already clamps.
      column: "User.aiQuota",
      bad: "-1",
      sql: `INSERT INTO "User" (id, provider, "providerSub", "aiQuota") VALUES ('check-bite-quota','gitlab','check-bite-4',-1)`,
    },
  ];

  it.each(cases)("$column rejects '$bad'", async ({ sql }) => {
    await expect(prisma.$executeRawUnsafe(sql)).rejects.toThrow(
      /violates check constraint/i,
    );
  });

  it("still accepts every value constants.ts declares for User.role", async () => {
    for (const role of Object.values(UserRole)) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "User" (id, provider, "providerSub", role) VALUES ($1,'gitlab',$2,$3)`,
        `check-ok-${role}`,
        `check-ok-${role}`,
        role,
      );
    }
    const ids = Object.values(UserRole).map((r) => `check-ok-${r}`);
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "User" WHERE id = ANY($1::text[])`,
      ids,
    );
    expect(rows).toHaveLength(ids.length);
    await prisma.$executeRawUnsafe(
      `DELETE FROM "User" WHERE id = ANY($1::text[])`,
      ids,
    );
  });
});

/**
 * #269 — the behavioural half for the medication tracker's two constraints.
 *
 * Its own block because both need FIXTURE ROWS the block above deliberately does
 * not have: `MedsDoseLog` has two foreign keys and `Settings` has one, so there
 * is no single INSERT that reaches either column. The rejections themselves are
 * the same shape — raw SQL past Prisma's types, which is the only way an
 * out-of-set value gets to the database at all.
 *
 * ⚠️ **This block is what makes the registry entries above worth anything.** The
 * sync assertions prove the constraint DEFINITIONS mirror `constants.ts`; they
 * cannot prove Postgres enforces them, because a constraint added `NOT VALID`
 * would still have to be re-added for the definition check to pass. And the
 * "no strays" assertion cannot see an unregistered constraint at all. So for
 * these two, "the constraint bites" is asserted here or it is asserted nowhere.
 */
describe("#269 medication CHECK constraints actually reject out-of-set values", () => {
  const WS = "meds-check-ws";
  const MED = "meds-check-med";
  const DOSE = "meds-check-dose";

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Workspace" (id, kind) VALUES ($1,'user') ON CONFLICT (id) DO NOTHING`,
      WS,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Medication" (id, "workspaceId", name, "order") VALUES ($1,$2,'Ritalin',1) ON CONFLICT (id) DO NOTHING`,
      MED,
      WS,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "MedicationDose" (id, "medicationId", label, quantity, "order") VALUES ($1,$2,'after breakfast',2,1) ON CONFLICT (id) DO NOTHING`,
      DOSE,
      MED,
    );
  });

  afterAll(async () => {
    // The Workspace cascade takes Medication, MedicationDose, MedsDoseLog and
    // Settings with it, so one DELETE is the whole teardown.
    await prisma.$executeRawUnsafe(`DELETE FROM "Workspace" WHERE id = $1`, WS);
  });

  it("MedsDoseLog.state rejects 'missed', which is DERIVED and must never be stored", async () => {
    // Not an arbitrary bad value. `missed` is the one an implementer would reach
    // for, because it is a real state the UI renders — and storing it would make
    // the absence of a row and the presence of a `missed` row two ways to say the
    // same thing, one of which a job can fail to write.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "MedsDoseLog" (id, "workspaceId", date, "medicationDoseId", state)
           VALUES ('meds-check-bite-missed',$1,'2026-08-17',$2,'missed')`,
        WS,
        DOSE,
      ),
    ).rejects.toThrow(/violates check constraint/i);
  });

  it("MedsDoseLog.state rejects an unrecognised value", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "MedsDoseLog" (id, "workspaceId", date, "medicationDoseId", state)
           VALUES ('meds-check-bite-maybe',$1,'2026-08-17',$2,'maybe')`,
        WS,
        DOSE,
      ),
    ).rejects.toThrow(/violates check constraint/i);
  });

  it("still accepts every value constants.ts declares for MedsDoseLog.state", async () => {
    // The non-zero control. Without it the two rejections above are satisfied by
    // a constraint that refuses everything, which would pass while making the
    // feature unusable.
    for (const state of Object.values(MedsDoseState)) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "MedsDoseLog" (id, "workspaceId", date, "medicationDoseId", state)
           VALUES ($1,$2,$3,$4,$5)`,
        `meds-check-ok-${state}`,
        WS,
        `2026-08-${state === MedsDoseState.Taken ? "18" : "19"}`,
        DOSE,
        state,
      );
    }
    const rows = await prisma.$queryRawUnsafe<{ state: string }[]>(
      `SELECT state FROM "MedsDoseLog" WHERE "workspaceId" = $1 ORDER BY state`,
      WS,
    );
    expect(rows.map((r) => r.state)).toEqual(
      [...Object.values(MedsDoseState)].sort(),
    );
  });

  it("Settings.medsNavMode rejects an out-of-set mode", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Settings" (id, "workspaceId", "medsNavMode", "updatedAt")
           VALUES ('meds-check-bite-mode',$1,'dial',CURRENT_TIMESTAMP)`,
        WS,
      ),
    ).rejects.toThrow(/violates check constraint/i);
  });

  it("still accepts every value constants.ts declares for Settings.medsNavMode", async () => {
    // `Settings.workspaceId` is @unique, so the control updates one row through
    // both values rather than inserting one row per value.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Settings" (id, "workspaceId", "updatedAt") VALUES ('meds-check-settings',$1,CURRENT_TIMESTAMP)`,
      WS,
    );
    for (const mode of Object.values(MedsNavMode)) {
      await prisma.$executeRawUnsafe(
        `UPDATE "Settings" SET "medsNavMode" = $1 WHERE "workspaceId" = $2`,
        mode,
        WS,
      );
      const rows = await prisma.$queryRawUnsafe<{ medsNavMode: string }[]>(
        `SELECT "medsNavMode" FROM "Settings" WHERE "workspaceId" = $1`,
        WS,
      );
      expect(rows[0]?.medsNavMode).toBe(mode);
    }
  });

  it("defaults a NEW Settings row to 'dots' and the tracker to off", async () => {
    // The migration's ADD COLUMN defaults are where two decisions live — "B★ is
    // the default mode" and "the feature is off until you ask for it" — so they
    // are asserted rather than left in a comment.
    //
    // Its OWN workspace, because the mode case above walks the shared row
    // through every declared value and leaves it on the last one. Reusing that
    // row read `next` and failed this assertion, which is the test-order
    // coupling doing its job rather than a flake.
    const freshWs = "meds-check-ws-default";
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Workspace" (id, kind) VALUES ($1,'user') ON CONFLICT (id) DO NOTHING`,
      freshWs,
    );
    try {
      const rows = await prisma.$queryRawUnsafe<
        { medsNavMode: string; medsTracker: boolean }[]
      >(
        `INSERT INTO "Settings" (id, "workspaceId", "updatedAt")
           VALUES ('meds-check-default', $1, CURRENT_TIMESTAMP)
         RETURNING "medsNavMode", "medsTracker"`,
        freshWs,
      );
      expect(rows[0]).toMatchObject({
        medsNavMode: MedsNavMode.Dots,
        medsTracker: false,
      });
    } finally {
      await prisma.$executeRawUnsafe(
        `DELETE FROM "Workspace" WHERE id = $1`,
        freshWs,
      );
    }
  });
});
