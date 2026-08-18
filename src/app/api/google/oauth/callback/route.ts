import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  exchangeCode,
  GoogleTimeoutError,
  GOOGLE_TIMEOUT_REASON,
} from "@/lib/google";
import { requestOrigin } from "@/lib/origin";
import { currentUser } from "@/lib/workspace";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  // #118 Phase C — the route that WRITES credentials. Any signed-in account may
  // complete an exchange, because the tokens can only land in THAT account's row:
  // exchangeCode takes `me.id` and there is no id parameter for a caller to
  // point elsewhere. That is why #119's role test could be relaxed and the
  // isolation still holds.
  //
  // Still 403, still before the cookie jar is read, so a rejected caller holding
  // a state + verifier pair completes nothing. Still not redundant with the
  // middleware: a revoked account passes that and resolves to null here.
  const me = await currentUser();
  if (!me) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const url = new URL(req.url);
  const origin = requestOrigin(req);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const jar = await cookies();
  const expectedState = jar.get("google_oauth_state")?.value;
  const verifier = jar.get("google_pkce_verifier")?.value;

  const fail = (reason: string) => {
    const res = NextResponse.redirect(
      `${origin}/?google=error&reason=${encodeURIComponent(reason)}`,
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
    await exchangeCode(
      me.id,
      code,
      verifier,
      `${origin}/api/google/oauth/callback`,
    );
  } catch (err) {
    // #211 — a deadline is not a refusal, and the two want different words.
    //
    // Nothing else bounds this request: it is a browser navigation back from
    // Google, so there is no server action to wrap in `withActionTimeout` and
    // no spinner to abandon. A stalled endpoint was five minutes of blank page.
    // Now that it fails in ten seconds, what the person reads next matters —
    // and `err instanceof Error` accepts a DOMException, so left alone this
    // line would put "The operation was aborted due to timeout" in the URL and
    // the inbox banner would print it verbatim.
    //
    // A fixed token rather than the message, because the banner has to BRANCH
    // on it: a timeout is retryable and gets a reconnect affordance, while a
    // refused exchange is not going to be fixed by pressing the same button
    // again and keeps its own text.
    if (err instanceof GoogleTimeoutError) return fail(GOOGLE_TIMEOUT_REASON);
    return fail(err instanceof Error ? err.message : "token_exchange_failed");
  }

  const res = NextResponse.redirect(`${origin}/?google=connected`);
  res.cookies.delete("google_oauth_state");
  res.cookies.delete("google_pkce_verifier");
  return res;
}
