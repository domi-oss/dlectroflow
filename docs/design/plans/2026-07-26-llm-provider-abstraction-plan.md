# LLM Provider Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the dormant `LLM_PROVIDER` seam so a self-hoster can run dlectroflow against their own model (local runner or other vendor) instead of an Anthropic key, without changing the live deployment.

**Architecture:** A new `src/lib/llm/` module exposes a memoized `getLLM()` factory returning a normalized `LLMProvider` (`generate()` + `stream()`). Two adapters — `anthropic` (extracted from today's code, unchanged behavior) and `openai-compatible` (new; covers OpenAI/Ollama/LM Studio/vLLM/OpenRouter) — plus a tool-less structured-output fallback so the breakdown feature works on models without native tool-calling. The four existing call-sites migrate from the raw SDK to normalized `{ text, toolCall? }` / an async-iterable stream. Default provider stays `anthropic`.

**Tech Stack:** Next.js (App Router — **breaking changes vs. training data; read `node_modules/next/dist/docs/` before touching Next-specific code, see `AGENTS.md`**), TypeScript, `@anthropic-ai/sdk` (existing), `openai` (new dep, Phase C), Prisma/Postgres, Vitest (unit, `vitest run`), Playwright (E2E).

## Global Constraints

- **Default `LLM_PROVIDER=anthropic`** — every phase must leave the live deployment byte-for-byte unchanged when the env is unset.
- **Preserve the guest-never-calls-the-LLM invariant** — `src/lib/ai-scope-guards.test.ts` must pass **unchanged** after every task.
- **Preserve the `StreamEvent` NDJSON client contract** (`src/lib/breakdown.ts:49-59`) — it does not change; the abstraction feeds it.
- **No live network in any test** — mock `@anthropic-ai/sdk` and the `openai` client; test call-sites against a fake `LLMProvider`.
- **TDD, frequent commits** — failing test first, minimal impl, green, commit. Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Reference `#59` in commit subjects.
- **Gates before any "done" claim:** `npx tsc --noEmit`, `npx eslint .`, `npx prettier --check .`, `npx vitest run` (non-DB units) all green.
- **Branch:** `feat/59-llm-provider-abstraction` (already created; the spec + this plan are committed on it).

---

### Task 1: Normalized LLM types

**Files:**
- Create: `src/lib/llm/types.ts`
- Test: `src/lib/llm/types.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module — no SDK imports, so it is safe to import anywhere).
- Produces: `LLMMessage`, `LLMTool`, `LLMRequest`, `LLMToolCall`, `LLMResult`, `LLMStreamEvent`, `LLMErrorKind`, `LLMError`, `LLMProvider` — consumed by Tasks 2, 3, 4, 6, 7.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/llm/types.test.ts
import { describe, it, expect } from "vitest";
import { LLMError } from "./types";

describe("LLMError", () => {
  it("carries kind, status, retryable and message", () => {
    const e = new LLMError("rate_limit", 429, "slow down", true);
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe("rate_limit");
    expect(e.status).toBe(429);
    expect(e.retryable).toBe(true);
    expect(e.message).toBe("slow down");
  });

  it("preserves the original cause", () => {
    const cause = new Error("socket hang up");
    const e = new LLMError("network", undefined, "network error", true, cause);
    expect(e.cause).toBe(cause);
    expect(e.status).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/llm/types.test.ts`
Expected: FAIL — `Cannot find module './types'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/llm/types.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/llm/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/types.ts src/lib/llm/types.test.ts
git commit -m "feat(#59): normalized LLM provider types"
```

---

### Task 2: Anthropic adapter + factory

**Files:**
- Create: `src/lib/llm/anthropic.ts`, `src/lib/llm/index.ts`
- Test: `src/lib/llm/anthropic.test.ts`, `src/lib/llm/index.test.ts`
- Reference (behavior to preserve): `src/lib/anthropic.ts`, `src/lib/models.ts:30-41`

**Interfaces:**
- Consumes: `LLMProvider`, `LLMRequest`, `LLMResult`, `LLMStreamEvent`, `LLMError` (Task 1).
- Produces: `createAnthropicProvider(): LLMProvider` and `getLLM(): LLMProvider` (memoized) + `_resetLLMForTest()` — consumed by Tasks 3, 4, 6.

- [ ] **Step 1: Write the failing test for `generate` mapping**

```ts
// src/lib/llm/anthropic.test.ts
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
});
```

> **Note for the implementer:** the stream test above is timing-sensitive because it bridges the SDK's callback API to an async iterator. Implement `stream()` with a small internal queue (push on `on("text")`, resolve on `finalMessage()`); if the queue-drain test is flaky, restructure the test to collect events after resolution rather than mid-flight, but keep asserting both the `text` and `final` events.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/llm/anthropic.test.ts`
Expected: FAIL — `Cannot find module './anthropic'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/llm/anthropic.ts
import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, LLMRequest, LLMResult, LLMStreamEvent } from "./types";
import { LLMError } from "./types";

function client(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
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
  const e = err as { message?: unknown; status?: unknown } | undefined;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const message = typeof e?.message === "string" ? e.message : String(err);
  if (status === 429) return new LLMError("rate_limit", 429, message, true, err);
  if (status === 401 || status === 403) return new LLMError("auth", status, message, false, err);
  if (status && status >= 500) return new LLMError("server", status, message, true, err);
  if (status && status >= 400) return new LLMError("bad_request", status, message, false, err);
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

function extract(content: Array<{ type: string; text?: string; name?: string; input?: unknown }>, toolChoice?: string): LLMResult {
  const text = content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  const tool = content.find((b) => b.type === "tool_use" && (!toolChoice || b.name === toolChoice));
  return {
    text,
    toolCall: tool ? { name: tool.name as string, input: tool.input as Record<string, unknown> } : undefined,
  };
}

export function createAnthropicProvider(): LLMProvider {
  return {
    id: "anthropic",
    supportsTools: true,
    async generate(req) {
      try {
        const resp = await client().messages.create(baseParams(req) as never);
        return extract((resp as { content: [] }).content, req.toolChoice);
      } catch (err) {
        throw toLLMError(err);
      }
    },
    async *stream(req) {
      let ms;
      try {
        ms = client().messages.stream(baseParams(req) as never);
      } catch (err) {
        throw toLLMError(err);
      }
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
      finalPromise.finally(() => {
        done = true;
        resolveNext?.();
        resolveNext = null;
      });
      while (!done || queue.length > 0) {
        if (queue.length > 0) {
          yield { type: "text", delta: queue.shift() as string } satisfies LLMStreamEvent;
          continue;
        }
        if (done) break;
        await new Promise<void>((r) => (resolveNext = r));
      }
      const final = await finalPromise;
      yield {
        type: "final",
        result: extract((final as { content: [] }).content, req.toolChoice),
      } satisfies LLMStreamEvent;
    },
  };
}
```

- [ ] **Step 4: Run the adapter test to verify it passes**

Run: `npx vitest run src/lib/llm/anthropic.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing factory test**

```ts
// src/lib/llm/index.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { getLLM, _resetLLMForTest } from "./index";

beforeEach(() => {
  _resetLLMForTest();
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.LLM_PROVIDER;
});

describe("getLLM()", () => {
  it("defaults to the anthropic provider", () => {
    expect(getLLM().id).toBe("anthropic");
  });

  it("memoizes the provider instance", () => {
    expect(getLLM()).toBe(getLLM());
  });
});
```

- [ ] **Step 6: Implement the factory**

```ts
// src/lib/llm/index.ts
import type { LLMProvider } from "./types";
import { createAnthropicProvider } from "./anthropic";

let cached: LLMProvider | undefined;

export function getLLM(): LLMProvider {
  if (cached) return cached;
  const provider = process.env.LLM_PROVIDER ?? "anthropic";
  // Task 6 adds the "openai-compatible" branch here.
  cached = createAnthropicProvider();
  if (provider !== "anthropic" && provider !== "openai-compatible") {
    // Unknown value → fall back to the safe default, but make it visible.
    console.error(`[llm] unknown LLM_PROVIDER="${provider}", defaulting to anthropic`);
  }
  return cached;
}

export function _resetLLMForTest(): void {
  cached = undefined;
}

export type { LLMProvider } from "./types";
```

- [ ] **Step 7: Run both tests + gates**

Run: `npx vitest run src/lib/llm/ && npx tsc --noEmit && npx eslint src/lib/llm/`
Expected: PASS / no errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/llm/anthropic.ts src/lib/llm/anthropic.test.ts src/lib/llm/index.ts src/lib/llm/index.test.ts
git commit -m "feat(#59): anthropic adapter + getLLM() factory"
```

---

### Task 3: Migrate the breakdown route (streaming + tool) to `getLLM()`

**Files:**
- Modify: `src/app/api/breakdown/route.ts`
- Reference test (must stay green, adapt mock target): `src/app/api/breakdown/route.test.ts` (if present) or the nearest breakdown route test.

**Interfaces:**
- Consumes: `getLLM()` (Task 2), `LLMTool` (Task 1), existing `StreamEvent`/`Proposal`/`buildUserPrompt`/`localBreakdown` (`src/lib/breakdown.ts`), `resolveBreakdownModel`/`breakdownParamsFor` (`src/lib/models.ts`).
- Produces: no new exports — same NDJSON response contract.

- [ ] **Step 1: Update the route test to drive a fake provider**

Find the existing breakdown route test. Replace its `@/lib/anthropic` mock with a fake `getLLM` whose `stream()` is an async generator yielding text then a `final` with a `toolCall`. Add/keep assertions: (a) `text` NDJSON events are forwarded; (b) a `steps` event carries `toolCall.input`; (c) on the provider throwing, a `fallback` event with `reason:"error"` is sent and `localBreakdown` is used. Example fake:

```ts
vi.mock("@/lib/llm", () => ({
  getLLM: () => ({
    id: "anthropic",
    supportsTools: true,
    async *stream() {
      yield { type: "text", delta: "hi " };
      yield {
        type: "final",
        result: { text: "hi ", toolCall: { name: "propose_steps", input: { parentEmoji: "🗂️", steps: [] } } },
      };
    },
    generate: vi.fn(),
  }),
}));
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/api/breakdown` (path per the real test file)
Expected: FAIL — route still imports `getAnthropic`/uses `ms.on`.

- [ ] **Step 3: Rewrite the route's LLM section**

Replace the imports and the `try` block body (`route.ts:1-3, 19, 45-78, 165-182`). Convert `PROPOSE_TOOL` from `Anthropic.Tool` to the normalized `LLMTool` (same schema, `input_schema` → `inputSchema`), and drive the stream via `for await`:

```ts
// top of file — replace the anthropic/observability imports
import { getLLM } from "@/lib/llm";
import type { LLMTool } from "@/lib/llm/types";
import { recordAnthropicFailure } from "@/lib/observability"; // renamed in Task 8
// (drop: import type Anthropic from "@anthropic-ai/sdk"; import { getAnthropic } ...)

const PROPOSE_TOOL: LLMTool = {
  name: "propose_steps",
  description: "Propose the breakdown of the task into small, ordered, actionable steps.",
  inputSchema: {
    /* identical JSON Schema object as before */
  },
};
```

```ts
// inside stream start(), replacing the getAnthropic()/ms.on block:
try {
  const params = breakdownParamsFor(model); // { model, thinking?, output_config? }
  const llm = getLLM();
  for await (const ev of llm.stream({
    model: params.model,
    system: SYSTEM,
    messages: [{ role: "user", content: buildUserPrompt(body) }],
    tools: [PROPOSE_TOOL],
    toolChoice: "propose_steps",
    maxTokens: 6000,
    hints: { thinking: !!params.thinking, effort: params.output_config?.effort },
  })) {
    if (ev.type === "text") {
      send({ type: "text", delta: ev.delta });
    } else if (ev.type === "final") {
      if (ev.result.toolCall?.name === "propose_steps") {
        send({ type: "steps", data: ev.result.toolCall.input as unknown as Proposal });
      }
    }
  }
  send({ type: "done" });
} catch (err) {
  recordAnthropicFailure("breakdown", err);
  if (isGuest && guestIpHash && !blockedReason) {
    await refundGuestBreakdown(guestIpHash);
  }
  send({ type: "fallback", reason: "error", data: localBreakdown(body.title) });
  send({ type: "done" });
} finally {
  controller.close();
}
```

> `breakdownParamsFor` still returns Anthropic-flavored keys at this point — we translate them into `hints` here. Task 5 changes `breakdownParamsFor` to return `hints` directly; when that lands, simplify this to `...params`.

- [ ] **Step 4: Run the route test + scope guard**

Run: `npx vitest run src/app/api/breakdown src/lib/ai-scope-guards.test.ts`
Expected: PASS (both). Guest path unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/breakdown/route.ts src/app/api/breakdown/*.test.ts
git commit -m "feat(#59): breakdown route streams via getLLM() (no behavior change)"
```

---

### Task 4: Migrate spark / rollup / focus to `getLLM().generate()`

**Files:**
- Modify: `src/lib/spark.ts`, `src/lib/rollup.ts`, `src/app/actions/focus.ts`
- Tests (keep green): the existing spark/rollup/focus tests + `src/lib/ai-scope-guards.test.ts`

**Interfaces:**
- Consumes: `getLLM()` (Task 2), `BREAKDOWN_MODEL` (still exported from `src/lib/anthropic.ts` shim, or inline the constant).
- Produces: no new exports.

- [ ] **Step 1: Update spark test to a fake provider**

In the spark test, mock `@/lib/llm` so `getLLM().generate()` resolves `{ text: "a warm line", toolCall: undefined }`; assert `getTodaySpark` for the owner returns `source: AI` with that text, and that a `generate` rejection falls back to a canned spark (`source: Fallback`). Keep the guest-returns-fallback-without-calling-generate assertion.

- [ ] **Step 2: Verify it fails**

Run: `npx vitest run src/lib/spark`
Expected: FAIL — spark still imports `getAnthropic`.

- [ ] **Step 3: Rewrite `generateQuote()` in `spark.ts`**

```ts
// src/lib/spark.ts — replace the import and the try block
import { getLLM } from "@/lib/llm";
import { BREAKDOWN_MODEL } from "@/lib/anthropic"; // shim keeps this export

async function generateQuote(): Promise<{ quote: string; source: string }> {
  try {
    const { text } = await getLLM().generate({
      model: BREAKDOWN_MODEL,
      maxTokens: 120,
      hints: { effort: "low" },
      messages: [
        {
          role: "user",
          content:
            "Write ONE short (max ~120 chars), warm, genuine encouraging line for someone with ADHD starting their day. Not cheesy, no emoji, no quotation marks, no attribution — just the line.",
        },
      ],
    });
    const clean = text.trim().replace(/^["']|["']$/g, "");
    if (clean) return { quote: clean, source: SparkSource.AI };
  } catch {
    // fall through to fallback
  }
  return { quote: randomFallback(), source: SparkSource.Fallback };
}
```

- [ ] **Step 4: Verify spark test passes**

Run: `npx vitest run src/lib/spark`
Expected: PASS.

- [ ] **Step 5: Repeat the same pattern for `rollup.ts` and `focus.ts`**

For each: update the test to the `@/lib/llm` fake first (red), then replace `getAnthropic().messages.create(...)` + content-block parsing with `getLLM().generate({ model, maxTokens, hints:{effort:"low"}, messages })` and read `.text`. `focus.ts` keeps its `{"minutes":N}` regex applied to `.text` (unchanged). Preserve every existing fallback (`fallbackNarrative()`, `estMinutes + 10`) and the `isGuestWorkspace` early-returns.

- [ ] **Step 6: Run all affected tests + scope guard + gates**

Run: `npx vitest run src/lib/spark src/lib/rollup src/app/actions/focus src/lib/ai-scope-guards.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/spark.ts src/lib/rollup.ts src/app/actions/focus.ts src/lib/spark.test.ts src/lib/rollup.test.ts src/app/actions/focus*.test.ts
git commit -m "feat(#59): spark/rollup/focus use getLLM().generate() (no behavior change)"
```

> **End of Phase A.** At this point `getAnthropic()` has no remaining callers except the `BREAKDOWN_MODEL` re-export. Optionally slim `src/lib/anthropic.ts` to just `export const BREAKDOWN_MODEL` (drop the client), or leave the shim; a follow-up commit can delete `getAnthropic` once nothing imports it.

---

### Task 5: Provider-scoped model registry

**Files:**
- Modify: `src/lib/models.ts`, `src/lib/constants.ts` (allowlist section, ~`:111-119`), `src/components/settings/settings-panel.tsx` (model picker), `src/app/api/breakdown/route.ts` (simplify `hints`), `src/lib/spark.ts`/`rollup.ts`/`focus.ts` (model source)
- Tests: `src/lib/models.test.ts` (create/extend), existing settings-panel test

**Interfaces:**
- Consumes: env vars `LLM_PROVIDER`, `LLM_MODEL`, `LLM_OWNER_MODEL`, `LLM_GUEST_MODEL`, existing `OWNER_BREAKDOWN_*`/`GUEST_BREAKDOWN_MODEL_DEFAULT`.
- Produces: `resolveBreakdownModel(ctx)` (unchanged signature, provider-aware body), `breakdownParamsFor(model): { model, hints }`, `modelChoicesForProvider(): { id, label }[] | null` (null = no user choice) — consumed by the settings picker and the breakdown route.

- [ ] **Step 1: Write failing registry tests**

```ts
// src/lib/models.test.ts (add cases)
import { describe, it, expect, beforeEach } from "vitest";
import { resolveBreakdownModel, breakdownParamsFor, modelChoicesForProvider } from "./models";

beforeEach(() => {
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_MODEL;
  delete process.env.OWNER_BREAKDOWN_MODEL;
});

describe("anthropic provider (default)", () => {
  it("guest → haiku default, owner → sonnet default", () => {
    expect(resolveBreakdownModel({ isOwner: false })).toBe("claude-haiku-4-5");
    expect(resolveBreakdownModel({ isOwner: true })).toBe("claude-sonnet-4-6");
  });
  it("breakdownParamsFor returns hints (thinking/effort) for sonnet/opus, bare for haiku", () => {
    expect(breakdownParamsFor("claude-haiku-4-5")).toEqual({ model: "claude-haiku-4-5", hints: {} });
    expect(breakdownParamsFor("claude-opus-4-8")).toEqual({
      model: "claude-opus-4-8",
      hints: { thinking: true, effort: "low" },
    });
  });
  it("exposes the three-tier choice list", () => {
    expect(modelChoicesForProvider()?.map((c) => c.id)).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
      "claude-opus-4-8",
    ]);
  });
});

describe("openai-compatible provider", () => {
  beforeEach(() => {
    process.env.LLM_PROVIDER = "openai-compatible";
    process.env.LLM_MODEL = "llama3.1:8b";
  });
  it("owner + guest both resolve to LLM_MODEL when no split set", () => {
    expect(resolveBreakdownModel({ isOwner: true })).toBe("llama3.1:8b");
    expect(resolveBreakdownModel({ isOwner: false })).toBe("llama3.1:8b");
  });
  it("has no user-facing choice list (single configured model)", () => {
    expect(modelChoicesForProvider()).toBeNull();
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `npx vitest run src/lib/models.test.ts`
Expected: FAIL — `modelChoicesForProvider` undefined; `breakdownParamsFor` returns old shape.

- [ ] **Step 3: Implement the provider-scoped registry**

Rewrite `src/lib/models.ts` to branch on `process.env.LLM_PROVIDER`. Anthropic branch keeps today's allowlist + defaults + hint mapping (now returned as `hints`); openai-compatible branch reads `LLM_MODEL`/`LLM_OWNER_MODEL`/`LLM_GUEST_MODEL` and returns `hints:{}` (hints no-op there). Keep `OWNER_BREAKDOWN_ALLOWLIST` in `constants.ts` as the anthropic allowlist.

- [ ] **Step 4: Simplify the breakdown route + call-sites to consume `hints` directly**

In `route.ts`, replace the hand-built `hints:{ thinking: !!params.thinking, ... }` with `...breakdownParamsFor(model)` (now `{ model, hints }`). spark/rollup/focus keep `hints:{effort:"low"}` inline (they don't use the registry's per-model hints).

- [ ] **Step 5: Update the settings model picker**

In `settings-panel.tsx`, render the picker from `modelChoicesForProvider()`; when it returns `null`, show a read-only "Using model: `<LLM_MODEL>`" line instead of the `<select>`. Keep the locked `claude-fable-5` decoy in the anthropic branch only. Update the settings-panel test accordingly.

- [ ] **Step 6: Run tests + gates**

Run: `npx vitest run src/lib/models src/components/settings src/app/api/breakdown && npx tsc --noEmit && npx eslint src/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/models.ts src/lib/models.test.ts src/lib/constants.ts src/components/settings/settings-panel.tsx src/components/settings/*.test.tsx src/app/api/breakdown/route.ts
git commit -m "feat(#59): provider-scoped model registry"
```

---

### Task 6: OpenAI-compatible adapter + env wiring

**Files:**
- Create: `src/lib/llm/openai-compatible.ts`, `src/lib/llm/openai-compatible.test.ts`
- Modify: `src/lib/llm/index.ts` (wire the branch), `src/lib/env-drift.ts` (drop `LLM_PROVIDER` from the intentionally-unread allowlist), the auth/env validator (`src/lib/auth/config.ts` `assertAuthConfig` or wherever env is asserted), `.env.example`, `package.json` (add `openai`)
- Reference: `node_modules/next/dist/docs/` is not needed here (server lib only), but do read the `openai` SDK's streaming docs via context7 if unsure.

**Interfaces:**
- Consumes: `LLMProvider` types (Task 1). Env: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_SUPPORTS_TOOLS`.
- Produces: `createOpenAICompatibleProvider(): LLMProvider` — consumed by `getLLM()`.

- [ ] **Step 1: Add the dependency (in the CI image, per repo lockfile rules)**

Add `"openai"` to `package.json` dependencies. Regenerate the lockfile inside the `node:22-alpine` CI image (local npm is allow-scripts-wrapped — see repo memory `dev-env-wrapped-npm-lockfile`). Do not `npm ci` in a worktree.

- [ ] **Step 2: Write the failing adapter test**

```ts
// src/lib/llm/openai-compatible.test.ts
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
});

describe("openai-compatible generate()", () => {
  it("prepends system as a message and parses stringified tool arguments", async () => {
    create.mockResolvedValue({
      choices: [
        {
          message: {
            content: "here you go",
            tool_calls: [
              { function: { name: "propose_steps", arguments: '{"parentEmoji":"🗂️","steps":[]}' } },
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
    expect(r.toolCall).toEqual({ name: "propose_steps", input: { parentEmoji: "🗂️", steps: [] } });
  });

  it("maps a 429 to a retryable rate_limit LLMError", async () => {
    create.mockRejectedValue(Object.assign(new Error("rate"), { status: 429 }));
    const p = createOpenAICompatibleProvider();
    await expect(
      p.generate({ model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 10 }),
    ).rejects.toMatchObject({ kind: "rate_limit", retryable: true });
  });
});
```

- [ ] **Step 3: Verify fail**

Run: `npx vitest run src/lib/llm/openai-compatible.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement the adapter (native-tool path only; fallback is Task 7)**

```ts
// src/lib/llm/openai-compatible.ts
import OpenAI from "openai";
import type { LLMProvider, LLMRequest, LLMResult, LLMStreamEvent } from "./types";
import { LLMError } from "./types";

function client(): OpenAI {
  const baseURL = process.env.LLM_BASE_URL;
  if (!baseURL) {
    throw new LLMError("auth", undefined, "LLM_BASE_URL is not set (required for LLM_PROVIDER=openai-compatible).", false);
  }
  // Many local runners need no key; OpenAI SDK requires a non-empty string.
  return new OpenAI({ baseURL, apiKey: process.env.LLM_API_KEY || "not-needed" });
}

function toLLMError(err: unknown): LLMError {
  const e = err as { message?: unknown; status?: unknown } | undefined;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const message = typeof e?.message === "string" ? e.message : String(err);
  if (status === 429) return new LLMError("rate_limit", 429, message, true, err);
  if (status === 401 || status === 403) return new LLMError("auth", status, message, false, err);
  if (status && status >= 500) return new LLMError("server", status, message, true, err);
  if (status && status >= 400) return new LLMError("bad_request", status, message, false, err);
  return new LLMError("network", undefined, message, true, err);
}

function messages(req: LLMRequest) {
  const out = req.messages.map((m) => ({ role: m.role, content: m.content }));
  return req.system ? [{ role: "system" as const, content: req.system }, ...out] : out;
}

function toolsParam(req: LLMRequest) {
  if (!req.tools?.length) return {};
  return {
    tools: req.tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),
  };
}

function parseChoice(msg: { content?: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> }, toolChoice?: string): LLMResult {
  const text = (msg.content ?? "").trim();
  const call = msg.tool_calls?.find((c) => !toolChoice || c.function.name === toolChoice);
  let toolCall;
  if (call) {
    try {
      toolCall = { name: call.function.name, input: JSON.parse(call.function.arguments) as Record<string, unknown> };
    } catch {
      toolCall = undefined; // malformed args → no tool; caller falls back
    }
  }
  return { text, toolCall };
}

const supportsTools = (): boolean => (process.env.LLM_SUPPORTS_TOOLS ?? "true") !== "false";

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
        return parseChoice((resp as { choices: [{ message: never }] }).choices[0].message, req.toolChoice);
      } catch (err) {
        throw toLLMError(err);
      }
    },
    async *stream(req) {
      const useTools = supportsTools() && !!req.tools?.length;
      let s;
      try {
        s = await client().chat.completions.create({
          model: req.model,
          max_tokens: req.maxTokens,
          stream: true,
          messages: messages(req),
          ...(useTools ? toolsParam(req) : {}),
        } as never);
      } catch (err) {
        throw toLLMError(err);
      }
      let text = "";
      const toolArgs: Record<string, { name: string; args: string }> = {};
      try {
        for await (const chunk of s as AsyncIterable<{ choices: [{ delta: { content?: string; tool_calls?: Array<{ index: number; function?: { name?: string; arguments?: string } }> } }] }>) {
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
      const chosen = Object.values(toolArgs).find((t) => !req.toolChoice || t.name === req.toolChoice);
      let toolCall;
      if (chosen) {
        try {
          toolCall = { name: chosen.name, input: JSON.parse(chosen.args) as Record<string, unknown> };
        } catch {
          toolCall = undefined;
        }
      }
      yield { type: "final", result: { text: text.trim(), toolCall } } satisfies LLMStreamEvent;
    },
  };
}
```

- [ ] **Step 5: Wire the factory branch**

In `src/lib/llm/index.ts`, import `createOpenAICompatibleProvider` and select it when `provider === "openai-compatible"`. Add an `index.test.ts` case: with `LLM_PROVIDER=openai-compatible` + `LLM_BASE_URL` set, `getLLM().id === "openai-compatible"`.

- [ ] **Step 6: Env wiring**

Remove `LLM_PROVIDER` from the `env-drift.ts` intentionally-unread allowlist (it is now read). In the env validator, add: provider `anthropic` requires `ANTHROPIC_API_KEY`; provider `openai-compatible` requires `LLM_BASE_URL` + `LLM_MODEL`. Document all `LLM_*` vars in `.env.example` (see spec §6 table). Add a test for the validator branch if the validator is unit-tested.

- [ ] **Step 7: Run tests + gates**

Run: `npx vitest run src/lib/llm src/lib/env-drift && npx tsc --noEmit && npx eslint src/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/llm/openai-compatible.ts src/lib/llm/openai-compatible.test.ts src/lib/llm/index.ts src/lib/llm/index.test.ts src/lib/env-drift.ts src/lib/auth/config.ts .env.example package.json package-lock.json
git commit -m "feat(#59): openai-compatible adapter + env wiring"
```

---

### Task 7: Tool-less structured-output fallback

**Files:**
- Create: `src/lib/llm/structured-output.ts`, `src/lib/llm/structured-output.test.ts`
- Modify: `src/lib/llm/openai-compatible.ts` (use the fallback when `!supportsTools`)
- Test: extend `openai-compatible.test.ts` + a breakdown-route test with a tool-less fake provider

**Interfaces:**
- Consumes: `LLMTool`, `LLMResult` (Task 1).
- Produces: `buildStructuredInstruction(tool: LLMTool): string`, `parseStructuredResult(text: string, tool: LLMTool): LLMToolCall | undefined` — consumed by the openai-compatible adapter.

- [ ] **Step 1: Write the failing parser tests**

```ts
// src/lib/llm/structured-output.test.ts
import { describe, it, expect } from "vitest";
import { buildStructuredInstruction, parseStructuredResult } from "./structured-output";

const tool = {
  name: "propose_steps",
  description: "d",
  inputSchema: {
    type: "object",
    properties: { parentEmoji: { type: "string" }, steps: { type: "array" } },
    required: ["parentEmoji", "steps"],
  },
};

describe("buildStructuredInstruction", () => {
  it("names the <result> sentinel and includes the schema", () => {
    const s = buildStructuredInstruction(tool);
    expect(s).toContain("<result>");
    expect(s).toContain("</result>");
    expect(s).toContain("propose_steps");
    expect(s).toContain('"parentEmoji"');
  });
});

describe("parseStructuredResult", () => {
  it("extracts and parses a valid <result> block matching required keys", () => {
    const text = 'Sure!\n<result>{"parentEmoji":"🗂️","steps":[]}</result>';
    expect(parseStructuredResult(text, tool)).toEqual({
      name: "propose_steps",
      input: { parentEmoji: "🗂️", steps: [] },
    });
  });
  it("returns undefined when the block is missing", () => {
    expect(parseStructuredResult("no json here", tool)).toBeUndefined();
  });
  it("returns undefined on malformed JSON", () => {
    expect(parseStructuredResult("<result>{not json}</result>", tool)).toBeUndefined();
  });
  it("returns undefined when a required key is absent (schema mismatch)", () => {
    expect(parseStructuredResult('<result>{"steps":[]}</result>', tool)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `npx vitest run src/lib/llm/structured-output.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the fallback helper**

```ts
// src/lib/llm/structured-output.ts
import type { LLMTool, LLMToolCall } from "./types";

/** Instruction appended to the system prompt when a model lacks native tools. */
export function buildStructuredInstruction(tool: LLMTool): string {
  return [
    "After your short conversational reply, output the result as a SINGLE JSON object",
    `for "${tool.name}", wrapped in <result>...</result> tags, matching this JSON Schema:`,
    JSON.stringify(tool.inputSchema),
    "Output nothing after the closing </result> tag. Do not use markdown code fences.",
  ].join("\n");
}

const BLOCK = /<result>([\s\S]*?)<\/result>/i;

/** Extract + validate the <result> block. Returns undefined on any failure. */
export function parseStructuredResult(text: string, tool: LLMTool): LLMToolCall | undefined {
  const m = text.match(BLOCK);
  if (!m) return undefined;
  let input: unknown;
  try {
    input = JSON.parse(m[1].trim());
  } catch {
    return undefined;
  }
  if (typeof input !== "object" || input === null) return undefined;
  const required = ((tool.inputSchema as { required?: string[] }).required ?? []) as string[];
  for (const key of required) {
    if (!(key in (input as Record<string, unknown>))) return undefined;
  }
  return { name: tool.name, input: input as Record<string, unknown> };
}
```

- [ ] **Step 4: Wire the fallback into the openai-compatible adapter**

When `supportsTools()` is false and `req.tools?.[0]` + `req.toolChoice` are set: append `buildStructuredInstruction(tool)` to `req.system` (or the last user message if no system), call the model **without** `tools`, stream text through unchanged, buffer the full text, and on the final event set `toolCall = parseStructuredResult(fullText, tool)`. Add an `openai-compatible.test.ts` case with `LLM_SUPPORTS_TOOLS=false` asserting: no `tools` sent to the API, the `<result>` block is parsed into `toolCall`, and a missing block yields `toolCall: undefined`.

- [ ] **Step 5: Breakdown route survives a tool-less provider**

Add a breakdown-route test using a fake provider with `supportsTools:false` whose stream yields text then a `final` with `toolCall:undefined`; assert the route sends a `fallback` event (via `localBreakdown`) so the user still gets steps. (No route code change needed — the route already treats "no tool" as fallback; this test locks the behavior in.)

- [ ] **Step 6: Run tests + gates**

Run: `npx vitest run src/lib/llm src/app/api/breakdown && npx tsc --noEmit && npx eslint src/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/llm/structured-output.ts src/lib/llm/structured-output.test.ts src/lib/llm/openai-compatible.ts src/lib/llm/openai-compatible.test.ts src/app/api/breakdown/*.test.ts
git commit -m "feat(#59): tool-less structured-output fallback for local models"
```

---

### Task 8: Generalize errors/observability + retry

**Files:**
- Modify: `src/lib/observability.ts`, `src/app/api/livez/route.ts`, all callers of `recordAnthropicFailure` (breakdown route), `src/lib/llm/anthropic.ts` + `src/lib/llm/openai-compatible.ts` (retry)
- Test: `src/lib/observability.test.ts`, `src/app/api/livez` test, a retry test

**Interfaces:**
- Consumes: `LLMError` (Task 1).
- Produces: `recordLLMFailure(provider, route, err)`, `llmFailureCount()`, `_resetLLMFailuresForTest()`; keep `recordAnthropicFailure`/`anthropicFailureCount` as deprecated aliases for one release.

- [ ] **Step 1: Write failing observability tests**

```ts
// src/lib/observability.test.ts (add)
import { describe, it, expect, beforeEach, vi } from "vitest";
import { recordLLMFailure, llmFailureCount, _resetLLMFailuresForTest, anthropicFailureCount } from "./observability";

beforeEach(() => _resetLLMFailuresForTest());

describe("recordLLMFailure", () => {
  it("increments the counter and logs a provider-tagged line", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    recordLLMFailure("openai-compatible", "breakdown", Object.assign(new Error("boom"), { status: 500 }));
    expect(llmFailureCount()).toBe(1);
    const logged = JSON.parse(spy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({ tag: "llm_failure", provider: "openai-compatible", route: "breakdown", status: 500 });
    spy.mockRestore();
  });
  it("anthropicFailureCount alias reflects the same counter", () => {
    recordLLMFailure("anthropic", "spark", new Error("x"));
    expect(anthropicFailureCount()).toBe(1);
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `npx vitest run src/lib/observability.test.ts`
Expected: FAIL — `recordLLMFailure` undefined.

- [ ] **Step 3: Implement the rename + alias**

Rewrite `observability.ts`: `recordLLMFailure(provider, route, err)` logs `tag:"llm_failure"` + `provider`; `llmFailureCount()`/`_resetLLMFailuresForTest()` are the canonical names; `recordAnthropicFailure(route, err)` = `recordLLMFailure("anthropic", route, err)` and `anthropicFailureCount = llmFailureCount` (deprecated `@deprecated` JSDoc). Update the breakdown route to call `recordLLMFailure(getLLM().id, "breakdown", err)`.

- [ ] **Step 4: Generalize the livez counter**

In `src/app/api/livez/route.ts`, surface `llmFailures: llmFailureCount()` and keep `anthropicFailures: llmFailureCount()` as a one-release alias. Update its test to assert both keys.

- [ ] **Step 5: Add bounded retry on retryable errors**

Add a tiny `withRetry` helper (2 retries, exponential backoff ~200ms/400ms) used inside both adapters' `generate`/`stream` entry for `LLMError.retryable === true`. Test: a `generate` that rejects twice with a 429 then resolves returns the value (fake timers); a non-retryable `auth` error throws immediately with no retry.

```ts
// inside each adapter (or a shared src/lib/llm/retry.ts)
export async function withRetry<T>(fn: () => Promise<T>, tries = 2): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const e = err as { retryable?: boolean };
      if (!e?.retryable || attempt >= tries) throw err;
      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      attempt++;
    }
  }
}
```

> Streaming retry only applies to the *initial* call that establishes the stream (a mid-stream failure can't be safely retried — partial text already sent). Wrap the stream-establishment call, not the iteration.

- [ ] **Step 6: Run full suite + gates**

Run: `npx vitest run && npx tsc --noEmit && npx eslint . && npx prettier --check .`
Expected: PASS (excluding the known `*.integration.test.ts` that need a live `DATABASE_URL` — run those only if a DB is available).

- [ ] **Step 7: Commit**

```bash
git add src/lib/observability.ts src/lib/observability.test.ts src/app/api/livez/route.ts src/app/api/livez/*.test.ts src/app/api/breakdown/route.ts src/lib/llm/
git commit -m "feat(#59): provider-agnostic failure telemetry + bounded retry"
```

---

## Self-Review

**Spec coverage:**
- §1 seam / `getLLM()` → Tasks 1, 2. ✓
- §2 adapters (anthropic extracted, openai-compatible new) → Tasks 2, 6. ✓
- §3 tool-less structured-output fallback → Task 7. ✓
- §4 provider-scoped model registry → Task 5. ✓
- §5 errors/observability/retry + guest invariant → Task 8 (+ scope-guard test asserted green in Tasks 3, 4). ✓
- §6 env surface → Task 6 (env wiring + `.env.example`). ✓
- Phasing A–E → Tasks 1-4 (A), 5 (B), 6 (C), 7 (D), 8 (E). ✓

**Type consistency:** `LLMResult` is `{ text, toolCall? }` everywhere; `breakdownParamsFor` returns `{ model, hints }` after Task 5 (Task 3 temporarily maps the old shape into `hints` and Task 5 simplifies it — called out inline); `recordLLMFailure(provider, route, err)` signature consistent across Task 8 and its call-site update.

**Deferred (spec non-goals, no task by design):** per-user keys (#35), provider-switch UI, third native adapter, streaming for the 3 non-streaming call-sites, capability auto-probing.
