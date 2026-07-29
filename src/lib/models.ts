import type { LLMRequest } from "@/lib/llm/types";
import { BREAKDOWN_MODEL } from "@/lib/anthropic";
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

/**
 * Which model tier serves this request.
 *
 * #96 — this was `{ isOwner: boolean }`. Before accounts that was a true binary:
 * you were the owner or you were a guest, so "not the owner" meaning "cheapest
 * tier" was correct. An invited member is a third thing, and it landed in the
 * guest branch — so every member got Haiku, the tier chosen as a GUEST COST
 * LEVER, including a member paying for their own API calls. A named tier is what
 * stops the next role inheriting the same default silently, and replacing the
 * boolean (rather than adding to it) is what makes tsc enumerate the call sites.
 */
export type ModelTier = "owner" | "member" | "guest";

type BreakdownModelOpts = {
  tier: ModelTier;
  ownerSetting?: string | null;
  /** Does this account pay for its own API calls? See `hasOwnKey` below. */
  hasOwnKey?: boolean;
};

function resolveAnthropicModel(opts: BreakdownModelOpts): string {
  // A guest is the only tier the cost lever applies to. `hasOwnKey` cannot be
  // true here — a guest has no account to hold a key on — but the ordering makes
  // that explicit rather than incidental.
  if (opts.tier === "guest") {
    return process.env.GUEST_BREAKDOWN_MODEL || GUEST_BREAKDOWN_MODEL_DEFAULT;
  }
  // A member paying with their own key gets the owner-grade default rather than
  // whatever the owner set for instance-funded work — it is not the owner's
  // spend to economise on. Their own explicit preference, if the settings UI
  // ever grows one, would slot in here.
  if (opts.tier === "member" && opts.hasOwnKey) {
    return OWNER_BREAKDOWN_MODEL_DEFAULT;
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

function resolveOpenAICompatibleModel(opts: { tier: ModelTier }): string {
  // #96 — only a guest gets the guest split. A member is not a guest.
  const split =
    opts.tier === "guest"
      ? process.env.LLM_GUEST_MODEL
      : process.env.LLM_OWNER_MODEL;
  const model = split || process.env.LLM_MODEL;
  if (!model) {
    // Env validation (assertLLMConfig) catches this at boot; this guard stops
    // the resolver from silently returning "" if it's ever reached without a
    // configured model (e.g. a code path that bypasses the boot check).
    throw new Error(
      "LLM_PROVIDER=openai-compatible requires LLM_MODEL (or LLM_OWNER_MODEL / LLM_GUEST_MODEL) to be set.",
    );
  }
  return model;
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Pick the breakdown model by TIER for the active `LLM_PROVIDER`. Guests get the
 * cheapest tier available: Haiku on `anthropic` (cost lever), or
 * `LLM_GUEST_MODEL`/`LLM_MODEL` on `openai-compatible`. A member on the
 * instance's key follows the owner's configured tier — that is the owner's cost
 * decision, and they already have a control for it — while a member paying with
 * their own key gets the owner-grade default (#96).
 */
export function resolveBreakdownModel(opts: BreakdownModelOpts): string {
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
 * Model for the owner-only utility calls (spark quote, day-rollup narrative,
 * focus "kinder re-estimate" — guests never reach any of these). Unlike
 * breakdown, there's no owner-configurable tier here: `anthropic` always uses
 * `BREAKDOWN_MODEL` (Opus), matching pre-#59 behavior byte-for-byte; on
 * `openai-compatible`, reuse the same owner-model resolution breakdown uses.
 */
export function resolveUtilityModel(): string {
  if (activeProvider() === "openai-compatible") {
    return resolveOpenAICompatibleModel({ tier: "owner" });
  }
  return BREAKDOWN_MODEL;
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
