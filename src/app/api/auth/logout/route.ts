import { NextResponse } from "next/server";
import { OWNER_COOKIE } from "@/lib/auth/session";
import { requestOrigin } from "@/lib/origin";

export const runtime = "nodejs";

// Item 7b (#21 P5 batch B): logout is a state change, so it is POST-only and
// CSRF-safe. Previously a bare GET cleared the owner cookie, so a link /
// prefetch / <img src> could force a sign-out. SameSite=lax on the owner cookie
// already blocks the cookie on cross-site requests; requiring POST closes the
// same-site GET/prefetch vector too. The owner JWT is stateless — deleting the
// cookie is the client-side sign-out; server-side revocation remains a follow-up
// (see #21).
export async function POST(req: Request): Promise<Response> {
  const allowedOrigin = requestOrigin(req);

  // Defense-in-depth (CWE-352): SameSite=lax does not block *same-site* POST, so a
  // page on the same eTLD+1 (e.g. a subdomain) could POST here to force a sign-out.
  // Reject when the Origin header is present but doesn't match our origin. A missing
  // Origin is allowed (non-browser clients); POST-only + SameSite=lax still bound
  // the cross-site case.
  //
  // ⚠️ **Copy `hasDisallowedOrigin` (src/lib/origin.ts), not the two lines below,
  // if you need this guard on another route.** Comparing against `requestOrigin`
  // refuses every request from the other hostname production serves without a
  // redirect — a real regression when the pattern was reused on `/api/braindump`
  // (#175), where it refused every capture typed on the apex. That function
  // documents why, and why PUBLIC_ORIGIN is right for a redirect URI and wrong for
  // this comparison.
  //
  // This route is NOT affected today, which is why it is left alone rather than
  // changed in #175's MR: the sign-out form only renders for a resolved identity
  // (`AccountMenu` in src/components/nav/), the owner cookie is set with no
  // `Domain` so it is host-only, and #174 forces the whole sign-in journey onto
  // PUBLIC_ORIGIN's host — so nobody is ever signed in on any other hostname and
  // the form is never rendered there. It becomes reachable the moment either of
  // those changes: a second hostname allowed to complete a sign-in, or a session
  // cookie gaining a `Domain` attribute. Move it to `hasDisallowedOrigin` then.
  const origin = req.headers.get("origin");
  if (origin && origin !== allowedOrigin) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // 303 See Other so the browser follows up with a GET to / (the inbox root)
  // after the POST.
  const res = NextResponse.redirect(`${allowedOrigin}/`, 303);
  res.cookies.delete(OWNER_COOKIE);
  return res;
}
