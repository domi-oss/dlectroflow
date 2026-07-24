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

import { updateAppearanceSettings } from "@/app/actions/settings";

beforeEach(() => vi.clearAllMocks());

describe("updateAppearanceSettings", () => {
  it("persists a boolean strike + an allowlisted tick colour + typeface", async () => {
    await updateAppearanceSettings({
      completeStrikethrough: false,
      completeTickColor: "black",
      typeface: "opendyslexic",
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "ws-1" },
        update: {
          completeStrikethrough: false,
          completeTickColor: "black",
          typeface: "opendyslexic",
        },
      }),
    );
  });

  it("coerces an out-of-set tick colour back to green (mirrors the CHECK)", async () => {
    await updateAppearanceSettings({
      completeStrikethrough: true,
      completeTickColor: "purple",
      typeface: "atkinson",
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          completeStrikethrough: true,
          completeTickColor: "green",
          typeface: "atkinson",
        },
      }),
    );
  });

  it("coerces an out-of-set typeface back to figtree (mirrors the CHECK)", async () => {
    await updateAppearanceSettings({
      completeStrikethrough: true,
      completeTickColor: "green",
      typeface: "comic-sans",
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ typeface: "figtree" }),
      }),
    );
  });

  it("defaults typeface to figtree when omitted", async () => {
    await updateAppearanceSettings({
      completeStrikethrough: true,
      completeTickColor: "green",
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ typeface: "figtree" }),
      }),
    );
  });
});
