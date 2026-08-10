import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted so the vi.mock factory (also hoisted) can reference them.
const { delegates, PrismaClientKnownRequestError } = vi.hoisted(() => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  // `upsert` is mocked even though nothing should call it any more: #156
  // replaced the upsert-and-catch shape precisely because a lost upsert prints
  // at error level, so a silent regression back to it is worth catching.
  const makeDelegate = () => ({
    findUnique: vi.fn(),
    createManyAndReturn: vi.fn(),
    upsert: vi.fn(),
  });
  return {
    delegates: { settings: makeDelegate(), streak: makeDelegate() },
    PrismaClientKnownRequestError,
  };
});

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    settings = delegates.settings;
    streak = delegates.streak;
  },
  Prisma: { PrismaClientKnownRequestError },
}));

import { getSettings, getStreak } from "./db";

beforeEach(() => {
  // reset, not clear: these delegates are queued per test with
  // `mockResolvedValueOnce`, and `clearAllMocks` leaves an unconsumed queue
  // behind to bleed into the next test.
  vi.resetAllMocks();
});

// getSettings and getStreak are the same algorithm over two per-workspace
// singleton tables, so they get the same battery rather than a hand-copied one
// that can drift — #156 was reported against Settings and only then found to
// apply identically to Streak.
const singletons = [
  {
    name: "getSettings",
    model: "Settings",
    read: () => getSettings("ws-1"),
    delegate: delegates.settings,
  },
  {
    name: "getStreak",
    model: "Streak",
    read: () => getStreak("ws-1"),
    delegate: delegates.streak,
  },
] as const;

describe.each(singletons)(
  "$name — first use must never raise (#156)",
  ({ model, read, delegate }) => {
    it("returns the existing row from one read, attempting no write", async () => {
      const row = { id: "ws-1", workspaceId: "ws-1" };
      delegate.findUnique.mockResolvedValueOnce(row);

      expect(await read()).toBe(row);
      expect(delegate.findUnique).toHaveBeenCalledTimes(1);
      expect(delegate.createManyAndReturn).not.toHaveBeenCalled();
      expect(delegate.upsert).not.toHaveBeenCalled();
    });

    it("creates the row on first use and returns it without re-reading", async () => {
      const row = { id: "ws-1", workspaceId: "ws-1" };
      delegate.findUnique.mockResolvedValueOnce(null);
      delegate.createManyAndReturn.mockResolvedValueOnce([row]);

      expect(await read()).toBe(row);
      expect(delegate.findUnique).toHaveBeenCalledTimes(1);
      // `skipDuplicates` is the load-bearing flag: it is what makes Prisma emit
      // INSERT ... ON CONFLICT DO NOTHING, so a concurrent first use loses
      // silently instead of raising P2002 and printing `prisma:error`.
      expect(delegate.createManyAndReturn).toHaveBeenCalledWith({
        data: { id: "ws-1", workspaceId: "ws-1" },
        skipDuplicates: true,
      });
    });

    it("resolves a lost race from the winner's row, raising nothing", async () => {
      const winner = { id: "ws-1", workspaceId: "ws-1" };
      delegate.findUnique
        .mockResolvedValueOnce(null) // nothing there yet
        .mockResolvedValueOnce(winner); // …the other request got there first
      // ON CONFLICT DO NOTHING inserted no row, so Prisma returns an empty
      // array. Crucially it does *not* reject, so nothing is logged.
      delegate.createManyAndReturn.mockResolvedValueOnce([]);

      expect(await read()).toBe(winner);
      expect(delegate.findUnique).toHaveBeenCalledTimes(2);
      expect(delegate.upsert).not.toHaveBeenCalled();
    });

    it("propagates a genuine Prisma error from the read", async () => {
      delegate.findUnique.mockRejectedValueOnce(
        new PrismaClientKnownRequestError("connection lost", "P1001"),
      );

      await expect(read()).rejects.toMatchObject({ code: "P1001" });
      expect(delegate.createManyAndReturn).not.toHaveBeenCalled();
    });

    it("propagates a genuine Prisma error from the create, unmasked", async () => {
      delegate.findUnique.mockResolvedValueOnce(null);
      delegate.createManyAndReturn.mockRejectedValueOnce(
        new PrismaClientKnownRequestError("FK violation", "P2003"),
      );

      await expect(read()).rejects.toMatchObject({ code: "P2003" });
      // No catch swallows this into a re-read: a missing workspace is a real
      // failure and must still reach the caller — and Prisma's own error log.
      expect(delegate.findUnique).toHaveBeenCalledTimes(1);
    });

    it("names the workspace when the row vanishes mid-create", async () => {
      // Only reachable if the Workspace was deleted between the two statements
      // (both tables cascade from it, and nothing else deletes them).
      delegate.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      delegate.createManyAndReturn.mockResolvedValueOnce([]);

      // A plain string rather than a constructed regular expression: semgrep's
      // "regular expression with non-literal value" rule flags a pattern built
      // from a variable even inside a test, and asserting the whole sentence is
      // the stronger check anyway.
      await expect(read()).rejects.toThrow(
        `${model} row for workspace ws-1 vanished during first-use creation ` +
          `— the workspace was deleted concurrently.`,
      );
    });
  },
);

// `isUniqueViolation` used to be tested here. It is gone (#158): the four call
// sites its docblock named — rewards.ts, guest-quota.ts, user-quota.ts and
// app/actions/people.ts — now insert with ON CONFLICT DO NOTHING and have no
// P2002 to recognise, so the helper had no callers left. See the note in db.ts.
