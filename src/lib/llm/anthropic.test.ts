import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
const streamFn = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create, stream: streamFn };
  },
}));

import { createAnthropicProvider } from "./anthropic";

beforeEach(() => {
  create.mockReset();
  streamFn.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("anthropic adapter generate()", () => {
  it("maps content blocks to { text, toolCall }", async () => {
    create.mockResolvedValue({
      content: [
        { type: "text", text: "here you go" },
        { type: "tool_use", name: "propose_steps", input: { parentEmoji: "🗂️", steps: [] } },
      ],
    });
    const p = createAnthropicProvider();
    const r = await p.generate({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      tools: [{ name: "propose_steps", description: "d", inputSchema: {} }],
      toolChoice: "propose_steps",
    });
    expect(r.text).toBe("here you go");
    expect(r.toolCall).toEqual({ name: "propose_steps", input: { parentEmoji: "🗂️", steps: [] } });
  });

  it("passes system as top-level param and applies thinking/effort hints", async () => {
    create.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const p = createAnthropicProvider();
    await p.generate({
      model: "claude-opus-4-8",
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50,
      hints: { thinking: true, effort: "low" },
    });
    const arg = create.mock.calls[0][0];
    expect(arg.system).toBe("SYS");
    expect(arg.thinking).toEqual({ type: "adaptive" });
    expect(arg.output_config).toEqual({ effort: "low" });
  });

  it("maps a 429 APIError to a retryable rate_limit LLMError", async () => {
    create.mockRejectedValue(Object.assign(new Error("rate"), { status: 429 }));
    const p = createAnthropicProvider();
    await expect(
      p.generate({ model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 10 }),
    ).rejects.toMatchObject({ kind: "rate_limit", retryable: true, status: 429 });
  });

  it("keeps a missing API key as a non-retryable auth error (not reclassified as network)", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const p = createAnthropicProvider();
    await expect(
      p.generate({ model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 10 }),
    ).rejects.toMatchObject({ kind: "auth", retryable: false });
  });
});

describe("anthropic adapter error mapping", () => {
  it.each([
    { status: 401, kind: "auth", retryable: false },
    { status: 403, kind: "auth", retryable: false },
    { status: 500, kind: "server", retryable: true },
    { status: 503, kind: "server", retryable: true },
    { status: 400, kind: "bad_request", retryable: false },
    { status: 404, kind: "bad_request", retryable: false },
  ])("maps status $status to kind $kind (retryable=$retryable)", async ({ status, kind, retryable }) => {
    create.mockRejectedValue(Object.assign(new Error("boom"), { status }));
    const p = createAnthropicProvider();
    await expect(
      p.generate({ model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 10 }),
    ).rejects.toMatchObject({ kind, retryable, status });
  });

  it("maps a status-less error to a retryable network LLMError", async () => {
    create.mockRejectedValue(new Error("socket hang up"));
    const p = createAnthropicProvider();
    await expect(
      p.generate({ model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 10 }),
    ).rejects.toMatchObject({ kind: "network", retryable: true, status: undefined });
  });
});

describe("anthropic adapter stream()", () => {
  it("yields text deltas then a final result", async () => {
    const handlers: Record<string, (d: string) => void> = {};
    streamFn.mockReturnValue({
      on: (evt: string, cb: (d: string) => void) => {
        handlers[evt] = cb;
      },
      finalMessage: async () => {
        return { content: [{ type: "text", text: "hello world" }] };
      },
    });
    const p = createAnthropicProvider();
    const it = p.stream({ model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 10 });
    // drive the async iterator, feeding a text delta mid-stream
    const events: unknown[] = [];
    const pump = (async () => {
      for await (const e of it) events.push(e);
    })();
    // simulate SDK emitting a delta then finishing
    handlers["text"]?.("hello ");
    await pump;
    expect(events).toContainEqual({ type: "text", delta: "hello " });
    expect(events.at(-1)).toEqual({
      type: "final",
      result: { text: "hello world", toolCall: undefined },
    });
  });

  it("propagates a finalMessage() rejection as an LLMError without an unhandled rejection", async () => {
    streamFn.mockReturnValue({
      on: () => {
        // no text deltas in this scenario
      },
      finalMessage: async () => {
        throw Object.assign(new Error("rate"), { status: 429 });
      },
    });
    const p = createAnthropicProvider();
    const it = p.stream({ model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 10 });

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await expect(
        (async () => {
          for await (const e of it) {
            void e; // drain until the rejection surfaces
          }
        })(),
      ).rejects.toMatchObject({ kind: "rate_limit", retryable: true, status: 429 });

      // Flush the macrotask queue so a floating/orphaned promise rejection
      // (if any) would have fired `unhandledRejection` by now.
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});
