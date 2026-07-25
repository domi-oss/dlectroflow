# Contributing to dlectroflow

Thanks for being here. dlectroflow is an ADHD helper app, built self-host-first
and in the open. Contributions are welcome — and so is the smaller stuff:
a bug report, a "this doc step confused me," a rough idea in an issue. You do
not need to ship a polished feature to be useful here.

It's a single-maintainer, agent-augmented project (built with the help of
[Claude Code](https://claude.com/claude-code) and GitLab Duo), so please be
patient on response times — but every genuine report or MR gets a real look.

## Ways to contribute

- **Report a bug or a confusing doc step** — [open an issue](https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/issues/new). Small reports are genuinely welcome; "this tripped me up" is a valid bug.
- **Suggest a feature or improvement** — open an issue describing the problem you're hitting first, before the solution. Check the [roadmap / milestones](https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/milestones) so we don't double up.
- **Send a code change** — open a merge request against `main` (see below).

## 🔒 Security issues — don't open a public issue

Found a vulnerability? **Do not file a public issue.** Follow
[SECURITY.md](SECURITY.md): open a **confidential issue** (or email the
maintainer at the address on the GitLab profile) with repro + impact.

## Getting set up

The [README quick start](README.md#-quick-start-local-5-minutes) is the source of
truth. The short version:

```bash
git clone https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow.git
cd dlectroflow
npm run setup   # starts Postgres in Docker, installs deps, runs migrations
npm run dev
```

The app is designed so nothing hard-fails on a missing piece — no Claude API key
or Google connection needed to run it locally.

## Before you open an MR

Run the same gates CI runs (all must be green):

```bash
npm run test           # vitest unit suite (jsdom / RTL)
npm run test:e2e       # Playwright smoke + axe accessibility gate
npm run lint           # eslint
npm run format:check   # prettier
npx tsc --noEmit       # typecheck
```

> **Heads-up on security scans.** The pipeline also runs blocking security
> scanners on every MR — SAST, Advanced SAST, dependency scanning, secret
> detection, and container scanning. Under the project's Scan Result Policy, a
> **new Critical/High finding requires maintainer approval before merge**, so an
> MR that pulls in a dependency with a known CVE (or trips a SAST rule) can be
> blocked without prior warning from your local gates. If it happens, fix the
> finding at the source (bump/replace the dependency, adjust the flagged code)
> rather than waiting on an override.

**What we look for** (this is a production app, held to a real bar):

- **Tests first.** Follow TDD where you can — a failing test, then the code. New behavior needs coverage; bug fixes need a regression test.
- **Accessibility is not optional.** WCAG-AA contrast in light *and* dark; the axe gate must stay green. Don't convey state by color alone.
- **Match what's already there.** Reuse the existing design tokens and components; don't invent new colors or add dependencies without a good reason (call it out in the MR if you do).
- **Keep the diff focused.** One logical change per MR; avoid repo-wide reformatting (it re-fingerprints security findings and blocks unrelated work).
- **This is not stock Next.js** — it tracks a fast-moving version with breaking changes. Check `node_modules/next/dist/docs/` before reaching for an API you remember.

## MR workflow

1. Branch from `main` (e.g. `feat/short-description` or `fix/short-description`).
2. Use clear, [Conventional-Commits](https://www.conventionalcommits.org/)-style messages (`feat:`, `fix:`, `docs:`, `chore:` …).
3. Open the MR against `main`. Every MR gets its **own review app** — you and reviewers can click around the change live.
4. Make sure the pipeline is green and describe what you changed and why.
5. GitLab Duo reviews MRs automatically; the maintainer gives the final approval and merge.

## Licensing & sign-off

- By contributing, you agree that your contributions are licensed under this
  project's license, **[AGPL-3.0](LICENSE)** (inbound = outbound). There is no
  separate CLA. Note AGPL-3.0's network-service clause: deploying a modified
  version as a service over a network is itself a distribution event, so it
  triggers the obligation to make your source available to those users — worth
  knowing since this app is meant to be self-hosted.
- Please **sign off your commits** (`git commit -s`) to certify you wrote the
  change and can submit it under that license — this is the
  [Developer Certificate of Origin](https://developercertificate.org/).
  Encouraged, not enforced.

## Code of Conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). Be kind;
assume good faith.
