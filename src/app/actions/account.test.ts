import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decryptToken } from "@/lib/crypto/token-cipher";

// #118 Phase C — the caller's OWN account settings. Every assertion below is
// about the same property: there is no id parameter on any of these actions, so
// the row written is the session's row and nothing else. A server action is a
// public POST endpoint, so that has to be structural rather than reviewed.
const {
  currentUserMock,
  userUpdateMock,
  userUpdateManyMock,
  userFindUniqueMock,
  userDeleteManyMock,
  revalidateMock,
  cookieDeleteMock,
  tryDisconnectGoogleMock,
} = vi.hoisted(() => ({
  currentUserMock: vi.fn(),
  userUpdateMock: vi.fn(),
  userUpdateManyMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  userDeleteManyMock: vi.fn(),
  revalidateMock: vi.fn(),
  cookieDeleteMock: vi.fn(),
  tryDisconnectGoogleMock: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));
// #153 — the session cookie is the only thing still naming the account after a
// self-serve deletion, so ending it is part of the action, not of the UI.
vi.mock("next/headers", () => ({
  cookies: async () => ({ delete: cookieDeleteMock }),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      update: userUpdateMock,
      updateMany: userUpdateManyMock,
      findUnique: userFindUniqueMock,
      deleteMany: userDeleteManyMock,
    },
  },
}));
vi.mock("@/lib/workspace", () => ({ currentUser: currentUserMock }));
// #126 — deliberately NOT mocking @/lib/account-lifecycle. The freeze it
// performs is the thing this entry point could most easily have bypassed, so
// the real one runs and the Google revoke underneath it is asserted here.
vi.mock("@/lib/google", () => ({
  tryDisconnectGoogle: tryDisconnectGoogleMock,
}));

import {
  saveOwnLlmKey,
  removeOwnLlmKey,
  ownLlmKeyPresent,
  deleteOwnAccount,
} from "./account";
import { PURGE_GRACE_DAYS } from "@/lib/account-lifecycle";

const ME = "user_alice";
const me = () => ({
  id: ME,
  role: "member" as const,
  workspaceId: "ws_a",
  provider: "gitlab",
  handle: "alice",
});

beforeEach(() => {
  vi.clearAllMocks();
  currentUserMock.mockResolvedValue(me());
  userUpdateMock.mockResolvedValue({});
  userUpdateManyMock.mockResolvedValue({ count: 1 });
  tryDisconnectGoogleMock.mockResolvedValue(true);
});

describe("saveOwnLlmKey", () => {
  it("encrypts the key and writes it to the CALLER's own row", async () => {
    expect(await saveOwnLlmKey("sk-ant-secret")).toEqual({ ok: true });
    const call = userUpdateMock.mock.calls[0][0];
    // No id parameter exists on this action, so there is no other row to write.
    expect(call.where).toEqual({ id: ME });
    expect(call.data.llmKeyEnc).toMatch(/^v1:/);
    expect(decryptToken(call.data.llmKeyEnc)).toBe("sk-ant-secret");
  });

  it("never writes the plaintext", async () => {
    await saveOwnLlmKey("sk-ant-secret");
    expect(JSON.stringify(userUpdateMock.mock.calls[0][0])).not.toContain(
      "sk-ant-secret",
    );
  });

  it("does not touch aiPolicy, aiQuota, role or llmProvider", async () => {
    // A present key already lifts the cap (consumeUserBreakdown's resolution
    // order), so there is nothing to change - and these are fields the OWNER
    // administers from the People panel.
    await saveOwnLlmKey("sk-ant-secret");
    const { data } = userUpdateMock.mock.calls[0][0];
    expect(data).not.toHaveProperty("aiPolicy");
    expect(data).not.toHaveProperty("aiQuota");
    expect(data).not.toHaveProperty("role");
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("llmProvider");
  });

  it("revalidates /settings so the stored-key state is not stale", async () => {
    await saveOwnLlmKey("sk-ant-secret");
    expect(revalidateMock).toHaveBeenCalledWith("/settings");
  });

  it("trims surrounding whitespace — a pasted key carries it", async () => {
    await saveOwnLlmKey("  sk-ant-secret\n");
    expect(decryptToken(userUpdateMock.mock.calls[0][0].data.llmKeyEnc)).toBe(
      "sk-ant-secret",
    );
  });

  it("rejects an empty key rather than storing an encrypted empty string", async () => {
    // An encrypted "" decrypts to "" which is falsy, so the account would
    // silently fall back to the instance key while the UI said 'key saved'.
    expect(await saveOwnLlmKey("   ")).toEqual({
      ok: false,
      error: "invalid_key",
    });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects a key longer than any real API key", async () => {
    expect(await saveOwnLlmKey("x".repeat(601))).toEqual({
      ok: false,
      error: "invalid_key",
    });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects a key containing control characters or newlines", async () => {
    // A header-bound secret with a newline in it is a request-splitting shape.
    expect(await saveOwnLlmKey("sk-ant\nX-Evil: 1")).toEqual({
      ok: false,
      error: "invalid_key",
    });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("refuses a caller with no signed-in account", async () => {
    currentUserMock.mockResolvedValue(null);
    expect(await saveOwnLlmKey("sk-ant-secret")).toEqual({
      ok: false,
      error: "not_signed_in",
    });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("reports a row that vanished mid-request rather than throwing", async () => {
    userUpdateMock.mockRejectedValue(
      Object.assign(new Error("nope"), { code: "P2025" }),
    );
    expect(await saveOwnLlmKey("sk-ant-secret")).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("rethrows an error that is not a missing row", async () => {
    // Swallowing every failure would report "saved" for a database outage.
    userUpdateMock.mockRejectedValue(new Error("connection reset"));
    await expect(saveOwnLlmKey("sk-ant-secret")).rejects.toThrow(
      "connection reset",
    );
  });
});

/**
 * #177 step 1 — the fourth guard, alongside empty / over-length / control
 * characters. The shape table itself is exercised in
 * `src/lib/llm/key-shape.test.ts`; what these specs pin is the WIRING: that the
 * guard runs before the write, that it reports a code of its own rather than
 * the generic `invalid_key`, and — the one that matters — that it stays
 * asymmetric once it is behind a server action.
 */
describe("saveOwnLlmKey — a key that belongs to another provider", () => {
  // The action resolves the configured provider from `LLM_PROVIDER`, so these
  // specs own that variable and hand it back. `beforeEach` deletes it rather
  // than assuming the ambient environment is clean: an `.env` that happens to
  // set it would otherwise silently flip which direction is being tested.
  beforeEach(() => {
    delete process.env.LLM_PROVIDER;
  });
  afterEach(() => {
    delete process.env.LLM_PROVIDER;
  });

  it("refuses an OpenAI key on an anthropic instance, before the write", async () => {
    // The 2026-08-05 incident: this saved, decrypted, and came back
    // `401 invalid x-api-key` with nothing on screen to say so.
    expect(await saveOwnLlmKey("sk-proj-AAAABBBBCCCCDDDD")).toEqual({
      ok: false,
      error: "wrong_provider_key",
      looksLike: "OpenAI",
      expectedProvider: "Anthropic",
      expectedPrefix: "sk-ant-",
    });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("reports a code of its own, distinct from `invalid_key`", async () => {
    // A generic code leaves the panel with nothing specific to say, which is
    // the state #177 is fixing — the user could already see that "it didn't
    // work" and still had no idea why.
    const result = await saveOwnLlmKey("gsk_AAAABBBBCCCCDDDD");
    expect(result).toMatchObject({ ok: false, error: "wrong_provider_key" });
    expect(result).not.toMatchObject({ error: "invalid_key" });
  });

  it("follows LLM_PROVIDER, so the check runs in both directions", async () => {
    process.env.LLM_PROVIDER = "openai-compatible";
    expect(await saveOwnLlmKey("sk-ant-api03-AAAA")).toMatchObject({
      ok: false,
      error: "wrong_provider_key",
      looksLike: "Anthropic",
      expectedPrefix: null,
    });
    expect(userUpdateMock).not.toHaveBeenCalled();

    // …and the same key that was refused above is stored here, because OpenAI
    // is a native openai-compatible endpoint rather than a foreign one.
    expect(await saveOwnLlmKey("sk-proj-AAAABBBBCCCCDDDD")).toEqual({
      ok: true,
    });
    expect(userUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("STORES an unrecognised key shape rather than guessing", async () => {
    // The false-reject case, pinned at the action boundary as well as in the
    // module. A conformance check here would make a key in a format the
    // provider introduced later unsaveable — a failure with no workaround at
    // all, which is worse than the silent 401 being fixed.
    expect(await saveOwnLlmKey("sk-ant2-a-format-that-does-not-exist")).toEqual(
      { ok: true },
    );
    expect(decryptToken(userUpdateMock.mock.calls[0][0].data.llmKeyEnc)).toBe(
      "sk-ant2-a-format-that-does-not-exist",
    );
  });

  it("never returns any part of the rejected key", async () => {
    // The result is rendered in the account panel, so anything derived from the
    // key would put a secret in an RSC payload — the exact thing this file's
    // presence-only discipline exists to prevent.
    const result = await saveOwnLlmKey("sk-proj-THE-SECRET-BODY-9f2c");
    expect(JSON.stringify(result)).not.toContain("THE-SECRET-BODY");
    expect(JSON.stringify(result)).not.toContain("9f2c");
  });

  it("still rejects an empty or control-character key as `invalid_key`", async () => {
    // Guard order: the shape check is the fourth, not the first. A blank field
    // is not a "wrong provider" problem and must not be described as one.
    expect(await saveOwnLlmKey("   ")).toEqual({
      ok: false,
      error: "invalid_key",
    });
    expect(await saveOwnLlmKey("sk-proj-A\nX-Evil: 1")).toEqual({
      ok: false,
      error: "invalid_key",
    });
    expect(await saveOwnLlmKey(`sk-proj-${"A".repeat(601)}`)).toEqual({
      ok: false,
      error: "invalid_key",
    });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("reports a lost session, not a key shape, for a signed-out caller", async () => {
    // Deliberately ordered after the session check: an expired session must not
    // be reported as a key problem, and a signed-out caller gets no signal
    // about key shapes at all.
    currentUserMock.mockResolvedValue(null);
    expect(await saveOwnLlmKey("sk-proj-AAAABBBBCCCCDDDD")).toEqual({
      ok: false,
      error: "not_signed_in",
    });
  });
});

describe("removeOwnLlmKey", () => {
  it("nulls the caller's own ciphertext", async () => {
    expect(await removeOwnLlmKey()).toEqual({ ok: true });
    // updateMany, not update: removing a key that is not there must read as
    // success, not as a thrown RecordNotFound.
    expect(userUpdateManyMock).toHaveBeenCalledWith({
      where: { id: ME },
      data: { llmKeyEnc: null },
    });
  });

  it("is idempotent for an account with no key", async () => {
    userUpdateManyMock.mockResolvedValue({ count: 0 });
    expect(await removeOwnLlmKey()).toEqual({ ok: true });
    expect(await removeOwnLlmKey()).toEqual({ ok: true });
  });

  it("refuses a caller with no signed-in account", async () => {
    currentUserMock.mockResolvedValue(null);
    expect(await removeOwnLlmKey()).toEqual({
      ok: false,
      error: "not_signed_in",
    });
    expect(userUpdateManyMock).not.toHaveBeenCalled();
  });
});

describe("ownLlmKeyPresent", () => {
  it("answers presence WITHOUT selecting the ciphertext", async () => {
    userFindUniqueMock.mockResolvedValue({ id: ME });
    expect(await ownLlmKeyPresent()).toBe(true);
    const { select, where } = userFindUniqueMock.mock.calls[0][0];
    expect(where).toMatchObject({ id: ME });
    // Same rule people.ts follows: never pull a secret into an object graph a
    // component's props are built from. Presence is a where-clause question.
    expect(select).toEqual({ id: true });
    expect(JSON.stringify(select)).not.toContain("llmKeyEnc");
  });

  it("is false for an account with no key and for no account at all", async () => {
    userFindUniqueMock.mockResolvedValue(null);
    expect(await ownLlmKeyPresent()).toBe(false);
    currentUserMock.mockResolvedValue(null);
    expect(await ownLlmKeyPresent()).toBe(false);
    // And no query was made for a caller with no account.
    expect(userFindUniqueMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * #153 — a member deleting their OWN account.
 *
 * The rule this file's other actions are built on ("NO ID PARAMETER") is doing
 * the heaviest lifting it has done yet: this action ends an account, so an id
 * parameter would be an IDOR that destroys somebody. The first block below is
 * the scoping invariant, asserted structurally rather than by review.
 */
describe("deleteOwnAccount — the scoping invariant", () => {
  it("takes no arguments at all, so there is no other account to name", () => {
    // A server action is a public POST endpoint. `length` is the arity the
    // client can actually supply, and zero is the only value that makes
    // "your own account only" true by construction instead of by validation.
    expect(deleteOwnAccount.length).toBe(0);
  });

  it("freezes the SESSION's account, never one the caller supplies", async () => {
    // Called with an id anyway — which a hand-rolled POST to this endpoint can
    // do whatever the signature says. It must be ignored.
    await (deleteOwnAccount as (...args: unknown[]) => Promise<unknown>)(
      "user_mallory",
    );

    const call = userUpdateManyMock.mock.calls[0][0];
    expect(call.where).toEqual({ id: ME, status: "active" });
    expect(JSON.stringify(call)).not.toContain("user_mallory");
    expect(tryDisconnectGoogleMock).toHaveBeenCalledWith(ME);
    expect(tryDisconnectGoogleMock).not.toHaveBeenCalledWith("user_mallory");
  });

  it("refuses a caller with no signed-in account, and writes nothing", async () => {
    currentUserMock.mockResolvedValue(null);
    expect(await deleteOwnAccount()).toEqual({
      ok: false,
      error: "not_signed_in",
    });
    expect(userUpdateManyMock).not.toHaveBeenCalled();
    expect(tryDisconnectGoogleMock).not.toHaveBeenCalled();
    expect(cookieDeleteMock).not.toHaveBeenCalled();
  });
});

describe("deleteOwnAccount", () => {
  it("freezes the account and schedules its purge, rather than deleting inline", async () => {
    expect(await deleteOwnAccount()).toEqual({ ok: true });

    const call = userUpdateManyMock.mock.calls[0][0];
    expect(call.data.status).toBe("revoked");
    const revokedAt = call.data.revokedAt as Date;
    const purgeAfter = call.data.purgeAfter as Date;
    // Derived from the exported constant, not a literal 30: `account-lifecycle`
    // is deliberately NOT mocked here, so the real `freezeAccount` computes this.
    // Hardcoding the number would fail a future change to PURGE_GRACE_DAYS with
    // an opaque number mismatch instead of pointing at the constant that moved.
    expect(purgeAfter.getTime() - revokedAt.getTime()).toBe(
      PURGE_GRACE_DAYS * 86_400_000,
    );
    // The recovery window is the point: an accidental self-deletion has to be
    // as recoverable as an owner-initiated revoke, so no row is destroyed here.
    expect(userDeleteManyMock).not.toHaveBeenCalled();
  });

  it("withdraws the Google grant AT GOOGLE, before the freeze (#126)", async () => {
    // The self-serve path must not be the one entry point that skips this. A
    // frozen account resolves to null in currentUser() and can no longer reach
    // its own Disconnect control, so a grant left live here is one its owner
    // cannot withdraw through the product at all.
    await deleteOwnAccount();

    expect(tryDisconnectGoogleMock).toHaveBeenCalledWith(ME);
    expect(tryDisconnectGoogleMock.mock.invocationCallOrder[0]).toBeLessThan(
      userUpdateManyMock.mock.invocationCallOrder[0],
    );
  });

  it("completes even when Google refuses the revoke", async () => {
    // An erasure request has a statutory clock on it; an unreachable Google
    // cannot be allowed to block it.
    tryDisconnectGoogleMock.mockResolvedValue(false);
    expect(await deleteOwnAccount()).toEqual({ ok: true });
    expect(userUpdateManyMock).toHaveBeenCalled();
  });

  it("ends the session, so the caller is signed out on the next request", async () => {
    await deleteOwnAccount();
    expect(cookieDeleteMock).toHaveBeenCalledWith("df_owner");
  });

  it("revalidates /settings so the page cannot re-render the old account", async () => {
    await deleteOwnAccount();
    expect(revalidateMock).toHaveBeenCalledWith("/settings");
  });

  it("refuses the instance owner, and writes nothing", async () => {
    // The same reason revokePerson refuses owner self-revocation: the owner is
    // the only account that can manage people, so an instance whose owner
    // deleted themselves has no route back through the UI.
    currentUserMock.mockResolvedValue({ ...me(), role: "owner" });
    expect(await deleteOwnAccount()).toEqual({
      ok: false,
      error: "owner_cannot_delete",
    });
    expect(userUpdateManyMock).not.toHaveBeenCalled();
    expect(tryDisconnectGoogleMock).not.toHaveBeenCalled();
    expect(cookieDeleteMock).not.toHaveBeenCalled();
  });

  it("is idempotent when the account was already frozen concurrently", async () => {
    // currentUser() already proved the row was ACTIVE, so a zero-row update is
    // only reachable when the owner revoked the same account in between. The
    // caller's outcome holds either way, and telling them it failed would
    // invite them to press it again.
    userUpdateManyMock.mockResolvedValue({ count: 0 });
    expect(await deleteOwnAccount()).toEqual({ ok: true });
    expect(cookieDeleteMock).toHaveBeenCalledWith("df_owner");
  });

  it("does not touch aiPolicy, aiQuota, role or the stored key", async () => {
    await deleteOwnAccount();
    const { data } = userUpdateManyMock.mock.calls[0][0];
    expect(Object.keys(data).sort()).toEqual([
      "purgeAfter",
      "revokedAt",
      "status",
    ]);
  });
});
