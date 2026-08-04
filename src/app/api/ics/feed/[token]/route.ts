import {
  buildFeedIcs,
  isFeedTokenShape,
  resolveFeed,
} from "@/lib/calendar-feed";

/**
 * #154 — the per-user calendar subscription feed.
 *
 * ## The token in the path is the whole authorization
 *
 * This is the one route in the app that authorises from something other than a
 * session, and it has to be: Google Calendar, Apple Calendar and Outlook all
 * fetch a subscription anonymously from a background agent, with no cookie and
 * no way to sign in. So the capability token is the credential, and
 * `src/lib/auth/gate.ts` opens `/api/ics/feed` — and nothing wider — to match.
 * `/api/ics/[taskId]` next door stays session-scoped: its id is guessable in a
 * way 256 CSPRNG bits are not.
 *
 * `resolveFeed` is where that authorization actually happens. This handler holds
 * no `prisma` call of its own and cannot: the scoping harness pins the entire
 * `prisma.calendarFeed` surface to `src/lib/calendar-feed.ts`, so there is one
 * place to read if you want to know who this request is.
 *
 * ## Everything unknown is the same 404
 *
 * Malformed, never-existed, regenerated a second ago, or belonging to an account
 * that was revoked — one answer, one body, no header that differs. Telling them
 * apart would turn the endpoint into an oracle, and there is nothing a
 * legitimate subscriber could do with the distinction anyway. The shape check
 * runs first so a probe that is not token-shaped never becomes a query.
 *
 * ## Not cacheable, and that is load-bearing
 *
 * A shared cache is the one thing that could break the revocation promise: if an
 * intermediary held a copy, a regenerated token would keep serving from it, and
 * the URL is fetched with no cookie so a proxy has every reason to think the
 * response is shareable. `no-store` says otherwise, and `private` says it again
 * for anything that only understands the older directive.
 *
 * Verified against how this app is actually deployed rather than assumed:
 *  - **Next.js** — `GET` route handlers have been dynamic (uncached) by default
 *    since 15.0; `force-dynamic` states it rather than relying on the default,
 *    and matches `/api/export`.
 *  - **Kubernetes** — `charts/dlectroflow/templates/ingress.yaml` sets no
 *    caching annotation, and ingress-nginx does not cache unless asked. It does
 *    apply `limit-rps: 20` per source IP, which is the abuse backstop this route
 *    needs and did not have to invent.
 *  - **Docker Compose** — `docker/Caddyfile` reverse-proxies with `encode` only.
 *    Caddy's `reverse_proxy` does not cache. That path has no per-IP rate limit
 *    (the Caddyfile says so and why), which is a property of the self-host stack
 *    rather than of this route.
 *
 * There is deliberately no rate limit in application code. The token is 256 bits
 * from a CSPRNG, so guessing is not a strategy; a per-token limit would throttle
 * the legitimate subscriber and do nothing about a flood of DIFFERENT invalid
 * tokens; and a per-IP one would mean trusting a forwarded header, which this
 * codebase refuses to do elsewhere for good reason (see `src/lib/origin.ts`).
 * What an invalid token costs is one indexed miss.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One answer for every failure, so the endpoint is not an oracle. */
function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;

  // Before the database: a path segment that is not token-shaped is not a
  // credential anybody ever held, so it never becomes a query.
  if (!isFeedTokenShape(token)) return notFound();

  const feed = await resolveFeed(token);
  if (!feed) return notFound();

  const ics = await buildFeedIcs({ workspaceId: feed.workspaceId });

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      // `inline`, and a FIXED filename that carries no account detail. A
      // subscription is fetched by a background agent rather than saved by a
      // person, and `attachment` makes some clients download a file instead.
      "Content-Disposition": 'inline; filename="dlectroflow.ics"',
      "Cache-Control": "private, no-store, max-age=0, must-revalidate",
      // The body is a text format some clients will happily sniff into
      // something renderable. It is served from the app's own origin, so say no.
      "X-Content-Type-Options": "nosniff",
      // If the URL ever escapes into a crawler's reach — pasted into a public
      // issue, left in a shared document — this is the cheapest thing that keeps
      // somebody's schedule out of a search index.
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}
