import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

const {
  cookiesMock,
  userFindUniqueMock,
  workspaceUpsertMock,
  deleteCookieMock,
} = vi.hoisted(() => ({
  cookiesMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  workspaceUpsertMock: vi.fn(),
  deleteCookieMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: userFindUniqueMock },
    workspace: { upsert: workspaceUpsertMock },
  },
}));

import {
  resolveWorkspaceId,
  resolveWorkspace,
  touchWorkspace,
  currentWorkspaceId,
  currentUser,
  hasSession,
  isOwnerRequest,
  MissingWorkspaceError,
  RevokedAccountError,
} from "./workspace";
import {
  signUserSession,
  signGuestSession,
  OWNER_COOKIE,
  GUEST_COOKIE,
} from "./auth/session";

const SECRET = "test-secret-at-least-32-bytes-long-xxxxx";

/**
 * What Next 16 actually throws when `.delete` is called on a sealed jar —
 * copied verbatim from `ReadonlyRequestCookiesError` in
 * `node_modules/next/dist/server/web/spec-extension/adapters/request-cookies.js`,
 * documentation tail and all.
 *
 * Verbatim on purpose (!305 review). `clearOwnerSession` tells the expected
 * failure from a real one by reading this message, so a test that throws a
 * paraphrase of it proves only that the paraphrase matches. The real string is
 * the input the production code will actually be handed.
 */
const SEALED_JAR_MESSAGE =
  "Cookies can only be modified in a Server Action or Route Handler. " +
  "Read more: https://nextjs.org/docs/app/api-reference/functions/cookies#options";

/** A cookie jar holding just the signed-in session cookie.
 *
 *  `delete` is present because a Server Function's jar has one and #220 uses
 *  it to sign a frozen account out. A jar without it would describe a shape
 *  Next.js never hands back — `ReadonlyRequestCookies` types `delete` in both
 *  phases; only the render phase makes calling it throw. */
function jarWith(token: string | undefined) {
  return {
    get: (name: string) =>
      name === OWNER_COOKIE && token ? { value: token } : undefined,
    delete: deleteCookieMock,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
  workspaceUpsertMock.mockResolvedValue({});
  cookiesMock.mockResolvedValue(jarWith(undefined));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveWorkspaceId", () => {
  // #35 Phase A — the whole point of the phase: a signed-in session resolves to
  // the workspace that account actually owns, not to a shared constant.
  it("resolves a user session to that user's own workspace, not a constant", async () => {
    const owner = await signUserSession(
      { kind: "user", userId: "u1", wsId: "ws-real" },
      SECRET,
    );
    expect(await resolveWorkspaceId({ owner })).toBe("ws-real");
  });

  it("gives two different users two different workspaces", async () => {
    const a = await signUserSession(
      { kind: "user", userId: "u1", wsId: "ws-a" },
      SECRET,
    );
    const b = await signUserSession(
      { kind: "user", userId: "u2", wsId: "ws-b" },
      SECRET,
    );
    expect(await resolveWorkspaceId({ owner: a })).toBe("ws-a");
    expect(await resolveWorkspaceId({ owner: b })).toBe("ws-b");
  });

  it("returns the guest wsId for a valid guest cookie", async () => {
    const guest = await signGuestSession("g-123", SECRET, 3600);
    expect(await resolveWorkspaceId({ guest })).toBe("g-123");
  });

  it("prefers the user session over guest", async () => {
    const owner = await signUserSession(
      { kind: "user", userId: "u1", wsId: "ws-real" },
      SECRET,
    );
    const guest = await signGuestSession("g-1", SECRET, 3600);
    expect(await resolveWorkspaceId({ owner, guest })).toBe("ws-real");
  });

  it("resolves a signed guest token forwarded via header", async () => {
    const token = await signGuestSession("g-hdr", SECRET, 3600);
    expect(await resolveWorkspaceId({ header: token })).toBe("g-hdr");
  });

  it("rejects a spoofed (unsigned) header value", async () => {
    await expect(
      resolveWorkspaceId({ header: "g-spoofed-raw-id" }),
    ).rejects.toBeInstanceOf(MissingWorkspaceError);
  });

  it("throws when nothing resolves", async () => {
    await expect(resolveWorkspaceId({})).rejects.toBeInstanceOf(
      MissingWorkspaceError,
    );
  });

  it("falls through to guest when the owner cookie is invalid/tampered", async () => {
    const guest = await signGuestSession("g-2", SECRET, 3600);
    expect(await resolveWorkspaceId({ owner: "bad.token.here", guest })).toBe(
      "g-2",
    );
  });

  it("does not accept a legacy owner cookie as a session at all", async () => {
    // Pre-#35 cookies carried { kind: "owner", sub }. They must not resolve.
    const guest = await signGuestSession("g-3", SECRET, 3600);
    const legacy = await signGuestSession("ignored", SECRET, 3600);
    expect(await resolveWorkspaceId({ owner: legacy, guest })).toBe("g-3");
  });
});

describe("resolveWorkspace", () => {
  it("reports the kind alongside the id so callers stop inferring it", async () => {
    const owner = await signUserSession(
      { kind: "user", userId: "u1", wsId: "ws-real" },
      SECRET,
    );
    // #220 adds `userId` to the user branch: it is a fact about the session, the
    // same as `kind`, and it is what `currentWorkspaceId` reads the status by
    // instead of querying the workspace it is about to write to.
    expect(await resolveWorkspace({ owner })).toEqual({
      id: "ws-real",
      kind: "user",
      userId: "u1",
    });
    const guest = await signGuestSession("g-9", SECRET, 3600);
    expect(await resolveWorkspace({ guest })).toEqual({
      id: "g-9",
      kind: "guest",
    });
  });
});

describe("touchWorkspace", () => {
  it("stamps a TTL on a guest workspace", async () => {
    await touchWorkspace("g-1", "guest");
    const [args] = workspaceUpsertMock.mock.calls[0] as [
      { create: { kind: string; expiresAt: Date | null } },
    ];
    expect(args.create.kind).toBe("guest");
    expect(args.create.expiresAt).toBeInstanceOf(Date);
  });

  it("never stamps a TTL on a user workspace", async () => {
    // A user workspace with an expiresAt would be swept by the guest purge.
    await touchWorkspace("ws-real", "user");
    const [args] = workspaceUpsertMock.mock.calls[0] as [
      { create: { kind: string; expiresAt: Date | null } },
    ];
    expect(args.create.kind).toBe("user");
    expect(args.create.expiresAt).toBeNull();
  });

  it("does not extend the TTL of an existing workspace on touch", async () => {
    await touchWorkspace("g-1", "guest");
    const [args] = workspaceUpsertMock.mock.calls[0] as [
      { update: Record<string, unknown> },
    ];
    expect(args.update).not.toHaveProperty("expiresAt");
  });

  // #220 — the compensating control for a regression this repo has now shipped
  // once. A `select` or `include` here disqualifies Prisma's single-statement
  // upsert; the read-then-write it falls back to loses the race that a fresh
  // guest sandbox's first navigation runs on every page load, and every loser
  // raises P2002. `touch-workspace-race.integration.test.ts` proves the failure
  // against a real database; this one names the cause, in the file somebody
  // editing this function is actually looking at.
  it("stays a shape Prisma can compile to one atomic statement", async () => {
    await touchWorkspace("ws-real", "user");
    const [args] = workspaceUpsertMock.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(Object.keys(args).sort()).toEqual(["create", "update", "where"]);
  });
});

// ── #220 — a frozen account with a valid cookie must not be able to write ────
//
// `currentUser()` has always re-read `status`, but only a minority of the action
// files go through it. Everything else resolves a workspace id here and writes,
// so this is the gate that decides whether a freeze actually froze anything.
describe("currentWorkspaceId", () => {
  /** Present the request as a signed-in account whose row says `status`, or
   *  `null` for an account whose row is gone entirely. */
  async function signedInWith(status: string | null) {
    const token = await signUserSession(
      { kind: "user", userId: "u1", wsId: "ws-u1" },
      SECRET,
    );
    cookiesMock.mockResolvedValue(jarWith(token));
    userFindUniqueMock.mockResolvedValue(status === null ? null : { status });
  }

  it("resolves the workspace of an active account", async () => {
    await signedInWith("active");
    expect(await currentWorkspaceId()).toBe("ws-u1");
  });

  it("refuses a revoked account holding a still-valid cookie", async () => {
    await signedInWith("revoked");
    await expect(currentWorkspaceId()).rejects.toBeInstanceOf(
      RevokedAccountError,
    );
  });

  // The subclassing is what carries the refusal into every action file and
  // /api/export's 401 branch without any of them changing. A sibling class would
  // have turned each of those into a 500 and each unhandled action into a
  // different failure — so this is behaviour, not taxonomy.
  it("refuses in a way every MissingWorkspaceError handler already understands", async () => {
    await signedInWith("revoked");
    await expect(currentWorkspaceId()).rejects.toBeInstanceOf(
      MissingWorkspaceError,
    );
  });

  it("reads the status once, by the id the token signed, selecting one column", async () => {
    await signedInWith("active");
    await currentWorkspaceId();
    expect(userFindUniqueMock).toHaveBeenCalledTimes(1);
    expect(userFindUniqueMock.mock.calls[0][0]).toEqual({
      where: { id: "u1" },
      select: { status: true },
    });
  });

  it("refuses BEFORE stamping lastSeenAt", async () => {
    // A frozen account must not leave activity behind on its way to being
    // refused, and a DELETED account's live cookie must not make
    // `touchWorkspace` re-create the workspace the cascade just removed. Both
    // follow from the order, so the order is asserted rather than assumed.
    await signedInWith("revoked");
    await expect(currentWorkspaceId()).rejects.toThrow();
    expect(workspaceUpsertMock).not.toHaveBeenCalled();
  });

  it("signs the frozen account out rather than only refusing it", async () => {
    await signedInWith("revoked");
    await expect(currentWorkspaceId()).rejects.toThrow();
    expect(deleteCookieMock).toHaveBeenCalledWith(OWNER_COOKIE);
  });

  it("still refuses when the jar is read-only, as it is in a page render", async () => {
    // Next 16 seals the cookie jar during Server Component rendering. Signing
    // somebody out is best-effort; refusing them is not.
    await signedInWith("revoked");
    deleteCookieMock.mockImplementationOnce(() => {
      throw new Error(SEALED_JAR_MESSAGE);
    });
    await expect(currentWorkspaceId()).rejects.toBeInstanceOf(
      RevokedAccountError,
    );
  });

  // ── Telling the expected sign-out failure from a real one (!305 review) ────
  //
  // The catch used to absorb every throw and label all of them as the sealed
  // jar. That is right for the one case it was written for and wrong for every
  // other: a genuine bug in the delete would look identical to the thing that
  // happens on every single page render, so nothing would ever surface it.
  describe("when signing the frozen account out fails", () => {
    /** Refuse the delete the way Next does, or the way a bug would. */
    async function frozenWithFailingDelete(thrown: unknown) {
      await signedInWith("revoked");
      deleteCookieMock.mockImplementationOnce(() => {
        throw thrown;
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const refusal = await currentWorkspaceId().catch((e: unknown) => e);
      const lines = [...errSpy.mock.calls, ...warnSpy.mock.calls].map((c) =>
        String(c[0]),
      );
      const quiet =
        errSpy.mock.calls.length +
          warnSpy.mock.calls.length +
          infoSpy.mock.calls.length ===
        0;
      errSpy.mockRestore();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      return { refusal, lines, quiet };
    }

    it("stays silent for the sealed jar, which every page render produces", async () => {
      // The expected case is not a fault and must not print like one — a line
      // per render of every page a frozen account opens is noise that would
      // bury the case below.
      const { refusal, quiet } = await frozenWithFailingDelete(
        new Error(SEALED_JAR_MESSAGE),
      );
      expect(quiet).toBe(true);
      expect(refusal).toBeInstanceOf(RevokedAccountError);
    });

    it("surfaces an unrelated failure as one structured line", async () => {
      const { refusal, lines } = await frozenWithFailingDelete(
        new Error("the cookie store went away"),
      );
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        tag: "session_clear_failed",
        message: "the cookie store went away",
      });
      // Greppable and datable, like every other structured line in the tree.
      expect(JSON.parse(lines[0]).ts).toEqual(expect.any(String));
      // Still a refusal: the gate is thrown by the caller and never consulted
      // the sign-out, so making the failure visible must not make it weaker.
      expect(refusal).toBeInstanceOf(RevokedAccountError);
    });

    it("surfaces a thrown non-Error rather than reading it as the sealed jar", async () => {
      // `throw "…"` and `throw { code }` both reach a catch as `unknown`. An
      // `instanceof Error` test that only knows how to recognise the expected
      // case must treat everything it cannot inspect as unexpected, or the
      // silent-swallow comes back through the one input that dodges the check.
      const { refusal, lines } = await frozenWithFailingDelete({
        code: "ERR_UNKNOWN",
      });
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).tag).toBe("session_clear_failed");
      expect(refusal).toBeInstanceOf(RevokedAccountError);
    });

    it("never lets the logging itself take the request down", async () => {
      // The invariant every other structured line in this repo states: an
      // observability failure must not become the response. Here it would be
      // the worst kind of regression, because the request it would replace is
      // the one refusing a frozen account.
      const hostile = new Error("unreadable");
      Object.defineProperty(hostile, "message", {
        get() {
          throw new Error("message is not readable");
        },
      });
      const { refusal } = await frozenWithFailingDelete(hostile);
      expect(refusal).toBeInstanceOf(RevokedAccountError);
    });
  });

  it("does not clear the cookie of an account that is merely browsing", async () => {
    await signedInWith("active");
    await currentWorkspaceId();
    expect(deleteCookieMock).not.toHaveBeenCalled();
  });

  // Fail closed, both ways it can go wrong.
  it("refuses a session whose account row is gone entirely", async () => {
    // A deleted account whose 30-day cookie is still alive: the cascade took the
    // workspace, `touchWorkspace` would re-create an ownerless one, and before
    // #220 that was a workspace the deleted account could write to.
    await signedInWith(null);
    await expect(currentWorkspaceId()).rejects.toBeInstanceOf(
      RevokedAccountError,
    );
  });

  it("refuses a status value neither side has heard of", async () => {
    // The column is a CHECK-constrained String, not a Postgres enum. An
    // allow-list comparison against `active` is what makes a future third value
    // deny by default instead of pass by default.
    await signedInWith("suspended-pending-appeal");
    await expect(currentWorkspaceId()).rejects.toBeInstanceOf(
      RevokedAccountError,
    );
  });

  it("propagates a database failure instead of reading it as revoked", async () => {
    // An outage must not become "your account is frozen", and must certainly not
    // become "carry on". /api/export narrows on MissingWorkspaceError precisely
    // so this stays a 500 rather than a 401.
    const token = await signUserSession(
      { kind: "user", userId: "u1", wsId: "ws-u1" },
      SECRET,
    );
    cookiesMock.mockResolvedValue(jarWith(token));
    userFindUniqueMock.mockRejectedValue(new Error("connection refused"));
    // Both facts asserted about the SAME rejection: calling the function twice
    // would let a `…Once` mock answer the second call from the default and quietly
    // test nothing.
    const err = await currentWorkspaceId().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("connection refused");
    expect(err).not.toBeInstanceOf(MissingWorkspaceError);
  });

  // #220's second requirement: a guest has no User row to have a status, so the
  // check must not apply to guests at all — and must not charge them for it.
  it("leaves a guest sandbox resolving exactly as before, at the same cost", async () => {
    const token = await signGuestSession("g-1", SECRET, 3600);
    cookiesMock.mockResolvedValue({
      get: (name: string) =>
        name === GUEST_COOKIE ? { value: token } : undefined,
      delete: deleteCookieMock,
    });
    expect(await currentWorkspaceId()).toBe("g-1");
    expect(deleteCookieMock).not.toHaveBeenCalled();
    // The extra round trip a signed-in request now pays must not reach the path
    // that serves an anonymous visitor: the guest branch is still one upsert and
    // nothing else, which is what the kind-based skip is for.
    expect(userFindUniqueMock).not.toHaveBeenCalled();
    expect(workspaceUpsertMock).toHaveBeenCalledTimes(1);
  });

  it("does not let a revoked account's status reach a guest sandbox", async () => {
    // Guests are skipped on the workspace's KIND, before any query — so even a
    // user row sitting in the mock cannot refuse a sandbox.
    const token = await signGuestSession("g-2", SECRET, 3600);
    cookiesMock.mockResolvedValue({
      get: (name: string) =>
        name === GUEST_COOKIE ? { value: token } : undefined,
      delete: deleteCookieMock,
    });
    userFindUniqueMock.mockResolvedValue({ status: "revoked" });
    expect(await currentWorkspaceId()).toBe("g-2");
  });
});

describe("currentUser", () => {
  async function signedInAs(user: {
    id: string;
    role: string;
    status: string;
    provider?: string;
    handle?: string | null;
  }) {
    const token = await signUserSession(
      { kind: "user", userId: user.id, wsId: `ws-${user.id}` },
      SECRET,
    );
    cookiesMock.mockResolvedValue(jarWith(token));
    userFindUniqueMock.mockResolvedValue(user);
  }

  it("returns null when there is no session cookie", async () => {
    expect(await currentUser()).toBeNull();
    expect(userFindUniqueMock).not.toHaveBeenCalled();
  });

  it("returns null for a guest session", async () => {
    const guest = await signGuestSession("g-1", SECRET, 3600);
    cookiesMock.mockResolvedValue(jarWith(guest));
    expect(await currentUser()).toBeNull();
  });

  it("returns null for a tampered token", async () => {
    cookiesMock.mockResolvedValue(jarWith("not.a.jwt"));
    expect(await currentUser()).toBeNull();
  });

  // #100 — provider + handle join the resolved account. They come from the SAME
  // row read that already loads role and status, so naming the signed-in account
  // in the header costs no extra round trip, and the header can never be shown a
  // handle that belongs to a different session than the role it enforces.
  it("returns the account's id, role, workspace, provider and handle", async () => {
    await signedInAs({
      id: "u1",
      role: "member",
      status: "active",
      provider: "gitlab",
      handle: "dlectronique",
    });
    expect(await currentUser()).toEqual({
      id: "u1",
      role: "member",
      workspaceId: "ws-u1",
      provider: "gitlab",
      handle: "dlectronique",
    });
  });

  // A provider may withhold a username (AuthProfile.username is optional), so
  // `handle` has to survive being absent as `null` rather than as `undefined` —
  // the display layer keys its short-id fallback off exactly that.
  it("reports a missing handle as null", async () => {
    await signedInAs({
      id: "u1",
      role: "owner",
      status: "active",
      provider: "gitlab",
      handle: null,
    });
    expect(await currentUser()).toMatchObject({ handle: null });
  });

  it("selects the display fields alongside role and status, in one query", async () => {
    await signedInAs({
      id: "u1",
      role: "owner",
      status: "active",
      provider: "gitlab",
      handle: "x",
    });
    await currentUser();
    expect(userFindUniqueMock).toHaveBeenCalledTimes(1);
    expect(userFindUniqueMock.mock.calls[0][0].select).toEqual({
      id: true,
      role: true,
      status: true,
      provider: true,
      handle: true,
    });
  });

  it("returns null when the token names a user that no longer exists", async () => {
    const token = await signUserSession(
      { kind: "user", userId: "ghost", wsId: "ws-ghost" },
      SECRET,
    );
    cookiesMock.mockResolvedValue(jarWith(token));
    userFindUniqueMock.mockResolvedValue(null);
    expect(await currentUser()).toBeNull();
  });

  // Revocation has to bite on the NEXT REQUEST, not the next sign-in: the
  // session cookie lives for 30 days, so honouring a revoked account until it
  // expires would make "revoke" mean "revoke in a month".
  it("returns null for a revoked account holding a still-valid cookie", async () => {
    await signedInAs({ id: "u1", role: "owner", status: "revoked" });
    expect(await currentUser()).toBeNull();
  });
});

describe("isOwnerRequest", () => {
  async function signedInAs(role: string, status = "active") {
    const token = await signUserSession(
      { kind: "user", userId: "u1", wsId: "ws-1" },
      SECRET,
    );
    cookiesMock.mockResolvedValue(jarWith(token));
    // provider/handle are carried even though `isOwnerRequest` only reads
    // `role`: `CurrentUser` declares `provider: string` non-optional (#100), so
    // a mock without them describes a row that cannot exist. The test would
    // still pass — which is exactly why it is worth keeping the fixture honest,
    // rather than leaving the next reader to infer the field is optional.
    userFindUniqueMock.mockResolvedValue({
      id: "u1",
      role,
      status,
      provider: "gitlab",
      handle: "owner-handle",
    });
  }

  it("treats the owner role as owner", async () => {
    await signedInAs("owner");
    expect(await isOwnerRequest()).toBe(true);
  });

  it("treats a member as not-owner", async () => {
    // The whole reason the role column exists: a signed-in account is NOT
    // automatically the instance owner.
    await signedInAs("member");
    expect(await isOwnerRequest()).toBe(false);
  });

  it("treats a revoked owner as not-owner", async () => {
    await signedInAs("owner", "revoked");
    expect(await isOwnerRequest()).toBe(false);
  });

  it("treats a guest as not-owner", async () => {
    const guest = await signGuestSession("g-1", SECRET, 3600);
    cookiesMock.mockResolvedValue(jarWith(guest));
    expect(await isOwnerRequest()).toBe(false);
  });

  it("treats an anonymous request as not-owner", async () => {
    expect(await isOwnerRequest()).toBe(false);
  });
});

describe("hasSession", () => {
  // #61 — the cheap gate. `currentWorkspaceId()` upserts `lastSeenAt` on the way
  // through, which is right for a page view and wrong for a range request: one
  // track can produce a dozen, and every seek adds more. This asks the same
  // question with no database round trip at all.
  it("is true for a signed-in account", async () => {
    const token = await signUserSession(
      { kind: "user", userId: "u-1", wsId: "ws-1" },
      SECRET,
    );
    cookiesMock.mockResolvedValue(jarWith(token));
    expect(await hasSession()).toBe(true);
    expect(workspaceUpsertMock).not.toHaveBeenCalled();
  });

  it("is true for a guest sandbox, which is a real session", async () => {
    const token = await signGuestSession("g-1", SECRET, 3600);
    cookiesMock.mockResolvedValue({
      get: (name: string) =>
        name === "df_guest" ? { value: token } : undefined,
    });
    expect(await hasSession()).toBe(true);
  });

  it("is false with no cookie at all", async () => {
    cookiesMock.mockResolvedValue(jarWith(undefined));
    expect(await hasSession()).toBe(false);
  });

  it("is false for a tampered token rather than throwing", async () => {
    cookiesMock.mockResolvedValue(jarWith("not.a.jwt"));
    expect(await hasSession()).toBe(false);
  });

  it("lets a non-session failure through instead of reporting anonymous", async () => {
    // A misconfigured AUTH_SESSION_SECRET must not read as "not signed in" —
    // that sends somebody with a perfectly good cookie to re-authenticate over
    // what is actually an outage. Same reasoning as /api/export's 401 branch.
    cookiesMock.mockRejectedValue(new Error("cookie store exploded"));
    await expect(hasSession()).rejects.toThrow("cookie store exploded");
  });
});
