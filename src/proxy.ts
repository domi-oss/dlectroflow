import { NextRequest, NextResponse } from "next/server";
import {
  verifySession,
  OWNER_COOKIE,
  GUEST_COOKIE,
  GUEST_WS_HEADER,
} from "@/lib/auth/session";
import { authConfig } from "@/lib/auth/config";
import { isPublicPath, isOwnerOnlyPath } from "@/lib/auth/gate";
import { requestOrigin } from "@/lib/origin";

export const config = {
  // Skip Next internals + static assets; run on everything else.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.\\w+$).*)"],
};

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const { sessionSecret } = authConfig();
  const guestTtlHours = Number(process.env.GUEST_SANDBOX_TTL_HOURS ?? 24);

  // Security: strip any inbound GUEST_WS_HEADER so a malicious client cannot
  // inject a workspace id. This stripped copy is used for all pass-throughs.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.delete(GUEST_WS_HEADER);

  const ownerToken = req.cookies.get(OWNER_COOKIE)?.value;
  const ownerPayload = ownerToken
    ? await verifySession(ownerToken, sessionSecret)
    : null;
  const isOwner = ownerPayload?.kind === "owner";

  // Owner-only paths: block guests.
  if (isOwnerOnlyPath(pathname) && !isOwner) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // Owner passes through (with inbound header stripped).
  if (isOwner) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // Guest: ensure a signed guest workspace token exists; forward the SIGNED
  // TOKEN (not raw wsId) so the workspace resolver can verify it via
  // verifySession — forwarding the raw id would be spoofable (IDOR).
  let guestToken = req.cookies.get(GUEST_COOKIE)?.value;
  let wsId: string | null = null;
  if (guestToken) {
    const p = await verifySession(guestToken, sessionSecret);
    if (p?.kind === "guest") wsId = p.wsId;
  }
  if (!wsId) {
    // Review apps only: seat every new guest into ONE shared, pre-seeded demo
    // workspace (see prisma/seed.ts) so reviewers land on populated content
    // instead of an empty sandbox. REVIEW_DEMO_WS is set only by the review
    // Helm deploy; it is unset in production, where each guest keeps getting an
    // isolated random workspace. The id is still wrapped in a signed JWT below,
    // so the IDOR defense (verify the token, never trust a raw id) is unchanged.
    wsId = process.env.REVIEW_DEMO_WS || crypto.randomUUID();
    // Sign inline (Edge-compatible via jose used in verifySession's module).
    const { SignJWT } = await import("jose");
    guestToken = await new SignJWT({ kind: "guest", wsId })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(`${guestTtlHours}h`)
      .sign(new TextEncoder().encode(sessionSecret));
  }

  // Security: forward the signed JWT, not the raw wsId. The workspace resolver
  // calls verifySession on this header value and only trusts a valid guest payload.
  requestHeaders.set(GUEST_WS_HEADER, guestToken!);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.cookies.set(GUEST_COOKIE, guestToken!, {
    httpOnly: true,
    // Derive Secure from the DEPLOYED origin (PUBLIC_ORIGIN), not the pod-observed
    // protocol: behind ingress-nginx TLS terminates at the ingress so the pod sees
    // http://, which previously left the guest cookie non-Secure in production.
    // requestOrigin pins PUBLIC_ORIGIN in prod and falls back to forwarded headers
    // in local dev (keeping http:// dev working). Mirrors the owner cookie. (#21)
    secure: requestOrigin(req).startsWith("https"),
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * guestTtlHours,
  });
  return res;
}
