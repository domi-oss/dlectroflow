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
| **Google OAuth scopes** (one: `.../auth/tasks`) | The verbatim scope literal, and "no Gmail, no Calendar, no Drive, no Contacts" | `src/lib/google.ts` → `SCOPE`; Privacy → *Connecting Google Tasks* |
| **Google connection becoming per-user** (planned) | The paragraph saying only the instance administrator can connect | `src/lib/google.ts` (`SINGLETON_ID`), `OWNER_ONLY_PREFIXES`; Privacy → *Connecting Google Tasks* |
| **Cookies** (six, all strictly necessary) | The cookie list AND the "no cookie banner" conclusion. **Adding any non-essential cookie means a consent mechanism, not a wording tweak** | `src/lib/auth/session.ts`, the OAuth `start` routes; Privacy → *Cookies* |
| **Adding an analytics/telemetry dependency** | Invalidates "there is no analytics package in the codebase at all" — which the policy invites readers to verify | Privacy → *What is not collected* |
| **Session TTL** (`USER_SESSION_TTL_SECONDS`, 30 days) | The `df_owner` lifetime in the cookie list | `src/lib/auth/session.ts`; Privacy → *Cookies* |
| **Resend / round-up email** | Whether Resend is a live recipient and a US transfer | `src/lib/email.ts`; Privacy → *Who else is involved*, *Data that leaves the UK* |
| **Sign-in providers** (GitLab only, `read_user`) | "GitLab is the only sign-in method", and what is stored from the provider | `src/lib/auth/providers.ts`; Privacy → *If you have an account* |
| **New Prisma model holding personal data** | The *What I collect* list. An incomplete notice is the failure mode here | `prisma/schema.prisma`; Privacy → *What I collect, and why* |
| **Controller identity** | `CONTROLLER_NAME` **and** the Google consent screen, which must match | `legal.ts`; both pages |

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
| Self-service data export (no `/api/account/*` route exists) | Access and portability are handled **by hand** from the contact address, within the statutory one month |
| Automatic revoke → freeze → 30-day purge (`User.purgeAfter` is written but never read) | Revocation does **not** delete content today; email and it will be deleted |
| Per-member Google connections | Only the instance administrator can connect; there is one connection per instance |
| Per-account BYO LLM key (`User.llmKeyEnc` is read but nothing writes it) | Provider choice is a deploy-time setting; this instance uses Anthropic for every request |

`src/app/privacy/page.test.tsx` has a `promises nothing unshipped` block that
asserts each honest wording is still present.

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
- [ ] Only if a **sensitive or restricted** scope is ever added: expect a demo
      video and possibly a security assessment. `.../auth/tasks` is neither
      today — keep it that way if at all possible.

---

## Tests that guard all this

| Test | What it prevents |
|---|---|
| `src/lib/legal.test.ts` | An unnamed or placeholder controller (Art. 13(1)(a)); a malformed effective date; the two contact inboxes collapsing into one |
| `src/lib/auth/gate.test.ts` | The legal paths losing their public exemption, and lookalike paths gaining one |
| `src/proxy.test.ts` | The **middleware** redirecting the pages even while the classifier says public — the failure that silently breaks Google verification |
| `src/app/privacy/page.test.tsx` | Missing required disclosures; contents/heading drift; hardcoded copies of `legal.ts` values; unshipped features creeping into the text |
| `src/app/terms/page.test.tsx` | Missing "as is"/no-SLA wording; the liability carve-outs disappearing; governing law changing by accident |
| `src/components/legal/legal-footer.test.tsx` | The links that make the pages reachable |
| `e2e/a11y/axe-legal-pages.spec.ts` | WCAG A/AA and colour-contrast regressions on both pages, in both themes, with no session |
| `e2e/smoke/legal-pages.spec.ts` | The deployed pages being unreachable, or the footer link being broken, end to end |

---

## Still to confirm with a human

Not blockers for publishing, but they are assertions with real-world paperwork
behind them:

- **ICO registration / data protection fee.** A sole trader processing personal
  data usually has to pay the annual fee unless an exemption applies. The pages
  make no claim about registration, deliberately — check
  [ico.org.uk/for-organisations](https://ico.org.uk/for-organisations/) and
  register if required.
- **Processor terms actually in place.** The Privacy Policy relies on Article 46
  safeguards (standard contractual clauses + the UK International Data Transfer
  Addendum) for Anthropic and Resend. Confirm the DPA is accepted on each account
  and keep a copy — a reader is entitled to ask to see the safeguards.
- **Access-log retention.** The pages describe web-server access logs using the
  "criteria" formulation rather than a fixed period, because the platform's log
  retention is not set in this repo. If you pin it (GKE/Cloud Logging retention),
  state the number instead — it is the stronger disclosure.
