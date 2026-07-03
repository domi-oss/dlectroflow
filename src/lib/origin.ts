/**
 * External origin of the request, honoring reverse-proxy forwarded headers.
 * Behind ingress-nginx, TLS terminates at the ingress and the pod receives plain
 * HTTP, so `new URL(req.url).origin` would wrongly yield http://…. ingress-nginx
 * sets x-forwarded-proto/host; fall back to the request URL for local dev.
 */
export function requestOrigin(req: Request): string {
  const h = req.headers;
  const url = new URL(req.url);
  const proto = h.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? url.host;
  return `${proto}://${host}`;
}
