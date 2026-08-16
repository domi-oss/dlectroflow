import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #119 — the callback is the half that actually writes credentials
// (exchangeCode → storeTokens → the instance-wide GoogleAuth row), so the owner
// gate matters even more here than on /start: a member who already holds PKCE
// cookies must not be able to complete an exchange.
const { currentUserMock, exchangeCodeMock, cookiesMock } = vi.hoisted(() => ({
  currentUserMock: vi.fn(),
  exchangeCodeMock: vi.fn(),
  cookiesMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ currentUser: currentUserMock }));
// #211 — the route needs the REAL `GoogleTimeoutError` and the real reason
// token, because telling a deadline apart from a refusal is the behaviour under
// test. A stub class would let the route match on something the module does not
// actually throw, and the banner reads the same token back out of the URL.
vi.mock("@/lib/google", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google")>();
  return {
    GoogleTimeoutError: actual.GoogleTimeoutError,
    GOOGLE_TIMEOUT_REASON: actual.GOOGLE_TIMEOUT_REASON,
    exchangeCode: exchangeCodeMock,
  };
});
vi.mock("next/headers", () => ({ cookies: cookiesMock }));
vi.mock("@/lib/origin", () => ({
  requestOrigin: () => "https://dlectroflow.test",
}));

import { GET } from "./route";

const CALLBACK_URL =
  "https://dlectroflow.test/api/google/oauth/callback?code=c&state=st";

// #118 — the handler reads currentUser() rather than isOwnerRequest(): it needs
// the acting account's ID as well as its role, because the exchange binds tokens
// to THAT account's row and there is no id parameter to pass instead.
const OWNER_ID = "user-owner";
const ownerUser = () => ({
  id: OWNER_ID,
  role: "owner" as const,
  workspaceId: "ws-owner",
  provider: "gitlab",
  handle: "owner",
});
const MEMBER_ID = "user-member";
const memberUser = () => ({
  id: MEMBER_ID,
  role: "member" as const,
  workspaceId: "ws-member",
  provider: "gitlab",
  handle: "member",
});

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

describe("google oauth callback — authenticated gate (#118, owner-only in #119)", () => {
  it("completes the exchange for a MEMBER, bound to THEIR row", async () => {
    // Was a 403 in #119, and rightly so: there was one shared credential row.
    // Phase C keys it on userId, so a member's tokens can only land in a member's
    // row — which is what makes this the intended behaviour rather than a hijack.
    currentUserMock.mockResolvedValue(memberUser());

    const res = await GET(new Request(CALLBACK_URL));

    expect(exchangeCodeMock).toHaveBeenCalledWith(
      MEMBER_ID,
      "c",
      "ver",
      "https://dlectroflow.test/api/google/oauth/callback",
    );
    expect(exchangeCodeMock).not.toHaveBeenCalledWith(
      OWNER_ID,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(res.headers.get("location")).toBe(
      "https://dlectroflow.test/?google=connected",
    );
  });

  it("rejects a caller with no account with 403 and exchanges no code", async () => {
    currentUserMock.mockResolvedValue(null);

    const res = await GET(new Request(CALLBACK_URL));

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
    // The credential write never happens. #119's version of this case pinned a
    // MEMBER; the shape that can still fail is "no account at all" — a guest, or
    // a revoked account whose signed cookie is still valid.
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });

  it("rejects a caller with no account holding a valid state + verifier", async () => {
    // Somebody who obtained cookies from a shared browser must still be refused:
    // the gate is on the SESSION, not the cookies. The jar is set explicitly
    // here even though beforeEach already does it — the whole point of this case
    // is that a VALID state + verifier pair is present, so it should be visible
    // in the test rather than inherited.
    cookiesMock.mockResolvedValue(validJar());
    currentUserMock.mockResolvedValue(null);

    const res = await GET(new Request(CALLBACK_URL));

    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("still completes the exchange for the owner", async () => {
    currentUserMock.mockResolvedValue(ownerUser());

    const res = await GET(new Request(CALLBACK_URL));

    // #118 — the exchange is bound to the ACTING user: their id is the first
    // argument, and it is the only thing that decides which row is written.
    expect(exchangeCodeMock).toHaveBeenCalledWith(
      OWNER_ID,
      "c",
      "ver",
      "https://dlectroflow.test/api/google/oauth/callback",
    );
    expect(res.headers.get("location")).toBe(
      "https://dlectroflow.test/?google=connected",
    );
  });

  // ── #211 — a deadline is not a refusal ────────────────────────────────────
  //
  // This route has no client-side bound of any kind: it is reached by a browser
  // navigation back from Google, so until `exchangeCode` carried a deadline a
  // stalled endpoint meant five minutes of blank page for someone who had just
  // clicked Connect. Now that it fails in ten seconds, the redirect has to say
  // something worth reading — a timeout is retryable and a refusal is not, and
  // only one of them should offer to connect again.
  describe("a timed-out exchange (#211)", () => {
    it("redirects with the reason the banner offers a reconnect for", async () => {
      currentUserMock.mockResolvedValue(ownerUser());
      const { GoogleTimeoutError, GOOGLE_TIMEOUT_REASON } =
        await import("@/lib/google");
      exchangeCodeMock.mockRejectedValue(
        new GoogleTimeoutError("nothing was connected. Try connecting again."),
      );

      const res = await GET(new Request(CALLBACK_URL));

      expect(res.headers.get("location")).toBe(
        `https://dlectroflow.test/?google=error&reason=${GOOGLE_TIMEOUT_REASON}`,
      );
    });

    it("never puts the raw abort wording in front of the user", async () => {
      // `err instanceof Error ? err.message` accepts a DOMException, so before
      // #211 the URL — and the banner that prints it — read "The operation was
      // aborted due to timeout".
      currentUserMock.mockResolvedValue(ownerUser());
      const { GoogleTimeoutError } = await import("@/lib/google");
      exchangeCodeMock.mockRejectedValue(
        new GoogleTimeoutError("nothing was connected. Try connecting again."),
      );

      const res = await GET(new Request(CALLBACK_URL));

      // Decoded, because the raw `location` percent-encodes the spaces — a
      // regex over the encoded form passes for the wrong reason.
      const location = decodeURIComponent(res.headers.get("location") ?? "");
      expect(location).not.toMatch(/abort/i);
      expect(location).not.toMatch(/did not respond/i);
      expect(location).not.toMatch(/try connecting again/i);
    });

    it("clears the one-shot cookies, so the retry mints a fresh pair", async () => {
      // The verifier and state are single-use and expire in ten minutes.
      // Leaving them behind would send "try connecting again" into a state
      // mismatch instead of a fresh consent.
      currentUserMock.mockResolvedValue(ownerUser());
      const { GoogleTimeoutError } = await import("@/lib/google");
      exchangeCodeMock.mockRejectedValue(new GoogleTimeoutError("nothing."));

      const res = await GET(new Request(CALLBACK_URL));

      const cookies = res.headers.getSetCookie().join("; ");
      expect(cookies).toMatch(/google_oauth_state=;/);
      expect(cookies).toMatch(/google_pkce_verifier=;/);
    });

    it("still reports a REFUSED exchange as itself, not as a timeout", async () => {
      // The distinction the reason exists for. A 400 from Google is not going
      // to be fixed by pressing the same button again.
      currentUserMock.mockResolvedValue(ownerUser());
      const { GOOGLE_TIMEOUT_REASON } = await import("@/lib/google");
      exchangeCodeMock.mockRejectedValue(
        new Error("Google token exchange failed (400)"),
      );

      const res = await GET(new Request(CALLBACK_URL));

      const location = res.headers.get("location") ?? "";
      expect(location).toContain("google=error");
      expect(location).not.toContain(`reason=${GOOGLE_TIMEOUT_REASON}`);
      expect(decodeURIComponent(location)).toContain(
        "Google token exchange failed (400)",
      );
    });
  });

  it("still rejects a state mismatch (gate relaxed, checks kept)", async () => {
    currentUserMock.mockResolvedValue(ownerUser());

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
