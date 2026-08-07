import { describe, it, expect } from "vitest";
import { brainDumpItemToTaskData } from "@/lib/braindump-to-task";
import { TaskSource, TaskStatus } from "@/lib/constants";
import { TASK_NOTE_MAX_LENGTH } from "@/lib/task-notes";
import { SchedulePriority, ScheduleHours } from "@/lib/scheduling/types";

/**
 * #179 — the ONE way a `BrainDumpItem` becomes a `Task`.
 *
 * Four call sites construct this row today (`keepAsTask`, `ensureFocusStep`,
 * `startBreakdown`, and the lazy create inside `scheduleSingleTask`). Four
 * independent implementations is how one of them eventually ships without the
 * note — and it would be the path nobody tested. The repo-hygiene guard
 * (`braindump-to-task-hygiene.test.ts`) stops a fifth appearing; this file pins
 * what the helper actually produces.
 */

const ITEM = {
  text: "water the office plants",
  notes: "can under sink needs a wash",
  scheduleDueAt: new Date("2026-09-01T09:00:00.000Z"),
  schedulePriority: SchedulePriority.Critical as string,
  scheduleHours: ScheduleHours.Personal as string,
};

describe("brainDumpItemToTaskData (#179)", () => {
  it("carries the item's text across as the task title", () => {
    expect(brainDumpItemToTaskData(ITEM, "ws-1").title).toBe(
      "water the office plants",
    );
  });

  it("stamps the brain-dump provenance and an active status", () => {
    const data = brainDumpItemToTaskData(ITEM, "ws-1");
    expect(data.source).toBe(TaskSource.BrainDump);
    expect(data.status).toBe(TaskStatus.Active);
    expect(data.workspaceId).toBe("ws-1");
  });

  describe("the note carries over rather than being orphaned", () => {
    it("copies the item's note onto the task", () => {
      // The #186 decision, written down: triage is a ROUTINE action, and user
      // content must not disappear because of one. The alternative — leaving
      // the note on the item while every note surface reads `Task.notes` —
      // makes it unreachable without deleting it, which is the worst of both.
      expect(brainDumpItemToTaskData(ITEM, "ws-1").notes).toBe(
        "can under sink needs a wash",
      );
    });

    it("leaves the task note NULL when the item had none", () => {
      expect(
        brainDumpItemToTaskData({ ...ITEM, notes: null }, "ws-1").notes,
      ).toBeNull();
    });

    it("normalises on the way across, so a blank never reaches the column", () => {
      // `Task.notes` NULL is what keeps an empty line out of a calendar entry.
      // The item column is normalised on write too, so this only bites for a
      // row some other writer produced — which is exactly the case a shared
      // helper exists to cover.
      expect(
        brainDumpItemToTaskData({ ...ITEM, notes: "   \n  " }, "ws-1").notes,
      ).toBeNull();
    });

    it("clamps an over-long note instead of letting Task_notes_check reject it", () => {
      // Both columns are bounded at the same number, so this is unreachable
      // through the app's own writers. It is asserted because the failure mode
      // if it ever became reachable is a CHECK violation thrown from "Keep as
      // task" — a routine action failing with nothing the user could act on.
      const data = brainDumpItemToTaskData(
        { ...ITEM, notes: "x".repeat(TASK_NOTE_MAX_LENGTH + 50) },
        "ws-1",
      );
      expect(data.notes).toHaveLength(TASK_NOTE_MAX_LENGTH);
    });
  });

  describe("the schedule intent carries over too", () => {
    it("copies all three intent columns", () => {
      // Same argument as the note, one field wider. An owner who set a deadline
      // on an untriaged item and then pressed "Keep as task" would otherwise
      // reopen the Schedule menu on `defaultIntentFor`'s fallback — the choice
      // they made silently replaced by one nobody made.
      const data = brainDumpItemToTaskData(ITEM, "ws-1");
      expect(data.scheduleDueAt).toEqual(ITEM.scheduleDueAt);
      expect(data.schedulePriority).toBe(SchedulePriority.Critical);
      expect(data.scheduleHours).toBe(ScheduleHours.Personal);
    });

    it("leaves all three NULL when the item never carried an intent", () => {
      // NULL has to survive the copy intact: it is what makes
      // `mergePersistedIntent` fall back per field, so a "" or an epoch date
      // here would read as a choice the owner never made.
      const data = brainDumpItemToTaskData(
        {
          ...ITEM,
          scheduleDueAt: null,
          schedulePriority: null,
          scheduleHours: null,
        },
        "ws-1",
      );
      expect(data.scheduleDueAt).toBeNull();
      expect(data.schedulePriority).toBeNull();
      expect(data.scheduleHours).toBeNull();
    });

    it("drops a pseudo-enum value outside the vocabulary rather than copying it", () => {
      // `BrainDumpItem_schedulePriority_check` makes this unreachable from the
      // app, but the value ends up in a Reclaim title parameter — the same
      // reason `mergePersistedIntent` re-validates a column a CHECK already
      // guards. Copying an illegal value forward would also make the TASK's
      // CHECK the thing that fails, on a different action, later.
      const data = brainDumpItemToTaskData(
        { ...ITEM, schedulePriority: "urgent", scheduleHours: "weekend" },
        "ws-1",
      );
      expect(data.schedulePriority).toBeNull();
      expect(data.scheduleHours).toBeNull();
    });
  });

  it("returns a plain object with no extra keys Prisma would reject", () => {
    expect(Object.keys(brainDumpItemToTaskData(ITEM, "ws-1")).sort()).toEqual([
      "notes",
      "scheduleDueAt",
      "scheduleHours",
      "schedulePriority",
      "source",
      "status",
      "title",
      "workspaceId",
    ]);
  });
});
