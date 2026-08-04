/**
 * #61 — the catalog's I/O half: read the manifest, and open a byte stream for
 * one track. Server-side only.
 *
 * `focus-catalog.ts` is the pure counterpart (parsing, validation, URL building)
 * and is safe in a browser bundle. Everything that touches `process.env` or the
 * network lives here, so nothing in this file may be imported from a client
 * component — that separation is also what keeps any store credential
 * server-side, which is one of #61's stated requirements.
 *
 * ── Why a proxy and not a public bucket URL ─────────────────────────────────
 *
 * `default-src 'self'` with `media-src` unset means the browser refuses audio
 * from anywhere but this app (`src/lib/security-headers.test.ts` fails on any
 * relaxation). Handing the `<audio>` element a store URL would need a
 * `media-src` origin, so the server fetches the bytes and streams them back
 * instead. The cost of that choice is this file: range forwarding, timeouts and
 * upstream error mapping all become ours, and are tested over a real socket in
 * `focus-catalog-source.test.ts`.
 *
 * ── Outbound-request posture (#83) ──────────────────────────────────────────
 *
 * The host is operator configuration — `FOCUS_CATALOG_ORIGIN`, the same class of
 * knob as `LLM_BASE_URL` — never request input. The one request-derived value is
 * a track filename, which is allow-listed by shape and percent-encoded into a
 * single path segment before it is appended to a base whose authority is already
 * closed, so it can only ever extend the path. Both call sites carry a written
 * entry in `REVIEWED_DYNAMIC_HOSTS` (`src/lib/fetch-host-hygiene.test.ts`).
 */

import {
  catalogFileUrl,
  catalogIndexUrl,
  isSafeCatalogFilename,
  parseCatalog,
  resolveCatalogBase,
} from "@/lib/focus-catalog";
import type { FocusTrack } from "@/lib/focus-sounds";

/** The variable an operator sets to point the app at a catalog. */
export const CATALOG_ORIGIN_ENV = "FOCUS_CATALOG_ORIGIN";

/** How long to wait for the manifest before giving up and staying bundled. */
const MANIFEST_TIMEOUT_MS = 5_000;

/**
 * How long to wait for a track's RESPONSE HEADERS.
 *
 * Deliberately not a whole-request deadline: the body is a stream, and a single
 * timer covering it would truncate a long download into a corrupt track. The
 * timer is cleared the moment headers arrive; from then on the stream is bounded
 * by the client's own connection, which is what cancels it when a listener
 * skips.
 */
const AUDIO_HEADER_TIMEOUT_MS = 10_000;

/**
 * Most bytes a manifest may be. It is `JSON.parse`d into memory, so unlike the
 * audio path there is nothing to stream around. open-lofi's 166-track
 * `catalog.json` is roughly 20 KB, so this is three orders of magnitude of head
 * room and still a bound.
 */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/**
 * A single byte range, the only form forwarded upstream.
 *
 * `bytes=0-`, `bytes=100-199` and the suffix form `bytes=-500` are what a media
 * element actually sends. A multi-range request would come back as
 * `multipart/byteranges`, which this proxy does not reassemble, so anything else
 * is dropped rather than passed on — see `sanitiseRange`.
 */
const SINGLE_BYTE_RANGE = /^bytes=(?:\d+-\d*|-\d+)$/;

/** The normalised catalog base, or null when no store is configured. */
export function catalogBase(): string | null {
  return resolveCatalogBase(process.env.FOCUS_CATALOG_ORIGIN);
}

export type CatalogResult =
  | { status: "unconfigured" }
  | { status: "ok"; tracks: FocusTrack[] }
  | { status: "unavailable"; reason: string };

export type AudioResult =
  | { status: "unconfigured" }
  /** The filename is not one this proxy will ask for. Never leaves the pod. */
  | { status: "rejected" }
  /** The store answered, and does not have it. */
  | { status: "missing" }
  | { status: "unavailable"; reason: string }
  | { status: "ok"; upstream: Response };

/**
 * The Range header to forward, or null to ask for the whole file.
 *
 * A header the store might answer with 416 turns a playable track into a broken
 * one, so anything unrecognised is dropped rather than relayed.
 */
export function sanitiseRange(range: string | null | undefined): string | null {
  if (typeof range !== "string") return null;
  const trimmed = range.trim();
  return SINGLE_BYTE_RANGE.test(trimmed) ? trimmed : null;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Thrown when a URL that is not under the configured base reaches the one
 *  outbound call site. Exported so the test can assert on the type. */
export class NotUnderCatalogBaseError extends Error {
  constructor(url: string) {
    super(`refusing to fetch ${url}: not under the configured catalog base`);
    this.name = "NotUnderCatalogBaseError";
  }
}

/**
 * The single outbound call site, with a deadline covering the RESPONSE HEADERS
 * only.
 *
 * ── The prefix check is the point, not a formality ──────────────────────────
 * `fetch-host-hygiene` cannot prove this target constant — the host comes from
 * `FOCUS_CATALOG_ORIGIN` — so it carries a written `REVIEWED_DYNAMIC_HOSTS`
 * entry. `url.startsWith(base)` is what makes that entry honest rather than a
 * promise: whatever a present or future caller passes, this function will only
 * ever open a connection to the operator-configured store. The reviewed entry
 * then covers one enforced property instead of one trusted caller.
 *
 * ── The timer ───────────────────────────────────────────────────────────────
 * `AbortSignal.timeout()` would abort the body stream too, which is fine for a
 * manifest and wrong for a 3 MB track. So the timer is owned here and cleared as
 * soon as `fetch` resolves — which, in Node's fetch, is when the headers land.
 *
 * `redirect: "error"` because the store's location is operator configuration: a
 * 3xx would move the request to a host nobody configured, which is exactly the
 * property the outbound-host guard exists to preserve. `cache: "no-store"`
 * because Next patches the global `fetch` and its Data Cache has no business
 * holding audio.
 */
export async function fetchFromStore(
  base: string,
  url: string,
  init: { headers?: HeadersInit; timeoutMs: number; signal?: AbortSignal },
): Promise<Response> {
  if (!url.startsWith(base)) throw new NotUnderCatalogBaseError(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  try {
    return await fetch(url, {
      headers: init.headers,
      signal,
      redirect: "error",
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Read a response body as text, refusing to buffer more than `max` bytes. */
async function readTextCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    throw new Error(`manifest declares ${declared} bytes, over the ${max} cap`);
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`manifest exceeded the ${max} byte cap`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Read `catalog.json` from the configured store.
 *
 * Never throws and never rejects: an unreachable store is a normal, expected
 * state (nobody has configured one yet, or it is having a bad day), and the
 * caller's answer to all of it is the same — keep playing the bundled tracks.
 * The distinction between "unconfigured" and "unavailable" is kept because only
 * one of them is worth an operator's attention.
 */
export async function fetchCatalogTracks(
  opts: { timeoutMs?: number } = {},
): Promise<CatalogResult> {
  const base = catalogBase();
  if (!base) return { status: "unconfigured" };

  try {
    const res = await fetchFromStore(base, catalogIndexUrl(base), {
      headers: { Accept: "application/json" },
      timeoutMs: opts.timeoutMs ?? MANIFEST_TIMEOUT_MS,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return unavailableCatalog(`the store answered ${res.status}`);
    }
    const text = await readTextCapped(res, MAX_MANIFEST_BYTES);
    return { status: "ok", tracks: parseCatalog(JSON.parse(text)) };
  } catch (err) {
    return unavailableCatalog(describe(err));
  }
}

/**
 * One structured, greppable line per manifest failure.
 *
 * Logged HERE and not on the audio path on purpose: the manifest is read once
 * per client session, while a single track can produce a dozen range requests,
 * and a log line per range would bury the one event that explains all of them.
 * Same shape as `recordLLMFailure` — a silent degradation to the bundled ten is
 * indistinguishable from normal operation otherwise, which is the failure mode
 * #147 is about.
 */
function unavailableCatalog(reason: string): CatalogResult {
  try {
    console.warn(
      JSON.stringify({
        tag: "focus_catalog_unavailable",
        reason,
        ts: new Date().toISOString(),
      }),
    );
  } catch {
    // Observability must never take the request down with it.
  }
  return { status: "unavailable", reason };
}

/**
 * Open a byte stream for one track.
 *
 * Returns the upstream `Response` rather than its bytes so the caller can hand
 * `upstream.body` straight to the browser: a 3 MB track must never be buffered
 * into the pod before the first byte is served.
 *
 * Only the Range header is relayed. Nothing else the client sent — cookies,
 * `Authorization`, `Referer` — is forwarded to the store, so a browser cannot
 * use this route to speak to it on its own behalf.
 */
export async function fetchCatalogAudio(
  filename: string,
  range: string | null,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<AudioResult> {
  if (!isSafeCatalogFilename(filename)) return { status: "rejected" };
  const base = catalogBase();
  if (!base) return { status: "unconfigured" };

  const forwarded = sanitiseRange(range);
  const headers: Record<string, string> = { Accept: "audio/mpeg" };
  if (forwarded) headers.Range = forwarded;

  try {
    const res = await fetchFromStore(base, catalogFileUrl(base, filename), {
      headers,
      timeoutMs: opts.timeoutMs ?? AUDIO_HEADER_TIMEOUT_MS,
      signal: opts.signal,
    });
    if (res.status === 404 || res.status === 403 || res.status === 410) {
      // 403 sits with 404 deliberately: a store that hides what it does not
      // want listed answers either way, and both mean "not a track you can
      // have" rather than "the store is broken".
      await res.body?.cancel();
      return { status: "missing" };
    }
    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel();
      return {
        status: "unavailable",
        reason: `the store answered ${res.status}`,
      };
    }
    return { status: "ok", upstream: res };
  } catch (err) {
    return { status: "unavailable", reason: describe(err) };
  }
}
