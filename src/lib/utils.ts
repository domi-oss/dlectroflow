import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Minimum interactive hit area — 44×44 CSS px (Tailwind `11` = 2.75rem), the
 * WCAG 2.5.5 target size. Applied to icon-only and small pill controls so they
 * meet the touch-target minimum while keeping their visual padding; the flex
 * centering keeps the glyph/label centred inside the expanded box.
 */
export const touchTarget = "inline-flex items-center justify-center min-h-11 min-w-11"
