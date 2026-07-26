import OpenAI from "openai";
import type {
  LLMProvider,
  LLMRequest,
  LLMResult,
  LLMStreamEvent,
} from "./types";
import { LLMError } from "./types";

function client(): OpenAI {
  const baseURL = process.env.LLM_BASE_URL;
  if (!baseURL) {
    throw new LLMError(
      "auth",
      undefined,
      "LLM_BASE_URL is not set (required for LLM_PROVIDER=openai-compatible).",
      false,
    );
  }
  // Many local runners (Ollama, LM Studio, vLLM) need no key, but the OpenAI
  // SDK requires a non-empty string — send a harmless placeholder.
  return new OpenAI({ baseURL, apiKey: process.env.LLM_API_KEY || "not-needed" });
}

function toLLMError(err: unknown): LLMError {
  if (err instanceof LLMError) return err;
  const e = err as { message?: unknown; status?: unknown } | undefined;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const message = typeof e?.message === "string" ? e.message : String(err);
  if (status === 429) return new LLMError("rate_limit", 429, message, true, err);
  if (status === 401 || status === 403)
    return new LLMError("auth", status, message, false, err);
  if (status && status >= 500)
    return new LLMError("server", status, message, true, err);
  if (status && status >= 400)
    return new LLMError("bad_request", status, message, false, err);
  return new LLMError("network", undefined, message, true, err);
}

function messages(req: LLMRequest) {
  const out = req.messages.map((m) => ({ role: m.role, content: m.content }));
  return req.system
    ? [{ role: "system" as const, content: req.system }, ...out]
    : out;
}

function toolsParam(req: LLMRequest) {
  if (!req.tools?.length) return {};
  return {
    tools: req.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    })),
  };
}

type ChoiceMessage = {
  content?: string | null;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
};

function parseChoice(msg: ChoiceMessage, toolChoice?: string): LLMResult {
  const text = (msg.content ?? "").trim();
  const call = msg.tool_calls?.find(
    (c) => !toolChoice || c.function.name === toolChoice,
  );
  let toolCall: LLMResult["toolCall"];
  if (call) {
    try {
      toolCall = {
        name: call.function.name,
        input: JSON.parse(call.function.arguments) as Record<string, unknown>,
      };
    } catch {
      // Malformed args → no tool; caller falls back (Task 7 handles tool-less).
      toolCall = undefined;
    }
  }
  return { text, toolCall };
}

const supportsTools = (): boolean =>
  (process.env.LLM_SUPPORTS_TOOLS ?? "true") !== "false";

type StreamChunk = {
  choices: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
};

export function createOpenAICompatibleProvider(): LLMProvider {
  return {
    id: "openai-compatible",
    get supportsTools() {
      return supportsTools();
    },
    async generate(req) {
      try {
        const useTools = supportsTools() && !!req.tools?.length;
        const resp = await client().chat.completions.create({
          model: req.model,
          max_tokens: req.maxTokens,
          ...(req.temperature != null ? { temperature: req.temperature } : {}),
          messages: messages(req),
          ...(useTools ? toolsParam(req) : {}),
        } as never);
        return parseChoice(
          (resp as unknown as { choices: [{ message: ChoiceMessage }] })
            .choices[0].message,
          req.toolChoice,
        );
      } catch (err) {
        throw toLLMError(err);
      }
    },
    async *stream(req) {
      const useTools = supportsTools() && !!req.tools?.length;
      let s: AsyncIterable<StreamChunk>;
      try {
        s = (await client().chat.completions.create({
          model: req.model,
          max_tokens: req.maxTokens,
          stream: true,
          messages: messages(req),
          ...(useTools ? toolsParam(req) : {}),
        } as never)) as unknown as AsyncIterable<StreamChunk>;
      } catch (err) {
        throw toLLMError(err);
      }
      let text = "";
      const toolArgs: Record<number, { name: string; args: string }> = {};
      try {
        for await (const chunk of s) {
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            text += delta.content;
            yield { type: "text", delta: delta.content } satisfies LLMStreamEvent;
          }
          for (const tc of delta?.tool_calls ?? []) {
            const slot = (toolArgs[tc.index] ??= { name: "", args: "" });
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
          }
        }
      } catch (err) {
        throw toLLMError(err);
      }
      const chosen = Object.values(toolArgs).find(
        (t) => !req.toolChoice || t.name === req.toolChoice,
      );
      let toolCall: LLMResult["toolCall"];
      if (chosen) {
        try {
          toolCall = {
            name: chosen.name,
            input: JSON.parse(chosen.args) as Record<string, unknown>,
          };
        } catch {
          toolCall = undefined;
        }
      }
      yield {
        type: "final",
        result: { text: text.trim(), toolCall },
      } satisfies LLMStreamEvent;
    },
  };
}
