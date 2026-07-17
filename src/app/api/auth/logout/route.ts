import { NextResponse } from "next/server";
import { OWNER_COOKIE } from "@/lib/auth/session";
import { requestOrigin } from "@/lib/origin";

export const runtime = "nodejs";

// Item 7b (#21 P5 batch B): logout is a state change, so it is POST-only and
// CSRF-safe. Previously a bare GET cleared the owner cookie, so a link /
// prefetch / <img src> could force a sign-out. SameSite=lax on the owner cookie
// already blocks the cookie on cross-site requests; requiring POST closes the
// same-site GET/prefetch vector too. The owner JWT is stateless — deleting the
// cookie is the client-side sign-out; server-side revocation and an explicit
// Origin/same-site check on this POST are follow-ups (see #21).
export async function POST(req: Request): Promise<Response> {
  // 303 See Other so the browser follows up with a GET to /inbox after the POST.
  const res = NextResponse.redirect(`${requestOrigin(req)}/inbox`, 303);
  res.cookies.delete(OWNER_COOKIE);
  return res;
}
