/**
 * #122 — behavioural proof that `GoogleAuth.userId` really is NOT NULL in
 * Postgres, not just in the Prisma types and the scoping harness.
 *
 * A `GoogleAuth` row is the highest-value thing in the schema: it carries an
 * encrypted Google access/refresh token pair. A row with a NULL `userId` is not
 * merely untidy, it is a credential that is
 *
 *   * unreachable  — every read is `findUnique({ where: { userId } })`;
 *   * unrevocable  — `disconnectGoogle` is `deleteMany({ where: { userId } })`;
 *   * uncascadable — the FK cascades FROM `User`, and a NULL never reaches one.
 *
 * Production held exactly one such row until #118's
 * `20260729140000_google_auth_orphan_purge` destroyed it. That migration was the
 * REPAIR half; this is the ENFORCE half, deferred one release on purpose because
 * the code #118 replaced wrote a NULL `userId` on every page load and a
 * `SET NOT NULL` mid-rolling-update would have 500'd the inbox.
 *
 * `src/lib/__tests__/scoping.harness.test.ts` remains the PRIMARY guard — it
 * fails in CI if any `prisma.googleAuth.*` call does not name `userId`, which is
 * strictly better than a runtime constraint violation. This constraint is
 * belt-and-braces beneath it, for the writer the static scan cannot see: raw
 * SQL, a psql session, or a restore of an old dump.
 *
 * Two halves, mirroring the split `enum-constraint-sync` /
 * `step-est-minutes-check.integration.test.ts` uses:
 *
 *   1. APPLIED — `information_schema` agrees the column is NOT NULL, so the
 *      migration cannot be quietly dropped without failing the suite.
 *   2. BITES   — a raw INSERT of a NULL `userId` is rejected by the database.
 *      Raw on purpose: `prisma.googleAuth.create` would not typecheck with a
 *      null, so the client can never produce this insert. Raw SQL is the closest
 *      thing to "a writer that bypassed the client", which is the only writer
 *      left for a database constraint to stop.
 *
 * Needs the real Postgres (CI wires up a service DB and runs
 * `prisma migrate deploy` first; locally it uses your DATABASE_URL schema —
 * vitest does NOT read .env):
 *   set -a; . ./.env; set +a; npm run test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { UserRole, UserStatus } from "@/lib/constants";

// Dedicated client + a unique, never-reused providerSub prefix, wiped before and
// after — the isolation approach every *.integration.test.ts here uses, so
// $disconnect() cannot tear the connection out from under a sibling suite.
const prisma = new PrismaClient();
const SUB_PREFIX = "test-122-notnull-";
const ORPHAN_ID = "test-122-orphan-row";
const OWNED_ID = "test-122-owned-row";

let userId: string;

async function wipe() {
  // GoogleAuth cascades from User, so deleting the fixture account takes the
  // owned row with it; the orphan can't cascade (that is the whole point of this
  // constraint), so it is deleted by primary key.
  await prisma.user.deleteMany({
    where: { providerSub: { startsWith: SUB_PREFIX } },
  });
  await prisma.googleAuth.deleteMany({
    where: { id: { in: [ORPHAN_ID, OWNED_ID] } },
  });
}

/**
 * Insert a GoogleAuth row straight through SQL, with `userId` supplied by the
 * caller so the same statement covers the rejected and the accepted case.
 *
 * `id` and `updatedAt` are explicit because neither has a database default:
 * `@default(cuid())` is generated client-side, and `20260727230000_accounts_identity`
 * dropped the legacy `DEFAULT 'singleton'` on `id` when the singleton died.
 *
 * Parameterised ($1..$3) rather than interpolated, so it cannot be read as a
 * SQL-injection pattern and matches how the other raw queries in the tree are
 * written.
 */
function insertGoogleAuth(id: string, ownerId: string | null) {
  return prisma.$executeRawUnsafe(
    `INSERT INTO "GoogleAuth" ("id", "userId", "accessToken", "updatedAt")
     VALUES ($1, $2, $3, now())`,
    id,
    ownerId,
    "v1:not-a-real-envelope",
  );
}

describe("GoogleAuth.userId is NOT NULL in the database (#122)", () => {
  beforeAll(async () => {
    await wipe();
    const user = await prisma.user.create({
      data: {
        provider: "gitlab",
        providerSub: `${SUB_PREFIX}owner`,
        role: UserRole.Member,
        status: UserStatus.Active,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  it("declares the column NOT NULL in information_schema", async () => {
    // The APPLIED half. Reads the live catalogue rather than the schema file so
    // that deleting the migration — or a hand-edited database — fails here
    // instead of only failing the raw-insert test with a confusing message.
    // `table_schema = current_schema()` keeps it correct under the per-worktree
    // `?schema=` the repo uses to share one Postgres between agents.
    const rows = await prisma.$queryRaw<{ is_nullable: string }[]>`
      SELECT "is_nullable"
        FROM "information_schema"."columns"
       WHERE "table_schema" = current_schema()
         AND "table_name" = 'GoogleAuth'
         AND "column_name" = 'userId'
    `;

    // Guard against the vacuous pass: an empty result would make a `toEqual`
    // on a mapped array succeed while proving nothing at all.
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("rejects a raw insert that belongs to nobody", async () => {
    // The BITES half. Postgres raises not_null_violation (23502), whose message
    // names both the column and the relation.
    await expect(insertGoogleAuth(ORPHAN_ID, null)).rejects.toThrow(
      /null value in column "userId" of relation "GoogleAuth"/,
    );

    // And nothing was written — the whole statement rolled back. Counted by
    // primary key rather than by `userId: null`, which the generated types no
    // longer accept as a filter now that the column is non-nullable.
    const survivors = await prisma.googleAuth.count({
      where: { id: ORPHAN_ID },
    });
    expect(survivors).toBe(0);
  });

  it("still accepts a row that names its owner", async () => {
    // The other side of the same statement, so a constraint that rejected
    // everything — or a fixture that could never insert in the first place —
    // cannot be mistaken for a passing test above.
    await expect(insertGoogleAuth(OWNED_ID, userId)).resolves.toBe(1);

    const row = await prisma.googleAuth.findUnique({ where: { userId } });
    expect(row?.id).toBe(OWNED_ID);
  });
});
