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
  gatherBreakdownContextMock,
  clientIpHashMock,
  consumeGuestBreakdownMock,
  refundGuestBreakdownMock,
  recordLLMFailureMock,
  streamImpl,
  lastLLMRequest,
} = vi.hoisted(() => {
  return {
    isOwnerRequestMock: vi.fn(),
    currentWorkspaceIdMock: vi.fn(),
    getSettingsMock: vi.fn(),
    gatherBreakdownContextMock: vi.fn(),
    clientIpHashMock: vi.fn(),
    consumeGuestBreakdownMock: vi.fn(),
    refundGuestBreakdownMock: vi.fn(),
    recordLLMFailureMock: vi.fn(),
    // Reassigned per-test to control what the fake provider's stream() does.
    streamImpl: { current: undefined as unknown },
    // Captures the LLMRequest the route actually put on the wire, so the
    // SYSTEM prompt and the user turn can be asserted without exporting them.
    lastLLMRequest: {
      current: undefined as
        { system?: string; messages?: { content: string }[] } | undefined,
    },
  };
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("@/lib/workspace", () => ({
  isOwnerRequest: isOwnerRequestMock,
  currentWorkspaceId: currentWorkspaceIdMock,
}));

// #84 — keeps this file a real unit test. #35 Phase A turned isGuestWorkspace()
// into a `prisma.workspace.findUnique()` call, which silently made these route
// tests require a live Postgres. Mocked here exactly as every other call-site
// unit test does (focus, settings, rollup, spark, ai-scope-guards), with
// "owner" as this file's existing non-guest sentinel id.
//
// No coverage is lost: the real guest-vs-user branch — including the fail-closed
// unknown-workspace case and the query shape — is asserted against a mocked
// prisma in src/lib/workspace-kind.test.ts (renamed from ai-scope.test.ts in
// #91), which is where that unit belongs. Against a real database this file
// never exercised the distinction anyway: neither sentinel id resolves to a
// `kind:"user"` row, so isGuestWorkspace() returned true for both, and the
// "owner" default silently ran the *guest* path.
vi.mock("@/lib/workspace-kind", () => ({
  isGuestWorkspace: (id: string) => Promise.resolve(id !== "owner"),
}));

vi.mock("@/lib/settings-read", () => ({
  getSettings: getSettingsMock,
}));

vi.mock("@/lib/breakdown-context", () => ({
  gatherBreakdownContext: gatherBreakdownContextMock,
}));

vi.mock("@/lib/guest-quota", () => ({
  clientIpHash: clientIpHashMock,
  consumeGuestBreakdown: consumeGuestBreakdownMock,
  refundGuestBreakdown: refundGuestBreakdownMock,
}));

vi.mock("@/lib/observability", () => ({
  recordLLMFailure: recordLLMFailureMock,
}));

vi.mock("@/lib/llm", () => ({
  getLLM: () => ({
    id: "anthropic",
    supportsTools: true,
    // streamImpl is reassigned per-test to control what the fake provider yields.
    stream: (req: unknown) => {
      lastLLMRequest.current = req as typeof lastLLMRequest.current;
      return (streamImpl.current as (req: unknown) => AsyncGenerator<unknown>)(
        req,
      );
    },
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

// File-scoped so the #14 describes at the bottom get the same clean slate as
// the original ones (an owner request, an allowed guest, no context).
beforeEach(() => {
  vi.clearAllMocks();
  lastLLMRequest.current = undefined;
  isOwnerRequestMock.mockResolvedValue(true);
  currentWorkspaceIdMock.mockResolvedValue("owner");
  getSettingsMock.mockResolvedValue(null);
  gatherBreakdownContextMock.mockResolvedValue({});
  clientIpHashMock.mockReturnValue("hash-1");
  consumeGuestBreakdownMock.mockResolvedValue({ allowed: true });
  refundGuestBreakdownMock.mockResolvedValue(undefined);
});

describe("POST /api/breakdown", () => {
  it("forwards text events and a steps event carrying the tool call's input", async () => {
    streamImpl.current = async function* () {
      yield { type: "text", delta: "hi " };
      yield { type: "text", delta: "there" };
      yield {
        type: "final",
        result: {
          text: "hi there",
          toolCall: {
            name: "propose_steps",
            input: { parentEmoji: "🗂️", steps: [] },
          },
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

  it("tool-less provider: <result> block WAS parsed → still sends a steps event", async () => {
    // Simulates the openai-compatible adapter's structured-output fallback
    // (#59 Task 7) succeeding: a tool-less local model has no native tool
    // call, but the adapter parsed a <result> block into toolCall itself,
    // so by the time it reaches the route this looks just like a normal
    // tool call.
    streamImpl.current = async function* () {
      yield { type: "text", delta: "here's a plan" };
      yield {
        type: "final",
        result: {
          text: 'here\'s a plan <result>{"parentEmoji":"🗂️","steps":[]}</result>',
          toolCall: {
            name: "propose_steps",
            input: { parentEmoji: "🗂️", steps: [] },
          },
        },
      };
    };

    const { POST } = await import("./route");
    const res = await POST(postRequest(REQUEST_BODY));
    const events = await readAllEvents(res);

    expect(events).toContainEqual({
      type: "steps",
      data: { parentEmoji: "🗂️", steps: [] },
    });
    expect(events.find((e) => e.type === "fallback")).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("tool-less provider: no <result> block parsed → falls back to localBreakdown so the user still gets steps", async () => {
    // Simulates a tool-less local model whose response never produced a
    // parseable <result> block (missing/malformed) — the adapter's
    // structured-output fallback (#59 Task 7) yields toolCall: undefined on
    // the final event without throwing. The route must not leave the user
    // with a dead stream.
    streamImpl.current = async function* () {
      yield { type: "text", delta: "rambling, no structured block" };
      yield {
        type: "final",
        result: { text: "rambling, no structured block", toolCall: undefined },
      };
    };

    const { POST } = await import("./route");
    const { localBreakdown } = await import("@/lib/breakdown");
    const res = await POST(postRequest(REQUEST_BODY));
    const events = await readAllEvents(res);

    expect(events).toContainEqual({
      type: "fallback",
      reason: "error",
      data: localBreakdown(REQUEST_BODY.title),
    });
    expect(events.find((e) => e.type === "steps")).toBeUndefined();
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
    expect(recordLLMFailureMock).toHaveBeenCalledWith(
      "anthropic",
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

  it("refunds the guest's quota on the soft-failure (no toolCall) path", async () => {
    // Mirrors the thrown-error refund test above, but for the OTHER failure
    // path: the stream finishes with no parsed tool call (tool-less/local
    // model, malformed response — #59 Task 7's fallback) rather than
    // throwing. The guest still didn't get a real AI breakdown, so the
    // refund must fire here too (Task 7 review finding: this branch used to
    // skip it, silently burning a guest's quota on a soft failure).
    isOwnerRequestMock.mockResolvedValue(false);
    currentWorkspaceIdMock.mockResolvedValue("guest-abc");
    streamImpl.current = async function* () {
      yield {
        type: "final",
        result: { text: "rambling, no structured block", toolCall: undefined },
      };
    };

    const { POST } = await import("./route");
    const { localBreakdown } = await import("@/lib/breakdown");
    const res = await POST(postRequest(REQUEST_BODY));
    const events = await readAllEvents(res);

    expect(refundGuestBreakdownMock).toHaveBeenCalledWith("hash-1");
    expect(events).toContainEqual({
      type: "fallback",
      reason: "error",
      data: localBreakdown(REQUEST_BODY.title),
    });
  });

  it("refunds the guest's quota exactly once, even when the soft-failure send() throws and control falls into the catch too", async () => {
    // Idempotency regression test: the soft-failure branch and the catch
    // block both live in the same try and both call
    // refundGuestOnLLMFailure(). A realistic trigger: the client
    // disconnects right after the soft-failure branch's refund, so the very
    // next send() — controller.enqueue() on a closed/errored controller —
    // throws, and control falls into the catch, which attempts the refund
    // again. Without a guard this double-refunds one failed breakdown.
    isOwnerRequestMock.mockResolvedValue(false);
    currentWorkspaceIdMock.mockResolvedValue("guest-abc");
    streamImpl.current = async function* () {
      yield {
        type: "final",
        result: { text: "rambling, no structured block", toolCall: undefined },
      };
    };
    // Force the route's own FIRST controller.enqueue() call — the
    // soft-failure branch's fallback send(), issued right after the first
    // refund — to throw, simulating a disconnected client.
    //
    // Deliberately spying on ReadableStreamDefaultController.prototype.enqueue
    // rather than TextEncoder.prototype.encode: an earlier version of this
    // test used a one-shot TextEncoder spy and relied on undici NOT calling
    // `encode` while building the Request body, so our route's first
    // in-stream `encode` would be the one that mattered. That assumption is
    // undici-version-dependent — it held locally but not on CI's
    // node:22-alpine, where the one-shot spy got consumed by Request
    // construction instead, the intended throw never fired, and the test
    // failed with 0 refund calls. `controller.enqueue` has no such ambiguity:
    // it is only ever called by this route's own `send()`, never by undici's
    // Request/Response body machinery, so which call is "first" doesn't
    // depend on any runtime's internal encoding details.
    const enqueueSpy = vi
      .spyOn(ReadableStreamDefaultController.prototype, "enqueue")
      .mockImplementationOnce(() => {
        throw new Error("controller is closed");
      });
    try {
      const { POST } = await import("./route");
      const res = await POST(postRequest(REQUEST_BODY));
      const events = await readAllEvents(res);

      expect(refundGuestBreakdownMock).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toEqual({ type: "done" });
    } finally {
      enqueueSpy.mockRestore();
    }
  });

  it("blocked guest gets a canned fallback with NO call to the LLM", async () => {
    isOwnerRequestMock.mockResolvedValue(false);
    currentWorkspaceIdMock.mockResolvedValue("guest-abc");
    consumeGuestBreakdownMock.mockResolvedValue({
      allowed: false,
      reason: "quota",
    });
    streamImpl.current = async function* () {
      throw new Error("must not be called");
    };

    const { POST } = await import("./route");
    const { localBreakdown } = await import("@/lib/breakdown");
    const res = await POST(postRequest(REQUEST_BODY));
    const events = await readAllEvents(res);

    expect(events).toEqual([
      {
        type: "fallback",
        reason: "quota",
        data: localBreakdown(REQUEST_BODY.title),
      },
      { type: "done" },
    ]);
    expect(refundGuestBreakdownMock).not.toHaveBeenCalled();
  });
});

// ── #14 — app + user context for the breakdown coach ────────────────────────

/** Drive one successful breakdown and hand back the LLMRequest it produced. */
async function captureRequest(body: unknown = REQUEST_BODY) {
  streamImpl.current = async function* () {
    yield {
      type: "final",
      result: {
        text: "ok",
        toolCall: {
          name: "propose_steps",
          input: { parentEmoji: "🗂️", steps: [] },
        },
      },
    };
  };
  const { POST } = await import("./route");
  const res = await POST(postRequest(body));
  const events = await readAllEvents(res);
  return { req: lastLLMRequest.current!, events };
}

describe("POST /api/breakdown — SYSTEM app knowledge (#14)", () => {
  it("teaches the coach what dlectroflow is", async () => {
    const { req } = await captureRequest();
    const { BREAKDOWN_APP_CONTEXT } = await import("@/lib/breakdown");
    expect(req.system).toContain(BREAKDOWN_APP_CONTEXT);
    expect(req.system).toMatch(/focus[- ]timer/i);
    expect(req.system).toMatch(/editable starting point/i);
    expect(req.system).toMatch(/streak/i);
  });

  it("keeps the 5–30 minute sizing exactly once, with no 10-minute nudge", async () => {
    const { req } = await captureRequest();
    expect(req.system!.match(/5–30/g)).toHaveLength(1);
    expect(req.system).not.toMatch(/10[- ]minute/i);
  });

  it("still ENDS with the propose_steps instruction", async () => {
    // The openai-compatible adapter appends buildStructuredInstruction() after
    // SYSTEM for tool-less providers (#59 Task 7), so whatever we add must not
    // push the tool instruction into the middle of the prompt.
    const { req } = await captureRequest();
    expect(req.system!.trimEnd()).toMatch(
      /Always finish by calling the propose_steps tool[\s\S]*$/,
    );
    const lines = req.system!.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toMatch(/propose_steps tool/);
  });

  it("requires the emoji fields regardless of voice", async () => {
    const { req } = await captureRequest();
    expect(req.system).toMatch(/parentEmoji/);
    expect(req.system).toMatch(/subtaskEmoji/);
    expect(req.system).toMatch(/both voices/i);
  });

  it("enforces the owner's voice decision: one warm nod, never the numbers", async () => {
    // Regression guard for issue #14's owner decision. If this fails, the
    // coach has been let loose to read the streak back like a scoreboard.
    const { req } = await captureRequest();
    expect(req.system).toMatch(/at most once/i);
    expect(req.system).toMatch(/never recite the numbers back/i);
    expect(req.system).toMatch(/never imply they are behind/i);
  });

  it("is byte-identical for two different workspaces (cacheable prefix)", async () => {
    gatherBreakdownContextMock.mockResolvedValue({ voice: "playful" });
    const a = (await captureRequest()).req.system;
    isOwnerRequestMock.mockResolvedValue(false);
    currentWorkspaceIdMock.mockResolvedValue("guest-abc");
    gatherBreakdownContextMock.mockResolvedValue({ voice: "plain" });
    const b = (await captureRequest()).req.system;
    expect(a).toBe(b);
  });
});

describe("POST /api/breakdown — live context injection (#14)", () => {
  it("appends the gathered context to the USER turn, feedback last", async () => {
    gatherBreakdownContextMock.mockResolvedValue({
      voice: "playful",
      streak: { current: 4, activeToday: true },
      buckets: { needsReview: 3, singleTask: 2, multiStep: 1, savedLater: 4 },
      recentBreakdowns: [
        { stepCount: 6, minMinutes: 10, medianMinutes: 15, maxMinutes: 30 },
      ],
    });

    const { req } = await captureRequest();
    const content = req.messages![0].content;

    expect(content).toContain("Voice: playful");
    expect(content).toContain(
      "Momentum: 4-day working-day streak, active today",
    );
    expect(content).toContain("Their board: 3 to review");
    expect(content).toContain("Their last kept breakdown: 6 steps");
    // Never in SYSTEM — the static prefix must stay per-request-value-free.
    expect(req.system).not.toContain("Voice: playful");
    // The person's own instruction stays the last thing the model reads.
    expect(content.trimEnd().split("\n").at(-1)).toMatch(/^Feedback: /);
  });

  it("leaves the prompt byte-identical to the pre-#14 one when there is no context", async () => {
    gatherBreakdownContextMock.mockResolvedValue({});
    const { req } = await captureRequest();
    const { buildUserPrompt } = await import("@/lib/breakdown");
    expect(req.messages![0].content).toBe(
      buildUserPrompt(REQUEST_BODY as never),
    );
  });

  it("gathers context for the REQUEST's workspace — a guest never reads owner data", async () => {
    isOwnerRequestMock.mockResolvedValue(false);
    currentWorkspaceIdMock.mockResolvedValue("guest-abc");

    await captureRequest();

    expect(gatherBreakdownContextMock).toHaveBeenCalledTimes(1);
    expect(gatherBreakdownContextMock).toHaveBeenCalledWith("guest-abc");
    for (const [arg] of gatherBreakdownContextMock.mock.calls) {
      expect(arg).not.toBe("owner");
    }
    // The owner-settings read is a MODEL-TIER lookup and stays gated on `owner`.
    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it("gathers the owner's own workspace for an owner request", async () => {
    await captureRequest();
    expect(gatherBreakdownContextMock).toHaveBeenCalledWith("owner");
  });

  it("a blocked guest performs ZERO context reads and still gets [fallback, done]", async () => {
    isOwnerRequestMock.mockResolvedValue(false);
    currentWorkspaceIdMock.mockResolvedValue("guest-abc");
    consumeGuestBreakdownMock.mockResolvedValue({
      allowed: false,
      reason: "quota",
    });
    streamImpl.current = async function* () {
      throw new Error("must not be called");
    };

    const { POST } = await import("./route");
    const { localBreakdown } = await import("@/lib/breakdown");
    const res = await POST(postRequest(REQUEST_BODY));
    const events = await readAllEvents(res);

    expect(gatherBreakdownContextMock).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        type: "fallback",
        reason: "quota",
        data: localBreakdown(REQUEST_BODY.title),
      },
      { type: "done" },
    ]);
  });

  it("a failing context gather still streams a real breakdown — no fallback event", async () => {
    // The breakdown path was DB-light before #14. Adding reads must never turn
    // a working breakdown into the canned local plan.
    gatherBreakdownContextMock.mockRejectedValue(new Error("db down"));

    const { req, events } = await captureRequest();

    expect(events).toContainEqual({
      type: "steps",
      data: { parentEmoji: "🗂️", steps: [] },
    });
    expect(events.find((e) => e.type === "fallback")).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(req.messages![0].content).not.toContain("App context");
    expect(recordLLMFailureMock).not.toHaveBeenCalled();
  });
});
