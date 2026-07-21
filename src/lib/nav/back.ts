/**
 * Origin-aware "back" navigation — the single source of truth for WHERE a
 * page's back button points.
 *
 * Generalized from the task page's #8-era back link, which carried this map
 * inline (`BACK_TARGETS` on tasks/[taskId]/page.tsx). A page reads the
 * `?from=` query param and resolves it HERE against a **closed whitelist**
 * keyed by a route identifier, so the user returns to wherever they came from.
 * The visible label is deliberately a single, destination-agnostic "← Back"
 * (rendered by <BackLink> from `action.back`) — only the destination varies.
 *
 * Security: this is deliberately a whitelist — `from` is NEVER reflected into a
 * path — so a hostile `?from=` (e.g. `https://evil.example`) can never become
 * an open redirect. `Object.hasOwn` (not truthiness) is used so inherited
 * Object.prototype keys like `__proto__` / `constructor` / `toString` resolve
 * to the safe default instead of a truthy-but-shapeless prototype member.
 *
 * Anything absent/unknown/hostile falls back to the inbox — the app's home.
 */
export type BackTarget = { href: string };

export const BACK_TARGETS = {
  // The Library's Multi-step ("sorted") tab deep-links into a task with
  // `?from=library` (library-multistep.tsx) — the only historical producer;
  // now any page can carry an origin through the shared helpers below.
  library: { href: "/library?tab=sorted" },
  settings: { href: "/settings" },
  help: { href: "/help" },
} as const satisfies Record<string, BackTarget>;

export const DEFAULT_BACK_TARGET: BackTarget = {
  href: "/inbox",
};

/** A known `?from=` origin key. */
export type BackFrom = keyof typeof BACK_TARGETS;

/**
 * Resolve a raw `?from=` value to its whitelisted target, falling back to the
 * inbox for absent/unknown/hostile values (see the security note above).
 */
export function resolveBackTarget(from: string | null | undefined): BackTarget {
  return from && Object.hasOwn(BACK_TARGETS, from)
    ? BACK_TARGETS[from as BackFrom]
    : DEFAULT_BACK_TARGET;
}

/**
 * Append `?from=<origin>` to a link that navigates INTO a back-button page, so
 * that page's back button has an origin to read. The whitelist is applied on
 * this producing side too: only known origins are propagated (unknown values
 * are dropped rather than reflected), and the value is URL-encoded.
 */
export function withFrom(
  href: string,
  from: string | null | undefined,
): string {
  if (!from || !Object.hasOwn(BACK_TARGETS, from)) return href;
  const sep = href.includes("?") ? "&" : "?";
  return `${href}${sep}from=${encodeURIComponent(from)}`;
}
