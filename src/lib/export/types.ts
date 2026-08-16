import type {
  Badge,
  BrainDumpItem,
  BreakdownTurn,
  DailySpark,
  DayRollup,
  EngagementDay,
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
 * **Exactly one column of `User` is withheld: `llmKeyEnc`.** It is the encrypted
 * per-user LLM key, and it must stay absent — `json.test.ts` asserts that no
 * ciphertext-shaped key reaches `export.json` at all, so a future column called
 * `somethingEnc` fails a test rather than shipping in somebody's download. A
 * credential in a file the reader may forward to somebody is the opposite of
 * protecting them.
 *
 * Everything else `User` holds is here, and `__tests__/model-coverage.test.ts`
 * derives that list from `Prisma.dmmf` rather than trusting this comment: a new
 * column on `User` fails a test until it is either exported or argued for as a
 * credential. That guard exists because the previous version of this docblock
 * named `providerSub` as a considered omission on the grounds that an importer
 * re-derives the subject from the OAuth flow — which was true about IMPORT and
 * beside the point about ACCESS. Art. 15 covers the identifiers the controller
 * holds about the data subject, whether or not a future importer would want them
 * back, and three more columns (`status`, `lastSeenAt`, `revokedAt`) were absent
 * with no reasoning at all. Being able to state the rule as "every column but
 * one" is what makes /privacy's claim checkable.
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
  /** The provider's own stable subject for this person. Not useful to an
   *  importer — the OAuth flow re-derives it — but it is an identifier held
   *  ABOUT them, which is what Art. 15 asks for. */
  providerSub: string;
  handle: string | null;
  /** #252 — the name the person chose for themselves. Personal data they
   *  supplied, so Art. 15/20 covers it exactly as it covers the address below;
   *  `null` for an account that never set one. */
  displayName: string | null;
  email: string | null;
  role: string;
  /** `active` or `revoked`. A flag the app sets about them rather than one they
   *  chose, which is the reason it was missed and not a reason to withhold it. */
  status: string;
  aiPolicy: string;
  aiQuota: number;
  /** `null` means "whatever this instance is configured to use". The KEY that
   *  may accompany it (`llmKeyEnc`) is the withheld column; naming a provider is
   *  a configuration choice the person made, not a credential. */
  llmProvider: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  /** When access was withdrawn, or `null` if it never was. */
  revokedAt: Date | null;
  /** Written by `freezeAccount` and read by nothing today — which is exactly why
   *  a reader is entitled to see it rather than infer a purge from it. /privacy's
   *  retention section says the same thing in words. */
  purgeAfter: Date | null;
};

/**
 * The invitation that made this account possible — one `Allowlist` row.
 *
 * **The strongest of the four records this file added**, and the reason the set
 * was worth exporting rather than merely disclosing: `note` is free text that
 * *another person wrote about the reader*. /privacy discloses it as collected, so
 * it is plainly their personal data, and an archive that withheld it while the
 * page admitted holding it was handing over less than the reader is owed.
 *
 * Read by `claimedById`, which is `@unique` — one row, addressed by the id the
 * session already verified. `identity` is deliberately NOT the key: it is
 * whatever the owner typed, it is not unique across providers on its own, and
 * keying on it would be a lookup by user-supplied string instead of by a
 * verified id.
 *
 * `id` and `claimedById` are omitted as carrying nothing: the first is an
 * internal cuid and the second repeats `account.id`, which is in the same file.
 */
export type ExportInvitation = {
  provider: string;
  /** The username, email or subject that was entered to invite them. */
  identity: string;
  /** The private note whoever invited them wrote. Free text ABOUT the reader,
   *  which is why this one is not bookkeeping. `null` if none was written. */
  note: string | null;
  /** Whether claiming this invitation made them the instance owner. */
  isOwnerSeed: boolean;
  invitedAt: Date;
  claimedAt: Date | null;
};

/**
 * The fair-use meter — one `UserAiUsage` row, as STORED.
 *
 * The stored row rather than `peekUserAiUsage`'s computed view, deliberately: the
 * view reports a lapsed window as zero used, which is the right answer for the
 * Settings panel and the wrong one for an export, whose job is to reproduce what
 * is in the database. `count` here is therefore the raw counter, and
 * `windowStartedAt` is what says whether it still applies.
 */
export type ExportAiUsage = {
  count: number;
  windowStartedAt: Date;
  updatedAt: Date;
};

/**
 * The calendar subscription's audit timestamps — a `CalendarFeed` row **minus its
 * token**.
 *
 * The token is withheld, and it is the third credential rather than a fourth
 * piece of bookkeeping: possession of it IS read access to the reader's scheduled
 * work (`prisma/schema.prisma` argues that at length), so putting it in a file
 * they might forward is the same mistake as exporting `llmKeyEnc`. Withholding it
 * costs them nothing — Settings shows the URL and can re-copy it, and this
 * archive is not the route by which anybody recovers a feed.
 *
 * `getOwnFeedTimestamps` never selects the column, so the token is absent by
 * construction rather than by a serialiser remembering to drop it.
 */
export type ExportCalendarFeed = {
  createdAt: Date;
  /** `null` means the token has never been regenerated. */
  rotatedAt: Date | null;
};

/**
 * The records the app keeps ABOUT the account, as distinct from the content in
 * the workspace.
 *
 * All three were held and unexported until this change, and none of them was
 * visible to `__tests__/model-coverage.test.ts`, because that guard's predicate
 * was `workspaceId` and these three hang off `User`. That is not a coincidence —
 * it is the whole mechanism by which they were forgotten, so the predicate was
 * widened in the same commit that made the export satisfy it.
 *
 * Every field is `null` for a guest sandbox, which has no account for them to
 * hang off.
 */
export type ExportAccountRecords = {
  invitation: ExportInvitation | null;
  aiUsage: ExportAiUsage | null;
  calendarFeed: ExportCalendarFeed | null;
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
  /**
   * #233 — the per-day engagement ledger.
   *
   * It sits in `gamification` rather than beside the inbox because it is derived
   * from the person's activity rather than typed by them, which is this group's
   * whole definition. It is still exported, and for the reason the group's
   * docblock gives for `rewardEvents`: `export.json` is the lossless tier, and a
   * workspace-scoped table left out of it is one an Art. 15/20 archive silently
   * misses (#199, and `FocusPlaylist` is the precedent that reached `main` absent
   * from all three files).
   */
  engagementDays: EngagementDay[];
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
    /** Touched by `currentWorkspaceId()` on every request. Added alongside
     *  `ExportAccount.lastSeenAt` rather than left behind it: the schema has two
     *  last-seen columns, and exporting one while withholding the other is the
     *  partial-list defect this change exists to remove. `Workspace.userId` stays
     *  out as a pure foreign key that repeats `account.id`. */
    lastSeenAt: Date;
    expiresAt: Date | null;
  };
  /** `null` for a guest sandbox: it has no account attached, which is the point
   *  of it (see `/privacy`). */
  account: ExportAccount | null;
  /** The three account-scoped records — invitation, AI meter, calendar feed
   *  timestamps. All `null` for a guest sandbox. */
  accountRecords: ExportAccountRecords;
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
