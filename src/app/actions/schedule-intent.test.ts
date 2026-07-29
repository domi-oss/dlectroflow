import { describe, it, expect, vi, beforeEach } from "vitest";
import { SchedulePriority, ScheduleHours } from "@/lib/scheduling/types";

// Mirrors the mocking style of google-schedule.push.test.ts: hoisted mocks, the
// module boundary faked at @/lib/db and @/lib/workspace, no real Postgres.
const { findFirstMock, workspaceMock, isOwnerMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  workspaceMock: vi.fn(),
  isOwnerMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { task: { findFirst: findFirstMock } },
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: workspaceMock,
  isOwnerRequest: isOwnerMock,
}));

import { loadScheduleIntent } from "./schedule-intent";

const steps = [
  { id: "s1", order: 1, text: "a", subtaskEmoji: "🔗", estMinutes: 15 },
  { id: "s2", order: 2, text: "b", subtaskEmoji: null, estMinutes: 45 },
];

const taskRow = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  scheduleDueAt: null,
  schedulePriority: null,
  scheduleHours: null,
  steps,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  workspaceMock.mockResolvedValue("ws_1");
  isOwnerMock.mockResolvedValue(true);
});

describe("loadScheduleIntent", () => {
  it("returns the persisted intent when the task has one", async () => {
    const dueAt = new Date("2026-08-07T16:00:00.000Z");
    findFirstMock.mockResolvedValue(
      taskRow({
        scheduleDueAt: dueAt,
        schedulePriority: "critical",
        scheduleHours: "personal",
      }),
    );
    const intent = await loadScheduleIntent("t1");
    expect(intent!.dueAt.toISOString()).toBe(dueAt.toISOString());
    expect(intent!.priority).toBe(SchedulePriority.Critical);
    expect(intent!.hours).toBe(ScheduleHours.Personal);
  });

  it("falls back to the shared defaults when nothing is persisted", async () => {
    findFirstMock.mockResolvedValue(taskRow());
    const intent = await loadScheduleIntent("t1");
    expect(intent!.priority).toBe(SchedulePriority.High);
    expect(intent!.hours).toBe(ScheduleHours.Work);
    expect(intent!.busy).toBe(true);
    // Three days out, the default the bare-📅 path already uses.
    expect(intent!.dueAt.getTime()).toBeGreaterThan(
      Date.now() + 2.9 * 24 * 60 * 60_000,
    );
  });

  it("carries every step through as an ordered unit with its emoji and estimate", async () => {
    findFirstMock.mockResolvedValue(taskRow());
    const intent = await loadScheduleIntent("t1");
    expect(intent!.units).toEqual([
      {
        id: "s1",
        order: 1,
        total: 2,
        text: "a",
        emoji: "🔗",
        estMinutes: 15,
        dueAt: null,
      },
      {
        id: "s2",
        order: 2,
        total: 2,
        text: "b",
        emoji: null,
        estMinutes: 45,
        dueAt: null,
      },
    ]);
  });

  // The CHECK constraint makes this unreachable, but a loader that trusts the
  // DB blindly would put "urgent" into a Reclaim parameter.
  it("ignores a persisted priority the DB should never have held", async () => {
    findFirstMock.mockResolvedValue(taskRow({ schedulePriority: "urgent" }));
    expect((await loadScheduleIntent("t1"))!.priority).toBe(
      SchedulePriority.High,
    );
  });

  it("returns null for a task outside the caller's workspace", async () => {
    findFirstMock.mockResolvedValue(null);
    expect(await loadScheduleIntent("t_other")).toBeNull();
  });

  it("scopes the query by workspace — not by id alone", async () => {
    findFirstMock.mockResolvedValue(null);
    await loadScheduleIntent("t1");
    expect(findFirstMock.mock.calls[0][0].where).toMatchObject({
      id: "t1",
      workspaceId: "ws_1",
    });
  });

  // Google is still the owner's singleton connection until #35 Phase C, so a
  // non-owner has no menu to prefill — and must not learn a task exists either.
  it("returns null for a non-owner without touching the database", async () => {
    isOwnerMock.mockResolvedValue(false);
    expect(await loadScheduleIntent("t1")).toBeNull();
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("returns an intent with no units for a task that has no steps", async () => {
    findFirstMock.mockResolvedValue(taskRow({ steps: [] }));
    const intent = await loadScheduleIntent("t1");
    expect(intent!.units).toEqual([]);
    expect(intent!.priority).toBe(SchedulePriority.High);
  });
});
