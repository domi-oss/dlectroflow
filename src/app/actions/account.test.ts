import { describe, it, expect, vi, beforeEach } from "vitest";
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
  revalidateMock,
} = vi.hoisted(() => ({
  currentUserMock: vi.fn(),
  userUpdateMock: vi.fn(),
  userUpdateManyMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  revalidateMock: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      update: userUpdateMock,
      updateMany: userUpdateManyMock,
      findUnique: userFindUniqueMock,
    },
  },
}));
vi.mock("@/lib/workspace", () => ({ currentUser: currentUserMock }));

import { saveOwnLlmKey, removeOwnLlmKey, ownLlmKeyPresent } from "./account";

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
