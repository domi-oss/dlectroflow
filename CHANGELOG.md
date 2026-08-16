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

- **The task row's action bar fits a phone (#253).** At 360px the row had grown to
  roughly seven stacked bands of controls. This is a **height** fix and not a
  touch-target one: every control on the row was already 44px and still is.

  The inline actions come down to four — the row's main call to action, **Save**,
  **Complete** and **Note** — and the trailing cluster of icons is gone. Move,
  schedule and delete were removed as props rather than merely hidden, because a
  prop that renders nothing is how a defect comes to be described in terms of a
  control nobody can see. The **▾** becomes the row's canonical action list instead
  of a mirror of what is already on it: what reshapes the item, in the order it
  escalates, then the two calendar entries, then **Delete** last as the destructive
  answer.

  Three entries were **removed** rather than moved. The nested `Move to…` picker;
  `Snooze 1h`, whose sixty-minute write is still reachable through **Save for
  later**, which dispatches the identical action; and `Edit task title`, a mirror of
  the ✎ pencil whose own label already names the row it belongs to. The ✓ came off
  **Complete** in `src/lib/strings.ts`, which nine callers read, so the label moved
  in one place. All four row renderers change, and a 360px assertion in
  `e2e/smoke/row-menu-viewport-fit.spec.ts` holds the height from now on.

- **A completed to-do can be deleted, and deleting it gives back what it banked
  (#251).** Completing something moved it into the Done bucket and took away every
  way of getting rid of it, so to-dos completed while demoing the app stayed in the
  list permanently. The 🗑 the other buckets already have is now on the inbox's
  Completed bucket too, and the Library's Done tab gets a delete of its own.

  **The reward reversal is a full one** — points and badge progress both — and it is
  stated as an equality rather than as a second rule: a delete owes exactly what
  reopening the same row would owe, one `step_done` per done step it destroys plus a
  `task_complete` if it was carrying a completion. Reopen-then-delete and delete
  outright therefore land on the same balance, and neither route can drift from the
  other. It also gets the Library's fully-done rows right, where every ticked step
  banked a `step_done` even though no completion was ever stamped.

  **Both halves run inside the delete's own transaction.** A reversal that failed
  after the row was gone would leave the points banked with nothing left to ever take
  them back, and production runs two replicas. The completion is claimed by a guarded
  write before the delete, so a second concurrent delete re-evaluates its condition
  after the row lock, matches nothing and reverses nothing — without that gate both
  callers would see the completion set and both would take a `task_complete`, and
  since a reward event holds no link back to the to-do that earned it, the second one
  would come out of unrelated, already-settled work. An over-large reversal stops at
  zero rather than going negative or borrowing from another reward type.

- **Brain dumps survive a bad connection, and save themselves when it comes back
  (#175).** Press Enter with patchy coverage and the words were gone: the capture
  bar held one failed write in a notice, and a second failure displaced the first
  — whose words were then in neither the notice nor the box. On a phone, where
  this feature is aimed, it was worse than that: Chrome discards background tabs
  under memory pressure and **fires no unload event**, so the notice and the words
  went with the tab.
  A capture is now written to this browser's own storage **before** the network is
  attempted, so nothing can lose it — not a closed tab, not a killed browser, not
  a reboot. Everything not yet on the server is listed in a **"N waiting to save"**
  strip under the capture box: expand it to read or copy the words, retry them, or
  discard one for good behind a two-step confirm. They flush by themselves on
  four triggers — opening the inbox, returning to the tab, the connection coming
  back, and the next capture — and through **Background Sync**, which is the only
  path that saves them while the app is closed. Firefox and Safari have no
  Background Sync; there the words are just as safe and save on the next open.
  Three things are worth knowing. **The strip never says "offline"** — a browser
  reports itself online on a captive portal, in a lift and at the edge of
  coverage, so it says what is true instead: the words are held, and what will or
  will not move them. **A session that expired is refused and kept**, with
  *"Sign in and these will save"* rather than being written into a throwaway
  sandbox that gets purged. And **retrying is safe**: each capture carries a
  one-time key, so words that quietly saved on a first attempt cannot arrive twice.
  For operators and self-hosters: this needs no new environment variable, and it
  is the browser half of the `POST /api/braindump` route and the
  `braindump_item_client_key` migration that shipped in v0.6.0. If you override
  `GUEST_SANDBOX_TTL_HOURS` **above 24**, raise `CAPTURE_ORPHAN_WINDOW_HOURS` in
  `src/lib/capture-queue.ts` to match — CI can only compare the two defaults, and
  a client window shorter than the server's TTL would expire captures whose
  account was still reachable.
  **`/privacy` has changed and its effective date has moved**: text you typed is
  now stored in the browser, which it never was before, so the notice names both
  stores and gives the retention as three triggers.

- **A name in the header, and one-tap access to the timer and the shopping list
  (#252).** The bar greeted people by their **provider username** — the
  lowercased handle the OAuth provider issued, else eight characters of an
  account id — because nothing on the account held a name. `Account → Your name`
  now sets one; it saves as you type, changes nothing about signing in, and
  emptying it goes back to the username. An account that never sets one is
  unchanged, which is every existing account: the new column is nullable and
  nothing is backfilled.

  The bar also carries a **timer button** and, when shopping-list mode is on, a
  **trolley** — both previously reachable only by opening the menu and reading
  seven labels. The timer shortcut is **on by default** and
  `Focus timer → Shortcut in the header` hides it; hiding the button leaves the
  focus timer in the menu. Neither shortcut costs a query: both gates were
  already on the settings row the header reads.

  Two things narrower phones get out of this. The bar is measured at **360px**
  now rather than only at 390 — it had been overflowing a 360px viewport before
  this change and nothing could see it — and below `sm` the brand shows its mark
  with the wordmark kept for screen readers, which is what makes room for the
  new controls.

  Operators: one additive migration, both statements metadata-only.
  `User.displayName` is nullable with no default; `Settings.focusQuickAccess` is
  a boolean defaulting `true`, stored in the catalogue rather than written into
  existing rows. No new environment variables.

- **An alert about production that reaches a person, and cannot go quiet (#191).**
  Production once served code from two days earlier on **one replica instead of
  two** for roughly 24 hours before anyone noticed. Every signal existed — six
  failed Helm revisions, `1/2 READY` throughout, and a note on the ops issue that
  said in as many words that production was not running `main`. Nobody read it. So
  the gap was never detection: **an alert nobody receives is not alerting, it is
  logging.**

  A new hourly job, `alert_prod_state`, answers two questions a deploy cannot: is
  production on `main`, and is it running every replica it should be. The replica
  half is genuinely new — a commit comparison against `/api/health` cannot see a
  half-empty Deployment, because that endpoint is answered by whichever pod the
  Service routes to, so a `1/2` whose surviving pod is on the right commit reads
  green. A wedged Prisma migration shows up here too: migrations run in an
  initContainer, so a failed one is a pod that never becomes ready, and `P3009`
  appears in no other signal at all.

  **The delivery is the point, and it needs no new account, secret or service.**
  GitLab already notifies the owner of a pipeline schedule when its pipeline
  fails, so the job exits non-zero on every outcome that is not "verified
  healthy" — including "could not tell" and "the note was rejected". A red job
  *is* the out-of-band alert. The note it posts carries the diagnosis, and setting
  `ALERT_MENTION` to a single `@handle` makes it raise a to-do as well.

  **New optional variable, and it is not a secret:** `ALERT_MENTION`. Self-hosted
  operators need nothing; the job only runs on a pipeline schedule that does not
  exist unless you create it. `docs/deploy-runbook.md` § 18 documents the setup and
  how to read an alert, § 19 the wedged-migration recovery it points at.

  It reports **how long**, not just whether: "behind since 24 hours ago" is a state
  that stays true until somebody fixes it, where a failed deploy is an event that
  is easy to miss. And it will not cry wolf — a rollout inside Kubernetes' own
  `progressDeadlineSeconds`, a deploy still in flight, and a replica shortfall that
  has lasted less than one hour are all reported as in progress rather than alerted
  on, because a channel that fires on every normal deploy gets muted, which is what
  took the original alert down. The one-hour wait is the schedule's own cadence, so
  a shortfall that does not fix itself alerts on the second run and the 24-hour case
  is still caught an hour in; a routine pod replacement, which is a minute of `1/2`
  with the rollout long finished, never alerts at all. **Drift is never waited on** —
  production running the wrong commit is not transient and alerts on first sight.
- **A build-time guard on where regular expressions get their patterns
  (#234).** Nothing changes for anyone using dlectroflow; this is about the
  project's own security scanning, and self-hosters inherit the same guard.

  One scanner rule — "this regular expression was built at run time rather than
  written out" — accounts for **more than a third of everything the scanners
  report** about this codebase, 58 records across the project's history with 57
  of them already reviewed and dismissed, and none was ever a real problem:
  every pattern here is assembled from fixed constants, from text already
  escaped, from identifiers in the project's own database migrations, or from a
  test's own fixtures. There is no route from anything a user types to one of
  them.

  The cost was never that these blocked anything — they did not. It was that the
  scanner remembers a finding by its **position in the file**, so adding a
  comment above one brought an already-reviewed finding back as brand new, and
  somebody had to read it and write down why it was fine all over again. Three
  came back on a change to the page footer. The same three in the tenancy test
  harness had been reviewed and dismissed eleven times since July.

  So the rule is turned down to informational, and a check that lives in this
  repository takes over the part that matters: every `new RegExp` must build its
  pattern from something no request can influence, and anything else has to be
  listed with a written argument and a count of how many places it covers.
  Unlike the scanner, it **fails the build** — which is stricter than what the
  rule was doing — and it identifies a site by what the code says rather than by
  which line it is on, so moving code around no longer resurrects settled
  questions.

  The neighbouring rule about patterns that can be made to run slowly is
  **deliberately left alone**: it measures something the new check does not, so
  turning it down would be claiming a safeguard that does not exist.

- **The inbox tells you the shopping list is there (#199).** When something is on
  the list, one line at the top of the inbox reads *"3 items on your shopping
  list"* and takes you straight there. **Not now** clears it, and it comes back the
  next time the list grows — adding an item, un-ticking one, or pulling one back up
  out of Saved for later. Ticking things off does not bring it back: that is
  progress, not a new reason to be reminded. If a **Not now** does not reach the
  server it says so and leaves the line where it is, rather than disappearing and
  turning up again later as though the button had never worked.

  The count is worked out from the list itself every time the inbox renders, and
  nothing anywhere stores a copy of it — so the number cannot drift away from the
  list, and the worst a missed update can do is hide the line rather than show a
  figure that is wrong. It is also not a captured item: it does not count toward
  the number of things you have to triage, it does not age, it cannot be dragged
  into a bucket, and it does not stop you reaching inbox zero.

- **A shopping list, if you want one (#199).** A plain list for the things that are
  not tasks: no estimate, no steps, nothing that lands in your calendar, and
  ticking one off does not touch your streak. It lives at its own `/shopping`
  destination in the menu, with a second **Saved for later** section below the
  live list — undated on purpose, so nothing there comes back on its own; you pull
  an item up when you want it again, and it arrives back un-ticked, because
  pulling it up is you saying you want to buy it.

  **Off by default**, behind Settings → Shopping list. Nothing is stored until you
  turn it on, and turning it off again hides the list rather than deleting it, so
  the items are still there if you change your mind.

  Shopping items are their own kind of thing rather than tasks in disguise, which
  is what keeps them out of the focus timer, the scheduler and the streak — the
  code that grants those cannot see them. Entries are capped at 200 characters and
  a list at 500 items. `/privacy` names the new category of stored content and the
  effective date moves with it.

- **Any inbox row can be scheduled and noted, untriaged ones included (#186), and
  capture can write the note inline (#179).** `BrainDumpItem` gains a notes column
  and the three schedule-intent columns, mirroring `Task` field for field, so an item
  no longer has to be triaged into a task before it can carry a deadline or a note.
  Item rows get the full Schedule menu, the `.ics` branch keeps its own duration
  path, and needs-review rows reuse the existing note row rather than a fork of it.

  **The inline syntax is one rule with no second clause:** a `{…}` group at the very
  end of what you type becomes the note. So `water the office plants {can under sink
  needs a wash}` splits, and `fix the {foo} handler` does not — nor does
  `rename {old} to {new}.`, because the full stop means the group is not final. That
  refusal is the feature rather than a limitation of it: a syntax that fires
  mid-string needs an escape character, and an escape character is a second syntax
  nobody remembers at the speed a brain dump happens. The group is found by scanning
  **backwards** from a closing brace, so an earlier placeholder survives —
  `deploy the {{VERSION}} chart {check values.yaml}` keeps the placeholder in the
  text where a forward search would have eaten most of the capture. Unbalanced braces
  are left literal.

  **One residual case is accepted knowingly rather than left to be discovered:** a
  trailing JSON object splits, because an end-anchored rule cannot tell it from a
  note. The alternative costs either an escape character or a content heuristic, and
  a heuristic that sometimes decides your note is JSON is worse than a rule that is
  always the same. It is visible and reversible either way — the split shows in the
  row immediately, and editing the text back re-runs the parser.

  Operators: one additive migration, no new environment variables. The notes column
  is bounded at 2000 code points by a CHECK constraint, the same bound as `Task`'s,
  because the value is copied into that column at triage. The schedule columns carry
  **no defaults** — NULL is what distinguishes "the owner chose this" from "nobody
  has said yet", which is the distinction prefill reads.

- **Pick your playlists and jump to any track, from inside the focus timer
  (#181).** The mini-player gains one expandable panel, collapsed by default and
  opening below the progress bar at a capped height with its own scroll. It holds
  both halves of "what am I listening to": a tick-list of the playlists the
  session draws from — ticking several plays the union, and each row shows how
  many tracks it has, because on an instance with no catalog configured they
  would otherwise all look identical — and, under it, the tracks that selection
  resolves to, grouped under their category headings, any of which starts playing
  when you tap its title.

  **Neither list interrupts what you are hearing.** Ticking a playlist while
  something is playing re-orders what comes next and nothing else; unticking the
  playlist of the track currently playing lets that track finish and draws the
  next one from the new selection, rather than cutting the audio mid-bar. Tapping
  a title plays it and then carries on through the rest of the list, so it is a
  jump rather than a filter. Changes save by themselves, a moment after the last
  tick.

  The panel is a real disclosure throughout: keyboard operable, Escape closes it,
  each playlist's track count is part of what a screen reader reads out rather
  than decoration beside it, and the playing track is marked in words as well as
  in colour.

- **Focus sounds are on by default, and Settings holds one switch (#180).** A new
  account starts with sound on, the ambient lo-fi playlist and shuffle — a
  catalogue you only hear after finding a settings page is a feature in hiding.
  **Existing accounts are not changed**: those are column defaults, applying to
  rows created after the upgrade, and there is deliberately no data migration
  turning anyone's audio on. `src/lib/focus-sound-migration-hygiene.test.ts`
  fails the build if a later migration ever tries.

  **Settings → Focus timer now holds a single on/off switch** and nothing else
  about music. The ten track radios, their preview buttons and #70's category
  radios are gone; which playlists and which track are chosen from the
  in-session player instead, because both are decisions you make while
  listening. One consequence is deliberate and worth knowing: **nothing
  persists an opening track any more**, so a session opens on the head of its
  playlist rather than on a track picked in advance.

  Under it, `Settings.focusSound` narrows from eleven values to `off | on`, and
  `Settings.focusSoundCategory` (one slug, or null) becomes
  `Settings.focusSoundCategories` — a text array guarded by a containment CHECK,
  so a playlist can draw from **several genre categories at once**. An empty
  array means the whole catalogue, which is exactly what the old `null` meant.
  Everyone's existing choice is carried across unchanged; where a row had both a
  track and a category, the category wins.

- **Notes on a task and on a step, which ride along into what you schedule
  (#44).** Jot the context you would otherwise lose — "bring the Figma link",
  "call before 5" — and it travels into the calendar event or Google Task
  alongside the focus deep-link, so the reminder arrives carrying its own
  context instead of just a title.

  **Collapsed until you want it.** With no note there is only a compact "Note"
  button; once a note exists it is shown as text, so coming back to a task never
  costs a tap to read what you wrote. It is a proper disclosure — keyboard
  operable, focus moves into the field when it opens and back to the trigger on
  Escape, and each control is named after the task or step it belongs to rather
  than being one of a dozen buttons all called "Note". Saving is automatic;
  there is no Save button.

  **Where both a task note and a step note exist, the scheduled item carries
  both**, task first. A calendar entry is read on its own, days later, so
  letting the step's note suppress the task's would mean the more carefully you
  annotate, the less each entry tells you. Notes are plain text (no markdown
  rendering) and bounded at 2000 characters each — Google Tasks rejects a note
  field over 8192, and yours is one part of what gets sent.

  Both notes are included in a data export: quoted in `tasks.md`, verbatim in
  `export.json`, and deliberately absent from the CSVs, where a paragraph with
  embedded newlines is the thing spreadsheets import wrong.
- **The focus timer can play the full lo-fi catalog (#61).** Ten CC0 tracks still
  ship inside the image, one per open-lofi category; the other 156 are read at run
  time from wherever an operator keeps them. **New optional environment variable:
  `FOCUS_CATALOG_ORIGIN`** (Helm: `focus.catalogOrigin`), pointing at a directory
  holding the extracted `openlofi.zip` — the mp3s plus `catalog.json`. Unset, which
  is the default, nothing changes.

  **The browser never talks to that store.** The CSP is unchanged — `default-src
  'self'` with `media-src` still unset — so third-party audio remains impossible
  during a focus session, and the bytes are fetched server-side and streamed back
  through `/api/focus-catalog/audio` instead, with `Range` forwarded so seeking
  works. Any credential the store needs stays on the server as a consequence
  rather than as a promise. Both routes require a session, guest sandboxes
  included, so an instance cannot be used as an open relay.

  Every failure keeps the music on: unset, unreachable, a broken manifest, an
  offline browser — the player falls back to the bundled ten and a session never
  starts silent. A configured store that does not answer logs
  `focus_catalog_unavailable` once per session, so the degradation is visible
  rather than silent. Licence and provenance for the streamed set are recorded in
  `public/audio/LICENSE.md`; setup is in `docs/self-host-vps.md` and
  `docs/deploy-runbook.md`.
- **A whole category of focus sounds can be the playlist (#70).** Settings now
  offers "Chillhop — whole category" alongside the individual tracks, using
  open-lofi's own category names. Picking one narrows the playlist to that
  category and plays it under the existing rules: it advances itself, and nothing
  repeats until every track in the category has had a turn.

  **The option only appears when a category actually holds more than one track.**
  With no catalog configured the app has one track per category, so a category
  picker there would be a second way of saying "this track" — the group is
  therefore absent rather than shown greyed out, and it appears on its own once
  `FOCUS_CATALOG_ORIGIN` points at a store with more. Nothing needs enabling. If a
  configured store later stops answering, a category you already chose keeps
  playing what is still available rather than quietly switching genre, and the
  setting stays visible so you can change it.

  Categories outside open-lofi's ten can be played but not pinned as a playlist:
  the preference is stored as a validated value, so a manifest's own category
  names are not selectable. Existing preferences are untouched — a fresh install
  and an upgraded one both start with the whole list.
- **Finishing a step no longer dead-ends (#142).** Completing a step used to swap
  the timer into a "done" screen on the same URL and stop; a single-task to-do got
  *"That was the last step of this task. 🏁"* and nothing else. Now the finish
  moves you on. Inside a multi-step task the next step arrives after a 5-second
  countdown, landing on its **start screen** — nothing begins a timer for you. At
  the end of a whole task the next task is offered rather than taken
  automatically, because that finish deserves a real pause, and stopping is a
  first-class button rather than a link hiding underneath. When there is nothing
  left at all you land on **Activity**, which is the one surface that treats an
  empty queue as an achievement; the daily spark is already there, and a quiet
  **Find something else →** link keeps the page from being a cul-de-sac.

  A new **hyper focus mode**, **off by default**, chains single-task to-dos the
  same way — turn it on from the /focus launcher, or accept the offer that
  appears when the multi-step queue empties. It governs single-task chaining
  only. The mode is remembered per browser rather than per account: it describes
  the session you are in, not a preference your account holds.

  **Accessibility.** A timed navigation that is not announced is a WCAG failure,
  so the countdown announces itself and how to stop it before it can run out
  (WCAG 2.2.1 Timing Adjustable). **Escape cancels** as well as the visible
  **Stay here** button, because tabbing to a control inside five seconds is not a
  real escape for anyone using a screen reader; the countdown also holds while
  the panel has focus, so reading the options is never a race. The escape does
  not move or relabel while you reach for it, focus lands somewhere deliberate on
  every transition (WCAG 2.4.3), and `prefers-reduced-motion` drops the animated
  progress track — the advance itself is unchanged, because that setting is about
  motion and not about what the app does.
- **Subscribe to your own schedule from any calendar app (#154).** Settings →
  Integrations gains **Calendar subscription**: one URL you paste into Google
  Calendar, Apple Calendar or Outlook once, after which your scheduled steps
  appear there and stay in sync. It needs **no Google account and no OAuth at
  all**, which is what makes it the half of the closed scheduling epic (#29) that
  serves a self-hoster rather than the hosted instance. Until now the whole ICS
  surface was the per-task download: one file, one task, no updates.

  **The URL is a credential**, because a calendar client cannot present a session
  cookie — Google, Apple and Outlook all fetch a subscription anonymously — so
  possession of the token is the entire authorization. It is 256 bits from a
  CSPRNG; regenerating replaces it in one write, so the old URL stops working on
  the very next request rather than at some later expiry; the responses are
  `no-store` so no shared cache can keep a revoked one alive; and the feed
  carries step titles and times and nothing else, because the URL will end up in
  a calendar provider's logs. The Settings card says all of that at the point you
  copy it, not in a paragraph further down.

  **It ends up in this instance's logs too, and the notice says so.** The token
  travels in the request path, so an access log entry for a feed fetch contains
  it — that is true of Caddy on the self-host path and of ingress-nginx on the
  Kubernetes one, neither of which is configured to drop it. Production keeps
  those entries for 30 days. The consequence for an operator is a rotation step:
  a leaked backup dump or a mishandled log export is a disclosure of every live
  feed token, and `docs/deploy-runbook.md` §15 now says to clear the table.

  New endpoint `GET /api/ics/feed/[token]`, which is the only route in the app
  that authorises from something other than a session — `/api/ics/[taskId]` next
  door stays session-scoped, because a task id is guessable in a way a token is
  not. Unknown, malformed, regenerated and revoked all answer the same 404.

  `/privacy` now discloses the new recipient (whichever calendar app you
  subscribe from, which is explicitly **not** a processor — you chose it), the
  stored token and its retention, the fact that the web server's access log
  records the URL and for how long, and the legal effective date moves with it.
  No new environment variable and no new dependency.

- **A member can export their own data (#129).** Settings → Account gains
  **Download my data (.zip)**, and `GET /api/export` behind it. The archive holds
  the same data written four ways, because no single format does every job: a
  `tasks.md` you can read in any text editor with the steps nested under their
  task, three RFC 4180 CSVs (`tasks.csv`, `steps.csv`, `inbox.csv`) joined on
  `task_id` for spreadsheets, a `scheduled.ics` for calendars, and a lossless
  `export.json` carrying `schemaVersion: 1`. A `README.md` inside explains every
  file and states what is deliberately absent — the OAuth tokens for a Google
  connection and any stored LLM API key are never exported, and the README says so
  rather than leaving a user to assume their Google connection travelled with it.
  UK GDPR Art. 15 and Art. 20 are the obligation; the archive is built to be
  usable long after that, which is why the human tier is Markdown.

  A guest sandbox can export too, deliberately: it expires within about a day, so
  the export is the only way anything done in one survives. `/privacy` now
  documents self-service access and portability instead of promising to answer by
  hand, and the legal effective date moves with it.

  No new dependency: the archive is a ZIP written with `node:zlib`, verified in
  tests against a reader written from the specification. The endpoint is metered
  per workspace (one export a minute) so a retry loop cannot make the instance
  rebuild a whole account's archive repeatedly.

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

- **A production log-retention check that verifies the artefact, not the status
  field (#157).** Keeping logs on GKE needs two independent settings to agree —
  the cluster's `loggingConfig`, which decides what to ship, and the project's
  `logging.googleapis.com` service, which decides whether anything accepts it —
  and neither can see the other. Enable only the first and logs are silently
  discarded while both settings still read as correct on their own.
  `scripts/check-log-retention.sh` sidesteps that by **reading a log line back
  out**, and follows `check-prod-drift.sh`'s three-state contract: `0` retained,
  `1` proven not retained, `2` undetermined. A successful query returning zero
  entries is `1`, not `0`, and a query that could not run is `2`, not either —
  collapsing those is the failure the check exists to prevent. It is read-only
  and reports provider errors as a category, never echoing an identifier, since
  the weekly `ops_digest` publishes its verdict on a public issue. Operator
  steps, and why the window is 30 days rather than a default nobody chose, are
  in `docs/deploy-runbook.md` § 16.

### Changed

- **`README.md` and this file caught up with what is on `main`.** The README gave
  `docker compose up -d db` twice in "Database & migrations". There is no compose file
  at the repo root, only `docker/`, so the bare form exits 1 with *"no configuration
  file provided: not found"* — while the Troubleshooting table two sections below
  already gave the `-f docker/docker-compose.yml` form. A document that disagrees with
  itself is the cheapest kind of defect to find and the most expensive to leave, so
  the reason is now stated once where the commands are rather than only in the row
  that catches the failure.

  Three shipped features were missing from the status table, which calls itself "what
  works today" and is promised further down as the reason you are never chasing
  something that is not wired up yet: notes on a to-do and on a step (#44) with the
  inline capture syntax (#179), the shopping list (#199), and the name in the header
  with its timer and trolley shortcuts (#252). **The shopping row says it is off by
  default and names the switch**, because a flat "works" overstates a feature nobody
  meets until they find Settings. The accessibility section described a single spec
  where `e2e/a11y/` now holds eight; its WCAG tags are unchanged and still 2.0/2.1
  A+AA. The table of contents had lost two of its own sections, and the stack list
  omitted Base UI, which seven components import.

  In this file, `[Unreleased]` had grown a **second `### Fixed`** below
  `### Security`, which made the entry it held invisible to anyone reading the section
  it belongs to, and six shipped changes had no entry at all (#251, #253, #186 with
  #179, #233, #244, #245). Each was written up from its own merge request rather than
  from its title.

- **The Privacy Policy now matches what the code does, in ten places, and its
  effective date moves to 15 August 2026.** Every correction runs the same way —
  the page was more reassuring than the software — so they are worth reading as
  one thing rather than a list of tweaks.

  **What the AI provider is sent.** The page said the context accompanying a
  breakdown "contains no free text". It has carried **the note on the task being
  broken down** since 8 August, quoted into the request verbatim up to 600
  characters. Now disclosed, alongside the fact that notes on your *other* tasks
  are never sent — the distinction the code actually draws.

  **What Google is sent.** Scheduling a step to Google Tasks writes a **notes
  field** as well as a title and a due date, and any note you wrote on that task
  or step is copied into it. The page described only the title and the date. The
  calendar **subscription feed** is unaffected and still carries titles and times
  only.

  **What deleting your account does.** The page said a freeze "marks its content
  to be removed 30 days later". Nothing removes it: the 30-day window is recorded
  but no job reads it, so the deletion is a hand operation. The page now says so
  for both routes — deleting your own account and having access revoked — and no
  longer implies anything happens when the window is up. **No behaviour changed
  here; the promise did.** If you want content gone, email and ask, and it will be
  done.

  **Health information in a free-text note.** The policy claimed *"explicit
  consent — Article 9(2)(a) UK GDPR"* permitted holding it. Nothing ever asked
  for that consent — there is no health field, no question that invites one, and
  no acknowledgement anywhere — so the claim is **withdrawn rather than
  mechanised**. A consent modal on a note box would be a dark pattern shaped like
  compliance, and would make the app worse at the one thing it is for. The page
  now states the true position: nothing here seeks health data, and whatever
  arrives in a note is held only as an unavoidable part of doing what you asked
  with the words you typed.

  **Four kinds of stored content that were never disclosed**: notes on tasks,
  steps and captures (up to 2,000 characters each), a display name if you set one,
  focus playlists and their names, and the coaching conversations — the last
  having been named in the Portability list while never being disclosed as stored.

  **What the export leaves out.** It withheld more than the two credentials it
  admitted to. Also absent, and now named on the page *and* in the archive's own
  README: your invitation record and any note whoever invited you wrote on it,
  your AI usage count, your calendar feed's timestamps, the flags saying whether
  the account is active or revoked, when it was last seen and when access was
  withdrawn if it ever was, and the account id your sign-in provider issued for
  you — as distinct from your username and the provider's name, both of which the
  export does include. Ask and any of it will be sent by hand, the invitation
  note included, since it is about you.

  **One sentence narrowed rather than removed.** "Nothing infers anything about
  how you are doing" was overstated: with the end-of-day round-up, a short
  narrative about your day is written from your own counts and stored. It is a
  summary of what you did, shown only to you, and nothing acts on it — but a page
  claiming nothing of the kind exists was wrong, so the sentence keeps its ground
  and states the exception. The rest of that clause is unchanged and verified:
  there is no health, mood, energy, sleep, medication or symptom field anywhere in
  the schema, and no questionnaire.

  Nothing an operator needs to do, no migration and no new environment variables.
  `docs/legal.md`'s re-check table gained the two trigger rows that would have
  caught the worst of these, and its "new Prisma **model**" row now covers a new
  **field** — which is how three of them got in.

- **The footer's Privacy, Terms and Source links now open in a new tab (#200).**
  That footer sits under every screen, the inbox included, and the old
  behaviour took you away from the page you were on. The reasoning written
  beside it — that nothing is lost because every bit of state is kept on the
  server — was not true of the words already typed into the capture bar, or of
  a note whose save had not yet gone through. In a tool built for catching a
  thought before it goes, that is the one loss with no undo.

  Opening a new tab is a change of context nobody asked for, so each link now
  says so out loud: its name reads "Privacy (opens in a new tab)". Sighted
  users watch the tab appear; anyone using a screen reader is told, which is
  the part that would otherwise be missing.

- **Inbox drag now runs on the browser's own drag and drop (#163).**
  `@dnd-kit/core` is replaced by `@atlaskit/pragmatic-drag-and-drop`. Dragging a
  row between buckets with a mouse or a touchscreen behaves as before, and the
  drag and the **Move to…** menu still share one dispatcher, so a drop and a
  menu pick can never mean different things.

  **One behaviour does change, and it is worth reading if you drag with a
  keyboard.** The old library had a keyboard drag mode — focus the grip, then
  arrow the item across the board. The new one has no keyboard drag at all, by
  design: its guidance is to offer an explicit control instead of arrow-key
  movement. That control already exists on every row — the **Move to** button
  (📥, and as "Move to…" in the ▾ menu) — so moving an item with the keyboard
  alone still works and takes fewer keystrokes than arrowing across the page
  ever did. The grip is now a pointer affordance only and is no longer a tab
  stop, because a focusable control that advertises a drag it cannot perform is
  worse than none.

  Moves are now **announced to screen readers**, naming the item and both lists
  — including moves made from the menu, which were silent before. A drop that
  changes nothing says so rather than claiming a move.

- **`.ics` downloads now fold long lines (RFC 5545 §3.1).** The per-task calendar
  download has emitted content lines over the 75-octet limit since #39 put a focus
  deep-link in every event's `DESCRIPTION`; #129's export made it unavoidable, so
  the shared serialiser now folds, backing off UTF-8 continuation bytes so a fold
  can never split an emoji. Every calendar client unfolds, so imported events are
  unchanged — but a strict parser will now accept the file.

- **Terms of Service — the backups are not a personal undo, and where to get
  your own copy (#164).** *Your data* gains a short clause saying what the
  nightly backups do and do not do for one person: they exist to bring the whole
  instance back after a disaster, and that obligation is stated rather than
  disclaimed — but there is no per-person restore, and nothing brings back a
  capture, task or step you deleted. The page previously mentioned backups once,
  in the as-is section, and left a reader to infer the rest; the likely inference
  was the wrong one. That sentence now carries the gist and links to the full
  clause, so the two cannot drift apart. Deliberately **not** filed under *Limits
  on my liability*: it describes how the service works, and the narrow claim is
  *no individual restore*, never *no responsibility for your data*. Tests assert
  both directions.

  The clause closes by telling you that you can download a copy of everything
  from Settings, which #129 made true while this change was open. It is **prose,
  not a link**: `/api/export` is an authenticated GET that returns a file, so a
  link to it from a page written to be readable while signed out would answer a
  reader with a 401 rather than their data. A test asserts the claim is present,
  that it names Settings, that no `/export/` link appears — and, separately,
  that the Settings control it describes still exists and still points at
  `/api/export`, so the Terms cannot outlive their own premise.

- **Privacy Policy — the Erasure right, and Access and Portability.** Two
  substantive changes, both about how a data subject actually exercises a right
  rather than about what the policy promises. The Erasure right now names the
  self-serve control and its one exception (the owner's own account), and the
  retention section says what deleting your own account does (#153). Access and
  Portability now name the export control instead of promising an answer by hand,
  disclose the two things it withholds (the Google OAuth tokens and any stored
  LLM API key), and state that a guest sandbox can exercise the right in full
  (#129). How a right is exercised, and what is withheld from it, are both part
  of the Art. 12/13 disclosure rather than copy tweaks.

- **Both legal pages now carry an effective date of 4 August 2026**, moved by the
  Terms change above. The date is shared by the two documents on purpose — a
  reader comparing them should not have to hold two version numbers — so
  /privacy's date moves with it even though its text has not changed since #129.
- `docs/legal.md`'s "Google revocation: the gap the pages admit" section was
  stale — it still described freeze and delete as paths that never call Google's
  revoke endpoint, which #126 fixed in v0.5.0. Corrected, and the residue that
  *is* still true (the revoke is a request Google can refuse) is stated
  separately so it does not get lost with it.
- **`README.md` and the in-app `/help` page caught up with #61, #142, #129 and
  #153.** Two of the claims they carried had become false rather than merely
  incomplete. The README said *"Streaming a bigger catalogue is a later release
  (#61); this is the bundled set"*, and `/help` told users *"ten lo-fi tracks are
  bundled with the app, so nothing is streamed from anywhere else"* — a privacy
  claim, so the correction deliberately keeps **both** halves: an operator can
  serve more tracks from a store they run, and the browser still never contacts
  it, because the CSP is unchanged and the bytes are proxied server-side through
  `/api/focus-catalog/audio`. Dropping the second half would have read as a
  privacy regression where none happened. `FOCUS_CATALOG_ORIGIN` is now in the
  README as well as `.env.example` and the two deploy guides.

  The larger gap was #142: completing a step **navigates on its own after five
  seconds**, and `/help` described none of it. An automatic navigation the docs
  do not mention is experienced as the app moving by itself, so the page now
  names the countdown, that it lands on the next step's start screen without
  starting its timer, both escapes (**Escape** as well as the **Stay here**
  button), and that **hyper focus mode is off by default** and chains single-task
  to-dos only.

  `/help` also gained a **Your data** section: export (#129) and self-deletion
  (#153) both shipped and neither was mentioned anywhere a user looks, despite
  being UK GDPR rights rather than features to browse for. It is worded against
  what the app actually does, the not-yet-automatic final purge included, and it
  says the Account section needs an account of your own — a guest sandbox is not
  shown those controls. Four specs pin the new copy, one of them asserting the
  retired streaming claim cannot come back.

### Fixed

- **A local end-to-end run can no longer test the wrong branch (#266).** Playwright
  reuses an existing server outside CI, on fixed ports, and this project's default
  working mode is many concurrent worktrees — so the server it attached to
  frequently belonged to a different branch, with nothing checking which. It was
  seen twice inside one review as an all-red run that came back clean on an
  immediate re-run with no change to the tree; the more expensive direction is the
  opposite, a spec that should fail passing against a build that happens to satisfy
  it. The checkout's commit is now handed to the servers under test, `/api/health`
  is asked for it back before any spec runs, and a mismatch aborts the run naming
  both commits and the port to free, so it can never be read as a failing feature.
  When the commit cannot be established at all, server reuse is switched off rather
  than left unverified. No effect on a self-hosted instance or on CI, where
  Playwright always starts its own server — this is this project's own test harness.

- **Completing the same to-do from two places at once no longer pays for it twice
  (#233).** Both payouts were guarded by a read taken before the write, so two
  simultaneous completions of one to-do both saw it as not yet complete, both passed
  the guard, and both paid out — the item completed once and was paid for twice.

  **The harm was never the points.** The ten-steps-in-a-day badge counts today's
  `step_done` rows and awards at ten, so a double-completed **five**-step to-do wrote
  ten rows for five real steps and earned that badge unearned. Badges are never
  revoked, so unlike the points that one was permanent. Production already holds a
  seven-step task, which makes a to-do of that size ordinary rather than a corner. The
  inflated total also leaves the app: it feeds the narrative and goes out in the daily
  round-up email.

  **The write is now the guard**, carrying the completion as a precondition, with
  every payout gated on whether that write actually changed anything. Postgres
  re-evaluates a blocked update's condition against the committed version, so the
  loser matches nothing, banks nothing, and raises nothing at somebody whose other tab
  finished first. Reaching this needs two tabs served by different replicas, which no
  in-process guard can span — that is why it is a database-level change and not a UI
  one. The item write goes first in the transaction, taking the same lock order four
  neighbouring writers already take, because inverting it in one writer is how a
  deadlock gets built. The three local writes became one transaction as well, so a
  to-do can no longer be left completed with its task still active.

- **Scheduling a single-task to-do no longer makes a second copy of it (#244).**
  Creating the task and linking the item to it were atomic with each other, but the
  decision that got them there was not: the check for an existing task came from a
  plain read taken **before any lock existed**, and a plain read does not wait on a
  row lock — it returns the last committed version. A caller whose read landed before
  a concurrent winner committed therefore entered the create branch and repointed the
  item at its own brand-new task the moment the block cleared. Two task rows: the item
  pointed at the loser's, while the winner's was reachable from no inbox row and the
  focus page, the calendar feed and the data export all still counted it.

  The precondition moved into the write. **Measured on real Postgres before the fix —
  two rows where one is required** — with the interleaving arranged rather than hoped
  for: the winner is held mid-transaction and released only once the other caller has
  demonstrably blocked on its row lock, observed on the holder's own backend rather
  than through a database-wide count another suite could satisfy.

- **Double-pressing ▶ Focus no longer makes a duplicate step (#245).** On this path
  the to-do already has its task, so the duplicate-task guard is skipped and the
  transaction takes **no lock at all**: both callers read an empty step list from
  their own snapshot and both insert. **No application-level precondition can close
  that.** An update's condition can carry one; an insert's cannot, and there is no row
  to lock because the whole question is whether a row should exist. Only something at
  the table grain can decide which insert wins, so `(taskId, order)` is now unique and
  the conflict is one Postgres resolves rather than one the app races.

  A caught duplicate-key error would not have been a quiet alternative: the client
  logs it before any handler runs, which is the defect that once got escalated as an
  incident. An insert that does nothing on conflict raises nothing at all, so a lost
  race is genuinely a no-op. Reproduced first and watched failing — again two rows
  where one is required — with the caller parked between its check and its act while
  the competing step is committed underneath it.

- **Editing a step's title no longer loses your place when another step's undo
  lands (#237).** A step you have marked done can be un-marked from the step
  list, and if that does not save the row offers a **Try again**. Both of those
  move you onto a sensible control when the button you pressed is taken away —
  which is right if you were standing on that button, and wrong if you were not.

  You could easily not be. Safari, and every browser on iPhone, does not put
  focus on a button when you click it, so pressing Try again with a mouse there
  never had your place to hand on. And a successful undo hands off *after* the
  round trip to the server, so on any browser you might have opened another
  step's title editor while it was still out. Either way the caret jumped out of
  the field you were typing in, into a different row.

  **Both hand-offs now check that the control being taken away is the one you
  were actually on**, matching what your inbox and the breakdown chat already
  did. Nothing changes when it is: pressing Try again from the keyboard still
  lands you on that row's own undo, and a successful undo still lands you on its
  Start Focus. Your typing was never at risk — only the caret.

- **Dependency update MRs no longer wait a week for an automerge that was lost at
  creation (#243).** Renovate arms GitLab's native auto-merge once, at the moment
  it opens the MR, never re-arms an MR it has not pushed a new commit to, and logs
  the failure at a level the job does not print — so five update MRs opened on
  10 August 2026 sat unmerged with nothing anywhere saying why. Renovate's own
  automerge does recover those MRs, but only on a later run, and there was one run
  a week. A second pipeline schedule now runs it every four hours purely to finish
  work already in flight, and a `schedule` window in `.gitlab/renovate.json` keeps
  those extra runs from opening MRs of their own; the arming failure is promoted to
  a warning, which also puts it on the Dependency Dashboard issue. No effect on a
  self-hosted instance — this is this project's own update automation.

- **The shopping list stops asking you to retry something it has taken the button
  away for, and says out loud that it is retrying (#246, #236).** Two small things
  in the notice that appears when a change to your list does not save. If the
  server never answered **and** the item has since left the list, it used to say
  "check the list before trying again" above a notice with no Try again button on
  it — because retrying a row that is gone either repeats a change that already
  went through or matches nothing, and both would look like it had quietly worked.
  It now says the item is not on the list any more **and** that the change may
  already have saved, which is the honest pair: it cannot claim nothing changed,
  because the item may be missing precisely *because* the change went through.

  The second is for screen-reader users. While a retry was in flight the notice
  showed "Saving…" on screen, but the only thing pointing at those words was a
  description on the Try again button — and a description is read when you *arrive*
  at a button, not while you are standing on it, which is exactly where you are
  after pressing it. The wait is now announced properly, from the same kind of
  region the focus timer and the inbox already use. Nothing changes on screen.

  A new repo-wide check (`write-notice-hygiene`) now asserts that every surface
  with one of these notices carries the whole set of messages, that each message
  agrees with the button it is shown beside, and that the wait is announced rather
  than merely displayed. Four surfaces grew this notice separately and each of them
  had drifted; this is the check that stops a fifth.

- **Your data export was missing a table (#199, found while adding one).** Custom
  focus playlists (#185) were absent from `export.json` — the export names every
  table by hand and nothing failed when one was left out, so the whole test suite
  stayed green while the archive quietly held less than the app did. The export now
  derives its obligations from the schema: a model that carries user data and is
  not read by the export fails the build. Nobody had a playlist to lose yet, since
  the feature has no save path on `main`, but the class of bug is closed rather
  than the instance.

- **"Back to inbox" in the step editor can no longer lose a step (#212).** The
  control takes one step out of the plan you are editing and puts it in your
  inbox as its own thing to break down later. It used to take the row away
  first and send the words afterwards, without waiting to hear whether they
  arrived — so if the connection dropped, or the app had updated in another tab
  since you opened this one, the step was gone from the screen and had never
  reached the inbox. Nothing said so, and because a plan is not saved until you
  press "Looks right", that row was the only copy.

  **The row now stays until the inbox has the words.** While it is sending, the
  control says so; if it cannot send, the row is still there, still editable,
  and a message above the list says what happened and offers to try again. If
  the app updated while the page was open it offers a reload instead, because
  that is the only thing that can work. And if the server simply never answers,
  it says the step **may** already be in your inbox and asks you to check
  before retrying, rather than claiming a failure it cannot be sure of — the
  step stays in the plan either way, so nothing is lost.

  Two more things the same control now gets right, because the plan's rows have
  an identity of their own rather than being told apart by their words. **A
  step you edit while it is still sending keeps the edit**, and a short note
  says your inbox has the wording as it read when you pressed, so you know an
  item arrived that you did not see. And **two steps that happen to say exactly
  the same thing are two steps**: pressing one no longer makes the other look
  busy, no longer swallows a press on it, and no longer clears a message about
  the first one.

  **Keyboard focus never lands nowhere.** Every control in this flow that
  vanishes when you press it now hands you on to a specific, still-present one:
  ejecting a step moves you to the row that takes its place, dismissing the
  "your inbox has the earlier wording" note puts you on that row's own control,
  and trying again after you have deleted the row leaves you on "Add a step".
  Each of those used to drop you at the top of the page, which for anyone
  navigating by keyboard or screen reader means starting the tab sequence over.

  Finally, **a step can no longer be in the plan and the inbox at the same
  time, whichever way round you press.** A plan is saved with every row it still
  shows, and a row on its way to the inbox is deliberately one of them until the
  inbox has it — so pressing "Looks right" in that moment used to put the same
  step in both places at once, with nothing said and no way for the app to
  notice afterwards. Asking for a different plan did the same thing more quietly
  still: the request shows the AI the plan as it stands, ejected row included,
  and then replaces the plan with the answer — which hands that row straight
  back, seconds after you watched it leave.

  So "Looks right", "More steps", "Fewer steps", the feedback box's Send and the
  error banner's Try again all wait for a step that is still being sent — and,
  the other way round, **"Back to inbox" and its own Try again wait while the
  plan is being saved or a new one is being asked for.** Every one of them says
  why it is waiting rather than just greying out, stays reachable by keyboard so
  the reason can be read, and goes through the moment the wait is over — however
  it ended.
- **A Settings switch no longer stays flipped on a change that did not save
  (#227).** Four sections could leave a control showing a value the server had
  refused. **First-run preview** was the quietest: it said nothing at all, so the
  checkbox simply looked switched while the setting was not. **Notifications**,
  **Appearance** and **Focus timer** were arguably worse — they showed "couldn't
  save" next to a control that still read the way you had just set it, leaving
  you to guess which of the two to believe. Appearance made the same false claim
  three times, because its completion and typeface samples previewed the refused
  choice too. All four now say the save failed **and** put the control back where
  the server still has it, and a save that fails while you are changing something
  else undoes only the one that failed.

  Flipping the *same* control several times in quick succession is handled too.
  Each save is tracked as its own attempt rather than by the value it wrote, so a
  slow failure can no longer undo a later change that did save — even when the
  two happen to land on the same setting. And a control that steps back steps
  back to the last value the server actually accepted, rather than to whatever it
  was showing when the page loaded.

  Two things deliberately unchanged. The **aging thresholds** are typed-in
  numbers rather than switches, so a failed save reports itself and leaves your
  typing exactly where it is — putting the stored number back would delete what
  you were in the middle of writing. And a save that gets **no answer at all** —
  a dropped connection, a server restarting mid-request — now says *"No answer
  yet — this may not have saved"* instead of showing the saving dots forever, and
  leaves your value alone: the app cannot tell a hung save from a slow one, so
  undoing it might undo something that did land.

- **Creating your calendar feed in two tabs at once no longer errors (#223).**
  Pressing "create my feed" twice at the same moment — two tabs, a double-click
  that outran the button — failed one of them outright, after you had already
  been told to expect a URL. Nothing was ever lost or leaked when it happened,
  and nobody ended up with a broken subscription; the write that came second was
  simply refused instead of being recognised as the same request. Both presses
  now finish, and **both hand back the same URL**, so there is no way to end up
  pasting a feed address into your calendar that nothing answers. The daily
  encouragement line had the identical fault and is fixed with it: two requests
  landing together on the first visit of the day could leave one of them with no
  quote on the dashboard until the next reload.

- **Retrying a failed "Mark not done" no longer loses your place (#215).** When a
  step's undo failed, the row showed the reason with a **Try again** beside it —
  and pressing that with the keyboard dropped focus to the top of the page. The
  notice is withdrawn while the retry runs (a message saying the step is still
  done should not stay up while the attempt that may fix it is in flight), and it
  took the button being pressed with it. Focus now moves to the row's own **Mark
  not done** control: the same action, in a place that does not disappear, and one
  that says out loud that the retry is running. The first failure was never
  affected — that press leaves you on a control that stays put.

- **"Trying again…" on the focus timer's error notice now reliably reaches a
  screen reader (#218), and "Saving…" on the inbox's capture notice with it.**
  Both sat inside the notice's own announcement, and a polite region nested
  inside an urgent one is read twice by some screen readers and not at all by
  others — so the one message telling you the app had heard you was the one that
  might go missing. Each now has its own quiet announcement, kept separate from
  the notice rather than tucked inside it, and it is also part of the description
  of the **Try again** button you are still holding for anyone arriving at that
  button mid-attempt. It goes away again the moment nothing is in flight.
  Nothing changes on screen.
- **Ticking off a multi-step to-do from the inbox left every step open in Google
  Tasks (#209).** Scheduling a to-do that has been broken down gives each step
  its own Google Task. Completing that to-do from the inbox — the row's Complete
  button, or a bulk complete — closed it here and nowhere else: every step stayed
  open on the Google side and Reclaim went on holding all of their calendar
  blocks. Finishing the same steps one at a time through the focus timer always
  worked, which is why this survived the stepless fix in #195. Both grains are
  closed now, the to-do's own Google Task and each of its steps, and steps that
  were already ticked off are left alone rather than re-sent.

- **Putting a completed to-do back left it finished in Google Tasks (#196).**
  Reopening an item from the Done view gave you the work back in the app while
  Google Tasks still showed it complete, and nothing afterwards ever corrected
  that — so the two sides parted permanently and Reclaim never re-booked the
  time. Reopening now tells Google, for the to-do itself and for each step it
  actually puts back. As everywhere else, the Google side is best-effort in the
  strict sense: an unreachable Google, or an account disconnected since the to-do
  was scheduled, costs you the sync and never the reopen.

- **Reopening a to-do and finishing it again paid you twice (#196).** Completing
  a to-do banks a point for each step it closes plus one for the to-do, and
  putting it back took none of that away — so the same piece of work could be
  banked over and over by completing, reopening and completing again. Reopening
  now returns exactly what that completion paid: one per step it genuinely puts
  back, and the to-do's own, only when the to-do really was complete. **Badges
  are untouched by design** — they mark that something happened once, they cannot
  be earned twice, and taking one back would make the collection lie about the
  past.

  **Reopening the same to-do twice takes the points back once.** A double-tap
  that outruns the button, or the same Done row open on a phone and a laptop,
  used to run the reopen twice — and because taking a point back means removing
  the most recent one, the second pass reached into a different, already-finished
  piece of work and took its points instead. Each reopen now claims the to-do and
  its steps as it puts them back, so whichever press arrives second finds the work
  already done and stops: silently, without an error, and without a second round
  of updates to Google.

- **The focus timer's Start and Resume no longer fail in silence (#139's shape,
  found via #198).** Both buttons handled a server that could not be *reached*,
  and neither handled a server that answered and *declined* — so in those cases
  the button did nothing at all: no message, no movement, nothing announced. Most
  reachable right after putting a step back, where the screen briefly still
  offered "Resume · ~Xm left" for the session that completion had just closed.
  Pressing it now says so and offers a retry, and that spent offer is **no longer
  shown in the first place** — once a step has been put back, the screen offers a
  fresh start, which is the only thing that can actually work. A genuinely paused
  session is still offered exactly as before.

- **A step completed by accident can now be put back (#198).** There was no way
  to un-complete a step while its task still had other steps outstanding: the
  only reopen path in the app worked on a whole inbox item, which an unfinished
  task never becomes. Finishing the wrong step was therefore permanent. Two
  places now undo it — **"Actually, I hadn't finished" on the timer's completion
  screen**, which is where the mistake is actually noticed, and a **"Mark not
  done"** control on any completed step row. Undoing reopens the parent task and
  its inbox item if that step was what closed them, tells Google Tasks the task
  is open again (the first time this app has ever sent that, rather than only
  ever reporting completions), and **takes back the points that completion
  awarded** so finishing the step again cannot bank them twice — a loophole that
  already existed through the inbox's Reopen. Your streak and any badges stay:
  the focus session really happened, and undoing a step does not un-happen it.
  On the timer, the undo also cancels the five-second countdown to the next step,
  so nothing navigates away from the step just rescued. If the step being put back
  was the one that finished its task, the task-completion points come back too —
  otherwise finishing that last step again would have paid for the same task twice.
  **Points for time spent focusing are yours to keep**, on both sides of an undo:
  you really did focus, and focusing on the step again means running another real
  session for it. **An undo that fails is an undo you can retry** — it either
  happens completely or not at all, so a hiccup leaves the step exactly as it was
  rather than half put-back with the points still banked, and pressing the button
  again finishes the job. And **using the keyboard, focus lands on the step's own
  Start button** once the step is back, rather than being dropped nowhere at the
  moment you have just fixed a mistake.

  **Pressing undo twice takes back one reward, not two.** A double-tap that
  outruns the button, or the same step open on a phone and a laptop, used to run
  the undo twice — and because taking a reward back means removing the most
  recent one, the second pass removed a *different* step's points. The undo now
  claims the step as it reopens it, so whichever press arrives second finds the
  work already done and stops, silently and without an error. **And one row's
  undo no longer greys out another's:** completing, renaming or re-estimating any
  step used to disable every "Mark not done" button on the page for the length of
  that request, so a press landing in the gap vanished with nothing to explain
  it. Each button now waits only on its own step, and while it is waiting it says
  so out loud rather than just going grey.

  **The button you press keeps the keyboard's focus while it works (#206).** It
  dims and says why, but it is still the control you are holding. Before, the
  browser dropped focus to the top of the page the moment the button went
  inactive, leaving a keyboard or screen-reader user holding nothing — in a list
  of identical-looking completed rows, while a change they could not observe went
  through. **And undoing two steps before either finishes now returns focus for
  both (#206).** The hand-off onto the reopened step's Start button remembered one
  step at a time, so the second undo erased the first's, and whichever row
  reopened first was left with focus nowhere: the exact problem the hand-off
  exists to prevent, on the row that had been waiting longest.

  **Un-completing two steps of the same finished task no longer takes back two
  task rewards.** The task only reopens once, so only one reopening is paid back —
  before, the second undo removed some other, already-finished task's reward
  instead. And **a failed undo on a step row now says so and offers to try
  again**, the way the timer's has all along: it was the one place this promise
  was made and not kept, because a failure there left the row looking untouched
  with nothing said.

- **The focus timer's "Complete step" sat where Pause belongs (#197).** In a
  running session the controls read *Complete step, then Pause*, with Complete
  the only filled button in the row — so the leading, most prominent, most
  colourful slot belonged to the one action that cannot be undone, in the exact
  position where every media player and timer puts pause. Reached for by muscle
  memory, it ended the step instead of pausing it: five separate accidental
  completions by one user before it was reported. **Pause now leads** and carries
  the filled treatment; Complete follows it, keeping the AA-measured green from
  #99. There is deliberately no confirmation dialog — that would put a tap
  between finishing a step and the reward, on every step, forever — so the
  recovery path is un-completing a step instead (#198). The code's own idea of
  the primary control (`sessionCtaRef`, where focus lands after a resume) was
  already on Pause; the row now agrees with it.

- **Migrations are tested against a database that already holds rows (#190).**
  `prisma migrate deploy` on an empty schema proves a migration parses and
  nothing more, and every gate this project had did exactly that — which is why
  the 2026-08-07 defect could not fail anywhere except production: its data steps
  were `UPDATE`s, and zero rows updated means no constraint is ever evaluated.
  `npm test` now applies the real migrations, one at a time, to a scratch schema
  seeded with synthetic rows at the schema version each was written against, then
  asserts what the conversions actually did to them. It counts the rows in every
  table a migration is about to touch, so "this migration met data" is a measured
  number rather than a claim about the seed files — the first thing that found was
  a table emptied mid-timeline whose later migrations were still running empty.
  The harness is **demonstrated to fail**: it reconstructs the pre-fix statement
  order of `20260806100000` and requires SQLSTATE 23514 and the P3009 that
  followed, so a gate that has quietly stopped being able to catch that defect
  fails the suite rather than passing it. Nothing an operator runs changes; the
  migrations themselves are untouched.

- **Completing a to-do with no steps left its Google Task open (#195).** A
  stepless to-do is pushed to Google Tasks as one task, so the scheduling unit is
  the to-do itself rather than any step of it — and only steps were ever marked
  completed on the Google side. Ticking such an item off in the app closed it
  here and nowhere else: it stayed open in Google Tasks, and Reclaim went on
  holding the block it had booked for work already finished. Both routes that
  close a to-do now complete its own Google Task, including the one taken when
  you finish a stepless item from the focus timer. The sync stays best-effort in
  the strict sense — an unreachable Google, or a Google account that has been
  disconnected since the item was scheduled, costs you the sync and never the
  completion. The timer's "marked complete in Google Tasks ✅" line now counts
  that case too; it was reading the step's sync alone and so said nothing for
  the very to-dos this fixes.
- **Two "best-effort" Google syncs that could still fail the thing they were
  attached to (#195).** Finishing a step, and requeueing one with a new time
  estimate, both talked to Google in a step marked best-effort — but a network
  error or an expired Google sign-in threw out of the whole action. Finishing a
  step could fail outright; requeueing saved the new estimate and then reported
  an error, leaving the list showing the old number until the next refresh.
  Both now do what the label always said: you keep the change, and only the
  Google side is skipped.
- **Signing in from any hostname but the canonical one looped forever (#174).**
  The app answers on more than one hostname, but every OAuth redirect URI is
  built from the single origin `PUBLIC_ORIGIN` names, and the PKCE verifier and
  state cookies are set with no `Domain` attribute — so they are host-only. A
  sign-in begun elsewhere set its cookies there, was returned by the provider to
  the `PUBLIC_ORIGIN` host, and failed on cookies the browser held but would not
  send. It then bounced to a login page on the *other* hostname, so retrying
  repeated it exactly. Reported as a hang on mobile, where the collapsed URL bar
  hides the hostname change; the auth-flow paths now move to the canonical
  origin before the flow starts. Every failed sign-in also writes one structured
  log line naming the reason and the hostname it arrived on — diagnosing this
  one needed an ingress access log, because the app itself said nothing.
- **Scheduling one inbox row disabled the Schedule button on every other row
  (#169).** A single `useTransition` was shared by the whole list, so its
  `pending` flag meant "some schedule call is in flight somewhere" while the
  control it guarded was documented as meaning "a schedule call for *this* row".
  On a list of any length that reads as the app locking up. `pending` is now
  keyed by item id and raised only by the schedule runners; the list-wide signal
  keeps its own name, `refreshing`, and keeps driving the list dimming, which is
  honest because every wrapper does end in a refresh.
- **Row action buttons sat exactly on the minimum touch target (#184).** The
  primary call to action on every item row was the smallest thing in the row,
  while the icon cluster beside it was already 44px — in a tool for people with
  ADHD, used mostly on a phone, where a mis-tap costs the thread you were
  holding. Every control in a row's action group is now 44x44, across the inbox,
  the library and the note trigger.

- **The inbox's drag instructions were being announced to nobody (#94).** On
  every hard load of `/`, the drag handle's `aria-describedby` named an element
  that was not in the document: the old library built that id from a per-render
  counter — the server's incremented per request while the browser's restarted
  at zero — and rendered the description into a portal that never
  server-rendered at all. Screen-reader users got silence where the instructions
  should have been. Both causes are gone with #163: the description is a real
  node in the page with a stable React id. It was never the fault that dropped
  dark mode (that was #105); an attribute mismatch does not make React rebuild
  the tree.

  Two tests keep it gone, because the reason it lasted this long is that nothing
  was looking: a server-render sweep asserting that no `aria-describedby` on the
  page dangles, and an axe scan of the inbox **with a row in it** — the existing
  scan loaded `/` empty, so there were no rows, no row controls, and nothing for
  the rule to fail on.

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

- **…and the same false alarm is gone from the four other places it could still
  come from (#158).** #156 fixed the one that had actually been reported and
  deliberately left the rest recorded. Earning a badge you already hold, a guest
  and a signed-in account each using AI for the first time, and — with no
  concurrency involved at all — an owner inviting somebody who is already
  invited: every one of those was handled correctly and every one still printed
  `Unique constraint failed` at error level, because Prisma's logger fires
  before the application's error handling ever sees it. All four now insert with
  `INSERT ... ON CONFLICT DO NOTHING` and read the row count instead. No
  behaviour changes: the same badge is awarded once, the same quotas are
  enforced to the same numbers, and re-inviting somebody still reports "already
  invited". Error logging is again untouched — the test that proves the four are
  silent also proves a genuine database failure still prints.

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
    2.4.13 Focus Appearance — AAA — needs 3:1, and it leaves no indicator a user
    can actually see, which is 2.4.7 Focus Visible and **is** AA. Both menus now
    draw an inset ring at 4.65–8.83:1 against both adjacent colours, in both
    themes, and keep the background swap as the hover affordance. Nothing had
    caught this because **axe implements no rule for any of WCAG 2.2's focus
    criteria** — including 2.4.11 Focus Not Obscured (Minimum), which is AA and
    which nothing in this repo checks (#258).
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

- **Freezing an account now actually stops it writing (#220).** Revoking somebody
  set their status and showed them as **Revoked** in the People panel, but did
  nothing to the browser cookie they were already holding — and the write path
  never read the status, so they could keep capturing, editing and deleting for
  the thirty days that cookie had left. Sign-in was blocked and pages treated
  them as signed out; only the writes were not. A frozen account is now refused
  on its very next request, whatever it tries, and is signed out rather than left
  to hit silent failures. The same check closes the matching hole for an account
  that has been **deleted** while its cookie was still alive.

  Guest sandboxes are unaffected — they have no account to freeze, and the check
  is skipped before any query is made, so an anonymous visitor's page load is
  unchanged. A signed-in request now makes one extra database read. Self-hosters
  running more than one account should take this one; on a single-account
  instance there is nobody to freeze.

  Signing the frozen account out is best-effort, because Next seals the cookie
  jar during a page render and there is nothing to be done about that — but only
  that one refusal is expected, and anything else now prints
  `session_clear_failed` rather than being absorbed alongside it. Refusing the
  request never depended on the sign-out landing, so this changes what an
  operator can see, not what the gate allows.

- **A GitLab quick action could be injected into an alert note through
  `ALERT_MENTION` (#191).** The handle was validated with
  `grep -Eq '^@[A-Za-z0-9…]$'`, and **grep anchors per line** — so a multi-line
  value whose first line was a valid handle passed the guard and was then
  interpolated whole. That put text such as `/close` at the start of its own line
  in a note posted with an `api`-scoped token, which is exactly how GitLab
  recognises a quick action. Both alert scripts now validate with bash's `=~`,
  which anchors the whole string; measured on bash 3.2.57 and 5.x. The variable is
  operator-set rather than attacker-set, so exploitation required an operator to
  paste a malformed value — but the guard was there to make that safe and did not.

- **`.ics` text values now escape every line terminator, not just `\n` (#154).**
  `esc()` in `src/lib/ics.ts` handled `\`, `;`, `,` and LF but not **CR**. RFC
  5545 §3.3.11 permits no control character but HTAB, and a literal CR inside a
  value ends the content line early under a lenient parser, so one property
  becomes two. CRLF now collapses to a single `\n` rather than two, and the
  remaining C0 controls are dropped — there is no escape sequence for them to
  survive as. `UID`, previously interpolated raw, is escaped too; every UID today
  is machine-derived so no output changes, but the next one derived from user
  text inherits the gate instead of having to notice its absence.

  **This reaches shipped code**, which is why it is here and not folded silently
  into the feature above: `ics.ts` is shared by the per-task `.ics` download, the
  #129 export's `scheduled.ics`, and the new subscription feed. The route in is
  `parentEmoji` and `subtaskEmoji`, the two fields not passed through the
  whitespace-collapsing helper and persisted straight from a model proposal.
  Impact is low — the attacker and the victim are the same account, and the only
  reachable effect is a malformed entry in your own calendar — but the fix is one
  expression and the surface is every calendar file the app has ever emitted.

  The test that should have caught it could not: it stripped `\r\n` and then
  looked only for `\n`, on a fixture containing no line terminator at all, so it
  passed with the defect present. It now asserts on text that would leak one.
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
