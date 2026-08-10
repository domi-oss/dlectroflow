-- #199 — shopping-list mode: a place for list-shaped things that are not tasks
-- with estimates, steps and calendar blocks.
--
-- ── Why its own table and not a Task with Steps ────────────────────────────
--
-- `Step.order`, `Step.total` and `Step.estMinutes` are all NOT NULL with no
-- defaults, and `Step_estMinutes_check` (20260727194512_step_est_minutes_check)
-- pins `estMinutes >= 1` — so an estimate-less step is refused by the DATABASE
-- and every shopping item would have to carry a fabricated estimate. Worse,
-- `beginFocus` and `completeStep` (src/app/actions/focus.ts) do no kind-check, so
-- items stored as steps become focusable and streak-earning by default; keeping
-- them out would mean an "unless this is shopping" exclusion at every
-- `prisma.step.*` / `prisma.task.*` call site, forever, plus one more every time
-- somebody writes new code.
--
-- A separate table earns none of that by default, because the code that grants it
-- cannot see the rows. That is also how "no streak credit for ticking off
-- shopping" is implemented: by writing no reward code at all.
--
-- ── What comes for free, and what did not ──────────────────────────────────
--
-- Free: workspace scoping (src/lib/__tests__/scoping.harness.test.ts derives the
-- scoped-model list from `Prisma.dmmf` at runtime, so declaring `workspaceId`
-- polices every query from the first commit); account deletion and guest purge
-- (both delete the Workspace and cascade); the nightly backup (whole-database
-- `pg_dump`); the auth gate (anything not in PUBLIC_PREFIXES is authenticated).
--
-- Not free: the data export. `src/lib/export/collect.ts` names every table by
-- hand and nothing failed when a model was missing from it — `FocusPlaylist`
-- (#185) shipped absent. `src/lib/export/__tests__/model-coverage.test.ts` closes
-- that: it derives the same list from `Prisma.dmmf` and fails if a
-- workspace-scoped model is not read by the export.

CREATE TABLE "ShoppingItem" (
    "id"            TEXT         NOT NULL,
    "workspaceId"   TEXT         NOT NULL,
    "text"          TEXT         NOT NULL,
    "done"          BOOLEAN      NOT NULL DEFAULT false,
    -- The undated "saved for later" section, and the reason it is ONE boolean:
    -- there is no date, no snooze and no scheduler involvement, so nothing here
    -- can reappear on its own. It is pulled back up by hand. A `snoozedUntil`
    -- shape (BrainDumpItem's) would have made this list part of the freshness and
    -- reminder machinery, which is exactly what shopping-list mode is not.
    "savedForLater" BOOLEAN      NOT NULL DEFAULT false,
    -- Capture order. Allocated as max+1 in src/lib/shopping.ts, which two
    -- concurrent adds can read at once and therefore duplicate; the read side
    -- breaks the tie on "id" so the rendered order is stable rather than
    -- reshuffling between page loads. Cheaper than serialising every add for an
    -- outcome that is cosmetic.
    "order"         INTEGER      NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShoppingItem_pkey" PRIMARY KEY ("id")
);

-- Cascade, matching every other workspace-owned table: deleting an account
-- destroys its content in one step (see 20260718180000_workspace_cascade_fks).
ALTER TABLE "ShoppingItem"
  ADD CONSTRAINT "ShoppingItem_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Every read is `where: { workspaceId }` (the scoping invariant), so this is the
-- access path rather than a nicety.
CREATE INDEX "ShoppingItem_workspaceId_idx" ON "ShoppingItem"("workspaceId");

-- The text's length bound and its lower bound. Registered in
-- src/lib/enum-constraint-sync.integration.test.ts's LENGTH_REGISTRY, which fails
-- the suite if it is dropped or drifts from SHOPPING_ITEM_TEXT_MAX_LENGTH in
-- src/lib/shopping.ts. (That sentence was false in 20260807140000_focus_playlists
-- when it was first written and `!282` caught it — a comment claiming a guard
-- exists is worse than no comment, because it stops the next reader looking. The
-- entry exists; the behavioural half is in
-- src/lib/shopping-item-text-check.integration.test.ts.)
--
-- `char_length`, never `octet_length`: they differ by up to 4x on astral
-- characters, so a byte bound would reject an all-emoji entry a quarter the length
-- of a Latin one it accepts. Same reason Task_notes_check pins its measuring
-- function (#44).
--
-- The lower bound is the backstop for the UI promise that an empty entry is
-- refused visibly. Stated as "contains at least one non-whitespace character"
-- with a POSIX class rather than `char_length(btrim(...)) >= 1`, because
-- 20260807140000_focus_playlists shipped both of the bugs that spelling has:
-- bare `btrim` strips only a plain space (so three TABS passed), and the obvious
-- repair `btrim("text", E' \t\n\r\f\v')` is worse — Postgres's E'' syntax has no
-- `\v` escape and degrades it to a literal lowercase `v`, so a genuine entry of
-- "v" would be rejected as empty. `[[:space:]]` has no escape sequence to get
-- wrong, and `~` on a negated class also rejects the empty string without a
-- second clause.
--
-- KNOWN RESIDUAL, recorded rather than papered over: `[[:space:]]` covers ASCII
-- whitespace while JS `.trim()` also strips Unicode separators such as U+00A0, so
-- an entry of one non-breaking space is refused by the TS validator and accepted
-- here. Left alone deliberately, on the same reasoning as FocusPlaylist_name_check:
-- closing it means a Unicode property class whose behaviour varies with the
-- server's collation, trading a known narrow gap for an unknown portable one.
ALTER TABLE "ShoppingItem"
  ADD CONSTRAINT "ShoppingItem_text_check"
  CHECK ("text" ~ '[^[:space:]]' AND char_length("text") <= 200);


-- The switch. OFF for every existing workspace AND for every new one — the point
-- of the toggle is that the feature adds no surface for people who did not ask
-- for it, so there is no conversion to do and no behaviour that can change for
-- anybody who does not turn it on.
--
-- ADD COLUMN's DEFAULT is written into every existing row and is also the value
-- new rows take, and here they are wanted to be the same thing, so unlike
-- 20260806100000_settings_focus_sound_categories there is no second
-- ALTER … SET DEFAULT below.
--
-- Turning the switch back OFF hides the list; it does not delete it. The rows
-- outlive the toggle so a switch pressed by accident is not destructive, which is
-- the same reasoning #180 gives for leaving focusShuffle inert rather than
-- resetting it.
ALTER TABLE "Settings"
  ADD COLUMN "shoppingList" BOOLEAN NOT NULL DEFAULT false;
