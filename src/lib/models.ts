import {
  OWNER_BREAKDOWN_ALLOWLIST,
  OWNER_BREAKDOWN_MODEL_DEFAULT,
  GUEST_BREAKDOWN_MODEL_DEFAULT,
} from "@/lib/constants";

function isAllowlisted(m: string | null | undefined): boolean {
  return !!m && (OWNER_BREAKDOWN_ALLOWLIST as readonly string[]).includes(m);
}

/** Pick the breakdown model by role. Guests are fixed to Haiku (cost lever). */
export function resolveBreakdownModel(opts: {
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
 * Per-model request params. Haiku 4.5 rejects `output_config.effort` and is not
 * an adaptive-thinking tier; Sonnet/Opus take adaptive thinking + low effort
 * (low keeps the interactive breakdown snappy).
 */
export function breakdownParamsFor(model: string): {
  model: string;
  thinking?: { type: "adaptive" };
  output_config?: { effort: "low" };
} {
  if (model === "claude-haiku-4-5") return { model };
  return {
    model,
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
  };
}
