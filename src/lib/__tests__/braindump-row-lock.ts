/**
 * Arrange the row-lock interleaving that the brain-dump→Task guards exist for.
 *
 * Extracted from `braindump-task-writers.integration.test.ts` when #244 gave the
 * same harness a second caller — the same move `prisma-error-log.ts` made for the
 * same reason, and it lives here rather than beside one action because the
 * property it arranges is cross-cutting: `src/lib/braindump-to-task.ts` names
 * FOUR writers that turn a `BrainDumpItem` into a `Task`, and every one of them
 * has to answer the same question about losing a race.
 *
 * ## Why an arranged interleaving rather than `Promise.all`
 *
 * Firing two calls at once and trusting them to overlap is not a proof. Measured
 * on `braindump-task-writers.integration.test.ts` (#225): the `Promise.all`
 * companion PASSED against the unfixed `ensureFocusStep` and FAILED against the
 * unfixed `startBreakdown` — same file, same pool, same run. A warm connection
 * pool serialises the two often enough that whether the interleaving happens is
 * not something a spec can assume in either direction, so a green from that shape
 * is not evidence and a red from it is not a diagnosis.
 * `reopen-item.integration.test.ts` reached the same conclusion and arranged its
 * interleaving too.
 *
 * ## Why `pg_blocking_pids` and not a count of waiting sessions
 *
 * This Postgres is shared: many worktrees run their integration suites against it
 * on separate schemas, concurrently. A database-wide count of sessions in
 * `wait_event_type = 'Lock'` can therefore be satisfied by somebody else's test
 * entirely — which would release this barrier before the action under test ever
 * reached the lock, and quietly turn the contended spec back into the sequential
 * one it is supposed to be stronger than. Naming the holder's own backend pid is
 * what makes the observation about the caller's own test.
 *
 * ## Why this is a helper and not a `.test.ts`
 *
 * Same as `prisma-error-log.ts`: it is imported BY suites rather than being one.
 * That also puts it in scope for `scoping.harness.test.ts`, which scans every
 * source file whose name does not contain `.test.` — hence the `updateMany` with
 * an explicit `workspaceId` below, where a bare `update({ where: { id } })` would
 * have been enough to take the lock. Explicit is what the harness asks for and it
 * costs nothing: an `UPDATE` takes the row lock either way.
 */

import type { PrismaClient } from "@prisma/client";

/** Is some session other than `holderPid` blocked specifically BY `holderPid`? */
async function isBlockedBy(
  prisma: PrismaClient,
  holderPid: number,
): Promise<boolean> {
  const [row] = await prisma.$queryRaw<{ blocked: bigint }[]>`
    SELECT count(*)::bigint AS blocked
    FROM pg_stat_activity
    WHERE pid <> ${holderPid}
      AND ${holderPid} = ANY(pg_blocking_pids(pid))`;
  return Number(row.blocked) > 0;
}

/**
 * Poll until something has demonstrably blocked on `holderPid`'s row lock, or
 * throw saying exactly that.
 *
 * The throw matters as much as the wait. A block that never appears means the
 * action under test took no lock at all, and the spec has to say so rather than
 * fall through and assert something weaker that happens to pass.
 */
async function waitUntilBlockedBy(
  prisma: PrismaClient,
  holderPid: number,
): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await isBlockedBy(prisma, holderPid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `nothing ever blocked on pid ${holderPid}'s row lock — the action under ` +
      "test did not take one, so this spec cannot prove the loser adopts",
  );
}

/** What the caller must tell the barrier about the row it is holding. */
export interface LockedItemOptions {
  /** The `BrainDumpItem` whose row is held locked. */
  itemId: string;
  /** The workspace both the winning `Task` and the item belong to. */
  workspaceId: string;
  /** Title for the winning `Task`. Defaults to the item text the suites seed. */
  title?: string;
}

/**
 * Run `act` while `itemId`'s row is held locked by a transaction that has already
 * given it a `Task`, releasing the lock only once `act` has demonstrably blocked
 * on it.
 *
 * Against a guarded write the action reaches its `UPDATE`, blocks, and when it
 * unblocks Postgres re-evaluates the statement against the COMMITTED row — a
 * `taskId: null` term in the `where` no longer holds, it matches zero rows, and
 * that is how the loser learns it lost, deterministically rather than by
 * comparing two reads. Against an unlocked check-then-act the same arrangement is
 * a deterministic FAILURE instead: the decision was made on a snapshot taken
 * before the winner committed, so the loser creates a second `Task` and repoints
 * the item at it.
 *
 * @param prisma A client dedicated to the suite — NOT the singleton the action
 *   under test uses, or the barrier's own queries contend with it.
 * @returns the winner's task id, so the caller can assert the loser adopted it.
 */
export async function whileItemRowIsLockedWithATask<T>(
  prisma: PrismaClient,
  { itemId, workspaceId, title = "Water the plants" }: LockedItemOptions,
  act: () => Promise<T>,
): Promise<{ winner: string; result: T }> {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let announceLocked = () => {};
  const locked = new Promise<void>((resolve) => (announceLocked = resolve));
  let winner = "";

  let holderPid = 0;
  const holder = prisma.$transaction(
    async (tx) => {
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`
        SELECT pg_backend_pid() AS pid`;
      holderPid = pid;
      const task = await tx.task.create({ data: { title, workspaceId } });
      winner = task.id;
      // Takes the row lock this barrier is about, and gives the row the `taskId`
      // the loser has to come back and read.
      await tx.brainDumpItem.updateMany({
        where: { id: itemId, workspaceId },
        data: { taskId: task.id },
      });
      announceLocked();
      await held;
    },
    // Generous: the timeout has to outlast the poll above, and a transaction that
    // timed out here would look like the defect rather than like a slow machine.
    { timeout: 30_000, maxWait: 30_000 },
  );

  await locked;
  const running = act();
  try {
    await waitUntilBlockedBy(prisma, holderPid);
  } finally {
    // Always, even when the barrier never fired. Skipping it on the throw path
    // would leave this transaction holding the row lock until its own 30 s
    // timeout — on a database many worktrees share — and the diagnostic would
    // arrive as somebody else's mysterious hang rather than as the caller's own
    // assertion.
    release();
    await holder;
  }
  return { winner, result: await running };
}
