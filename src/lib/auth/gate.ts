/**
 * Paths served to anyone, with no session of any kind.
 *
 * `/privacy` and `/terms` (#123) are here because they are LEGALLY REQUIRED to
 * be publicly reachable, not merely convenient: UK GDPR Art. 12(1) wants the
 * notice accessible, and Google's OAuth verification reviewers fetch both URLs
 * cold — no cookies, no sign-in. Everything not matched here is redirected to
 * /login by src/proxy.ts, so omitting them shows the reviewer a sign-in wall and
 * fails consent-screen verification while the app itself looks perfectly fine.
 * Asserted by src/lib/auth/gate.test.ts AND src/proxy.test.ts (the classifier
 * and the middleware that has to honour it).
 *
 * Matching is exact-or-`prefix + "/"` (see isPublicPath), so a prefix without a
 * trailing "/" is still safe against lookalikes like "/privacyhack" — unlike
 * OWNER_ONLY_PREFIXES / AUTHENTICATED_PREFIXES below, which use a plain
 * startsWith and therefore MUST end in "/".
 */
export const PUBLIC_PREFIXES = [
  "/api/health",
  "/login",
  "/api/auth/",
  "/privacy",
  "/terms",
];

/**
 * Paths only the instance owner may reach. **Deliberately empty since #118.**
 *
 * Kept as a named category rather than deleted, for two reasons. At the
 * middleware layer this means exactly what AUTHENTICATED_PREFIXES means — the
 * Edge runtime has no Prisma client, so "role = owner" can only be checked at
 * the handler (see src/proxy.ts) — and #119 is what happens when that handler
 * half is assumed rather than written. And Phase D's revoke/purge routes are the
 * next likely occupant. Its middleware branch is retained on the same grounds.
 */
export const OWNER_ONLY_PREFIXES: readonly string[] = [];

/**
 * Paths that require a real signed-in account. A guest session is NOT enough.
 *
 * Distinct from OWNER_ONLY_PREFIXES: any member may use these, guests may not.
 * Before #35 there were only two categories, so anything that was not
 * owner-only was reachable by a guest session — which is why moving
 * `/api/google/oauth/` out of owner-only needed this category to move INTO
 * rather than simply dropping the gate.
 *
 * Every prefix MUST end with "/" — the match is a plain `startsWith`, so
 * "/api/account" would also gate a future "/api/accountant".
 *
 * #118 Phase C moved `/api/google/oauth/` in here, which is the move this
 * category was created for: `GoogleAuth` is keyed on `userId` now, so a member
 * connecting their OWN account is the intended behaviour. The handler still
 * checks `currentUser()` itself — the middleware proves "signed in", never "who".
 */
export const AUTHENTICATED_PREFIXES = ["/api/account/", "/api/google/oauth/"];

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
