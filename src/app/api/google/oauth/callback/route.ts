import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeCode } from "@/lib/google";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const jar = await cookies();
  const expectedState = jar.get("google_oauth_state")?.value;
  const verifier = jar.get("google_pkce_verifier")?.value;

  const fail = (reason: string) => {
    const res = NextResponse.redirect(
      `${origin}/inbox?google=error&reason=${encodeURIComponent(reason)}`,
    );
    res.cookies.delete("google_oauth_state");
    res.cookies.delete("google_pkce_verifier");
    return res;
  };

  if (oauthError) return fail(oauthError);
  if (!code) return fail("missing_code");
  if (!state) return fail("missing_state");
  if (!verifier) return fail("missing_verifier_cookie");
  if (state !== expectedState) return fail("state_mismatch");

  try {
    await exchangeCode(code, verifier, `${origin}/api/google/oauth/callback`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "token_exchange_failed");
  }

  const res = NextResponse.redirect(`${origin}/inbox?google=connected`);
  res.cookies.delete("google_oauth_state");
  res.cookies.delete("google_pkce_verifier");
  return res;
}
