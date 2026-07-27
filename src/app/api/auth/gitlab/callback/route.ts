import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthProvider, type AuthProfile } from "@/lib/auth/providers";
import { authConfig } from "@/lib/auth/config";
import { provisionFromProfile } from "@/lib/auth/provisioning";
import {
  signUserSession,
  OWNER_COOKIE,
  USER_SESSION_TTL_SECONDS,
} from "@/lib/auth/session";
import { requestOrigin } from "@/lib/origin";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const origin = requestOrigin(req);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const jar = await cookies();
  const expectedState = jar.get("gitlab_oauth_state")?.value;
  const verifier = jar.get("gitlab_pkce_verifier")?.value;

  const fail = (reason: string) => {
    const res = NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(reason)}`,
    );
    res.cookies.delete("gitlab_oauth_state");
    res.cookies.delete("gitlab_pkce_verifier");
    return res;
  };

  if (oauthError) return fail(oauthError);
  if (!code || !state || !verifier) return fail("missing_oauth_params");
  if (!expectedState) return fail("state_mismatch");
  if (state !== expectedState) return fail("state_mismatch");

  let profile: AuthProfile;
  try {
    const provider = getAuthProvider();
    const token = await provider.exchangeCode({
      code,
      codeVerifier: verifier,
      redirectUri: `${origin}/api/auth/gitlab/callback`,
    });
    profile = await provider.fetchProfile(token);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "auth_failed");
  }

  const { provider, sessionSecret } = authConfig();
  const result = await provisionFromProfile(provider, profile);
  // ONE reason string for both not_invited and revoked. A distinct message
  // would turn this endpoint into an oracle for whether an identity is known to
  // the instance — the allowlist is not meant to be enumerable.
  if (!result.ok) return fail("not_authorized");

  const session = await signUserSession(
    { kind: "user", userId: result.userId, wsId: result.workspaceId },
    sessionSecret,
  );
  const res = NextResponse.redirect(`${origin}/`);
  res.cookies.set(OWNER_COOKIE, session, {
    httpOnly: true,
    secure: origin.startsWith("https"),
    sameSite: "lax",
    path: "/",
    // Keep the cookie lifetime in lock-step with the JWT exp (both 30d) so the
    // browser drops the cookie when the token expires. See USER_SESSION_TTL_SECONDS.
    maxAge: USER_SESSION_TTL_SECONDS,
  });
  res.cookies.delete("gitlab_oauth_state");
  res.cookies.delete("gitlab_pkce_verifier");
  return res;
}
