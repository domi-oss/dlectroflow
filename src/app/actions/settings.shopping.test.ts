/**
 * #199 — action test for `updateShoppingList`, the on/off switch behind
 * shopping-list mode.
 *
 * A plain Boolean column, so coercion is the only validation it needs (the
 * `focusShuffle` / `updateFirstRunPreview` precedent). What is worth pinning is
 * the two paths this switch controls: the SHELL has to be invalidated as well as
 * the settings page, because the menu entry is rendered by the app layout — a
 * revalidation of `/settings` alone would flip the checkbox and leave the menu
 * showing the previous state until the next full navigation.
 *
 * Its own file rather than an addition to `settings.test.ts`, matching
 * `settings.appearance.test.ts` and `settings.focustimer.test.ts`: that file mocks
 * the guest/owner machinery for the roundup guard, and this switch has no owner
 * gate at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(
  () => ({
    prismaMock: { settings: { upsert: vi.fn().mockResolvedValue({}) } },
    revalidatePathMock: vi.fn(),
    currentWorkspaceIdMock: vi.fn().mockResolvedValue("ws-1"),
  }),
);
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/workspace-kind", () => ({
  isGuestWorkspace: () => Promise.resolve(false),
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  isOwnerRequest: vi.fn().mockResolvedValue(true),
}));

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("ws-1");
});

describe("updateShoppingList", () => {
  it("turns the feature on for the resolved workspace", async () => {
    const { updateShoppingList } = await import("./settings");
    await updateShoppingList(true);
    expect(prismaMock.settings.upsert).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      create: { id: "ws-1", workspaceId: "ws-1", shoppingList: true },
      update: { shoppingList: true },
    });
  });

  it("turns it off again — the switch is reversible", async () => {
    const { updateShoppingList } = await import("./settings");
    await updateShoppingList(false);
    expect(prismaMock.settings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { shoppingList: false } }),
    );
  });

  it("coerces a non-boolean rather than writing it", async () => {
    const { updateShoppingList } = await import("./settings");
    await updateShoppingList("on" as unknown as boolean);
    expect(prismaMock.settings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { shoppingList: true } }),
    );
  });

  it("writes NOTHING else — turning the list off must not delete it", async () => {
    // The rows outlive the switch, so a switch pressed by accident is not
    // destructive. A `deleteMany` creeping in here is the regression this catches.
    const { updateShoppingList } = await import("./settings");
    await updateShoppingList(false);
    const [call] = prismaMock.settings.upsert.mock.calls;
    expect(Object.keys(call[0].update)).toEqual(["shoppingList"]);
  });

  it("invalidates the shell as well as the settings page", async () => {
    // The menu entry is rendered by src/app/(app)/layout.tsx, so revalidating
    // only /settings would tick the checkbox and leave the menu stale.
    const { updateShoppingList } = await import("./settings");
    await updateShoppingList(true);
    expect(revalidatePathMock).toHaveBeenCalledWith("/settings");
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });
});
