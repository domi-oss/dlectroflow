/**
 * The dlectroflow app-icon brand mark (#13 / #40 Phase 3) — the shipped app
 * icon (`public/brand-mark.png`: the swoosh + lightning on the purple→magenta
 * brand gradient), rendered at whatever size the caller's `className` sets.
 *
 * Purely decorative: `alt=""` + `aria-hidden`, so the accessible name always
 * comes from the adjacent "dlectroflow" text, never the glyph. Server-safe
 * (plain <img>, no hooks / no "use client"), so it renders directly in the
 * Server-Component app header as well as in client components (welcome / guest
 * first-run moments).
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- tiny static, decorative brand icon; next/image adds no value at this size and would pull a client wrapper into the RSC header.
    <img
      src="/brand-mark.png"
      alt=""
      aria-hidden="true"
      width={32}
      height={32}
      draggable={false}
      className={className}
    />
  );
}
