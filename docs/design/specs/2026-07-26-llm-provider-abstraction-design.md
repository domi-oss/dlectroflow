# LLM provider abstraction — bring-your-own-model (`{anthropic, openai-compatible}` behind one interface)

- **Date:** 2026-07-26
- **Status:** Draft (design) — awaiting approval before implementation plan
- **Issue:** #59 · **Epic:** #60 (Generalize integrations for self-host / OSS: LLM + scheduling + accounts)
- **Depends on:** nothing shipped — activates the existing dormant `LLM_PROVIDER` env seam
- **Size:** Medium — a seam + one new adapter + a tool-less structured-output fallback. No user-facing feature; the payoff is self-hosters can run local/other-vendor models.

## Goal

Today every LLM feature talks to Claude through the official `@anthropic-ai/sdk`, via one thin factory (`src/lib/anthropic.ts`) called directly from four call-sites. A forward-looking `LLM_PROVIDER=anthropic` env var already exists but is deliberately **unread** (a placeholder seam, allowlisted in `src/lib/env-drift.ts`). The repo is now public/AGPL, so the headline OSS ask is: **a self-hoster should be able to point dlectroflow at their own model — a local runner (Ollama, LM Studio, vLLM) or another hosted vendor — instead of being forced to hold an Anthropic key.**

#59 activates the `LLM_PROVIDER` seam and delivers a **`getLLM()` factory** returning a normalized LLM client, with two implementations:

1. **`anthropic`** — wraps today's SDK behaviour unchanged (native tool-use + streaming). Default; existing deployments are byte-for-byte unaffected.
2. **`openai-compatible`** — one adapter speaking the OpenAI Chat Completions API with a configurable `baseURL`/`apiKey`/`model`. This single adapter covers OpenAI, OpenRouter, Groq, Together, **and** local runners (Ollama `/v1`, LM Studio, vLLM, LocalAI) — the OpenAI wire format is the lingua franca.

Plus the thing that makes "runs fully local" actually true: **a tool-less structured-output fallback** so the core *breakdown* feature works even on local models with no tool-calling.

Concretely, #59 delivers:

1. A single normalized **`LLMProvider`** interface (`generate()` non-streaming + `stream()`), a normalized request/result/error shape, and a memoized **`getLLM()`** factory selecting the provider from `LLM_PROVIDER`.
2. An **`openai-compatible`** adapter (new) alongside the extracted **`anthropic`** adapter.
3. A **structured-output fallback** (`propose_steps` schema → JSON-in-text → parse) for models without native tool-calling, degrading to the existing `localBreakdown()` on parse failure.
4. A **provider-scoped model registry** replacing the Claude-string-hardcoded allowlist, so model IDs and per-model tuning params are provider-aware.
5. Provider-agnostic **error/observability** plumbing (normalized error type, generalized failure recorder + livez counter, optional retry/backoff on retryable 429/5xx) that **preserves the guest-never-calls-the-LLM invariant** and the guest-quota refund.

## Non-goals (deferred / out of scope)

- **Per-user / bring-your-own-*key***. v1 config is **global env** — the person running the instance picks one provider + key + base URL. True per-end-user keys require the accounts foundation (**F = #35**), which is not built. This is a *consequence* of #35 not being done, encoded so that when #35 lands, per-user key resolution is a change to *where the config is read*, not to the adapters.
- **A provider-switching UI.** Provider selection is env-only (`LLM_PROVIDER` + friends). The existing per-model settings picker stays (now provider-scoped), but choosing the *provider* is a deploy-time decision.
- **More than two providers / a plugin framework.** No dynamic registration, no `register(provider)` discovery API. Exactly two adapters (`anthropic`, `openai-compatible`); "another vendor" is expected to be reachable through the OpenAI-compatible adapter, not a bespoke third adapter.
- **Adding streaming to the three non-streaming call-sites** (spark, rollup, focus re-estimate). They stay `generate()` (non-streaming). Only breakdown streams, as today.
- **Capability auto-probing.** Whether a model supports tools is a **config flag** (`LLM_SUPPORTS_TOOLS`, default provider-appropriate), not a runtime probe. No speculative negotiation.
- **Changing prompts, the `StreamEvent` NDJSON contract, guest quota semantics, or the breakdown UX.** All unchanged; #59 changes *who makes the API call and how the response is normalized*, not what is asked or shown.

## Current state — the Anthropic-isms #59 normalizes

*(Full map: the #59 grounding brief. Summary of what is load-bearing.)*

**Four call-sites, all via `getAnthropic()` (`src/lib/anthropic.ts`):**

| # | Feature | File:line | Shape |
|---|---------|-----------|-------|
| 1 | **Breakdown coach** (task → ordered steps; core feature) | `src/app/api/breakdown/route.ts:166-182` | **Streaming + tool use** (`messages.stream()`, `.on("text")`, `finalMessage()`, extract `propose_steps` `tool_use` block) |
| 2 | Daily spark | `src/lib/spark.ts:29-48` | Non-streaming `messages.create()`, parse text blocks |
| 3 | End-of-day rollup | `src/lib/rollup.ts:128-164` | Non-streaming, parse text blocks |
| 4 | Kinder re-estimate | `src/app/actions/focus.ts:328-353` | Non-streaming, regex-extract `{"minutes":N}` from text |

No raw `fetch()` to the Anthropic REST API — all SDK. No wrapper beyond `getAnthropic()`; SDK types leak into call-sites (`Anthropic.Tool`, `b.type === "tool_use"`).

**Already provider-agnostic (keep as the interface boundary):** breakdown re-serializes to a custom NDJSON `StreamEvent` union (`{type: "text"|"steps"|"fallback"|"done"|"error"}`, `src/lib/breakdown.ts:49-59`). This is the output contract the abstraction feeds; it does not change.

**The Anthropic-isms baked into call-sites (each must be normalized):**

1. **Streaming format** — `messages.stream()` + `.on("text")` + `finalMessage()` + content-block deltas.
2. **Tool-calling schema** — `tools:[{name, description, input_schema}]` → returns a `tool_use` block with `.name`/`.input`. OpenAI uses `tools:[{type:"function", function:{parameters}}]` → returns `tool_calls[].function.arguments` (a **stringified** JSON). Tool-less models return neither.
3. **System-prompt handling** — Anthropic takes `system` as a top-level param; OpenAI wants a `role:"system"` message.
4. **Response parsing** — every read assumes `resp.content[]` blocks with `b.type`. OpenAI returns `choices[].message.content` (a string).
5. **Token/tuning params** — `max_tokens` (required by Anthropic; optional/`max_tokens` vs `max_completion_tokens` elsewhere), plus **Anthropic-only** `thinking:{type:"adaptive"}` and `output_config:{effort:"low"}` (`src/lib/models.ts:30-41`; Haiku already rejects `effort`).
6. **Model identity + selection** — hardcoded `BREAKDOWN_MODEL="claude-opus-4-8"` (`anthropic.ts:23`); dynamic owner/guest resolution in `src/lib/models.ts` (`resolveBreakdownModel()`); server-validated allowlist in `src/lib/constants.ts:111-119`; per-model params in `models.ts`.
7. **Config/auth** — one global `ANTHROPIC_API_KEY` (`anthropic.ts:10`), no `baseURL`, memoized `new Anthropic({apiKey})`.
8. **Errors** — code reads `err.status`/`err.message` off the SDK `APIError`; only breakdown reports via `recordAnthropicFailure("breakdown", err)` (`src/lib/observability.ts:23-41`) → structured log + `/api/livez` `anthropicFailures` counter. No retry/backoff. Guest-quota refund on breakdown failure (`route.ts:187-189`).

**Invariant to preserve:** `src/lib/ai-scope-guards.test.ts` asserts guests never reach the LLM on spark/rollup/focus paths (via `isGuestWorkspace` early-returns). The abstraction must keep guest-skips-the-LLM intact.

## Design

### 1. The seam — `src/lib/llm/`

A new server-only module. New dependency: `openai` (official SDK, for the OpenAI-compatible adapter — it accepts a `baseURL`, so one client class covers every OpenAI-compatible endpoint).

**Normalized types (`src/lib/llm/types.ts`):**

```ts
export type LLMMessage = { role: "user" | "assistant"; content: string };

/** Provider-agnostic tool definition (JSON Schema input). */
export type LLMTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
};

export type LLMRequest = {
  model: string;
  system?: string;
  messages: LLMMessage[];
  tools?: LLMTool[];
  /** Which tool the caller wants back parsed (breakdown → "propose_steps"). */
  toolChoice?: string;
  maxTokens: number;
  temperature?: number;
  /** Optional, provider-specific tuning that MUST no-op where unsupported. */
  hints?: { thinking?: boolean; effort?: "low" | "medium" | "high" };
};

export type LLMToolCall = { name: string; input: Record<string, unknown> };

export type LLMResult = { text: string; toolCall?: LLMToolCall };

/** Streaming: text deltas, then a resolved final result. */
export type LLMStreamEvent =
  | { type: "text"; delta: string }
  | { type: "final"; result: LLMResult };

export type LLMErrorKind =
  | "rate_limit"   // 429
  | "auth"         // 401/403
  | "bad_request"  // 400
  | "server"       // 5xx
  | "network"
  | "unknown";

export class LLMError extends Error {
  constructor(
    readonly kind: LLMErrorKind,
    readonly status: number | undefined,
    message: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) { super(message); }
}

export interface LLMProvider {
  readonly id: "anthropic" | "openai-compatible";
  /** Does this provider/model do native tool-calling? Drives the fallback. */
  readonly supportsTools: boolean;
  generate(req: LLMRequest): Promise<LLMResult>;
  stream(req: LLMRequest): AsyncIterable<LLMStreamEvent>;
}
```

Design notes:
- `LLMResult` is `{ text, toolCall? }` — call-sites stop touching content blocks. `LLMStreamEvent` is the *provider* stream contract; breakdown maps it onto the app's existing *client* `StreamEvent` NDJSON (unchanged) at `route.ts`.
- `hints` are **capability hints, not params** — `thinking`/`effort` apply on Anthropic, are dropped by the OpenAI adapter. A provider never errors because a hint it doesn't understand was passed.
- `stream()` is an `AsyncIterable`, not a callback emitter — cleaner to consume and to test (a fake provider just yields events). The breakdown route's current `.on("text")` loop becomes `for await`.

**Factory (`src/lib/llm/index.ts`):**

```ts
let cached: LLMProvider | undefined;
export function getLLM(): LLMProvider {
  if (cached) return cached;
  const provider = process.env.LLM_PROVIDER ?? "anthropic";
  cached = provider === "openai-compatible"
    ? createOpenAICompatibleProvider()
    : createAnthropicProvider();
  return cached;
}
```

Memoized exactly like today's `getAnthropic()`. Reads config lazily at first call (so `next build` survives an unset key), throwing a descriptive `LLMError("auth", …)` at request time if the selected provider's required env is missing.

### 2. Adapters

**`src/lib/llm/anthropic.ts`** — moves the logic from `src/lib/anthropic.ts` behind `LLMProvider`. `supportsTools = true`.
- `generate()` → `messages.create({ system, messages, tools?, max_tokens, ...hintsToAnthropic(hints) })`; map `content[]` → `{ text, toolCall }` (find the `tool_use` block matching `toolChoice`).
- `stream()` → `messages.stream(...)`; translate `.on("text")` deltas into `{type:"text",delta}` and `finalMessage()` into `{type:"final",result}`.
- `hintsToAnthropic` produces `thinking:{type:"adaptive"}` + `output_config:{effort}` only when hinted and model-appropriate (preserves today's Haiku-vs-Sonnet/Opus split).
- Maps `APIError.status` → `LLMError` (`429→rate_limit/retryable`, `401/403→auth`, `5xx→server/retryable`, else `bad_request/unknown`).

**`src/lib/llm/openai-compatible.ts`** — new. `new OpenAI({ apiKey: LLM_API_KEY ?? "not-needed", baseURL: LLM_BASE_URL })`. `supportsTools = LLM_SUPPORTS_TOOLS` (default `true`; self-hoster sets `false` for a tool-less local model).
- `generate()` → `chat.completions.create({ model, messages: [systemMsg?, ...messages], tools?, max_tokens })`; map `choices[0].message` → `{ text, toolCall }`, **`JSON.parse`-ing** `tool_calls[0].function.arguments` (stringified) into `toolCall.input`.
- `stream()` → `chat.completions.create({ stream: true })`; accumulate `choices[].delta.content` into `{type:"text",delta}` events and assemble streamed `tool_calls` argument fragments, emitting `{type:"final",result}` at the end.
- `system` → prepend a `{role:"system"}` message. `hints` → dropped. Maps HTTP status → `LLMError` the same way.
- **When `supportsTools === false`,** `generate`/`stream` ignore `req.tools` and defer structured output to §3.

### 3. Tool-less structured-output fallback — `src/lib/llm/structured-output.ts`

The crux of "runs fully local." When the active provider's `supportsTools` is false and the caller passed `tools` + `toolChoice`:

1. **Augment the prompt** — append to `system` (or the last user message) an instruction: *"Respond with a short conversational sentence, then output the result as a single JSON object inside a `<result>…</result>` block, matching this JSON Schema: `<inputSchema>`. Output nothing after the closing tag."* (Schema serialized from `LLMTool.inputSchema`.)
2. **Stream text through unchanged** — the model's prose still streams as `{type:"text"}` events, so the breakdown UX (text first, then steps) is preserved. The `<result>…</result>` block is buffered, not shown.
3. **Parse** — extract the `<result>` block (generalizing the `{"minutes":N}` regex idiom already in `focus.ts`), `JSON.parse`, and **validate against the schema** before accepting. On success → `{type:"final", result:{text, toolCall:{name, input}}}`.
4. **On any failure** (no block / bad JSON / schema mismatch) → return a result with **no `toolCall`**; the breakdown route already handles "no steps produced" by falling back to `localBreakdown()`. No new failure path, and the deterministic local fallback still guarantees the user gets steps.

Sentinel choice: `<result>…</result>` (an XML-ish tag) parses more reliably across small local models than fenced ```json (models emit stray fences). Validation is a minimal JSON-Schema check (the schema is simple: `parentEmoji` + `steps[]`); reuse an existing validator if one is already a dep, else a tiny hand-rolled check for the two known shapes — no new heavy dependency.

### 4. Provider-scoped model registry — generalize `src/lib/models.ts` + `src/lib/constants.ts`

Today model IDs and the allowlist are Claude strings. Generalize so the registry is provider-keyed:

- **`constants.ts`** — replace the flat Claude allowlist with a per-provider allowlist. For `anthropic`, the current three (`claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-8`) + defaults (owner=Sonnet, guest=Haiku) — **unchanged**. For `openai-compatible`, the allowlist is "whatever the self-hoster configured" — validation becomes "matches `LLM_MODEL` (+ optional `LLM_OWNER_MODEL`/`LLM_GUEST_MODEL`)" rather than a fixed list.
- **`models.ts`** — `resolveBreakdownModel(ctx)` keeps owner/guest resolution but reads from the active provider's registry entry. `breakdownParamsFor(model)` returns `hints` (not raw Anthropic params) — the adapter translates.
- **Settings UI** (`settings-panel.tsx`) — the per-model picker is shown only when the active provider exposes a **choice** (Anthropic's three tiers). For a single-model `openai-compatible` deploy, the picker collapses to a read-only "using `<LLM_MODEL>`" line. The locked `claude-fable-5` decoy stays Anthropic-only.

### 5. Errors, observability, retry — generalize (preserve invariants)

- `recordAnthropicFailure(feature, err)` → **`recordLLMFailure(provider, feature, err)`** (`observability.ts`); structured log tag `anthropic_failure` → `llm_failure` with a `provider` field.
- `/api/livez` `anthropicFailures` counter → **`llmFailures`** (keep `anthropicFailures` as a deprecated alias for one release to avoid breaking any dashboard/alert that reads it).
- **New: retry/backoff** in the adapters for `LLMError.retryable` (429/5xx) — small bounded exponential backoff (e.g. 2 retries), since the brief confirms none exists today. Non-retryable errors fail through to each call-site's existing local fallback immediately.
- **Guest invariant preserved** — the abstraction changes *how* the call is made, not *whether* guests reach it. The `isGuestWorkspace` early-returns on spark/rollup/focus stay exactly where they are; `ai-scope-guards.test.ts` must pass **unchanged**. Guest-quota metering + the breakdown refund-on-failure stay in `route.ts`.

### 6. Config surface (env)

| Var | Meaning | Default |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` \| `openai-compatible` | `anthropic` |
| `ANTHROPIC_API_KEY` | required when provider=anthropic | — |
| `LLM_BASE_URL` | OpenAI-compatible endpoint (e.g. `http://localhost:11434/v1`) | — |
| `LLM_API_KEY` | key for the OpenAI-compatible endpoint (optional for local) | — |
| `LLM_MODEL` | model id for the OpenAI-compatible provider | — |
| `LLM_OWNER_MODEL` / `LLM_GUEST_MODEL` | optional owner/guest split | fall back to `LLM_MODEL` |
| `LLM_SUPPORTS_TOOLS` | whether the configured model does native tool-calling | `true` |

`LLM_PROVIDER` is removed from the `env-drift.ts` intentionally-unread allowlist (it becomes read). `assertAuthConfig` / env validation gains a provider-conditional check: provider=anthropic requires `ANTHROPIC_API_KEY`; provider=openai-compatible requires `LLM_BASE_URL` + `LLM_MODEL`. `.env.example` documents all of the above.

## Refactor / migration path (incremental, each step green)

Ordered so every phase is independently shippable and the diff stays reviewable. Default `LLM_PROVIDER=anthropic` means **the live deployment is unaffected at every phase.**

- **Phase A — extract the Anthropic adapter behind `LLMProvider` (no behavior change).** Add `src/lib/llm/{types,anthropic,index}.ts`; `getLLM()` returns the Anthropic adapter. Migrate the **four call-sites** from `getAnthropic()` + raw SDK to `getLLM()` + normalized `{text, toolCall}` / `for await` stream. `src/lib/anthropic.ts` becomes a thin re-export shim (or is deleted if no external import remains). All existing tests pass; this is pure indirection. *Highest-value lowest-risk commit — ships even if later phases slip.*
- **Phase B — provider-scoped model registry.** Generalize `models.ts` + `constants.ts` to provider-keyed; `breakdownParamsFor` → `hints`. Anthropic behavior identical. Settings picker reads the registry.
- **Phase C — the OpenAI-compatible adapter.** Add `src/lib/llm/openai-compatible.ts` + the `openai` dep + env wiring + `env-drift`/`assertAuthConfig` updates. Factory can now select it. Native-tool path only.
- **Phase D — tool-less structured-output fallback.** Add `src/lib/llm/structured-output.ts`; wire it into the OpenAI-compatible adapter's `generate`/`stream` when `supportsTools=false`; breakdown route consumes it via the same normalized result (falls back to `localBreakdown()` on parse failure).
- **Phase E — generalize errors/observability + retry.** Rename `recordAnthropicFailure`→`recordLLMFailure`, `anthropicFailures`→`llmFailures` (with alias), add bounded retry on retryable errors. Update `livez` + its test.

Client imports and the `StreamEvent` NDJSON contract stay valid throughout.

## Testing (TDD)

No live network in any test — adapters are tested against a mocked `openai` client / mocked `@anthropic-ai/sdk`, and call-sites against a **fake `LLMProvider`** injected via `getLLM()`.

- **`types`/`index.test.ts`** — factory returns Anthropic by default, OpenAI-compatible when `LLM_PROVIDER=openai-compatible`; memoization; missing-required-env → descriptive `LLMError`.
- **`anthropic.test.ts`** — `generate` maps `content[]` → `{text, toolCall}`; `stream` yields text deltas then final; `hints` produce thinking/effort only where model-appropriate; status→`LLMError` kind mapping.
- **`openai-compatible.test.ts`** — `system` → system message; `generate` `JSON.parse`s `tool_calls.arguments`; `stream` accumulates content + tool-call fragments; hints dropped; status→`LLMError` mapping.
- **`structured-output.test.ts`** — schema-as-instruction is injected; valid `<result>` block → parsed `toolCall`; missing/malformed/partial/ schema-mismatch → **no `toolCall`** (never throws); text still streams.
- **Contract test** — a shared suite runs both adapters against the same `LLMRequest` (with mocked transports) and asserts both return the normalized `LLMResult`/`LLMStreamEvent` shape.
- **Call-site regression (must pass unchanged where behavior is identical):** breakdown route (native-tool path with a fake tool-capable provider **and** the fallback path with a fake tool-less provider both yield `steps`), `ai-scope-guards.test.ts` (guest still never calls the LLM), spark/rollup/focus fallbacks still fire on provider error.
- **Gates:** `tsc --noEmit`, `eslint`, full `vitest run` green. Read `node_modules/next/dist/docs/` before touching any Next-specific code (this Next version diverges from training data — see `AGENTS.md`).

## Rollout / risk

- **Zero change to the live deployment**: default provider is `anthropic`, behavior byte-identical after Phase A. New env vars are all optional/defaulted.
- **New dependency** `openai` — vetted, official, widely used; used only server-side in one adapter.
- **Main risks:**
  1. *Streaming regression in breakdown* during Phase A (the `.on("text")` → `for await` move). Mitigated by requiring the breakdown route test + a manual smoke to pass unchanged.
  2. *Tool-less fallback reliability* on small local models (the model ignores the format). Mitigated because a parse failure degrades to the existing deterministic `localBreakdown()` — the user always gets steps; worst case a local model gives non-AI-quality steps, never an error.
  3. *Observability rename* breaking a dashboard/alert — mitigated by keeping `anthropicFailures` as a one-release alias.
- Land **Phase A alone first** for immediate value (the seam + normalized call-sites) if review time is tight; Phases C–D are what unlock BYO-model and can follow.

## TDD-friendly task breakdown

1. **Normalized types + Anthropic adapter + factory (Phase A).** Write `index.test.ts` + `anthropic.test.ts` → implement `types.ts`, `anthropic.ts`, `index.ts` → migrate the four call-sites to `getLLM()` + `{text, toolCall}`/`for await`. Green: new tests + all existing call-site/scope-guard tests unchanged.
2. **Provider-scoped model registry (Phase B).** Write registry tests → generalize `models.ts` + `constants.ts` (Anthropic behavior identical) → settings picker reads registry. Green: existing settings/model tests unchanged.
3. **OpenAI-compatible adapter (Phase C).** Write `openai-compatible.test.ts` → add the `openai` dep + adapter (native-tool path) + env wiring + `env-drift`/`assertAuthConfig`/`.env.example`. Green: adapter tests + contract test.
4. **Tool-less structured-output fallback (Phase D).** Write `structured-output.test.ts` + a breakdown-route test with a fake tool-less provider → implement `structured-output.ts` + wire into the OpenAI-compatible adapter + breakdown consumption. Green: fallback yields steps; parse-failure degrades to `localBreakdown()`.
5. **Errors/observability/retry (Phase E).** Write updated `observability`/`livez` tests → rename to `recordLLMFailure`/`llmFailures` (+ alias) + bounded retry on retryable errors. Green: updated tests + retry tests.
6. **Final verification.** `tsc --noEmit` + `eslint` + full `vitest run`; smoke-test breakdown streaming on `anthropic` (unchanged) and, if a local runner is available, on `openai-compatible` with `LLM_SUPPORTS_TOOLS=false`.
