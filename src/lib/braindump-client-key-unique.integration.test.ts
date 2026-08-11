/**
 * #175 — behavioural proof that `BrainDumpItem_workspaceId_clientKey_key` is
 * enforced by Postgres, not merely intended by the route.
 *
 * The offline capture queue replays a capture whose write may already have
 * landed: `withActionTimeout` bounds how long the UI waits, **not the request**
 * (see its docblock in `src/lib/server-action-failure.ts`), so on a mobile
 * connection a write that times out at 10s and lands at 14s is ordinary. Every
 * automatic flush would duplicate it. `clientKey` under a unique index is what
 * makes the replay safe, and it also fixes the late-write duplicate #210
 * recorded as its own residual.
 *
 * ⚠️ **Not registered in `enum-constraint-sync.integration.test.ts`.** That file
 * polices CHECK constraints and pseudo-enum/range/length registries; a unique
 * index is none of those. The spec's first draft said otherwise and was wrong.
 * The pattern this follows is `step-est-minutes-check.integration.test.ts` and
 * `notes-length-check.integration.test.ts`: a dedicated file that proves the
 * constraint BITES.
 *
 * Three properties, and the second and third are the ones a naive index gets
 * wrong:
 *
 *  1. the same `clientKey` twice in one workspace is REJECTED
 *  2. the same `clientKey` in two DIFFERENT workspaces is ALLOWED — the key is
 *     client-generated, so it is only ever unique per tenant, and a global
 *     unique index would let one workspace's key collide with another's and
 *     leak the existence of a row across the tenancy boundary
 *  3. MANY NULL `clientKey`s coexist — Postgres treats NULLs as distinct in a
 *     unique index, which is what lets every ordinary non-queued capture (and
 *     every row that predates this migration) leave the column empty
 *
 * Needs the real Postgres (CI wires up a service DB and runs
 * `prisma migrate deploy` first; locally it uses your DATABASE_URL schema —
 * vitest does NOT read .env):
 *   set -a; . ./.env; set +a; npm test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { WorkspaceKind } from "@/lib/constants";

// Dedicated client + never-reused workspace ids, wiped before and after — same
// isolation approach as the sibling constraint tests, so $disconnect() here
// cannot tear the connection out from under them.
const prisma = new PrismaClient();
const WS_A = "test-175-clientkey-ws-a";
const WS_B = "test-175-clientkey-ws-b";

async function wipe() {
  await prisma.brainDumpItem.deleteMany({
    where: { workspaceId: { in: [WS_A, WS_B] } },
  });
  await prisma.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B] } } });
}

beforeAll(async () => {
  await wipe();
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.create({
      data: { id, kind: WorkspaceKind.User },
    });
  }
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("BrainDumpItem clientKey uniqueness (#175)", () => {
  it("the unique index exists on (workspaceId, clientKey)", async () => {
    const rows = await prisma.$queryRaw<
      { indexdef: string }[]
    >`SELECT indexdef FROM pg_indexes
        WHERE tablename = 'BrainDumpItem'
          AND indexdef ILIKE '%UNIQUE%'
          AND indexdef ILIKE '%clientKey%'`;

    expect(rows).toHaveLength(1);
    // Both columns, so a global-unique index cannot pass this by accident.
    expect(rows[0].indexdef).toMatch(/workspaceId/);
    expect(rows[0].indexdef).toMatch(/clientKey/);
  });

  it("REJECTS the same clientKey twice in one workspace", async () => {
    await prisma.brainDumpItem.create({
      data: { text: "ring mum", workspaceId: WS_A, clientKey: "dup-key" },
    });

    await expect(
      prisma.brainDumpItem.create({
        data: { text: "ring mum", workspaceId: WS_A, clientKey: "dup-key" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    expect(
      await prisma.brainDumpItem.count({
        where: { workspaceId: WS_A, clientKey: "dup-key" },
      }),
    ).toBe(1);
  });

  it("ALLOWS the same clientKey in a different workspace", async () => {
    // The key is generated on the client, so two devices in two workspaces can
    // legitimately mint the same one. A global unique index would refuse this
    // and, worse, would tell one tenant that another tenant holds that key.
    await prisma.brainDumpItem.create({
      data: { text: "shared key", workspaceId: WS_A, clientKey: "cross-ws" },
    });
    await prisma.brainDumpItem.create({
      data: { text: "shared key", workspaceId: WS_B, clientKey: "cross-ws" },
    });

    expect(
      await prisma.brainDumpItem.count({ where: { clientKey: "cross-ws" } }),
    ).toBe(2);
  });

  it("ALLOWS many null clientKeys in the same workspace", async () => {
    // Every ordinary capture and every pre-migration row leaves this null.
    // Postgres treats nulls as distinct in a unique index; if that ever stopped
    // being true, the second insert here would fail and the whole app would
    // break on its second capture.
    for (const text of ["one", "two", "three"]) {
      await prisma.brainDumpItem.create({
        data: { text, workspaceId: WS_A },
      });
    }

    expect(
      await prisma.brainDumpItem.count({
        where: { workspaceId: WS_A, clientKey: null },
      }),
    ).toBe(3);
  });

  it("clientKey is nullable, so the migration cannot break existing rows", async () => {
    const rows = await prisma.$queryRaw<
      { is_nullable: string }[]
    >`SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'BrainDumpItem' AND column_name = 'clientKey'`;

    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe("YES");
  });
});
