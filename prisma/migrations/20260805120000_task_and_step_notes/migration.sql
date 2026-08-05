-- #44 — a freeform note on a task AND on a step, threaded into the scheduled
-- artifact.
--
-- ONE migration for both columns, deliberately. They are the same decision
-- applied at two grains: same type, same bound, same measuring function, same
-- NULL semantics. Splitting them would leave two migrations that must be read
-- together to understand either, and would let a later change to one silently
-- diverge from the other.
--
-- Both nullable with NO column default. NULL means "nobody has written a note",
-- and that is a state the feature reads rather than a placeholder: a note is
-- only composed into the ICS DESCRIPTION / Google Task notes when it is
-- present, so an empty string standing in for absence would put a blank line in
-- somebody's calendar entry. `normalizeTaskNote` (src/lib/task-notes.ts)
-- collapses "" and whitespace-only back to NULL for the same reason.
--
-- THE BOUND: 2000 CHARACTERS EACH, and Google sets it, not us. A scheduled
-- step's note is written into the Google Tasks `notes` field, which the Tasks
-- API caps at 8192 characters and REJECTS above. The value sent there is a
-- context line + the TASK note + the STEP note + the focus prompt + an absolute
-- deep-link URL, so 2000 each is chosen to leave that envelope roughly a 2x
-- margin even when both notes are full. A column allowed to fill the cap on its
-- own would not fail at write time where the user could see it — it would fail
-- later, at schedule time, on a surface with no way to explain itself.
--
-- char_length, NOT octet_length. `char_length` counts characters, which is what
-- Google's cap counts and what `normalizeTaskNote` clamps in; octet_length
-- would reject an all-emoji note a quarter the length of a Latin one it
-- accepts, for no reason a user could ever infer.
--
-- Prisma cannot express a CHECK, so this migration plus the comments on the two
-- fields in schema.prisma are the constraints' only trace in the schema. Both
-- are registered in src/lib/enum-constraint-sync.integration.test.ts
-- (LENGTH_REGISTRY) so dropping one out of band fails the suite, following the
-- #38 / #78 pattern; the behavioural half — that Postgres really rejects an
-- over-long value — is src/lib/notes-length-check.integration.test.ts.
--
-- No repair statement is needed: neither column exists yet, so every existing
-- row gets NULL and NULL satisfies both constraints. A later migration that
-- NARROWS either bound would need a repair pass before it enforces, or
-- `prisma migrate deploy` can wedge a release halfway.

ALTER TABLE "Task" ADD COLUMN "notes" TEXT;
ALTER TABLE "Step" ADD COLUMN "notes" TEXT;

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_notes_check"
  CHECK ("notes" IS NULL OR char_length("notes") <= 2000);

ALTER TABLE "Step"
  ADD CONSTRAINT "Step_notes_check"
  CHECK ("notes" IS NULL OR char_length("notes") <= 2000);
