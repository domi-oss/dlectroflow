import { describe, it, expect, vi, beforeEach } from "vitest";

const { upsert, currentWorkspaceIdMock, isOwnerRequestMock } = vi.hoisted(
  () => ({
    upsert: vi.fn().mockResolvedValue(undefined),
    currentWorkspaceIdMock: vi.fn().mockResolvedValue("ws-1"),
    isOwnerRequestMock: vi.fn().mockResolvedValue(true),
  }),
);
vi.mock("@/lib/db", () => ({ prisma: { settings: { upsert } } }));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  isOwnerRequest: isOwnerRequestMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  updateFocusTimerSettings,
  dismissFocusTimerTip,
  updateFocusShuffle,
  updateFocusSoundCategories,
} from "@/app/actions/settings";

beforeEach(() => vi.clearAllMocks());

describe("updateFocusTimerSettings", () => {
  it("persists an allowlisted style + sound and coerces the booleans", async () => {
    await updateFocusTimerSettings({
      timerStyle: "mug",
      minimalMode: true,
      keepAwake: false,
      alarmEnabled: true,
      sound: "on",
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "ws-1" },
        update: {
          focusTimerStyle: "mug",
          focusMinimalMode: true,
          focusKeepAwake: false,
          focusAlarmEnabled: true,
          focusSound: "on",
          focusPauseTogether: false,
        },
      }),
    );
  });

  // #180 — the category selection is an array now, written only when the caller
  // actually supplies one. These four cover the whole contract, and three of them
  // are reversals of what #70 did.
  it("stores an allowlisted selection in catalogue order, without duplicates", async () => {
    await updateFocusTimerSettings({
      timerStyle: "ring",
      minimalMode: false,
      keepAwake: true,
      alarmEnabled: true,
      sound: "on",
      // Reverse catalogue order, with a repeat: one selection must have exactly
      // one stored spelling, or two rows that mean the same thing look different.
      categories: ["jazzhop", "chillhop", "jazzhop"],
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          focusSound: "on",
          focusSoundCategories: ["chillhop", "jazzhop"],
        }),
        create: expect.objectContaining({
          focusSoundCategories: ["chillhop", "jazzhop"],
        }),
      }),
    );
  });

  it("drops an out-of-set slug rather than failing the write (mirrors the containment CHECK)", async () => {
    // `ambient` is the slug #70's own description carried before it was corrected
    // against the code, so it is the realistic bad value rather than an invented
    // one. `lofi_chillhop` is the paired mistake: a track id in the category slot,
    // which #180 makes likelier because a track id has no persistable home now.
    await updateFocusTimerSettings({
      timerStyle: "ring",
      minimalMode: false,
      keepAwake: true,
      alarmEnabled: true,
      sound: "on",
      categories: ["ambient", "lofi_chillhop", "category:chillhop", "chillhop"],
    });
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          focusSoundCategories: ["chillhop"],
        }),
      }),
    );
  });

  // The behaviour the Settings switch depends on. Omitting the key must leave the
  // stored selection alone: the switch is the only music control on that page, so
  // treating "not mentioned" as "empty it" would wipe a playlist on every toggle.
  it("does not touch the selection when the caller omits it", async () => {
    await updateFocusTimerSettings({
      timerStyle: "ring",
      minimalMode: false,
      keepAwake: true,
      alarmEnabled: true,
      sound: "off",
    });
    const [call] = upsert.mock.calls.at(-1) as [
      { update: Record<string, unknown>; create: Record<string, unknown> },
    ];
    expect(call.update).not.toHaveProperty("focusSoundCategories");
    expect(call.create).not.toHaveProperty("focusSoundCategories");
  });

  // Deliberately UNLIKE #70, where "off" cleared the category because they were
  // options in one radio group. They are two independent controls on two surfaces
  // now, and keeping the playlist through a silent spell is what makes the switch
  // reversible.
  it("keeps the selection when the sound is switched off", async () => {
    await updateFocusTimerSettings({
      timerStyle: "ring",
      minimalMode: false,
      keepAwake: true,
      alarmEnabled: true,
      sound: "off",
      categories: ["chillhop"],
    });
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          focusSound: "off",
          focusSoundCategories: ["chillhop"],
        }),
      }),
    );
  });

  it("stores an explicitly empty selection as the whole catalogue", async () => {
    await updateFocusTimerSettings({
      timerStyle: "ring",
      minimalMode: false,
      keepAwake: true,
      alarmEnabled: true,
      sound: "on",
      categories: [],
    });
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ focusSoundCategories: [] }),
      }),
    );
  });

  it("keeps a null style (null → voice default) and does not coerce it away", async () => {
    await updateFocusTimerSettings({
      timerStyle: null,
      minimalMode: false,
      keepAwake: true,
      alarmEnabled: true,
      sound: "off",
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ focusTimerStyle: null }),
      }),
    );
  });

  it("coerces an out-of-set style to null and an out-of-set sound to off (mirrors the CHECKs)", async () => {
    // `lofi_calm` is the interesting one: it was a legal focusSound value until
    // #180 narrowed the column, so a stale caller sending it must land on "off"
    // rather than writing a value Settings_focusSound_check now rejects.
    for (const sound of ["spotify", "lofi_calm"]) {
      await updateFocusTimerSettings({
        timerStyle: "hourglass",
        minimalMode: false,
        keepAwake: true,
        alarmEnabled: false,
        sound,
      });
      expect(upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            focusTimerStyle: null,
            focusSound: "off",
          }),
        }),
      );
    }
    await updateFocusTimerSettings({
      timerStyle: "hourglass",
      minimalMode: false,
      keepAwake: true,
      alarmEnabled: false,
      sound: "spotify",
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          focusTimerStyle: null,
          focusSound: "off",
        }),
      }),
    );
  });

  // #65 — the music↔timer pause coupling. A plain Boolean column (the
  // focusShuffle precedent), so coercion is the only validation it needs, and
  // it must default OFF: the coupling stops the timer, which nobody who only
  // wanted to silence their music should get by accident.
  it("persists the pause-together coupling when asked for", async () => {
    await updateFocusTimerSettings({
      timerStyle: "ring",
      minimalMode: false,
      keepAwake: true,
      alarmEnabled: true,
      sound: "lofi_calm",
      pauseTogether: true,
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ focusPauseTogether: true }),
        create: expect.objectContaining({ focusPauseTogether: true }),
      }),
    );
  });

  it("defaults to false when omitted; coerces any truthy junk to a real boolean (NOT NULL column)", async () => {
    await updateFocusTimerSettings({
      timerStyle: "ring",
      minimalMode: false,
      keepAwake: true,
      alarmEnabled: true,
      sound: "lofi_calm",
    });
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ focusPauseTogether: false }),
      }),
    );
    await updateFocusTimerSettings({
      timerStyle: "ring",
      minimalMode: false,
      keepAwake: true,
      alarmEnabled: true,
      sound: "lofi_calm",
      pauseTogether: "yes" as unknown as boolean,
    });
    // Truthy junk still coerces to a real boolean — the column is NOT NULL.
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ focusPauseTogether: true }),
      }),
    );
  });
});

/**
 * #252 — the header's focus-timer shortcut, and the one place this action's
 * optional fields are NOT all the same shape.
 *
 * `pauseTogether` coerces unconditionally, so omitting it writes `false`. That is
 * argued for where it is written: `false` is the column default too, so an
 * omission lands on the value a fresh row would have had.
 *
 * `focusQuickAccess` defaults **true**, which inverts the argument. Coercing an
 * omission would write `false` — a silent move AWAY from the default, and the one
 * a stale client bundle calling the previous deploy's payload shape would make on
 * somebody who never touched the setting. So it follows `categories` instead: an
 * absent key leaves the stored value alone. The difference between the two fields
 * is the column default and nothing else.
 */
describe("updateFocusTimerSettings — the quick-access gate (#252)", () => {
  const base = {
    timerStyle: "ring",
    minimalMode: false,
    keepAwake: true,
    alarmEnabled: true,
    sound: "on",
  } as const;

  it("persists the gate in both directions when it is supplied", async () => {
    for (const quickAccess of [true, false]) {
      upsert.mockClear();
      await updateFocusTimerSettings({ ...base, quickAccess });
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ focusQuickAccess: quickAccess }),
          create: expect.objectContaining({ focusQuickAccess: quickAccess }),
        }),
      );
    }
  });

  // The property that matters: an omission must not be a write. Turning the
  // header shortcut off is a decision, and nobody makes it by changing the timer
  // style from a browser holding last week's bundle.
  it("does not write the column at all when it is omitted", async () => {
    await updateFocusTimerSettings(base);
    const call = upsert.mock.calls[0][0];
    expect(call.update).not.toHaveProperty("focusQuickAccess");
    expect(call.create).not.toHaveProperty("focusQuickAccess");
  });

  it("coerces truthy junk to a real boolean — the column is NOT NULL", async () => {
    await updateFocusTimerSettings({
      ...base,
      quickAccess: "yes" as unknown as boolean,
    });
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ focusQuickAccess: true }),
      }),
    );
  });
});

describe("updateFocusShuffle (#68)", () => {
  it("persists the shuffle preference for the current workspace", async () => {
    await updateFocusShuffle(true);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "ws-1" },
        create: expect.objectContaining({
          workspaceId: "ws-1",
          focusShuffle: true,
        }),
        update: { focusShuffle: true },
      }),
    );
  });

  it("coerces a non-boolean to a boolean (the column is NOT NULL)", async () => {
    await updateFocusShuffle(undefined as unknown as boolean);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { focusShuffle: false } }),
    );
  });

  it("is not owner-gated — a guest workspace keeps its own taste setting", async () => {
    isOwnerRequestMock.mockResolvedValueOnce(false);
    await updateFocusShuffle(true);
    expect(upsert).toHaveBeenCalled();
  });
});

/**
 * #181 — the playlist tick-list writes from the PLAYER, mid-session.
 *
 * It gets its own action rather than reusing `updateFocusTimerSettings`, which
 * the issue's wording suggested. That action takes five other focus preferences
 * and writes every one of them, so calling it from the player would mean posting
 * a snapshot of the timer style, minimal mode, keep-awake, the alarm and the
 * sound switch as they were when the page loaded — reverting anything changed on
 * the Settings page in another tab since. `updateFocusShuffle` is the precedent:
 * a player-side control that owns exactly its own column.
 */
describe("updateFocusSoundCategories (#181)", () => {
  it("stores the selection in catalogue order, deduplicated", async () => {
    await updateFocusSoundCategories(["jazzhop", "chillhop", "jazzhop"]);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "ws-1" },
        create: expect.objectContaining({
          workspaceId: "ws-1",
          focusSoundCategories: ["chillhop", "jazzhop"],
        }),
        update: { focusSoundCategories: ["chillhop", "jazzhop"] },
      }),
    );
  });

  it("drops a slug the CHECK constraint would refuse rather than failing the write", async () => {
    // Same rule as updateFocusTimerSettings: a retired or manifest-invented slug
    // shrinks the selection instead of rejecting the whole tick.
    await updateFocusSoundCategories(["chillhop", "wind-chimes"]);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { focusSoundCategories: ["chillhop"] },
      }),
    );
  });

  it("stores the empty array for 'All tracks' — the one way to say the whole catalogue", async () => {
    await updateFocusSoundCategories([]);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { focusSoundCategories: [] } }),
    );
  });

  it("treats a missing or non-array argument as the empty selection", async () => {
    // The column is NOT NULL, so there is no value of this the DB would take
    // other than an array.
    await updateFocusSoundCategories(undefined as unknown as readonly string[]);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { focusSoundCategories: [] } }),
    );
  });

  it("writes nothing but its own column", async () => {
    await updateFocusSoundCategories(["chillhop"]);
    expect(Object.keys(upsert.mock.calls[0][0].update)).toEqual([
      "focusSoundCategories",
    ]);
  });

  it("is not owner-gated — a guest workspace picks its own playlists", async () => {
    isOwnerRequestMock.mockResolvedValueOnce(false);
    await updateFocusSoundCategories(["chillhop"]);
    expect(upsert).toHaveBeenCalled();
  });
});

describe("dismissFocusTimerTip", () => {
  it("stamps focusTimerTipDismissedAt with a Date", async () => {
    await dismissFocusTimerTip();
    const call = upsert.mock.calls[0][0];
    expect(call.where).toEqual({ workspaceId: "ws-1" });
    expect(call.update.focusTimerTipDismissedAt).toBeInstanceOf(Date);
  });
});
