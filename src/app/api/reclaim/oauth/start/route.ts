import { NextResponse } from "next/server";
import {
  ensureClient,
  createPkce,
  randomState,
  buildAuthorizeUrl,
} from "@/lib/reclaim";
import { requestOrigin } from "@/lib/origin";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const origin = requestOrigin(req);
  const redirectUri = `${origin}/api/reclaim/oauth/callback`;

  try {
    const { clientId } = await ensureClient(redirectUri);
    const { verifier, challenge } = createPkce();
    const state = randomState();

    const authorizeUrl = buildAuthorizeUrl({
      clientId,
      redirectUri,
      state,
      codeChallenge: challenge,
    });

    const res = NextResponse.redirect(authorizeUrl);
    const cookieOpts = {
      httpOnly: true,
      secure: origin.startsWith("https"),
      sameSite: "lax" as const,
      path: "/",
      maxAge: 600, // 10 min
    };
    res.cookies.set("reclaim_pkce_verifier", verifier, cookieOpts);
    res.cookies.set("reclaim_oauth_state", state, cookieOpts);
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "connect_failed";
    return NextResponse.redirect(
      `${origin}/inbox?reclaim=error&reason=${encodeURIComponent(msg)}`,
    );
  }
}
