import { hasSession } from "@/lib/workspace";
import { fetchCatalogTracks } from "@/lib/focus-catalog-source";
import type { FocusTrack } from "@/lib/focus-sounds";

/**
 * #61 — the playlist's view of the streamed lo-fi catalog.
 *
 * ## What it is for
 *
 * #43 bundles ten CC0 tracks, one per open-lofi category. The full set is 166
 * tracks / ~544 MB, too much for a container image, so the rest is read from an
 * object store the operator configures. This route is where the client asks what
 * is out there; `audio/route.ts` next door serves the bytes.
 *
 * ## Same-origin, which is the point rather than an implementation detail
 *
 * Every `src` in the response is a path into this app. `next.config.ts` keeps
 * `default-src 'self'` with `media-src` unset, so the browser refuses audio from
 * anywhere else — a focus session is a long, unattended, personal page view and
 * makes no third-party request. Handing the client a store URL here would need a
 * CSP relaxation and is explicitly out of scope for #61;
 * `src/lib/security-headers.test.ts` fails if that posture erodes.
 *
 * ## Gated on a session, not on ownership of anything
 *
 * The tracks are public domain and carry no user data, so this is not a
 * confidentiality gate — it is what stops an anonymous caller using the instance
 * as a relay to somebody else's storage. A guest sandbox counts: guests use the
 * focus timer, and `src/proxy.ts` mints them a signed session before the request
 * arrives. `hasSession()` rather than `currentWorkspaceId()` because no user data
 * is read and a `lastSeenAt` write per catalog fetch buys nothing.
 *
 * ## Three outcomes, two of them fine
 *
 * `unconfigured` (200) is the normal state of a fresh install and not an error —
 * the player has the bundled ten. `unavailable` (502) means a store WAS
 * configured and did not answer, which is worth an operator's attention, so it
 * gets a status that shows up in the logs while handing the client the same empty
 * list. Either way a focus session never starts silent.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long a browser may reuse the catalog. It changes when an operator
 *  re-uploads the store's contents, which is a rare, deliberate act. */
const CATALOG_MAX_AGE_SECONDS = 3600;

type CatalogPayload = {
  source: "catalog" | "unconfigured" | "unavailable";
  tracks: FocusTrack[];
};

function json(
  payload: CatalogPayload,
  status: number,
  cacheControl: string,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(): Promise<Response> {
  if (!(await hasSession())) {
    // `src/proxy.ts` redirects browsers before they reach here, so this is a
    // direct call with no cookie; a plain-text 401 is the honest answer.
    return new Response("Not signed in", {
      status: 401,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  const result = await fetchCatalogTracks();

  if (result.status === "ok") {
    // `private` because the response is behind a session: a shared cache holding
    // it would serve it to somebody who has not passed the gate above.
    return json(
      { source: "catalog", tracks: result.tracks },
      200,
      `private, max-age=${CATALOG_MAX_AGE_SECONDS}, stale-while-revalidate=60`,
    );
  }

  if (result.status === "unconfigured") {
    return json({ source: "unconfigured", tracks: [] }, 200, "no-store");
  }

  // The reason is already in the server log (`focus_catalog_unavailable`). It is
  // deliberately NOT in the body: it can name the store's host, and the client
  // has nothing to do with it beyond keeping the bundled tracks.
  return json({ source: "unavailable", tracks: [] }, 502, "no-store");
}
