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

  // #185, wired in review of #199 — the table reached `main` absent from the
  // export and every test stayed green. `__tests__/model-coverage.test.ts` is the
  // structural half; this is the value half.
  it("carries the workspace's own focus playlists", () => {
    expect(parsed.focusPlaylists).toHaveLength(1);
    expect(parsed.focusPlaylists[0].name).toBe("Deep work, mornings 🎧");
    expect(parsed.focusPlaylists[0].trackIds).toEqual([
      "catalog:rain-01.mp3",
      "bundled-piano",
    ]);
  });

  // #199 — the WHOLE shopping list, including the ticked and saved-for-later
  // rows: both are things the data subject wrote down, and this is the tier whose
  // job is to lose nothing.
  it("carries the shopping list, ticked and saved-for-later rows included", () => {
    expect(parsed.shoppingItems).toHaveLength(3);
    expect(parsed.shoppingItems[0].text).toBe('oat milk, the "barista" one');
    expect(parsed.shoppingItems.map((i: { done: boolean }) => i.done)).toEqual([
      false,
      true,
      false,
    ]);
    expect(
      parsed.shoppingItems.map(
        (i: { savedForLater: boolean }) => i.savedForLater,
      ),
    ).toEqual([false, false, true]);
  });

  // #199 — the summary row is app-generated bookkeeping, and it is DELIBERATELY
  // absent. This assertion exists so the exclusion can never be mistaken for
  // hiding real user data: the shopping list itself is exported in full (above),
  // and what is withheld is one nullable timestamp saying whether an inbox line is
  // currently dismissed — a fact an importer can recreate from the exported rows.
  // Registered with that reasoning in __tests__/model-coverage.test.ts's
  // DELIBERATELY_EXCLUDED, which requires every exclusion to carry a reason.
  it("does NOT carry the inbox summary row — and does carry the list it summarises", () => {
    expect(everyKey(parsed)).not.toContain("shoppingSummary");
    expect(everyKey(parsed)).not.toContain("clearedAt");
    // The control that makes the two absences above mean something: a serialiser
    // that dropped the whole feature would satisfy them too.
    expect(parsed.shoppingItems).toHaveLength(3);
  });

  // #175 — the archive carries `clientKey`, and this pins it as a decision rather
  // than a side effect of `inbox` being typed against the whole model (Duo review,
  // `!334`). The reasoning lives beside the column in `prisma/schema.prisma`; the
  // short version is that an idempotency key is not a secret, that
  // `DELIBERATELY_EXCLUDED` is keyed by model rather than by field so it could not
  // express the alternative anyway, and that narrowing the read to exclude it would
  // cost the compile-time tripwire which makes the next new column a build error.
  //
  // `in` rather than a value comparison, because the two failure modes differ and
  // only one of them is visible from the value: `JSON.stringify` drops `undefined`
  // and keeps `null`, so a row that reached the archive with the field missing
  // entirely and a row that reached it as an explicit null both read `undefined`
  // once parsed.
  it("carries clientKey as an explicit null rather than dropping the field", () => {
    expect("clientKey" in parsed.inbox[0]).toBe(true);
    expect(parsed.inbox[0].clientKey).toBeNull();
    // The control that stops this passing on an empty archive, in the same shape
    // the shopping-summary absence above uses.
    expect(parsed.inbox).toHaveLength(2);
    expect(everyKey(parsed)).toContain("clientKey");
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

  // ── The four records that were held and unexported ────────────────────────
  //
  // `__tests__/model-coverage.test.ts` is the structural half — it fails when a
  // model is forgotten. This is the value half, in the same pairing #185 already
  // has: the guard proves the table is not forgotten, these prove the rows
  // actually arrive.

  it("carries the account flags that used to be dropped from the User select", () => {
    // All four were in the database and absent from the export while /privacy
    // disclosed holding them. Asserted per COLUMN rather than as one "account
    // flags are there" test, because the defect twice took the form of a partial
    // list that read as a complete one.
    expect(parsed.account.status).toBe("active");
    expect(parsed.account.lastSeenAt).toBe("2026-08-03T09:29:00.000Z");
    expect(parsed.account.revokedAt).toBeNull();
    expect(parsed.account.providerSub).toBe("gitlab-sub-778201");
    // Found while fixing the four above: the same shape of omission, so they are
    // pinned the same way rather than left to be discovered a third time.
    expect(parsed.account.llmProvider).toBeNull();
    expect("purgeAfter" in parsed.account).toBe(true);
    expect(parsed.account.purgeAfter).toBeNull();
    // `in` rather than a value comparison for the nullables, for the reason the
    // clientKey test above spells out: JSON.stringify drops `undefined` and keeps
    // `null`, so a field that never reached the archive and a field that arrived
    // as an explicit null both read `undefined` once parsed.
    expect("revokedAt" in parsed.account).toBe(true);
  });

  it("carries the workspace's own lastSeenAt, not just the account's", () => {
    // The schema has two last-seen columns and exporting one while withholding
    // the other is the partial-list defect this change removes.
    expect(parsed.workspace.lastSeenAt).toBe("2026-08-03T09:29:00.000Z");
  });

  it("carries the invitation record, INCLUDING the note written about the reader", () => {
    // The strongest of the four, and the reason the set was worth exporting
    // rather than disclosing and withholding: this is free text ANOTHER PERSON
    // wrote about the data subject. /privacy discloses collecting it, so an
    // archive without it hands over less than the reader is entitled to.
    expect(parsed.accountRecords.invitation.note).toBe(
      "met at the ADHD meetup, wants the shopping list beta",
    );
    expect(parsed.accountRecords.invitation.identity).toBe("sam");
    expect(parsed.accountRecords.invitation.isOwnerSeed).toBe(false);
    expect(parsed.accountRecords.invitation.invitedAt).toBe(
      "2026-05-28T14:00:00.000Z",
    );
    expect(parsed.accountRecords.invitation.claimedAt).toBe(
      "2026-06-01T07:00:00.000Z",
    );
    // The note reaches the rendered bytes, not merely a parsed field — the same
    // "is it in there at all" form the omission assertions use, so a serialiser
    // that stringified it as "[object Object]" could not pass.
    expect(exportJson(snapshot)).toContain("met at the ADHD meetup");
  });

  it("carries the AI usage counter as STORED, not as the Settings panel view", () => {
    // `peekUserAiUsage` reports a lapsed window as 0 used, which is right for the
    // panel and wrong here: an export reproduces what is in the database.
    expect(parsed.accountRecords.aiUsage.count).toBe(7);
    expect(parsed.accountRecords.aiUsage.windowStartedAt).toBe(
      "2026-08-03T06:00:00.000Z",
    );
    expect(parsed.accountRecords.aiUsage.updatedAt).toBe(
      "2026-08-03T08:45:00.000Z",
    );
  });

  it("carries the calendar feed's timestamps and NOT its token", () => {
    expect(parsed.accountRecords.calendarFeed.createdAt).toBe(
      "2026-07-20T11:00:00.000Z",
    );
    expect(parsed.accountRecords.calendarFeed.rotatedAt).toBeNull();
    // The token is the third credential, not a fourth piece of bookkeeping:
    // possession of it IS read access to the reader's scheduled work, so a copy
    // in a file they might forward is the same mistake as exporting llmKeyEnc.
    // `ExportCalendarFeed` has no such field, so this is a tripwire for a future
    // widening rather than a check on today's code — which is exactly what the
    // `enc|token|secret` key tripwire below could not be relied on for alone,
    // since a token carried under a friendlier field name would slip past it.
    expect(everyKey(parsed)).not.toContain("token");
    expect(everyKey(parsed.accountRecords)).toEqual([
      "invitation",
      "provider",
      "identity",
      "note",
      "isOwnerSeed",
      "invitedAt",
      "claimedAt",
      "aiUsage",
      "count",
      "windowStartedAt",
      "updatedAt",
      "calendarFeed",
      "createdAt",
      "rotatedAt",
    ]);
  });

  it("renders every account record as null for a guest sandbox", () => {
    // A guest has no account for these to hang off, and each serialiser has to
    // render that rather than throwing on a missing nested object.
    const guest = makeSnapshot({
      account: null,
      accountRecords: { invitation: null, aiUsage: null, calendarFeed: null },
    });
    const document = JSON.parse(exportJson(guest));
    expect(document.account).toBeNull();
    expect(document.accountRecords).toEqual({
      invitation: null,
      aiUsage: null,
      calendarFeed: null,
    });
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
    expect(empty.focusPlaylists).toEqual([]);
    expect(empty.shoppingItems).toEqual([]);
    expect(empty.gamification.streak).toBeNull();
    expect(empty.gamification.badges).toEqual([]);
    // The invitation PREDATES first sign-in — it is what allowed the account to
    // exist — so an account with nothing in it still has one, while the two rows
    // that only appear once the features are used are genuinely absent.
    expect(empty.accountRecords.invitation.identity).toBe("newcomer");
    expect(empty.accountRecords.aiUsage).toBeNull();
    expect(empty.accountRecords.calendarFeed).toBeNull();
  });

  it("is deterministic — the same snapshot serialises to the same bytes", () => {
    // What makes two exports diffable, and what makes this suite assertable.
    expect(exportJson(makeSnapshot())).toBe(exportJson(makeSnapshot()));
  });
});
