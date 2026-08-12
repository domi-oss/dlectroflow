import { isCanonicalOriginPath } from "./auth/gate";
import { recordAuthFailure } from "./observability";

/**
 * Latch so a malformed PUBLIC_ORIGIN is reported ONCE per process rather than
 * once per auth-flow request — `canonicalOriginRedirect` runs on every one of
 * them, and a bad deploy value would otherwise bury the logs it is trying to
 * reach.
 */
let warnedMalformedOrigin = false;

/** @internal Test hook — resets the once-per-process latch above. */
export function _resetOriginWarningForTest(): void {
  warnedMalformedOrigin = false;
}

/**
 * The hostname the browser actually used, as best the pod can tell.
 *
 * **`x-forwarded-host` first, deliberately.** TLS terminates at ingress-nginx,
 * so the raw `Host` the pod sees is not reliably the hostname the user typed —
 * and in a multi-hostname deployment that difference is not a detail, it is
 * #174 itself. `.split(",")[0]` because each proxy in a chain appends to the
 * header; the first entry is the client-facing one.
 *
 * Both headers are attacker-controllable and that is fine for every current
 * caller, because none of them ECHO the value: `canonicalOriginRedirect`
 * compares it and builds the destination from PUBLIC_ORIGIN, `recordAuthFailure`
 * writes it to a log line, and `hasDisallowedOrigin` below compares it against
 * the `Origin` header. Do not use this to construct a URL that is served back to
 * the user.
 *
 * Extracted because there were three copies of this precedence and one of them
 * had drifted — the #174 diagnostic field read bare `Host`, so the single field
 * added to identify a wrong-hostname sign-in would itself have reported the
 * wrong hostname, in exactly the topology that produced the bug.
 */
export function inboundHost(headers: Headers): string | null {
  return (
    headers.get("x-forwarded-host")?.split(",")[0].trim() ||
    headers.get("host") ||
    null
  );
}

/**
 * The origin the request ARRIVED on — scheme + host as the browser used them,
 * normalised the way a browser computes the `Origin` it sends.
 *
 * Deliberately **not exported**, and that is the whole of `inboundHost`'s warning
 * applied one level up: this is a value derived from attacker-controllable
 * headers, so it is safe to COMPARE and unsafe to serve back. Keeping it private
 * means the only thing that can be done with it is the comparison below, and a
 * future caller wanting to build a URL is pushed to `publicOrigin()`, which is the
 * right source for that.
 *
 * `new URL(...).origin` rather than string concatenation, because it applies
 * exactly the normalisation the browser already applied to the header this is
 * compared against: the host is lowercased and a DEFAULT port is dropped
 * (`https://h:443` → `https://h`). Neither deploy target emits a port here —
 * ingress-nginx passes the raw `Host` and Caddy's `{host}` placeholder excludes it
 * — so this is not fixing an observed bug; it is refusing to make the comparison
 * depend on a proxy detail, because the failure mode if one ever did add `:443`
 * would be every capture refused rather than anything visible.
 *
 * The scheme is restricted to http/https instead of being trusted verbatim. Both
 * proxies overwrite `x-forwarded-proto` (ingress-nginx `X-Forwarded-Proto
 * $pass_access_scheme`, Caddy `header_up X-Forwarded-Proto {scheme}`), so a
 * spoofed one does not reach the pod — but an unrestricted scheme makes
 * `new URL()` return the literal string `"null"` for a non-special scheme, and
 * `"null"` is also what a browser sends as `Origin` for an OPAQUE origin. Two
 * different things must not be able to collide on one sentinel in a security
 * comparison, whatever currently prevents the collision.
 *
 * `null` when the arrival origin cannot be determined, which callers must treat as
 * "cannot verify" and refuse — never as "no constraint".
 */
function arrivalOrigin(req: Request): string | null {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return null;
  }

  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0];
  const proto = (forwardedProto ?? url.protocol.replace(":", ""))
    .trim()
    .toLowerCase();
  if (proto !== "http" && proto !== "https") return null;

  // `url.host` as the last resort, matching `requestOrigin`'s chain below: in a
  // Route Handler it is reconstructed from this same Host header, so it is the
  // same value and not a weaker source. It is what answers in the tests and under
  // `npm run dev`, where no proxy has forwarded anything.
  const host = inboundHost(req.headers) ?? url.host;
  if (!host) return null;

  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}

/**
 * Whether a state-changing request's `Origin` header must be refused — the CSRF
 * comparison (CWE-352), in ONE place.
 *
 * Three rules, the house pattern `src/app/api/auth/logout/route.ts` records:
 * reject an `Origin` that is PRESENT and does not match, allow a MISSING one for
 * non-browser clients (POST-only plus `SameSite=lax` still bound that case), and
 * compare against **the origin the request arrived on**.
 *
 * ## ⚠️ Why the comparand is the arrival origin and NOT `PUBLIC_ORIGIN` (#175)
 *
 * **This deployment serves the app on more than one hostname, without a redirect,
 * on purpose.** `.gitlab-ci.yml`'s `deploy_production` sets `host` to the
 * canonical hostname and passes the apex as `legacyHosts[1]`, recording that it is
 * *"served WITHOUT a redirect … That is deliberate"* — Google's OAuth consent
 * review fetches the homepage cold and wants a `200`, not a hop — and
 * `src/lib/auth/gate.ts` states that `/` must keep answering `200` on every
 * hostname the ingress serves. `PUBLIC_ORIGIN` names exactly one of them.
 *
 * So comparing against `requestOrigin()` refuses **every** request from the other
 * served hostname. That is not a theoretical loss of a fallback path: it was
 * measured on `/api/braindump`, where it refused every capture typed on the apex,
 * foreground and queued alike, with a `400` the client maps to "retryable" — so it
 * presented to the user as *"waiting to save"* forever and to an operator as
 * nothing at all.
 *
 * `requestOrigin`'s `PUBLIC_ORIGIN` pinning is correct for what it is for — an
 * **OAuth redirect URI**, which must be one stable value a provider was
 * registered with, and which is why `CANONICAL_ORIGIN_PREFIXES` moves the whole
 * sign-in journey onto that host (#174). It is the wrong source for a CSRF
 * comparison, and the two failure modes are opposites: a redirect URI derived from
 * a spoofable header is an account-takeover vector, while a CSRF comparand pinned
 * to one host is an outage on the hosts it does not name.
 *
 * ## ⚠️ This still blocks cross-site, which is the entire job
 *
 * A forged POST carries the ATTACKER's `Origin` against the VICTIM's `Host` — the
 * attacker must aim at the victim's hostname, because both session cookies are
 * host-only — so the two differ and the request is refused. What it does not do is
 * insist on one hostname, which was never the property being bought.
 *
 * The comparand is derived from attacker-controllable headers, so the question
 * that decides whether this is sound is whether a CSRF attacker can move
 * `x-forwarded-host` (or `Host`) to their own hostname and make the two agree.
 * They cannot, for three independent reasons, and the first two were verified
 * against the deployment rather than assumed:
 *
 *  1. **Both proxies overwrite the header from the inbound `Host`.**
 *     ingress-nginx: `proxy_set_header X-Forwarded-Host $best_http_host` with
 *     `set $best_http_host $http_host`, and that line carries **no**
 *     `use-forwarded-headers` conditional while the `X-Forwarded-For` line three
 *     lines above it does — the original value is preserved into a separate
 *     `X-Original-Forwarded-Host` header precisely because this one is discarded.
 *     Caddy, for self-host: `header_up X-Forwarded-Host {host}`
 *     (`docker/Caddyfile`).
 *  2. **A browser cannot add the header cross-origin anyway.**
 *     `X-Forwarded-Host` is not a CORS-safelisted request header, so a
 *     cross-origin `fetch` carrying it is preflighted — and this app sets no
 *     `Access-Control-*` header anywhere and exposes no `OPTIONS` handler, so the
 *     preflight fails and the POST is never sent. A `<form>` cannot set headers at
 *     all. CSRF needs the browser to attach the cookie ambiently, so an attacker
 *     who steps outside the browser to forge headers has no session to forge with.
 *  3. **`Host` itself is not free either.** Reaching this app at all means
 *     matching an ingress rule, and the multi-SAN certificate covers only the
 *     hostnames the chart serves — so a DNS-rebinding attempt that made `Origin`
 *     and `Host` agree on the attacker's own hostname fails TLS, fails to route,
 *     and would carry no host-only cookie even if it did both.
 *
 * ## ⚠️ The trap worth naming, because the next route handler inherits it
 *
 * Capture worked on the apex before this route existed, and that was not luck:
 * the write was a **server action**, and Next's own action CSRF guard compares
 * `Origin` against the request's own `Host`/`x-forwarded-host` — the arrival
 * origin, exactly what this function reconstructs. Replacing a server action with
 * a route handler silently changes the comparand from *"the host the browser
 * used"* to *"the one canonical host"*, and on a single-hostname deployment the
 * two are indistinguishable. **Any future route handler replacing a server action
 * inherits this**, which is why the comparison lives here rather than being
 * written out at a call site for the third time.
 */
export function hasDisallowedOrigin(req: Request): boolean {
  const declared = req.headers.get("origin");
  // A MISSING Origin is allowed, deliberately — a non-browser client, which
  // POST-only plus host-only `SameSite=lax` cookies already bound. Note this tests
  // for ABSENCE and not for falsiness: `"null"` is a real value a browser sends
  // for an opaque origin (a sandboxed iframe, or a POST that arrived via a
  // cross-origin redirect) and it must reach the comparison and be refused.
  if (declared === null) return false;

  const arrived = arrivalOrigin(req);
  // Fail closed. An `Origin` we cannot check is not an `Origin` we can allow, and
  // the alternative — treating an unparseable request as unconstrained — is the
  // shape that turns a guard into a formality.
  if (arrived === null) return true;

  return declared.trim().toLowerCase() !== arrived;
}

/**
 * External origin of the request.
 *
 * ⚠️ **For OAuth redirect URIs and other absolute URLs this app SERVES — not for
 * a CSRF comparison.** In a deployment serving more than one hostname, pinning
 * refuses every request from the hostnames PUBLIC_ORIGIN does not name; use
 * `hasDisallowedOrigin` above, which documents the difference (#175).
 *
 * In production PUBLIC_ORIGIN pins the origin (e.g. https://dlectroflow.dev),
 * so OAuth redirect URIs can't be influenced by spoofed Host / X-Forwarded-* headers.
 * When PUBLIC_ORIGIN is unset (local dev), fall back to forwarded headers — behind
 * ingress-nginx TLS terminates at the ingress, so the pod would otherwise see http://.
 */
export function requestOrigin(req: Request): string {
  const configured = process.env.PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  // In production PUBLIC_ORIGIN is required (the Helm chart always sets it). If it's
  // somehow missing, refuse to derive the origin from spoofable headers.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "PUBLIC_ORIGIN must be set in production (refusing to derive OAuth origin from request headers).",
    );
  }

  const h = req.headers;
  const url = new URL(req.url);
  const proto =
    h.get("x-forwarded-proto")?.split(",")[0].trim() ??
    url.protocol.replace(":", "");
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? url.host;
  return `${proto}://${host}`;
}

/**
 * External origin without a request — for server actions that embed an absolute,
 * *persisted* URL (e.g. a focus deep-link written into a scheduled .ics / Google
 * Task, #39). PUBLIC_ORIGIN is the right source here (stable, not request-derived);
 * in production it's required, and locally we fall back to the dev server origin.
 */
export function publicOrigin(): string {
  const configured = process.env.PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "production") {
    throw new Error("PUBLIC_ORIGIN must be set in production.");
  }
  return "http://localhost:3000";
}

/**
 * The absolute URL an auth-flow request should be moved to, or `null` if it is
 * already where it belongs.
 *
 * **Why this exists (#174).** The app is reachable on more than one hostname,
 * but every OAuth redirect URI is built from the single origin PUBLIC_ORIGIN
 * names (see `requestOrigin` above), and the PKCE verifier + state cookies are
 * set with no `Domain` attribute — so they are host-only. A sign-in begun on
 * any other hostname set its cookies there, was returned by the provider to the
 * PUBLIC_ORIGIN host, and failed `missing_oauth_params` on cookies the browser
 * held but would not send. Not a hang and not a one-off: an unbreakable loop of
 * error page → retry → same error.
 *
 * Which paths move is `isCanonicalOriginPath` (src/lib/auth/gate.ts) — narrow
 * on purpose, and documented there. This function is only the origin half.
 *
 * It could not live in `next.config.ts`'s `redirects()`: with
 * `output: "standalone"` those rules are serialised into `routes-manifest.json`
 * at `next build` time, where PUBLIC_ORIGIN is unset, so the hostname pair
 * would be frozen into the image — which is exactly how the pre-existing
 * hardcoded rule drifted. This runs per request instead.
 *
 * Safe against an attacker-chosen Host: the destination is *always* built from
 * PUBLIC_ORIGIN, and the inbound host is only ever compared, never echoed.
 */
export function canonicalOriginRedirect({
  host,
  pathname,
  search,
}: {
  /** The inbound Host header, verbatim. */
  host: string | null | undefined;
  pathname: string;
  search: string;
}): string | null {
  const configured = process.env.PUBLIC_ORIGIN?.trim();
  // Unset means local dev (see requestOrigin above) — there is no canonical
  // hostname to enforce, and localhost/127.0.0.1/a LAN IP are all legitimate.
  if (!configured) return null;
  if (!isCanonicalOriginPath(pathname)) return null;

  let canonical: URL;
  try {
    canonical = new URL(configured);
  } catch {
    // A malformed PUBLIC_ORIGIN is a deploy bug, but taking every request down
    // over it would be worse than serving them off-canonical.
    //
    // It must not be SILENT, though. Returning null here disables the whole
    // canonical-origin protection, which is #174's own failure mode moved up a
    // level: the app says nothing and the only symptom is users looping at
    // sign-in. Raised in review on !280.
    //
    // Once per process, not per request — this runs on every auth-flow request,
    // and a bad deploy value would otherwise bury the logs it is trying to
    // reach.
    if (!warnedMalformedOrigin) {
      warnedMalformedOrigin = true;
      recordAuthFailure({
        reason: "public_origin_unparseable",
        // Deliberately not the request's host: the fault is the configured
        // value, and naming the visitor's hostname would point at the wrong
        // thing. The bad value itself is a deploy config string, not a secret.
        host: null,
      });
    }
    return null;
  }

  const inbound = host?.trim().toLowerCase();
  // No Host header at all (HTTP/1.0) — nothing to compare, leave it alone.
  if (!inbound) return null;
  if (inbound === canonical.host.toLowerCase()) return null;

  const target = new URL(canonical.origin);
  // SECURITY: the `pathname` setter, never `new URL(pathname, canonical)`. A
  // request for `//evil.example/x` has that as its pathname, and the two-arg
  // form resolves it protocol-relatively to `https://evil.example/x` — an open
  // redirect. The setter keeps the host that is already on the URL.
  target.pathname = pathname;
  target.search = search;
  return target.toString();
}
