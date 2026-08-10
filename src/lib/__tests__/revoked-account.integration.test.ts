/**
 * #220 — a frozen account holding a valid cookie must not be able to write.
 *
 * This is an END-TO-END proof against real Postgres, and it is deliberately not
 * a unit test of `currentWorkspaceId()`. The bug was never that any single
 * function was wrong in isolation: `freezeAccount` set `status: revoked`
 * correctly, `currentUser()` refused the account correctly, and every server
 * action resolved its workspace correctly. The hole was in the SEAM — the write
 * path resolves through `currentWorkspaceId()`, which read the signed token and
 * stopped, so a revoked account kept writing while the People panel rendered it
 * as "Revoked".
 *
 * A test that mocks `@/lib/workspace` (as most action tests do, and rightly)
 * cannot see that seam at all, which is why this one mocks nothing below
 * `next/headers`: real session signing, the real resolver, the real Prisma
 * client, and a real `freezeAccount`. The only things stubbed are the two
 * request-context APIs that have no meaning outside a Next.js request.
 *
 * Isolation follows `delete-braindump-item.integration.test.ts`: a dedicated
 * PrismaClient for setup and teardown so this file's own queries can never
 * interfere with the shared `@/lib/db` singleton the code under test uses, plus
 * ids unique to this file, wiped either side.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { PrismaClient } from "@prisma/client";

const SECRET = "test-secret-at-least-32-bytes-long-xxxxx";

const { cookiesMock, headersMock } = vi.hoisted(() => ({
  cookiesMock: vi.fn(),
  headersMock: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: cookiesMock, headers: headersMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createBrainDumpItem } from "@/app/actions/braindump";
import { freezeAccount } from "@/lib/account-lifecycle";
import { RevokedAccountError } from "@/lib/workspace";
import {
  GUEST_COOKIE,
  OWNER_COOKIE,
  signGuestSession,
  signUserSession,
} from "@/lib/auth/session";
import { UserStatus, WorkspaceKind } from "@/lib/constants";

// Dedicated client, not the `@/lib/db` singleton the action under test uses.
const prisma = new PrismaClient();

/** Ids unique to this file, so a parallel suite can never collide with it. */
const USER_ID = "test-220-revoked-user";
const WS_ID = "test-220-revoked-ws";
const GUEST_WS_ID = "test-220-guest-ws";
const PROVIDER_SUB = "test-220-subject";

async function wipe() {
  await prisma.brainDumpItem.deleteMany({
    where: { workspaceId: { in: [WS_ID, GUEST_WS_ID] } },
  });
  await prisma.workspace.deleteMany({
    where: { id: { in: [WS_ID, GUEST_WS_ID] } },
  });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
}

/** A signed owner session, plus the `delete` a Server Function's jar exposes. */
function jarWith(cookie: string, token: string) {
  return {
    get: (name: string) => (name === cookie ? { value: token } : undefined),
    delete: vi.fn(),
  };
}

/** Items in a workspace — the thing a refused write must not move. */
function itemCount(workspaceId: string) {
  return prisma.brainDumpItem.count({ where: { workspaceId } });
}

/**
 * The state every case is entitled to find: the account exists, is active, and
 * owns an empty workspace.
 *
 * Built fresh rather than repaired, because two of the cases below do not leave
 * an account to repair — the deleted-outright one removes the row and lets the
 * cascade take the workspace with it.
 */
async function createFixture() {
  await prisma.user.create({
    data: {
      id: USER_ID,
      provider: "gitlab",
      providerSub: PROVIDER_SUB,
      handle: "frozen-person",
      status: UserStatus.Active,
      workspace: { create: { id: WS_ID, kind: WorkspaceKind.User } },
    },
  });
}

/**
 * Leave the fixture in the worst state any case here can leave it — on purpose,
 * unconditionally, after every case and before the first (!305 review round 2).
 *
 * Without this, `beforeEach` restoring the fixture is not observable by anything
 * in the file. Every case is handed a rebuild, so "the fixture is intact" is
 * true no matter how the restore is written, and the canary at the foot of the
 * file asserted it anyway — a check whose subject was constructed one line
 * earlier. Proven rather than argued: degrading `beforeEach` to a repair that
 * restores `status` but never `handle`, which is precisely the defect the first
 * review round found, left all seven cases green.
 *
 * Damaging the fixture deliberately is what turns that assertion back into a
 * question. Each of the three things the canary reads is broken here in a
 * different way, so a restore that misses any one of them is caught by name:
 *
 *  - `status` revoked — what the guest case leaves behind.
 *  - `handle` null — what the deleted-outright case's hand-written rebuild left
 *    behind, and the half no other case in this file reads, which is why a
 *    restore that forgot it stayed silent.
 *  - a stray item in the workspace — what the active-write case leaves behind.
 *
 * Upserted rather than updated, so the row EXISTS and is wrong. A case that
 * deletes the account outright would otherwise hand the next restore an absent
 * row, and "rebuild when there is nothing there" is the one branch a partial
 * restore gets right by accident. This is also why it runs in `beforeAll`: with
 * the damage in place before the first case, no assertion here depends on run
 * order, so `--sequence.shuffle` and a single `-t` filter both mean the same
 * thing as the whole file.
 */
async function damageFixture() {
  await prisma.user.upsert({
    where: { id: USER_ID },
    create: {
      id: USER_ID,
      provider: "gitlab",
      providerSub: PROVIDER_SUB,
      handle: null,
      status: UserStatus.Revoked,
    },
    update: { handle: null, status: UserStatus.Revoked },
  });
  await prisma.workspace.upsert({
    where: { id: WS_ID },
    create: { id: WS_ID, kind: WorkspaceKind.User, userId: USER_ID },
    update: { kind: WorkspaceKind.User, userId: USER_ID },
  });
  await prisma.brainDumpItem.create({
    data: {
      workspaceId: WS_ID,
      text: "residue the next case must not inherit",
    },
  });
}

describe("#220 a revoked account with a valid cookie (real Postgres)", () => {
  /** The cookie the browser is still holding, signed while the account was live. */
  let ownerToken: string;

  beforeAll(async () => {
    vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
    // Signed ONCE, and reused by every case below rather than re-signed per
    // test. That is the whole scenario: freezing does not and cannot reach into
    // a cookie the browser already holds, so the token stays cryptographically
    // valid for its full 30 days. It survives `beforeEach` rebuilding the
    // account because a session token carries no status — only the ids, and
    // those are stable.
    ownerToken = await signUserSession(
      { kind: "user", userId: USER_ID, wsId: WS_ID },
      SECRET,
    );
    headersMock.mockResolvedValue(new Headers());
    // The first case is entitled to the same proof as every later one, so it
    // starts from damage too rather than from whatever the database happened to
    // hold. See {@link damageFixture}.
    await damageFixture();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await wipe();
    await prisma.$disconnect();
  });

  /**
   * A full teardown and rebuild per case, not a per-case repair (!305 review).
   *
   * Every case here mutates the one shared account — that IS the subject — so
   * "who puts it back" has to be answered once, here, rather than by each case
   * remembering. It was previously answered by each case calling `reactivate()`
   * on the way IN, which reads as isolation but is not: a case's precondition
   * was still whatever its predecessor happened to leave, and two of them left
   * something. The guest case revoked the account and never restored it, and
   * the deleted-outright case rebuilt a row without its `handle`.
   *
   * Rebuilding costs four statements against a local database and buys an
   * ordering the suite does not depend on — so `--sequence.shuffle`, a split
   * into concurrent blocks, or a case inserted in the middle next year are all
   * non-events instead of silent corruption.
   *
   * A full rebuild rather than a repair is also what {@link damageFixture} makes
   * checkable: it is handed a row that exists and is wrong on all three counts,
   * which no repair short of a rebuild puts right.
   */
  beforeEach(async () => {
    cookiesMock.mockResolvedValue(jarWith(OWNER_COOKIE, ownerToken));
    await wipe();
    await createFixture();
  });

  /** @see damageFixture — the restore above is only observable if this runs. */
  afterEach(damageFixture);

  // The control. Without it, every refusal below could just as easily mean the
  // fixture never worked — the "a zero nobody proved" failure the harnesses in
  // this repo guard against everywhere else.
  it("writes normally while the account is active", async () => {
    await createBrainDumpItem("something an active account may capture");
    expect(await itemCount(WS_ID)).toBe(1);
  });

  it("refuses the write once the account is frozen, on the very next request", async () => {
    // The real thing, not a hand-written UPDATE: this is what `revokePerson`
    // calls, so the promise under test is the one `freezeAccount`'s own doc
    // comment makes.
    expect(await freezeAccount(USER_ID)).toBe(true);

    await expect(
      createBrainDumpItem("a write a frozen account must not get"),
    ).rejects.toThrow(RevokedAccountError);
    expect(await itemCount(WS_ID)).toBe(0);
  });

  it("signs the frozen account out rather than only refusing it", async () => {
    const jar = jarWith(OWNER_COOKIE, ownerToken);
    cookiesMock.mockResolvedValue(jar);
    await freezeAccount(USER_ID);

    await expect(createBrainDumpItem("nope")).rejects.toThrow();
    // A Server Function's cookie jar is writable, so the sign-out lands here and
    // the next request arrives as an ordinary guest instead of failing forever
    // behind a cookie with 30 days left on it.
    expect(jar.delete).toHaveBeenCalledWith(OWNER_COOKIE);
  });

  it("still refuses when the jar is read-only, as it is in a page render", async () => {
    // Next 16 seals the cookie jar during Server Component rendering, so
    // `.delete` throws. Signing somebody out is best-effort; refusing them is
    // not — the throw must survive the attempt failing.
    cookiesMock.mockResolvedValue({
      get: (name: string) =>
        name === OWNER_COOKIE ? { value: ownerToken } : undefined,
      delete: () => {
        throw new Error(
          "Cookies can only be modified in a Server Action or Route Handler.",
        );
      },
    });
    await freezeAccount(USER_ID);

    await expect(createBrainDumpItem("nope")).rejects.toThrow(
      RevokedAccountError,
    );
    expect(await itemCount(WS_ID)).toBe(0);
  });

  // #220's second requirement: the guest and header branches have no `User` row
  // to have a status, and must not have been collateral damage.
  it("leaves a guest sandbox writing exactly as before", async () => {
    // Revoked as this case's OWN precondition — a frozen account existing in
    // the database at the same time is the situation being ruled out, so it has
    // to be set here rather than inherited. `beforeEach` is what puts it back.
    await prisma.user.update({
      where: { id: USER_ID },
      data: { status: UserStatus.Revoked },
    });
    const guestToken = await signGuestSession(GUEST_WS_ID, SECRET, 3600);
    cookiesMock.mockResolvedValue(jarWith(GUEST_COOKIE, guestToken));

    await createBrainDumpItem("a guest capture");
    expect(await itemCount(GUEST_WS_ID)).toBe(1);
  });

  // Adjacent to the freeze and closed by the same check: #153's flow deletes the
  // account after the grace window, and the cascade takes the workspace with it.
  // Before #220 that cookie resolved to a workspace id `touchWorkspace` happily
  // re-created — an ownerless workspace a deleted account could keep writing to.
  it("refuses a cookie whose account has been deleted outright", async () => {
    await prisma.brainDumpItem.deleteMany({ where: { workspaceId: WS_ID } });
    await prisma.user.delete({ where: { id: USER_ID } });

    await expect(createBrainDumpItem("nope")).rejects.toThrow(
      RevokedAccountError,
    );
    expect(await itemCount(WS_ID)).toBe(0);
  });

  /**
   * The canary for `beforeEach` — and the second review round on !305 is the
   * reason it is worth reading twice.
   *
   * The first round wrote it as "declared last, so it inherits whatever the
   * mutating cases left". That stopped being true in the same commit that
   * introduced it: the fix for the ordering leak was to make `beforeEach` wipe
   * and rebuild unconditionally, so from then on this case read a fixture
   * constructed microseconds earlier, could not fail for the reason its own
   * comment gave, and said so in prose anyway. The same shape as #220 itself —
   * a comment promising a check the code does not make — which is a poor thing
   * to leave in the file that closes it.
   *
   * What makes the assertions real is {@link damageFixture}, not their
   * position: the row this reads is deliberately broken before every case, so
   * each line below now names a distinct way the restore can be incomplete, and
   * the `handle` line names the one no other case in this file would notice.
   * Position is now irrelevant, which is the point — it holds under
   * `--sequence.shuffle` and under a single `-t` filter alike.
   *
   * Demonstrated, not asserted: degrade `beforeEach` to a repair that restores
   * `status` and not `handle` and this case fails with `null` where
   * `'frozen-person'` was expected, while the other six stay green. Against the
   * version of this comment that claimed declaration order was the mechanism,
   * the very same degradation left all seven green.
   */
  it("is handed a rebuilt fixture, not the damaged one every case leaves", async () => {
    const owner = await prisma.user.findUnique({
      where: { id: USER_ID },
      select: { status: true, handle: true },
    });
    // Each line is a different failure of the restore: a row that was never
    // rebuilt, a rebuild that dropped a column, and a wipe that did not run.
    expect(owner?.status).toBe(UserStatus.Active);
    expect(owner?.handle).toBe("frozen-person");
    expect(await itemCount(WS_ID)).toBe(0);
  });
});
