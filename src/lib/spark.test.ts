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

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.dailySpark.findUnique.mockResolvedValue(null);
  prismaMock.dailySpark.upsert.mockImplementation(
    ({
      create,
    }: {
      create: {
        quote: string;
        source: string;
        date: string;
        workspaceId: string;
      };
    }) => Promise.resolve(create),
  );
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
});
