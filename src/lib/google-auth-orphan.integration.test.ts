/**
 * #118 Phase C — the credential table after the orphan purge, and the
 * `User_llmProvider_check` constraint that rides along with it.
 *
 * Three properties, none of which was true before this migration:
 *
 *  1. No `userId IS NULL` row survives. The pre-Phase-C singleton held real
 *     encrypted refresh tokens for the whole instance; the moment reads key on
 *     `userId` it becomes unreachable AND uncascadable, so it is destroyed
 *     rather than kept as a credential nobody can revoke.
 *  2. Deleting the User cascades the credential away. That was only ever true
 *     for a row WITH a userId — the FK cascades FROM User, and a NULL userId
 *     never reaches one.
 *  3. `User.llmProvider` can only name an adapter that exists. Phase C makes
 *     `llmKeyEnc` writable, which makes this column load-bearing for the first
 *     time: `user-quota.ts` hands it to `getLLM()`, which picks an ADAPTER from
 *     it and silently falls back for anything unrecognised.
 *
 * `enum-constraint-sync.integration.test.ts` polices that the constraint is
 * APPLIED and mirrors `LlmProvider`. This file proves it BITES, and that the
 * purge left nothing behind.
 *
 * Needs the real Postgres (CI wires up a service DB and runs
 * `prisma migrate deploy` first; locally vitest.config.ts forwards
 * DATABASE_URL from your .env).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { LlmProvider, UserRole, UserStatus } from "@/lib/constants";

// Dedicated client + a unique, never-reused providerSub prefix, wiped before and
// after — the isolation approach every *.integration.test.ts here uses, so
// $disconnect() cannot tear the connection out from under a sibling suite.
const prisma = new PrismaClient();
const SUB_PREFIX = "test-118-orphan-";

async function wipe() {
  // GoogleAuth rows cascade from User, so deleting the fixture accounts is
  // enough — which is the property the second test below is about.
  await prisma.user.deleteMany({
    where: { providerSub: { startsWith: SUB_PREFIX } },
  });
  await prisma.$executeRawUnsafe(
    `DELETE FROM "User" WHERE "id" = 'test-118-bad-provider'`,
  );
}

function makeUser(suffix: string, llmProvider?: string | null) {
  return prisma.user.create({
    data: {
      provider: "gitlab",
      providerSub: `${SUB_PREFIX}${suffix}`,
      role: UserRole.Member,
      status: UserStatus.Active,
      ...(llmProvider !== undefined ? { llmProvider } : {}),
    },
  });
}

describe("GoogleAuth after the orphan purge (#118)", () => {
  beforeAll(wipe);
  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  it("holds no credential that belongs to nobody", async () => {
    // The row the migration destroys. It is production this matters for — a dev
    // database may never have held one — but the assertion is what stops a
    // future writer re-introducing an unowned credential and nobody noticing.
    const orphans = await prisma.googleAuth.count({ where: { userId: null } });
    expect(orphans).toBe(0);
  });

  it("cascades a credential away with its user", async () => {
    const user = await makeUser("cascade");
    await prisma.googleAuth.create({
      data: { userId: user.id, accessToken: "v1:not-a-real-envelope" },
    });
    expect(await prisma.googleAuth.count({ where: { userId: user.id } })).toBe(
      1,
    );

    await prisma.user.delete({ where: { id: user.id } });

    // No credential outlives the account it belongs to. Before Phase C the one
    // row in this table had a NULL userId, so deleting every account would have
    // left it sitting there holding a live refresh token.
    expect(await prisma.googleAuth.count({ where: { userId: user.id } })).toBe(
      0,
    );
  });
});

describe("User.llmProvider CHECK constraint (#118)", () => {
  beforeAll(wipe);
  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  it("accepts every adapter id, and NULL for the instance default", async () => {
    for (const [i, p] of [...Object.values(LlmProvider), null].entries()) {
      const user = await makeUser(`accept-${i}`, p);
      expect(user.llmProvider).toBe(p);
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it("rejects a provider no adapter can serve", async () => {
    // Raw SQL on purpose: nothing in the app writes this column through the
    // client, so a raw insert is the closest thing to "a future writer that
    // forgot" — and getLLM() falls back to LLM_PROVIDER for an unknown value,
    // so a bad row is not a crash. It is a user billed to their own key against
    // the wrong vendor's endpoint. The database is where that stops.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "User" ("id","provider","providerSub","role","status","aiPolicy","aiQuota","llmProvider","createdAt","lastSeenAt")
         VALUES ($1,'gitlab',$2,'member','active','capped',50,'gpt-cheapest',now(),now())`,
        "test-118-bad-provider",
        `${SUB_PREFIX}bad-provider`,
      ),
    ).rejects.toThrow(/User_llmProvider_check/);

    // And nothing was written — the whole statement rolled back.
    expect(
      await prisma.user.count({ where: { id: "test-118-bad-provider" } }),
    ).toBe(0);
  });
});
