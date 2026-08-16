-- #261 — Settings rows for `20260816120000_aging_hours_single_source` to convert,
-- so the minutes → hours arithmetic is exercised against data rather than parsed.
--
-- Seeded after the last migration BEFORE that one, which is what puts these rows
-- in place while `agingThresholdMinutes` still exists.
--
-- ## Why this seed is not optional, and why a row count cannot stand in for it
--
-- `Settings` is ALREADY populated at this point in the timeline: the init seed
-- inserts the singleton, and `20260706130912_workspaces` inserts the owner
-- workspace's row. So the harness's coverage gate — which counts rows in the
-- table a data-dependent statement touches — was already satisfied, and the
-- `UPDATE` below would have reported a clean pass having matched **nothing**:
-- every pre-existing row holds `agingThresholdMinutes = 240`, and the statement
-- is deliberately scoped to `<> 240`.
--
-- That is the exact structural property #190 exists to remove, wearing different
-- clothes. The 2026-08-07 incident was a statement that could only fail in
-- production; this is a statement that could only *do anything* in production.
-- A green harness would have meant "no row was ever converted", and the
-- assertions in `migration-data-harness.integration.test.ts` name the expected
-- hours per workspace for that reason rather than counting rows.
--
-- ## The cases, and the rounding rule each one pins
--
-- The rule is NEAREST WHOLE HOUR, floored at 1, applied only where `agingHours`
-- is still its 4-hour default.
--
-- `seed-aging-ws-round-up`
--   90 minutes → **2h**. The case the issue names by number: a user who set 90
--   minutes must not wake up on 4. It also catches the commonest wrong spelling,
--   because `"agingThresholdMinutes" / 60` is INTEGER division in Postgres and
--   truncates to 1 before `ROUND` sees anything at all.
--
-- `seed-aging-ws-round-half-even-trap`
--   150 minutes → **3h**, not 2. This is the row that pins the tie-breaking MODE.
--   `/ 60.0` makes the division `numeric`, and `ROUND(numeric)` breaks ties away
--   from zero — the same direction as `Math.round` in `updateAgingSettings`,
--   which is the function that writes this column next. A `double precision`
--   division rounds ties to even on most platforms and would store 2 here, a rule
--   that silently disagrees with the app's own UI on exactly the values a human
--   picks.
--
-- `seed-aging-ws-floor`
--   30 minutes → **1h**, the floor. Rounding alone gives 1 (`ROUND(0.5)` = 1 on
--   numeric), so the floor is not what saves this row — but 20 minutes would
--   round to 0, and an aging threshold of 0 makes every item aging the instant it
--   is captured. `GREATEST(1, …)` is the guard; this row is where it is visible.
--
-- `seed-aging-ws-both-set`
--   ⚠️ THE NEGATIVE CONTROL. 90 minutes AND a deliberately-chosen
--   `agingHours = 10`. The conversion must **not** fire: the workspace expressed
--   two intents and the hours one is the newer system, the one driving the
--   visible status pill, and the one its Settings page will write next. Without
--   this row a migration that ignored the `agingHours = 4` guard would look
--   exactly like one that honoured it, and it would silently undo an explicit
--   choice.
--
-- `seed-aging-ws-default`
--   The second negative control: both columns untouched. 240 minutes is the
--   default and means "never configured", so converting it to 4h would be a
--   no-op in value and a lie in intent — and on a workspace that had moved
--   `agingHours` and left the minutes field alone, it would overwrite the real
--   setting with the stale default. `agingHours` stays 4.
--
-- Each row needs its own `Workspace`: `Settings.workspaceId` is `@unique` with a
-- cascading foreign key, so one settings row per workspace is the only shape the
-- schema allows. `updatedAt` is explicit because the column has no database
-- default (`@updatedAt` is applied by the Prisma client, not by Postgres).

INSERT INTO "Workspace" ("id", "kind", "createdAt", "lastSeenAt")
VALUES ('seed-aging-ws-round-up',             'user', '2026-08-01 09:00:00', '2026-08-01 09:00:00'),
       ('seed-aging-ws-round-half-even-trap', 'user', '2026-08-01 09:00:00', '2026-08-01 09:00:00'),
       ('seed-aging-ws-floor',                'user', '2026-08-01 09:00:00', '2026-08-01 09:00:00'),
       ('seed-aging-ws-both-set',             'user', '2026-08-01 09:00:00', '2026-08-01 09:00:00'),
       ('seed-aging-ws-default',              'user', '2026-08-01 09:00:00', '2026-08-01 09:00:00');

INSERT INTO "Settings" ("id", "workspaceId", "agingThresholdMinutes", "agingHours", "updatedAt")
VALUES ('seed-aging-set-round-up',             'seed-aging-ws-round-up',              90, 4, now()),
       ('seed-aging-set-round-half-even-trap', 'seed-aging-ws-round-half-even-trap', 150, 4, now()),
       ('seed-aging-set-floor',                'seed-aging-ws-floor',                 30, 4, now()),
       -- Negative control: an explicitly chosen `agingHours` is never overwritten.
       ('seed-aging-set-both-set',             'seed-aging-ws-both-set',              90, 10, now()),
       -- Negative control: both columns at their defaults, nothing to convert.
       ('seed-aging-set-default',              'seed-aging-ws-default',              240, 4, now());
