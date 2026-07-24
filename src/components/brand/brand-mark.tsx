/**
 * The dlectroflow app-icon mark (#13 / #40 Phase 3) — a compact brand glyph:
 * a lightning bolt (momentum/flow) knocked out of the purple→magenta brand tile.
 * Rendered inline from the brand gradient primitive (same stops as
 * `--gradient-brand` in globals.css) so it needs no raster asset and stays on
 * palette (no cyan — the near-black hexagon `domi-oss-group-logo.png` is the
 * GitLab *group* logo, not the app icon; see the design spec §2).
 *
 * Server-safe (no hooks / no "use client"), so it renders directly in the
 * Server-Component app header as well as in client components (welcome/guest
 * first-run moments). Purely decorative: `aria-hidden`, so the accessible name
 * always comes from the adjacent "dlectroflow" text, never the glyph.
 *
 * a11y: as a decorative logo it is exempt from non-text contrast, but the white
 * bolt on the brand tile still clears 3:1 in both themes regardless.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <defs>
        <linearGradient
          id="df-brand-mark-gradient"
          x1="0"
          y1="0"
          x2="1"
          y2="1"
        >
          <stop offset="0%" stopColor="#9b5cf0" />
          <stop offset="100%" stopColor="#e0479e" />
        </linearGradient>
      </defs>
      <rect
        x="1"
        y="1"
        width="30"
        height="30"
        rx="8"
        fill="url(#df-brand-mark-gradient)"
      />
      {/* Lightning bolt = momentum / flow. */}
      <path
        d="M18.5 5.5 L9 17.5 h5.2 l-1.7 9 9.5-12.8 h-5.2 z"
        fill="#ffffff"
      />
    </svg>
  );
}
