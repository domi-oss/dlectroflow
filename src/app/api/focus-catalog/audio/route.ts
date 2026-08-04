import { hasSession } from "@/lib/workspace";
import { fetchCatalogAudio } from "@/lib/focus-catalog-source";
import { CATALOG_TRACK_PARAM } from "@/lib/focus-catalog";

/**
 * #61 — one streamed lo-fi track, served from this app's own origin.
 *
 * ## Why a proxy exists at all
 *
 * `next.config.ts` keeps `default-src 'self'` with `media-src`, `frame-src` and
 * `child-src` unset, so the browser refuses audio from anywhere but here. That is
 * a privacy property of the focus session rather than an accident of what got
 * built — a long, unattended, personal page view with no third-party media host
 * inside it — and `src/lib/security-headers.test.ts` fails on any relaxation.
 *
 * So the bytes take the long way round: the server fetches them from the
 * operator-configured store and streams them back through this route. The
 * alternative #61 rules out explicitly is pointing `<audio>` at the store, which
 * would need a `media-src` origin. A useful side effect is that any credential
 * the store requires stays server-side, which the issue also asks for.
 *
 * The ingress could route a path at the store instead and skip this hop. That is
 * a deployment-shaped answer to the same requirement and would work; this one was
 * chosen because it needs no ingress change, so the Compose self-host path and
 * the Kubernetes one get the feature from the same code.
 *
 * ## Range, and why it is the whole job
 *
 * `<audio>` will not offer a scrub bar without `Accept-Ranges`, and a seek is a
 * `Range` request whose `Content-Range` must survive the hop or playback silently
 * restarts from zero. Both are forwarded rather than reimplemented — the store
 * does the arithmetic — and proved over a real socket in
 * `src/lib/focus-catalog-source.test.ts`.
 *
 * ## The track name is a query parameter, deliberately
 *
 * `src/proxy.ts`'s matcher skips any path ending in an extension, so
 * `/api/focus-catalog/audio/foo.mp3` would bypass the middleware and with it the
 * guest session it mints — leaving every guest unable to play a streamed track,
 * for a reason nothing at the call site would explain.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A track is immutable for as long as its name is: the store holds one file per
 * filename and a re-upload is an operator action. A day is long enough to make
 * repeat sessions cheap and short enough that a corrected upload lands.
 * `private` because the route is behind a session — a shared cache holding the
 * response would serve it to callers who never passed the gate.
 */
const AUDIO_CACHE_CONTROL = "private, max-age=86400";

/**
 * Headers copied from the store's response, and nothing else.
 *
 * An allowlist rather than a copy-with-exclusions: relaying `Set-Cookie` would
 * let the store set cookies on THIS origin, and relaying its CORS headers would
 * let it decide who may read a response served from ours. Content-Type is
 * deliberately absent — it is pinned below rather than taken on trust.
 */
const PASSTHROUGH_HEADERS = [
  "Content-Length",
  "Content-Range",
  "Accept-Ranges",
  "ETag",
  "Last-Modified",
] as const;

function plain(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(req: Request): Promise<Response> {
  if (!(await hasSession())) return plain("Not signed in", 401);

  const track = new URL(req.url).searchParams.get(CATALOG_TRACK_PARAM);
  if (!track) return plain("No track requested", 400);

  const result = await fetchCatalogAudio(track, req.headers.get("range"), {
    // A listener who skips mid-download should not leave the pod pulling the
    // rest of the track from the store on nobody's behalf.
    signal: req.signal,
  });

  switch (result.status) {
    case "rejected":
    case "unconfigured":
    case "missing":
      // One answer for all three. From the player's side "this track is not
      // available here" is the whole of the truth, and telling a caller apart
      // which of the three it hit would map out the store's contents and its
      // configuration for them. The player already has the bundled ten.
      return plain("Track not found", 404);
    case "unavailable":
      // The failure detail can name the store's host, so it stays in the server
      // log and out of the body.
      return plain("The focus catalog is unavailable", 502);
  }

  const headers = new Headers({
    // Pinned, not copied: only `.mp3` names reach the store, so the type is
    // knowable here, and taking the store's word for it would let a mislabelled
    // object decide how the browser treats the bytes. `nosniff` closes the half
    // that a wrong-but-plausible type would still leave open.
    "Content-Type": "audio/mpeg",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": AUDIO_CACHE_CONTROL,
    // Stated even when the store forgot to: without it the browser assumes the
    // resource cannot be seeked and disables scrubbing entirely.
    "Accept-Ranges": "bytes",
  });
  for (const name of PASSTHROUGH_HEADERS) {
    const value = result.upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  // `upstream.body` is handed straight on, so a 3 MB track is never buffered
  // into the pod before its first byte reaches the browser. The status is
  // preserved too — a 206 that arrives as a 200 breaks seeking.
  return new Response(result.upstream.body, {
    status: result.upstream.status,
    headers,
  });
}
