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
