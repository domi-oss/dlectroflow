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
      sound: "lofi_calm",
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "ws-1" },
        update: {
          focusTimerStyle: "mug",
          focusMinimalMode: true,
          focusKeepAwake: false,
          focusAlarmEnabled: true,
          focusSound: "lofi_calm",
          focusSoundCategory: null,
          focusPauseTogether: false,
        },
      }),
    );
  });

  // #70 — the category playlist. A separate nullable column rather than a
  // `category:*` value in focusSound, so both facts survive: which category is
  // the playlist, and which track the session opens on.
  it("persists an allowlisted category alongside the start track", async () => {
    await updateFocusTimerSettings({
      timerStyle: "ring",
      minimalMode: false,
      keepAwake: true,
      alarmEnabled: true,
      sound: "lofi_chillhop",
      category: "chillhop",
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          focusSound: "lofi_chillhop",
          focusSoundCategory: "chillhop",
        }),
        create: expect.objectContaining({ focusSoundCategory: "chillhop" }),
      }),
    );
  });

  it("coerces an out-of-set category to null (mirrors Settings_focusSoundCategory_check)", async () => {
    // `ambient` is the slug #70's own description carried before it was corrected
    // against the code, so it is the realistic bad value rather than an invented
    // one. `lofi_chillhop` is the paired mistake: a track id in the category slot.
    for (const category of ["ambient", "lofi_chillhop", "category:chillhop"]) {
      await updateFocusTimerSettings({
        timerStyle: "ring",
        minimalMode: false,
        keepAwake: true,
        alarmEnabled: true,
        sound: "lofi_chillhop",
        category,
      });
      expect(upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ focusSoundCategory: null }),
        }),
      );
    }
  });

  it("clears the category when the sound is off — the pair has no meaning", async () => {
    // Unlike focusShuffle / focusPauseTogether, which are orthogonal tastes left
    // inert while sound is off, the category IS part of the sound selection: it
    // and "off" are options in the same radio group, so choosing one replaces the
    // other. Storing (off, chillhop) would leave a state the picker cannot show.
    await updateFocusTimerSettings({
      timerStyle: "ring",
      minimalMode: false,
      keepAwake: true,
      alarmEnabled: true,
      sound: "off",
      category: "chillhop",
    });
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          focusSound: "off",
          focusSoundCategory: null,
        }),
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
