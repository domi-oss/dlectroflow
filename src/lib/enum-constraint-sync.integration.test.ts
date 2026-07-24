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
