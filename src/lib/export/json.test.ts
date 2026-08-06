import { describe, it, expect } from "vitest";
import { exportJson, EXPORT_SCHEMA_VERSION } from "./json";
import { makeSnapshot, makeEmptySnapshot } from "./__tests__/fixture";

const snapshot = makeSnapshot();
const parsed = JSON.parse(exportJson(snapshot));

/** Every string value anywhere in the tree, for the "is it in there at all"
 *  assertions that are the only honest way to test an omission. */
function everyKey(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) everyKey(v, keys);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      keys.push(k);
      everyKey(v, keys);
    }
  }
  return keys;
}

describe("export.json — the round-trippable tier", () => {
  it("is valid, pretty-printed JSON ending in a newline", () => {
    const text = exportJson(snapshot);
    expect(() => JSON.parse(text)).not.toThrow();
    // Pretty-printed because a human will open this one too, and a single-line
    // 200 KB file is not diffable, greppable or reviewable.
    expect(text).toContain("\n  ");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("declares schemaVersion 1, so a future importer knows what it is reading", () => {
    expect(parsed.schemaVersion).toBe(1);
    expect(EXPORT_SCHEMA_VERSION).toBe(1);
  });

  it("names the app and the export time at the top level", () => {
    expect(parsed.app).toBe("dlectroflow");
    expect(parsed.exportedAt).toBe("2026-08-03T09:30:00.000Z");
  });

  it("expands estimateHistory into a real array", () => {
    // The column holds the JSON *string* "[10,15]". Leaving it as a string would
    // make every consumer re-parse a field whose type is a lie.
    const [step] = parsed.tasks[0].steps;
    expect(step.estimateHistory).toEqual([10, 15]);
    expect(typeof step.estimateHistory).not.toBe("string");
  });

  it("renders an absent estimateHistory as an empty array, not null", () => {
    // "No history" and "a history of nothing" are the same fact here, and one
    // type for the field means a consumer never has to branch.
    expect(parsed.tasks[0].steps[1].estimateHistory).toEqual([]);
  });

  it("expands proposedSteps on a coaching turn too", () => {
    // Same column-holds-JSON shape as estimateHistory, same reasoning.
    expect(parsed.tasks[0].turns[1].proposedSteps).toEqual([
      { text: "Draft the outline", estMinutes: 15 },
    ]);
    expect(parsed.tasks[0].turns[0].proposedSteps).toBeNull();
  });

  it("survives an unparseable JSON column instead of failing the whole export", () => {
    // A corrupt cell must not cost somebody their entire download. The raw text
    // is preserved so nothing is lost.
    const broken = makeSnapshot();
    broken.tasks[0].steps[0].estimateHistory = "{not json";
    const step = JSON.parse(exportJson(broken)).tasks[0].steps[0];
    expect(step.estimateHistory).toEqual([]);
    expect(step.estimateHistoryRaw).toBe("{not json");
  });

  it("keeps every task field, including the ones the CSVs drop", () => {
    const task = parsed.tasks[0];
    expect(task.id).toBe("task-1");
    expect(task.parentEmoji).toBe("🚀");
    // External identifiers: meaningless outside the original Google account, and
    // exactly what a re-import needs to reconcile.
    expect(task.googleTaskId).toBe("g-task-1");
    expect(task.googleTaskListId).toBe("g-list-1");
    expect(task.scheduledVia).toBe("ics");
    // #44 — the user's note, VERBATIM. `tasks.md` quotes it and the CSVs drop
    // it, so this tier is the only one that reproduces the exact bytes the
    // person typed, blank line included.
    expect(task.notes).toBe("Bring the Figma link\n\ncall before 5");
  });

  it("keeps the unflattened title, newline and all", () => {
    // tasks.md has to flatten it onto a heading line. This tier is the one that
    // must not lose a byte.
    expect(parsed.tasks[0].title).toBe(
      'Ship "the thing",\nwith a newline; and a 🚀',
    );
  });

  it("nests steps and turns under their task", () => {
    expect(parsed.tasks[0].steps).toHaveLength(2);
    expect(parsed.tasks[0].turns).toHaveLength(2);
  });

  it("carries the inbox, focus sessions, settings and the derived tables", () => {
    expect(parsed.inbox).toHaveLength(2);
    expect(parsed.focusSessions).toHaveLength(1);
    expect(parsed.settings.voice).toBe("playful");
    expect(parsed.gamification.streak.current).toBe(3);
    expect(parsed.gamification.badges[0].key).toBe("first_breakdown");
    expect(parsed.gamification.rewardEvents).toHaveLength(1);
    expect(parsed.gamification.dayRollups[0].narrative).toBe(
      "One step, and it was the hard one.",
    );
    expect(parsed.gamification.dailySparks).toHaveLength(1);
    expect(parsed.gamification.streakRecords).toHaveLength(1);
  });

  it("writes every timestamp as ISO-8601 with an explicit offset", () => {
    const offsets =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|[+-]\d{2}:\d{2})$/;
    expect(parsed.tasks[0].createdAt).toMatch(offsets);
    expect(parsed.tasks[0].scheduleDueAt).toMatch(offsets);
    expect(parsed.inbox[1].triagedAt).toMatch(offsets);
    expect(parsed.focusSessions[0].startedAt).toMatch(offsets);
    expect(parsed.gamification.badges[0].earnedAt).toMatch(offsets);
    expect(parsed.settings.updatedAt).toMatch(offsets);
    // A nullable timestamp stays null rather than becoming an empty string.
    expect(parsed.tasks[0].steps[1].scheduledAt).toBeNull();
  });

  it("says who the account is, without its credentials", () => {
    expect(parsed.account.handle).toBe("sam");
    expect(parsed.account.provider).toBe("gitlab");
    expect(parsed.account.email).toBe("sam@example.com");
    expect(parsed.account.aiQuota).toBe(50);
  });

  it("carries integration METADATA and no tokens", () => {
    expect(parsed.integrations.googleTasks).toEqual({
      configured: true,
      connected: true,
      needsReconnect: false,
    });
    // The whole GoogleAuth row is excluded. README.md says so, because a user
    // must not infer that exporting preserves their Google connection.
    expect(everyKey(parsed)).not.toContain("accessToken");
    expect(everyKey(parsed)).not.toContain("refreshToken");
  });

  it("contains no key that looks like a stored secret", () => {
    // A tripwire, in the shape src/lib/env-drift.ts uses: the encrypted per-user
    // LLM key is not in the snapshot type today, and this is what fails if a
    // future column called `somethingEnc` gets swept in by a spread. An export is
    // the last place a user's own API key should surface — they may well forward
    // the file to somebody.
    const suspicious = everyKey(parsed).filter((k) =>
      /(^|[^a-z])(enc|token|secret|password|credential)/i.test(k),
    );
    expect(suspicious).toEqual([]);
    expect(everyKey(parsed)).not.toContain("llmKeyEnc");
  });

  it("names the workspace and whether it is a guest sandbox", () => {
    expect(parsed.workspace.kind).toBe("user");
    expect(parsed.workspace.expiresAt).toBeNull();
  });

  it("is valid and complete for a brand-new account with nothing in it", () => {
    const empty = JSON.parse(exportJson(makeEmptySnapshot()));
    expect(empty.schemaVersion).toBe(1);
    expect(empty.tasks).toEqual([]);
    expect(empty.inbox).toEqual([]);
    expect(empty.settings).toBeNull();
    expect(empty.gamification.streak).toBeNull();
    expect(empty.gamification.badges).toEqual([]);
  });

  it("is deterministic — the same snapshot serialises to the same bytes", () => {
    // What makes two exports diffable, and what makes this suite assertable.
    expect(exportJson(makeSnapshot())).toBe(exportJson(makeSnapshot()));
  });
});
