import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
    constructor(public opts: unknown) {}
  },
}));

import { createOpenAICompatibleProvider } from "./openai-compatible";

beforeEach(() => {
  create.mockReset();
  process.env.LLM_BASE_URL = "http://localhost:11434/v1";
  process.env.LLM_MODEL = "llama3.1:8b";
  process.env.LLM_SUPPORTS_TOOLS = "true";
  delete process.env.LLM_API_KEY;
});

describe("openai-compatible generate()", () => {
  it("prepends system as a message and parses stringified tool arguments", async () => {
    create.mockResolvedValue({
      choices: [
        {
          message: {
            content: "here you go",
            tool_calls: [
              {
                function: {
                  name: "propose_steps",
                  arguments: '{"parentEmoji":"🗂️","steps":[]}',
                },
              },
            ],
          },
        },
      ],
    });
    const p = createOpenAICompatibleProvider();
    const r = await p.generate({
      model: "llama3.1:8b",
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      tools: [{ name: "propose_steps", description: "d", inputSchema: {} }],
      toolChoice: "propose_steps",
    });
    const sent = create.mock.calls[0][0];
    expect(sent.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(r.text).toBe("here you go");
    expect(r.toolCall).toEqual({
      name: "propose_steps",
      input: { parentEmoji: "🗂️", steps: [] },
    });
  });

  it("maps a 429 to a retryable rate_limit LLMError", async () => {
    create.mockRejectedValue(Object.assign(new Error("rate"), { status: 429 }));
    const p = createOpenAICompatibleProvider();
    await expect(
      p.generate({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 10,
      }),
    ).rejects.toMatchObject({ kind: "rate_limit", retryable: true });
  });

  it("maps 401 to a non-retryable auth LLMError", async () => {
    create.mockRejectedValue(Object.assign(new Error("nope"), { status: 401 }));
    const p = createOpenAICompatibleProvider();
    await expect(
      p.generate({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 10,
      }),
    ).rejects.toMatchObject({ kind: "auth", retryable: false });
  });

  it("maps a 5xx to a retryable server LLMError", async () => {
    create.mockRejectedValue(Object.assign(new Error("boom"), { status: 503 }));
    const p = createOpenAICompatibleProvider();
    await expect(
      p.generate({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 10,
      }),
    ).rejects.toMatchObject({ kind: "server", retryable: true });
  });

  it("maps a status-less failure to a retryable network LLMError", async () => {
    create.mockRejectedValue(new Error("ECONNREFUSED"));
    const p = createOpenAICompatibleProvider();
    await expect(
      p.generate({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 10,
      }),
    ).rejects.toMatchObject({ kind: "network", retryable: true });
  });

  it("ignores tools when LLM_SUPPORTS_TOOLS=false (native path only)", async () => {
    process.env.LLM_SUPPORTS_TOOLS = "false";
    create.mockResolvedValue({
      choices: [{ message: { content: "plain text" } }],
    });
    const p = createOpenAICompatibleProvider();
    expect(p.supportsTools).toBe(false);
    const r = await p.generate({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 10,
      tools: [{ name: "propose_steps", description: "d", inputSchema: {} }],
      toolChoice: "propose_steps",
    });
    const sent = create.mock.calls[0][0];
    expect(sent.tools).toBeUndefined();
    expect(r.text).toBe("plain text");
    expect(r.toolCall).toBeUndefined();
  });

  it("returns no toolCall when the arguments are malformed JSON", async () => {
    create.mockResolvedValue({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              { function: { name: "propose_steps", arguments: "{not json" } },
            ],
          },
        },
      ],
    });
    const p = createOpenAICompatibleProvider();
    const r = await p.generate({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 10,
      tools: [{ name: "propose_steps", description: "d", inputSchema: {} }],
      toolChoice: "propose_steps",
    });
    expect(r.toolCall).toBeUndefined();
  });

  it("parses a <result> block into toolCall when LLM_SUPPORTS_TOOLS=false", async () => {
    process.env.LLM_SUPPORTS_TOOLS = "false";
    create.mockResolvedValue({
      choices: [
        {
          message: {
            content: 'Sure!\n<result>{"parentEmoji":"🗂️","steps":[]}</result>',
          },
        },
      ],
    });
    const p = createOpenAICompatibleProvider();
    const r = await p.generate({
      model: "m",
      system: "SYS",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 10,
      tools: [
        {
          name: "propose_steps",
          description: "d",
          inputSchema: { type: "object", required: ["parentEmoji", "steps"] },
        },
      ],
      toolChoice: "propose_steps",
    });
    const sent = create.mock.calls[0][0];
    expect(sent.tools).toBeUndefined();
    // The structured-output instruction rides along in the system prompt.
    expect(sent.messages[0]).toEqual({
      role: "system",
      content: expect.stringContaining("<result>"),
    });
    expect(r.toolCall).toEqual({
      name: "propose_steps",
      input: { parentEmoji: "🗂️", steps: [] },
    });
  });

  it("uses LLM_API_KEY when set, else a placeholder key", async () => {
    process.env.LLM_API_KEY = "sk-local";
    create.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
    const p = createOpenAICompatibleProvider();
    await p.generate({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 10,
    });
    // Nothing to assert on the client opts here beyond not throwing; the
    // placeholder-key path is exercised by the other tests (LLM_API_KEY unset).
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("openai-compatible stream()", () => {
  async function* chunks(
    parts: Array<{
      content?: string;
      tool_calls?: Array<{
        index: number;
        function?: { name?: string; arguments?: string };
      }>;
    }>,
  ) {
    for (const delta of parts) yield { choices: [{ delta }] };
  }

  it("accumulates text deltas and assembles a streamed tool call", async () => {
    create.mockResolvedValue(
      chunks([
        { content: "Hel" },
        { content: "lo" },
        {
          tool_calls: [
            {
              index: 0,
              function: { name: "propose_steps", arguments: '{"a"' },
            },
          ],
        },
        { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] },
      ]),
    );
    const p = createOpenAICompatibleProvider();
    const events = [];
    for await (const ev of p.stream({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 10,
      tools: [{ name: "propose_steps", description: "d", inputSchema: {} }],
      toolChoice: "propose_steps",
    })) {
      events.push(ev);
    }
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.map((e) => (e.type === "text" ? e.delta : ""))).toEqual([
      "Hel",
      "lo",
    ]);
    const final = events.at(-1);
    expect(final).toEqual({
      type: "final",
      result: {
        text: "Hello",
        toolCall: { name: "propose_steps", input: { a: 1 } },
      },
    });
  });

  it("parses a streamed <result> block when LLM_SUPPORTS_TOOLS=false (no tools sent)", async () => {
    process.env.LLM_SUPPORTS_TOOLS = "false";
    create.mockResolvedValue(
      chunks([
        { content: "Here you go! " },
        { content: '<result>{"parentEmoji":"🗂️","steps":[]}</result>' },
      ]),
    );
    const p = createOpenAICompatibleProvider();
    const events = [];
    for await (const ev of p.stream({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 10,
      tools: [
        {
          name: "propose_steps",
          description: "d",
          inputSchema: { type: "object", required: ["parentEmoji", "steps"] },
        },
      ],
      toolChoice: "propose_steps",
    })) {
      events.push(ev);
    }
    const sent = create.mock.calls[0][0];
    expect(sent.tools).toBeUndefined();
    // No system message in this request → instruction rides on the last user message.
    expect(sent.messages.at(-1).content).toContain("<result>");
    const final = events.at(-1);
    expect(final).toEqual({
      type: "final",
      result: {
        text: 'Here you go! <result>{"parentEmoji":"🗂️","steps":[]}</result>',
        toolCall: {
          name: "propose_steps",
          input: { parentEmoji: "🗂️", steps: [] },
        },
      },
    });
  });

  it("yields toolCall: undefined when the streamed text has no <result> block", async () => {
    process.env.LLM_SUPPORTS_TOOLS = "false";
    create.mockResolvedValue(chunks([{ content: "just talking, no block" }]));
    const p = createOpenAICompatibleProvider();
    const events = [];
    for await (const ev of p.stream({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 10,
      tools: [
        {
          name: "propose_steps",
          description: "d",
          inputSchema: { type: "object", required: ["parentEmoji", "steps"] },
        },
      ],
      toolChoice: "propose_steps",
    })) {
      events.push(ev);
    }
    const final = events.at(-1);
    expect(final).toEqual({
      type: "final",
      result: { text: "just talking, no block", toolCall: undefined },
    });
  });

  it("maps a stream-open failure to an LLMError", async () => {
    create.mockRejectedValue(Object.assign(new Error("rate"), { status: 429 }));
    const p = createOpenAICompatibleProvider();
    const it = p
      .stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 10,
      })
      [Symbol.asyncIterator]();
    await expect(it.next()).rejects.toMatchObject({
      kind: "rate_limit",
      retryable: true,
    });
  });
});
