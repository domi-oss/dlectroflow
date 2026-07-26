// Server-only. Provider-agnostic LLM types. No SDK imports — this is the
// interface boundary every adapter and call-site depends on.

export type LLMMessage = { role: "user" | "assistant"; content: string };

/** Provider-agnostic tool definition (JSON Schema input). */
export type LLMTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type LLMRequest = {
  model: string;
  system?: string;
  messages: LLMMessage[];
  tools?: LLMTool[];
  /** Which tool the caller wants parsed back (breakdown → "propose_steps"). */
  toolChoice?: string;
  maxTokens: number;
  temperature?: number;
  /** Optional tuning; MUST no-op on providers/models that don't support it. */
  hints?: { thinking?: boolean; effort?: "low" | "medium" | "high" };
};

export type LLMToolCall = { name: string; input: Record<string, unknown> };

export type LLMResult = { text: string; toolCall?: LLMToolCall };

export type LLMStreamEvent =
  | { type: "text"; delta: string }
  | { type: "final"; result: LLMResult };

export type LLMErrorKind =
  | "rate_limit"
  | "auth"
  | "bad_request"
  | "server"
  | "network"
  | "unknown";

export class LLMError extends Error {
  constructor(
    readonly kind: LLMErrorKind,
    readonly status: number | undefined,
    message: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export interface LLMProvider {
  readonly id: "anthropic" | "openai-compatible";
  /** Native tool-calling? Drives the tool-less structured-output fallback. */
  readonly supportsTools: boolean;
  generate(req: LLMRequest): Promise<LLMResult>;
  stream(req: LLMRequest): AsyncIterable<LLMStreamEvent>;
}
