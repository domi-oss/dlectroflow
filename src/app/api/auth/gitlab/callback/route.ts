import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthProvider, isOwner } from "@/lib/auth/providers";
import { authConfig } from "@/lib/auth/config";
import {
  signOwnerSession,
  OWNER_COOKIE,
  OWNER_SESSION_TTL_SECONDS,
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

  let identity: string;
  try {
    const provider = getAuthProvider();
    const token = await provider.exchangeCode({
      code,
      codeVerifier: verifier,
      redirectUri: `${origin}/api/auth/gitlab/callback`,
    });
    identity = await provider.fetchIdentity(token);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "auth_failed");
  }

  const { ownerAllowlist, sessionSecret } = authConfig();
  if (!isOwner(identity, ownerAllowlist)) return fail("not_authorized");

  const session = await signOwnerSession(
    { kind: "owner", sub: identity },
    sessionSecret,
  );
  const res = NextResponse.redirect(`${origin}/inbox`);
  res.cookies.set(OWNER_COOKIE, session, {
    httpOnly: true,
    secure: origin.startsWith("https"),
    sameSite: "lax",
    path: "/",
    // Keep the cookie lifetime in lock-step with the JWT exp (both 7d) so the
    // browser drops the cookie when the token expires. See OWNER_SESSION_TTL_SECONDS.
    maxAge: OWNER_SESSION_TTL_SECONDS,
  });
  res.cookies.delete("gitlab_oauth_state");
  res.cookies.delete("gitlab_pkce_verifier");
  return res;
}
