import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  workspaceMock,
  revalidatePathMock,
  taskFindFirstMock,
  taskUpdateMock,
  logRewardMock,
  awardBadgeMock,
  getSettingsMock,
} = vi.hoisted(() => ({
  workspaceMock: vi.fn(),
  revalidatePathMock: vi.fn(),
  taskFindFirstMock: vi.fn(),
  taskUpdateMock: vi.fn(),
  logRewardMock: vi.fn(),
  awardBadgeMock: vi.fn(),
  getSettingsMock: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({
  prisma: { task: { findFirst: taskFindFirstMock, update: taskUpdateMock } },
  getSettings: getSettingsMock,
}));
vi.mock("@/lib/rewards", () => ({
  logReward: logRewardMock,
  awardBadge: awardBadgeMock,
}));
vi.mock("@/lib/workspace", () => ({ currentWorkspaceId: workspaceMock }));

import { scheduleViaIcs } from "./ics-schedule";
import { RewardType, BadgeKey } from "@/lib/constants";

beforeEach(() => {
  vi.clearAllMocks();
  logRewardMock.mockResolvedValue(undefined);
  awardBadgeMock.mockResolvedValue(undefined);
  taskUpdateMock.mockResolvedValue({});
  getSettingsMock.mockResolvedValue({ voice: "plain" });
});

const stepTask = (over: Record<string, unknown> = {}) => ({
  id: "task-1",
  title: "Ship the thing",
  parentEmoji: "🚀",
  scheduledAt: null,
  steps: [{ text: "Plan", estMinutes: 15, subtaskEmoji: "📝" }],
  ...over,
});

describe("scheduleViaIcs", () => {
  it("awards Scheduled + FirstSchedule once on first schedule and marks the task", async () => {
    workspaceMock.mockResolvedValue("owner");
    taskFindFirstMock.mockResolvedValue(stepTask());
    const res = await scheduleViaIcs("task-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ics).toContain("BEGIN:VCALENDAR");
      expect(res.icsFilename).toBe("dlectroflow-Ship-the-thing.ics");
    }
    expect(taskUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
        data: expect.objectContaining({ scheduledVia: "ics" }),
      }),
    );
    expect(logRewardMock).toHaveBeenCalledWith("owner", RewardType.Scheduled);
    expect(awardBadgeMock).toHaveBeenCalledWith(
      "owner",
      BadgeKey.FirstSchedule,
    );
  });

  it("guest workspace earns the reward (no owner gate)", async () => {
    workspaceMock.mockResolvedValue("guest-ws");
    taskFindFirstMock.mockResolvedValue(stepTask());
    const res = await scheduleViaIcs("task-1");
    expect(res.ok).toBe(true);
    expect(logRewardMock).toHaveBeenCalledWith(
      "guest-ws",
      RewardType.Scheduled,
    );
  });

  it("is idempotent: an already-scheduled task returns the .ics but does NOT re-award", async () => {
    workspaceMock.mockResolvedValue("owner");
    taskFindFirstMock.mockResolvedValue(
      stepTask({ scheduledAt: new Date("2026-07-17T10:00:00Z") }),
    );
    const res = await scheduleViaIcs("task-1");
    expect(res.ok).toBe(true);
    expect(taskUpdateMock).not.toHaveBeenCalled();
    expect(logRewardMock).not.toHaveBeenCalled();
    expect(awardBadgeMock).not.toHaveBeenCalled();
  });

  it("no-steps task synthesizes one event from durationMin", async () => {
    workspaceMock.mockResolvedValue("owner");
    taskFindFirstMock.mockResolvedValue(stepTask({ steps: [] }));
    const res = await scheduleViaIcs("task-1", { durationMin: 45 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
      expect(res.ics).toContain("SUMMARY:🚀 Ship the thing");
    }
  });

  it("wrong-workspace taskId is not found (IDOR-safe) — no award, no marker", async () => {
    workspaceMock.mockResolvedValue("guest-ws");
    taskFindFirstMock.mockResolvedValue(null);
    const res = await scheduleViaIcs("task-owned-by-someone-else");
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(taskFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-owned-by-someone-else", workspaceId: "guest-ws" },
      }),
    );
    expect(logRewardMock).not.toHaveBeenCalled();
    expect(taskUpdateMock).not.toHaveBeenCalled();
  });

  // #104: every VEVENT used to carry steps[0]'s link, so a downloaded calendar
  // sent all of a task's events to step 1's timer. Each event links to ITS step.
  it("embeds a voice-aware focus deep-link note pointing at ITS OWN step (#104)", async () => {
    workspaceMock.mockResolvedValue("owner");
    getSettingsMock.mockResolvedValue({ voice: "playful" });
    process.env.PUBLIC_ORIGIN = "https://app.example";
    taskFindFirstMock.mockResolvedValue(
      stepTask({
        steps: [
          { id: "step-A", text: "Plan", estMinutes: 15 },
          { id: "step-B", text: "Build", estMinutes: 20 },
        ],
      }),
    );
    const res = await scheduleViaIcs("task-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.ics.match(/DESCRIPTION:/g) ?? []).length).toBe(2);
      // #129 — these DESCRIPTIONs are over 75 octets, so they are now folded
      // (RFC 5545 §3.1) and the URL is split across two physical lines. The
      // property under test is which step each event links to, so it is asserted
      // against the unfolded text — which is what a calendar client sees.
      const unfolded = res.ics.replace(/\r\n[ \t]/g, "");
      expect(unfolded).toContain("https://app.example/focus/step-A");
      expect(unfolded).toContain("https://app.example/focus/step-B");
      expect(res.ics).toContain("🍽️"); // playful voice resolved from settings
      // The owner asked for defended time and an .ics can say so (#104).
      expect((res.ics.match(/TRANSP:OPAQUE/g) ?? []).length).toBe(2);
    }
    delete process.env.PUBLIC_ORIGIN;
  });

  it("stepless task deep-links to the /focus launcher (no step id available)", async () => {
    workspaceMock.mockResolvedValue("owner");
    process.env.PUBLIC_ORIGIN = "https://app.example";
    taskFindFirstMock.mockResolvedValue(stepTask({ steps: [] }));
    const res = await scheduleViaIcs("task-1", { durationMin: 30 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ics).toContain("https://app.example/focus");
      expect(res.ics).not.toContain("/focus/");
    }
    delete process.env.PUBLIC_ORIGIN;
  });

  // ── #44: the task's own note rides into the DESCRIPTION ──────────────────
  it("threads the task's note into every step's DESCRIPTION, above the deep-link", async () => {
    workspaceMock.mockResolvedValue("owner");
    process.env.PUBLIC_ORIGIN = "https://app.example";
    taskFindFirstMock.mockResolvedValue(
      stepTask({
        notes: "Bring the Figma link",
        steps: [
          { id: "step-A", text: "Plan", estMinutes: 15 },
          { id: "step-B", text: "Build", estMinutes: 20 },
        ],
      }),
    );
    const res = await scheduleViaIcs("task-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      const unfolded = res.ics.replace(/\r\n[ \t]/g, "");
      // Every event, not just the first: the note is context for the whole
      // task, and a calendar entry you open at step 3 needs it as much as one
      // you open at step 1.
      expect((unfolded.match(/Bring the Figma link/g) ?? []).length).toBe(2);
      const description = unfolded
        .split("\r\n")
        .find((l) => l.startsWith("DESCRIPTION:")) as string;
      expect(description.indexOf("Bring the Figma link")).toBeLessThan(
        description.indexOf("https://app.example/focus/step-A"),
      );
    }
    delete process.env.PUBLIC_ORIGIN;
  });

  it("threads the note onto the stepless fallback event too", async () => {
    workspaceMock.mockResolvedValue("owner");
    taskFindFirstMock.mockResolvedValue(
      stepTask({ steps: [], notes: "call before 5" }),
    );
    const res = await scheduleViaIcs("task-1", { durationMin: 30 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ics.replace(/\r\n[ \t]/g, "")).toContain("call before 5");
    }
  });

  it("produces the pre-#44 bytes for a task with no note", async () => {
    workspaceMock.mockResolvedValue("owner");
    process.env.PUBLIC_ORIGIN = "https://app.example";
    const stamp = new Date("2026-08-05T09:00:00Z");
    vi.setSystemTime(stamp);
    taskFindFirstMock.mockResolvedValue(stepTask({ notes: null }));
    const withNullNote = await scheduleViaIcs("task-1");
    vi.setSystemTime(stamp);
    taskFindFirstMock.mockResolvedValue(stepTask());
    const withNoColumn = await scheduleViaIcs("task-1");
    vi.useRealTimers();
    expect(withNullNote.ok && withNullNote.ics).toBe(
      withNoColumn.ok && withNoColumn.ics,
    );
    delete process.env.PUBLIC_ORIGIN;
  });

  // ── #44 / #154: the note is free text, so it is an injection surface ──────
  //
  // This is the exact hole `esc()` was hardened for. A DESCRIPTION value that
  // reaches the file unescaped can END ITS CONTENT LINE and start a new one, and
  // a lenient parser then reads whatever follows as a fresh calendar property —
  // a forged ATTENDEE, a second VEVENT, an ORGANIZER that is not you. Before
  // #44 the only user text in a DESCRIPTION was a title that `oneLine`
  // collapsed; a multi-line note is the first value with a real line terminator
  // in it, and CR is the one that matters most because no editor shows it.
  it("cannot forge a calendar property from a note containing newlines, semicolons and a bare CR", async () => {
    workspaceMock.mockResolvedValue("owner");
    taskFindFirstMock.mockResolvedValue(
      stepTask({
        notes:
          "harmless\r\nATTENDEE;CN=Mallory:mailto:m@evil.test\rORGANIZER:mailto:m@evil.test\nEND:VEVENT\nBEGIN:VEVENT\nSUMMARY:forged",
        steps: [{ id: "step-A", text: "Plan", estMinutes: 15 }],
      }),
    );
    const res = await scheduleViaIcs("task-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Unfold first (§3.1), because that is what a client does before parsing:
    // a check against the folded text would pass on a payload that reassembles
    // into a property once the continuations are joined.
    const unfolded = res.ics.replace(/\r\n[ \t]/g, "");
    const lines = unfolded.split("\r\n");

    // The structure is exactly what one step produces — the note added no
    // events and closed none. Counted as WHOLE LINES rather than substrings,
    // because the escaped payload legitimately still contains the characters
    // `END:VEVENT` inside a DESCRIPTION value; being present as data is the
    // outcome we want, and only being present as a LINE is the attack.
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines.filter((l) => l === "END:VEVENT")).toHaveLength(1);

    // No physical line begins one of the properties the note tried to
    // introduce.
    for (const forbidden of ["ATTENDEE", "ORGANIZER", "SUMMARY:forged"]) {
      expect(
        lines.some((l) => l.startsWith(forbidden)),
        `a note forged a ${forbidden} line`,
      ).toBe(false);
    }

    // The payload is still THERE — escaped, not stripped. The user typed it and
    // gets to read it back; the point is that it is data, not syntax.
    expect(unfolded).toContain("ATTENDEE\\;CN=Mallory");
    // CRLF and a bare CR both collapse to ONE escaped `\n`, never two, so the
    // note does not gain blank lines on the way into somebody's calendar.
    expect(unfolded).toContain("harmless\\nATTENDEE");

    // And no raw terminator survives inside a value: after unfolding, the only
    // CR and LF in the file are the CRLFs that separate content lines.
    for (const line of lines) {
      expect(/[\r\n]/.test(line)).toBe(false);
    }
  });

  it("keeps every physical line inside 75 octets with a long note (RFC 5545 §3.1)", async () => {
    workspaceMock.mockResolvedValue("owner");
    taskFindFirstMock.mockResolvedValue(
      stepTask({
        // Emoji on purpose: folding is bounded in OCTETS, and a naive character
        // fold both overshoots and can split a UTF-8 sequence.
        notes: "🧠 remember the thing ".repeat(40),
        steps: [{ id: "step-A", text: "Plan", estMinutes: 15 }],
      }),
    );
    const res = await scheduleViaIcs("task-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    for (const line of res.ics.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
    // Unfolding is lossless — the note is intact once the client puts it back
    // together, replacement characters and all absent.
    const unfolded = res.ics.replace(/\r\n[ \t]/g, "");
    expect(unfolded).toContain("🧠 remember the thing");
    expect(unfolded).not.toContain("�");
  });

  it("a reward failure does not fail scheduling (returns the .ics anyway)", async () => {
    workspaceMock.mockResolvedValue("owner");
    taskFindFirstMock.mockResolvedValue(stepTask());
    logRewardMock.mockRejectedValue(new Error("db down"));
    const res = await scheduleViaIcs("task-1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.ics).toContain("BEGIN:VCALENDAR");
  });
});
