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
  { type: "text"; delta: string } | { type: "final"; result: LLMResult };

export type LLMErrorKind =
  "rate_limit" | "auth" | "bad_request" | "server" | "network" | "unknown";

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

/**
 * A per-request credential that overrides the instance's own configuration.
 *
 * #35 Phase B — a signed-in account may bring its own LLM key, in which case the
 * breakdown is billed to that key instead of the instance's and is not metered.
 * `apiKey` is a DECRYPTED secret: server-only, never logged, never in a response.
 *
 * Deliberately narrow. There is no `baseUrl` here: letting a per-user value
 * choose the endpoint would turn a settings field into an SSRF primitive, and
 * the deploy's `LLM_BASE_URL` stays authoritative.
 */
export type LLMCredentials = {
  apiKey: string;
  /** Which adapter to bind the key to; null/unknown → the instance's provider. */
  provider?: string | null;
};

export interface LLMProvider {
  readonly id: "anthropic" | "openai-compatible";
  /** Native tool-calling? Drives the tool-less structured-output fallback. */
  readonly supportsTools: boolean;
  generate(req: LLMRequest): Promise<LLMResult>;
  stream(req: LLMRequest): AsyncIterable<LLMStreamEvent>;
}
