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
 * `/api/ics/feed` (#154) is here for a structural reason rather than a legal
 * one, and it is the narrowest entry in the list on purpose. A calendar client
 * fetching a subscription — Google, Apple, Outlook — sends no cookie and cannot
 * sign in, so the 256-bit capability token in the path IS the authorization; see
 * `src/lib/calendar-feed.ts`. Redirecting it to /login would not look like an
 * auth failure to anybody, it would look like a feed that quietly stopped
 * updating. **`/api/ics` itself stays private**: the per-task download at
 * `/api/ics/[taskId]` is session-scoped and keyed on an id that is guessable in
 * a way a token is not.
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
  "/api/ics/feed",
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

/**
 * Paths that only work on the ONE origin PUBLIC_ORIGIN names, and are therefore
 * redirected there from any other hostname (#174).
 *
 * A fourth, orthogonal category: this is about *where* a path is served, not
 * who may reach it. Everything here either sets or reads a cookie written with
 * no `Domain` attribute — the PKCE verifier, the OAuth state, the session — and
 * such a cookie is **host-only**. The app answers on more than one hostname,
 * but the provider always returns the browser to PUBLIC_ORIGIN, because that is
 * what the redirect URI is built from (src/lib/origin.ts `requestOrigin`). So a
 * sign-in begun anywhere else set its cookies on a host the callback never
 * reached, failed `missing_oauth_params`, and looped forever with no way out.
 *
 * **Deliberately not the whole app.** `/`, `/privacy` and `/terms` must keep
 * answering 200 on every hostname the ingress serves — see the reasoning in
 * `.gitlab-ci.yml`'s `deploy_production` — so this is the narrow set that has
 * to move, not a blanket canonical-host redirect. It is also why the two
 * Kubernetes probe paths need no exemption: they are outside these prefixes, so
 * a probe addressing the pod by IP is never redirected. A 3xx counts as a pass
 * to the kubelet, which would make readiness green without /api/health ever
 * running its `SELECT 1`.
 *
 * `/login` is in the list so the whole visible journey — the button, the
 * provider hop, the callback and any error page — happens on one origin, rather
 * than starting on one hostname and silently finishing on another.
 *
 * Matching is exact-or-`prefix + "/"`, as PUBLIC_PREFIXES above, so `/login`
 * here does not also catch `/loginhack`.
 */
export const CANONICAL_ORIGIN_PREFIXES = [
  "/api/auth/",
  "/api/google/oauth/",
  "/login",
];

/**
 * Exact match, or a prefix that ends on a path segment boundary.
 *
 * The trailing-slash normalisation is the whole point and is easy to lose: a
 * plain `startsWith("/login")` also catches `/loginhack`, which would hand an
 * attacker-chosen path the treatment `/login` gets. Shared between the two
 * classifiers that need it rather than written twice — they had drifted apart
 * once already in review (!280), and two copies of a security predicate is one
 * copy too many.
 */
function matchesExactOrSegmentPrefix(
  pathname: string,
  prefixes: readonly string[],
): boolean {
  return prefixes.some(
    (p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : p + "/"),
  );
}

export function isPublicPath(pathname: string): boolean {
  return matchesExactOrSegmentPrefix(pathname, PUBLIC_PREFIXES);
}

export function isOwnerOnlyPath(pathname: string): boolean {
  return OWNER_ONLY_PREFIXES.some((p) => pathname.startsWith(p));
}

export function isAuthenticatedOnlyPath(pathname: string): boolean {
  return AUTHENTICATED_PREFIXES.some((p) => pathname.startsWith(p));
}

export function isCanonicalOriginPath(pathname: string): boolean {
  return matchesExactOrSegmentPrefix(pathname, CANONICAL_ORIGIN_PREFIXES);
}
