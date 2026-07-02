import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeCode } from "@/lib/reclaim";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const jar = await cookies();
  const expectedState = jar.get("reclaim_oauth_state")?.value;
  const verifier = jar.get("reclaim_pkce_verifier")?.value;

  const fail = (reason: string) => {
    const res = NextResponse.redirect(
      `${origin}/inbox?reclaim=error&reason=${encodeURIComponent(reason)}`,
    );
    res.cookies.delete("reclaim_oauth_state");
    res.cookies.delete("reclaim_pkce_verifier");
    return res;
  };

  if (oauthError) return fail(oauthError);
  if (!code || !state || !verifier || state !== expectedState) {
    return fail("invalid_oauth_callback");
  }

  try {
    await exchangeCode(code, verifier, `${origin}/api/reclaim/oauth/callback`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "token_exchange_failed");
  }

  const res = NextResponse.redirect(`${origin}/inbox?reclaim=connected`);
  res.cookies.delete("reclaim_oauth_state");
  res.cookies.delete("reclaim_pkce_verifier");
  return res;
}
