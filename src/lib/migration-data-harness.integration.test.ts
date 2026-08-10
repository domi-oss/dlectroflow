import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dropConstraintAfterWrite,
  findDataDependentStatements,
  findSeedGaps,
  planSeededDeploy,
  type SeedFile,
} from "@/lib/migration-data-harness";
import { type MigrationFile } from "@/lib/focus-sound-migration-hygiene";
import { FocusSound, FocusSoundCategory } from "@/lib/constants";

/**
 * #190 — the migrations, applied to a database that already holds rows.
 *
 * `prisma migrate deploy` against an empty schema proves a migration parses.
 * Every gate this project has does exactly that, which is why on 2026-08-07 a
 * migration that wrote `focusSound = 'on'` while the constraint forbidding
 * `'on'` was still live shipped green and then failed in production with
 * SQLSTATE 23514, taking every later migration down with it (P3009).
 *
 * This file runs the real `prisma migrate deploy`, one migration at a time,
 * against a scratch schema seeded from `__tests__/migration-seeds/`. Three things
 * come out of it:
 *
 *  1. **Failure is demonstrated, not assumed.** The second test reconstructs the
 *     pre-fix statement order and requires the harness to fail with 23514 and
 *     then P3009. #190 says in as many words not to close on a harness that
 *     passes — a green harness nobody has watched fail is the exact class of
 *     signal this repo has been bitten by six times.
 *  2. **Coverage is measured, not inferred.** Before each migration the rows in
 *     the tables it is about to touch are counted, so "this migration met data"
 *     is a number rather than a claim about the seed files. A seed silently
 *     deleted by an intermediate migration shows up here; the static
 *     `findSeedGaps` cannot see it.
 *  3. **The conversion is asserted, not just survived.** The final state of every
 *     seeded row is checked against what the migrations promised to do with it.
 *
 * ── Why the real CLI and a staged directory ────────────────────────────────
 *
 * The migrations could be replayed far more cheaply by splitting each file and
 * pushing the statements through `$executeRawUnsafe`. That would make the harness
 * depend on this repo's own SQL splitter agreeing with Prisma's, and a harness
 * whose fidelity rests on the thing it is testing is not one. So each phase
 * copies migration directories into a temp tree and shells out to the real
 * `prisma migrate deploy`, exactly as the container entrypoint does.
 *
 * The spawn runs with `cwd` set to the temp directory on purpose: `prisma.config.ts`
 * at the repo root pins `migrations.path` to the real `prisma/migrations`, and it
 * would quietly override the staged subset that makes staged application possible.
 *
 * Needs the real Postgres, and creates its own schemas (dropped afterwards) so it
 * cannot disturb the schema the rest of the suite shares:
 *   set -a; . ./.env; set +a; npm run test
 */

const REPO_ROOT = process.cwd();
const MIGRATIONS_DIR = join(REPO_ROOT, "prisma/migrations");
const SEEDS_DIR = join(REPO_ROOT, "src/lib/__tests__/migration-seeds");
const PRISMA_BIN = join(REPO_ROOT, "node_modules/.bin/prisma");

/** The migration under test in the failure demonstration. */
const INCIDENT_MIGRATION = "20260806100000_settings_focus_sound_categories";
const INCIDENT_CONSTRAINT = "Settings_focusSound_check";

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function readMigrations(): MigrationFile[] {
  return migrationNames().map((name) => ({
    name,
    sql: readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8"),
  }));
}

/**
 * The seed corpus. The file name is the migration the seed is applied straight
 * after, which is what ties a seed to the schema version it was written against
 * — and what `planSeededDeploy` throws over if that migration is ever renamed.
 */
function readSeeds(): SeedFile[] {
  return readdirSync(SEEDS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({
      after: f.replace(/\.sql$/, ""),
      sql: readFileSync(join(SEEDS_DIR, f), "utf8"),
    }));
}

/** The suite's DATABASE_URL with its `schema` parameter replaced. */
function urlForSchema(schema: string): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.searchParams.set("schema", schema);
  return url.toString();
}

const createdSchemas: string[] = [];
const tempDirs: string[] = [];

/**
 * A scratch Postgres schema name unique to this process. Postgres is shared
 * between parallel worktrees here, so a fixed name would have two runs
 * migrating each other's tables.
 */
function scratchSchema(purpose: string): string {
  const name = `h190_${purpose}_${process.pid}`;
  createdSchemas.push(name);
  return name;
}

/** A temp tree holding `schema.prisma` and a `migrations/` subset. */
function stageTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "h190-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "prisma/migrations"), { recursive: true });
  cpSync(
    join(REPO_ROOT, "prisma/schema.prisma"),
    join(dir, "prisma/schema.prisma"),
  );
  cpSync(
    join(MIGRATIONS_DIR, "migration_lock.toml"),
    join(dir, "prisma/migrations/migration_lock.toml"),
  );
  return dir;
}

/**
 * Copy one migration into the staged tree, optionally replacing its SQL. Used to
 * install the reconstructed pre-fix migration in place of the committed one.
 */
function stageMigration(tree: string, name: string, sql?: string): void {
  const target = join(tree, "prisma/migrations", name);
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, "migration.sql"),
    sql ?? readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8"),
  );
}

interface RunResult {
  ok: boolean;
  output: string;
}

/** `prisma <args>` against `url`, from the staged tree. Never throws. */
function runPrisma(tree: string, url: string, args: string[]): RunResult {
  try {
    const stdout = execFileSync(
      PRISMA_BIN,
      [...args, "--schema", join(tree, "prisma/schema.prisma")],
      {
        cwd: tree,
        // A near-empty env on purpose: a stray `DATABASE_URL` or `PRISMA_*` from
        // the developer's shell must not decide which database this writes to.
        // The four that are forwarded each earn it:
        //   PATH  — the CLI shells out to nothing, but Node resolves itself
        //   HOME  — the CLI writes a cache under it and errors without one on
        //           the alpine CI image, where HOME is not implied by anything
        //   CHECKPOINT_DISABLE — Prisma's version check, which is a network
        //           round-trip per invocation; there are ~40 invocations here
        //           and CI runners should not be reaching the internet for them
        //   NODE_ENV — only because @types/node requires it on ProcessEnv
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? tree,
          CHECKPOINT_DISABLE: "1",
          NODE_ENV: "test",
          DATABASE_URL: url,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { ok: true, output: stdout };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    return {
      ok: false,
      output: `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message}`,
    };
  }
}

const deploy = (tree: string, url: string) =>
  runPrisma(tree, url, ["migrate", "deploy"]);

/** Run a seed file. Written to the staged tree so the path is a real file. */
function applySeed(tree: string, url: string, seed: SeedFile): void {
  const path = join(tree, `seed-${seed.after}.sql`);
  writeFileSync(path, seed.sql);
  const result = runPrisma(tree, url, ["db", "execute", "--file", path]);
  if (!result.ok) {
    throw new Error(
      `migration seed "${seed.after}" failed to apply. A seed has to be valid at ` +
        `the schema version it is named for, so this usually means the seed names ` +
        `a column that migration has not added yet (or one a later migration ` +
        `dropped).\n\n${result.output}`,
    );
  }
}

/**
 * A bare SQL identifier. Every schema and table name that reaches a query below
 * is checked against this first: identifiers cannot be parameterised, so the only
 * thing standing between a template literal and an injection sink is proof that
 * the value is an identifier — and "it came from our own code" is the assumption
 * every such sink was built on.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(kind: string, value: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`refusing to interpolate ${kind} "${value}" into SQL.`);
  }
  return value;
}

/** Tables that exist in `schema` right now. */
async function existingTables(
  prisma: PrismaClient,
  schema: string,
): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
    schema,
  );
  return new Set(rows.map((r) => r.table_name));
}

async function countRows(
  prisma: PrismaClient,
  schema: string,
  table: string,
): Promise<number> {
  // `table` comes from information_schema in this same schema and `schema` from
  // `scratchSchema`, so neither is user input — and both are still checked,
  // because an identifier interpolated on the strength of where it came from is
  // an injection sink waiting for its provenance to change.
  const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM "${assertIdentifier("schema", schema)}"."${assertIdentifier("table", table)}"`,
  );
  return rows[0]?.n ?? 0;
}

async function dropSchemas(schemas: readonly string[]): Promise<void> {
  const prisma = new PrismaClient();
  try {
    for (const schema of schemas) {
      await prisma.$executeRawUnsafe(
        `DROP SCHEMA IF EXISTS "${assertIdentifier("schema", schema)}" CASCADE`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

afterAll(async () => {
  await dropSchemas(createdSchemas);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** One migration's turn: what it will touch, and how much of it was there. */
interface Measurement {
  migration: string;
  table: string;
  rows: number;
}

/**
 * Apply `names` one migration at a time, injecting seeds at their points, and
 * count the rows in each table a migration is about to touch.
 *
 * One `prisma migrate deploy` per migration rather than one per phase: the
 * counts have to be taken between two adjacent migrations, and that granularity
 * is the difference between measuring coverage and assuming it.
 */
async function seededDeploy(
  names: string[],
  seeds: SeedFile[],
  schema: string,
): Promise<{ measurements: Measurement[]; failure?: RunResult }> {
  // Validates the seed names against the migration list before anything runs.
  planSeededDeploy(names, seeds);

  // A schema left behind by a crashed run is the one failure mode that would go
  // unnoticed: `migrate deploy` would find its migrations already recorded, skip
  // them, and the row counts taken between them would describe a database this
  // run never built. Every scenario therefore starts from nothing.
  await dropSchemas([schema]);

  const tree = stageTree();
  const url = urlForSchema(schema);
  const prisma = new PrismaClient({ datasourceUrl: url });
  const seedsByAfter = new Map(seeds.map((s) => [s.after, s]));
  const wanted = findDataDependentStatements(readMigrations());
  const measurements: Measurement[] = [];

  try {
    for (const name of names) {
      const tables = new Set(
        wanted.filter((w) => w.migration === name).map((w) => w.table),
      );
      if (tables.size > 0) {
        const present = await existingTables(prisma, schema);
        for (const table of tables) {
          if (!present.has(table)) continue; // created by this migration
          measurements.push({
            migration: name,
            table,
            rows: await countRows(prisma, schema, table),
          });
        }
      }

      stageMigration(tree, name);
      const result = deploy(tree, url);
      if (!result.ok) return { measurements, failure: result };

      const seed = seedsByAfter.get(name);
      if (seed) applySeed(tree, url, seed);
    }
    return { measurements };
  } finally {
    await prisma.$disconnect();
  }
}

describe("the migrations applied to a database that already holds rows (#190)", () => {
  const names = migrationNames();
  const seeds = readSeeds();

  // One seeded run, shared by the assertions below. Applying the migrations is
  // the expensive part (one real CLI invocation each), and running it per
  // assertion made this file the slowest in the suite for no extra coverage.
  const schema = scratchSchema("green");
  let run: Awaited<ReturnType<typeof seededDeploy>>;

  beforeAll(async () => {
    run = await seededDeploy(names, seeds, schema);
  }, 240_000);

  it("applies every committed migration to seeded data", () => {
    expect(
      run.failure?.output ?? "no failure",
      "a committed migration failed against seeded rows — this is the shape of " +
        "the 2026-08-07 incident, not a harness problem",
    ).toBe("no failure");
  });

  it("ran every data-dependent migration against a table that had rows in it", () => {
    // An empty measurement list would mean the classifier stopped finding
    // anything, which reads as success and proves nothing.
    expect(run.measurements.length).toBeGreaterThan(20);

    const empty = run.measurements.filter((m) => m.rows === 0);
    expect(
      empty.map((m) => `${m.migration} ran with 0 rows in "${m.table}"`),
      "these migrations still ran against an empty table, so nothing they do " +
        "to data was tested. Add a seed under src/lib/__tests__/migration-seeds/ " +
        "named for a migration BEFORE the one listed.",
    ).toEqual([]);
  });

  it("converts every seeded focus-sound state to what #180 promised", async () => {
    const prisma = new PrismaClient({ datasourceUrl: urlForSchema(schema) });
    try {
      const settings = await prisma.settings.findMany();
      const byWorkspace = new Map(settings.map((s) => [s.workspaceId, s]));

      // A stored TRACK becomes that track's category, sound on.
      expect(byWorkspace.get("seed-ws-track")).toMatchObject({
        focusSound: FocusSound.On,
        focusSoundCategories: [FocusSoundCategory.Chillhop],
      });

      // A stored CATEGORY wins over the track: more recent, more deliberate.
      expect(byWorkspace.get("seed-ws-category")).toMatchObject({
        focusSound: FocusSound.On,
        focusSoundCategories: [FocusSoundCategory.Jazzhop],
      });

      // The account that chose silence is still silent, and its stray category
      // did not become a playlist. This is the assertion that would have
      // failed if the conversion's `focusSound <> 'off'` guard were dropped.
      expect(byWorkspace.get("seed-ws-silent")).toMatchObject({
        focusSound: FocusSound.Off,
        focusSoundCategories: [],
      });

      // The original account never asked for music, so it keeps the value the
      // column defaulted to when it was added — the new-account default of
      // `'on'` reaches rows inserted after it and no others.
      expect(byWorkspace.get("owner")).toMatchObject({
        focusSound: FocusSound.Off,
        focusSoundCategories: [],
      });

      // Both estimate floors were repaired rather than left to fail the CHECK.
      const steps = await prisma.step.findMany({ orderBy: { order: "asc" } });
      expect(steps.map((s) => s.estMinutes)).toEqual([1, 15]);
      const inbox = await prisma.brainDumpItem.findMany({
        where: { id: "seed-inbox-2" },
      });
      expect(inbox[0]?.estMinutes).toBe(1);

      // The task survived cleanup_orphaned_tasks because an inbox item points
      // at it; that migration deletes every task none does.
      expect(await prisma.task.count({ where: { id: "seed-task-1" } })).toBe(1);

      // owner_uncapped_repair lifted the owner and left the member alone.
      const users = await prisma.user.findMany({ orderBy: { id: "asc" } });
      expect(users.map((u) => [u.id, u.aiPolicy, u.llmProvider])).toEqual([
        ["seed-user-member", "capped", "anthropic"],
        ["seed-user-owner", "uncapped", null],
      ]);

      // Both purges removed the orphan and kept the linked row, which is what
      // let `SET NOT NULL` succeed rather than abort the migration.
      const google = await prisma.googleAuth.findMany();
      expect(google.map((g) => g.id)).toEqual(["seed-google-linked"]);
    } finally {
      await prisma.$disconnect();
    }
  });

  // ── The close condition of #190 ─────────────────────────────────────────────
  // "Do not close this on a harness that passes. Close it on a harness
  // demonstrated to fail against the pre-fix 20260806100000 migration with
  // seeded rows, reproducing SQLSTATE 23514."
  it("fails with SQLSTATE 23514 when the 2026-08-07 statement order is put back", async () => {
    const upTo = names.slice(0, names.indexOf(INCIDENT_MIGRATION) + 1);
    expect(upTo.at(-1)).toBe(INCIDENT_MIGRATION);

    const original = readFileSync(
      join(MIGRATIONS_DIR, INCIDENT_MIGRATION, "migration.sql"),
      "utf8",
    );
    // Throws rather than returning the input if the move is a no-op, so this
    // test cannot degrade into running the fixed migration and passing.
    const preFix = dropConstraintAfterWrite(original, INCIDENT_CONSTRAINT);

    const brokenSchema = scratchSchema("prefix");
    await dropSchemas([brokenSchema]);
    const tree = stageTree();
    const url = urlForSchema(brokenSchema);
    const seedsByAfter = new Map(seeds.map((s) => [s.after, s]));

    // Phase-at-a-time rather than migration-at-a-time: nothing is measured
    // here, so the only boundaries that matter are the seed points, and this
    // is the difference between four CLI invocations and thirty-eight.
    const before = upTo.slice(0, -1);

    // Only the seeds that belong to this prefix (raised in review). Every seed
    // committed today happens to sit before the incident migration, but
    // CONTRIBUTING tells the next author to add a seed named for a migration
    // before their own — so the first seed added after this point would make
    // `planSeededDeploy` throw "seed names a migration that does not exist",
    // and this test would fail with something that has nothing to do with the
    // regression it exists to pin. That strictness is right for the full run and
    // wrong here, because here the truncation is deliberate.
    const beforeSet = new Set(before);
    const applicable = seeds.filter((s) => beforeSet.has(s.after));

    // …and the filter must not be what makes the demonstration pass. The row
    // that violates the old constraint comes from exactly one seed; if a rename
    // ever drops it, this test would deploy a clean database and observe no
    // 23514, which reads as "the harness is fine".
    expect(applicable.map((s) => s.after)).toContain(
      "20260726120000_focus_sound_lofi_library",
    );

    for (const phase of planSeededDeploy(before, applicable)) {
      for (const name of phase.migrations) stageMigration(tree, name);
      const result = deploy(tree, url);
      expect(
        result.ok,
        `a migration BEFORE the one under test failed, so any 23514 after this ` +
          `would not be the incident:\n${result.output}`,
      ).toBe(true);
      const seed = phase.seedAfter && seedsByAfter.get(phase.seedAfter);
      if (seed) applySeed(tree, url, seed);
    }

    stageMigration(tree, INCIDENT_MIGRATION, preFix);
    const attempt = deploy(tree, url);
    const failure = attempt.ok ? undefined : attempt;

    expect(
      failure,
      "the reconstructed pre-fix migration APPLIED CLEANLY. Either the seeded " +
        "rows no longer reach it, or the harness is no longer exercising the " +
        "constraint — both mean this suite would miss the 2026-08-07 defect.",
    ).toBeDefined();
    expect(failure?.output).toContain("23514");
    expect(failure?.output).toContain(INCIDENT_CONSTRAINT);

    // The second-order damage: Prisma records the failed migration and then
    // refuses every later one, which is why a one-line ordering mistake cost
    // two days of deploys rather than one rollback.
    const again = deploy(tree, url);
    expect(again.ok).toBe(false);
    expect(again.output).toContain("P3009");
  }, 240_000);

  // The static companion to the measured gate above. It needs no database, so it
  // is the check that tells an author WHERE to put a seed; the measured one is
  // what proves the seed arrived. Neither replaces the other: this one cannot see
  // a seed emptied by an intermediate migration, and that one cannot run in a
  // pre-commit hook.
  it("has a seed for every table a migration's data-dependent statements touch", () => {
    const gaps = findSeedGaps(readMigrations(), seeds);
    expect(
      gaps.map((g) => `${g.migration}: "${g.table}" [${g.shapes.join(", ")}]`),
    ).toEqual([]);
  });
});
