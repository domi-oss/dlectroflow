// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import {
  CATALOG_ENDPOINT,
  useFocusCatalog,
  _resetFocusCatalogForTest,
} from "./use-focus-catalog";
import { CATALOG_INDEX_PATH } from "./focus-catalog";
import { FOCUS_SOUND_TRACKS } from "./focus-sounds";

const CATALOG_BODY = {
  source: "catalog",
  tracks: [
    {
      id: "catalog:paper-cranes.mp3",
      title: "Paper Cranes",
      category: "chillhop",
      categoryLabel: "Chillhop",
      src: "/api/focus-catalog/audio?track=paper-cranes.mp3",
    },
    {
      id: "catalog:bell-field.mp3",
      title: "Bell Field",
      category: "hybrid",
      categoryLabel: "Hybrid / world",
      src: "/api/focus-catalog/audio?track=bell-field.mp3",
    },
  ],
};

const fetchMock = vi.fn();

function respond(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

beforeEach(() => {
  _resetFocusCatalogForTest();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(respond(CATALOG_BODY));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useFocusCatalog", () => {
  it("hands back the bundled tracks on the very first render", () => {
    // Before anything is fetched, and by identity — useFocusSound re-deals its
    // play order whenever the track list changes, so an unresolved catalog must
    // not look like a change.
    const { result } = renderHook(() => useFocusCatalog());
    expect(result.current).toBe(FOCUS_SOUND_TRACKS);
  });

  it("asks the route the API is actually served on", async () => {
    renderHook(() => useFocusCatalog());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe(CATALOG_INDEX_PATH);
    // The literal in the hook and the constant the route is mounted at must not
    // drift; the guard on `fetch()` targets means the hook cannot import one.
    expect(CATALOG_ENDPOINT).toBe(CATALOG_INDEX_PATH);
  });

  it("grows the playlist once the catalog arrives, bundled tracks first", async () => {
    const { result } = renderHook(() => useFocusCatalog());
    await waitFor(() =>
      expect(result.current.length).toBe(FOCUS_SOUND_TRACKS.length + 2),
    );
    expect(result.current.slice(0, FOCUS_SOUND_TRACKS.length)).toEqual([
      ...FOCUS_SOUND_TRACKS,
    ]);
    expect(result.current.at(-1)?.title).toBe("Bell Field");
  });

  it("keeps every track same-origin", async () => {
    const { result } = renderHook(() => useFocusCatalog());
    await waitFor(() =>
      expect(result.current.length).toBeGreaterThan(FOCUS_SOUND_TRACKS.length),
    );
    for (const track of result.current) {
      expect(track.src.startsWith("/"), track.src).toBe(true);
      expect(track.src.startsWith("//"), track.src).toBe(false);
    }
  });

  it("re-validates what the route returned rather than trusting it", async () => {
    // The response is same-origin, but it is assembled from a manifest this app
    // does not author, and the client is the last place a bad `src` could turn
    // into a cross-origin request.
    fetchMock.mockResolvedValue(
      respond({
        source: "catalog",
        tracks: [
          {
            id: "catalog:../../x",
            title: "Escapes the prefix",
            category: "activities",
            categoryLabel: "Activities",
            src: "/api/focus-catalog/audio?track=..%2F..%2Fx",
          },
          {
            id: "paper-cranes.mp3",
            title: "Unprefixed id",
            category: "chillhop",
            categoryLabel: "Chillhop",
            src: "/api/focus-catalog/audio?track=paper-cranes.mp3",
          },
          {
            id: "catalog:fine.mp3",
            title: "Offsite src",
            category: "activities",
            categoryLabel: "Activities",
            src: "https://evil.test/x.mp3",
          },
        ],
      }),
    );
    const { result } = renderHook(() => useFocusCatalog());
    await waitFor(() =>
      expect(result.current.length).toBe(FOCUS_SOUND_TRACKS.length + 1),
    );
    // The two malformed ids are gone, and the survivor's src was recomputed from
    // its id rather than taken from the response.
    expect(result.current.at(-1)?.title).toBe("Offsite src");
    expect(result.current.at(-1)?.src).toBe(
      "/api/focus-catalog/audio?track=fine.mp3",
    );
  });

  it("stays on the bundled tracks when the route says the store is down", async () => {
    fetchMock.mockResolvedValue(
      respond({ source: "unavailable", tracks: [] }, { status: 502 }),
    );
    const { result } = renderHook(() => useFocusCatalog());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current).toBe(FOCUS_SOUND_TRACKS);
  });

  it("stays on the bundled tracks when the request itself fails", async () => {
    // Offline, or the app is being redeployed underneath the open tab. A focus
    // session must not go silent for it.
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useFocusCatalog());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current).toBe(FOCUS_SOUND_TRACKS);
  });

  it("stays on the bundled tracks when the body is not what it should be", async () => {
    for (const body of [null, "nope", { tracks: "no" }, {}]) {
      _resetFocusCatalogForTest();
      fetchMock.mockResolvedValue(respond(body));
      const { result } = renderHook(() => useFocusCatalog());
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(result.current, JSON.stringify(body)).toBe(FOCUS_SOUND_TRACKS);
    }
  });

  it("survives a response that is not JSON at all", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>proxy error</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const { result } = renderHook(() => useFocusCatalog());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current).toBe(FOCUS_SOUND_TRACKS);
  });

  it("fetches once however many players are on the page", async () => {
    // The settings picker and the in-timer mini-player can both be mounted.
    const a = renderHook(() => useFocusCatalog());
    const b = renderHook(() => useFocusCatalog());
    await waitFor(() =>
      expect(a.result.current.length).toBeGreaterThan(
        FOCUS_SOUND_TRACKS.length,
      ),
    );
    await waitFor(() =>
      expect(b.result.current.length).toBeGreaterThan(
        FOCUS_SOUND_TRACKS.length,
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not update a hook that has already unmounted", async () => {
    let release: ((value: Response) => void) | undefined;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const { unmount } = renderHook(() => useFocusCatalog());
    unmount();
    release?.(respond(CATALOG_BODY));
    // A setState on an unmounted hook logs a React warning rather than throwing,
    // so assert on the console instead of on the absence of a crash.
    const error = vi.spyOn(console, "error");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
