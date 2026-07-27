import OpenAI from "openai";
import type {
  LLMProvider,
  LLMRequest,
  LLMResult,
  LLMStreamEvent,
  LLMTool,
} from "./types";
import { LLMError } from "./types";
import {
  buildStructuredInstruction,
  parseStructuredResult,
} from "./structured-output";
import { withRetry } from "./retry";

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
  return new OpenAI({
    baseURL,
    apiKey: process.env.LLM_API_KEY || "not-needed",
  });
}

function toLLMError(err: unknown): LLMError {
  if (err instanceof LLMError) return err;
  const e = err as { message?: unknown; status?: unknown } | undefined;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const message = typeof e?.message === "string" ? e.message : String(err);
  if (status === 429)
    return new LLMError("rate_limit", 429, message, true, err);
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

/**
 * When the model has no native tool-calling (LLM_SUPPORTS_TOOLS=false), emulate
 * it: pick the requested tool and append `buildStructuredInstruction` to the
 * prompt (system if present, else the last user message) so the model emits a
 * `<result>` block instead of a tool call. Returns undefined when no fallback
 * is needed (tools supported, or no tool/toolChoice on the request).
 */
function structuredFallback(
  req: LLMRequest,
): { tool: LLMTool; req: LLMRequest } | undefined {
  if (supportsTools() || !req.tools?.length || !req.toolChoice)
    return undefined;
  const tool = req.tools.find((t) => t.name === req.toolChoice) ?? req.tools[0];
  const instruction = buildStructuredInstruction(tool);
  if (req.system) {
    return { tool, req: { ...req, system: `${req.system}\n\n${instruction}` } };
  }
  const msgs = [...req.messages];
  const lastIndex = msgs.length - 1;
  if (lastIndex >= 0) {
    msgs[lastIndex] = {
      ...msgs[lastIndex],
      content: `${msgs[lastIndex].content}\n\n${instruction}`,
    };
  } else {
    msgs.push({ role: "user", content: instruction });
  }
  return { tool, req: { ...req, messages: msgs } };
}

const RESULT_SENTINEL = "<result>";

/**
 * Tool-less fallback streaming helper (Task 7 UX fix): given the full text
 * accumulated so far and how much of it has already been forwarded to the
 * client, return the next safe slice of conversational prose to emit.
 *
 * - While no `<result>` sentinel has appeared, withholds the last
 *   `RESULT_SENTINEL.length - 1` characters — enough that a sentinel split
 *   across chunk boundaries (e.g. "...text<res" + "ult>{...") is never
 *   emitted as partial text before being recognized as the real thing.
 * - Once the sentinel appears (case-insensitively, matching
 *   `parseStructuredResult`), emits only the prose before it and returns
 *   `sealed: true` — the caller must stop emitting for the rest of the
 *   stream; the JSON block is buffered, never shown to the user.
 */
function nextSafeProseSlice(
  accumulated: string,
  emittedLen: number,
): { delta: string; emittedLen: number; sealed: boolean } {
  const idx = accumulated.toLowerCase().indexOf(RESULT_SENTINEL);
  if (idx !== -1) {
    const safeLen = Math.max(idx, emittedLen);
    return {
      delta: accumulated.slice(emittedLen, safeLen),
      emittedLen: safeLen,
      sealed: true,
    };
  }
  const safeLen = Math.max(
    emittedLen,
    accumulated.length - (RESULT_SENTINEL.length - 1),
  );
  return {
    delta: accumulated.slice(emittedLen, safeLen),
    emittedLen: safeLen,
    sealed: false,
  };
}

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
      return withRetry(async () => {
        try {
          const fallback = structuredFallback(req);
          const effective = fallback?.req ?? req;
          const useTools = supportsTools() && !!req.tools?.length;
          const resp = await client().chat.completions.create({
            model: req.model,
            max_tokens: req.maxTokens,
            ...(req.temperature != null
              ? { temperature: req.temperature }
              : {}),
            messages: messages(effective),
            ...(useTools ? toolsParam(req) : {}),
          } as never);
          const choice = (
            resp as unknown as { choices?: Array<{ message?: ChoiceMessage }> }
          ).choices?.[0];
          if (!choice?.message) {
            // A misbehaving runner can return an empty `choices` array —
            // surface a classified, non-retryable error instead of a raw
            // TypeError from indexing past the end of it.
            throw new LLMError(
              "bad_request",
              undefined,
              "Model runner returned no choices in the completion response.",
              false,
            );
          }
          const result = parseChoice(choice.message, req.toolChoice);
          if (fallback && !result.toolCall) {
            result.toolCall = parseStructuredResult(result.text, fallback.tool);
          }
          return result;
        } catch (err) {
          throw toLLMError(err);
        }
      });
    },
    async *stream(req) {
      const fallback = structuredFallback(req);
      const effective = fallback?.req ?? req;
      const useTools = supportsTools() && !!req.tools?.length;
      // Only the ESTABLISHMENT call is retried — once text starts flowing
      // below, a partial stream can't be safely replayed.
      const s = await withRetry(async () => {
        try {
          return (await client().chat.completions.create({
            model: req.model,
            max_tokens: req.maxTokens,
            stream: true,
            messages: messages(effective),
            ...(useTools ? toolsParam(req) : {}),
          } as never)) as unknown as AsyncIterable<StreamChunk>;
        } catch (err) {
          throw toLLMError(err);
        }
      });
      let text = "";
      const toolArgs: Record<number, { name: string; args: string }> = {};
      // Tool-less fallback only: track how much prose has been safely
      // forwarded to the client, and whether the `<result>` sentinel has
      // been seen (once true, nothing more is ever emitted — see
      // `nextSafeProseSlice`). The native-tool path below ignores both and
      // keeps forwarding every delta verbatim, unchanged.
      let emittedLen = 0;
      let sealed = false;
      try {
        for await (const chunk of s) {
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            text += delta.content;
            if (fallback) {
              if (!sealed) {
                const next = nextSafeProseSlice(text, emittedLen);
                emittedLen = next.emittedLen;
                sealed = next.sealed;
                if (next.delta) {
                  yield {
                    type: "text",
                    delta: next.delta,
                  } satisfies LLMStreamEvent;
                }
              }
              // else: sentinel already seen — buffer silently, never emit.
            } else {
              yield {
                type: "text",
                delta: delta.content,
              } satisfies LLMStreamEvent;
            }
          }
          for (const tc of delta?.tool_calls ?? []) {
            const slot = (toolArgs[tc.index] ??= { name: "", args: "" });
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
          }
        }
        // Fallback path, no sentinel ever seen: flush the withheld tail
        // (there is no JSON block to hide, so all of it is safe prose).
        if (fallback && !sealed && emittedLen < text.length) {
          yield {
            type: "text",
            delta: text.slice(emittedLen),
          } satisfies LLMStreamEvent;
        }
      } catch (err) {
        throw toLLMError(err);
      }
      let toolCall: LLMResult["toolCall"];
      if (fallback) {
        toolCall = parseStructuredResult(text, fallback.tool);
      } else {
        const chosen = Object.values(toolArgs).find(
          (t) => !req.toolChoice || t.name === req.toolChoice,
        );
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
      }
      yield {
        type: "final",
        result: { text: text.trim(), toolCall },
      } satisfies LLMStreamEvent;
    },
  };
}
