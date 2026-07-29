import { NextResponse } from "next/server";
import {
  googleConfigured,
  createPkce,
  randomState,
  buildAuthorizeUrl,
} from "@/lib/google";
import { requestOrigin } from "@/lib/origin";
import { isOwnerRequest } from "@/lib/workspace";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  // #119 — the handler half of the two-gate design described in src/proxy.ts.
  // The middleware can only prove "signed in" (no Prisma client on the Edge
  // runtime), and Google is ONE instance-wide credential row until #118 makes it
  // per user, so a signed-in member reaching this route could hand their own
  // account the owner's task pushes. 403 rather than a redirect: this is an API
  // route, and bouncing a member into Google's consent screen would walk them
  // through the very flow being denied. The check is first so a rejected caller
  // is minted no PKCE verifier or state cookie to replay at the callback.
  if (!(await isOwnerRequest())) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const origin = requestOrigin(req);

  if (!googleConfigured()) {
    return NextResponse.redirect(
      `${origin}/?google=error&reason=${encodeURIComponent(
        "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set",
      )}`,
    );
  }

  const redirectUri = `${origin}/api/google/oauth/callback`;
  const { verifier, challenge } = createPkce();
  const state = randomState();

  const res = NextResponse.redirect(
    buildAuthorizeUrl({ redirectUri, state, codeChallenge: challenge }),
  );
  const cookieOpts = {
    httpOnly: true,
    secure: origin.startsWith("https"),
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  };
  res.cookies.set("google_pkce_verifier", verifier, cookieOpts);
  res.cookies.set("google_oauth_state", state, cookieOpts);
  return res;
}
