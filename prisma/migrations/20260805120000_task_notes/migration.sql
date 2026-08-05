-- #44 — a freeform note on a task, threaded into the scheduled artifact.
--
-- Nullable with NO column default. NULL means "nobody has written a note", and
-- that is a state the feature reads rather than a placeholder: the note is only
-- composed into the ICS DESCRIPTION / Google Task notes when it is present, so
-- an empty string standing in for absence would put a blank line in somebody's
-- calendar entry. `normalizeTaskNote` (src/lib/task-notes.ts) collapses "" and
-- whitespace-only back to NULL for the same reason.
--
-- THE BOUND: 2000 CHARACTERS, and Google sets it, not us. A scheduled task's
-- note is written into the Google Tasks `notes` field, which the Tasks API caps
-- at 8192 characters and REJECTS above. The value sent there is a context line
-- + this note + the focus prompt + an absolute deep-link URL, so a note allowed
-- to fill that cap on its own would not fail at write time where the user could
-- see it — it would fail later, at schedule time, on a surface with no way to
-- explain itself. 2000 leaves the envelope roughly a 4x margin. The ICS path
-- imposes no competing limit: RFC 5545 bounds a CONTENT LINE at 75 octets and
-- folds past it (foldLine in src/lib/ics.ts), not the value.
--
-- char_length, NOT octet_length. `char_length` counts characters, which is what
-- Google's cap counts and what `normalizeTaskNote` clamps in; octet_length
-- would reject an all-emoji note a quarter the length of a Latin one it
-- accepts, for no reason a user could ever infer.
--
-- Prisma cannot express a CHECK, so this migration plus the comment on the
-- field in schema.prisma are the constraint's only trace in the schema. It is
-- registered in src/lib/enum-constraint-sync.integration.test.ts (LENGTH_REGISTRY)
-- so dropping it out of band fails the suite, following the #38 / #78 pattern;
-- the behavioural half — that Postgres really rejects an over-long value — is
-- src/lib/task-notes-check.integration.test.ts.
--
-- No repair statement is needed: the column does not exist yet, so every
-- existing row gets NULL and NULL satisfies the constraint. A later migration
-- that NARROWS this bound would need a repair pass before it enforces, or
-- `prisma migrate deploy` can wedge a release halfway.

ALTER TABLE "Task" ADD COLUMN "notes" TEXT;

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_notes_check"
  CHECK ("notes" IS NULL OR char_length("notes") <= 2000);
