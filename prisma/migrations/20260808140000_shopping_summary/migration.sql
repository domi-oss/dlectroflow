-- #199 — the inbox's shopping-list summary line.
--
-- ── What this row does and does not hold ───────────────────────────────────
--
-- It holds WHETHER to show a summary. It does NOT hold the count, and it does not
-- hold the text either. The count is `SELECT count(*) FROM "ShoppingItem"` at
-- render time (src/lib/shopping-summary.ts), from the same predicate the
-- /shopping header uses for its own count.
--
-- That is the entire reason the shape is this way. The owner chose a real
-- persisted row over a line derived on the fly, and the risk of that choice is a
-- stored number drifting away from the list it describes. A row that stores no
-- number cannot drift: a missed sync — a crash between the item write and this
-- one, or a future writer that forgets — can only leave the row outliving the
-- list, and the read side answers that with no summary at all. There is no state
-- of this database in which a count is displayed that the list does not have.
--
-- ── Why its own table, and not a generated row in BrainDumpItem ────────────
--
-- A generated row in "BrainDumpItem" is visible to every query against that
-- table (eighteen files today), and two of those are not cosmetic:
--
--   * `maybeAwardInboxZero` (src/lib/rewards.ts) counts un-triaged inbox items,
--     so a permanent generated row would make INBOX ZERO UNREACHABLE for anybody
--     who keeps a shopping list — a badge and a daily reward silently switched
--     off by an unrelated feature.
--   * `bucketItems` / `libraryBuckets` (src/components/inbox/bucket.ts) file
--     items by status / snoozedUntil / completedAt, so dismissing the summary
--     would drop it into the Library's "saved for later" or "done" tab, where it
--     is not something anybody can act on.
--
-- The freshness clock, the untriaged nav badge and the daily-review nudge would
-- each need their own exclusion on top. A separate table makes all of that true
-- by construction rather than by seven exclusions a future query can forget —
-- the same reasoning "ShoppingItem" itself rests on.
--
-- ── The primary key is the workspace ───────────────────────────────────────
--
-- One summary per workspace, enforced by the key rather than by a uniqueness rule
-- somebody has to remember. It also settles concurrency for free: `upsert` on the
-- primary key means two concurrent "add a shopping item" requests cannot create
-- two summary rows, because the loser's INSERT collides and becomes an UPDATE. A
-- SELECT-then-INSERT would need SERIALIZABLE or an advisory lock to say the same
-- thing.
--
-- No index beyond the primary key: every read is by workspace, which IS the key.

CREATE TABLE "ShoppingSummary" (
    "workspaceId" TEXT         NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- When the summary was dismissed from the inbox. NULL means "showing".
    --
    -- Cleared again by the next shopping write that can INCREASE the count:
    -- adding an item, un-ticking one, or pulling one back up out of
    -- saved-for-later. Ticking off, saving for later, deleting and renaming leave
    -- a dismissal alone, because a change that cannot make the list longer is not
    -- a new reason to remind anybody — dismissing the line and then ticking items
    -- off would otherwise resurrect it as a reward for making progress.
    --
    -- ONE column, not a "ticked off" and a "snoozed until". The issue asks for
    -- snoozing to behave consistently with ticking off, and one gesture with one
    -- meaning is the most consistent that gets; two controls doing the same thing
    -- would be two things to explain and a place for them to drift apart. There
    -- is deliberately no date arithmetic here at all: nothing reappears on a
    -- timer, only in response to the list growing.
    "clearedAt"   TIMESTAMP(3),

    CONSTRAINT "ShoppingSummary_pkey" PRIMARY KEY ("workspaceId")
);

-- Cascade, matching every other workspace-owned table: deleting an account
-- destroys its content in one step (see 20260718180000_workspace_cascade_fks).
-- Deleting the workspace is also what the guest purge and account deletion do, so
-- this row needs no hand-wiring in either.
ALTER TABLE "ShoppingSummary"
  ADD CONSTRAINT "ShoppingSummary_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
