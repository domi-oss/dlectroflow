import Link from "next/link";
import { t, type Voice } from "@/lib/strings";
import { resolveBackTarget } from "@/lib/nav/back";

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
 * (breakdown-chat), is simply bundled alongside it — see
 * node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md.
 *
 * Scope note: forward CTAs ("Plan tomorrow →", "see it on your Inbox →"), the
 * header brand link, and the focus flow's own "← Back" control are intentionally
 * out of scope — this is for page-level back navigation only.
 */
export function BackLink({
  from,
  voice,
}: {
  /** The raw `?from=` origin for this page (resolved against the whitelist). */
  from?: string;
  voice: Voice;
}) {
  const target = resolveBackTarget(from);
  return (
    <Link
      href={target.href}
      className="text-muted-foreground inline-block rounded text-sm outline-none hover:text-primary hover:underline focus-visible:text-primary focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* `action.back` already carries the leading ← ("← Back"). */}
      {t("action.back", voice)}
    </Link>
  );
}
