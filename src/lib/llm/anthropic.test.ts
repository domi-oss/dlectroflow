import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  // Retryable-error cases below now go through withRetry's real backoff
  // (~200ms/400ms); fake timers keep those tests instant instead of
  // burning wall-clock on every CI run.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("maps content blocks to { text, toolCall }", async () => {
    create.mockResolvedValue({
      content: [
        { type: "text", text: "here you go" },
        {
          type: "tool_use",
          name: "propose_steps",
          input: { parentEmoji: "🗂️", steps: [] },
        },
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
    expect(r.toolCall).toEqual({
      name: "propose_steps",
      input: { parentEmoji: "🗂️", steps: [] },
    });
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
    const promise = p.generate({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 10,
    });
    const assertion = expect(promise).rejects.toMatchObject({
      kind: "rate_limit",
      retryable: true,
      status: 429,
    });
    await vi.advanceTimersByTimeAsync(200); // 1st backoff
    await vi.advanceTimersByTimeAsync(400); // 2nd backoff
    await assertion;
  });

  it("keeps a missing API key as a non-retryable auth error (not reclassified as network)", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const p = createAnthropicProvider();
    await expect(
      p.generate({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 10,
      }),
    ).rejects.toMatchObject({ kind: "auth", retryable: false });
  });
});

describe("anthropic adapter error mapping", () => {
  // Retryable cases (500/503) below go through withRetry's real backoff;
  // fake timers keep them instant instead of burning ~600ms each on CI.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([
    { status: 401, kind: "auth", retryable: false },
    { status: 403, kind: "auth", retryable: false },
    { status: 500, kind: "server", retryable: true },
    { status: 503, kind: "server", retryable: true },
    { status: 400, kind: "bad_request", retryable: false },
    { status: 404, kind: "bad_request", retryable: false },
  ])(
    "maps status $status to kind $kind (retryable=$retryable)",
    async ({ status, kind, retryable }) => {
      create.mockRejectedValue(Object.assign(new Error("boom"), { status }));
      const p = createAnthropicProvider();
      const promise = p.generate({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 10,
      });
      const assertion = expect(promise).rejects.toMatchObject({
        kind,
        retryable,
        status,
      });
      // No-op when the case above is non-retryable (nothing scheduled).
      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(400);
      await assertion;
    },
  );

  it("maps a status-less error to a retryable network LLMError", async () => {
    create.mockRejectedValue(new Error("socket hang up"));
    const p = createAnthropicProvider();
    const promise = p.generate({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 10,
    });
    const assertion = expect(promise).rejects.toMatchObject({
      kind: "network",
      retryable: true,
      status: undefined,
    });
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(400);
    await assertion;
  });
});

describe("anthropic adapter stream()", () => {
  it("yields text deltas then a final result", async () => {
    const handlers: Record<string, (d: string) => void> = {};
    // Control exactly when finalMessage() settles so it can't race ahead of
    // the injected text delta below (the stream-establishment call now goes
    // through the bounded-retry wrapper — #59 Task 8 — so it resolves a
    // microtask tick later than a synchronous `on()` registration used to).
    let resolveFinal!: (v: {
      content: { type: string; text: string }[];
    }) => void;
    const finalDeferred = new Promise<{
      content: { type: string; text: string }[];
    }>((resolve) => {
      resolveFinal = resolve;
    });
    streamFn.mockReturnValue({
      on: (evt: string, cb: (d: string) => void) => {
        handlers[evt] = cb;
      },
      finalMessage: () => finalDeferred,
    });
    const p = createAnthropicProvider();
    const it = p.stream({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 10,
    });
    // drive the async iterator, feeding a text delta mid-stream
    const events: unknown[] = [];
    const pump = (async () => {
      for await (const e of it) events.push(e);
    })();
    // Wait for stream establishment to finish and register the "text"
    // handler before feeding it a delta.
    while (!handlers["text"]) {
      await Promise.resolve();
    }
    handlers["text"]?.("hello ");
    // Let the delta propagate before finishing the stream.
    await Promise.resolve();
    await Promise.resolve();
    resolveFinal({ content: [{ type: "text", text: "hello world" }] });
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
    const it = p.stream({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 10,
    });

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
      ).rejects.toMatchObject({
        kind: "rate_limit",
        retryable: true,
        status: 429,
      });

      // Flush the macrotask queue so a floating/orphaned promise rejection
      // (if any) would have fired `unhandledRejection` by now.
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});

describe("anthropic adapter bounded retry (#59 Task 8)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("generate() retries a 429 twice then returns the eventual success", async () => {
    create
      .mockRejectedValueOnce(Object.assign(new Error("rate"), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error("rate"), { status: 429 }))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });
    const p = createAnthropicProvider();
    const promise = p.generate({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 10,
    });
    await vi.advanceTimersByTimeAsync(200); // 1st backoff
    await vi.advanceTimersByTimeAsync(400); // 2nd backoff
    await expect(promise).resolves.toMatchObject({ text: "ok" });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("generate() throws a non-retryable auth error immediately, with no retry", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const p = createAnthropicProvider();
    await expect(
      p.generate({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 10,
      }),
    ).rejects.toMatchObject({ kind: "auth", retryable: false });
    expect(create).not.toHaveBeenCalled();
  });

  it("stream() retries the ESTABLISHMENT call on a retryable failure, then streams normally", async () => {
    streamFn
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("rate"), { status: 429 });
      })
      .mockReturnValueOnce({
        on: () => {
          // no text deltas in this scenario
        },
        finalMessage: async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
      });
    const p = createAnthropicProvider();
    const events: unknown[] = [];
    const pump = (async () => {
      for await (const e of p.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 10,
      })) {
        events.push(e);
      }
    })();
    await vi.advanceTimersByTimeAsync(200); // 1st backoff
    await pump;
    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toEqual({
      type: "final",
      result: { text: "ok", toolCall: undefined },
    });
  });
});
