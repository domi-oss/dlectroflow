import Link from "next/link";
import { cn } from "@/lib/utils";
import { t, type Voice } from "@/lib/strings";
import { resolveBackTarget } from "@/lib/nav/back";

/**
 * Where this copy of the control is being rendered. The DESTINATION, the
 * whitelist and the label are identical in both — only the presentation
 * differs, which is exactly why #131 added a variant here instead of a second
 * component with its own back recipe.
 *
 *  - `page` — the full-width control at the top of a page (the original, and
 *    still the default).
 *  - `bar` — the compact copy folded into the sticky `<SectionNav>` bar on the
 *    two long pages, so the way OUT is still on screen once the page-level one
 *    has scrolled away.
 */
export type BackLinkVariant = "page" | "bar";

const VARIANT_CLASS: Record<BackLinkVariant, string> = {
  page: "inline-block",
  // #131 — inside the sticky bar every control is a tap target on a phone, so
  // this one clears the same 44px minimum (`min-h-11`) as the "Jump to…" toggle
  // beside it. The -ml-2/px-2 pair pulls the padded hit area back out to the
  // page's text margin, so the target costs no visible indent and no extra bar
  // height — the same trick the toggle carried while it was the bar's first
  // control. `shrink-0` keeps the exit at full width when the bar is tight; the
  // current-section label beside it is the part that truncates.
  bar: "-ml-2 inline-flex min-h-11 shrink-0 items-center px-2 focus-visible:ring-offset-background focus-visible:ring-offset-2",
};

/**
 * The one canonical, origin-aware "back" link. It reads the page's `?from=`
 * origin (resolved against the whitelist in @/lib/nav/back) to pick the
 * DESTINATION, then renders a single, destination-agnostic label — "← Back"
 * (from `action.back`) — with one shared className. So the link returns the
 * user to where they came from, but always simply reads "← Back".
 * Absent/unknown/hostile origins fall back to the inbox (no open redirect).
 *
 * This replaces the old per-page recipes (hardcoded lowercase "← inbox" that
 * bypassed the voice system, "Back to inbox" with no arrow, a generic "← Back",
 * and the task page's own inline origin-aware link) with a single component.
 *
 * Deliberately NOT a `"use client"` module: it has no state, effects, or
 * browser APIs, so it renders directly in Server Components (dashboard,
 * settings, library, help, tasks) and, when imported into a Client Component
 * (breakdown-chat, section-nav), is simply bundled alongside it — see
 * node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md.
 *
 * Scope note: forward CTAs ("Plan tomorrow →", "see it on your Inbox →"), the
 * header brand link, and the focus flow's own "← Back" control are intentionally
 * out of scope — this is for page-level back navigation only.
 */
export function BackLink({
  from,
  voice,
  variant = "page",
}: {
  /** The raw `?from=` origin for this page (resolved against the whitelist). */
  from?: string;
  voice: Voice;
  /** Presentation only — see {@link BackLinkVariant}. */
  variant?: BackLinkVariant;
}) {
  const target = resolveBackTarget(from);
  return (
    <Link
      href={target.href}
      // #131 — /settings and /help render BOTH copies (the page-level one stays
      // put; the sticky one is for after it has scrolled away), so two links
      // with an identical accessible name share the page. This names which is
      // which for tests and for e2e; nothing styles or reads it at runtime.
      data-back-link={variant}
      className={cn(
        "text-muted-foreground hover:text-primary focus-visible:text-primary focus-visible:ring-ring rounded text-sm outline-none hover:underline focus-visible:ring-2",
        VARIANT_CLASS[variant],
      )}
    >
      {/* `action.back` already carries the leading ← ("← Back"). */}
      {t("action.back", voice)}
    </Link>
  );
}
