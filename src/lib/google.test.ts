import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decryptToken, encryptToken } from "@/lib/crypto/token-cipher";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    googleAuth: {
      upsert: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn(),
    },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("google token encryption", () => {
  it("getValidAccessToken decrypts a stored (encrypted) access token", async () => {
    const { encryptToken } = await import("@/lib/crypto/token-cipher");
    prismaMock.googleAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: encryptToken("google-access-token"),
      refreshToken: null,
      expiresAt: null,
    });
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken()).toBe("google-access-token");
  });

  it("returns null when no token stored", async () => {
    prismaMock.googleAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
    });
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken()).toBeNull();
  });

  it("exchangeCode persists encrypted tokens in both upsert branches", async () => {
    process.env.GOOGLE_CLIENT_ID = "google-cid";
    process.env.GOOGLE_CLIENT_SECRET = "google-csecret";
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
    const { exchangeCode } = await import("./google");
    await exchangeCode("code", "verifier", "https://app/cb");

    expect(prismaMock.googleAuth.upsert).toHaveBeenCalled();
    const { create, update } = prismaMock.googleAuth.upsert.mock.calls[0][0];
    expect(create.accessToken).toMatch(/^v1:/);
    expect(decryptToken(create.accessToken)).toBe("g-at");
    expect(create.refreshToken).toMatch(/^v1:/);
    expect(decryptToken(create.refreshToken)).toBe("g-rt");
    expect(update.accessToken).toMatch(/^v1:/);
    expect(decryptToken(update.accessToken)).toBe("g-at");
    expect(update.refreshToken).toMatch(/^v1:/);
    expect(decryptToken(update.refreshToken)).toBe("g-rt");
  });
});

describe("invalid_grant handling", () => {
  function connectedRow() {
    return {
      id: "singleton",
      accessToken: encryptToken("stale-at"),
      refreshToken: encryptToken("dead-rt"),
      expiresAt: new Date(Date.now() - 1000), // forces refresh path
      needsReconnect: false,
    };
  }

  it("clears tokens and sets needsReconnect on invalid_grant", async () => {
    process.env.GOOGLE_CLIENT_ID = "google-cid";
    process.env.GOOGLE_CLIENT_SECRET = "google-csecret";
    prismaMock.googleAuth.upsert.mockResolvedValue(connectedRow());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant" }),
      }),
    );
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken()).toBeNull();
    expect(prismaMock.googleAuth.update).toHaveBeenCalledWith({
      where: { id: "singleton" },
      data: {
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        needsReconnect: true,
      },
    });
  });

  it("leaves stored tokens untouched on transient refresh errors", async () => {
    process.env.GOOGLE_CLIENT_ID = "google-cid";
    process.env.GOOGLE_CLIENT_SECRET = "google-csecret";
    prismaMock.googleAuth.upsert.mockResolvedValue(connectedRow());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: "temporarily_unavailable" }),
      }),
    );
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken()).toBeNull();
    expect(prismaMock.googleAuth.update).not.toHaveBeenCalled();
  });
});

describe("status + reconnect healing", () => {
  it("getGoogleStatus surfaces needsReconnect", async () => {
    prismaMock.googleAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      needsReconnect: true,
    });
    const { getGoogleStatus } = await import("./google");
    expect(await getGoogleStatus()).toMatchObject({
      connected: false,
      needsReconnect: true,
    });
  });

  it("storeTokens resets needsReconnect", async () => {
    process.env.GOOGLE_CLIENT_ID = "google-cid";
    process.env.GOOGLE_CLIENT_SECRET = "google-csecret";
    prismaMock.googleAuth.upsert.mockResolvedValue({ id: "singleton" });
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
    const { exchangeCode } = await import("./google");
    await exchangeCode("code", "verifier", "https://app/cb");
    const call = prismaMock.googleAuth.upsert.mock.calls.at(-1)![0];
    expect(call.update.needsReconnect).toBe(false);
    expect(call.create.needsReconnect).toBe(false);
  });
});

describe("disconnectGoogle", () => {
  it("revokes the refresh token then deletes the row", async () => {
    const { encryptToken } = await import("@/lib/crypto/token-cipher");
    prismaMock.googleAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: encryptToken("at"),
      refreshToken: encryptToken("rt"),
      expiresAt: null,
      needsReconnect: false,
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const { disconnectGoogle } = await import("./google");
    await disconnectGoogle();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({ method: "POST" }),
    );
    expect(String(fetchMock.mock.calls[0][1].body)).toContain("token=rt");
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalled();
  });

  it("still deletes when revoke fails", async () => {
    const { encryptToken } = await import("@/lib/crypto/token-cipher");
    prismaMock.googleAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: encryptToken("at"),
      refreshToken: null,
      expiresAt: null,
      needsReconnect: false,
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net down")));
    const { disconnectGoogle } = await import("./google");
    await expect(disconnectGoogle()).resolves.toBeUndefined();
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalled();
  });

  it("is a no-op-safe delete when nothing is stored", async () => {
    prismaMock.googleAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      needsReconnect: false,
    });
    vi.stubGlobal("fetch", vi.fn());
    const { disconnectGoogle } = await import("./google");
    await disconnectGoogle();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalled();
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
