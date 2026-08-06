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
    focusShuffle: false,
    focusPauseTogether: false,
    focusTimerTipDismissedAt: null,
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
      expiresAt: null,
    },
    account: {
      id: "user-1",
      provider: "gitlab",
      handle: "sam",
      email: "sam@example.com",
      role: "member",
      aiPolicy: "capped",
      aiQuota: 50,
      createdAt: new Date(Date.UTC(2026, 5, 1, 7, 0, 0)),
    },
    settings: makeSettings(),
    tasks: [makeTaskWithSteps(), makeSteplessTask(), makeUnscheduledTask()],
    inbox: [
      {
        id: "item-1",
        text: AWKWARD_INBOX_TEXT,
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
        workspaceId: WORKSPACE_ID,
      },
      {
        id: "item-2",
        text: "book the car in",
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
