import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #154 — the three actions behind the Settings card.
 *
 * Every assertion here is about the same property, and it is the same one
 * `account.ts` Rule 1 states: **none of these takes an id**, so the feed they
 * touch is the session's feed and there is nothing for a hand-rolled POST to
 * point at somebody else's. A server action is a public POST endpoint, so that
 * has to be structural rather than reviewed.
 */
const {
  currentUserMock,
  createOwnFeedMock,
  regenerateOwnFeedMock,
  disableOwnFeedMock,
  getOwnFeedMock,
  revalidateMock,
} = vi.hoisted(() => ({
  currentUserMock: vi.fn(),
  createOwnFeedMock: vi.fn(),
  regenerateOwnFeedMock: vi.fn(),
  disableOwnFeedMock: vi.fn(),
  getOwnFeedMock: vi.fn(),
  revalidateMock: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));
vi.mock("@/lib/workspace", () => ({ currentUser: currentUserMock }));
// `feedUrl` is the REAL one: "the action hands back an absolute URL built from
// PUBLIC_ORIGIN" is one of the things being tested, and a stub would make it
// pass whatever the action returned.
vi.mock("@/lib/calendar-feed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/calendar-feed")>();
  return {
    feedUrl: actual.feedUrl,
    createOwnFeed: createOwnFeedMock,
    regenerateOwnFeed: regenerateOwnFeedMock,
    disableOwnFeed: disableOwnFeedMock,
    getOwnFeed: getOwnFeedMock,
  };
});

import {
  createCalendarFeed,
  regenerateCalendarFeed,
  disableCalendarFeed,
} from "./calendar-feed";

const ME = "user_alice";
const TOKEN = "T".repeat(43);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PUBLIC_ORIGIN = "https://dlectroflow.dev";
  currentUserMock.mockResolvedValue({ id: ME, role: "member" });
  createOwnFeedMock.mockResolvedValue({ token: TOKEN });
  regenerateOwnFeedMock.mockResolvedValue({ token: TOKEN });
  getOwnFeedMock.mockResolvedValue({ token: TOKEN });
});

describe("createCalendarFeed (#154)", () => {
  it("returns the absolute URL a person pastes into their calendar", async () => {
    await expect(createCalendarFeed()).resolves.toEqual({
      ok: true,
      url: `https://dlectroflow.dev/api/ics/feed/${TOKEN}`,
    });
  });

  it("acts on the SESSION's account and takes no id", async () => {
    await createCalendarFeed();
    expect(createOwnFeedMock).toHaveBeenCalledWith(ME);
    // The arity is the guarantee: an argument that does not exist cannot be
    // forged, and cannot be dropped by a later refactor the way a check can.
    expect(createCalendarFeed).toHaveLength(0);
  });

  it("ignores an id passed anyway", async () => {
    await (createCalendarFeed as unknown as (id: string) => Promise<unknown>)(
      "user_mallory",
    );
    expect(createOwnFeedMock).toHaveBeenCalledWith(ME);
  });

  it("refuses a caller with no account", async () => {
    // A guest sandbox expires in about a day, so a subscription that outlives
    // it would be a URL that silently stops working. Guests have the per-task
    // download and the data export instead.
    currentUserMock.mockResolvedValue(null);
    await expect(createCalendarFeed()).resolves.toEqual({
      ok: false,
      error: "not_signed_in",
    });
    expect(createOwnFeedMock).not.toHaveBeenCalled();
  });

  it("invalidates the settings page it just changed", async () => {
    await createCalendarFeed();
    expect(revalidateMock).toHaveBeenCalledWith("/settings");
  });
});

describe("regenerateCalendarFeed (#154)", () => {
  it("returns the new URL", async () => {
    regenerateOwnFeedMock.mockResolvedValue({ token: "N".repeat(43) });
    await expect(regenerateCalendarFeed()).resolves.toEqual({
      ok: true,
      url: `https://dlectroflow.dev/api/ics/feed/${"N".repeat(43)}`,
    });
  });

  it("rotates rather than creating, and takes no id", async () => {
    await regenerateCalendarFeed();
    expect(regenerateOwnFeedMock).toHaveBeenCalledWith(ME);
    expect(createOwnFeedMock).not.toHaveBeenCalled();
    expect(regenerateCalendarFeed).toHaveLength(0);
  });

  it("refuses a caller with no account", async () => {
    currentUserMock.mockResolvedValue(null);
    await expect(regenerateCalendarFeed()).resolves.toEqual({
      ok: false,
      error: "not_signed_in",
    });
    expect(regenerateOwnFeedMock).not.toHaveBeenCalled();
  });

  it("invalidates the settings page", async () => {
    await regenerateCalendarFeed();
    expect(revalidateMock).toHaveBeenCalledWith("/settings");
  });
});

describe("disableCalendarFeed (#154)", () => {
  it("turns the feed off for the session's account and takes no id", async () => {
    await expect(disableCalendarFeed()).resolves.toEqual({ ok: true });
    expect(disableOwnFeedMock).toHaveBeenCalledWith(ME);
    expect(disableCalendarFeed).toHaveLength(0);
  });

  it("refuses a caller with no account", async () => {
    currentUserMock.mockResolvedValue(null);
    await expect(disableCalendarFeed()).resolves.toEqual({
      ok: false,
      error: "not_signed_in",
    });
    expect(disableOwnFeedMock).not.toHaveBeenCalled();
  });

  it("invalidates the settings page", async () => {
    await disableCalendarFeed();
    expect(revalidateMock).toHaveBeenCalledWith("/settings");
  });
});
