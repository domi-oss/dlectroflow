/**
 * #109 — the one place that decides the colour of a tinted status banner.
 *
 * Six banners across three files had independently copied the same shape: a
 * `border-<family>-<n>/30` edge, a `bg-<family>-<n>/10` tint, and a `-700` text
 * colour. Five of them then failed AA, and the sixth
 * (`components/breakdown/schedule-status-banner.tsx`) carried a comment
 * asserting they passed:
 *
 *     // -700 is AA on the light tint, but fails AA on the dark tint
 *
 * That is measurably wrong in the light half, and it is wrong for a reason worth
 * writing down, because it is the trap the whole class of bug sits in:
 *
 * **A translucent tint moves the background toward the text.** `text-green-700`
 * is 4.65:1 on the bare light `--background` (#fdf6fa) and passes. Composite the
 * banner's own `bg-green-600/10` over that background and the effective
 * background becomes #f2f7f1 — greener and, crucially, *closer in luminance to
 * the green text*. The same token now measures **4.16:1** and fails. Nobody
 * measured the composite, everybody measured the token, and the numbers in the
 * comment above came from the token.
 *
 * So the tinted banners need one shade darker than the same semantic gets on a
 * plain background. Measured against the light `--background` composited with
 * each tone's own tint, and the dark `--background` likewise:
 *
 *   tone     light                      dark
 *   ok       green-800  5.98:1  ✓       green-400  10.09:1  ✓
 *   warn     amber-800  6.24:1  ✓       amber-400  10.04:1  ✓
 *   error    red-700    5.07:1  ✓       red-400     6.50:1  ✓
 *
 * (`green-700` 4.16:1 ✗ and `amber-700` 4.42:1 ✗ are what these replace.
 * `red-700` already cleared 4.5:1 on its tint and is kept, because it is also
 * the established error text elsewhere — `status-pill.tsx`'s `wayOverdue`,
 * `people-panel.tsx`, `delete-account.tsx` — and inventing a second error red
 * would be worse than the 1.5-point margin is worth. Every text value is AA at
 * the 4.5:1 NORMAL-text threshold, not the 3:1 large-text one, because the
 * smallest of these banners is 12px and none is large scale.)
 *
 * `-800` on an amber tint is not a new shade either: `inbox-view.tsx`'s stale
 * nudge and `guest-indicator.tsx`'s guest banner already pair `text-amber-800`
 * with an amber tint. This makes that the rule rather than the coincidence.
 *
 * ── Do not re-hardcode a banner tone in a component ─────────────────────────
 * Same contract `completion-style.ts` carries. `a11y-class-hygiene.ts` enforces
 * the *token* discipline (no bare `-600`, always a `dark:` partner) but it
 * cannot see the composite ratio — so a component that spells its own tone out
 * again can pass the unit gate and still fail AA. Adding a tone means measuring
 * it and putting the number in the table above.
 */

/**
 * Text/border/background classes for a tinted status banner, by semantic tone.
 * The caller supplies the geometry (`rounded-lg border p-3 text-sm`); this
 * supplies only what carries the meaning and the contrast.
 */
export const STATUS_BANNER_TONE = {
  /** Something succeeded. */
  ok: "border-green-600/30 bg-green-600/10 text-green-800 dark:text-green-400",
  /** Something needs attention but nothing is broken — "attention, not alarm". */
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-400",
  /** Something failed. */
  error: "border-red-600/30 bg-red-600/10 text-red-700 dark:text-red-400",
} as const;

export type StatusBannerTone = keyof typeof STATUS_BANNER_TONE;
