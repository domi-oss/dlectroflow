import { NextResponse } from "next/server";
import { getAuthProvider } from "@/lib/auth/providers";
import { createPkce, randomState } from "@/lib/oauth-pkce";
import { requestOrigin } from "@/lib/origin";
import { GITLAB_OAUTH_CALLBACK_PATH } from "@/lib/auth/oauth-callback";

export const runtime = "nodejs";

/**
 * How long a started sign-in stays completable (#174).
 *
 * NOT the cause of #174 — that was a hostname split, and the failing round trip
 * took fourteen seconds. Widened because ten minutes was never a realistic
 * budget for the flow it has to cover: an interactive sign-in at the provider
 * can involve a password manager, an MFA prompt, an app switch to an
 * authenticator and a switch back, and a phone user gets interrupted partway
 * through all of that. Blowing the deadline is unrecoverable — the callback has
 * no verifier and the attempt is simply lost.
 *
 * Thirty minutes costs nothing in exposure. Both values are pre-authentication
 * nonces: the verifier is httpOnly and useless without a matching state and a
 * fresh authorization code from the provider, and the state is a single-use
 * random value this route just minted. Neither confers any access on its own,
 * and both are deleted on every callback branch, success or failure.
 */
const OAUTH_NONCE_TTL_SECONDS = 30 * 60;

export async function GET(req: Request): Promise<Response> {
  const origin = requestOrigin(req);
  const redirectUri = `${origin}${GITLAB_OAUTH_CALLBACK_PATH}`;
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
    maxAge: OAUTH_NONCE_TTL_SECONDS,
  };
  res.cookies.set("gitlab_pkce_verifier", verifier, opts);
  res.cookies.set("gitlab_oauth_state", state, opts);
  return res;
}
