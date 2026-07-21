import { FocusTimerStyle } from "@/lib/constants";
import type { Voice } from "@/lib/strings";

/**
 * Resolve the timer visual style. A stored, allowlisted value wins; otherwise
 * (null/unset or an unknown value) fall back to the voice default — mug for the
 * playful voice, ring for plain. Pure: no React/DB. See the spec, Design B.
 */
export function resolveTimerStyle(
  setting: string | null | undefined,
  voice: Voice,
): FocusTimerStyle {
  const allowed = Object.values(FocusTimerStyle) as string[];
  if (setting && allowed.includes(setting)) return setting as FocusTimerStyle;
  return voice === "playful" ? FocusTimerStyle.Mug : FocusTimerStyle.Ring;
}
