/**
 * Where the OAuth provider sends the browser back to.
 *
 * ── Why this is a module and not two template literals ──────────────────────
 *
 * It used to be two: `src/app/api/auth/gitlab/start/route.ts` built
 * `` `${origin}/api/auth/gitlab/callback` `` for the authorize URL, and
 * `src/app/api/auth/gitlab/callback/route.ts` built the identical string again
 * for the token exchange, where the provider requires it to match byte for byte.
 * Two spellings of one fact, in two files, with the failure mode of a silent
 * `redirect_uri_mismatch` at the provider if they ever drift.
 *
 * #277 added a third reader and is what forced the extraction. The web app
 * manifest's `scope` must COVER this path: if it does not, the provider's
 * redirect opens outside the installed app's window, the user signs in **in a
 * browser tab**, and the installed app still reads signed-out. Nothing surfaces
 * that until somebody signs out, so `src/app/manifest.test.ts` asserts
 * containment — and a test cannot assert containment of a string that only
 * exists inside two function bodies.
 *
 * ⚠️ **Do not substitute `PUBLIC_PREFIXES`/`CANONICAL_ORIGIN_PREFIXES` from
 * `src/lib/auth/gate.ts` for this.** Both carry `/api/auth/`, which makes that
 * file look like the source of truth, but a prefix is not the callback path: if
 * the route directory moved, `/api/auth/` would not change and a test reading it
 * would keep passing. `src/lib/auth/oauth-callback.test.ts` closes the remaining
 * gap by checking this string against the directory it names, so a moved route
 * reds here rather than at the provider.
 *
 * ── Relative to the origin, deliberately ────────────────────────────────────
 *
 * A path, not a URL. The origin is `requestOrigin()`'s decision (see
 * `src/lib/origin.ts`), which pins `PUBLIC_ORIGIN` in production and falls back
 * to forwarded headers in local dev — the callers concatenate. Baking an origin
 * in here would give this module an opinion it has no way to be right about,
 * and #174 was exactly what happens when two parts of the sign-in flow disagree
 * about the hostname.
 */
export const GITLAB_OAUTH_CALLBACK_PATH = "/api/auth/gitlab/callback";
