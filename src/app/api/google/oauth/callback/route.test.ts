import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #119 — the callback is the half that actually writes credentials
// (exchangeCode → storeTokens → the instance-wide GoogleAuth row), so the owner
// gate matters even more here than on /start: a member who already holds PKCE
// cookies must not be able to complete an exchange.
const { isOwnerMock, exchangeCodeMock, cookiesMock } = vi.hoisted(() => ({
  isOwnerMock: vi.fn(),
  exchangeCodeMock: vi.fn(),
  cookiesMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ isOwnerRequest: isOwnerMock }));
vi.mock("@/lib/google", () => ({ exchangeCode: exchangeCodeMock }));
vi.mock("next/headers", () => ({ cookies: cookiesMock }));
vi.mock("@/lib/origin", () => ({
  requestOrigin: () => "https://dlectroflow.test",
}));

import { GET } from "./route";

const CALLBACK_URL =
  "https://dlectroflow.test/api/google/oauth/callback?code=c&state=st";

/** A jar carrying a matching state + verifier, i.e. everything the callback
 *  needs before it gets as far as the authorization decision. */
function validJar() {
  return {
    get: (name: string) =>
      name === "google_oauth_state"
        ? { value: "st" }
        : name === "google_pkce_verifier"
          ? { value: "ver" }
          : undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cookiesMock.mockResolvedValue(validJar());
  exchangeCodeMock.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("google oauth callback — owner gate (#119)", () => {
  it("rejects a signed-in non-owner with 403 and exchanges no code", async () => {
    isOwnerMock.mockResolvedValue(false);

    const res = await GET(new Request(CALLBACK_URL));

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
    // The credential write never happens — this is the line that stops a
    // member's tokens landing in the shared GoogleAuth row.
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });

  it("rejects a non-owner holding a valid state + verifier", async () => {
    // A member who obtained cookies before this gate existed (or from a shared
    // browser) must still be refused: the gate is on the ROLE, not the cookies.
    // The jar is set explicitly here even though beforeEach already does it —
    // the whole point of this case is that a VALID state + verifier pair is
    // present, so it should be visible in the test rather than inherited.
    cookiesMock.mockResolvedValue(validJar());
    isOwnerMock.mockResolvedValue(false);

    const res = await GET(new Request(CALLBACK_URL));

    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("still completes the exchange for the owner", async () => {
    isOwnerMock.mockResolvedValue(true);

    const res = await GET(new Request(CALLBACK_URL));

    expect(exchangeCodeMock).toHaveBeenCalledWith(
      "c",
      "ver",
      "https://dlectroflow.test/api/google/oauth/callback",
    );
    expect(res.headers.get("location")).toBe(
      "https://dlectroflow.test/?google=connected",
    );
  });

  it("still rejects a state mismatch for the owner (gate added, checks kept)", async () => {
    isOwnerMock.mockResolvedValue(true);

    const res = await GET(
      new Request(
        "https://dlectroflow.test/api/google/oauth/callback?code=c&state=wrong",
      ),
    );

    expect(exchangeCodeMock).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe(
      "https://dlectroflow.test/?google=error&reason=state_mismatch",
    );
  });
});
