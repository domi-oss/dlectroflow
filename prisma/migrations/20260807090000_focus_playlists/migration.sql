-- #185 — a workspace's own named focus playlists, and the column that selects
-- them alongside the built-in category playlists.
--
-- ── Why a table and not another array on Settings ──────────────────────────
--
-- `focusSoundCategories` (#180) is an array because a category selection is a
-- set of ten known strings. A custom playlist is a NAMED object with its own
-- track list and its own lifetime — several of them coexist, each is renamed
-- and deleted independently — so the row is the unit, not the string.
--
-- ── Why trackIds carries no CHECK constraint ───────────────────────────────
--
-- Every other pseudo-enum column in this schema is CHECK-constrained against a
-- constant in src/lib/constants.ts, and enum-constraint-sync.integration.test.ts
-- polices that. This column is the deliberate exception, and the reason is that
-- there is no closed set to mirror: track ids are CATALOGUE data. A deployment
-- with FOCUS_CATALOG_ORIGIN set has ~166 of them; one without has the ten
-- bundled with the app (#43); a self-hoster pointing at their own manifest has
-- neither. A constraint written against any one of those would reject a valid
-- playlist on the other two, and would turn "the store changed its filenames"
-- into a failed write rather than a track that quietly stops resolving.
--
-- So the guarantee is made one layer up instead: `resolveFocusPool`
-- (src/lib/focus-sounds.ts) filters the catalogue, so an id nothing carries
-- contributes nothing — exactly what already happens to a category the manifest
-- has stopped declaring.
--
-- What the database DOES enforce is size, because that is not instance-specific
-- and the write is client-callable: the name is bounded below, and the array's
-- length and element size are bounded in src/lib/focus-playlists.ts (an array
-- bound in SQL would have to be re-stated as a second literal, and the action is
-- the only writer).

CREATE TABLE "FocusPlaylist" (
    "id"          TEXT      NOT NULL,
    "workspaceId" TEXT      NOT NULL,
    "name"        TEXT      NOT NULL,
    -- Empty is a legal, reachable state: a playlist created before its first
    -- category is added. The player treats it the way it treats a playlist whose
    -- ids have all left the manifest — it contributes nothing to the pool.
    "trackIds"    TEXT[]    NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FocusPlaylist_pkey" PRIMARY KEY ("id")
);

-- Cascade, matching every other workspace-owned table: deleting an account
-- destroys its content in one step (see 20260718180000_workspace_cascade_fks).
ALTER TABLE "FocusPlaylist"
  ADD CONSTRAINT "FocusPlaylist_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Every read is `where: { workspaceId }` (the scoping invariant), so this is the
-- access path rather than a nicety.
CREATE INDEX "FocusPlaylist_workspaceId_idx" ON "FocusPlaylist"("workspaceId");

-- Name uniqueness, per workspace, on the EXACT stored spelling.
--
-- The rule the app promises is case-INSENSITIVE uniqueness, and this index is
-- only its exact-spelling half. The other half is a scoped case-insensitive
-- lookup in createFocusPlaylist / renameFocusPlaylist, and the split is
-- deliberate: Prisma 6 cannot express an expression index (`lower("name")`) in
-- schema.prisma, so a functional unique index would exist in the database and
-- not in the schema — drift that the next `prisma migrate dev` would offer to
-- "fix" by dropping it.
--
-- What that costs is written down where it is enforced
-- (src/app/actions/focus-playlists.ts): two requests racing can land "Deep work"
-- and "deep work" together. That is a cosmetic outcome with no data-integrity
-- consequence, and it is the residual the app accepts in exchange for the
-- constraint being visible in the schema. What the index does guarantee — no two
-- rows with the identical name — is the case that actually breaks the UI, since
-- the name is the only thing distinguishing one row's "Delete …" from another's.
CREATE UNIQUE INDEX "FocusPlaylist_workspaceId_name_key"
  ON "FocusPlaylist"("workspaceId", "name");

-- The name's length bound. Registered in
-- src/lib/enum-constraint-sync.integration.test.ts's LENGTH_REGISTRY, which
-- fails the suite if it is dropped or drifts from FOCUS_PLAYLIST_NAME_MAX_LENGTH
-- in src/lib/focus-playlists.ts.
--
-- `char_length`, never `octet_length`: they differ by up to 4x on astral
-- characters, so a byte bound would reject an all-emoji name a quarter the
-- length of a Latin one it accepts. The same reason Task_notes_check pins its
-- measuring function (#44).
--
-- The lower bound is here too, and it is not decoration. "An empty or
-- whitespace-only name must be refused visibly" is a UI promise (#185); this is
-- what makes it a fact. `btrim` so a name of three spaces cannot satisfy it —
-- the normaliser trims before storing, and this is the backstop for a writer
-- that does not.
ALTER TABLE "FocusPlaylist"
  ADD CONSTRAINT "FocusPlaylist_name_check"
  CHECK (char_length(btrim("name")) >= 1 AND char_length("name") <= 60);

-- The selection. Sibling of Settings.focusSoundCategories, and empty for every
-- existing row — nobody has a custom playlist yet, so there is no conversion to
-- do and no behaviour that can change.
--
-- No containment CHECK, because there is no closed set: the legal values are the
-- cuids of this workspace's own FocusPlaylist rows, which change on every create
-- and delete. No foreign key either — Postgres has none for an element of a
-- scalar array. Referential integrity is therefore maintained by the writers:
-- deleteFocusPlaylist strips the id from every selection naming it, and
-- updateFocusPlaylistSelection filters to playlists the resolved workspace owns.
-- An id that outlives both (a delete racing a tick) resolves to no tracks and is
-- ignored, which is the same never-go-silent behaviour a retired category slug
-- already gets.
--
-- ADD COLUMN's default is written into every existing row AND is the value new
-- rows take, and here they are wanted to be the same thing, so unlike #180's
-- column there is no second ALTER … SET DEFAULT below: "no custom playlists
-- selected" is correct for an existing workspace and for a brand-new one alike.
ALTER TABLE "Settings"
  ADD COLUMN "focusPlaylistIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
