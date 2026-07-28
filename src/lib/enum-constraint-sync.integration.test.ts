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
  CompleteTickColor,
  Typeface,
} from "@/lib/constants";

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

// The bijection between a CHECK constraint and the constants.ts object whose
// values it must mirror. Deriving `values` from the imported constant object
// (not a re-typed literal list) is what makes constants.ts authoritative:
// adding `BrainDumpStatus.Foo` here immediately changes the expected set.
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
];

// #78 — numeric-range CHECK constraints. Unlike the pseudo-enum columns above
// there is no constants.ts object to mirror (the bound is a number, not a
// value set), so the source of truth is the constraint's own migration and
// this table pins it: `min` is the inclusive lower bound the SQL must declare.
// Keeping it here rather than in its own file means one place still answers
// "which CHECK constraints does this schema manage?".
const RANGE_REGISTRY: ReadonlyArray<{
  constraint: string;
  table: string;
  column: string;
  min: number;
}> = [
  {
    // 20260727194512_step_est_minutes_check — every Step must be at least one
    // whole minute long. Four application writers clamp to this already; the
    // constraint is what stops a fifth from skipping it.
    constraint: "Step_estMinutes_check",
    table: "Step",
    column: "estMinutes",
    min: 1,
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
    ({ constraint, column, min }) => {
      const def = checks.get(constraint);
      expect(
        def,
        `constraint ${constraint} is not applied to the DB — add the migration`,
      ).toBeDefined();

      // Postgres normalises `CHECK ("estMinutes" >= 1)` to
      // `CHECK (("estMinutes" >= 1))`; match the comparison, not the parens.
      expect(
        new RegExp(`"${column}"\\s*>=\\s*${min}\\b`).test(def as string),
        `${constraint} does not pin "${column}" >= ${min} — its definition is: ${def}`,
      ).toBe(true);

      // A NOT NULL column needs no NULL allowance; one appearing here would
      // mean the column went nullable without this registry noticing.
      expect(
        /IS NULL/i.test(def as string),
        `${constraint} guards a non-nullable column but unexpectedly contains an "IS NULL" allowance`,
      ).toBe(false);
    },
  );
});
