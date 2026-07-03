/**
 * External origin of the request.
 *
 * In production PUBLIC_ORIGIN pins the origin (e.g. https://dlectroflow.dlectronique.dev),
 * so OAuth redirect URIs can't be influenced by spoofed Host / X-Forwarded-* headers.
 * When PUBLIC_ORIGIN is unset (local dev), fall back to forwarded headers — behind
 * ingress-nginx TLS terminates at the ingress, so the pod would otherwise see http://.
 */
export function requestOrigin(req: Request): string {
  const configured = process.env.PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const h = req.headers;
  const url = new URL(req.url);
  const proto =
    h.get("x-forwarded-proto")?.split(",")[0].trim() ?? url.protocol.replace(":", "");
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? url.host;
  return `${proto}://${host}`;
}
