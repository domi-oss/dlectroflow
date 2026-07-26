/**
 * Route tests for POST /api/breakdown.
 *
 * Drives the route through a fake `@/lib/llm` provider (no real network) and
 * asserts the NDJSON `StreamEvent` contract (`src/lib/breakdown.ts`) is
 * unchanged after the migration off the raw `@anthropic-ai/sdk` client:
 *   - `text` events are forwarded as the fake provider streams them
 *   - a `steps` event carries the tool call's `input` once the provider
 *     yields its `final` event
 *   - a provider throw produces a `fallback` event with `reason:"error"` and
 *     `localBreakdown()` data (never a dead stream)
 * Also covers the two invariants the brief calls out: guests never reach the
 * LLM at all when blocked (canned fallback only), and a guest's quota is
 * refunded when the LLM call itself fails.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent } from "@/lib/breakdown";

const {
  isOwnerRequestMock,
  currentWorkspaceIdMock,
  getSettingsMock,
  clientIpHashMock,
  consumeGuestBreakdownMock,
  refundGuestBreakdownMock,
  recordAnthropicFailureMock,
  streamImpl,
} = vi.hoisted(() => {
  return {
    isOwnerRequestMock: vi.fn(),
    currentWorkspaceIdMock: vi.fn(),
    getSettingsMock: vi.fn(),
    clientIpHashMock: vi.fn(),
    consumeGuestBreakdownMock: vi.fn(),
    refundGuestBreakdownMock: vi.fn(),
    recordAnthropicFailureMock: vi.fn(),
    // Reassigned per-test to control what the fake provider's stream() does.
    streamImpl: { current: undefined as unknown },
  };
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("@/lib/workspace", () => ({
  isOwnerRequest: isOwnerRequestMock,
  currentWorkspaceId: currentWorkspaceIdMock,
}));

vi.mock("@/lib/settings-read", () => ({
  getSettings: getSettingsMock,
}));

vi.mock("@/lib/guest-quota", () => ({
  clientIpHash: clientIpHashMock,
  consumeGuestBreakdown: consumeGuestBreakdownMock,
  refundGuestBreakdown: refundGuestBreakdownMock,
}));

vi.mock("@/lib/observability", () => ({
  recordAnthropicFailure: recordAnthropicFailureMock,
}));

vi.mock("@/lib/llm", () => ({
  getLLM: () => ({
    id: "anthropic",
    supportsTools: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, streamImpl is set per-test
    stream: (...args: any[]) => (streamImpl.current as (...a: any[]) => AsyncGenerator<unknown>)(...args),
    generate: vi.fn(),
  }),
}));

async function readAllEvents(res: Response): Promise<StreamEvent[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StreamEvent);
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/breakdown", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const REQUEST_BODY = {
  title: "clean the garage",
  currentProposal: null,
  feedback: { kind: "propose" },
};

describe("POST /api/breakdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isOwnerRequestMock.mockResolvedValue(true);
    currentWorkspaceIdMock.mockResolvedValue("owner");
    getSettingsMock.mockResolvedValue(null);
    clientIpHashMock.mockReturnValue("hash-1");
    consumeGuestBreakdownMock.mockResolvedValue({ allowed: true });
    refundGuestBreakdownMock.mockResolvedValue(undefined);
  });

  it("forwards text events and a steps event carrying the tool call's input", async () => {
    streamImpl.current = async function* () {
      yield { type: "text", delta: "hi " };
      yield { type: "text", delta: "there" };
      yield {
        type: "final",
        result: {
          text: "hi there",
          toolCall: { name: "propose_steps", input: { parentEmoji: "🗂️", steps: [] } },
        },
      };
    };

    const { POST } = await import("./route");
    const res = await POST(postRequest(REQUEST_BODY));
    const events = await readAllEvents(res);

    expect(events).toContainEqual({ type: "text", delta: "hi " });
    expect(events).toContainEqual({ type: "text", delta: "there" });
    expect(events).toContainEqual({
      type: "steps",
      data: { parentEmoji: "🗂️", steps: [] },
    });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("sends a fallback/error event with localBreakdown data when the provider throws", async () => {
    streamImpl.current = async function* () {
      yield { type: "text", delta: "partial" };
      throw new Error("provider exploded");
    };

    const { POST } = await import("./route");
    const { localBreakdown } = await import("@/lib/breakdown");
    const res = await POST(postRequest(REQUEST_BODY));
    const events = await readAllEvents(res);

    const fallback = events.find((e) => e.type === "fallback");
    expect(fallback).toEqual({
      type: "fallback",
      reason: "error",
      data: localBreakdown(REQUEST_BODY.title),
    });
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(recordAnthropicFailureMock).toHaveBeenCalledWith(
      "breakdown",
      expect.any(Error),
    );
  });

  it("refunds the guest's quota when the LLM call fails", async () => {
    isOwnerRequestMock.mockResolvedValue(false);
    currentWorkspaceIdMock.mockResolvedValue("guest-abc");
    streamImpl.current = async function* () {
      throw new Error("provider exploded");
    };

    const { POST } = await import("./route");
    await POST(postRequest(REQUEST_BODY));

    expect(refundGuestBreakdownMock).toHaveBeenCalledWith("hash-1");
  });

  it("blocked guest gets a canned fallback with NO call to the LLM", async () => {
    isOwnerRequestMock.mockResolvedValue(false);
    currentWorkspaceIdMock.mockResolvedValue("guest-abc");
    consumeGuestBreakdownMock.mockResolvedValue({ allowed: false, reason: "quota" });
    streamImpl.current = async function* () {
      throw new Error("must not be called");
    };

    const { POST } = await import("./route");
    const { localBreakdown } = await import("@/lib/breakdown");
    const res = await POST(postRequest(REQUEST_BODY));
    const events = await readAllEvents(res);

    expect(events).toEqual([
      { type: "fallback", reason: "quota", data: localBreakdown(REQUEST_BODY.title) },
      { type: "done" },
    ]);
    expect(refundGuestBreakdownMock).not.toHaveBeenCalled();
  });
});
