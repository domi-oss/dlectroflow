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

> Shipped to production but not yet tagged. At cut time this becomes
> `## [X.Y.Z] - <date>` and a fresh empty `## [Unreleased]` is added above it.

### Added

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

### Security

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

[Unreleased]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/compare/v0.4.0...main
[0.4.0]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/compare/v0.3.0...v0.4.0
[0.3.0]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/compare/v0.2.0...v0.3.0
[0.2.0]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/compare/v0.1.0...v0.2.0
[0.1.0]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/compare/v0.0.1...v0.1.0
[0.0.1]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/releases/v0.0.1
