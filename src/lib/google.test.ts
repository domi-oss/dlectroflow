import { readFileSync } from "node:fs";
import path from "node:path";
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
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { disconnectGoogle } = await import("./google");
    await expect(disconnectGoogle(USER)).resolves.toBe(false);
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER },
    });
    // Logged HERE, not by the lifecycle wrapper, so the interactive Disconnect
    // reports a failed revoke too instead of swallowing it.
    expect(JSON.parse(String(errorSpy.mock.calls[0][0])).reason).toBe(
      "revoke_rejected",
    );
    errorSpy.mockRestore();
  });

  it("reports a REJECTED revoke — fetch does not throw on a 4xx", async () => {
    // The realistic failure mode, and the one a try/catch cannot see: Google
    // answers 400 `invalid_token` for a grant it has already expired, or 5xx
    // when it is having a bad day. `fetch` resolves for both, so a disconnect
    // that revoked nothing looked exactly like one that succeeded — and the
    // caller was told the grant had been withdrawn when it had not.
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({
        accessToken: encryptToken("at"),
        refreshToken: null,
        expiresAt: null,
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400 }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { disconnectGoogle } = await import("./google");
    await expect(disconnectGoogle(USER)).resolves.toBe(false);
    // Still deleted. A grant we could not revoke is all the more reason not to
    // keep the token that could not revoke it.
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER },
    });
    expect(JSON.parse(String(errorSpy.mock.calls[0][0])).reason).toBe(
      "revoke_rejected",
    );
    errorSpy.mockRestore();
  });

  it("is idempotent for a user with no row and calls no revoke", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(null);
    vi.stubGlobal("fetch", vi.fn());
    const { disconnectGoogle } = await import("./google");
    // Nothing to revoke is not a failure to revoke.
    await expect(disconnectGoogle(USER)).resolves.toBe(true);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER },
    });
  });

  it("still throws when the tokens cannot be deleted", async () => {
    // The interactive Disconnect (`disconnectGoogleTasks`) depends on this: a
    // row that survived is a disconnect that did not happen, and the person who
    // clicked the button must not be told it did. Only the LIFECYCLE callers
    // contain this failure, and they do it in `tryDisconnectGoogle`.
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({ expiresAt: null }),
    );
    prismaMock.googleAuth.deleteMany.mockRejectedValueOnce(
      new Error("db down"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { disconnectGoogle } = await import("./google");
    await expect(disconnectGoogle(USER)).rejects.toThrow(/db down/);
  });
});

// ── #126 — the lifecycle wrapper ──────────────────────────────────────────
//
// Freezing a member and deleting an account both have to withdraw the grant
// BEFORE the account stops being reachable, and neither may be aborted by a
// revoke that failed. That is one rule, so it is one function — a try/catch
// copied into each caller is how the two come to disagree about it.
describe("tryDisconnectGoogle (#126)", () => {
  it("revokes at Google and leaves no row holding a live token", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({ refreshToken: encryptToken("rt"), expiresAt: null }),
    );
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const { tryDisconnectGoogle } = await import("./google");

    expect(await tryDisconnectGoogle(USER)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({ method: "POST" }),
    );
    expect(String(fetchMock.mock.calls[0][1].body)).toContain("token=rt");
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER },
    });
  });

  // The two failures are NOT the same event and do not leave the same mess, so
  // they are logged apart. The operator's next move differs: one is cleared at
  // Google, the other is a row sitting in this database.
  it("logs revoke_rejected when Google refuses — the tokens are gone, the grant may not be", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({ expiresAt: null }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400 }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { tryDisconnectGoogle } = await import("./google");

    expect(await tryDisconnectGoogle(USER)).toBe(false);
    expect(errorSpy).toHaveBeenCalledOnce();
    const line = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(line.tag).toBe("google_disconnect_failed");
    expect(line.reason).toBe("revoke_rejected");
    expect(line.userId).toBe(USER);
    // The row went, so there is nothing left here to clean up — the grant is
    // cleared at Google's permissions page or not at all.
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER },
    });
    errorSpy.mockRestore();
  });

  it("logs tokens_not_cleared when the row survives, without throwing", async () => {
    // The worse of the two, and the one the caller cannot see: a thrown error
    // would abort the freeze or the deletion that asked for this, so it is
    // contained — but a surviving credential on an account that is about to
    // become unreachable is #126's exact state, reached through a database
    // fault instead of a missing revoke path. It gets its own reason for that.
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({ expiresAt: null }),
    );
    prismaMock.googleAuth.deleteMany.mockRejectedValueOnce(
      new Error("db down"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { tryDisconnectGoogle } = await import("./google");

    expect(await tryDisconnectGoogle(USER)).toBe(false);
    expect(errorSpy).toHaveBeenCalledOnce();
    const line = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(line.tag).toBe("google_disconnect_failed");
    expect(line.reason).toBe("tokens_not_cleared");
    expect(line.userId).toBe(USER);
    expect(line.message).toMatch(/db down/);
    errorSpy.mockRestore();
  });

  it("keeps BOTH signals when the revoke is refused and the row then survives", async () => {
    // The double failure, and the reason the refusal is logged the moment it is
    // observed rather than after the delete: the throw would skip the line, and
    // the operator would be told to clear a database row while never learning
    // that the grant needs clearing at Google as well. Two states, two
    // clean-ups — losing one is exactly what having two reasons is for.
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({ expiresAt: null }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    prismaMock.googleAuth.deleteMany.mockRejectedValueOnce(
      new Error("db down"),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { tryDisconnectGoogle } = await import("./google");

    expect(await tryDisconnectGoogle(USER)).toBe(false);
    const reasons = errorSpy.mock.calls.map(
      (call) => JSON.parse(String(call[0])).reason,
    );
    expect(reasons).toEqual(["revoke_rejected", "tokens_not_cleared"]);
    errorSpy.mockRestore();
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

    /**
     * Duo review (!288) — #195 puts this call inside `completeItem`, which
     * `bulkBrainDumpAction` runs in a sequential loop over every selected row.
     * Node's fetch defaults to a 300 s header timeout, so ONE stalled
     * connection would hold a bulk-complete of twenty to-dos for an hour and
     * forty minutes, and the caller's try/catch cannot help because nothing
     * throws. A deadline is what turns "best-effort" from a promise about
     * errors into a promise about time as well.
     *
     * Same `AbortSignal.timeout` shape as `src/lib/auth/providers.ts`, for the
     * same reason it gives: the response is a few hundred bytes of JSON, so a
     * server that answers promptly and then trickles the body should hit this
     * too, and there is no long stream to truncate.
     */
    it("sends a deadline, so a stalled Google cannot hold a bulk complete open", async () => {
      const fetchMock = stubTasksFetch();
      const { patchGoogleTask } = await import("./google");
      await patchGoogleTask("tok", "list-9", "gtask-9", {
        status: "completed",
      });
      const init = fetchMock.mock.calls[0][1] as { signal?: AbortSignal };
      expect(init.signal).toBeInstanceOf(AbortSignal);
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

// ── #211 — a deadline on every call, and a decided meaning for hitting it ────
//
// Node's fetch defaults to a 300 s header timeout, so a Google endpoint that
// accepts the connection and then goes quiet held six of this module's seven
// calls open for five minutes with no error and nothing on screen. !288 covered
// the seventh (the PATCH, the one call inside a loop) and deliberately did not
// widen; this is the widening.
//
// Two halves, and the second is the one that makes it a fix rather than a
// faster failure: every call gets a deadline, and every call site DECIDES what
// hitting it means. A timeout is not a dead grant, is not a missing task, and
// on the create path is not even proof that nothing was written.
describe("#211 — every Google call carries a deadline", () => {
  /**
   * A rejection shaped exactly like the one a real deadline produces.
   *
   * Measured rather than assumed, on both Node majors in play — `node:22-alpine`
   * (the CI image, v22.23.1) and the local v26.4.0 — against a server that
   * accepts the connection and never answers: `fetch` rejects with the signal's
   * own reason, a `DOMException` whose `name` is `TimeoutError` and whose
   * `message` is "The operation was aborted due to timeout". It is an `Error`
   * (`instanceof Error === true`), which is exactly why the OAuth callback used
   * to put that sentence in a URL: its `err instanceof Error ? err.message`
   * branch accepts it.
   */
  function deadlineRejection(): DOMException {
    return new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
  }

  /** A live credential whose access token expires imminently, so every read
   *  goes down the refresh path. */
  function refreshingRow() {
    return connectedRow({ refreshToken: encryptToken("live-rt") });
  }

  function stubFetch(impl: ReturnType<typeof vi.fn>) {
    vi.stubGlobal("fetch", impl);
    return impl;
  }

  /** The `init` object handed to the Nth `fetch` call. */
  function initOf(fetchMock: ReturnType<typeof vi.fn>, n = 0) {
    return fetchMock.mock.calls[n][1] as { signal?: AbortSignal };
  }

  describe("the signal reaches every call site", () => {
    it("exchangeCode — the OAuth callback, the worst of the six", async () => {
      const fetchMock = stubFetch(
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ access_token: "g-at", expires_in: 3600 }),
        }),
      );
      prismaMock.googleAuth.upsert.mockResolvedValue(connectedRow());
      const { exchangeCode } = await import("./google");
      await exchangeCode(USER, "code", "verifier", "https://app/cb");
      expect(initOf(fetchMock).signal).toBeInstanceOf(AbortSignal);
    });

    it("refreshAccessToken — reached by every path that syncs", async () => {
      prismaMock.googleAuth.findUnique.mockResolvedValue(refreshingRow());
      const fetchMock = stubFetch(
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ access_token: "fresh-at", expires_in: 3600 }),
        }),
      );
      prismaMock.googleAuth.upsert.mockResolvedValue(connectedRow());
      const { getValidAccessToken } = await import("./google");
      await getValidAccessToken(USER);
      expect(initOf(fetchMock).signal).toBeInstanceOf(AbortSignal);
    });

    it("disconnectGoogle's revoke — the Disconnect button waits on it", async () => {
      prismaMock.googleAuth.findUnique.mockResolvedValue(
        connectedRow({ expiresAt: null }),
      );
      const fetchMock = stubFetch(vi.fn().mockResolvedValue({ ok: true }));
      const { disconnectGoogle } = await import("./google");
      await disconnectGoogle(USER);
      expect(initOf(fetchMock).signal).toBeInstanceOf(AbortSignal);
    });

    it("listTaskLists — the list read behind every push", async () => {
      const fetchMock = stubFetch(
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
      );
      const { listTaskLists } = await import("./google");
      await listTaskLists("tok");
      expect(initOf(fetchMock).signal).toBeInstanceOf(AbortSignal);
    });

    it("createGoogleTask — a schedule push", async () => {
      const fetchMock = stubFetch(
        vi
          .fn()
          .mockResolvedValue({ ok: true, json: async () => ({ id: "g-1" }) }),
      );
      const { createGoogleTask } = await import("./google");
      await createGoogleTask("tok", "list-9", { title: "t" });
      expect(initOf(fetchMock).signal).toBeInstanceOf(AbortSignal);
    });

    it("upsertGoogleTask's PATCH branch — a re-schedule", async () => {
      const fetchMock = stubFetch(vi.fn().mockResolvedValue({ ok: true }));
      const { upsertGoogleTask } = await import("./google");
      await upsertGoogleTask("tok", "list-9", "gtask-9", { title: "t" });
      expect(initOf(fetchMock).signal).toBeInstanceOf(AbortSignal);
    });

    /**
     * The checkbox that says "one shared constant, not seven literals".
     *
     * Read off the source because that is the only surface on which "every
     * fetch" is a countable claim — a per-call test can only see the calls
     * somebody remembered to write one for, which is precisely how six of seven
     * went uncovered for a release. #155 and #194 add callers here next, and
     * this is what tells them.
     *
     * What it can see: a `fetch(` with no `AbortSignal.timeout(
     * GOOGLE_FETCH_TIMEOUT_MS)` anywhere, and any second timeout literal
     * reappearing in the module. What it cannot: two deadlines on one call and
     * none on another, which would keep the totals equal. The per-call tests
     * above are what cover that half, and both halves are needed.
     */
    it("one shared constant covers every fetch in the module", async () => {
      const source = readFileSync(
        path.join(process.cwd(), "src/lib/google.ts"),
        "utf8",
      );
      // Block comments and line comments go first: this file's prose says
      // "fetch" a great many times. `//` only opens a comment at a line start
      // or after whitespace, which leaves `https://…` in the endpoint
      // constants alone.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1");
      const calls = code.match(/\bfetch\(/g) ?? [];
      const deadlines =
        code.match(/AbortSignal\.timeout\(GOOGLE_FETCH_TIMEOUT_MS\)/g) ?? [];
      // The non-zero control. A regex that silently matched nothing would
      // report a module with no fetches at all as fully covered.
      expect(calls.length).toBeGreaterThanOrEqual(7);
      expect(deadlines).toHaveLength(calls.length);
      // And no second budget creeps back in beside the shared one.
      expect(code).not.toMatch(/AbortSignal\.timeout\((?!GOOGLE_FETCH)/);
    });

    /**
     * The deadline must fit STRICTLY INSIDE the client's wait, with room to
     * return (Duo review, !368).
     *
     * These are two timers over one operation, and until this assertion existed
     * they were the same number by coincidence. `completeItem`
     * (`braindump.ts:1167`) awaits its Google sync, and the inbox row runs it
     * through `withActionTimeout(fn(), INBOX_ACTION_TIMEOUT_MS)` — so an equal
     * budget means a stalled Google releases the server at the same instant the
     * client gives up, and the response still has to be serialised and sent
     * after that. The client wins, and reports a completion that LANDED
     * LOCALLY as a failed write with Retry armed.
     *
     * The relationship, not the number, is the thing being pinned: whatever
     * either side is retuned to, one Google call plus its response must fit in
     * the shortest wait a client surface will sit through. Asserted against all
     * four rather than only the two that reach Google today, so a shopping or
     * library action that starts syncing later is already covered.
     *
     * What this CANNOT promise, stated because the gap is real: a *pool* of
     * Google calls (a bulk complete, a multi-step push) can still outlast any
     * client wait, and no per-call budget can fix that. That is exactly why
     * every Google leg behind a client-bounded action is best-effort and
     * swallowed, while the surfaces that render a Google timeout message
     * (`runSchedule`, `breakdown-chat.tsx`, `task-schedule.tsx`) carry no
     * client-side wait at all.
     */
    it("fits strictly inside the shortest client-side wait, with margin", async () => {
      const surfaces = [
        "src/components/inbox/inbox-view.tsx",
        "src/components/focus/focus-timer.tsx",
        "src/components/library/library-done-delete.tsx",
        "src/components/shopping/shopping-list.tsx",
      ];
      const budgets = new Map<string, number>();
      for (const file of surfaces) {
        const src = readFileSync(path.join(process.cwd(), file), "utf8");
        // A file-level literal, not a built one: `regexp-source-hygiene`
        // requires every `new RegExp` to come from a literal constant, and a
        // literal here sidesteps the question entirely.
        for (const [, name, raw] of src.matchAll(
          /\b(\w*ACTION_TIMEOUT_MS)\s*=\s*([0-9_]+)/g,
        )) {
          budgets.set(`${file}:${name}`, Number(raw.replace(/_/g, "")));
        }
      }
      // The non-zero control. A regex that matched nothing would make the
      // inequality below vacuously true for every surface at once.
      expect(budgets.size).toBe(surfaces.length);

      const { GOOGLE_FETCH_TIMEOUT_MS } = await import("./google");
      for (const [where, ms] of budgets) {
        expect(ms, `${where} should be a real budget`).toBeGreaterThan(0);
        expect(
          GOOGLE_FETCH_TIMEOUT_MS,
          `${where} must outlast one Google call plus its response`,
        ).toBeLessThan(ms);
      }
      // Named margin rather than "smaller by any amount": the gap has to cover
      // serialising the action's result and returning it over the network.
      const shortest = Math.min(...budgets.values());
      expect(shortest - GOOGLE_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(2_000);
    });
  });

  describe("what a timeout MEANS, per call site", () => {
    it("exchangeCode: a connect that timed out is reconnectable, not a raw abort", async () => {
      // The callback route turns this into `?google=error&reason=…`, which the
      // banner prints. Leaving the DOMException to escape put "The operation
      // was aborted due to timeout" in front of the person who clicked Connect.
      stubFetch(vi.fn().mockRejectedValue(deadlineRejection()));
      const { exchangeCode, GoogleTimeoutError } = await import("./google");
      const failure = exchangeCode(USER, "code", "verifier", "https://app/cb");
      await expect(failure).rejects.toBeInstanceOf(GoogleTimeoutError);
      await expect(failure).rejects.toThrow(/did not respond/i);
      await expect(failure).rejects.not.toThrow(/aborted/i);
      // Nothing was stored, so there is nothing to undo — which is what makes
      // "try connecting again" a safe thing to offer.
      expect(prismaMock.googleAuth.upsert).not.toHaveBeenCalled();
    });

    it("refreshAccessToken: a timeout is transient — no reconnect flag, no cleared tokens", async () => {
      // The sibling of the 503 case above, and the distinction that matters: a
      // deadline says nothing about whether the grant is alive, so writing
      // needsReconnect here would send a connected user to re-consent for a
      // network blip. Only `invalid_grant` means the grant is dead.
      prismaMock.googleAuth.findUnique.mockResolvedValue(refreshingRow());
      stubFetch(vi.fn().mockRejectedValue(deadlineRejection()));
      const { getValidAccessToken } = await import("./google");
      expect(await getValidAccessToken(USER)).toBeNull();
      expect(prismaMock.googleAuth.update).not.toHaveBeenCalled();
      expect(prismaMock.googleAuth.upsert).not.toHaveBeenCalled();
    });

    it("disconnectGoogle: a timed-out revoke still deletes the tokens and says the grant may stand", async () => {
      // No new branch — the existing catch already draws this line, and the
      // deadline just makes the Disconnect button answer in seconds instead of
      // minutes. Locked here because it is the one call site where "we asked
      // and got no answer" must NOT block the local clean-up.
      prismaMock.googleAuth.findUnique.mockResolvedValue(
        connectedRow({ expiresAt: null }),
      );
      stubFetch(vi.fn().mockRejectedValue(deadlineRejection()));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { disconnectGoogle } = await import("./google");
      await expect(disconnectGoogle(USER)).resolves.toBe(false);
      expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER },
      });
      expect(JSON.parse(String(errorSpy.mock.calls[0][0])).reason).toBe(
        "revoke_rejected",
      );
      errorSpy.mockRestore();
    });

    it("listTaskLists: says Google was slow, and that nothing was scheduled", async () => {
      stubFetch(vi.fn().mockRejectedValue(deadlineRejection()));
      const { listTaskLists, GoogleTimeoutError } = await import("./google");
      const failure = listTaskLists("tok");
      await expect(failure).rejects.toBeInstanceOf(GoogleTimeoutError);
      // `pushStepsToGoogleTasks` renders this message verbatim.
      await expect(failure).rejects.toThrow(/nothing was scheduled/i);
    });

    it("createGoogleTask: admits the task may exist, because the request may have landed", async () => {
      // The honest half. A deadline fires on OUR side; Google may well have
      // created the task before going quiet, so telling the user "nothing
      // happened" would send them into a duplicate.
      stubFetch(vi.fn().mockRejectedValue(deadlineRejection()));
      const { createGoogleTask, GoogleTimeoutError } = await import("./google");
      const failure = createGoogleTask("tok", "list-9", { title: "t" });
      await expect(failure).rejects.toBeInstanceOf(GoogleTimeoutError);
      await expect(failure).rejects.toThrow(/may/i);
    });

    it("upsertGoogleTask: a timed-out PATCH does not fall through and create a duplicate", async () => {
      // The 404 branch recreates the task on purpose. A deadline is not a 404 —
      // the task is probably still there — so the fall-through must not be
      // reached, or a re-schedule of a stalled connection leaves the user with
      // two Google tasks and Reclaim with two calendar blocks.
      const fetchMock = stubFetch(
        vi.fn().mockRejectedValue(deadlineRejection()),
      );
      const { upsertGoogleTask, GoogleTimeoutError } = await import("./google");
      await expect(
        upsertGoogleTask("tok", "list-9", "gtask-9", { title: "t" }),
      ).rejects.toBeInstanceOf(GoogleTimeoutError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("patchGoogleTask: rejects, which every best-effort caller already reads as not-synced", async () => {
      stubFetch(vi.fn().mockRejectedValue(deadlineRejection()));
      const { patchGoogleTask, GoogleTimeoutError } = await import("./google");
      await expect(
        patchGoogleTask("tok", "list-9", "gtask-9", { status: "completed" }),
      ).rejects.toBeInstanceOf(GoogleTimeoutError);
    });

    it("a rejection that is NOT our deadline keeps its own identity", async () => {
      // The classifier keys on the name a real abort carries. A DNS failure or
      // a dropped socket is a different fault with a different message, and
      // dressing it up as a timeout would send the reader looking for a slow
      // network instead of an unreachable one.
      stubFetch(vi.fn().mockRejectedValue(new TypeError("fetch failed")));
      const { listTaskLists, GoogleTimeoutError } = await import("./google");
      const failure = listTaskLists("tok");
      await expect(failure).rejects.toThrow(/fetch failed/);
      await expect(failure).rejects.not.toBeInstanceOf(GoogleTimeoutError);
    });
  });
});
