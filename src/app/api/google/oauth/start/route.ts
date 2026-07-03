import { NextResponse } from "next/server";
import {
  googleConfigured,
  createPkce,
  randomState,
  buildAuthorizeUrl,
} from "@/lib/google";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const origin = new URL(req.url).origin;

  if (!googleConfigured()) {
    return NextResponse.redirect(
      `${origin}/inbox?google=error&reason=${encodeURIComponent(
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
