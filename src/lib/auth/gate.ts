export const PUBLIC_PREFIXES = ["/api/health", "/login", "/api/auth/"];

// Integration connect/callback routes touch the owner's global Google tokens —
// guests must never reach them.
export const OWNER_ONLY_PREFIXES = ["/api/google/oauth/"];

/**
 * Paths that require a real signed-in account. A guest session is NOT enough.
 *
 * Distinct from OWNER_ONLY_PREFIXES: any member may use these, guests may not.
 * Before #35 there were only two categories, so anything that was not
 * owner-only was reachable by a guest session. Phase C moves
 * `/api/google/oauth/` out of owner-only once Google is per-user; without this
 * category to move it INTO, that would open the OAuth callback to guests.
 *
 * Every prefix MUST end with "/" — the match is a plain `startsWith`, so
 * "/api/account" would also gate a future "/api/accountant".
 */
export const AUTHENTICATED_PREFIXES = ["/api/account/"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : p + "/"),
  );
}

export function isOwnerOnlyPath(pathname: string): boolean {
  return OWNER_ONLY_PREFIXES.some((p) => pathname.startsWith(p));
}

export function isAuthenticatedOnlyPath(pathname: string): boolean {
  return AUTHENTICATED_PREFIXES.some((p) => pathname.startsWith(p));
}
