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

/** Put the account back to active, undoing whatever the previous case did. */
function reactivate() {
  return prisma.user.update({
    where: { id: USER_ID },
    data: { status: UserStatus.Active, revokedAt: null, purgeAfter: null },
  });
}

describe("#220 a revoked account with a valid cookie (real Postgres)", () => {
  /** The cookie the browser is still holding, signed while the account was live. */
  let ownerToken: string;

  beforeAll(async () => {
    vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
    await wipe();
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
    // Signed ONCE, while the account is still active, and reused by every case
    // below. That is the whole scenario: freezing does not and cannot reach into
    // a cookie the browser already holds, so the token stays cryptographically
    // valid for its full 30 days. Re-signing per test would quietly test
    // something else.
    ownerToken = await signUserSession(
      { kind: "user", userId: USER_ID, wsId: WS_ID },
      SECRET,
    );
    headersMock.mockResolvedValue(new Headers());
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await wipe();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    cookiesMock.mockResolvedValue(jarWith(OWNER_COOKIE, ownerToken));
    await prisma.brainDumpItem.deleteMany({
      where: { workspaceId: { in: [WS_ID, GUEST_WS_ID] } },
    });
  });

  // The control. Without it, every refusal below could just as easily mean the
  // fixture never worked — the "a zero nobody proved" failure the harnesses in
  // this repo guard against everywhere else.
  it("writes normally while the account is active", async () => {
    await reactivate();
    await createBrainDumpItem("something an active account may capture");
    expect(await itemCount(WS_ID)).toBe(1);
  });

  it("refuses the write once the account is frozen, on the very next request", async () => {
    await reactivate();

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
    await reactivate();
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
    await reactivate();
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

    // Rebuild the fixture for whatever runs next: the cascade took the workspace
    // with the user, and `afterAll`'s wipe expects to find both.
    await prisma.workspace.deleteMany({ where: { id: WS_ID } });
    await prisma.user.create({
      data: {
        id: USER_ID,
        provider: "gitlab",
        providerSub: PROVIDER_SUB,
        status: UserStatus.Active,
        workspace: { create: { id: WS_ID, kind: WorkspaceKind.User } },
      },
    });
  });
});
