import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  BrainDumpStatus,
  TaskStatus,
  TaskSource,
  TurnRole,
  FocusOutcome,
  RewardType,
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
} from "@/lib/constants";
// #106 — the scheduling vocabulary lives in its own client-safe module (both the
// server actions and the Schedule menu import it), so these two value sets are
// authoritative from there rather than from constants.ts.
import { SchedulePriority, ScheduleHours } from "@/lib/scheduling/types";

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

type CheckRow = { conname: string; def: string };
let checks: Map<string, string>;

beforeAll(async () => {
  const schema = connectedSchema();
  const rows = await prisma.$queryRawUnsafe<CheckRow[]>(
    `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE contype = 'c'
        AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)`,
    schema,
  );
  checks = new Map(rows.map((r) => [r.conname, r.def]));
});

afterAll(async () => {
  await prisma.$disconnect();
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
      // A literal pattern that CAPTURES the column and the bound, rather than one
      // built around them — same assertion, and it keeps this file free of the
      // dynamically-constructed patterns SAST flags (#180 removed the other one).
      const bound = /"(\w+)"\s*>=\s*(\d+)\b/.exec(def as string);
      expect(
        bound?.[1],
        `${constraint} does not compare "${column}" — its definition is: ${def}`,
      ).toBe(column);
      expect(
        Number(bound?.[2]),
        `${constraint} does not pin "${column}" >= ${min} — its definition is: ${def}`,
      ).toBe(min);

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
