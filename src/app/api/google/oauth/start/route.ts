import { NextResponse } from "next/server";
import {
  googleConfigured,
  createPkce,
  randomState,
  buildAuthorizeUrl,
} from "@/lib/google";
import { requestOrigin } from "@/lib/origin";
import { currentUser } from "@/lib/workspace";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  // #118 Phase C — any signed-in account may connect THEIR OWN Google account.
  // The middleware already rejects guests (AUTHENTICATED_PREFIXES); this is the
  // handler half of the two-gate design in src/proxy.ts, and it is not redundant:
  // a REVOKED account still holds a valid signed cookie and passes the
  // middleware, while currentUser() resolves it to null (src/lib/workspace.ts).
  // 403 rather than a redirect — bouncing a rejected caller into Google's consent
  // screen walks them through the very flow being denied. First, so a rejected
  // caller is minted no PKCE verifier or state cookie to replay at the callback.
  if (!(await currentUser())) {
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
