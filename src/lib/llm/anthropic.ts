import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMCredentials,
  LLMProvider,
  LLMRequest,
  LLMResult,
  LLMStreamEvent,
} from "./types";
import { LLMError } from "./types";
import { withRetry } from "./retry";

/**
 * #35 Phase B — `creds` is a user's own key, when they brought one. An EMPTY
 * string is treated as absent rather than passed through: authenticating as ""
 * would produce a confusing 401 from Anthropic instead of the instance-key
 * fallback the caller expects.
 */
function client(creds?: LLMCredentials): Anthropic {
  const apiKey = creds?.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new LLMError(
      "auth",
      undefined,
      "ANTHROPIC_API_KEY is not set. Provide it in the environment (local dev: source it into your shell; CI/deploy: GitLab Secrets Manager).",
      false,
    );
  }
  return new Anthropic({ apiKey });
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

/** Anthropic-only tuning derived from request hints (no-ops on models that reject it). */
function hintParams(req: LLMRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (req.hints?.thinking) out.thinking = { type: "adaptive" };
  if (req.hints?.effort) out.output_config = { effort: req.hints.effort };
  return out;
}

function baseParams(req: LLMRequest): Record<string, unknown> {
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    ...(req.system ? { system: req.system } : {}),
    ...(req.temperature != null ? { temperature: req.temperature } : {}),
    ...(req.tools
      ? {
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
          })),
        }
      : {}),
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    ...hintParams(req),
  };
}

type ContentBlock = {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
};

function extract(content: ContentBlock[], toolChoice?: string): LLMResult {
  const text = content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  const tool = content.find(
    (b) => b.type === "tool_use" && (!toolChoice || b.name === toolChoice),
  );
  return {
    text,
    toolCall: tool
      ? {
          name: tool.name as string,
          input: tool.input as Record<string, unknown>,
        }
      : undefined,
  };
}

/**
 * `creds` (#35 Phase B) binds this provider to ONE caller's own API key for the
 * lifetime of the instance it returns. `getLLM()` never caches a credentialed
 * provider, so one user's key can't be reused for the next request.
 */
export function createAnthropicProvider(creds?: LLMCredentials): LLMProvider {
  return {
    id: "anthropic",
    supportsTools: true,
    async generate(req) {
      return withRetry(async () => {
        try {
          const resp = await client(creds).messages.create(
            baseParams(req) as never,
          );
          return extract(
            (resp as unknown as { content: ContentBlock[] }).content,
            req.toolChoice,
          );
        } catch (err) {
          throw toLLMError(err);
        }
      });
    },
    async *stream(req) {
      // Only the ESTABLISHMENT call is retried — once text starts flowing
      // (below) a partial stream can't be safely replayed.
      const ms = await withRetry(async () => {
        try {
          return client(creds).messages.stream(baseParams(req) as never);
        } catch (err) {
          throw toLLMError(err);
        }
      });
      const queue: string[] = [];
      let resolveNext: (() => void) | null = null;
      ms.on("text", (delta: string) => {
        queue.push(delta);
        resolveNext?.();
        resolveNext = null;
      });
      const finalPromise = ms.finalMessage().catch((err: unknown) => {
        throw toLLMError(err);
      });
      let done = false;
      finalPromise
        .finally(() => {
          done = true;
          resolveNext?.();
          resolveNext = null;
        })
        .catch(() => {
          // The rejection is surfaced below via `await finalPromise`; this
          // no-op catch only prevents the `.finally()`-derived promise from
          // being an unhandled rejection (it is a separate promise from
          // `finalPromise` and would otherwise go unobserved).
        });
      while (!done || queue.length > 0) {
        if (queue.length > 0) {
          yield {
            type: "text",
            delta: queue.shift() as string,
          } satisfies LLMStreamEvent;
          continue;
        }
        await new Promise<void>((r) => (resolveNext = r));
      }
      const final = await finalPromise;
      yield {
        type: "final",
        result: extract(
          (final as unknown as { content: ContentBlock[] }).content,
          req.toolChoice,
        ),
      } satisfies LLMStreamEvent;
    },
  };
}
