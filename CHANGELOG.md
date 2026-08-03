# Changelog

All notable changes to **dlectroflow** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is pre-`1.0`, it stays on the `v0.x` line; `v1.0.0` will mark the
stability promise. Each pushed `vX.Y.Z` git tag builds a versioned container image
(`:vX.Y.Z`) alongside `:latest`. **Upgrade sequentially through minor versions**
(Prisma migrations run on container start); downgrades are not supported.

Sections group changes as **Added / Changed / Fixed / Security**. **Breaking
changes** and **new required environment variables** are called out explicitly so
operators upgrading a self-hosted instance don't get surprised.

## [Unreleased]

> Shipped to production but not yet tagged. At cut time the entries below move
> under a new `## [X.Y.Z] - <date>` heading, leaving `## [Unreleased]` empty and
> **this note with it** — the note describes the ritual, so it belongs to
> whichever section is currently open, not to the release just closed. (Read the
> older wording literally and the note migrates into the released section, taking
> the instructions with it.) The move happens **in the same commit that bumps
> `package.json`, `package-lock.json` and `charts/dlectroflow/Chart.yaml` to that
> version, before the tag is pushed.** `src/lib/version-hygiene.test.ts` fails
> until the three it checks agree; the full cut checklist is in `CLAUDE.md`
> ("CI & release" → "Cutting a release"). v0.4.0 was tagged without the bump
> (#148), so the image published as `:v0.4.0` was built from a tree that called
> itself 0.3.0.

### Added

- **The self-host Compose stack now copies each database dump off the host
  (#162).** It previously dumped to `./backups` on the same disk it was
  protecting: a backup should not share a failure domain with the thing it backs
  up, and the database is the one asset in that stack that cannot be rebuilt from
  source. A new `backup-upload` service copies every dump to a Backblaze B2
  bucket; the host's own retained copy stays, and both now carry the same
  filename so they can be matched and verified against each other.
  - **New optional environment variables**: `B2_BUCKET`, `B2_PREFIX`,
    `B2_KEY_ID`, `B2_APP_KEY` in `.env.prod`. Leave them unset and nothing
    changes — `backup` alone still works for anyone copying dumps off some other
    way, and `backup-upload` refuses to run rather than appearing to succeed.
  - **The crontab line changes** from `run --rm backup` to
    `run --rm backup-upload`, which takes the dump and uploads it in one
    invocation. `docs/self-host-vps.md` has the walkthrough, including how to
    scope the B2 application key: one bucket, one prefix, `writeFiles` only, so a
    compromised host can neither read existing backups out nor delete them. The
    read-capable key stays off the host, which makes a restore drill an off-host
    task by construction.
  - **The dump gained `--no-owner --no-privileges`**, so it restores under any
    role name — without them a restore into a scratch database on a rescue host
    fails on every `GRANT` and `OWNER TO`.
  - **A size guard and a two-step write.** The dump is written to a `.partial`
    name and only promoted after passing a minimum-size check, so a degenerate
    dump cannot become "the backup". Measured: a dump of an empty database is
    under 400 bytes, and a `pg_dump` that fails at the head of `pg_dump | gzip`
    leaves gzip's 20-byte output behind — which is also why every stage uses
    `set -euo pipefail` rather than a bare `set -eu`, under which that pipeline
    exits 0.
  - **Rehearsed end to end**, not just written: a dump taken by the stack,
    uploaded, pulled back down, restored into a fresh digest-pinned
    `postgres:16.14` under a different role name, and compared per table against
    the source — row counts and a content hash for all 20 tables. The comparison
    was itself checked against an empty database and against a five-row deletion,
    so the match means something. Both guards were made to fire on purpose.
  - `backup-hygiene` grows a Compose walk beside its Helm one and fails the build
    if any of these properties is removed.

- Optional second backup destination: the prod database CronJob can now upload
  each dump to a Backblaze B2 bucket alongside the existing GCS upload, writing
  the same timestamped filename to both. Off by default; enabled per-environment
  with `BACKUP_B2_ENABLED`. B2 verifies the upload server-side — rclone sends an
  `X-Bz-Content-Sha1` and B2 rejects a mismatch — and a new `backup-hygiene`
  guard fails the build if either destination is removed.

- **A member can delete their own account (#153).** Settings → Account gains a
  **Delete my account** control. v0.5.0 put other people's data in the database
  and the published Privacy Policy names an individual as data controller, so
  UK GDPR Art. 17 erasure is an obligation that already existed — and until now
  the only way to exercise it was to ask the owner to run it on your behalf,
  because every route into the account lifecycle was `isOwnerRequest()`-gated.
  - **It freezes, it does not destroy.** The action writes the same
    `revokedAt` / `purgeAfter` window the owner's Revoke writes, so an accidental
    self-deletion is exactly as recoverable as an accidental revoke. The
    confirmation says so — including the part that is not automatic yet: nothing
    reads `purgeAfter`, so the final deletion is still a hand operation, which
    is what /privacy has said since #123.
  - **The Google grant is withdrawn at Google first (#126).** The freeze
    sequence moved into `freezeAccount` (`src/lib/account-lifecycle.ts`) rather
    than being written a second time, so the new entry point cannot skip the
    revoke — a frozen account resolves to `null` in `currentUser()` and can no
    longer reach its own Disconnect control, which is precisely the state that
    ordering exists to prevent.
  - **The action takes no arguments.** The account it ends is the session's, so
    there is nothing for a hand-rolled POST to point at somebody else's row.
  - **The owner is refused**, for the reason `revokePerson` already refuses
    owner self-revocation: an instance whose owner deleted themselves has no
    route back through the UI. They get the sentence explaining why, not a
    control that could only fail.
  - **The confirmation is a real modal dialog**, not an inline row and not
    `confirm()`: `role="alertdialog"`, focus trapped and restored to the
    trigger, Escape and Cancel both an exit, and the word `delete` typed before
    the destructive button enables. The destructive read is carried by the word
    "Permanent" and by the button's own label, not by colour (WCAG 1.4.1), and
    both controls meet the 44px target size at 390px (WCAG 2.5.5).

### Changed

- **Privacy Policy — effective date 2 August 2026.** The Erasure right now names
  the self-serve control and its one exception (the owner's own account), and
  the retention section says what deleting your own account does. How a data
  subject exercises an Art. 17 right is part of the Art. 12/13 disclosure, so it
  is a substantive change rather than a copy tweak.
- `docs/legal.md`'s "Google revocation: the gap the pages admit" section was
  stale — it still described freeze and delete as paths that never call Google's
  revoke endpoint, which #126 fixed in v0.5.0. Corrected, and the residue that
  *is* still true (the revoke is a request Google can refuse) is stated
  separately so it does not get lost with it.

### Fixed

- **A signing-in user no longer makes the logs report an incident that never
  happened (#156).** The first authenticated render for a new workspace creates
  its settings and streak rows, and the app layout and the page beneath it do
  that concurrently within one request — so one of them lost the insert and
  Prisma printed `Unique constraint failed on the fields: (id)` at error level.
  The loss was expected, handled and invisible to the user, but the log line was
  not distinguishable from a real failure and got escalated as one. The two
  helpers now create with `INSERT ... ON CONFLICT DO NOTHING`, so the loser is
  told "already there" instead of raising. Nothing about error logging changed:
  a genuine Prisma failure still prints exactly as before, and a test asserts
  both halves against a real database.

- **The WCAG-AA failures the accessibility suite could not see, and the gate that
  now catches them (#109, #117).** Both issues are one structural blind
  spot: the automated gates only measure what is painted during the scan, so a
  green suite meant "the gate cannot see this", not "this is fine".
  - **Text colour.** On this palette a bare Tailwind `-600` is not AA as text
    (3.00–4.48:1 on the light background), and a `-700` used as text needs a
    `dark:` partner (it drops to 2.34–3.97:1 in dark). Every instance was data-
    or state-dependent — the save indicator only paints its green mid-save, the
    aging note only appears with a demo override set, the sign-in error copy only
    on an error redirect — so the routes' zero-tolerance contrast gates scanned
    the idle page and passed. Fixed at the save indicator, the aging and round-up
    demo notes, the points stat, the sign-in errors, the task-schedule label and
    the five Google/breakdown status banners.
  - **Focus indicators.** Every popup menu entry in the header used a background
    swap as its only focus indicator, with the outline explicitly removed. That
    is 1.07:1 (light) and 1.17:1 (dark) between focused and unfocused, where WCAG
    2.4.11 Focus Appearance — AA in WCAG 2.2 — needs 3:1. Both menus now draw an
    inset ring at 4.65–8.83:1 against both adjacent colours, in both themes, and
    keep the background swap as the hover affordance. Nothing had caught this
    because **axe does not implement 2.4.11 at all.**
  - **Two more found by the new gate, in neither issue's inventory**: a bare
    `text-emerald-600` on the task-schedule label, and the scheduling banner,
    whose in-code comment asserted its colours were AA on its own tint. They are
    not: a translucent `/10` tint composites over the page background and pulls
    it toward the text, so `text-green-700` reads 4.16:1 there rather than the
    4.65:1 the bare token gives. The tinted banners are now driven from one
    measured table (`src/lib/status-banner-style.ts`) instead of six copies.
  - **The durable half** is `src/lib/a11y-class-hygiene.ts`: a TypeScript-AST
    scan of the class strings in `src/`, asserting no sub-AA chromatic text
    shade, a `dark:` partner on every dark-side text colour, and a non-colour
    focus indicator wherever the UA outline is removed. It runs in the unit job
    with no browser and no database, catches the *class* rather than the
    instance, and carries a reason-bearing allowlist per rule — the same contract
    `fetch-host-hygiene` uses. Verified failing on the unfixed tree first: 15
    text findings across 9 files, 2 focus findings, 4 unmeasured banner tones.
### Security

- **The dependency bot can no longer walk a security override back into a CVE
  range (#161).** `brace-expansion` is held at the patched `^5.0.8` by a
  top-level npm `override` because CVE-2026-14257 / GHSA-mh99-v99m-4gvg has no
  patched 2.x/3.x/4.x backport. A Renovate MR titled "update dependency
  brace-expansion to v2.1.4" nevertheless rewrote that entry to `^2.1.3` — back
  inside the affected range — and it was classified as a `patch`, which this
  repo automerges; only an unresolved review discussion stopped it. The
  scanners were not a backstop, because the head pipeline's security summary was
  identical to `main`'s.
  - **It was a mis-read, not a rollback.** Renovate resolves the top-level
    override's current version from the *hoisted* `node_modules/brace-expansion`,
    which a second, deliberately different override pins to 2.1.3 for the lint
    toolchain — while the copy the top-level entry actually governs sits nested
    under `@ts-morph/common` and is the only production-reachable one. So
    Renovate saw "currently 2.1.3", offered 2.1.3 → 2.1.4 as a patch, and wrote
    the range it inferred over the deliberate one. That recurs on every 2.x
    release, and the MR is recreated even when closed, so the fix had to be in
    config.
  - **Each override scope is now capped inside its own major.** The two entries
    cannot share one rule — forcing 5.x on the lint-tooling copy raises
    `TypeError: expand is not a function` and makes ESLint exit having linted
    zero files — and Renovate reports both scopes under the same dependency
    name, so the cap keys on the current value instead. The wanted 5.0.8 → 5.0.9
    bump is still proposed, and a new `override-hygiene` guard fails the build if
    either override drifts out from under the rule that protects it.
  - `postgres` majors are capped in the same pass: the version is pinned in three
    places that must move together, and moving it is a dump/restore migration
    rather than an image swap.

## [0.5.0] - 2026-08-01

**More than one person can use it now.** dlectroflow stops being a single-owner
instance. Invited people get real accounts, their own Google connection, their own
model key and their own AI budget, and the owner sets all of it from
Settings → People. Alongside that, scheduling gained a menu that remembers what you
told it last time, and a focus session gained longer presets, a "keep going for…"
answer when time runs out, and a breathing pacer on the paused ring. Under it,
the two deployment surfaces are now pinned to each other by a test, and the
container image is roughly a quarter of the size it was.

### ⚠️ Upgrade notes

- **This release migrates the database. Eight Prisma migrations run before the
  app container starts** — on Kubernetes via the `migrate` initContainer, on
  Docker Compose via the `migrate` service. Take a backup first. The set:
  new `User` / `Allowlist` / `UserAiUsage` tables and the Google credential
  re-keying (#35, #118), `Task.scheduleDueAt` / `schedulePriority` /
  `scheduleHours` (#106), `Settings.focusPauseTogether` (#65), CHECK constraints
  on `Step.estMinutes` (#78), `BrainDumpItem.estMinutes` (#80) and
  `User.aiQuota` (#35), and two data statements described below.
- **Your Google Tasks connection is destroyed by this upgrade and has to be
  reconnected once (#118).** Before accounts existed, one instance-wide Google
  credential row served everybody. Phase C keys every read and write on the
  acting user, which leaves that row unreachable, unrevocable and outside the
  `User` cascade — a live credential nobody can see or withdraw. The
  `google_auth_orphan_purge` migration deletes it rather than silently binding
  it to whoever looks like the owner, and logs how many rows it removed. **After
  deploying, go to Settings → Integrations and connect Google again.** Until you
  do, the UI reports a plain "Not connected"; nothing errors.
- **Sign-in is invite-only from this release onward.** An identity that is not in
  the `Allowlist` table cannot sign in at all. `OWNER_ALLOWLIST` is no longer just
  a comparison at login — it is seeded into that table by a `seed-allowlist` step
  that both deploy targets run automatically, after migrations and before the app
  starts, so **the owner cannot be locked out of their own instance by their own
  invite gate.** It is idempotent and re-asserts on every deploy. Set
  `OWNER_ALLOWLIST` before upgrading if it was ever left blank. Guest sandboxes
  are unaffected and still need no account.
- **The owner's own account is repaired to `uncapped` on upgrade.** Per-account AI
  metering starts being *enforced* in this release, and accounts provisioned by
  the earlier phase were created on the schema default of `capped`. Without the
  `owner_uncapped_repair` statement the owner would begin hitting a
  50-breakdown rolling cap on their own instance the moment it deployed. It only
  touches owner rows still carrying the default, so a deliberately capped owner
  is left alone.
- **One new environment variable, optional: `USER_AI_WINDOW_HOURS`** (default
  `720`, i.e. 30 days) — the rolling window per-account AI usage is measured over.
  It slides from each person's first breakdown rather than following the calendar.
  The quota itself is not an env var; the owner sets it per account in
  Settings → People. **No new *required* variables, and none removed.**

### Added

- **More than one person can use one instance — real accounts, roles and an
  invite allowlist (#35, Phase A).** The `OWNER_WORKSPACE_ID = "owner"` binary is
  gone, replaced by `User` records that own workspaces and are provisioned only
  from an `Allowlist`. Sessions are per-user rather than a single owner session,
  and the provider profile now supplies a username and email so an account is
  identifiable rather than anonymous.
  - **The data layer did not have to change**, because it was already
    workspace-scoped from the earlier workspace-access work. This changes *who a
    workspace belongs to*, not how content is partitioned — and a scoping test
    harness was added to keep it that way as models gain a `userId`.
  - **The owner role is keyed off a dedicated `Allowlist.isOwnerSeed` boolean**,
    not a role string and emphatically not a sentinel value in the free-text
    `note` column. A free-text field deciding a privilege level is a
    privilege-escalation hole; only the seed script sets the flag.
  - A missing workspace now self-heals on sign-in, tolerating two requests racing
    to create it.

- **Settings → People: the owner decides who gets AI, and how much (#35,
  Phase B).** A People panel lists every provisioned account with its role,
  status and AI policy, and lets the owner switch an account between capped and
  uncapped and set its quota. Enforcement is live — a capped account that has
  spent its allowance is refused rather than quietly billed to the owner.
  - **Uncapped accounts are metered too, including the owner's own.** They are
    never refused, but the count is visible in the panel, so "who is spending the
    AI budget" is answerable rather than guessed. An account on its own key is
    not counted at all: their key, their bill.
  - The panel is a collapsible disclosure, collapsed by default, and stays
    visually stable while a policy is mid-edit rather than reflowing under the
    cursor.

- **Everyone brings their own Google account and their own model key (#118,
  Phase C).** The Google credential is keyed on the acting user instead of being
  one instance-wide singleton, so any signed-in member can connect their own
  Google account, and their calendar control and Schedule-menu prefill use their
  own connection. A member can also supply their own LLM key and provider, which
  takes their usage off the instance's budget entirely.
  - **Both OAuth routes are gated on the acting user throughout (#119).** During
    this release's development the owner gate was briefly keyed off the removed
    owner constant; it is now an explicit per-user check on both the start and
    callback routes, proven by tests covering the non-owner case.
  - Disconnecting is a real disconnect — see the revocation change under
    **Security**.

- **The Schedule menu — one place to say when, how urgent, and whose hours
  (#106).** The 📅 control opens a menu with a due date, a priority and a
  work/personal hours choice, shows a summary line of what will happen, and turns
  that line into a warning when the combination cannot be honoured. The three
  fields are persisted on the task, so re-opening the menu prefills what you said
  last time instead of asking again.
  - **They are nullable with no column default, deliberately.** A column default
    would freeze "three days from the migration date", and it would make "the
    owner chose this" indistinguishable from "nobody has said" — which is exactly
    the distinction prefill depends on. The fallback comes from application code.

- **Scheduling gained a real intent model, and steps stop arriving reversed
  (#104).** A timezone-aware working-hours calendar lays steps into disjoint
  windows, so a breakdown pushed to a calendar arrives in the order you read it.
  Reclaim gets a properly briefed title and notes, plain Google Tasks gets its own
  encoder (detected from the list), re-scheduling upserts instead of duplicating,
  and each `VEVENT` in an exported `.ics` deep-links to its own step. Single
  to-dos go through the same intent path as broken-down ones.
  - `SCHEDULING_SYNTAX` and `SCHEDULING_TIMEZONE` are documented in
    `.env.example` — both optional, and both previously undiscoverable.

- **Pausing the music can pause the timer too (#65).** The timer already drove
  the music; this adds the other direction, so reaching for the mini-player's
  pause button stops the focus session as well and playing it resumes both.
  **Off by default** — it has to be asked for, because otherwise a reflexive
  reach for the volume control ends your session. Workspace-scoped, like every
  other focus preference, so guests keep their own value.

- **A paced breathing guide on the paused ring (#89).** Pausing gives you
  something to breathe with rather than a frozen dial, and the pacing runs across
  the whole live session rather than only the pause. Respects
  `prefers-reduced-motion`.

- **Longer focus presets, and a "keep going for…" answer when time is up
  (#138).** The preset row covers longer sessions, and reaching zero now offers
  extending in place as a first-class answer alongside the existing ones, with
  the hand-off keeping sound on.

- **Settings and Help have a collapsible sticky section nav (#72, #101).**
  Collapsed by default, with iOS-style sticky section headers, every section
  collapsible, and the sections reordered by how often they are actually used.
  It survives the section list shrinking underneath a stale current id rather
  than crashing.

- **The header names the account you are signed in as (#100)**, and the nav shows
  *Account* rather than *Sign in* once you are.

- **The breakdown coach is given app and user context (#14)**, so its proposals
  are shaped by how you actually work instead of being generated cold.

- **The Integrations panel says which Google account to connect (#128)** — and
  documents that a managed work account can be blocked outright by its Workspace
  admin, which is otherwise a silent, unexplained failure.

- **A scheduled job bounds the container registry (#114).** `main-*` tags are
  pruned on a schedule instead of accumulating forever.

- **The Kubernetes and Docker Compose deployments can no longer drift apart, and
  `/api/health` says which commit it is running (#135).**
  The Helm chart and `.env.prod.example` are two configuration surfaces of the
  same app, and nothing checked that they matched. `src/lib/env-drift.test.ts`
  now diffs them in both directions and fails the build on any divergence that
  is not written into `CONFIG_SURFACE_ALLOWLIST` with a stated reason.
  - **Self-hosters gain nothing they must change, and several things they can.**
    `LLM_OWNER_MODEL`, `LLM_GUEST_MODEL`, `SCHEDULING_SYNTAX` and
    `SCHEDULING_TIMEZONE` were readable by the app and documented in
    `.env.example`, but `.env.prod.example` never mentioned them — so a
    self-hosted instance was stuck on the `Europe/London` default with no way to
    discover otherwise. All four are now documented. **No new required
    variables**; everything added is optional.
  - **`docs/self-host-vps.md` now actually sets Google Tasks up.** The keys were
    in `.env.prod.example`, but the walkthrough never mentioned them, so
    following it end to end produced an instance where "Connect Google" could
    not succeed and nothing said why. The new section covers enabling the Tasks
    API, the exact redirect URI Google matches literally, and the seven-day
    grant expiry while the consent screen is in Testing.
  - **The Kubernetes instance can now tune guest quotas and switch LLM provider
    without a chart edit.** Seventeen previously Compose-only keys are chart
    values, each rendered into the Secret only when non-empty — an empty value
    is not the same as unset for readers that use `??`, and a rendered
    `GUEST_SANDBOX_TTL_HOURS=""` would have expired every guest workspace
    immediately.
  - **`/api/health` gains a `sha` field** — the short build SHA, baked into the
    image at build time, so two instances can be *asserted* to be on the same
    commit rather than assumed to be. Additive and backward-compatible; it is
    `null` on an image built without the new `BUILD_SHA` build arg. Self-hosters
    who want it should pass
    `--build-arg BUILD_SHA="$(git rev-parse HEAD)"` when building.
  - Deliberate platform differences are now recorded in code too
    (`PLATFORM_DIVERGENCES`): per-IP rate limiting, Postgres TLS, container
    hardening, PodDisruptionBudget/replicas, and CronJob status as a health
    signal all exist on Kubernetes and not on the single-host stack.

- **The Privacy Policy now carries Google's Limited Use undertaking (#140).**
  A new subsection of "Connecting Google Tasks" states, in Google's own required
  wording, that use of Workspace API data adheres to the Google User Data Policy
  including the Limited Use requirements — and states plainly that nothing from a
  connected Google account is ever sent to the AI provider or used to train any
  model. **Effective date moved to 2026-07-31.**
  - Prompted by Google's Third-Party Data Safety team pausing OAuth verification
    for apps that pair a Workspace API with an AI/ML model. The substantive claim
    was already true: the Tasks integration is **write-only**, so no Workspace
    data exists in the app to forward anywhere. What was missing was saying so.
  - **Self-hosters running their own OAuth client**: this obligation follows the
    client, not the code. If you pair the Google scope with any model, you need
    the equivalent statement somewhere you control. See `docs/legal.md`.
- **A CI gate pinning the published legal text to the effective date (#141).**
  `src/lib/legal-fingerprint.test.tsx` hashes the rendered text of `/privacy` and
  `/terms`; changing a word fails the build until someone decides whether the
  change is substance (bump `LEGAL_EFFECTIVE_DATE`) or copy (do not). It hashes
  rendered output rather than source, so formatting and refactors do not trip it.
  Added because #140 shipped new material text under the previous day's date and
  nothing caught it.

- **The hosted instance now publishes a Privacy Policy and Terms of Service (#123).**
  Two new public pages, `/privacy` and `/terms`, linked from a quiet footer on
  every app screen and on the sign-in page. Written for the **UK GDPR** and the
  **Data Protection Act 2018**, governed by the law of **England and Wales**, with
  the ICO complaint route spelled out.
  - **The immediate driver was Google OAuth verification**, which requires a
    publicly reachable policy before the consent screen can be verified. Both
    paths join `PUBLIC_PREFIXES` (`src/lib/auth/gate.ts`) — without that the
    middleware redirects a reviewer arriving with no cookies to `/login`, and
    verification fails while the app itself looks perfectly healthy. Guarded from
    both sides: `src/lib/auth/gate.test.ts` for the classifier and
    `src/proxy.test.ts` for the middleware that has to honour it.
  - **It documents what is shipped, and says so where something is not.** No
    self-service export exists, revocation does not auto-delete content, and only
    the instance administrator can connect Google — so the pages describe the
    honest fallback (requests handled by hand within the statutory one month)
    rather than a feature the software lacks. `src/app/privacy/page.test.tsx`
    asserts that honest wording is still there.
  - **Notably disclosed rather than buried:** task text is sent to Anthropic in
    the **United States** to produce breakdowns, which is an international
    transfer; the Google integration uses exactly one scope
    (`.../auth/tasks`); and all six cookies are strictly necessary, so there is
    **no cookie banner** and no analytics package anywhere in the codebase.
  - Facts live once, in `src/lib/legal.ts` (controller, contact addresses,
    effective date, hosting region, backup retention). **Maintaining the pages:
    [`docs/legal.md`](docs/legal.md)** lists which claims depend on the running
    system — region, backup retention, LLM provider, cookies, scopes — and what
    to re-check when infrastructure changes, plus a Google verification checklist.

- **You can self-host dlectroflow on one small server without Kubernetes (#102).**
  `docker-compose.prod.yml`, a `Caddyfile` and `.env.prod.example` now ship, with
  a walkthrough in `docs/self-host-vps.md`. That is roughly **$6/month** on a
  small VPS, versus $105–145 for the GKE Autopilot deploy — and until now the
  cost guide recommended that path while the repo's only Compose file started
  Postgres alone, for local development.
  - **Mirrors what the Helm chart does**, minus the cluster-only parts: the
    startup order `db (healthy) → migrate → seed-allowlist → app → caddy` is
    enforced, so migrations are applied before the app starts and the owner's
    invitation is seeded — without that step you would be locked out of your own
    invite-only instance on first boot.
  - **Caddy replaces ingress-nginx and cert-manager**, obtaining and renewing a
    Let's Encrypt certificate on its own. It also enforces the same 2 MB request
    body cap as the Kubernetes Ingress. Per-IP rate limiting is the one Ingress
    feature not carried over, and that is called out in both the Caddyfile and
    the runbook.
  - **Backup and guest-purge jobs are included** behind a Compose profile, with
    the two crontab lines in the runbook, plus restore and upgrade procedures.
  - **`DATABASE_URL` is composed from the `POSTGRES_*` values** in one place, so
    the app's connection string and the database's own credentials cannot drift
    apart, and the stack uses its own Compose project name (`dlectroflow-prod`)
    so it can never take over a local development database.
  - **Verified end-to-end before shipping** — 30 migrations applied, owner
    invitation seeded, `/api/health` green through Caddy, purge and backup both
    producing correct output, and the boot guard confirmed to refuse a
    half-configured instance. The one thing not yet exercised is Let's Encrypt
    issuing a certificate on a real public domain, which needs public DNS and
    port 80; both the runbook and the cost guide say so plainly.
- **An honest self-hosting cost guide — `docs/running-costs.md`.** Eight ways to
  run dlectroflow, cheapest first ($0 on your own hardware → $105–145/month on
  GKE Autopilot), with every tool named and explained, whether it's free or open
  source, where to get it, and per-line costs. Includes what the AI breakdown
  actually costs per request (~$0.005 on Haiku, ~$0.025 on Sonnet, ~$0.05 on
  Opus) and the fact that prompt caching isn't enabled yet. The README gains a
  `💸 What it costs to run` summary linking to it.
  - **Only the GKE Autopilot numbers come from the real deployment.** The other
    seven are worked examples from published provider prices, explicitly labelled
    as untested, with an invitation for self-hosters to contribute corrections
    and their own setups.
  - The Autopilot **ingress-nginx + cert-manager line ($40–60/month) is an
    estimate** derived from Autopilot's per-pod rates and minimums, not read from
    an invoice — flagged as such in both the guide and the deploy runbook.

### Changed

- **A new task's deadline defaults to a week out, not three days.** Three days
  was optimistic often enough that the default was being edited more than it was
  accepted, which is the definition of a wrong default.

- **A step estimate under one minute is now rejected by the database (#78).**
  The `>= 1` invariant lived in four scattered writers, so it held only while all
  four stayed correct and a fifth writer added later inherited nothing. A single
  bad row distorted the step-size summary handed to the breakdown coach —
  `[-5, 0, 0.4, 10, 20]` read out as "5 steps (0–20 min, ~0 median)", telling the
  coach this person likes zero-minute steps and sizing its next proposal to match.
  The read side was fixed earlier; this is the cure the guard was standing in for.

- **A brain-dump item's estimate is now constrained too — but to `NULL` or
  `>= 1`, not `>= 1` (#80).** The difference from the step constraint above was
  accidental rather than recorded, and copying `>= 1` across would have made
  every estimate-less item unwritable. `NULL` is meaningful here: it says "the
  user never gave an estimate", and the read side substitutes a display default
  rather than a stored one. The distinction is now written down in three places,
  one of which fails the suite if the `NULL` allowance is ever dropped.

- **One hosted deployment moved from the apex to a subdomain (#130).** Hosted
  deployment only; self-hosters are unaffected.

- **A brand-new account's empty inbox no longer congratulates you for clearing a
  queue you never had (#111).** Signing in produced "Inbox zero. Nothing to
  review." — or "🎉 Inbox zero! Nothing to review." in playful voice — whether
  the account had just emptied itself or had never held anything, so a first
  sign-in told you something you owned was gone. It now reads **"Nothing here yet
  — this is a new account (`handle`, signed in with GitLab)"**, naming the
  account as well as the state.
  - **Why the account is named.** The failure this sentence exists for is signing
    in with the *wrong* provider account, which yields a perfectly empty
    workspace that looks like data loss. The provider is the fact that resolves
    it, so it is included; the role is not, because it answers "what may I do
    here?" rather than "whose workspace is this?".
  - **New versus emptied is decided honestly, not by counting rows.** The inbox
    query excludes archived items and captures are hard-deleted, so "captured
    three things and deleted them all" renders exactly as many rows as an account
    five seconds old. `workspaceHasHistory()` probes four tables instead —
    captures of any status, tasks (which outlive their capture through
    `onDelete: SetNull`), reward events (the inbox-zero award the deletion does
    not remove) and badges (awarded once ever, never deleted). Anything at all
    counts as history, because being wrong in the generous direction is the worse
    error here.
  - **No cost on the hot path.** The probe runs only when the page has already
    rendered zero items for a signed-in account — the one request where the
    answer changes anything. Guests and the first-run preview never reach it, and
    every probe is workspace-scoped and selects `id` only.
  - **Guests are unchanged** — no account to name, and they already get the
    sandbox banner, so the copy is byte-identical to before.
  - **Accessibility:** the same node and the same tokens as the string it
    replaces, so the zero-tolerance `color-contrast` gate on guest surfaces sees
    no new pairing — asserted in a unit test rather than by eye, and the copy sits
    inside the existing e2e contrast scan of `/` in both themes.
- **`shadcn` is a `devDependency`, not a runtime one (#93).** It is the
  component-scaffolding CLI; nothing in the shipped app imports it. Declaring it
  under `dependencies` meant `npm ci --omit=dev` resolved **412 packages instead
  of 103** — 309 packages of CLI subtree (`ts-morph`, `@dotenvx/dotenvx`, a second
  `dotenv@17.4.2`) described as production supply-chain surface that never reached
  the image. The `output: "standalone"` trace is unchanged at 13 packages, the
  compiled stylesheet is bit-identical, and `find / -name 'shadcn*'` in the built
  image returns nothing — so this changes what the dependency graph *claims*, not
  what ships. It is not removable: `src/app/globals.css` still
  `@import`s `shadcn/tailwind.css`, so the build fails outright without it — but
  that CSS is compiled into `.next/static` before the image is assembled.
  `npx shadcn add …` still works, since dev dependencies are installed locally.
- **`CONTRIBUTING.md` now documents how to add a dependency (#81).** The
  lockfile-regeneration trap (#67) was tribal knowledge: CI installs with `npm ci`,
  which fails on a mismatch rather than repairing it, and the npm that resolves a
  contributor's tree is not the npm in `node:22-alpine`. The new section gives the
  `docker run … npm install --package-lock-only` recipe, the
  `dependencies`-vs-`devDependencies` test (does it appear in the standalone
  trace?), why images are pinned by digest, and what each hygiene guard means when
  it fails.
- **The header's theme control is icon-only (#103).** In a menu bar the words
  "Dark mode" / "Light mode" were dead weight, and the width they added crowded
  the rest of the bar at 390px. The header now shows a lucide moon/sun glyph in a
  44×44 button. **Settings → Appearance keeps its words**, where a bare icon in a
  settings row would be worse than the label it replaced — the component takes a
  `variant` prop and the labelled variant is the default, so no call site can
  quietly lose its text.
  - **Accessibility.** Dropping the visible words drops the button's accessible
    name with them, so the icon-only variant carries an `aria-label` (and a
    matching `title` for pointer users) naming the **action** — "Switch to dark
    mode" / "Switch to light mode" — keeps `aria-pressed` for the state, and is
    squared up to the shared 44×44 minimum target (WCAG 2.5.5). The box is
    measured in a real browser by a Playwright spec, not just asserted as a class
    name. The labelled variant deliberately has **no** `aria-label`, so its
    visible words stay its name (WCAG 2.5.3, Label in Name).
  - **Both variants draw lucide icons instead of emoji**, finishing the move
    started in !141: emoji render differently on every platform, and the VS16
    variation selector makes their advance width unpredictable.
  - **Behaviour is untouched** — the control still writes the `dark` class on
    `<html>`, reads it back through `useSyncExternalStore`, and two mounted
    toggles stay in sync.
- **Documentation-only merge requests no longer run the full build gate.** A
  three-file README change was spending ~18 minutes of runner time compiling the
  app, running unit + Playwright suites, building and scanning a container image,
  and deploying a review app to the cluster. The expensive merge-request jobs are
  now gated on `changes: *code_changes`, so a docs-only MR runs secret detection
  alone (~19s) and deploys nothing.
  - **Secret detection stays ungated deliberately** — a credential can be pasted
    into a README, and it also keeps a docs-only pipeline from having zero jobs.
  - **`main`, version tags and the weekly rescan schedule are untouched** and
    still run everything, so `deploy_production` can never find itself without
    an image.
  - Because `changes:` on a merge-request pipeline is evaluated against the diff
    to the *target branch*, the fast path engages only when an MR's **entire**
    diff is documentation — an MR that touches one line of `src/` runs the full
    gate regardless of what later commits do.
  - `src/lib/ci-docs-only.ts` + tests guard the list: `rules:changes` is an
    allow-list, so a top-level path nobody added would silently skip the gate.
    The test fails until every committed top-level entry is classified as either
    code or documentation.
- **Review apps stop after 12 hours instead of 2 days.** Each idle review
  environment holds an app pod and a Postgres pod on billable Autopilot
  capacity. Stopping is not destructive — re-running `deploy_review` brings the
  environment straight back.
- **The container image is ~4× smaller (#71).** **893 MB → 207 MB** as reported
  by the container registry — the same metric the failed rollout logged
  (`Image size: 893096400 bytes`) — a 77% cut, so a cold pull onto a fresh
  Autopilot node no longer dominates the deploy. Almost none of the bulk was
  the app. The runtime stage ran `npm install` with `/app`
  as the working directory, so npm treated the standalone output's
  `package.json` as the project manifest and reinstalled the **entire**
  dependency tree — 392 packages including `next`, `typescript`, `playwright`
  and `@next/swc` — on top of the minimal `node_modules` that
  `output: "standalone"` had just traced, and kept npm's 885 MB tarball cache
  in the same layer (408 MiB compressed). A closing `RUN chown -R node:node
  /app` then rewrote every file, writing a second copy of the whole app into
  another layer (219 MiB compressed). The migrate/seed/purge CLIs (`prisma`,
  `tsx`, `dotenv`) now install into an isolated prefix and are grafted into
  `/app/node_modules`; ownership comes from `COPY --chown`.
  - **Nothing was removed.** The bundled lo-fi audio (29 MB, #43) — which the
    0.4.0 note above blamed for the size — stays, and `npx prisma migrate
    deploy`, `npx tsx prisma/seed.ts` and the purge CronJob were all verified
    to still run from the image. The image's `tsx` pin also caught up with the
    lockfile (4.19.2 → 4.23.1, the version #67 realigned on).
  - **Operators:** no action. The `helm --timeout` values raised in 0.4.0
    (production 20m, review 15m) are left as they are — they are now headroom
    rather than a requirement.

### Fixed

- **An emptied focus lane says it is empty, instead of showing a stale count
  (#136).** Moving the last card out of a lane left the old count behind and no
  zero-state, so the lane read as populated when it was not. Each lane now names
  its own landmark and reports one count from it, rather than the count being
  recovered by walking the DOM.

- **A member is no longer treated as a guest when picking a model (#96).** An
  invited account fell through to the guest model because the check tested for
  "not the owner" rather than "not signed in", so members silently got the
  cheaper model they had not asked for.

- **Row-action popups stay inside the viewport at 390px (#92).** On a phone the
  inbox row menus opened partly off-screen, putting the destructive action under
  the edge of the display.

- **The inbox keeps dark mode through hydration (#105).** The inbox clock was
  read on the client, so the server and client markup disagreed and React
  discarded the server tree — taking the resolved theme with it and flashing
  light. The clock is now stamped on the server.

- **The guest banner uses the owner's copy, not the voice-aware variant (#73).**
  A guest was being addressed in a voice setting that belongs to an account they
  do not have.

- **The React Compiler's `react-hooks` findings are burned down (#23).** The rule
  had been left at warn level with a stale comment claiming otherwise; the
  findings are fixed and the comment now matches the config.

- **Review-app namespaces no longer leak forever (#145).** `stop_review` was
  failing with **`missing_dependency_failure`** — `started_at: null`, empty log,
  script never reached — so `kubectl delete namespace` never ran. Six
  environments were wedged in `stopping`, the oldest since **11 July**, and two of
  them were still running an app pod *and* a Postgres StatefulSet for merge
  requests that had already merged: roughly **$20/month each** on Autopilot,
  against a total bill of £80–120.
  - **The cause is a GitLab default that only bites teardown jobs.** A job with
    no explicit `needs:` inherits an implicit dependency on **every job in every
    earlier stage**. `stop_review` sits in `deploy`, so that meant `build`,
    `build_image` and `test` — and once those artifacts expired the dependency
    could never be satisfied again, permanently. `needs: []` is both the fix and
    the honest declaration: teardown consumes no artifacts at all, only `helm`
    and `kubectl` against a live cluster. It now also starts immediately instead
    of queueing behind a build it does not use.
  - **It concealed itself twice over.** `allow_failure: true` kept the pipeline
    green so merge requests merged normally, and GitLab's Environments page lists
    `stopping` under **Active** — so the auto-stop timer looked healthy while
    being entirely decorative. `allow_failure: true` stays, because a teardown
    that cannot reach the cluster should not block a merge and the script is
    already written not to fail (`|| true`, `--ignore-not-found`), but its
    reasoning is now recorded inline.
  - **Operators running review environments on their own cluster should sweep
    once for orphans** — compare `dlectroflow-mr-*` namespaces against open merge
    requests. One non-obvious step, worth writing down: `DELETE
    /environments/:id` returns **403 while an environment is `stopping`**, which
    reads as a permissions error and is not one. `POST /environments/:id/stop`
    with `force=true` skips the `on_stop` action, moves it to `stopped`, and then
    the delete succeeds.
  - **Guarded by `ci-job-deps`**, a new repo-invariant test: every job declaring
    `environment.action: stop` must still exist, and must declare `needs:`
    explicitly and empty. **`extends:` is deliberately not followed** —
    inheriting "no `needs`" from a shared base is precisely how this happened, so
    a job that satisfied the check only through a template would reproduce the
    bug with the test green.
  - Still open on #145: a scheduled sweep comparing `dlectroflow-mr-*` namespaces
    against open merge requests, which would have caught all six on its own.
- **The focus timer no longer hangs forever when a server action fails (#137).**
  Finishing a session, choosing "Not yet", or confirming a requeue could leave
  the screen on "Claude is re-estimating…" indefinitely — no error, no timeout,
  and no way out but a reload that lost your place. Three handlers shared the
  same unguarded shape, so a rejected request skipped the line that clears the
  pending state and the UI silently stopped responding while still *looking*
  like it was working.
  - **Every focus action now runs through one guarded path**, with the pending
    state cleared in a `finally` so no route can leave the timer stuck, and a
    timeout so a request that never answers surfaces the same way one that
    rejects does.
  - **A failed re-estimate is no longer a dead end.** It says what happened and
    offers **Try again** and **Skip — pick a time myself**, so the session can
    still end in a requeue with a number you chose.
  - **A deploy while your tab is open is now named as such.** Next regenerates
    server-action ids on every build, so a tab open across a release posts an id
    the running deployment no longer has — the original trigger in production.
    That case says "the app updated" and offers a reload, and deliberately does
    *not* offer a retry, which could never succeed against a stale bundle.
  - **Accessibility:** the notice is a `role="alert"`, focus moves to its
    primary action, and that action is described by the message so the reason is
    announced with the remedy. State is carried by the words, not by the red.

- **A requeue's new estimate now shows up on the list (#139).** Choosing "Not
  yet" wrote the kinder estimate to the database correctly and then left the
  home list rendering the old one, so a feature that worked looked broken. The
  requeue was the one mutation in the focus actions that invalidated the task
  page and not the list.
  - **It also said "done" when it had failed.** The requeue's result was
    discarded, so all four of its guard failures still showed the "🌱 bumped to
    N min" success screen. The screen now appears only when the write actually
    landed, and completing a step is held to the same standard — a completion
    the server refused no longer gets a celebration.
  - **Completing a step mid-task refreshes the list too.** That invalidation sat
    inside a branch, so finishing the *last* step of a task refreshed the list
    and finishing any earlier one did not.
  - **Guarded by a new hygiene test.** `revalidation-hygiene` parses the focus
    actions and fails the build if a mutation stops invalidating the list, or
    starts doing it from inside a branch. It follows writes through the file's
    private helpers, and the four session-only actions are exempt through a
    reasoned allowlist the test re-proves on every run.

- **Settings and Help now have a way home from the bottom of the page (#131).**
  On both pages the "Jump to…" bar sticks, but everything above it scrolls away
  — including the "← Back" link, the one control that returns you to wherever
  you came from. A screen down a long list of disclosures there was no way back
  but scrolling all the way up or reaching for browser Back. The exit now rides
  in the bar that already sticks, at its left end.
  - **The same control, not a second one.** `<BackLink>` grew a compact variant,
    so the origin whitelist, the inbox fallback for an unknown or hostile
    `?from=`, and the "← Back" label are still resolved in exactly one place.
    Both pages hand the same origin to both copies, so the exit below the fold
    can never lead somewhere the one at the top would not have. The full-width
    control at the top of each page is unchanged.
  - **No second sticky row**, deliberately: the bar's height is what every jump
    target's landing offset is measured against (#115), and a second layer would
    also cost a permanent slice of every phone screen on the two longest pages.
    The exit shares the toggle's row instead — asserted end to end, along with
    the pills still laying out at 390px with no sideways scroll.
  - **Accessibility:** one tab stop, at the head of the bar rather than one per
    jump (checked in both directions), first in the DOM because it is first on
    screen, a 44px touch target, the bar's visible focus ring, and the same
    accessible name as the control it stands in for. axe unchanged on both
    pages, both themes.
- **Documentation changes can merge again (#116).** Every docs-only merge
  request came back `security_policy_violations` and needed an approval from the
  single eligible approver — including changes made specifically to correct
  misleading docs. Two things the project built separately were in conflict: the
  docs-only fast path (#53) skips the four code scanners, correctly, because
  there is no code to scan; and the approval policy compares the set of security
  report **types** in a merge request's pipeline against main's, reading a
  missing type as unresolved rather than as inapplicable. A new
  `docs_only_scan_stub` job supplies the three missing types as empty,
  schema-valid reports. Its rule is the exact inverse of the one that runs the
  real scanners — the same `.code_changes` anchor — so it can only fire on a
  diff containing no code path at all, and its log opens with
  `THIS JOB SCANS NOTHING` and prints the diff it is making that claim about.
  - **Nothing about scanning a code change moved.** `fallback_behavior: fail:
    open` on the policy would have fixed this in one line and was rejected: it
    would also pass a merge request whose SAST job had errored out.
  - **Contributors:** a documentation typo fix no longer waits on a security
    approval.

- **The accessibility contrast gate can be trusted again (#110).** The guest
  settings axe spec failed roughly **2 runs in 4**, in a different theme each
  time, always reporting `--foreground` over `--primary` — a pairing nobody ever
  chose. The number was real; the layout was not. Two sticky section headers were
  overlapping mid-handover and axe, which reads once with no retries, sampled one
  band's text against another band's magenta.
  - **This is in a changelog because of what it was hiding.** `retries: 1` in
    `playwright.config.ts` meant the retry passed and CI never showed the
    failure, and **a retry-masked flake in a contrast gate is indistinguishable
    from a genuine AA regression**. It also burned unrelated merge requests at
    random.
  - **The overlap was proven, not assumed** — a MutationObserver on
    `data-current` plus a timestamp at the test helper's return showed a **1 ms
    margin, every run**: the scroll-spy released its override from an
    IntersectionObserver callback one frame after the helper had already returned.
    Green only because CDP round trips outlasted a frame of browser work. Under
    8× CPU throttling the margin inverted and 2 of 10 runs scanned a page mid
    change.
  - **The wait is a positive, terminal condition, not a timeout or an "unchanged
    for N frames" heuristic:** at the top of the page exactly one band may claim
    `data-current`, and it must be the topmost one — an invariant verified across
    desktop and mobile × light and dark × owner and guest before anything was
    built on it. A leftover `waitForFunction` guarding a CSS transition that does
    not exist on `[data-section-header]` was removed rather than carried forward.
  - **And the colours were checked separately**, so a genuine failure cannot hide
    behind the fix. Verified 10× for determinism; a companion test reads scroll
    position and highlight inside a single `page.evaluate`, where an
    IntersectionObserver callback cannot run mid-task, so it catches the bad state
    on any machine however fast.
  - Still open: `retries: 1` continues to mask flakes in CI generally, tracked
    separately.
- **The documented quick start now works on a fresh clone (#91).** Following the
  README could not get a new checkout running, and three faults compounded:
  `.env.example` shipped a `CHANGEME` database password while
  `docker-compose.yml` uses `dlectroflow` (so a copy-paste failed with Prisma
  `P1000: Authentication failed`); the README said to copy the template to
  `.env.local`, but the Prisma CLI reads `.env` (so `npm run setup` stopped at
  *"Environment variable not found: DATABASE_URL"* even when followed exactly);
  and nothing stated that `.env` has to exist **before** `npm run setup`, whose
  last step is `prisma migrate dev`. The template now carries the local Compose
  credentials and copies with no edit, that copy is an explicit step before
  setup in both the README and CONTRIBUTING, and a new README section documents
  which file each variable belongs in — `.env` for the Prisma CLI, Next.js and
  `npm test`; `.env.local` as the Next-only override that Prisma never reads.
  Verified by walking a real fresh clone from `git clone` to a green
  `npm test` and a serving app with no manual env editing.
  - **Operators:** no action — nothing about a deployed instance changes. The
    Compose password now in `.env.example` is local-only and was already
    published in the committed `docker-compose.yml`; it reaches nothing outside
    a developer's own machine, and production credentials still come from
    GitLab Secrets Manager.

- **The test suite is honest about what it needs and what it covers.** Unit tests
  no longer silently require Postgres — the one route test that did now fails
  with a clear message instead of an obscure connection error (#84); the
  registry-prune suite is hermetic against ambient CI environment variables
  (#120); e2e boots the `standalone` output rather than `next start`, so it
  exercises what actually ships (#97); and guest-only UI is scanned by axe, which
  caught real issues now fixed (#90).

- **A schedule-menu test no longer passes or fails depending on the time of
  day.** Two tests set a deadline of *today* and asserted the menu's
  infeasibility warning, on the premise that today could never hold the
  fixture's 2h15m of work. It can, before mid-afternoon —
  `workingMinutesBetween(now, dueAt)` is a function of `now`, so the same tree
  was green at 23:34 and red at 06:43. Both now use a deadline already in the
  past, which scores zero available minutes at every hour, and a clock-sweeping
  unit test pins that premise so the next change to the hours model cannot
  quietly unpin it.

### Security

- **Freezing or deleting an account now revokes its Google grant at Google, not
  just locally (#126).** Deleting the stored credential left the OAuth grant
  standing in the user's Google account, so an offboarded person's data remained
  reachable by anyone who could restore a token. Revocation is attempted at
  Google first; **a refused revoke is treated as a failure rather than a
  success**, is logged before the local delete, and is reported to the user
  instead of showing a disconnect that did not happen. The Privacy Policy is
  updated to state that the grant goes with the access.

- **Hygiene tests can no longer be steered by the ambient git environment
  (#146).** Several repo-asserting tests shelled out to `git` inheriting the
  caller's environment and current directory, so a stray `GIT_DIR`, a `-C` in an
  arg list, or simply running from a subdirectory changed what they scanned — a
  guard that quietly scans the wrong tree is a guard that has stopped guarding.
  Scans are anchored to the repo root, git children get an allow-listed
  environment, and the guard fails closed on an unreadable arg list.

- **The generic-SSRF SAST rule is replaced by a repo-owned guard, not merely
  silenced (#83).** `javascript-node-ssrf-generic-taint` produced **five findings
  in this repo and zero true positives**, all on OAuth token-exchange code whose
  request target is a module-level string constant. What the taint engine follows
  is user input reaching the request **body** — the `code` and `refresh_token`
  form fields, which is what an authorization-code exchange *is*. CWE-918
  requires control of the request **target**. Worse, the findings
  **re-fingerprint whenever a line moves**, resurfacing as "new High" and
  tripping the "require approval for new Critical or High" policy on merge
  requests that changed nothing relevant; that blocked one unrelated merge request
  six times.
  - **A severity override, not `disable = true`.** `.gitlab/sast-ruleset.toml`
    (new) demotes the rule to `Info`. Disabling would mark everything it had ever
    found as "No longer detected", silently retiring three documented dismissals
    and losing the audit trail; the override keeps every finding visible with its
    history intact and is reversible. The ruleset schema was checked first — it
    supports only `disable`, an `identifier` selector and a metadata `override`,
    so a **path-scoped** disable of one rule is not expressible at all. Which
    analyzer sections needed the override was answered from a real
    `gl-sast-report.json` artifact rather than assumed: all four SSRF findings
    **in the current report** come from `gitlab-advanced-sast` and the semgrep
    report has none, so the `[semgrep]` entries are included but labelled as
    currently inert.
  - **The compensating control is a hard gate, not an approval prompt.**
    `src/lib/fetch-host-hygiene.ts` walks the TypeScript AST and asserts that
    every `fetch()` and `new Request()` target in `src/`, `prisma/` and
    `scripts/` has a **host that is constant at build time**. It fails the unit
    test job, and it does not re-fingerprint when a line shifts. `e2e/` is
    deliberately out of scope — it hits dynamic local URLs, and including it would
    reintroduce exactly the noise this replaces.
  - **It rejects the subtle shapes, each with its own test:** a template whose
    constant prefix does not close the URL authority (`` `${GITLAB}${tail}` ``
    with `tail = "@evil.com/x"`), a protocol-relative `` `/${p}` ``, a `let`-bound
    or parameter target, an imported builder, a ternary with a dynamic arm, and
    `fetch(new Request(u))` — reporting **both** sites. It accepts a
    caller-supplied *path segment*, because the host is still pinned by the
    builder's leading constant; conflating path traversal (#79, fixed in !165
    with per-segment encoding) with SSRF is what produced the original noise.
  - **Watched failing in both directions.** Two dynamic hosts were injected into
    `src/lib/google.ts` — a direct interpolated host and a `tasksUrl` rewritten to
    take its host from a parameter — and all four resulting call sites were
    reported before the tree was restored. A separate read of the module then
    found a real hole and fixed it: the constant resolver walked past shadowing
    bindings, so a parameter shadowing a module-level const reported its host as
    constant — the exact attacker-reachable case the guard exists for. It now
    stops at the first binding of a name, whatever kind, and fails closed.
  - **`REVIEWED_DYNAMIC_HOSTS` is empty**, and keyed by `<file>:<target
    expression>` rather than by line so it cannot rot the way the SAST
    fingerprints did. An env-derived host (a bring-your-own `LLM_BASE_URL`, #59)
    would belong there with a stated reason; a request-derived one never does.
  - **Self-hosters forking the repo inherit `.gitlab/sast-ruleset.toml`.** If you
    add `fetch()` calls of your own, `fetch-host-hygiene` is a **hard failure**
    rather than an approval prompt — that is the trade this makes, and relaxing
    the test means reopening the CWE-918 hole rather than tidying a style rule.

- **The eight HIGH findings sitting untriaged in the vulnerability baseline are
  dispositioned, and the security assessment finally has a schedule (#134).** The
  Vulnerability Report held **70 findings, 8 of them HIGH**, none individually
  triaged. Both halves of #134 are the same failure. The scan-result policy gates
  on **new** Critical/High, so the standing baseline is never "new" and is
  invisible by construction — and `docs/quality-audit-prompts.md` had prescribed a
  monthly security assessment since the cadence was written, with nothing to run
  it. A gate that only catches new problems plus a review that only happens when
  remembered leaves everything already in the baseline unread.
  - **The headline finding is that none of the eight were live.** All 8 were
    `resolvedOnDefaultBranch: true` — no scan of `main` reported them any more.
    They sat as `DETECTED` because GitLab holds that state until someone acts, and
    the report's default view does not surface the distinction. Three were the
    #83 SSRF false positives, dismissed as `FALSE_POSITIVE` with evidence; the
    other five (four Next.js CVEs — **CVE-2026-64649**, **CVE-2026-64641**,
    **CVE-2026-64645**, **CVE-2026-64642** — and `sharp`'s inherited libvips
    advisory **GHSA-f88m-g3jw-g9cj**) were marked **resolved rather than
    dismissed**, because they applied perfectly well and were genuinely fixed by
    the `next@16.2.11` and `sharp@0.35.3` bumps already in the lockfile.
    Dismissing a real finding that a version bump fixed would misrecord why it
    went away. **Zero HIGH and zero Critical now sit in a `DETECTED` or
    `CONFIRMED` state project-wide.**
  - **A monthly `security_assessment` job**, on the 1st at 08:00, files the dated
    work item the Duo assessment prompt requires, pre-filled with the data the run
    needs — so the documented cadence has a mechanism instead of a memory. It
    declares `needs: []` and is not `interruptible`: the point is that it always
    runs and always finishes. **Its digest leads with the number the Vulnerability
    Report does not show — how many findings are still detected on `main`** —
    because a digest that printed "8 HIGH" and stopped would reproduce the exact
    confusion above. With no `GL_TOKEN` configured it previews to the log, posts
    nothing and exits 0.
  - **The MEDIUM findings are deliberately not triaged** — 64 of them once the
    HIGH ones were cleared — but one measurement was taken to make that decision
    cheaper later: `main`'s own scan reports **18 MEDIUM**, so roughly three
    quarters of the MEDIUM baseline is in the same already-fixed-never-resolved
    state the HIGH ones turned out to be in. Left to the first scheduled
    assessment run, which will report the live number rather than the baseline's.

- **`brace-expansion` is on the patched 5.0.8 wherever it can go (#82).** This
  is **CVE-2026-14257** (High) — a DoS via unbounded expansion length that
  crashes the process with an OOM a `try`/`catch` cannot trap. The advisory
  widened after #55: the 2.1.2 that #55 landed on is itself affected, and only
  5.0.8 is clean (`npm audit` range `<=5.0.7`).
  The `brace-expansion: ^2.0.2` override #55 added had also become the *cause*
  of two of the three affected copies — `minimatch@10.2.5` already asks for
  `brace-expansion@^5.0.5`, and the override was pinning it back down to 2.x.
  Installed affected copies go **3 → 1**.
  - **This does not clear the finding, and is not claimed to.** GitLab's
    Dependency Scanning already reported `brace-expansion` as a *single* finding
    (it reports per package version in `package-lock.json`, and all three copies
    were the same 2.1.2), so the HIGH stays — now attributed to 2.1.3. What
    changes is that two of the three installed copies are genuinely patched.
    Clearing the finding needs the upstream move described below, or a policy
    decision on #82.
  - **The one remaining copy is upstream-blocked, not overlooked.** It serves
    `minimatch@3.1.5`, which does `expand(pattern)` on a default import;
    5.0.8's CommonJS build exports only `{ expand }`, so forcing it there
    raises `TypeError: expand is not a function` and takes ESLint down
    wholesale. `minimatch@3.1.5` is required by `eslint`, `@eslint/eslintrc`
    and three `eslint-config-next` plugins (`import`, `jsx-a11y`, `react`) —
    none of which has a release that moved off `minimatch@3`, including with
    `eslint@10`. It is scoped to 2.1.3 via a nested override until they do.
  - **Reachability:** **no copy of `brace-expansion` ships in the production
    image at all** — it is absent from the `output: "standalone"` trace and from
    the image's isolated `prisma`/`dotenv`/`tsx` install. It reaches the tree
    only through build and lint tooling, so no request path can feed it
    untrusted input. Since #93 moved `shadcn` to `devDependencies`, **no copy is
    declared under runtime `dependencies` either** — the copy that used to be
    (`shadcn` → `ts-morph` → `@ts-morph/common`, on 5.0.8 anyway) is dev-only
    along with the rest, so all three are now `devDependencies`-only.
  - **Operators:** no action.

## [0.4.0] - 2026-07-27

**Focus-session depth + bring-your-own-model.** A focus session is now something you
can sit inside for an hour: real lo-fi music with a playlist that actually moves on,
a pause that survives a reload or a second device, and a setup screen that puts one
number and one action in front of you instead of four competing figures. Alongside
it, the dormant LLM seam is live — a self-hoster can point dlectroflow at a local
model or another vendor instead of needing an Anthropic key.

### ⚠️ Upgrade notes

- **This release migrates the database.** Four Prisma migrations run on container
  start: `FocusSession.pausedAt` + `accumulatedPausedMs` (#27), a widened
  `Settings.focusSound` CHECK constraint (#43), `Settings.focusShuffle` (#68), and a
  **one-off data cleanup that deletes orphaned `Task` rows** (#64). The schema
  changes are additive and default-valued; the cleanup is idempotent and only
  removes rows that were already unreachable from the Library. Still: take a backup
  and upgrade sequentially from 0.3.0.
- **New environment variables — required only if you change LLM provider (#59).**
  `LLM_PROVIDER` still defaults to `anthropic`, and that path is unchanged, so an
  existing deployment needs no config edits. Setting
  `LLM_PROVIDER=openai-compatible` makes **`LLM_BASE_URL` and `LLM_MODEL`
  boot-required in production** — the app refuses to start without them rather than
  failing at first use. Optional alongside them: `LLM_API_KEY` (omit it for local
  runners that need none), `LLM_OWNER_MODEL` / `LLM_GUEST_MODEL` (per-role split,
  each falling back to `LLM_MODEL`), and `LLM_SUPPORTS_TOOLS=false` for a model
  without native tool-calling. All documented in `.env.example`.
- **The container image is larger** (~893 MB) because the lo-fi tracks are bundled
  (#43). A cold rollout onto fresh nodes now spends real time pulling it, so the
  deploy jobs' `helm --timeout` was raised (production 10m → 20m, review 10m →
  15m). If you deploy with your own `helm --timeout`, raise it too — the first
  rollout of this version can otherwise time out and roll back on time alone,
  with healthy pods.

### Added

- **Bring-your-own-LLM (#59):** the `LLM_PROVIDER` seam is now real. A `getLLM()`
  factory serves one normalized provider interface behind every AI call (task
  breakdown, daily spark, end-of-day round-up, focus re-estimate), with two
  adapters: `anthropic` (today's behaviour, unchanged) and `openai-compatible` —
  one adapter covering hosted vendors (OpenAI, OpenRouter, Groq, Together) and
  local runners (Ollama, LM Studio, vLLM) via a base URL. Models for a
  non-Anthropic provider come from env rather than the built-in allowlist, and a
  model **without** tool-calling still works: steps are requested as JSON in the
  response and, if that can't be parsed, the deterministic local breakdown takes
  over. Provider health is surfaced on `/api/livez` (`llmFailures`), and retryable
  429/5xx responses get bounded backoff (never mid-stream).
- **Real lo-fi focus music (#43):** the placeholder sound is replaced by 10 curated
  **CC0** tracks (one per open-lofi category, bundled — no external requests, no new
  CSP origin, provenance recorded in `public/audio/LICENSE.md`). Settings gains a
  track picker with per-track preview, and `/focus` gets a mini-player
  (play/pause, prev/next, volume, now-playing as text). The music is coupled to the
  timer: pausing the session pauses the music, resuming resumes it, and it stops
  when the session ends.
- **The playlist moves on, and can shuffle (#68):** a track no longer loops
  forever. Playback walks the library as a "pass", so nothing repeats until the
  pass is exhausted, and Shuffle deals a shuffled copy of that order up front
  (rather than picking at random per track, which is what made it feel repetitive).
  The preference persists per workspace. This is Phase 1 — per-category playlists
  wait on catalog streaming (#61).
- **True pause/resume for the focus timer (#27):** pausing is now persisted, not
  just local React state, so a paused session survives a reload or a move to
  another device. The clock freezes at the pause instant — a session left paused
  overnight doesn't silently drain — and resuming returns the exact remaining time
  you left, across any number of pause/resume cycles. Pressing Start on a step with
  a genuinely paused session offers **both** "Resume · ~Xm left" and "Start fresh"
  instead of guessing. Task-level "time left" figures now derive from the same
  effective-remaining calculation, so the step and the task agree.

### Changed

- **Focus setup screen: one number, one action (#66).** The pre-session screen
  showed up to four figures at once (ring countdown, step-context line, the Resume
  button's own estimate, and a duration input) — and in the resume case two of them
  contradicted each other. Now the ring shows a single number labelled for what it
  is, there is one primary action, duration is a chip row (5/10/15/25m, plus the
  step's own estimate when it's off-preset) instead of a free-type input, and
  "Start fresh" reveals the chips only when asked — reversibly, so a mis-tap can't
  retire a paused session. On a multi-step task, `Step N of M` becomes the header
  eyebrow and the whole-task total is demoted to one quiet line: re-ranked, not
  removed.
- **CI is faster without weakening any gate (#53):** the image build no longer
  waits on tests it doesn't consume — the "no deploy from a red suite" gate moved
  downstream to the deploy jobs, and tag pipelines explicitly re-add the test gate
  so a release image can never be published from a red suite. Secret detection was
  deduplicated.
- **Dependency health:** `react` + `react-dom` upgraded to 19.2.8 as a peer pair,
  with a Renovate grouping rule so the React peer set always lands in one MR;
  `@axe-core/playwright` pinned; `google/cloud-sdk:slim` and `renovate/renovate`
  image digests refreshed.
- README now opens with an AI-built + no-warranty transparency note.

### Fixed

- **Phantom tasks in the focus launcher, and completions that never reached the
  Library (#64).** Deleting a captured item left its linked `Task` behind: the
  Focus launcher reads `Task` directly and kept offering the orphan forever, while
  the Library (which reads only captured items) couldn't see it at all — so
  completing it wrote to zero rows. Deletion now removes the linked task in the
  same transaction, and the migration clears orphans created before the fix.
- **Mobile drag preview (#62):** dragging an inbox row showed a grip-sized sliver
  with the title wrapped to one word per line; the drag ghost now sizes to its own
  content and reads as a full row, as it does on desktop.
- **Cramped breakdown step rows on mobile (#63):** the step row's controls now
  stack below `sm:` instead of overflowing and truncating the step text.
- **The saved-for-later "Review now" button failed WCAG-AA contrast (#56).** The
  idle row dimmed itself with `opacity-70`, which composited the brand-coloured CTA
  toward the background (~3.3:1). The dim now applies to the title line only, so
  the row still reads as asleep while the CTA stays at 5.4:1 (light) / 6.3:1
  (dark).
- **Renovate-generated lockfiles could no longer be installed by CI (#67):** two
  dependents needed incompatible `esbuild` ranges, so npm nested a second copy —
  and Renovate's newer npm dropped that nested subtree while keeping the package
  requiring it, so every dependency MR failed `npm ci` immediately. Upgrading
  `tsx` collapses `esbuild` to a single hoisted version, leaving nothing for the
  two npm versions to disagree about. Tooling only: no user-facing change.

## [0.3.0] - 2026-07-26

The **open-source launch**: dlectroflow is now public under AGPL-3.0, running on its
own domain, with a visual-identity refresh and a batch of UX + accessibility polish.

### Added

- **Visual identity refresh** (#40): a real app icon / brand mark (favicon + in-app),
  a Settings typeface picker, brand accents across nav, and hero-surface polish.
- **Open-source project files**: `LICENSE` (**AGPL-3.0**), `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`; README rewritten self-host-first with a live-demo pointer and
  a Roadmap section.
- **Guest read-only settings** (#11): guests see the owner settings UI, disabled, so
  the app's capabilities are legible without exposing owner-only controls or values.
- **Stale-reminder as a notification chip** (#57): the "still needed?" nudge is now a
  compact, tinted, glanceable chip instead of muted background text.

### Changed

- **Primary domain is now `dlectroflow.dev`** (#54). The previous
  `dlectroflow.dlectronique.dev` permanently redirects to it (path + query preserved).
  Self-hosters set their own `host`; the app's origin is env-driven (`PUBLIC_ORIGIN`).
- **Inbox row hierarchy** (#50/#51/#52): the task title is the dominant element, the
  age/status pill moved down to the metadata line, and the stale banner no longer
  outweighs the row.
- **Inbox is served at the root `/`** (#58); `/inbox` permanently redirects to it.
- **Dark-mode toggle moved into the app header** (#49).
- Repo tidied for public consumption (internal design docs under `docs/design/`).

### Fixed

- `/library` tab-count pill failed WCAG-AA contrast once state accumulated (#48);
  fixed and the axe accessibility gate now covers `/library`.
- Aging label + nav aging-count contrast, and the "Help & Docs" footer spacing/casing.

### Security

- Bumped `brace-expansion` past **CVE-2026-14257** (High, DoS) (#55).
- Hardened the repository for public release: full git-history secret scan (clean),
  personal/infra fingerprint scrubbed from docs/config/CI, CI job logs made private,
  per-feature project visibility locked down before going public.

## [0.2.0] - 2026-07-22

Generalizing the scheduling stack for open-source (epic #29) and closing the loop
from *scheduled* → *focusing*, plus a CI/quality-gate build-out, Helm hardening,
and dependency/data-integrity security fixes.

### ⚠️ Upgrade notes (optional — no breaking changes, no new required env vars)

- **Preserve real client IP for the guest quota (#28):** the fix is a cluster-side
  ingress-nginx change (`controller.service.externalTrafficPolicy=Local` + ≥2
  controller replicas + a PDB via `controller.minAvailable`), not a chart change —
  apply it per `docs/deploy-runbook.md`. Until then the per-IP guest quota can be
  bypassed via node-IP SNAT collapse.
- **Weekly ops digest (#33):** posts only once the `OPS_DIGEST_ISSUE_IID` and
  `GL_TOKEN` (Reporter + `api`) CI variables are set; until then it runs a harmless
  preview and never fails the schedule.

### Added

- **Focus deep-link in scheduled events (#39):** a scheduled task's `.ics` events
  and Google Tasks now carry a short voice-aware note plus an absolute deep-link
  straight into the `/focus` timer.
- **/focus redesign (#41):** a step-picker launcher (resume hero + lanes), a
  redesigned timer with four styles (ring / digits / bar / mug) + previews and an
  optional completion alarm chime, and an app-wide completion-style Appearance
  setting (strikethrough + tick colour, WCAG-AA).
- **Scheduling-provider seam (#34):** `{ics, googleTasks}` behind one interface
  with a shared schedule + reward path — the foundation for generalized scheduling.
- **Weekly ops digest (#33):** a scheduled pipeline posts prod health, failed-CI,
  security, and dependency-upgrade signals to a standing tracking issue.
- **Playwright E2E smoke suite (#37):** browser tests across the core flows, wired
  as a blocking merge gate.
- **CI quality gates:** Prettier + `prettier --check` formatting (#32), a mechanical
  accessibility (axe) check on core routes (#31), and an `.env.example` drift check
  that fails on missing/extra keys (#30).

### Changed

- **Dropped Reclaim (#36):** removed the Reclaim client/model/routes; scheduling now
  flows entirely through the provider seam.
- **Helm chart hardening (#15):** opt-in spot-instance toleration, a CPU-limit
  throttling fix, and Renovate tracking for `values.yaml` image tags.

### Fixed

- Flaky roundup-card notification that fired twice and produced false CI failures
  (#42).

### Security

- **`sharp` → 0.35.3** via a `package.json` override, remediating inherited libvips
  vulnerabilities CVE-2026-33327 / -33328 / -35590 / -35591 (#47). Transitive via
  Next.js image optimization; low exploitability (no untrusted-image surface).
- **DB-level CHECK constraints** on status/role columns (pseudo-enums) enforcing
  data integrity at the database (#38).
- **Real client-IP preservation at the ingress (#28)** so the per-IP guest quota
  can't be bypassed (see upgrade notes).

## [0.1.0] - 2026-07-19

The wireframe → product build (#8): a Plain/Playful voice layer, inbox
information architecture, the Library hub, settings hub, and an accessibility
pass — plus the #21 security-hardening suite and guest-data retention.

### ⚠️ Upgrade notes (operator action required)

- **New required env var in production:** `TOKEN_ENC_KEY` — a 64-hex-character
  (32-byte) key used to encrypt OAuth tokens at rest (AES-256-GCM). The app now
  **refuses to boot in production** if it is missing or malformed. Generate with
  `openssl rand -hex 32`. This joins the existing production boot-guard set
  (`AUTH_SESSION_SECRET` ≥32 chars, `OWNER_ALLOWLIST`, `GITLAB_OAUTH_CLIENT_ID`,
  `GITLAB_OAUTH_CLIENT_SECRET`, `GUEST_IP_HASH_SALT` ≥16 chars). `PUBLIC_ORIGIN`
  is also required in production (used to derive OAuth redirect origins).
- **App ↔ database now requires TLS** (`sslmode=require`). Ensure your PostgreSQL
  presents a certificate the app trusts before upgrading.

### Added

- Complete + Completed bucket board: drag items between buckets, a "Move to…"
  menu, and a per-step Reopen picker (#10).
- Inbox information-architecture overhaul — a 4-tier freshness model,
  freshness-aware sort, a "freshen" action, and a ☰ navigation menu.
- Task-row and step-row redesign with inline row-level scheduling, and reward
  parity when scheduling a single task (#25).
- Settings → Integrations panel for connecting Google Tasks, with automatic
  cleanup of revoked/expired tokens (#22).
- In-app getting-started docs at `/help`, linked from Settings and the nav menu.
- Voice/tone foundation (Plain / Playful) with voice-aware step labels.
- Breakdown editor controls: step emoji picker and add/remove-step, plus
  send-to-review.
- Daily automated PostgreSQL → GCS backups with retention, plus a documented
  `helm --atomic` rollback runbook.
- Operational observability: process-only liveness probe and surfaced AI
  provider failures instead of silent errors.
- Library "Everything" hub — a dedicated `/library` view with Single-task /
  Multi-step / Saved-for-later / Done tabs, per-row actions, and a single-open
  expand/collapse toggle (#8).
- First-run welcome card, a non-destructive "first-run preview" demo toggle, and
  a low-shame "Pause for now" focus exit with an Inbox "resume →" banner (#8).
- Settings hub finish — freshness settings that auto-save (the Save button is
  gone), per-type desktop-notification toggles (end-of-day round-up / aging
  reminders / daily-review nudge), and a client-triggered daily-review nudge (#8).

### Changed

- Routine dependency and base-image maintenance via Renovate: Next.js/React
  ecosystem, ESLint 9, Anthropic SDK, jsdom, lucide-react, resend, shadcn,
  Kaniko executor, helm-kubectl, and the Node base image; `framer-motion`
  replaced by its `motion` successor.
- CI/tooling reliability: switched Renovate to the `-full` image and bumped it
  39 → 43 to fix lock-file artifact crashes (#24); deferred the ESLint (<10) and
  TypeScript (<6.1) majors until the plugin chain supports them.
- Repointed deploy references to the `gl-demo-ultimate-dtop/domi-oss` subgroup.
- Ignore `.claude/` agent worktrees in git and ESLint.
- Accessibility pass — honour `prefers-reduced-motion` (the focus confetti no
  longer animates under reduce), WCAG-AA contrast in both light and dark themes,
  ≥44px touch targets, and status conveyed by text/icon (never colour alone) (#8).

### Fixed

- Intermittent 503s during rollouts — run 2 app replicas behind a
  PodDisruptionBudget.
- Duplicate end-of-day round-up email — an atomic claim replaces a
  check-then-act race (#18).
- Board drag-and-drop on touch / mobile screens (#26).
- Inverted "More / Fewer" control in the breakdown editor.

### Security

- **Encrypted OAuth tokens at rest** (AES-256-GCM) so a database dump alone does
  not expose them. Introduces the required `TOKEN_ENC_KEY` (see Upgrade notes).
- **Enforced TLS between the app and the database** (`sslmode=require`), plus a
  documented database-leak credential-rotation runbook.
- **Session and cookie hardening** — signing-algorithm pinning, hardened guest
  and owner session cookies, an owner session lifetime, POST-based logout, and
  safer forwarded-header handling.
- **Hardened validation of outbound request targets** to prevent server-side
  request forgery.
- **Robustness fixes** across concurrency- and parsing-sensitive paths.
- **Owner-gated the round-up email** configuration and send path, removing a
  guest-accessible route.
- **CI security gate** — type-check, lint, and tests now run ahead of image
  build and deploy, so a red suite can't reach production.
- **Guest-data retention** (#21) — a 30-day purge of IP-hash-keyed guest
  rate-limit counters plus an owner-guarded cascade delete of expired guest
  workspaces, run by a daily production-only CronJob. Workspace-scoped rows now
  cascade via foreign keys, so no orphaned guest data lingers after a sandbox
  expires.

## [0.0.1] - 2026-07-08

Baseline — first tracked release of the shipped app.

### Added

- Core ADHD loop: **capture → clarify → schedule → focus → reward** — brain-dump
  capture with triage and aging reminders, Claude-powered task breakdown
  (streaming chat), scheduling into Google Tasks / Reclaim, a focus timer, and a
  rewards dashboard with streaks and badges.
- Desktop notifications with a demo override.
- End-of-day round-up (in-app + desktop) and opt-in round-up email (Resend).
- Workspace access **Phase 1** — owner GitLab OAuth login plus isolated
  per-browser guest sandboxes.
- Workspace access **Phase 2** — guest AI cost controls (per-IP and global daily
  caps), per-role breakdown models, client-side `.ics` calendar export, a 24-hour
  guest sandbox TTL, and dark mode.
- GKE Autopilot deployment with valid TLS, per-MR review apps, and the full
  GitLab security-scanner suite.

[Unreleased]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/compare/v0.5.0...main
[0.5.0]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/compare/v0.4.0...v0.5.0
[0.4.0]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/compare/v0.3.0...v0.4.0
[0.3.0]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/compare/v0.2.0...v0.3.0
[0.2.0]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/compare/v0.1.0...v0.2.0
[0.1.0]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/compare/v0.0.1...v0.1.0
[0.0.1]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/releases/v0.0.1
