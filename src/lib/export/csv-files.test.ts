import { describe, it, expect } from "vitest";
import {
  tasksCsv,
  stepsCsv,
  inboxCsv,
  TASKS_CSV_HEADER,
  STEPS_CSV_HEADER,
  INBOX_CSV_HEADER,
} from "./csv-files";
import {
  makeSnapshot,
  makeEmptySnapshot,
  AWKWARD_TITLE,
  AWKWARD_INBOX_TEXT,
} from "./__tests__/fixture";

/**
 * Split a CSV document into records the way RFC 4180 says to: a CRLF only ends a
 * record when it is not inside a quoted field. Written from the spec rather than
 * imported, so the test proves the file is parseable rather than proving the
 * writer agrees with itself.
 */
function parseCsv(csv: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < csv.length) {
    const c = csv[i];
    if (quoted) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (c === ",") {
      record.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r" && csv[i + 1] === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      i += 2;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

const snapshot = makeSnapshot();

describe("tasks.csv", () => {
  const csv = tasksCsv(snapshot);
  const records = parseCsv(csv);

  it("has the agreed columns, in the agreed order", () => {
    expect(records[0]).toEqual([
      "id",
      "title",
      "status",
      "source",
      "scheduled_at",
      "schedule_due_at",
      "priority",
      "hours",
      "created_at",
    ]);
    expect(records[0]).toEqual([...TASKS_CSV_HEADER]);
  });

  it("has one record per task and no more", () => {
    expect(records).toHaveLength(1 + snapshot.tasks.length);
  });

  it("round-trips a title containing a comma, a quote and a newline", () => {
    // The whole reason the CSV tier needs a real writer. A `join(",")` turns this
    // one task into three malformed records.
    expect(records[1][1]).toBe(AWKWARD_TITLE);
  });

  it("writes every timestamp as ISO-8601 with an explicit offset, and blanks the absent ones", () => {
    expect(records[1][4]).toBe("2026-07-02T08:00:00.000Z");
    expect(records[1][5]).toBe("2026-07-05T17:00:00.000Z");
    expect(records[1][8]).toBe("2026-07-01T09:00:00.000Z");
    // task-2 has never been scheduled.
    expect(records[2][4]).toBe("");
    for (const record of records.slice(1)) {
      for (const index of [4, 5, 8]) {
        if (record[index] !== "") {
          expect(record[index]).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|[+-]\d{2}:\d{2})$/,
          );
        }
      }
    }
  });

  it("carries status, source and the scheduling intent", () => {
    expect(records[1][2]).toBe("active");
    expect(records[1][3]).toBe("braindump");
    expect(records[1][6]).toBe("high");
    expect(records[1][7]).toBe("work");
    // Nulls are empty fields, not the word "null".
    expect(records[2][6]).toBe("");
    expect(records[2][7]).toBe("");
  });

  it("does not carry the Google identifiers — they are meaningless elsewhere", () => {
    // They are in export.json, so a re-import can reconcile; a spreadsheet
    // column of opaque Google ids is noise.
    expect(csv).not.toContain("g-task-1");
    expect(csv).not.toContain("g-list-1");
  });

  it("is header-only for an account with no tasks", () => {
    expect(parseCsv(tasksCsv(makeEmptySnapshot()))).toEqual([
      [...TASKS_CSV_HEADER],
    ]);
  });
});

describe("steps.csv", () => {
  const records = parseCsv(stepsCsv(snapshot));

  it("has the agreed columns, in the agreed order", () => {
    expect(records[0]).toEqual([
      "id",
      "task_id",
      "order",
      "total",
      "text",
      "est_minutes",
      "done",
      "scheduled_at",
    ]);
    expect(records[0]).toEqual([...STEPS_CSV_HEADER]);
  });

  it("keys every step to its task, which is how the relation survives CSV", () => {
    // CSV cannot represent Task → Step[]; two files joined on an id can.
    expect(records.slice(1).map((r) => [r[0], r[1]])).toEqual([
      ["step-1", "task-1"],
      ["step-2", "task-1"],
    ]);
  });

  it("keeps steps in their display order across tasks", () => {
    expect(records.slice(1).map((r) => r[2])).toEqual(["1", "2"]);
  });

  it("round-trips step text containing a newline", () => {
    expect(records[2][4]).toBe("Write it\nacross two lines");
  });

  it("writes done as true/false", () => {
    expect(records[1][6]).toBe("true");
    expect(records[2][6]).toBe("false");
  });

  it("omits estimateHistory rather than nesting JSON in a cell", () => {
    // Agreed on the issue: a JSON array inside a CSV field is neither readable
    // nor parseable by the tools this tier exists for. It is expanded properly in
    // export.json instead.
    expect(records[0]).not.toContain("estimate_history");
    expect(stepsCsv(snapshot)).not.toContain("[10,15]");
  });

  it("is header-only for an account with no steps", () => {
    expect(parseCsv(stepsCsv(makeEmptySnapshot()))).toEqual([
      [...STEPS_CSV_HEADER],
    ]);
  });
});

describe("inbox.csv", () => {
  const records = parseCsv(inboxCsv(snapshot));

  it("has the agreed columns, in the agreed order", () => {
    expect(records[0]).toEqual([
      "id",
      "text",
      "status",
      "est_minutes",
      "task_id",
      "created_at",
      "triaged_at",
      "completed_at",
    ]);
    expect(records[0]).toEqual([...INBOX_CSV_HEADER]);
  });

  it("round-trips inbox text containing a comma, a quote and a newline", () => {
    expect(records[1][1]).toBe(AWKWARD_INBOX_TEXT);
  });

  it("keeps the link to the task an item was triaged into", () => {
    expect(records[1][4]).toBe("");
    expect(records[2][4]).toBe("task-1");
  });

  it("blanks an absent estimate rather than substituting the display default", () => {
    // null estMinutes is MEANINGFUL (#80): it says nobody estimated this. The
    // read side substitutes 5 for display; an export must not.
    expect(records[1][3]).toBe("5");
    expect(records[2][3]).toBe("");
  });

  it("is header-only for an empty inbox", () => {
    expect(parseCsv(inboxCsv(makeEmptySnapshot()))).toEqual([
      [...INBOX_CSV_HEADER],
    ]);
  });
});

describe("all three files", () => {
  it("use CRLF and terminate the last record", () => {
    for (const csv of [
      tasksCsv(snapshot),
      stepsCsv(snapshot),
      inboxCsv(snapshot),
    ]) {
      expect(csv.endsWith("\r\n")).toBe(true);
      // Every LF that is not part of a CRLF is inside a quoted field.
      const outsideQuotes = csv.replace(/"(?:[^"]|"")*"/g, "");
      expect(outsideQuotes).not.toMatch(/(?<!\r)\n/);
    }
  });

  it("carry no byte-order mark", () => {
    for (const csv of [
      tasksCsv(snapshot),
      stepsCsv(snapshot),
      inboxCsv(snapshot),
    ]) {
      expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    }
  });
});
