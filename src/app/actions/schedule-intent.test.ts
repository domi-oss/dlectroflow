import { describe, it, expect, vi, beforeEach } from "vitest";
import { SchedulePriority, ScheduleHours } from "@/lib/scheduling/types";

// Mirrors the mocking style of google-schedule.push.test.ts: hoisted mocks, the
// module boundary faked at @/lib/db and @/lib/workspace, no real Postgres.
const { findFirstMock, workspaceMock, currentUserMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  workspaceMock: vi.fn(),
  currentUserMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { task: { findFirst: findFirstMock } },
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: workspaceMock,
  currentUser: currentUserMock,
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
  currentUserMock.mockResolvedValue({ id: "u_owner", role: "owner" });
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
    // A week out — the shared default from defaultIntentFor, which the bare-📅
    // path uses too. Asserted as a window rather than an instant because the
    // action computes `now` itself.
    expect(intent!.dueAt.getTime()).toBeGreaterThan(
      Date.now() + 6.9 * 24 * 60 * 60_000,
    );
    expect(intent!.dueAt.getTime()).toBeLessThan(
      Date.now() + 7.1 * 24 * 60 * 60_000,
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

  // #118 Phase C gave every member their own Google connection, so a member
  // reaches the Schedule menu and MUST get their own prefill — an owner-only gate
  // here would open their menu on the defaults while their stored choice sat in
  // the database. What keeps accounts apart is the workspace filter, not the role.
  it("returns a member's own intent, not just the owner's", async () => {
    currentUserMock.mockResolvedValue({ id: "u_member", role: "member" });
    findFirstMock.mockResolvedValue(
      taskRow({ schedulePriority: SchedulePriority.Critical }),
    );

    const intent = await loadScheduleIntent("t1");

    expect(intent!.priority).toBe(SchedulePriority.Critical);
    // Scoped by the caller's OWN workspace, never by an id from the request.
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "t1", workspaceId: "ws_1" }),
      }),
    );
  });

  // A caller with no account has no menu to prefill — and must not learn a task
  // exists either, so the check comes before the query.
  it("returns null for a caller with no account, without touching the database", async () => {
    currentUserMock.mockResolvedValue(null);
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
