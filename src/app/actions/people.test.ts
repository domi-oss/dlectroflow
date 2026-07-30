import { describe, it, expect, vi, beforeEach } from "vitest";

// #35 Phase B — the owner-only People actions.
//
// These are the only writes the People panel can perform, so the gate on each
// one is the whole security boundary of the panel. Every action is tested for
// three things: it refuses a non-owner AND writes nothing, it validates its
// input against the same value sets the CHECK constraints enforce, and it can
// never grant ownership (`isOwnerSeed` / `role` are not writable from here).

const db = vi.hoisted(() => ({
  allowlist: { create: vi.fn(), deleteMany: vi.fn() },
  user: { updateMany: vi.fn() },
}));
const isOwnerRequestMock = vi.hoisted(() => vi.fn());
const currentUserMock = vi.hoisted(() => vi.fn());
const revalidatePathMock = vi.hoisted(() => vi.fn());
const tryDisconnectGoogleMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({
  prisma: db,
  isUniqueViolation: (e: unknown) =>
    !!e && typeof e === "object" && (e as { code?: string }).code === "P2002",
}));
vi.mock("@/lib/workspace", () => ({
  isOwnerRequest: isOwnerRequestMock,
  currentUser: currentUserMock,
}));
vi.mock("@/lib/google", () => ({
  tryDisconnectGoogle: tryDisconnectGoogleMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import {
  invitePerson,
  withdrawInvitation,
  updatePersonAiPolicy,
  revokePerson,
} from "./people";

class FakeP2002 extends Error {
  code = "P2002";
}

const OWNER = { id: "u-owner", role: "owner" as const, workspaceId: "ws-o" };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_PROVIDER = "gitlab";
  isOwnerRequestMock.mockResolvedValue(true);
  currentUserMock.mockResolvedValue(OWNER);
  db.allowlist.create.mockResolvedValue({ id: "a-1" });
  db.allowlist.deleteMany.mockResolvedValue({ count: 1 });
  db.user.updateMany.mockResolvedValue({ count: 1 });
  tryDisconnectGoogleMock.mockResolvedValue(true);
});

function expectNoWrites() {
  expect(db.allowlist.create).not.toHaveBeenCalled();
  expect(db.allowlist.deleteMany).not.toHaveBeenCalled();
  expect(db.user.updateMany).not.toHaveBeenCalled();
  // #126 — "writes nothing" includes somebody's Google grant. Revoking a
  // member now withdraws their grant, so a rejected caller reaching this
  // action must not be able to destroy a connection either.
  expect(tryDisconnectGoogleMock).not.toHaveBeenCalled();
}

describe("every People action is owner-only", () => {
  beforeEach(() => {
    isOwnerRequestMock.mockResolvedValue(false);
    currentUserMock.mockResolvedValue({
      id: "u-member",
      role: "member",
      workspaceId: "ws-m",
    });
  });

  it("refuses a member and writes nothing", async () => {
    expect(await invitePerson({ identity: "grace" })).toEqual({
      ok: false,
      error: "not_allowed",
    });
    expect(await withdrawInvitation("a-1")).toEqual({
      ok: false,
      error: "not_allowed",
    });
    expect(
      await updatePersonAiPolicy({
        userId: "u-2",
        aiPolicy: "uncapped",
        aiQuota: 10,
      }),
    ).toEqual({ ok: false, error: "not_allowed" });
    expect(await revokePerson("u-2")).toEqual({
      ok: false,
      error: "not_allowed",
    });

    expectNoWrites();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("invitePerson", () => {
  it("stores the identity lowercased and trimmed, for the configured provider", async () => {
    // Must match how the OAuth profile is normalised, or the invite can never be
    // claimed — the same rule prisma/seed-allowlist.ts follows.
    const res = await invitePerson({ identity: "  Grace.Hopper  " });

    expect(res).toEqual({ ok: true });
    expect(db.allowlist.create).toHaveBeenCalledWith({
      data: {
        provider: "gitlab",
        identity: "grace.hopper",
        note: null,
      },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/settings");
  });

  it("keeps an optional note, trimmed", async () => {
    await invitePerson({ identity: "grace", note: "  new teammate " });
    expect(db.allowlist.create.mock.calls[0][0].data.note).toBe("new teammate");
  });

  it("NEVER writes isOwnerSeed or a role — the panel cannot mint an owner", async () => {
    await invitePerson({ identity: "grace" });
    const data = db.allowlist.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("isOwnerSeed");
    expect(data).not.toHaveProperty("role");
  });

  it("rejects an empty or whitespace-only identity", async () => {
    // A blank invitation would match a profile with no username at all.
    for (const identity of ["", "   ", "\t"]) {
      expect(await invitePerson({ identity })).toEqual({
        ok: false,
        error: "invalid_identity",
      });
    }
    expectNoWrites();
  });

  it("rejects an absurdly long identity rather than storing it", async () => {
    expect(await invitePerson({ identity: "a".repeat(321) })).toEqual({
      ok: false,
      error: "invalid_identity",
    });
    expectNoWrites();
  });

  it("reports an existing invitation instead of throwing a unique violation", async () => {
    db.allowlist.create.mockRejectedValue(new FakeP2002("dup"));

    expect(await invitePerson({ identity: "grace" })).toEqual({
      ok: false,
      error: "already_invited",
    });
  });

  it("rethrows a database failure that is not a duplicate", async () => {
    db.allowlist.create.mockRejectedValue(new Error("connection reset"));
    await expect(invitePerson({ identity: "grace" })).rejects.toThrow(
      "connection reset",
    );
  });
});

describe("withdrawInvitation", () => {
  it("deletes only an UNCLAIMED invitation", async () => {
    // A claimed row is the record that an account exists; deleting it would
    // orphan the audit trail while leaving the account signed in. Revoke the
    // person instead.
    const res = await withdrawInvitation("a-1");

    expect(res).toEqual({ ok: true });
    expect(db.allowlist.deleteMany).toHaveBeenCalledWith({
      where: { id: "a-1", claimedById: null },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/settings");
  });

  it("reports a miss rather than pretending it worked", async () => {
    db.allowlist.deleteMany.mockResolvedValue({ count: 0 });
    expect(await withdrawInvitation("a-claimed")).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("rejects an empty id without issuing a delete", async () => {
    expect(await withdrawInvitation("  ")).toEqual({
      ok: false,
      error: "not_found",
    });
    expectNoWrites();
  });
});

describe("updatePersonAiPolicy", () => {
  it("sets the policy and quota", async () => {
    const res = await updatePersonAiPolicy({
      userId: "u-2",
      aiPolicy: "capped",
      aiQuota: 25,
    });

    expect(res).toEqual({ ok: true });
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { id: "u-2" },
      data: { aiPolicy: "capped", aiQuota: 25 },
    });
  });

  it("accepts every value AiPolicy defines and nothing else", async () => {
    for (const aiPolicy of ["uncapped", "capped", "own_key"]) {
      expect(
        await updatePersonAiPolicy({ userId: "u-2", aiPolicy, aiQuota: 5 }),
      ).toEqual({ ok: true });
    }
    db.user.updateMany.mockClear();
    for (const aiPolicy of ["free_for_all", "owner", "", "CAPPED"]) {
      expect(
        await updatePersonAiPolicy({ userId: "u-2", aiPolicy, aiQuota: 5 }),
      ).toEqual({ ok: false, error: "invalid_policy" });
    }
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it("clamps the quota to a whole number in range, mirroring the CHECK constraint", async () => {
    const cases: Array<[number, number]> = [
      [-5, 0],
      [0, 0],
      [7.6, 8],
      [100_000, 10_000],
    ];
    for (const [input, expected] of cases) {
      db.user.updateMany.mockClear();
      await updatePersonAiPolicy({
        userId: "u-2",
        aiPolicy: "capped",
        aiQuota: input,
      });
      expect(db.user.updateMany.mock.calls[0][0].data.aiQuota).toBe(expected);
    }
  });

  it("treats a non-finite quota as zero rather than writing NaN", async () => {
    await updatePersonAiPolicy({
      userId: "u-2",
      aiPolicy: "capped",
      aiQuota: Number.NaN,
    });
    expect(db.user.updateMany.mock.calls[0][0].data.aiQuota).toBe(0);
  });

  it("NEVER writes role or status — policy is the only thing this action changes", async () => {
    await updatePersonAiPolicy({
      userId: "u-2",
      aiPolicy: "capped",
      aiQuota: 5,
    });
    const data = db.user.updateMany.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual(["aiPolicy", "aiQuota"]);
  });

  it("reports a miss when the account is gone", async () => {
    db.user.updateMany.mockResolvedValue({ count: 0 });
    expect(
      await updatePersonAiPolicy({
        userId: "ghost",
        aiPolicy: "capped",
        aiQuota: 5,
      }),
    ).toEqual({ ok: false, error: "not_found" });
  });
});

describe("revokePerson", () => {
  it("freezes the account and schedules its purge 30 days out", async () => {
    const res = await revokePerson("u-2");

    expect(res).toEqual({ ok: true });
    const call = db.user.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "u-2", status: "active" });
    expect(call.data.status).toBe("revoked");
    const revokedAt = call.data.revokedAt as Date;
    const purgeAfter = call.data.purgeAfter as Date;
    expect(purgeAfter.getTime() - revokedAt.getTime()).toBe(30 * 86_400_000);
    expect(revalidatePathMock).toHaveBeenCalledWith("/settings");
  });

  it("leaves the account's DATA alone — revoke freezes, it does not delete", async () => {
    await revokePerson("u-2");
    const data = db.user.updateMany.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual([
      "purgeAfter",
      "revokedAt",
      "status",
    ]);
  });

  it("refuses to let the owner revoke themselves", async () => {
    // The owner is the only account that can manage people. Freezing it would
    // lock the instance's administration away with no way back through the UI.
    expect(await revokePerson(OWNER.id)).toEqual({
      ok: false,
      error: "cannot_revoke_self",
    });
    expectNoWrites();
  });

  it("reports a miss for an unknown or already-revoked account", async () => {
    db.user.updateMany.mockResolvedValue({ count: 0 });
    expect(await revokePerson("u-2")).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  // ── #126 — the grant goes with the access ────────────────────────────────
  //
  // Before this, freezing an account touched no tokens: the member's GoogleAuth
  // row survived, their grant stayed live at Google, and a frozen account
  // cannot reach the Disconnect control — so the product had no way left to
  // withdraw a consent it had taken. UK GDPR Art. 7(3) says withdrawing consent
  // must be as easy as giving it, and "email the owner" is not that.
  it("withdraws the member's Google grant as part of revoking them", async () => {
    await revokePerson("u-2");
    expect(tryDisconnectGoogleMock).toHaveBeenCalledWith("u-2");
  });

  it("revokes the grant BEFORE the freeze, never after", async () => {
    await revokePerson("u-2");
    // Not cosmetic ordering. Whichever step runs first is the one that survives
    // a crash between them: revoke-then-freeze can leave an ACTIVE account with
    // no Google connection (the member simply reconnects), while
    // freeze-then-revoke leaves exactly the bug — a frozen account holding a
    // live grant that nothing in the product can withdraw.
    expect(tryDisconnectGoogleMock.mock.invocationCallOrder[0]).toBeLessThan(
      db.user.updateMany.mock.invocationCallOrder[0],
    );
  });

  it("still freezes the account when the revoke fails", async () => {
    // Access has to stop even if Google cannot be reached. `tryDisconnectGoogle`
    // reports rather than throws (src/lib/google.ts) precisely so this holds,
    // and it deletes the stored tokens either way — no dead token is left
    // behind by a failed revoke.
    tryDisconnectGoogleMock.mockResolvedValue(false);
    expect(await revokePerson("u-2")).toEqual({ ok: true });
    expect(db.user.updateMany.mock.calls[0][0].data.status).toBe("revoked");
  });

  it("touches no grant when the owner is stopped from revoking themselves", async () => {
    // The self-revoke guard runs before anything happens, so the owner's own
    // connection survives a click on their own row.
    expect(await revokePerson(OWNER.id)).toEqual({
      ok: false,
      error: "cannot_revoke_self",
    });
    expectNoWrites();
  });
});
