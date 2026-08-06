import { isCanonicalOriginPath } from "./auth/gate";

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
