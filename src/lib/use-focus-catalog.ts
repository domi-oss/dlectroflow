"use client";

import { useEffect, useState } from "react";
import { mergeFocusTracks, parseCatalogTracks } from "@/lib/focus-catalog";
import { FOCUS_SOUND_TRACKS } from "@/lib/focus-sounds";
import type { FocusTrack } from "@/lib/focus-sounds";

/**
 * #61 — the playlist the focus timer actually plays: the bundled ten, plus
 * whatever the streamed catalog adds.
 *
 * ## It is additive, and it never subtracts
 *
 * The first render returns `FOCUS_SOUND_TRACKS` ITSELF — same array, same
 * identity — so a session that starts before (or entirely without) the catalog
 * has music immediately. Anything that goes wrong afterwards leaves that array
 * exactly where it is: an unreachable store, a 502, a body that is not what it
 * claims. #61 asks that a focus session never start silent by accident, and the
 * cheapest way to keep that promise is for this hook to have no failure mode
 * that removes a track.
 *
 * ## One request per page load
 *
 * The settings picker and the in-timer mini-player can both be mounted, and both
 * want the same list. The in-flight promise is shared at module scope, so N
 * consumers cost one request. It is deliberately NOT re-fetched on remount: the
 * catalog changes when an operator re-uploads the store's contents, which a page
 * reload will pick up.
 *
 * ## The response is re-validated, not trusted
 *
 * It arrives same-origin, but it is assembled from a manifest this app does not
 * author, so it goes back through `parseCatalogTracks`, which ignores the `src`
 * it was sent and recomputes it from the track id. The client is the last place a
 * bad `src` could turn into a cross-origin request, and `default-src 'self'`
 * would then be the only thing standing between a hostile manifest and a
 * third-party media host.
 */

/**
 * The route this hook reads, as a literal.
 *
 * It cannot be `fetch(CATALOG_INDEX_PATH)`: `fetch-host-hygiene` (#83) resolves
 * only module-local `const` bindings, and an IMPORTED identifier reads as a
 * non-constant target — which would put a same-origin path into the reviewed
 * dynamic-host allowlist and dilute the one map that has to stay readable. So the
 * path is written out here and `use-focus-catalog.test.ts` asserts it still
 * equals `CATALOG_INDEX_PATH`, which is what stops the two drifting.
 */
export const CATALOG_ENDPOINT = "/api/focus-catalog";

/** The shared in-flight (then settled) fetch. Null until the first consumer. */
let pending: Promise<readonly FocusTrack[]> | null = null;

/** Drop the shared promise so each test starts from an unfetched state. */
export function _resetFocusCatalogForTest(): void {
  pending = null;
}

async function loadCatalog(): Promise<readonly FocusTrack[]> {
  try {
    const res = await fetch(CATALOG_ENDPOINT, {
      headers: { Accept: "application/json" },
    });
    // 502 (store down) and 200-with-nothing (no store configured) are the same
    // answer here: keep what we have.
    if (!res.ok) return FOCUS_SOUND_TRACKS;
    const body: unknown = await res.json();
    return mergeFocusTracks(FOCUS_SOUND_TRACKS, parseCatalogTracks(body));
  } catch {
    // Offline, a redeploy under an open tab, a body that is not JSON. None of
    // them is a reason to stop the music.
    return FOCUS_SOUND_TRACKS;
  }
}

export function useFocusCatalog(): readonly FocusTrack[] {
  const [tracks, setTracks] =
    useState<readonly FocusTrack[]>(FOCUS_SOUND_TRACKS);

  useEffect(() => {
    let live = true;
    pending ??= loadCatalog();
    void pending.then((loaded) => {
      // Two guards, both load-bearing. `live` keeps a resolved fetch from
      // updating a hook whose component has gone. The identity check keeps a
      // no-op result from re-rendering at all — `mergeFocusTracks` returns the
      // bundled array itself when the catalog added nothing, and a setState with
      // an equal-but-new array would re-deal the play order for no reason.
      if (!live || loaded === FOCUS_SOUND_TRACKS) return;
      setTracks(loaded);
    });
    return () => {
      live = false;
    };
  }, []);

  return tracks;
}
