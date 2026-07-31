import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const queryRaw = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: queryRaw } }));

import { GET } from "./route";

describe("GET /api/health", () => {
  const originalSha = process.env.BUILD_SHA;

  beforeEach(() => {
    queryRaw.mockReset().mockResolvedValue([{ "1": 1 }]);
  });

  afterEach(() => {
    if (originalSha === undefined) delete process.env.BUILD_SHA;
    else process.env.BUILD_SHA = originalSha;
  });

  it("keeps the existing shape: 200 {status:'ok'} when the DB answers", async () => {
    delete process.env.BUILD_SHA;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing shape: 503 {status:'error'} when the DB is down", async () => {
    queryRaw.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "error" });
  });

  it("reports the build SHA so both instances can be compared (#135)", async () => {
    process.env.BUILD_SHA = "cafc16d2f4b8a9e1c3d5069a7b8c9d0e1f2a3b4c";
    const body = await (await GET()).json();
    expect(body).toEqual({ status: "ok", sha: "cafc16d" });
  });

  it("reports the build SHA on the failure path too, for triage", async () => {
    process.env.BUILD_SHA = "cafc16d2f4b8a9e1c3d5069a7b8c9d0e1f2a3b4c";
    queryRaw.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "error", sha: "cafc16d" });
  });

  it("reports sha: null when the image was built without BUILD_SHA", async () => {
    delete process.env.BUILD_SHA;
    expect(await (await GET()).json()).toEqual({ status: "ok", sha: null });
  });

  it("leaks nothing beyond the short SHA", async () => {
    process.env.BUILD_SHA = "cafc16d2f4b8a9e1c3d5069a7b8c9d0e1f2a3b4c";
    const body = (await (await GET()).json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["sha", "status"]);
    // The full SHA is not a secret, but the endpoint is unauthenticated, so it
    // publishes the shortest thing that answers "which commit is this?".
    expect(body.sha).not.toBe("cafc16d2f4b8a9e1c3d5069a7b8c9d0e1f2a3b4c");
  });
});
