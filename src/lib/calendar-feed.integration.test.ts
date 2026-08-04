import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { UserStatus } from "@/lib/constants";
import {
  buildFeedIcs,
  createOwnFeed,
  disableOwnFeed,
  getOwnFeed,
  regenerateOwnFeed,
  resolveFeed,
  FEED_PAST_WINDOW_DAYS,
} from "./calendar-feed";

/**
 * #154 — the security tests for the calendar subscription feed, against real
 * Postgres.
 *
 * A capability URL is a credential that travels through third parties, so the
 * three properties it rests on are proved rather than argued:
 *
 *  1. **One account's token never reaches another account's content.** Same
 *     class of bug as #21, and the reason #129's export got the same treatment.
 *  2. **Regenerating invalidates the old token immediately** — not on a
 *     schedule, not at the next expiry.
 *  3. **A revoked account's feed stops serving**, because #153 freezes an
 *     account rather than deleting it, so the row survives.
 *
 * Every negative assertion has a control that must SEE the content, so a fixture
 * that silently failed to write cannot make the test pass vacuously.
 *
 * Verified to bite, each rule against the change that would break it:
 *  - Delete `where: { workspaceId }` from `buildFeedIcs` → "one account's feed
 *    never contains another account's step text" fails, reporting the leak.
 *  - Change `regenerateOwnFeed`'s `update` to `{ rotatedAt: new Date() }` → "the
 *    old token stops resolving the instant a new one is minted" fails.
 *  - Delete the `status` check from `resolveFeed` → "a revoked account's feed
 *    stops resolving" fails.
 *
 * Needs the real Postgres (CI wires up a service DB and runs `prisma migrate
 * deploy` first; locally `vitest.config.ts` forwards DATABASE_URL from `.env`).
 */

const SUB_PREFIX = "test-154-feed-";
const WS_A = "test-154-feed-ws-a";
const WS_B = "test-154-feed-ws-b";

/** Distinctive on purpose — a substring search for "task" would match the
 *  calendar's own scaffolding. */
const A_STEP = "aardvark-private-feed-step";
const A_TASK = "aardvark-private-feed-task";
const B_STEP = "bandicoot-private-feed-step";

let userA = "";
let userB = "";
let userRevoked = "";

async function wipe() {
  await prisma.task.deleteMany({
    where: { workspaceId: { in: [WS_A, WS_B] } },
  });
  await prisma.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B] } } });
  // CalendarFeed cascades from User, so deleting the accounts takes the feeds.
  await prisma.user.deleteMany({
    where: { providerSub: { startsWith: SUB_PREFIX } },
  });
}

async function makeAccount(sub: string, workspaceId: string, status: string) {
  const user = await prisma.user.create({
    data: { provider: "gitlab", providerSub: `${SUB_PREFIX}${sub}`, status },
  });
  await prisma.workspace.create({
    data: { id: workspaceId, kind: "user", userId: user.id },
  });
  return user.id;
}

beforeAll(async () => {
  await wipe();

  userA = await makeAccount("a", WS_A, UserStatus.Active);
  userB = await makeAccount("b", WS_B, UserStatus.Active);
  // A revoked account needs a workspace too, so the test proves the STATUS check
  // refuses it rather than the missing-workspace branch.
  userRevoked = await makeAccount(
    "revoked",
    "test-154-feed-ws-revoked",
    UserStatus.Revoked,
  );

  const taskA = await prisma.task.create({
    data: { title: A_TASK, workspaceId: WS_A },
  });
  await prisma.step.create({
    data: {
      taskId: taskA.id,
      text: A_STEP,
      order: 1,
      total: 1,
      estMinutes: 20,
      scheduledAt: new Date(),
    },
  });

  const taskB = await prisma.task.create({
    data: { title: "bandicoot-private-feed-task", workspaceId: WS_B },
  });
  await prisma.step.create({
    data: {
      taskId: taskB.id,
      text: B_STEP,
      order: 1,
      total: 1,
      estMinutes: 20,
      scheduledAt: new Date(),
    },
  });
});

afterAll(async () => {
  await prisma.workspace.deleteMany({
    where: { id: "test-154-feed-ws-revoked" },
  });
  await wipe();
});

describe("the feed token's lifecycle (#154)", () => {
  it("an account starts with no feed", async () => {
    expect(await getOwnFeed(userA)).toBeNull();
  });

  it("creating one mints a token that resolves to that account's workspace", async () => {
    const { token } = await createOwnFeed(userA);
    expect(await resolveFeed(token)).toEqual({
      userId: userA,
      workspaceId: WS_A,
    });
  });

  it("creating again is idempotent — a double-click never revokes a live URL", async () => {
    const first = await getOwnFeed(userA);
    const second = await createOwnFeed(userA);
    expect(second.token).toBe(first?.token);
  });

  it("the old token stops resolving the instant a new one is minted", async () => {
    const before = (await getOwnFeed(userA))!.token;
    const after = (await regenerateOwnFeed(userA)).token;

    expect(after).not.toBe(before);
    // The control: the NEW token works, so a null on the old one cannot be a
    // broken fixture reporting a passing revocation.
    expect(await resolveFeed(after)).toEqual({
      userId: userA,
      workspaceId: WS_A,
    });
    expect(await resolveFeed(before)).toBeNull();
  });

  it("records the rotation, so an incident can ask when the credential last changed", async () => {
    const row = await prisma.calendarFeed.findUnique({
      where: { userId: userA },
      select: { rotatedAt: true },
    });
    expect(row?.rotatedAt).toBeInstanceOf(Date);
  });

  it("turning the feed off stops the token resolving, and is safe to repeat", async () => {
    const token = (await getOwnFeed(userA))!.token;
    await disableOwnFeed(userA);

    expect(await getOwnFeed(userA)).toBeNull();
    expect(await resolveFeed(token)).toBeNull();
    // Turning off a feed that is already off is a no-op, not a thrown
    // RecordNotFound.
    await expect(disableOwnFeed(userA)).resolves.toBeUndefined();
  });

  it("refuses a token that is not even token-shaped, without a query", async () => {
    for (const probe of ["", "../../etc/passwd", "short", "x".repeat(200)]) {
      expect(await resolveFeed(probe)).toBeNull();
    }
  });

  it("refuses a well-shaped token that belongs to nobody", async () => {
    expect(await resolveFeed("z".repeat(43))).toBeNull();
  });
});

describe("cross-account isolation — the calendar feed (#154)", () => {
  it("one account's feed never contains another account's step text", async () => {
    const { token } = await createOwnFeed(userB);
    const resolved = await resolveFeed(token);
    expect(resolved).not.toBeNull();

    const ics = await buildFeedIcs({ workspaceId: resolved!.workspaceId });

    // Control first: B's own content IS in B's feed, so the negative below
    // cannot pass because nothing was written.
    expect(ics).toContain(B_STEP);
    expect(ics).not.toContain(A_STEP);
    expect(ics).not.toContain(A_TASK);
  });

  it("a revoked account's feed stops resolving, though the row survives the freeze", async () => {
    const { token } = await createOwnFeed(userRevoked);
    // The control: the row is really there, so a null resolve is the status
    // check refusing it rather than a fixture that never wrote.
    expect(await getOwnFeed(userRevoked)).not.toBeNull();
    expect(await resolveFeed(token)).toBeNull();
  });

  it("deleting an account destroys its feed with it", async () => {
    const doomed = await makeAccount(
      "doomed",
      "test-154-feed-ws-doomed",
      UserStatus.Active,
    );
    const { token } = await createOwnFeed(doomed);
    expect(await resolveFeed(token)).not.toBeNull();

    await prisma.user.delete({ where: { id: doomed } });

    expect(await resolveFeed(token)).toBeNull();
    expect(
      await prisma.calendarFeed.findUnique({
        where: { userId: doomed },
        select: { token: true },
      }),
    ).toBeNull();
  });
});

describe("what the feed body carries (#154)", () => {
  it("carries titles and times, and no other column of the row", async () => {
    const ics = await buildFeedIcs({ workspaceId: WS_A });
    expect(ics).toContain(A_STEP);
    // The row's other columns are never selected, so they cannot appear. Proved
    // on the one that would be most alarming: the step's own database id is in
    // the UID by design, but nothing carries a workspace id.
    expect(ics).not.toContain(WS_A);
  });

  it("drops work that finished before the past window opens", async () => {
    const stale = await prisma.task.create({
      data: { title: "stale-feed-task", workspaceId: WS_A },
    });
    await prisma.step.create({
      data: {
        taskId: stale.id,
        text: "stale-private-feed-step",
        order: 1,
        total: 1,
        estMinutes: 20,
        scheduledAt: new Date(
          Date.now() - (FEED_PAST_WINDOW_DAYS + 1) * 24 * 3600_000,
        ),
      },
    });

    const ics = await buildFeedIcs({ workspaceId: WS_A });
    // Control: today's step is still there, so the absence below is the window
    // and not an empty read.
    expect(ics).toContain(A_STEP);
    expect(ics).not.toContain("stale-private-feed-step");
  });
});
