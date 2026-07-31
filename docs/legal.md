# Legal pages — maintenance guide

How to keep the published Privacy Policy and Terms of Service **true**. (#123)

> [!IMPORTANT]
> This is a maintenance doc, **not** a second copy of the text. The prose lives in
> exactly one place. Duplicating it here would guarantee that two versions of a
> legal document drift apart, and the one nobody remembered to update is the one
> a reader would be relying on.

---

## Where everything lives

| Thing | File |
|---|---|
| Privacy Policy prose | `src/app/privacy/page.tsx` |
| Terms of Service prose | `src/app/terms/page.tsx` |
| Canonical facts (names, addresses, dates, region, retention) | `src/lib/legal.ts` |
| Shared page shell + section machinery | `src/components/legal/legal-page.tsx` |
| Site footer that makes both reachable | `src/components/legal/legal-footer.tsx` |
| Public-path exemption (no login wall) | `src/lib/auth/gate.ts` → `PUBLIC_PREFIXES` |

Both pages are **top-level routes, deliberately outside the `(app)` route
group** — no session, no app chrome, no database — and are statically
prerendered, so they still answer when Postgres is down.

### The one rule about `src/lib/legal.ts`

Every value in it appears in more than one place (both pages, this doc, the
Google consent screen). **Import it; never retype it.** `src/app/privacy/page.test.tsx`
asserts the page renders the *constant's* value, so a hardcoded second copy fails
the build rather than quietly going stale.

---

## Who the controller is — and why UK GDPR applies at all

**Read this before editing the controller section of either page.** It is the
single easiest thing in this repo to reason wrongly about, and the wrong
conclusion is one a maintainer would reach while trying to be accurate.

The controller is **an individual in the United Kingdom running dlectroflow as a
personal, non-commercial hobby project.** No company, no business, no trade,
nothing charged for.

> [!WARNING]
> **Do not describe the controller as a sole trader, a business, or as "trading
> as" anything.** An earlier draft did, and it was wrong: it asserted a commercial
> undertaking that does not exist. It reads professional, which is exactly why a
> template or a find-and-replace can reintroduce it unchallenged. Both page test
> suites assert the phrases are absent.

### Non-commercial is NOT a data protection exemption

Here is the trap. UK GDPR **Article 2(2)(c)** disapplies the Regulation for
processing by a natural person "in the course of a purely personal or household
activity". Learn that this is a hobby project, and it is a short step to
concluding the whole regime is optional here.

**It is not, for two independent reasons — either is sufficient:**

1. dlectroflow is **offered over the public internet to other people**, and it
   processes *their* personal data on infrastructure the controller runs. That is
   not the controller's own personal or household activity, whatever the motive
   for building it. (This is the Lindqvist/Ryneš line of reasoning: making
   personal data available to an indefinite number of people over the internet
   takes processing outside the household exemption.)
2. **Recital 18** says the Regulation applies to controllers and processors that
   *provide the means* for processing, even where the end user's own activity is
   purely personal. Providing the means is precisely what this instance does.

So the full set of obligations attaches: lawful basis per purpose, the Article 13
notice, data-subject rights, Article 32 security, the lot. Being unpaid changes
what the project can afford, not what a user is entitled to. Both pages say this
explicitly, and `src/app/privacy/page.test.tsx` pins the wording.

### Where non-commercial status *does* legitimately change the analysis

Being non-commercial is a real fact with real consequences — just not that one:

- **Consumer Rights Act 2015** binds a **"trader"** (someone acting for purposes
  relating to a trade, business, craft or profession). An unpaid hobbyist giving
  software away is likely outside it, so the Terms are **not** written as a
  consumer sale, and their liability clause does not rest on CRA unfair-terms
  reasoning.
- **UCTA 1977** ss.2–7 reach **"business liability"** (s.1(3)) — same doubt.
- **But the Terms deliberately do not exploit either point.** Whether an unpaid
  hobby project counts as a business or a trader is genuinely arguable, and the
  Terms say outright that they are not running that argument: the carve-outs for
  death or personal injury from negligence and for fraud are stated flatly and
  unconditionally, so the clause stands however that question resolves. A test
  (`does not make the carve-outs conditional on being a business or trader`)
  keeps it that way. **Do not "tighten" that clause by adding a trader-status
  condition.**
- **The ICO data protection fee** genuinely turns on the nature of the
  processing — see *Still to confirm with a human* below, and do not assume the
  answer in either direction.
- **The jurisdiction clause** is phrased without leaning on
  "consumer"/"trader" labels, so a user in Scotland or Northern Ireland keeps the
  right to sue where they live regardless of how that argument would come out.

**If dlectroflow ever starts charging** — donations tied to features, a paid tier,
anything traded — every bullet above is reopened, along with the controller
description on both pages.

---

## The effective-date bump rule

`LEGAL_EFFECTIVE_DATE` in `src/lib/legal.ts` is the **version identifier** of both
documents. A reader uses it to tell whether the text changed since they last read
it, so:

- **Substance changed** → bump the date **in the same commit**. New processing, a
  new recipient, a changed retention period, a changed lawful basis, a new cookie,
  a changed scope, a different LLM provider, a new region.
- **Typo, wording, formatting, markup** → leave it alone. Bumping for a comma
  teaches people the date means nothing.

There is no automated way to tell those apart. If you are unsure, bump it — a
spurious bump costs a reader thirty seconds; a missed one misrepresents when a
material change took effect.

> [!NOTE]
> **The rule only bites once the text has been published.** The date identifies a
> version *a reader may have relied on*. While the pages were still unpublished
> (#123 unmerged), edits — including the substantive #118 Phase C rewrite of the
> Google and AI sections — were edits to the **first** version, not a transition
> between two, and nobody had read a prior one. So the date stayed at the date
> that text first took effect, **2026-07-29**.
>
> The pages are published now, and **#126 was the first substantive change after
> publication**: freezing or deleting an account revokes the Google grant, which
> the policy had disclosed as something the app did *not* do. It bumped the date
> to **2026-07-30**, in the same commit as the behaviour. That is the rule
> working; every substantive change from here does the same.

---

## Facts the pages assert about the running system

This is the part that rots. Each row is a claim in the published text that is
**only true because of how the system is currently deployed**. If you change the
thing in the left column, the pages are wrong until you fix them.

| If this changes… | Re-check | Where it is asserted |
|---|---|---|
| **GCP region** (currently `europe-west2`) | `HOSTING_REGION`; the "data at rest is in the UK" claim; whether transfers section still holds | `legal.ts`, Privacy → *Where your data is stored* |
| **Backup schedule / bucket region** (02:00 UTC, same region) | The backup time and the "same region" claim | `charts/dlectroflow/values.yaml` → `backup.schedule`; Privacy → *Where your data is stored* |
| **Backup retention** (30-day bucket lifecycle) | `BACKUP_RETENTION_DAYS`; the erasure promise depends on it ("gone from backups within 30 days") | `legal.ts`, Privacy → *How long I keep it*, *Your rights* |
| **Guest purge schedule** (03:30 UTC) | The stated purge time | `charts/dlectroflow/values.yaml` → `purge.schedule`; Privacy → *How long I keep it* |
| **Guest TTL** (`GUEST_SANDBOX_TTL_HOURS`, default 24) | "about a day" in three places, and the `df_guest` cookie lifetime | Privacy → *Cookies*, *How long I keep it*; Terms → *Who can use it* |
| **LLM provider** (`LLM_PROVIDER`, default `anthropic`) | Who the AI processor is, and the international-transfer section. **A switch to a non-UK provider is a new transfer disclosure**; a switch to a self-hosted model may remove one | Privacy → *Sending your text to an AI provider*, *Data that leaves the UK* |
| **What is put in an LLM prompt** | The "what is sent / what is not sent" list. See the four call sites below | Privacy → *Sending your text to an AI provider* |
| **Anything writing `User.llmProvider`** (nothing does today — #125) | **The whole "it is a key, not a destination" argument**, and with it the transfer section: today every request goes to Anthropic *because* a member cannot redirect it. See *The BYO-key / BYO-provider line* below | `src/app/actions/account.ts`, `src/lib/llm/index.ts` → `getLLM`; Privacy → *If you bring your own API key*; Terms → *About the AI suggestions* |
| **Google OAuth scopes** (one: `.../auth/tasks`) | The verbatim scope literal, and "no Gmail, no Calendar, no Drive, no Contacts" | `src/lib/google.ts` → `SCOPE`; Privacy → *Connecting Google Tasks* |
| **Google credentials ceasing to be per-user** (they are per-user since #118 Phase C) | "your own Google account", "one connection per person", and the claim that the owner cannot reach a member's connection | `src/lib/google.ts` (`getAuth`, keyed on `userId`), `AUTHENTICATED_PREFIXES`, `src/lib/__tests__/scoping.harness.test.ts`; Privacy → *Connecting Google Tasks*; Terms → *Your Google account is yours to look after* |
| **A lifecycle path that stops revoking at Google** (#126 made freeze and delete revoke first; `tryDisconnectGoogle` is the one wrapper both use) | The "if your access here is withdrawn, the grant goes with it" paragraph. **Dropping the revoke makes it wrong in the reassuring direction** — a live grant its holder cannot withdraw through the product is the Art. 7(3) problem #126 fixed | `src/lib/google.ts` → `disconnectGoogle` / `tryDisconnectGoogle`, `src/app/actions/people.ts` → `revokePerson`, `src/lib/account-lifecycle.ts` → `deleteAccount`; Privacy → *Tokens, and how to disconnect* |
| **Anything deleting a `User` outside `deleteAccount`** | Same paragraph, from the other direction: the FK cascade drops the credential without telling Google, so a second delete path silently reintroduces the gap. `src/lib/account-lifecycle.test.ts` fails the build if one appears | `src/lib/account-lifecycle.ts`; Privacy → *Tokens, and how to disconnect*, *How long I keep it* |
| **The People panel selecting anything new** | "counts, never content", and "does not even disclose whether you have one" for Google | `src/lib/people.ts` (`select` blocks); Privacy → *Connecting Google Tasks*, *How it is protected* |
| **Cookies** (six, all strictly necessary) | The cookie list AND the "no cookie banner" conclusion. **Adding any non-essential cookie means a consent mechanism, not a wording tweak** | `src/lib/auth/session.ts`, the OAuth `start` routes; Privacy → *Cookies* |
| **Adding an analytics/telemetry dependency** | Invalidates "there is no analytics package in the codebase at all" — which the policy invites readers to verify | Privacy → *What is not collected* |
| **Session TTL** (`USER_SESSION_TTL_SECONDS`, 30 days) | The `df_owner` lifetime in the cookie list | `src/lib/auth/session.ts`; Privacy → *Cookies* |
| **Resend / round-up email** | Whether Resend is a live recipient and a US transfer | `src/lib/email.ts`; Privacy → *Who else is involved*, *Data that leaves the UK* |
| **Sign-in providers** (GitLab only, `read_user`) | "GitLab is the only sign-in method", and what is stored from the provider | `src/lib/auth/providers.ts`; Privacy → *If you have an account* |
| **New Prisma model holding personal data** | The *What I collect* list. An incomplete notice is the failure mode here | `prisma/schema.prisma`; Privacy → *What I collect, and why* |
| **Controller identity** | `CONTROLLER_NAME` **and** the Google consent screen, which must match | `legal.ts`; both pages |
| **The project ever charging for anything** (a paid tier, donations tied to features, any trade) | The non-commercial framing on both pages, the "not a sale / not a customer" clause, the liability rationale, CRA/UCTA trader status, and the ICO fee answer. See *Who the controller is* above — this reopens all of it | both pages; `docs/legal.md` |

### The four places text is sent to the LLM

Easy to miss when auditing "what leaves the box", because only the first is
obvious:

1. `src/app/api/breakdown/route.ts` — the breakdown itself (task title, current
   proposed steps, your free-text guidance).
2. `src/lib/rollup.ts` — the end-of-day narrative (up to 5 completed step texts,
   up to 3 carry-over texts). Signed-in accounts only.
3. `src/app/actions/focus.ts` → `proposeNewEstimate` — one step's text plus its
   estimate. Signed-in accounts only.
4. `src/lib/spark.ts` — the daily quote. **Static prompt, no user data** — listed
   so a future reader does not have to re-derive that.

Note the non-obvious one: breaking down a brain-dump item copies that item's text
into `Task.title` (`src/app/actions/breakdown.ts`), so captured text **does** reach
the provider that way. The policy says so explicitly; do not "simplify" it.

---

## What the pages deliberately do NOT claim

These were designed and are **not shipped**. The pages describe the honest
fallback instead. If you implement one, the page text is what changes with it —
and until then, please do not "improve" the wording into a promise.

| Not shipped | What the page says instead |
|---|---|
| Self-service data export (still no `src/app/api/account/` directory — the `/api/account/` entry in `AUTHENTICATED_PREFIXES` reserves the prefix, it does not implement a route) | Access and portability are handled **by hand** from the contact address, within the statutory one month |
| Automatic revoke → freeze → 30-day purge (`User.purgeAfter` is written but never read; #126 added `deleteAccount` as the one safe way to delete an account, but nothing calls it yet) | Revocation does **not** delete content today; email and it will be deleted |
| **Per-account choice of AI provider (#125)** | The key is used against *this instance's* configured provider; "it is a key, not a destination", and choosing your own provider is not something dlectroflow can do today |

`src/app/privacy/page.test.tsx` has a `promises nothing unshipped` block that
asserts each honest wording is still present.

> [!NOTE]
> Two rows left this table in #118 Phase C, because they **shipped**: per-member
> Google connections, and a per-account BYO LLM key. Their claims are now pinned
> by the `per-user integrations (#118 Phase C)` block in the same test file.

### The BYO-key / BYO-provider line

**Read this before editing either AI section.** It is the one distinction in these
pages that is easy to overstate by accident, and overstating it would misdescribe
where a user's text goes.

A member can save **their own API key** (`User.llmKeyEnc`, encrypted with
`token-cipher`, written only by `saveOwnLlmKey`). A member **cannot choose the
provider**:

- `src/lib/llm/openai-compatible.ts` resolves the base URL from **`LLM_BASE_URL`**
  and takes only the *key* from the caller. `LLMCredentials` deliberately has no
  `baseUrl` field: a per-user endpoint would let a settings field aim the server at
  an arbitrary host (SSRF).
- `User.llmProvider` exists and `getLLM()` *would* honour it — but **nothing in the
  app writes it**. `saveOwnLlmKey` writes one column and its docblock says so
  ("Not aiPolicy, not aiQuota, not `llmProvider`"), so the value is always `NULL`,
  which `getLLM` resolves to the deployment's `LLM_PROVIDER`.
- Per-user provider selection is **#125, unshipped**.

So the accurate sentence is *"your key, spent against this instance's provider"* —
never *"bring your own provider"*. This also keeps the transfer section true: every
request still goes to Anthropic, own key or not, so the Article 46 analysis does
not fork. **If #125 ever ships, the international-transfer section must be
reopened**, not just this paragraph.

What *does* change with an own key, and is disclosed: the request is authenticated
as the member, so it lands in their own account with the provider and their own
agreement governs it — the controller's processor terms cover requests on the
controller's key only.

### Google revocation: the gap the pages admit

`disconnectGoogle` (Settings → Disconnect) is the **only** code path that calls
Google's revoke endpoint. Two other states exist and neither revokes:

- **Frozen** (`revokePerson`): sets `status`/`revokedAt`/`purgeAfter` and touches
  no tokens. The account's ciphertext stays in `GoogleAuth`, unusable because
  `currentUser()` resolves a revoked account to `null` — which *also* means the
  member can no longer reach Disconnect.
- **Deleted**: `GoogleAuth.userId` has `onDelete: Cascade`, so the row goes with
  the `User` — silently, without a revoke call.

Both pages therefore point at the user's own Google security settings as the route
that always works. **Do not soften that into "disconnecting revokes your access"
without also making the freeze/delete paths revoke.**

#### The pre-accounts credential destroyed by Phase C — and why it is not in the notice

Phase C's migration (`20260729140000_google_auth_orphan_purge`) ran
`DELETE FROM "GoogleAuth" WHERE "userId" IS NULL`, with a logged row count. That
destroyed the **real** encrypted access + refresh tokens of the single
pre-accounts, instance-wide Google connection.

**Deliberate decision: this is NOT disclosed in the published Privacy Policy.**
The reasoning, recorded so it is not re-litigated as an oversight:

1. **Whose data was it?** Before Phase C, `/api/google/oauth/*` was owner-only, so
   the only Google account that connection could belong to is the **instance
   owner's own** — i.e. the controller's. A privacy notice tells *other people*
   what happens to *their* data. The controller deleting their own OAuth token is
   not a disclosure owed to readers.
2. **The direction of the event is deletion.** No data was exposed, copied or
   newly processed; a stale credential that had become unreachable and unrevocable
   was removed. Data minimisation working is not a notice-triggering event.
3. **A notice is not a changelog.** The repository history is the change log, and
   both pages already say so. Narrating one-off migrations in the notice starts a
   habit that rots, and pushes genuinely current facts further down the page.

The general rule that *is* user-affecting — deletion removes tokens without
revoking at Google — **is** disclosed, in the section above. That is the right
altitude: the standing behaviour, not the single historical instance of it.

> [!WARNING]
> **Operational follow-up, not a legal one.** That migration deleted the row but
> never called Google's revoke endpoint, so the pre-accounts grant may still be
> listed as active in the owner's Google account even though no token for it
> survives here. Nothing in the app can revoke it now (there is no row to read a
> token from). If it is still there, revoke it by hand at
> [myaccount.google.com](https://myaccount.google.com/permissions) before
> reconnecting — the reconnect is already a documented post-deploy step.

---

## Google OAuth verification checklist

The immediate reason these pages exist. Work through it before submitting the
consent screen for review.

- [ ] **Both URLs load with no session and no cookies.** `https://dlectroflow.dev/privacy`
      and `/terms`. Test in a private window — a reviewer arrives cold, and the
      middleware redirects anything not in `PUBLIC_PREFIXES` to `/login`.
      Guarded by `src/proxy.test.ts` and `src/lib/auth/gate.test.ts`, but check
      the deployed site too: the gate cannot catch an ingress or DNS problem.
- [ ] **Both are reachable from inside the app**, not just by typing the URL —
      Google requires a link. The footer provides it on every app screen, the
      sign-in page and both legal pages.
- [ ] **`CONTROLLER_NAME` matches the name on the OAuth consent screen exactly.**
      A mismatch is a rejection.
- [ ] **The homepage URL on the consent screen** is `https://dlectroflow.dev`
      and it resolves.
- [ ] **The published scope matches the requested scope, verbatim** — one scope,
      `https://www.googleapis.com/auth/tasks`. If the consent screen requests
      anything else, either remove it or disclose it first.
- [ ] **The privacy policy explains what the scope is used for** in terms a
      reviewer can match to the app's behaviour: creating and updating tasks in
      the connected account's Google Tasks list.
- [ ] **The contact addresses receive mail.** Reviewers do check.
      `privacy@dlectroflow.dev` and `admin@dlectroflow.dev`.
- [ ] **Domain ownership is verified** in Google Search Console for the account
      that owns the OAuth client.
- [ ] **`.../auth/tasks` IS a sensitive scope.** This checklist previously said
      it was neither sensitive nor restricted; that was wrong, and events
      disproved it — the 2026-07-30 submission drew the full sensitive-scope
      treatment, demo video included. Budget for a demo video and a multi-week
      review, and treat "keep the scope list at one" as the thing that stops it
      escalating to *restricted*, not as a way to avoid review altogether.
- [ ] **If the app pairs a Workspace scope with any AI/ML model, the Limited Use
      requirements apply** — see the section below. This is the one that paused
      the 2026-07-31 review.

---

## Google Limited Use, and why this app clears it structurally

Raised by Google's Third-Party Data Safety team on 2026-07-31 (#140). Any app
that touches a Workspace or Photos API **and** uses an AI/ML model falls under
the Limited Use requirements of the Workspace API User Data and Developer
Policy, which prohibit using, transferring or selling Google user data — raw,
aggregated or derived — to train or improve AI/ML models.

dlectroflow pairs `.../auth/tasks` with the Anthropic breakdown coach, so it is
in scope. It clears the bar for a reason worth stating precisely, because the
reason is architectural rather than procedural:

**The Google Tasks integration is write-only.** `src/lib/google.ts` issues
`POST` and `PATCH` against `/lists/{listId}/tasks`, plus exactly one read —
`GET /users/@me/lists`, which returns task-**list** names so the right list can
be found to write into. No task is ever read back. There is therefore no
Workspace user data held in the app that *could* be forwarded to a model.
`src/lib/breakdown-context.ts` independently pins a `select` of numeric, enum,
boolean and date columns and never selects `Step.text` or `BrainDumpItem.text`.

Two consequences that save work if this comes round again:

1. **No re-architecture and no new demo video are needed.** Google asks for
   those only where Workspace data actually reaches a training-capable service.
2. **The answer to "which AI provider, and on what tier" is about the product,
   not the billing.** What Google needs to establish is whether the provider's
   terms permit training. All Anthropic API access sits under the same
   Commercial Terms of Service, which prohibit training on inputs and outputs —
   so "paid Anthropic API access, not a consumer Claude.ai plan" is the
   responsive answer, and it stays true across a change of key or account.

The affirmative statement Google requires is published in the "Connecting Google
Tasks" section of /privacy, verbatim, and pinned by a test. Reviewers match on
the standard wording — do not paraphrase it.

**Self-hosters:** this obligation travels with the OAuth client, not with the
codebase. Run your own client against your own LLM and it is yours to satisfy,
including hosting the statement somewhere you control.

---

## Tests that guard all this

| Test | What it prevents |
|---|---|
| `src/lib/legal.test.ts` | An unnamed or placeholder controller (Art. 13(1)(a)); a malformed effective date; the two contact inboxes collapsing into one |
| `src/lib/legal-fingerprint.test.tsx` | **The published text changing without anyone deciding whether the effective date should move** (#141). Hashes the *rendered* text of both pages, so a Prettier run or a JSX refactor does not trip it but a changed sentence does. This is the gate that #140 needed and did not have |
| `src/lib/auth/gate.test.ts` | The legal paths losing their public exemption, and lookalike paths gaining one |
| `src/proxy.test.ts` | The **middleware** redirecting the pages even while the classifier says public — the failure that silently breaks Google verification |
| `src/app/privacy/page.test.tsx` | Missing required disclosures; contents/heading drift; hardcoded copies of `legal.ts` values; unshipped features creeping into the text; the non-commercial framing being lost, or the Art. 2(2)(c) rebuttal being dropped. **Plus (#118 Phase C):** the per-user Google claims regressing to owner-only, the "owner cannot reach your connection" claim being dropped, the freeze/delete revoke gap being softened, and BYO key drifting into BYO provider |
| `src/app/terms/page.test.tsx` | Missing "as is"/no-uptime-guarantee wording; the liability carve-outs disappearing or becoming conditional on trader status; "sole trader"/"trading as" returning; governing law changing by accident; **the Google connection being described as the instance's rather than the user's, and the own-key clause implying a provider choice (#125)** |
| `src/components/legal/legal-footer.test.tsx` | The links that make the pages reachable |
| `e2e/a11y/axe-legal-pages.spec.ts` | WCAG A/AA and colour-contrast regressions on both pages, in both themes, with no session |
| `e2e/smoke/legal-pages.spec.ts` | The deployed pages being unreachable, or the footer link being broken, end to end |

---

## Still to confirm with a human

Not blockers for publishing, but they are assertions with real-world paperwork
behind them:

- **ICO registration / the data protection fee — do not assume, either way.**
  An earlier draft of this doc said a sole trader "usually has to pay the annual
  fee". That was wrong twice: the controller is not a sole trader, and "usually
  has to" overstates it. The **Data Protection (Charges and Information)
  Regulations 2018** contain exemptions, and a non-commercial personal project may
  or may not fall inside one — that cannot be determined from this repository, and
  neither the pages nor this doc make any claim about it.
  - **Settle it with the ICO's own self-assessment**, on
    [ico.org.uk/for-organisations/data-protection-fee](https://ico.org.uk/for-organisations/data-protection-fee/) —
    a short questionnaire that gives a definitive answer for a specific setup.
  - Do **not** assume the fee is owed, and do **not** assume it is exempt.
    Guessing in the reassuring direction is the worse of the two failures: the
    cost of checking is a few minutes, and the cost of being wrong is a penalty.
- **Processor terms actually in place.** The Privacy Policy relies on Article 46
  safeguards (standard contractual clauses + the UK International Data Transfer
  Addendum) for Anthropic and Resend. Confirm the DPA is accepted on each account
  and keep a copy — a reader is entitled to ask to see the safeguards.
- **Access-log retention.** The pages describe web-server access logs using the
  "criteria" formulation rather than a fixed period, because the platform's log
  retention is not set in this repo. If you pin it (GKE/Cloud Logging retention),
  state the number instead — it is the stronger disclosure.
