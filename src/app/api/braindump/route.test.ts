/**
 * Route tests for POST /api/braindump (#175).
 *
 * The write itself is `writeCapture`'s and is tested in
 * `src/lib/capture-write.test.ts`; the unique index is Postgres's and is proved
 * in `src/lib/braindump-client-key-unique.integration.test.ts`. What is asserted
 * here is only what the ROUTE decides, and the two most important of those are
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

import { MissingWorkspaceError, RevokedAccountError } from "@/lib/workspace";
import { CAPTURE_QUEUE_MAX_BYTES } from "@/lib/capture-queue";
import { POST } from "./route";

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

const post = (body: Body | string) =>
  POST(
    new Request("http://localhost/api/braindump", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
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
