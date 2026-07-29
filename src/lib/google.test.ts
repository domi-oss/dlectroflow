import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decryptToken, encryptToken } from "@/lib/crypto/token-cipher";

// #118 Phase C — GoogleAuth is one row per USER, keyed on `userId`. Every test
// below asserts the `where` clause, not just the outcome: the outcome of a
// correctly-keyed read and of a read that reaches somebody else's row look
// identical from the return value, and only one of them is acceptable.
//
// getAuth() is a genuine `findUnique` now, not an `upsert`. That is a real
// behaviour change worth naming: the old version MATERIALISED a credential row
// on every read, so an anonymous guest page load created one (via the
// unconditional getGoogleStatus() at src/app/(app)/page.tsx:65). A read that
// writes is also a read that cannot answer "is there a row?" honestly.
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    googleAuth: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn(),
    },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const USER = "user_alice";
const OTHER = "user_mallory";

/** A connected row for USER. `expiresAt` in the past forces the refresh path. */
function connectedRow(over: Record<string, unknown> = {}) {
  return {
    id: "ga_1",
    userId: USER,
    accessToken: encryptToken("stale-at"),
    refreshToken: encryptToken("dead-rt"),
    expiresAt: new Date(Date.now() - 1000),
    needsReconnect: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.googleAuth.update.mockResolvedValue({});
  process.env.GOOGLE_CLIENT_ID = "google-cid";
  process.env.GOOGLE_CLIENT_SECRET = "google-csecret";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reads are keyed on the acting user", () => {
  it("getValidAccessToken looks the row up BY userId and nothing else", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({ expiresAt: null, accessToken: encryptToken("live-at") }),
    );
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken(USER)).toBe("live-at");
    expect(prismaMock.googleAuth.findUnique).toHaveBeenCalledWith({
      where: { userId: USER },
    });
  });

  it("returns null for a user with no row — not connected, not an error", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(null);
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken(OTHER)).toBeNull();
  });

  it("returns null when the row exists but holds no token", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({ accessToken: null, refreshToken: null, expiresAt: null }),
    );
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken(USER)).toBeNull();
  });

  it("never reads without a userId in the where clause", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(null);
    const { getValidAccessToken, getGoogleStatus, disconnectGoogle } =
      await import("./google");
    await getValidAccessToken(USER);
    await getGoogleStatus(USER);
    await disconnectGoogle(USER);
    for (const call of prismaMock.googleAuth.findUnique.mock.calls) {
      expect(call[0].where).toEqual({ userId: USER });
    }
  });
});

describe("writes are bound to the acting user", () => {
  function stubTokenExchange() {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: "g-at",
          refresh_token: "g-rt",
          expires_in: 3600,
        }),
      }),
    );
  }

  it("exchangeCode upserts on userId and encrypts both tokens", async () => {
    stubTokenExchange();
    prismaMock.googleAuth.upsert.mockResolvedValue(connectedRow());
    const { exchangeCode } = await import("./google");
    await exchangeCode(USER, "code", "verifier", "https://app/cb");

    const call = prismaMock.googleAuth.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ userId: USER });
    // The CREATE branch must bind the row to the user. Without this the unique
    // index on a nullable column lets Postgres hold many userId IS NULL rows,
    // so a forgotten userId accumulates orphans silently instead of failing.
    expect(call.create.userId).toBe(USER);
    expect(call.create.accessToken).toMatch(/^v1:/);
    expect(decryptToken(call.create.accessToken)).toBe("g-at");
    expect(decryptToken(call.create.refreshToken)).toBe("g-rt");
    expect(decryptToken(call.update.accessToken)).toBe("g-at");
    expect(decryptToken(call.update.refreshToken)).toBe("g-rt");
  });

  it("never lets the UPDATE branch move a row to another user", async () => {
    stubTokenExchange();
    prismaMock.googleAuth.upsert.mockResolvedValue(connectedRow());
    const { exchangeCode } = await import("./google");
    await exchangeCode(USER, "code", "verifier", "https://app/cb");
    // Re-keying an existing row is how one account's connection becomes
    // another's. The update branch writes tokens, never ownership.
    expect(
      prismaMock.googleAuth.upsert.mock.calls[0][0].update,
    ).not.toHaveProperty("userId");
  });

  it("resets needsReconnect on a successful connect", async () => {
    stubTokenExchange();
    prismaMock.googleAuth.upsert.mockResolvedValue(connectedRow());
    const { exchangeCode } = await import("./google");
    await exchangeCode(USER, "code", "verifier", "https://app/cb");
    const call = prismaMock.googleAuth.upsert.mock.calls.at(-1)![0];
    expect(call.create.needsReconnect).toBe(false);
    expect(call.update.needsReconnect).toBe(false);
  });

  it("keeps an existing refresh token when Google returns none", async () => {
    // Google omits refresh_token on a re-consent. Overwriting it with null
    // would silently end the grant on the next expiry.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "g-at2", expires_in: 3600 }),
      }),
    );
    prismaMock.googleAuth.upsert.mockResolvedValue(connectedRow());
    const { exchangeCode } = await import("./google");
    await exchangeCode(USER, "code", "verifier", "https://app/cb");
    expect(
      prismaMock.googleAuth.upsert.mock.calls[0][0].update,
    ).not.toHaveProperty("refreshToken");
  });

  it("throws, and writes nothing, when Google refuses the exchange", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 400, text: async () => "" }),
    );
    const { exchangeCode } = await import("./google");
    await expect(
      exchangeCode(USER, "code", "verifier", "https://app/cb"),
    ).rejects.toThrow(/Google token exchange failed \(400\)/);
    expect(prismaMock.googleAuth.upsert).not.toHaveBeenCalled();
  });
});

describe("invalid_grant handling stays scoped to the acting user", () => {
  it("clears that user's tokens and flags them for reconnect", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(connectedRow());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant" }),
      }),
    );
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken(USER)).toBeNull();
    expect(prismaMock.googleAuth.update).toHaveBeenCalledWith({
      where: { userId: USER },
      data: {
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        needsReconnect: true,
      },
    });
  });

  it("leaves stored tokens untouched on a transient refresh error", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(connectedRow());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: "temporarily_unavailable" }),
      }),
    );
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken(USER)).toBeNull();
    expect(prismaMock.googleAuth.update).not.toHaveBeenCalled();
  });

  it("treats a non-JSON error body as transient rather than fatal", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(connectedRow());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error("not json");
        },
      }),
    );
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken(USER)).toBeNull();
    expect(prismaMock.googleAuth.update).not.toHaveBeenCalled();
  });
});

describe("getGoogleStatus", () => {
  it("answers a guest WITHOUT touching the database", async () => {
    // The old getAuth() was an upsert, so an anonymous page load materialised a
    // credential row. A guest has no account, so there is nothing to look up -
    // and a guest must never learn anything about anyone's connection.
    const { getGoogleStatus } = await import("./google");
    expect(await getGoogleStatus(null)).toEqual({
      configured: true,
      connected: false,
      needsReconnect: false,
    });
    expect(prismaMock.googleAuth.findUnique).not.toHaveBeenCalled();
  });

  it("reports not-connected for a signed-in user with no row", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(null);
    const { getGoogleStatus } = await import("./google");
    expect(await getGoogleStatus(USER)).toEqual({
      configured: true,
      connected: false,
      needsReconnect: false,
    });
  });

  it("surfaces needsReconnect", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        needsReconnect: true,
      }),
    );
    const { getGoogleStatus } = await import("./google");
    expect(await getGoogleStatus(USER)).toMatchObject({
      connected: false,
      needsReconnect: true,
    });
  });

  it("reports configured:false when the instance has no OAuth client", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    prismaMock.googleAuth.findUnique.mockResolvedValue(null);
    const { getGoogleStatus } = await import("./google");
    expect(await getGoogleStatus(USER)).toMatchObject({ configured: false });
  });

  it("says NOT connected when the ciphertext cannot be decrypted", async () => {
    // `connected` used to be Boolean(auth.accessToken) - ciphertext PRESENCE.
    // After a TOKEN_ENC_KEY rotation the UI read "Connected" while every push
    // failed with "not connected", which is the worst of both answers.
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({
        accessToken: "v1:not-a-real-envelope",
        refreshToken: null,
        expiresAt: null,
      }),
    );
    const { getGoogleStatus } = await import("./google");
    expect(await getGoogleStatus(USER)).toMatchObject({
      connected: false,
      // And it is actionable: an unreadable credential is exactly the state a
      // reconnect fixes, so say so rather than showing a bare "Not connected".
      needsReconnect: true,
    });
  });
});

describe("disconnectGoogle", () => {
  it("revokes the refresh token then deletes that user's row only", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({
        accessToken: encryptToken("at"),
        refreshToken: encryptToken("rt"),
        expiresAt: null,
      }),
    );
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const { disconnectGoogle } = await import("./google");
    await disconnectGoogle(USER);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({ method: "POST" }),
    );
    // The refresh token is preferred: revoking it kills the whole grant.
    expect(String(fetchMock.mock.calls[0][1].body)).toContain("token=rt");
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER },
    });
  });

  it("falls back to the access token when there is no refresh token", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({
        accessToken: encryptToken("at"),
        refreshToken: null,
        expiresAt: null,
      }),
    );
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const { disconnectGoogle } = await import("./google");
    await disconnectGoogle(USER);
    expect(String(fetchMock.mock.calls[0][1].body)).toContain("token=at");
  });

  it("still deletes when revoke fails — a dead token must not survive", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({
        accessToken: encryptToken("at"),
        refreshToken: null,
        expiresAt: null,
      }),
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net down")));
    const { disconnectGoogle } = await import("./google");
    await expect(disconnectGoogle(USER)).resolves.toBeUndefined();
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER },
    });
  });

  it("is idempotent for a user with no row and calls no revoke", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(null);
    vi.stubGlobal("fetch", vi.fn());
    const { disconnectGoogle } = await import("./google");
    await expect(disconnectGoogle(USER)).resolves.toBeUndefined();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER },
    });
  });
});

describe("Google Tasks URL construction (#79)", () => {
  const TASKS_API = "https://tasks.googleapis.com/tasks/v1";

  function stubTasksFetch() {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ id: "gtask-1" }) });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  /**
   * The URL actually handed to `fetch`, parsed the way `fetch` parses it.
   *
   * Asserting on the raw string alone is not enough: the URL parser resolves
   * `.`/`..` segments, so a string that *looks* contained can still resolve to
   * a different path. Requiring `parsed.href === raw` proves the identifier
   * smuggled no structure into the URL.
   */
  function urlPassedToFetch(fetchMock: ReturnType<typeof vi.fn>): URL {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const raw = String(fetchMock.mock.calls[0][0]);
    const parsed = new URL(raw);
    expect(parsed.href).toBe(raw);
    return parsed;
  }

  /** Identifiers that must stay inert inside a single path segment. */
  const hostileIds = [
    "../../../oauth2/v1/tokeninfo",
    "..%2f..%2fadmin",
    "%2e%2e%2f%2e%2e%2f",
    "?maxResults=1&key=leak",
    "#fragment",
    "@evil.example",
    "https://evil.example",
    "evil.example:443",
    "lists/other/tasks",
    "a\\b",
  ];

  describe("createGoogleTask", () => {
    it("keeps a normal listId in its own path segment", async () => {
      const fetchMock = stubTasksFetch();
      const { createGoogleTask } = await import("./google");
      await createGoogleTask("tok", "MDk4NzY1NDMyMQ", { title: "t" });
      expect(fetchMock.mock.calls[0][0]).toBe(
        `${TASKS_API}/lists/MDk4NzY1NDMyMQ/tasks`,
      );
    });

    it.each(hostileIds)(
      "a hostile listId (%j) cannot alter the path or query",
      async (listId) => {
        const fetchMock = stubTasksFetch();
        const { createGoogleTask } = await import("./google");
        await createGoogleTask("tok", listId, { title: "t" });

        const url = urlPassedToFetch(fetchMock);
        expect(url.origin).toBe("https://tasks.googleapis.com");
        expect(url.search).toBe("");
        expect(url.hash).toBe("");
        // Exactly ["", "tasks", "v1", "lists", <listId>, "tasks"] — the
        // identifier occupies one segment and adds none.
        const segments = url.pathname.split("/");
        expect(segments).toHaveLength(6);
        expect(segments.slice(0, 4)).toEqual(["", "tasks", "v1", "lists"]);
        expect(segments[5]).toBe("tasks");
      },
    );

    it("percent-encodes a full URL into a single segment", async () => {
      const fetchMock = stubTasksFetch();
      const { createGoogleTask } = await import("./google");
      await createGoogleTask("tok", "https://evil.example", { title: "t" });
      expect(fetchMock.mock.calls[0][0]).toBe(
        `${TASKS_API}/lists/https%3A%2F%2Fevil.example/tasks`,
      );
    });
  });

  describe("patchGoogleTask", () => {
    it("keeps normal identifiers in their own path segments", async () => {
      const fetchMock = stubTasksFetch();
      const { patchGoogleTask } = await import("./google");
      await patchGoogleTask("tok", "list-9", "gtask-9", {
        status: "completed",
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        `${TASKS_API}/lists/list-9/tasks/gtask-9`,
      );
    });

    it.each(hostileIds)(
      "a hostile taskId (%j) cannot alter the path or query",
      async (taskId) => {
        const fetchMock = stubTasksFetch();
        const { patchGoogleTask } = await import("./google");
        await patchGoogleTask("tok", "list-9", taskId, {
          status: "completed",
        });

        const url = urlPassedToFetch(fetchMock);
        expect(url.origin).toBe("https://tasks.googleapis.com");
        expect(url.search).toBe("");
        expect(url.hash).toBe("");
        // ["", "tasks", "v1", "lists", "list-9", "tasks", <taskId>]
        const segments = url.pathname.split("/");
        expect(segments).toHaveLength(7);
        expect(segments.slice(0, 6)).toEqual([
          "",
          "tasks",
          "v1",
          "lists",
          "list-9",
          "tasks",
        ]);
      },
    );

    it.each(hostileIds)(
      "a hostile listId (%j) cannot alter the path or query",
      async (listId) => {
        const fetchMock = stubTasksFetch();
        const { patchGoogleTask } = await import("./google");
        await patchGoogleTask("tok", listId, "gtask-9", {
          status: "completed",
        });

        const url = urlPassedToFetch(fetchMock);
        expect(url.origin).toBe("https://tasks.googleapis.com");
        expect(url.search).toBe("");
        expect(url.hash).toBe("");
        const segments = url.pathname.split("/");
        expect(segments).toHaveLength(7);
        expect(segments.slice(0, 4)).toEqual(["", "tasks", "v1", "lists"]);
        expect(segments[5]).toBe("tasks");
        expect(segments[6]).toBe("gtask-9");
      },
    );
  });

  /**
   * `encodeURIComponent` cannot neutralise these: `.` is an unreserved
   * character so it is left as-is, and the URL parser treats a bare `.`/`..`
   * segment (and `%2e%2e`, which is what encoding the dots would produce) as a
   * directory hop. No Google identifier is ever `.`, `..` or empty, so these
   * must be rejected outright rather than sent.
   */
  describe("dot-segment identifiers are rejected, not sent", () => {
    const dotSegments = ["..", ".", ""];

    it.each(dotSegments)(
      "createGoogleTask rejects listId %j without calling fetch",
      async (listId) => {
        const fetchMock = stubTasksFetch();
        const { createGoogleTask } = await import("./google");
        await expect(
          createGoogleTask("tok", listId, { title: "t" }),
        ).rejects.toThrow(/identifier/i);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it.each(dotSegments)(
      "patchGoogleTask rejects taskId %j without calling fetch",
      async (taskId) => {
        const fetchMock = stubTasksFetch();
        const { patchGoogleTask } = await import("./google");
        await expect(
          patchGoogleTask("tok", "list-9", taskId, { status: "completed" }),
        ).rejects.toThrow(/identifier/i);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );
  });
});
