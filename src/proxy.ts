import { NextRequest, NextResponse } from "next/server";
import {
  verifySession,
  signGuestSession,
  OWNER_COOKIE,
  GUEST_COOKIE,
  GUEST_WS_HEADER,
} from "@/lib/auth/session";
import { authConfig } from "@/lib/auth/config";
import {
  isPublicPath,
  isOwnerOnlyPath,
  isAuthenticatedOnlyPath,
} from "@/lib/auth/gate";
import {
  canonicalOriginRedirect,
  requestOrigin,
  inboundHost,
} from "@/lib/origin";

export const config = {
  // Skip Next internals + static assets; run on everything else.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.\\w+$).*)"],
};

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // #174 — move the request onto the canonical origin before anything else.
  //
  // FIRST, ahead of every session decision, because everything below this line
  // sets a host-only cookie. The bug this fixes was a sign-in begun on a
  // non-canonical hostname: the PKCE verifier and OAuth state landed there, the
  // provider returned the browser to the PUBLIC_ORIGIN host, and the callback
  // failed `missing_oauth_params` on cookies the browser held but would not
  // send — an unbreakable loop with no way out. Minting a guest sandbox on a
  // host we are about to leave has the same shape, one cookie down.
  //
  // Host precedence is `inboundHost` (src/lib/origin.ts) — x-forwarded-host,
  // then host. Both are attacker-controllable, and that is fine here:
  // canonicalOriginRedirect only ever COMPARES the inbound host, and builds the
  // destination from PUBLIC_ORIGIN, so a spoofed Host can at worst trigger a
  // redirect to where the request was already going.
  const host = inboundHost(req.headers) ?? req.nextUrl.host;
  const canonical = canonicalOriginRedirect({
    host,
    pathname,
    search: req.nextUrl.search,
  });
  // 307, not 308. A permanent redirect between two hostnames is cached by the
  // browser indefinitely, and the canonical host is a runtime value a redeploy
  // can change — flip it after a 308 is cached and the two hosts point at each
  // other from cache alone, a loop no reload can clear. The SEO value of a
  // legacy hostname is not worth that.
  if (canonical) return NextResponse.redirect(canonical, 307);

  const { sessionSecret } = authConfig();
  const guestTtlHours = Number(process.env.GUEST_SANDBOX_TTL_HOURS ?? 24);

  // Security: strip any inbound GUEST_WS_HEADER so a malicious client cannot
  // inject a workspace id. This stripped copy is used for all pass-throughs.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.delete(GUEST_WS_HEADER);

  const sessionToken = req.cookies.get(OWNER_COOKIE)?.value;
  const sessionPayload = sessionToken
    ? await verifySession(sessionToken, sessionSecret)
    : null;
  // A real signed-in account (#35). The middleware can only tell "signed in"
  // from "guest" — telling an OWNER from a MEMBER needs the database, which the
  // Edge runtime has no client for, so role checks stay in isOwnerRequest() at
  // the route/action layer. OWNER_ONLY_PREFIXES therefore means "signed in" at
  // this layer and "role = owner" at the handler; both gates run. The partner
  // gate is named, not assumed: #119 found this promise unkept on the Google
  // OAuth routes, so the handlers now call isOwnerRequest() themselves — see
  // src/app/api/google/oauth/{start,callback}/route.ts.
  //
  // #220 — the same boundary, for the same reason, applies to `User.status`.
  // This is "the signature is ours and unexpired", NOT "this account may act": a
  // frozen account's cookie stays cryptographically valid for its full 30 days,
  // and nothing here can read a status to know otherwise. So this must never
  // become the only gate in front of anything that reads or writes account data.
  // The status check is currentWorkspaceId()'s, at the action/route layer, where
  // the round trip it needs is already being made; src/lib/workspace.ts says why
  // it is there rather than here.
  const isSignedIn = sessionPayload?.kind === "user";

  // Owner-only paths: block guests.
  if (isOwnerOnlyPath(pathname) && !isSignedIn) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  // Authenticated-only paths: a valid GUEST session is not enough here.
  if (isAuthenticatedOnlyPath(pathname) && !isSignedIn) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // A signed-in account passes through with the inbound header stripped and
  // NO guest cookie minted below — otherwise they would carry a guest workspace
  // header alongside their own session and the resolver could read either.
  if (isSignedIn) {
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
    // One canonical guest signer (shares SESSION_ALG; no inline alg to drift).
    guestToken = await signGuestSession(
      wsId,
      sessionSecret,
      guestTtlHours * 3600,
    );
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
