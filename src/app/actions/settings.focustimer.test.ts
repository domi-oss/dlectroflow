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

describe("dismissFocusTimerTip", () => {
  it("stamps focusTimerTipDismissedAt with a Date", async () => {
    await dismissFocusTimerTip();
    const call = upsert.mock.calls[0][0];
    expect(call.where).toEqual({ workspaceId: "ws-1" });
    expect(call.update.focusTimerTipDismissedAt).toBeInstanceOf(Date);
  });
});
