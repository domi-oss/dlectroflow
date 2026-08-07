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
import { requestOrigin, inboundHost } from "@/lib/origin";
import { recordAuthFailure } from "@/lib/observability";

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
    // Every branch below logs, because the alternative is #174: an owner
    // reporting a sign-in that "hangs", and nothing on the server side to read
    // but an ingress access log.
    //
    // The host is `inboundHost`, not `requestOrigin`'s: that one is pinned to
    // PUBLIC_ORIGIN and would report the canonical hostname even when the
    // mismatch between the two IS the failure. It is also not a bare `Host` —
    // TLS terminates at ingress, so `Host` is not reliably what the browser
    // used, and getting that wrong here would break the single field this
    // whole change exists to record. Caught in review on !280.
    recordAuthFailure({
      reason,
      host: inboundHost(req.headers),
      hadState: Boolean(expectedState),
      hadVerifier: Boolean(verifier),
    });
    const res = NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(reason)}`,
    );
    res.cookies.delete("gitlab_oauth_state");
    res.cookies.delete("gitlab_pkce_verifier");
    return res;
  };

  if (oauthError) return fail(oauthError);
  // Three failures, three reasons — they are not interchangeable to the reader
  // (#174). A return with no code or state in the URL is MALFORMED: the browser
  // still holds its cookies and retrying blindly will not help. Cookies gone
  // while the URL is intact is a LOST ATTEMPT, which is recoverable by simply
  // starting again, and is the one the login page phrases differently. Only a
  // present-but-wrong state is a genuine mismatch.
  //
  // "Expired" is the friendliest true label for the middle case, not a
  // certainty: an attempt that timed out and one begun in a different browser
  // both arrive here as an absent cookie, with nothing left to tell them apart.
  // The copy on /login names both, rather than the server guessing.
  if (!code || !state) return fail("missing_oauth_params");
  if (!verifier || !expectedState) return fail("expired");
  // Fails closed exactly as before; only the labels above were split.
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
