/**
 * Unit tests for spark.ts's `generateQuote()`/`getTodaySpark()` AI path,
 * migrated (#59) from the raw `getAnthropic()` client to the provider-agnostic
 * `getLLM().generate()` seam. Covers what ai-scope-guards.test.ts doesn't:
 * the actual success/failure content mapping, not just the guest guard.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SparkSource } from "@/lib/constants";

const { generateMock, prismaMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  prismaMock: {
    dailySpark: {
      findUnique: vi.fn(),
      // #223 — `getTodaySpark` writes through `createManyAndReturn` +
      // `skipDuplicates` now, not `upsert`. `refreshTodaySpark` still upserts,
      // legitimately: its update payload is non-empty, so Prisma compiles it to
      // a real `INSERT … ON CONFLICT DO UPDATE`.
      createManyAndReturn: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
// #35 Phase A — "is this a guest?" is a database lookup on Workspace.kind now,
// not a comparison against a magic id. These specs already express intent
// through the workspace id they pass in, so map that id back to a kind: the
// signed-in account's workspace here is "owner", everything else is a sandbox.
// The lookup itself is covered by src/lib/workspace-kind.test.ts.
vi.mock("@/lib/workspace-kind", () => ({
  isGuestWorkspace: (id: string) => Promise.resolve(id !== "owner"),
}));

vi.mock("@/lib/models", () => ({
  resolveUtilityModel: () => "claude-opus-4-8",
}));
vi.mock("@/lib/llm", () => ({ getLLM: () => ({ generate: generateMock }) }));

type SparkRow = {
  quote: string;
  source: string;
  date: string;
  workspaceId: string;
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.dailySpark.findUnique.mockResolvedValue(null);
  // The winning caller: `ON CONFLICT DO NOTHING` inserted, so the row it wrote
  // comes back.
  prismaMock.dailySpark.createManyAndReturn.mockImplementation(
    ({ data }: { data: SparkRow }) => Promise.resolve([data]),
  );
  // No `upsert` implementation on purpose. `refreshTodaySpark` still upserts,
  // but this file only exercises `getTodaySpark`, which no longer does — and a
  // stub for a call nobody makes reads as though `upsert` were still on the
  // path under test. It also would not clear between tests if it drifted:
  // `vi.clearAllMocks()` resets calls, not implementations.
});

describe("spark.ts › getTodaySpark", () => {
  it("owner: getLLM().generate() success returns source AI with the generated text", async () => {
    generateMock.mockResolvedValue({
      text: "a warm line",
      toolCall: undefined,
    });
    const { getTodaySpark } = await import("@/lib/spark");

    const result = await getTodaySpark("owner");

    expect(result).toEqual({ quote: "a warm line", source: SparkSource.AI });
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("owner: getLLM().generate() rejection falls back to a canned spark", async () => {
    generateMock.mockRejectedValue(new Error("boom"));
    const { getTodaySpark } = await import("@/lib/spark");

    const result = await getTodaySpark("owner");

    expect(result.source).toBe(SparkSource.Fallback);
    expect(result.quote).toBeTruthy();
  });

  it("guest: never calls getLLM().generate(), always returns a fallback", async () => {
    const { getTodaySpark } = await import("@/lib/spark");

    const result = await getTodaySpark("guest-xyz");

    expect(generateMock).not.toHaveBeenCalled();
    expect(result.source).toBe(SparkSource.Fallback);
    expect(result.quote).toBeTruthy();
  });

  it("losing the insert race returns the WINNER's row, not the quote it generated", async () => {
    // #223 — `createManyAndReturn` + `skipDuplicates` answers a loser with an
    // empty array, so the read-back is the only thing that delivers "keep the
    // first". Returning the locally-generated quote instead would show two
    // requests on the same day two different sparks, one of which is in no
    // table. The real race is proved against Postgres in
    // spark.integration.test.ts; this pins the branch itself, which a
    // concurrency test cannot force deterministically.
    generateMock.mockResolvedValue({ text: "mine", toolCall: undefined });
    prismaMock.dailySpark.createManyAndReturn.mockResolvedValueOnce([]);
    prismaMock.dailySpark.findUnique
      // The leading cache read: still nothing when this caller looked.
      .mockResolvedValueOnce(null)
      // The read-back, after the insert was skipped.
      .mockResolvedValueOnce({ quote: "theirs", source: SparkSource.AI });
    const { getTodaySpark } = await import("@/lib/spark");

    expect(await getTodaySpark("owner")).toEqual({
      quote: "theirs",
      source: SparkSource.AI,
    });
  });

  it("falls back to its own quote if the winning row is gone by the read-back", async () => {
    // The workspace was purged mid-request (guest TTL, account deletion). A
    // dashboard is not worth throwing away over a cache miss on a quote, so the
    // line already in hand is served — uncached, which is the correct answer for
    // a workspace that no longer exists.
    generateMock.mockResolvedValue({ text: "mine", toolCall: undefined });
    prismaMock.dailySpark.createManyAndReturn.mockResolvedValueOnce([]);
    prismaMock.dailySpark.findUnique.mockResolvedValue(null);
    const { getTodaySpark } = await import("@/lib/spark");

    expect(await getTodaySpark("owner")).toEqual({
      quote: "mine",
      source: SparkSource.AI,
    });
  });
});
