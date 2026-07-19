import { NextResponse } from "next/server";
import { getAuthProvider } from "@/lib/auth/providers";
import { createPkce, randomState } from "@/lib/oauth-pkce";
import { requestOrigin } from "@/lib/origin";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const origin = requestOrigin(req);
  const redirectUri = `${origin}/api/auth/gitlab/callback`;
  const { verifier, challenge } = createPkce();
  const state = randomState();
  const res = NextResponse.redirect(
    getAuthProvider().buildAuthorizeUrl({
      redirectUri,
      state,
      codeChallenge: challenge,
    }),
  );
  const opts = {
    httpOnly: true,
    secure: origin.startsWith("https"),
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  };
  res.cookies.set("gitlab_pkce_verifier", verifier, opts);
  res.cookies.set("gitlab_oauth_state", state, opts);
  return res;
}
