// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ShoppingPage from "./page";

/**
 * #199 — the gate, tested where it matters.
 *
 * The issue's requirement is that the toggle is enforced **server-side on the
 * page itself**, not only by hiding the menu link. A menu-only gate leaves
 * `/shopping` reachable by typing the URL, which is how a feature switch turns
 * into decoration. The server actions carry the same gate
 * (`src/app/actions/shopping.test.ts`), so this is one of two halves rather than
 * the whole story.
 */

const { findManyMock, getSettingsMock, currentWorkspaceIdMock } = vi.hoisted(
  () => ({
    findManyMock: vi.fn(),
    getSettingsMock: vi.fn(),
    currentWorkspaceIdMock: vi.fn(),
  }),
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  notFound: () => {
    throw new Error("notFound() called");
  },
}));
vi.mock("@/lib/db", () => ({
  prisma: { shoppingItem: { findMany: findManyMock } },
  getSettings: getSettingsMock,
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("ws-1");
  getSettingsMock.mockResolvedValue({ shoppingList: true, voice: "plain" });
  findManyMock.mockResolvedValue([]);
});
afterEach(cleanup);

describe("the server-side gate", () => {
  it("404s when the toggle is off", async () => {
    getSettingsMock.mockResolvedValue({ shoppingList: false, voice: "plain" });
    await expect(ShoppingPage()).rejects.toThrow("notFound() called");
  });

  it("reads nothing at all when the toggle is off", async () => {
    // The gate is decided BEFORE the list is fetched: a 404 that still queried the
    // table would be work done for a page nobody is allowed to see, and it is the
    // shape that later gets "optimised" into rendering the data it already has.
    getSettingsMock.mockResolvedValue({ shoppingList: false, voice: "plain" });
    await expect(ShoppingPage()).rejects.toThrow();
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("renders when the toggle is on", async () => {
    render(await ShoppingPage());
    expect(
      screen.getByRole("heading", { level: 1, name: /shopping list/i }),
    ).toBeInTheDocument();
  });
});

describe("the read", () => {
  it("is scoped to the resolved workspace and ordered by capture order", async () => {
    render(await ShoppingPage());
    expect(findManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      orderBy: [{ order: "asc" }, { id: "asc" }],
    });
  });

  it("hands the rows to the list", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "s1",
        text: "Apples",
        done: false,
        savedForLater: false,
        order: 1,
        createdAt: new Date(),
        workspaceId: "ws-1",
      },
    ]);
    render(await ShoppingPage());
    expect(screen.getByText("Apples")).toBeInTheDocument();
  });

  it("speaks the workspace's voice", async () => {
    getSettingsMock.mockResolvedValue({ shoppingList: true, voice: "playful" });
    render(await ShoppingPage());
    expect(
      screen.getByRole("heading", { level: 1, name: /🛒 Shopping list/ }),
    ).toBeInTheDocument();
  });
});
