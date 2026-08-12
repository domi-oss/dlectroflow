import type {
  Badge,
  BrainDumpItem,
  BreakdownTurn,
  DailySpark,
  DayRollup,
  FocusPlaylist,
  FocusSession,
  RewardEvent,
  Settings,
  ShoppingItem,
  Step,
  Streak,
  StreakRecord,
  Task,
} from "@prisma/client";

/**
 * #129 — the shape every export serialiser reads, and nothing else.
 *
 * The whole feature is one workspace-scoped read (`collect.ts`) followed by five
 * PURE functions over its result. That is not a stylistic preference: it puts
 * authorization in exactly one place, and it means every serialiser can be tested
 * on a hand-built snapshot with no database, no session and no mocking — which
 * is why the CSV quoting, the ICS folding and the Markdown nesting each have real
 * tests instead of a smoke test through an HTTP route.
 */

/** A task with everything that hangs off it. Steps and turns carry no
 *  `workspaceId` of their own — they are reached THROUGH the scoped task read,
 *  which is this codebase's existing idiom (see `src/app/api/ics/[taskId]`). */
export type ExportTask = Task & {
  steps: Step[];
  turns: BreakdownTurn[];
};

/**
 * The account behind the export, as far as the export is concerned.
 *
 * Two deliberate omissions:
 *
 *  - **`llmKeyEnc` is absent, and must stay absent.** It is the encrypted
 *    per-user LLM key. `json.test.ts` asserts that no ciphertext-shaped key
 *    reaches `export.json` at all, so a future column called `somethingEnc`
 *    fails a test rather than shipping in somebody's download.
 *  - **`providerSub` is absent.** It is the login mapping's internal identifier,
 *    not content: an import happens into an account you have already signed in
 *    to, so the subject is re-derived from the OAuth flow rather than restored
 *    from a file.
 *
 * `email` IS present, and that is a considered departure from the convention in
 * `currentUser()`, which deliberately never selects it. That rule exists to keep
 * the address out of RSC payloads and component props — a channel to *other*
 * people. This is the one surface whose entire purpose is to hand the data
 * subject their own data, and UK GDPR Art. 15 covers the identity the controller
 * holds. Omitting it here would be the misleading choice.
 */
export type ExportAccount = {
  id: string;
  provider: string;
  handle: string | null;
  /** #252 — the name the person chose for themselves. Personal data they
   *  supplied, so Art. 15/20 covers it exactly as it covers the address below;
   *  `null` for an account that never set one. */
  displayName: string | null;
  email: string | null;
  role: string;
  aiPolicy: string;
  aiQuota: number;
  createdAt: Date;
};

/**
 * Derived tables. In `export.json` only — never in Markdown or CSV, because
 * they do not port anywhere: a streak is recomputed from activity and a badge is
 * a fact about this app rather than about the person's work.
 */
export type ExportGamification = {
  streak: Streak | null;
  streakRecords: StreakRecord[];
  badges: Badge[];
  rewardEvents: RewardEvent[];
  dayRollups: DayRollup[];
  dailySparks: DailySpark[];
};

export type ExportSnapshot = {
  /** The instant the read happened, and the archive's own timestamp. */
  exportedAt: Date;
  workspace: {
    id: string;
    /** `user` or `guest` — a guest sandbox is exportable, and its expiry is why. */
    kind: string;
    createdAt: Date;
    expiresAt: Date | null;
  };
  /** `null` for a guest sandbox: it has no account attached, which is the point
   *  of it (see `/privacy`). */
  account: ExportAccount | null;
  /** `null` when the workspace has never had a settings row written. Reading
   *  must not create one — `getSettings()` does, so the export does not use it. */
  settings: Settings | null;
  tasks: ExportTask[];
  inbox: BrainDumpItem[];
  focusSessions: FocusSession[];
  /**
   * #185 — the workspace's own named focus playlists.
   *
   * ADDED IN REVIEW OF #199, and the omission is why
   * `__tests__/model-coverage.test.ts` exists: `FocusPlaylist` reached `main` on
   * 2026-08-07 absent from all three export files and every test stayed green,
   * because nothing derived the export's obligations from the schema. A user
   * exercising Art. 15/20 would have received an archive quietly missing a table.
   */
  focusPlaylists: FocusPlaylist[];
  /**
   * #199 — the shopping list, `savedForLater` pile included.
   *
   * The whole list, not the un-ticked part of it: an export is the artefact that
   * outlives the app, and "I had already bought this" and "I deferred this" are
   * both things the user wrote down.
   */
  shoppingItems: ShoppingItem[];
  gamification: ExportGamification;
  /**
   * Metadata about connected integrations — never a token, encrypted or
   * otherwise. `GoogleAuth` itself is excluded from the export entirely and
   * `README.md` says so, because a user must not infer that their export
   * preserves their Google connection.
   */
  integrations: {
    googleTasks: {
      configured: boolean;
      connected: boolean;
      needsReconnect: boolean;
    };
  };
};

/**
 * Every timestamp in every file goes through here.
 *
 * ISO-8601 with an EXPLICIT offset, which for an instant read out of a
 * `DateTime` column means UTC and a trailing `Z` — the ISO-8601 UTC designator,
 * i.e. `+00:00` written the short way. A bare local datetime was the thing to
 * avoid: scheduling is instance-wide-timezone today (#121 — Scheduling timezone
 * is instance-wide, not per-member), so `2026-08-03T10:00` silently changes
 * meaning the moment that setting does, and an export is exactly the artefact
 * that outlives the setting.
 *
 * `Z` rather than rendering the instance's local offset, deliberately: the
 * instance timezone is a deploy-wide value that is not part of anybody's data,
 * so baking it into every row would attribute a deployment detail to the person.
 * UTC is the same instant read by every tool that will ever open the file.
 */
export function isoStamp(d: Date): string {
  return d.toISOString();
}

/** `isoStamp` for a nullable column, rendered as an EMPTY CSV field rather than
 *  the string "null" — a spreadsheet can filter on empty and cannot on "null". */
export function isoStampOrEmpty(d: Date | null | undefined): string {
  return d == null ? "" : isoStamp(d);
}

/** `YYYY-MM-DD` in UTC, for the archive's filename. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
