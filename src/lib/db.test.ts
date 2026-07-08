import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted so the vi.mock factory (also hoisted) can reference them.
const { settingsUpsert, settingsFindUnique, PrismaClientKnownRequestError } =
  vi.hoisted(() => {
    class PrismaClientKnownRequestError extends Error {
      code: string;
      constructor(message: string, code: string) {
        super(message);
        this.code = code;
      }
    }
    return {
      settingsUpsert: vi.fn(),
      settingsFindUnique: vi.fn(),
      PrismaClientKnownRequestError,
    };
  });

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    settings = { upsert: settingsUpsert, findUnique: settingsFindUnique };
    streak = { upsert: vi.fn(), findUnique: vi.fn() };
  },
  Prisma: { PrismaClientKnownRequestError },
}));

import { getSettings } from "./db";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getSettings — race-safe first-use create", () => {
  it("returns the upserted row on the happy path (no refetch)", async () => {
    const row = { id: "ws-1", workspaceId: "ws-1" };
    settingsUpsert.mockResolvedValueOnce(row);

    const result = await getSettings("ws-1");

    expect(result).toBe(row);
    expect(settingsFindUnique).not.toHaveBeenCalled();
  });

  it("re-fetches the existing row when a concurrent create loses with P2002", async () => {
    const existing = { id: "ws-1", workspaceId: "ws-1" };
    settingsUpsert.mockRejectedValueOnce(
      new PrismaClientKnownRequestError("Unique constraint failed", "P2002"),
    );
    settingsFindUnique.mockResolvedValueOnce(existing);

    const result = await getSettings("ws-1");

    expect(result).toBe(existing);
    expect(settingsFindUnique).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
    });
  });

  it("rethrows non-P2002 errors", async () => {
    settingsUpsert.mockRejectedValueOnce(
      new PrismaClientKnownRequestError("connection lost", "P1001"),
    );

    await expect(getSettings("ws-1")).rejects.toMatchObject({ code: "P1001" });
    expect(settingsFindUnique).not.toHaveBeenCalled();
  });
});
