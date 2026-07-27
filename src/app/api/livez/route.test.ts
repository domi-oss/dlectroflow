import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Liveness must be process-only: importing/serving it may not touch the DB.
// Poison the prisma module so any accidental DB dependency fails loudly.
vi.mock("@/lib/db", () => {
  throw new Error("livez must not import the DB layer");
});

import { GET } from "./route";
import {
  _resetLLMFailuresForTest,
  recordLLMFailure,
} from "@/lib/observability";

describe("GET /api/livez", () => {
  beforeEach(() => _resetLLMFailuresForTest());
  afterEach(() => vi.restoreAllMocks());

  it("returns 200 alive without any DB access", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("alive");
  });

  it("surfaces the LLM failure counter under both the canonical and deprecated keys", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    recordLLMFailure("anthropic", "breakdown", new Error("x"));
    const body = await (await GET()).json();
    expect(body.llmFailures).toBe(1);
    expect(body.anthropicFailures).toBe(1);
  });
});
