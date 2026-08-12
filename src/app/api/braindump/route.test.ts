/**
 * Route tests for POST /api/braindump (#175).
 *
 * The write itself is `writeCapture`'s and is tested in
 * `src/lib/capture-write.test.ts`; the unique index is Postgres's and is proved
 * in `src/lib/braindump-client-key-unique.integration.test.ts`. What is asserted
 * here is only what the ROUTE decides, and the most important of those are
 * security properties rather than status codes:
 *
 *  1. **The body's `workspaceId` is never trusted for authorization.** The
 *     workspace comes from the cookie, exactly as everywhere else in the app, and
 *     the declared one is only ever COMPARED. A mismatch can produce a refusal
 *     and nothing else — client input can narrow access, never widen it.
 *  2. **409 and 403 share neither a status nor a message.** 409 means the session
 *     moved on and signing in again fixes it; 403 means the account was revoked
 *     and signing in again cannot. `RevokedAccountError` is a SUBCLASS of
 *     `MissingWorkspaceError`, so the order of the two `instanceof` branches is
 *     load-bearing and is pinned below.
 *  3. **A cross-origin POST is refused, and refused as a 400.** A route handler
 *     gets none of the CSRF protection Next gives a server action. The status
 *     matters as much as the refusal: 403 and 409 are already spoken for in the
 *     client's outcome map, so a CSRF rejection must not borrow either.
 *
 * The error classes are the REAL ones, not stubs: the route narrows on
 * `instanceof`, and a fake would make both refusal branches pass for the wrong
 * reason (the shape `src/app/api/export/route.test.ts` uses, for the same
 * reason).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { currentWorkspaceIdMock, writeCaptureMock, revalidatePathMock } =
  vi.hoisted(() => ({
    currentWorkspaceIdMock: vi.fn(),
    writeCaptureMock: vi.fn(),
    revalidatePathMock: vi.fn(),
  }));

vi.mock("@/lib/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspace")>();
  return {
    MissingWorkspaceError: actual.MissingWorkspaceError,
    RevokedAccountError: actual.RevokedAccountError,
    currentWorkspaceId: currentWorkspaceIdMock,
  };
});
vi.mock("@/lib/capture-write", () => ({ writeCapture: writeCaptureMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
// Stubbed rather than left real, as `logout/route.test.ts` does: `requestOrigin`
// reads PUBLIC_ORIGIN, which `config/vitest.config.ts` deliberately does not
// forward, so a real one would answer differently depending on the shell the
// suite was launched from.
vi.mock("@/lib/origin");

import { MissingWorkspaceError, RevokedAccountError } from "@/lib/workspace";
import { CAPTURE_QUEUE_MAX_BYTES, newClientKey } from "@/lib/capture-queue";
import { requestOrigin } from "@/lib/origin";
import { POST } from "./route";

/** The origin this app is served from, as `requestOrigin` reports it. */
const APP_ORIGIN = "https://dlectroflow.dev";

/** The workspace the COOKIE resolves to. Never anything a request supplied. */
const SESSION_WS = "ws-session";

type Body = Record<string, unknown>;

/** A well-formed capture declaring the session's own workspace. */
const validBody = (over: Body = {}): Body => ({
  clientKey: "3f2b9c1e-0d4a-4c8e-9f11-a7b3c5d6e7f8",
  text: "buy milk",
  workspaceId: SESSION_WS,
  ...over,
});

const post = (body: Body | string, headers: Record<string, string> = {}) =>
  POST(
    new Request("http://localhost/api/braindump", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requestOrigin).mockReturnValue(APP_ORIGIN);
  currentWorkspaceIdMock.mockResolvedValue(SESSION_WS);
  writeCaptureMock.mockResolvedValue("created");
});

describe("POST /api/braindump — the happy paths", () => {
  it("answers 201 when the capture is written", async () => {
    const res = await post(validBody());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: "saved" });
  });

  it("passes the SESSION's workspace, plus the text and key from the body", async () => {
    await post(validBody({ text: "water the plants {can under sink}" }));
    expect(writeCaptureMock).toHaveBeenCalledExactlyOnceWith({
      workspaceId: SESSION_WS,
      text: "water the plants {can under sink}",
      clientKey: "3f2b9c1e-0d4a-4c8e-9f11-a7b3c5d6e7f8",
    });
  });

  it("answers 200 — not 201, and not an error — for a capture already saved", async () => {
    // The whole point of `clientKey`: `withActionTimeout` bounds how long the UI
    // waits, not how long the request runs, so a write that timed out at 10s and
    // landed at 14s comes back on the next flush as a duplicate. The queue drops
    // the entry on 200 exactly as it does on 201.
    writeCaptureMock.mockResolvedValue("duplicate");
    const res = await post(validBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "duplicate" });
  });

  it("invalidates the inbox when a capture was written", async () => {
    await post(validBody());
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  it("does NOT invalidate the inbox for a duplicate — nothing changed", async () => {
    writeCaptureMock.mockResolvedValue("duplicate");
    await post(validBody());
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("never lets a response be cached", async () => {
    const res = await post(validBody());
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });
});

// Next protects server actions against CSRF automatically; a plain route handler
// gets none of that, and the only reason this route exists is that a service
// worker cannot replay a server action. So the protection was lost in that trade
// and something has to replace it.
//
// The pattern is `src/app/api/auth/logout/route.ts`'s, copied rather than
// reinvented so the two cannot drift the way `focus-timer.tsx` and the inbox
// notice already did once: reject a PRESENT Origin that does not match, and allow
// a MISSING one for non-browser clients, which POST-only plus SameSite=lax still
// bound.
describe("POST /api/braindump — CSRF (CWE-352)", () => {
  it("refuses a cross-origin POST and writes nothing", async () => {
    const res = await post(validBody(), { origin: "https://evil.example.com" });

    expect(res.status).toBe(400);
    expect(writeCaptureMock).not.toHaveBeenCalled();
    // Before the session, so a forged request cannot make the app do the two
    // queries `currentWorkspaceId()` costs — which is the one thing a cross-site
    // POST could actually achieve here even before this guard existed.
    expect(currentWorkspaceIdMock).not.toHaveBeenCalled();
  });

  // ⚠️ The status is load-bearing, not cosmetic. `capture-queue.ts` maps outcomes
  // by STATUS — 403 → `account-revoked`, 409 → `session-expired` — and both of
  // those carry copy about signing in. A CSRF rejection answering either would
  // tell somebody their account had been revoked because a subdomain page forged a
  // request, which is the exact collapse this feature's spec has been reviewed for
  // twice. 400 lands in the client's "anything else → retry" arm, which keeps the
  // words: the right direction for a guard that should never fire on a real client.
  it("does NOT answer 403 or 409, which the queue reads as something else entirely", async () => {
    const res = await post(validBody(), { origin: "https://evil.example.com" });

    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(409);
    // And it is not in the FlushOutcome vocabulary at all.
    const body = await res.json();
    expect(body).not.toHaveProperty("status");
    // Says why, so a misconfigured PUBLIC_ORIGIN refusing every capture is
    // diagnosable — but never names the origin it would have accepted.
    expect(body.error).toBe("Request origin not allowed");
    expect(JSON.stringify(body)).not.toContain(APP_ORIGIN);
  });

  it("allows a POST whose Origin is this app", async () => {
    const res = await post(validBody(), { origin: APP_ORIGIN });
    expect(res.status).toBe(201);
  });

  // Deliberate, and the same call `logout/route.ts` made: a missing Origin is a
  // non-browser client, and refusing it would buy nothing a browser attacker
  // cannot already do while breaking curl, and every existing test above.
  it("allows a POST with no Origin header at all", async () => {
    const res = await post(validBody());
    expect(res.status).toBe(201);
  });

  // The one caller it would be catastrophic to break. The spec's background flush
  // runs in `public/sw.js` — the only path that works while the app is closed, so
  // a silent failure there is invisible rather than reported.
  //
  // That `sync` handler is NOT written yet (`public/sw.js` today hosts
  // notifications only), so what is pinned here is the property it will depend on:
  // a worker registered for this app has this app's origin, and `fetch` attaches
  // `Origin` on a POST — so it arrives on the matching arm. Asserted both ways
  // because whether a same-origin POST carries the header at all is the browser's
  // choice, not ours, and the worker must pass either way.
  it.each([
    ["Origin attached by fetch", { origin: APP_ORIGIN }],
    ["Origin omitted", {}],
  ])(
    "lets the service worker's own flush through — %s",
    async (_label, hdrs) => {
      const res = await post(validBody(), hdrs);
      expect(res.status).toBe(201);
      expect(writeCaptureMock).toHaveBeenCalledOnce();
    },
  );

  // A near-miss is the case a substring or `startsWith` check waves through, and
  // it is the realistic shape of an attack: register a lookalike host.
  it.each([
    "https://dlectroflow.dev.evil.example",
    "http://dlectroflow.dev",
    "https://evil.dlectroflow.dev",
    "null",
  ])("refuses the near-miss origin %s", async (origin) => {
    const res = await post(validBody(), { origin });
    expect(res.status).toBe(400);
    expect(writeCaptureMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/braindump — the declared workspaceId can only narrow", () => {
  it("answers 409 when the resolved workspace is not the declared one, and writes nothing", async () => {
    // The expired-cookie hole this closes without touching middleware: a queued
    // OWNER capture flushing after the cookie lapsed resolves to a fresh GUEST
    // sandbox, and must refuse rather than land somewhere the person will never
    // look again.
    const res = await post(validBody({ workspaceId: "ws-somebody-else" }));
    expect(res.status).toBe(409);
    expect(writeCaptureMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("refuses rather than writing to the workspace the BODY named", async () => {
    // The security invariant stated as the thing that must not happen: there is
    // no input to this route that causes a write to a workspace the cookie did
    // not resolve. The mismatch branch is the only place the declared id is read
    // at all, and it can only ever produce this refusal.
    await post(validBody({ workspaceId: "ws-somebody-else" }));
    expect(writeCaptureMock).not.toHaveBeenCalled();
  });

  it("does not echo the resolved workspace id back to the caller", async () => {
    // Otherwise the refusal is a workspace-id oracle: a caller could learn whose
    // session it is holding by declaring a wrong id on purpose. Same reasoning as
    // the per-workspace (rather than global) unique index — the refusal itself
    // must not carry information across the tenancy boundary.
    const res = await post(validBody({ workspaceId: "ws-somebody-else" }));
    expect(await res.text()).not.toContain(SESSION_WS);
  });
});

describe("POST /api/braindump — the two refusals stay distinguishable", () => {
  it("answers 403 for a revoked account, and writes nothing", async () => {
    currentWorkspaceIdMock.mockRejectedValue(new RevokedAccountError());
    const res = await post(validBody());
    expect(res.status).toBe(403);
    expect(writeCaptureMock).not.toHaveBeenCalled();
  });

  it("does NOT answer 409 for a revoked account, despite the subclass", async () => {
    // `RevokedAccountError extends MissingWorkspaceError`, so a branch order that
    // narrows on the parent first would collapse both refusals into one — and
    // tell a person whose account was revoked to sign in again, which #220 has
    // already made impossible. They would loop forever.
    currentWorkspaceIdMock.mockRejectedValue(new RevokedAccountError());
    const res = await post(validBody());
    expect(res.status).not.toBe(409);
    expect(res.status).not.toBe(401);
  });

  it("gives the two refusals different statuses AND different bodies", async () => {
    currentWorkspaceIdMock.mockRejectedValue(new RevokedAccountError());
    const revoked = await post(validBody());
    const revokedBody = await revoked.json();

    vi.clearAllMocks();
    currentWorkspaceIdMock.mockResolvedValue(SESSION_WS);
    const mismatch = await post(validBody({ workspaceId: "ws-other" }));
    const mismatchBody = await mismatch.json();

    expect(revoked.status).not.toBe(mismatch.status);
    expect(revokedBody).not.toEqual(mismatchBody);
    // Spelled out, because the client's strip renders different copy off each and
    // `capture-queue.ts` keeps them as two values of a union for this reason.
    expect(revokedBody).toEqual({ status: "account-revoked" });
    expect(mismatchBody).toEqual({ status: "session-expired" });
  });

  it("answers 401 with no session of any kind", async () => {
    currentWorkspaceIdMock.mockRejectedValue(new MissingWorkspaceError());
    const res = await post(validBody());
    expect(res.status).toBe(401);
    expect(writeCaptureMock).not.toHaveBeenCalled();
  });

  it("does NOT turn a database failure into a refusal", async () => {
    // `currentWorkspaceId()` reads the account's status and upserts `lastSeenAt`,
    // so it fails for reasons that have nothing to do with the caller. Answering
    // 401/403 over an outage tells somebody to re-authenticate about a problem
    // they cannot fix, and hides a 500 from whoever is watching the logs — the
    // same distinction `/api/export` draws.
    currentWorkspaceIdMock.mockRejectedValue(new Error("connection refused"));
    await expect(post(validBody())).rejects.toThrow(/connection refused/);
  });
});

describe("POST /api/braindump — a request that could never be a capture", () => {
  it("answers 400 for a body that is not JSON", async () => {
    const res = await post("not json at all");
    expect(res.status).toBe(400);
    expect(writeCaptureMock).not.toHaveBeenCalled();
  });

  it("answers 400 for a JSON body that is not an object", async () => {
    const res = await post("[1,2,3]");
    expect(res.status).toBe(400);
    expect(writeCaptureMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing clientKey", { clientKey: undefined }],
    ["a blank clientKey", { clientKey: "" }],
    ["a non-string clientKey", { clientKey: 7 }],
    [
      "a clientKey outside the generated alphabet",
      { clientKey: "key with space" },
    ],
    ["an over-long clientKey", { clientKey: "a".repeat(65) }],
    ["a missing text", { text: undefined }],
    ["a non-string text", { text: { toString: "nope" } }],
    ["a missing workspaceId", { workspaceId: undefined }],
    ["a non-string workspaceId", { workspaceId: 7 }],
  ])("answers 400 for %s, and writes nothing", async (_why, over) => {
    const res = await post(validBody(over));
    expect(res.status).toBe(400);
    expect(writeCaptureMock).not.toHaveBeenCalled();
  });

  it("answers 400 when the text parses to nothing", async () => {
    // `writeCapture` reads the PARSED text, so this is its answer rather than a
    // second empty check here — one write path, one set of semantics.
    writeCaptureMock.mockResolvedValue("empty");
    const res = await post(validBody({ text: "   \n\t " }));
    expect(res.status).toBe(400);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("answers 413 for an oversized body, without touching the session or the database", async () => {
    const res = await post(
      validBody({ text: "x".repeat(2 * CAPTURE_QUEUE_MAX_BYTES) }),
    );
    expect(res.status).toBe(413);
    expect(currentWorkspaceIdMock).not.toHaveBeenCalled();
    expect(writeCaptureMock).not.toHaveBeenCalled();
  });

  it("accepts a capture as large as the queue itself can hold", async () => {
    // The size guard must never be stricter than `enqueue`'s own bound, or the
    // queue would accept words it can then never flush — a capture stuck forever
    // with the user told it is waiting to save.
    const res = await post(
      validBody({ text: "x".repeat(CAPTURE_QUEUE_MAX_BYTES - 500) }),
    );
    expect(res.status).toBe(201);
  });

  // ⚠️ #175 — the guard is a BYTE budget and must be measured in bytes. This pair
  // is the only thing in the suite that can tell UTF-8 bytes from UTF-16 code
  // units: every other body here is ASCII, where the two are equal, so a
  // `rawBody.length` check passes all of them. `MAX_BODY_BYTES` is derived from
  // `CAPTURE_QUEUE_MAX_BYTES`, which `enqueue` measures with `byteLength` — so a
  // code-unit check on this side lets a non-Latin body through at up to three
  // times the budget the two are supposed to share. Caught in review of !334.
  //
  // Measured with `Buffer.byteLength` rather than the exported `byteLength`
  // deliberately: an independent ruler, so a broken helper cannot make its own
  // test agree with it.
  it("answers 413 for a body inside the budget in characters but over it in bytes", async () => {
    // U+8003 is one UTF-16 code unit and three UTF-8 bytes, which is the widest
    // gap the BMP offers. 60k of them serialise to ~180 KB — well over the ~131 KB
    // budget — while `rawBody.length` reads ~60k, well under it.
    const body = JSON.stringify(validBody({ text: "考".repeat(60_000) }));
    expect(body.length).toBeLessThan(2 * CAPTURE_QUEUE_MAX_BYTES);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(
      2 * CAPTURE_QUEUE_MAX_BYTES,
    );

    const res = await post(body);
    expect(res.status).toBe(413);
    expect(currentWorkspaceIdMock).not.toHaveBeenCalled();
    expect(writeCaptureMock).not.toHaveBeenCalled();
  });

  it("still accepts a multi-byte capture whose BYTES fit the budget", async () => {
    // The control on the test above, and the reason it cannot be passed by
    // refusing everything: measuring bytes must not become "refuse non-Latin
    // text". 18k of the same character is ~54 KB, inside the route's budget AND
    // inside `enqueue`'s own 64 KB — so this is a capture the queue really can
    // hold and really can flush.
    const body = JSON.stringify(validBody({ text: "考".repeat(18_000) }));
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(
      CAPTURE_QUEUE_MAX_BYTES,
    );

    const res = await post(body);
    expect(res.status).toBe(201);
  });

  // ⚠️ Cross-file agreement, asserted rather than reasoned about. `newClientKey`
  // has three tiers producing three different SHAPES, and `CLIENT_KEY_SHAPE` has to
  // accept all of them — a key this route refuses is not a visible error, it is a
  // capture that can never flush: queued forever while the strip says it is waiting
  // to save. The third tier is the one no test could have caught by accident,
  // because it only fires on a runtime with no `crypto` at all.
  it("accepts a clientKey from every tier of newClientKey, fallback included", async () => {
    const realCrypto = newClientKey();

    vi.stubGlobal("crypto", {});
    const clockFallback = newClientKey();
    vi.unstubAllGlobals();

    // The fallback really is the shape under test, not another UUID.
    expect(clockFallback.startsWith("clk-")).toBe(true);

    for (const clientKey of [realCrypto, clockFallback]) {
      writeCaptureMock.mockResolvedValue("created");
      const res = await post(validBody({ clientKey }));
      expect(res.status).toBe(201);
    }
  });

  it("refuses a malformed body BEFORE resolving the session", async () => {
    // Cheap refusals first: this route is reachable with a guest cookie, so a
    // request that could not be a capture whatever the session says must not cost
    // the two queries `currentWorkspaceId()` makes. A queued capture cannot be
    // malformed — `isQueuedCapture` validates every entry `readQueue` returns —
    // so this ordering cannot strand one.
    await post("not json at all");
    expect(currentWorkspaceIdMock).not.toHaveBeenCalled();
  });
});
