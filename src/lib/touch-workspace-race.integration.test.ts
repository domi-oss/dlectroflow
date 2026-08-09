/**
 * #220 — `touchWorkspace` must stay a SINGLE atomic statement.
 *
 * Every page render, every server action and every route handler in the app
 * calls this, and a fresh guest sandbox's very first navigation fires several of
 * them at once for a workspace id that does not exist yet. So the upsert is
 * racing itself constantly, and it is only safe because Prisma compiles it to
 * one `INSERT ... ON CONFLICT DO UPDATE`.
 *
 * **Prisma silently gives that up when the query shape stops qualifying.** The
 * first attempt at #220 read the owner's status through a nested relation
 * `select` on this upsert, reasoning that a column on a query already being
 * issued is free. It is not: the relation select disqualifies the native upsert,
 * Prisma falls back to read-then-write, and the race comes straight back — every
 * loser of it raising P2002. It cost nothing in a sequential unit test, nothing
 * in a sequential integration test, and took down every guest page in e2e, where
 * requests actually overlap.
 *
 * Hence a test that overlaps them on purpose. It is the only shape that can see
 * this, and the property it protects — one statement, no read-then-write — is
 * invisible to every other test in the suite.
 */

import { describe, it, expect, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { touchWorkspace } from "@/lib/workspace";
import { WorkspaceKind } from "@/lib/constants";

const prisma = new PrismaClient();

/** How many overlapping first-sightings to force. A guest's first navigation
 *  produces the shell plus the page plus its data reads; eight is comfortably
 *  above that and still fast. */
const CONCURRENCY = 8;

const IDS: string[] = [];

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: IDS } } });
  await prisma.$disconnect();
});

/** A workspace id no run has used before, registered for teardown. */
function freshId(tag: string): string {
  const id = `test-220-race-${tag}-${crypto.randomUUID()}`;
  IDS.push(id);
  return id;
}

describe("#220 touchWorkspace under concurrent first-sighting", () => {
  it("creates a brand-new guest sandbox exactly once, with no loser", async () => {
    const id = freshId("guest");
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () =>
        touchWorkspace(id, WorkspaceKind.Guest),
      ),
    );

    // Named rather than counted, so a failure says WHICH error — a bare count
    // would report "1 !== 0" for a P2002 and for a dropped connection alike.
    const failures = results
      .filter((r) => r.status === "rejected")
      .map((r) => String((r as PromiseRejectedResult).reason).slice(0, 200));
    expect(failures).toEqual([]);
    expect(await prisma.workspace.count({ where: { id } })).toBe(1);
  });

  it("does the same for a user workspace, which takes the other branch", async () => {
    // The TTL branch differs between the two kinds, and a future change could
    // qualify one shape for the native upsert and not the other.
    const id = freshId("user");
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () =>
        touchWorkspace(id, WorkspaceKind.User),
      ),
    );
    const failures = results
      .filter((r) => r.status === "rejected")
      .map((r) => String((r as PromiseRejectedResult).reason).slice(0, 200));
    expect(failures).toEqual([]);
    expect(await prisma.workspace.count({ where: { id } })).toBe(1);
  });
});
