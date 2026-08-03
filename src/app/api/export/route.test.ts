/**
 * Route tests for GET /api/export (#129).
 *
 * The archive's contents are covered by the serialiser tests and the
 * cross-workspace guarantee by `collect.integration.test.ts`, so this file is
 * about the four things only the route decides: that it passes the SESSION's ids
 * and nothing else to `collectExport`, that it refuses without a session, that it
 * meters, and that the response headers actually make a browser download a zip.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  currentWorkspaceIdMock,
  currentUserMock,
  collectExportMock,
  buildExportArchiveMock,
  cooldownCheckMock,
} = vi.hoisted(() => ({
  currentWorkspaceIdMock: vi.fn(),
  currentUserMock: vi.fn(),
  collectExportMock: vi.fn(),
  buildExportArchiveMock: vi.fn(),
  cooldownCheckMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  currentUser: currentUserMock,
}));
vi.mock("@/lib/export/collect", () => ({ collectExport: collectExportMock }));
vi.mock("@/lib/export/bundle", () => ({
  buildExportArchive: buildExportArchiveMock,
}));
vi.mock("@/lib/export/cooldown", () => ({
  exportCooldown: { check: cooldownCheckMock },
}));

import { GET } from "./route";

const ARCHIVE_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("ws-1");
  currentUserMock.mockResolvedValue({ id: "user-1", role: "member" });
  collectExportMock.mockResolvedValue({ snapshot: true });
  buildExportArchiveMock.mockReturnValue({
    filename: "dlectroflow-export-sam-2026-08-03.zip",
    bytes: ARCHIVE_BYTES,
  });
  cooldownCheckMock.mockReturnValue({ allowed: true });
});

describe("GET /api/export", () => {
  it("serves the archive as a zip download", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="dlectroflow-export-sam-2026-08-03.zip"',
    );
    expect(res.headers.get("Content-Length")).toBe("7");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(ARCHIVE_BYTES);
  });

  it("never lets the response be cached", async () => {
    // The body is the whole of somebody's account.
    const res = await GET();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("passes the SESSION's workspace and account, and nothing else", async () => {
    // The security property, asserted at the boundary: the route takes no
    // arguments, so these two ids are the only ones it could pass.
    await GET();
    expect(collectExportMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "user-1",
    });
  });

  it("takes no arguments at all — there is no id for a caller to supply", async () => {
    // Pinned deliberately, in the shape src/app/actions/account.test.ts pins
    // `deleteOwnAccount`: a `userId` parameter with an `=== me.id` check would be
    // the same feature and a far worse one, because the guard is a line of code a
    // refactor can drop while an absent argument cannot be forged.
    expect(GET.length).toBe(0);
  });

  it("exports a guest sandbox, with no account", async () => {
    // Decided deliberately (#129): a sandbox expires in about a day, so an export
    // is the only way anything done in one survives.
    currentUserMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(collectExportMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: null,
    });
  });

  it("answers 401 with no session of any kind, and reads nothing", async () => {
    currentWorkspaceIdMock.mockRejectedValue(new Error("no workspace"));
    const res = await GET();
    expect(res.status).toBe(401);
    expect(collectExportMock).not.toHaveBeenCalled();
    expect(cooldownCheckMock).not.toHaveBeenCalled();
  });

  it("answers 429 with Retry-After when the cooldown refuses, without doing the work", async () => {
    cooldownCheckMock.mockReturnValue({ allowed: false, retryAfterSec: 42 });
    const res = await GET();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(await res.text()).toContain("42 seconds");
    // The entire point of metering this endpoint: the expensive part never runs.
    expect(collectExportMock).not.toHaveBeenCalled();
    expect(buildExportArchiveMock).not.toHaveBeenCalled();
  });

  it("meters the workspace, not the account", async () => {
    // One busy account must never be able to refuse somebody else their own data.
    await GET();
    expect(cooldownCheckMock).toHaveBeenCalledWith("ws-1");
  });

  it("meters before resolving the account, so a refusal costs one query at most", async () => {
    cooldownCheckMock.mockReturnValue({ allowed: false, retryAfterSec: 5 });
    await GET();
    expect(currentUserMock).not.toHaveBeenCalled();
  });
});
