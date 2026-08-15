import type { Settings } from "@prisma/client";
import type { ExportSnapshot, ExportTask } from "../types";

/**
 * #129 — one snapshot fixture, shared by every serialiser test.
 *
 * It lives in `__tests__/` rather than beside the modules because it is not app
 * code and nothing in `src/app` or `src/components` may import it; the directory
 * name is the signal, and it matches `src/lib/__tests__/` which the harness tests
 * already use.
 *
 * The content is chosen to be hostile in the specific ways real data is hostile,
 * because a fixture of tidy one-line strings tests the serialisers against input
 * they will never see:
 *
 *  - **A newline inside task and inbox text.** The case that breaks naive CSV,
 *    and it is not hypothetical: both are typed into a textarea.
 *  - **A comma, a double quote and a semicolon.** RFC 4180 quoting and
 *    RFC 5545 escaping respectively.
 *  - **Emoji, including one outside the BMP.** ICS folding counts octets.
 *  - **A stepless task with only a due date**, which is the one shape that
 *    produces a task-level calendar event.
 *  - **`estimateHistory` as the JSON *string* the column really holds**, plus one
 *    step where it is null and one where it is unparseable.
 */
const WORKSPACE_ID = "ws-fixture";

/** A task whose text contains every character class that needs escaping. */
export const AWKWARD_TITLE = 'Ship "the thing",\nwith a newline; and a 🚀';

export const AWKWARD_INBOX_TEXT =
  'remember to call the dentist, ask about the "deep clean"\nand the price';

export function makeSettings(overrides: Partial<Settings> = {}): Settings {
  // Built from the generated type so a new column with no default breaks the
  // fixture at compile time rather than at runtime. Values are the schema
  // defaults except where a test needs to see something distinctive.
  return {
    id: WORKSPACE_ID,
    agingThresholdMinutes: 240,
    demoOverrideSeconds: null,
    defaultFromEstimate: true,
    addTimeIncrementMin: 5,
    workdayEndTime: "17:00",
    roundupDemoOverride: false,
    roundupEmailEnabled: false,
    roundupEmail: null,
    workingDays: "1,2,3,4,5",
    breakdownModel: null,
    voice: "playful",
    agingHours: 4,
    overdueHours: 8,
    wayOverdueHours: 12,
    welcomeDismissedAt: null,
    firstRunPreview: false,
    notifyRoundup: true,
    notifyAging: true,
    notifyDailyReview: false,
    dailyReviewNudgeTime: "17:00",
    focusTimerStyle: null,
    focusMinimalMode: false,
    focusKeepAwake: true,
    focusAlarmEnabled: true,
    focusSound: "off",
    // #180 — the empty array is "play the whole catalogue", which is what #70's
    // NULL meant, so it stays the right value for a baseline fixture. Held at
    // off/[]/false rather than the new-account defaults on purpose: this fixture
    // is a row an EXISTING account could have, and the export's job is to
    // reproduce what was stored, not what a fresh install would store.
    focusSoundCategories: [],
    // #185 — held at `[]` for the same reason as its sibling above: this
    // fixture is a row an EXISTING account could have, and an account that
    // predates custom playlists has selected none. The export's job is to
    // reproduce what was stored, not what a fresh install would store.
    focusPlaylistIds: [],
    focusShuffle: false,
    focusPauseTogether: false,
    focusTimerTipDismissedAt: null,
    // #252 — at the schema default (on). This fixture is a row an existing
    // account could have, and the migration leaves every existing row at the
    // column's default, so `true` is what one of them really holds.
    focusQuickAccess: true,
    // #199 — held at the schema default. Shopping-list mode is off unless asked
    // for, so "an existing account that never turned it on" is the baseline row,
    // and `makeSnapshot` below still carries shopping items: the export reproduces
    // what was STORED, and turning the switch off hides the list rather than
    // deleting it.
    shoppingList: false,
    completeStrikethrough: true,
    completeTickColor: "green",
    typeface: "figtree",
    updatedAt: new Date(Date.UTC(2026, 6, 1, 8, 0, 0)),
    workspaceId: WORKSPACE_ID,
    ...overrides,
  };
}

function makeTaskWithSteps(): ExportTask {
  return {
    id: "task-1",
    title: AWKWARD_TITLE,
    source: "braindump",
    createdAt: new Date(Date.UTC(2026, 6, 1, 9, 0, 0)),
    status: "active",
    parentEmoji: "🚀",
    googleTaskId: "g-task-1",
    googleTaskListId: "g-list-1",
    scheduledAt: new Date(Date.UTC(2026, 6, 2, 8, 0, 0)),
    scheduledVia: "ics",
    scheduleDueAt: new Date(Date.UTC(2026, 6, 5, 17, 0, 0)),
    schedulePriority: "high",
    scheduleHours: "work",
    // #44 — deliberately MULTI-LINE and multi-paragraph: the note is free text
    // typed by the data subject, and the tiers disagree about how to carry it
    // (quoted in `tasks.md`, verbatim in `export.json`, absent from the CSVs).
    // A single-line fixture would let all three look correct.
    notes: "Bring the Figma link\n\ncall before 5",
    workspaceId: WORKSPACE_ID,
    steps: [
      {
        id: "step-1",
        taskId: "task-1",
        text: "Draft the outline, then stop",
        order: 1,
        total: 2,
        estMinutes: 15,
        subtaskEmoji: "📝",
        googleTaskId: null,
        googleTaskListId: null,
        scheduledAt: new Date(Date.UTC(2026, 6, 2, 9, 0, 0)),
        done: true,
        // #44 — a step-level note, so the export tiers are exercised at BOTH
        // grains. `tasks.md` quotes it under its step, `export.json` reproduces
        // it verbatim, and the CSVs drop it like every other free-text column.
        notes: "the login page, not the marketing one",
        // The column holds a JSON *string*, which is the whole reason
        // export.json has to expand it.
        estimateHistory: "[10,15]",
        createdAt: new Date(Date.UTC(2026, 6, 1, 9, 1, 0)),
      },
      {
        id: "step-2",
        taskId: "task-1",
        text: "Write it\nacross two lines",
        order: 2,
        total: 2,
        estMinutes: 30,
        subtaskEmoji: null,
        googleTaskId: null,
        googleTaskListId: null,
        scheduledAt: null,
        done: false,
        notes: null,
        estimateHistory: null,
        createdAt: new Date(Date.UTC(2026, 6, 1, 9, 2, 0)),
      },
    ],
    turns: [
      {
        id: "turn-1",
        taskId: "task-1",
        role: "user",
        message: "I keep putting this off; it feels enormous.",
        proposedSteps: null,
        createdAt: new Date(Date.UTC(2026, 6, 1, 9, 0, 30)),
      },
      {
        id: "turn-2",
        taskId: "task-1",
        role: "assistant",
        message: "Two steps.\n\nFirst, draft an outline.",
        proposedSteps: '[{"text":"Draft the outline","estMinutes":15}]',
        createdAt: new Date(Date.UTC(2026, 6, 1, 9, 0, 45)),
      },
    ],
  };
}

/** Stepless, with a due date and nothing else — the only shape that produces a
 *  task-level VEVENT. */
function makeSteplessTask(): ExportTask {
  return {
    id: "task-2",
    title: "Renew the passport",
    source: "manual",
    createdAt: new Date(Date.UTC(2026, 6, 3, 10, 0, 0)),
    status: "done",
    parentEmoji: null,
    googleTaskId: null,
    googleTaskListId: null,
    scheduledAt: null,
    scheduledVia: null,
    scheduleDueAt: new Date(Date.UTC(2026, 6, 10, 12, 0, 0)),
    schedulePriority: null,
    scheduleHours: null,
    // No note — the common case, and what keeps the "omits what it has no
    // value for" assertions honest (#44).
    notes: null,
    workspaceId: WORKSPACE_ID,
    steps: [],
    turns: [],
  };
}

/** A task that is scheduled but has no due date and no scheduled step — the
 *  shape that deliberately produces NO calendar event. */
function makeUnscheduledTask(): ExportTask {
  return {
    id: "task-3",
    title: "Tidy the garage",
    source: "manual",
    createdAt: new Date(Date.UTC(2026, 6, 4, 11, 0, 0)),
    status: "archived",
    parentEmoji: null,
    googleTaskId: null,
    googleTaskListId: null,
    scheduledAt: new Date(Date.UTC(2026, 6, 4, 11, 5, 0)),
    scheduledVia: "google",
    scheduleDueAt: null,
    schedulePriority: null,
    scheduleHours: null,
    notes: null,
    workspaceId: WORKSPACE_ID,
    steps: [],
    turns: [],
  };
}

export function makeSnapshot(
  overrides: Partial<ExportSnapshot> = {},
): ExportSnapshot {
  return {
    exportedAt: new Date(Date.UTC(2026, 7, 3, 9, 30, 0)),
    workspace: {
      id: WORKSPACE_ID,
      kind: "user",
      createdAt: new Date(Date.UTC(2026, 5, 1, 7, 0, 0)),
      lastSeenAt: new Date(Date.UTC(2026, 7, 3, 9, 29, 0)),
      expiresAt: null,
    },
    account: {
      id: "user-1",
      provider: "gitlab",
      // A GitLab subject is a numeric string. Distinctive here so an assertion
      // that it reached the archive cannot pass on some other field's value.
      providerSub: "gitlab-sub-778201",
      handle: "sam",
      // #252 — null, so the fixture stays a row an account that predates the
      // column really has: the migration adds it nullable and backfills nothing.
      displayName: null,
      email: "sam@example.com",
      role: "member",
      status: "active",
      aiPolicy: "capped",
      aiQuota: 50,
      // At the schema default (null = the instance's own provider). The account
      // that saved a key is not the baseline row.
      llmProvider: null,
      createdAt: new Date(Date.UTC(2026, 5, 1, 7, 0, 0)),
      lastSeenAt: new Date(Date.UTC(2026, 7, 3, 9, 29, 0)),
      // An active account, so both of these are null — and they are spelled out
      // rather than omitted, because this literal is typed against
      // `ExportAccount` and that is what makes a new column a compile error here
      // instead of a silently-missing export field.
      revokedAt: null,
      purgeAfter: null,
    },
    accountRecords: {
      invitation: {
        provider: "gitlab",
        identity: "sam",
        // The whole reason this record is exported rather than disclosed and
        // withheld: free text ANOTHER PERSON wrote about the data subject. A
        // comma and an apostrophe because it is typed into a free-text field,
        // and distinctive enough that a search for it cannot match anything else
        // in the archive.
        note: "met at the ADHD meetup, wants the shopping list beta",
        isOwnerSeed: false,
        invitedAt: new Date(Date.UTC(2026, 4, 28, 14, 0, 0)),
        claimedAt: new Date(Date.UTC(2026, 5, 1, 7, 0, 0)),
      },
      aiUsage: {
        count: 7,
        windowStartedAt: new Date(Date.UTC(2026, 7, 3, 6, 0, 0)),
        updatedAt: new Date(Date.UTC(2026, 7, 3, 8, 45, 0)),
      },
      calendarFeed: {
        createdAt: new Date(Date.UTC(2026, 6, 20, 11, 0, 0)),
        // Never rotated — the ordinary case, and the null path for the one
        // nullable column on the row.
        rotatedAt: null,
      },
    },
    settings: makeSettings(),
    tasks: [makeTaskWithSteps(), makeSteplessTask(), makeUnscheduledTask()],
    inbox: [
      {
        id: "item-1",
        text: AWKWARD_INBOX_TEXT,
        // #175 — null is the ordinary case: only a capture replayed from the
        // offline queue carries a clientKey, and the export fixture is an online
        // one. Spelled out rather than omitted because this literal is typed
        // against the whole model, which is what makes a new column a compile
        // error here instead of a silently-missing export field.
        clientKey: null,
        createdAt: new Date(Date.UTC(2026, 6, 1, 7, 0, 0)),
        status: "inbox",
        triagedAt: null,
        remindedAt: null,
        snoozedUntil: null,
        freshenedAt: null,
        promptDismissedAt: null,
        completedAt: null,
        estMinutes: 5,
        breakdownRequestedAt: null,
        taskId: null,
        // #186 added notes + the three schedule columns to BrainDumpItem. This
        // fixture is the export golden master, so it has to carry every column
        // the model has — an absent one here means the exporter is never asked
        // to emit it and a regression ships silently. item-1 leaves them empty
        // on purpose; item-2 below populates them, so both paths are covered.
        notes: null,
        scheduleDueAt: null,
        schedulePriority: null,
        scheduleHours: null,
        workspaceId: WORKSPACE_ID,
      },
      {
        id: "item-2",
        text: "book the car in",
        clientKey: null,
        createdAt: new Date(Date.UTC(2026, 6, 2, 7, 0, 0)),
        status: "triaged",
        triagedAt: new Date(Date.UTC(2026, 6, 2, 7, 30, 0)),
        remindedAt: null,
        snoozedUntil: null,
        freshenedAt: null,
        promptDismissedAt: null,
        completedAt: new Date(Date.UTC(2026, 6, 2, 18, 0, 0)),
        estMinutes: null,
        breakdownRequestedAt: null,
        taskId: "task-1",
        // Populated, so the exporter's handling of a scheduled + noted item is
        // exercised rather than only its null path.
        notes: "ring them before 10, they close for lunch",
        scheduleDueAt: new Date(Date.UTC(2026, 6, 9, 9, 0, 0)),
        schedulePriority: "high",
        scheduleHours: "work",
        workspaceId: WORKSPACE_ID,
      },
    ],
    focusSessions: [
      {
        id: "focus-1",
        stepId: "step-1",
        taskId: "task-1",
        plannedMin: 15,
        addedMin: 5,
        startedAt: new Date(Date.UTC(2026, 6, 2, 9, 0, 0)),
        endedAt: new Date(Date.UTC(2026, 6, 2, 9, 20, 0)),
        durationMin: 20,
        outcome: "completed",
        workspaceId: WORKSPACE_ID,
        pausedAt: null,
        accumulatedPausedMs: 0,
      },
    ],
    focusPlaylists: [
      {
        id: "playlist-1",
        workspaceId: WORKSPACE_ID,
        // #185 — a name with a comma and an emoji, for the same reason the task
        // title has them: this is free text the data subject typed.
        name: "Deep work, mornings 🎧",
        trackIds: ["catalog:rain-01.mp3", "bundled-piano"],
        createdAt: new Date(Date.UTC(2026, 6, 1, 10, 0, 0)),
      },
    ],
    shoppingItems: [
      {
        id: "shop-1",
        workspaceId: WORKSPACE_ID,
        // #199 — a comma and a quote, because item text is free text typed into a
        // single-line field and `export.json` is the only tier that must carry it
        // back verbatim.
        text: 'oat milk, the "barista" one',
        done: false,
        savedForLater: false,
        order: 1,
        createdAt: new Date(Date.UTC(2026, 6, 3, 7, 0, 0)),
      },
      {
        id: "shop-2",
        workspaceId: WORKSPACE_ID,
        text: "batteries",
        done: true,
        savedForLater: false,
        order: 2,
        createdAt: new Date(Date.UTC(2026, 6, 3, 7, 1, 0)),
      },
      {
        // The saved-for-later pile IS exported: "I deferred this" is something
        // the data subject wrote down, so an export that dropped it would be
        // handing over less than they have.
        id: "shop-3",
        workspaceId: WORKSPACE_ID,
        text: "a bigger frying pan",
        done: false,
        savedForLater: true,
        order: 3,
        createdAt: new Date(Date.UTC(2026, 6, 3, 7, 2, 0)),
      },
    ],
    gamification: {
      streak: {
        id: "streak-1",
        current: 3,
        lastActiveWorkday: "2026-07-02",
        workspaceId: WORKSPACE_ID,
      },
      streakRecords: [
        {
          id: "rec-1",
          length: 5,
          startedAt: new Date(Date.UTC(2026, 5, 1, 0, 0, 0)),
          endedAt: new Date(Date.UTC(2026, 5, 6, 0, 0, 0)),
          workspaceId: WORKSPACE_ID,
        },
      ],
      badges: [
        {
          id: "badge-1",
          key: "first_breakdown",
          earnedAt: new Date(Date.UTC(2026, 5, 1, 9, 0, 0)),
          workspaceId: WORKSPACE_ID,
        },
      ],
      rewardEvents: [
        {
          id: "reward-1",
          type: "step_done",
          points: 10,
          createdAt: new Date(Date.UTC(2026, 6, 2, 9, 20, 0)),
          workspaceId: WORKSPACE_ID,
        },
      ],
      dayRollups: [
        {
          id: "rollup-1",
          date: "2026-07-02",
          focusMin: 20,
          sessions: 1,
          stepsDone: 1,
          pointsEarned: 10,
          streakDay: 3,
          narrative: "One step, and it was the hard one.",
          emailedAt: null,
          workspaceId: WORKSPACE_ID,
        },
      ],
      dailySparks: [
        {
          id: "spark-1",
          date: "2026-07-02",
          quote: "Start where you are.",
          source: "fallback",
          workspaceId: WORKSPACE_ID,
        },
      ],
    },
    integrations: {
      googleTasks: { configured: true, connected: true, needsReconnect: false },
    },
    ...overrides,
  };
}

/**
 * The empty state: a brand-new account that has opened the app and done nothing.
 * No tasks, no inbox, no settings row (nothing has written one), no streak.
 * Every serialiser has to produce a valid file from this.
 */
export function makeEmptySnapshot(): ExportSnapshot {
  return makeSnapshot({
    settings: null,
    tasks: [],
    inbox: [],
    focusSessions: [],
    focusPlaylists: [],
    shoppingItems: [],
    accountRecords: {
      // The invitation survives into the empty state on purpose: it PREDATES
      // first sign-in — it is what allowed the account to exist at all — so an
      // account with nothing in it still has one. The other two rows are written
      // by using the features, so a brand-new account genuinely has neither, and
      // that is the null path every serialiser has to render.
      invitation: {
        provider: "gitlab",
        identity: "newcomer",
        note: null,
        isOwnerSeed: false,
        invitedAt: new Date(Date.UTC(2026, 5, 1, 6, 0, 0)),
        claimedAt: new Date(Date.UTC(2026, 5, 1, 7, 0, 0)),
      },
      aiUsage: null,
      calendarFeed: null,
    },
    gamification: {
      streak: null,
      streakRecords: [],
      badges: [],
      rewardEvents: [],
      dayRollups: [],
      dailySparks: [],
    },
    integrations: {
      googleTasks: {
        configured: true,
        connected: false,
        needsReconnect: false,
      },
    },
  });
}
