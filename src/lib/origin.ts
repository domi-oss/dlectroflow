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
 * compares it and builds the destination from PUBLIC_ORIGIN, and
 * `recordAuthFailure` writes it to a log line. Do not use this to construct a
 * URL that is served back to the user.
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
 * External origin of the request.
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
