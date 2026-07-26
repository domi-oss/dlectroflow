import type { LLMRequest } from "@/lib/llm/types";
import {
  OWNER_BREAKDOWN_ALLOWLIST,
  OWNER_BREAKDOWN_MODEL_DEFAULT,
  GUEST_BREAKDOWN_MODEL_DEFAULT,
} from "@/lib/constants";

/** Provider-agnostic model tuning hints — the canonical shape lives on
 * `LLMRequest` (`@/lib/llm/types`); adapters no-op whatever they don't use. */
type ModelHints = NonNullable<LLMRequest["hints"]>;

function activeProvider(): string {
  return process.env.LLM_PROVIDER || "anthropic";
}

function isAllowlisted(m: string | null | undefined): boolean {
  return !!m && (OWNER_BREAKDOWN_ALLOWLIST as readonly string[]).includes(m);
}

// ── anthropic provider ───────────────────────────────────────────────────────

/** Display labels for the anthropic tiers, rendered by the settings picker. */
const ANTHROPIC_MODEL_LABELS: Record<
  (typeof OWNER_BREAKDOWN_ALLOWLIST)[number],
  string
> = {
  "claude-haiku-4-5": "Haiku 4.5 — fastest, cheapest",
  "claude-sonnet-4-6": "Sonnet 4.6 — balanced (default)",
  "claude-opus-4-8": "Opus 4.8 — deepest reasoning, slower",
};

function resolveAnthropicModel(opts: {
  isOwner: boolean;
  ownerSetting?: string | null;
}): string {
  if (!opts.isOwner) {
    return process.env.GUEST_BREAKDOWN_MODEL || GUEST_BREAKDOWN_MODEL_DEFAULT;
  }
  if (isAllowlisted(opts.ownerSetting)) return opts.ownerSetting as string;
  const envDefault = process.env.OWNER_BREAKDOWN_MODEL;
  if (isAllowlisted(envDefault)) return envDefault as string;
  return OWNER_BREAKDOWN_MODEL_DEFAULT;
}

/**
 * Anthropic-only tuning hints. Haiku 4.5 rejects `output_config.effort` and is
 * not an adaptive-thinking tier; Sonnet/Opus take adaptive thinking + low
 * effort (low keeps the interactive breakdown snappy).
 */
function anthropicHintsFor(model: string): ModelHints {
  if (model === "claude-haiku-4-5") return {};
  return { thinking: true, effort: "low" };
}

// ── openai-compatible provider ──────────────────────────────────────────────
// A single self-hoster-configured model (LLM_MODEL), with an optional
// owner/guest split (LLM_OWNER_MODEL / LLM_GUEST_MODEL). No fixed allowlist —
// "valid" just means "what the deploy is configured with" — and no hint
// tuning: hints are Anthropic-specific knobs that no-op on other providers.

function resolveOpenAICompatibleModel(opts: { isOwner: boolean }): string {
  const split = opts.isOwner
    ? process.env.LLM_OWNER_MODEL
    : process.env.LLM_GUEST_MODEL;
  return split || process.env.LLM_MODEL || "";
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Pick the breakdown model by role for the active `LLM_PROVIDER`. Guests get
 * the cheapest tier available: Haiku on `anthropic` (cost lever), or
 * `LLM_GUEST_MODEL`/`LLM_MODEL` on `openai-compatible`.
 */
export function resolveBreakdownModel(opts: {
  isOwner: boolean;
  ownerSetting?: string | null;
}): string {
  if (activeProvider() === "openai-compatible") {
    return resolveOpenAICompatibleModel(opts);
  }
  return resolveAnthropicModel(opts);
}

/**
 * Per-model request params: the resolved model id plus provider-appropriate
 * tuning hints. `hints` is always present (possibly empty) so callers can
 * spread it straight into an `LLMRequest`.
 */
export function breakdownParamsFor(model: string): {
  model: string;
  hints: ModelHints;
} {
  if (activeProvider() === "openai-compatible") {
    return { model, hints: {} };
  }
  return { model, hints: anthropicHintsFor(model) };
}

/**
 * User-facing model choices for the settings picker, or `null` when the
 * active provider has nothing to choose from (e.g. a single-model
 * openai-compatible deploy) — the settings panel falls back to a read-only
 * "Using model: `<LLM_MODEL>`" line in that case.
 */
export function modelChoicesForProvider():
  { id: string; label: string }[] | null {
  if (activeProvider() === "openai-compatible") return null;
  return OWNER_BREAKDOWN_ALLOWLIST.map((id) => ({
    id,
    label: ANTHROPIC_MODEL_LABELS[id],
  }));
}
