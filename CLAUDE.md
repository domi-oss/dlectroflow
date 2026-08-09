@AGENTS.md

# dlectroflow

ADHD-friendly productivity app: brain-dump → AI breaks tasks into tiny steps → schedule to calendar → focus timer → rewards/streaks. Public, AGPL-3.0-only, self-hostable. GitLab project `84020916` (`gl-demo-ultimate-dtop/domi-oss/dlectroflow`).

This is a **maintained production app, not a demo** — real users, real data. Tests, error/edge handling, security and WCAG-AA accessibility are part of "done", not follow-ups.

## Stack

- **Next.js 16** (App Router) + React 19, TypeScript 5.9, Node ≥20.19
- **Prisma 6** → PostgreSQL. Migrations run on container start.
- **Tailwind 4** + shadcn/ui + Base UI, `lucide-react` icons, `motion` for animation
- **LLM**: bring-your-own provider — `@anthropic-ai/sdk` and `openai` behind `src/lib/llm/`
- **Tests**: Vitest (unit/integration) and Playwright (e2e, `@axe-core/playwright` for a11y)

Next.js 16 has breaking changes vs. older training data — read `node_modules/next/dist/docs/` before writing framework code (see `AGENTS.md`).

## Commands

```
npm run setup          docker compose -f docker/docker-compose.yml up -d db && npm install && prisma migrate dev
npm run dev            dev server
npm test               vitest run (unit + integration; *.integration.test.ts need Postgres)
npm run test:e2e       playwright
npm run lint           eslint
npm run format:check   prettier --check .   <- CI gate, run before pushing
npm run db:migrate     prisma migrate dev
npm run check:env      env-drift check
```

`DATABASE_URL` is read from `.env` (Prisma's convention). `config/vitest.config.ts` forwards only that one variable into tests — deliberately, so no test can reach a secret it wasn't given.

## Architecture

- `src/app/(app)/` — authenticated pages. `src/app/api/` — route handlers. `src/app/login`, `/privacy`, `/terms` are public.
- `src/app/actions/` — server actions, one file per action, colocated tests.
- `src/lib/` — all domain logic, flat, colocated `*.test.ts`. Subfolders only where a cluster earns one: `auth/`, `llm/`, `crypto/`, `scheduling/`, `nav/`.
- `src/components/` — grouped by feature (`inbox/`, `focus/`, `library/`, `settings/`…); `ui/` is shadcn primitives.
- `prisma/schema.prisma` — `Workspace` is the tenancy root. A model that declares
  `workspaceId` is enrolled automatically in the scoping harness
  (`src/lib/__tests__/scoping.harness.test.ts`) and the export coverage guard
  (`src/lib/export/__tests__/model-coverage.test.ts`), both of which read
  `Prisma.dmmf` at runtime. (The count used to be written here and was wrong by
  the time anybody read it — `grep -c '^model ' prisma/schema.prisma`.)
- `docker/` — both Dockerfiles, the Caddyfile and both Compose files. Paths inside the compose files resolve against `docker/`, so `.env.prod` and `backups/` are referenced as `../`; the image build context stays the repo root.
- Community files (`CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`) live in `docs/`, not the root and not `.gitlab/` — `.gitlab/**` is in the CI `.code_changes` list, so putting them there would cost every typo fix a full pipeline. Renovate's config is `.gitlab/renovate.json`.

### The scoping invariant

**Every query that touches user data must be scoped to the resolved workspace.** `src/lib/workspace.ts` resolves it from the session; an unscoped `prisma.<model>.findMany()` is an IDOR. Guest workspaces are real workspaces with a TTL, not a special case to branch on.

Auth path classification lives in `src/lib/auth/gate.ts` and is enforced by `src/proxy.ts`. `/privacy` and `/terms` are public because UK GDPR Art. 12(1) and Google's OAuth reviewers require it — don't "tidy" them behind the gate.

## Conventions

- Prettier: `semi`, double quotes, 2 spaces, `trailingComma: "all"`, `printWidth: 80`. These were measured off the existing tree, not copied from defaults.
- **Comments explain _why_, and cite the issue number.** Config files carry real prose (see `config/prettier.config.mjs`, `config/vitest.config.ts`, `src/lib/auth/gate.ts`). Match that density — a non-obvious constant or exclusion without its reasoning will get flagged in review.
- Tests colocate next to the code: `foo.ts` + `foo.test.ts`. `*.integration.test.ts` means it needs real Postgres.
- Path alias `@/` → `src/`.
- Conventional commits.

## Testing

TDD: failing test first, watch it fail, then implement.

**Vitest runs in the `node` environment.** jsdom is opt-in per file, via a `// @vitest-environment jsdom` docblock on the first line — 64 files do this today. A component or hook test written without it fails on missing DOM globals rather than telling you what's wrong, so add the docblock when you add a `.test.tsx`.

The suite includes **hygiene tests that assert on the repo itself** — `dockerfile-hygiene`, `lockfile-hygiene`, `manifest-hygiene`, `fetch-host-hygiene`, `version-hygiene`, `revalidation-hygiene`, `backup-hygiene`, `git-env-hygiene`, `a11y-class-hygiene`, `override-hygiene`, `env-drift`, `ci-docs-only`, `ci-job-deps`, `log-retention`, `enum-constraint-sync`. If one fails, the repo drifted; fix the drift, don't relax the test. **Three are compensating controls rather than style, and relaxing any of them reopens what it replaced:** `fetch-host-hygiene` stands in for a demoted SAST rule (#83), so weakening it reopens a CWE-918 hole; `a11y-class-hygiene` is the **only** check in the repo that can see WCAG 2.4.11 (axe does not implement it) or a state-dependent contrast failure (axe only measures what is painted during the scan) — every site #109 and #117 list shipped green because nothing else could look, and the gate then found three more they had both missed; `override-hygiene` keeps a `package.json` override from drifting out from under the Renovate rule that pins it inside a patched major (#161).

Every file-parsing one follows the same shape: a **pure module with no `fs`**, so the parsing is unit-testable on synthetic input, and the colocated `.test.ts` reads the real files. Follow it when adding one — a guard whose parser can only be exercised against the repo can't be shown to fail. (`enum-constraint-sync` is the exception, and can't help it: it queries the live schema, so it's an `.integration.test.ts` and needs Postgres.)

## CI & release

Stages: `build` → `build_image` (Kaniko) → `test` (SAST, dependency, secret, container scanning) → `deploy` → `maintenance` (scheduled: Renovate, ops digest, registry prune).

- Docs-only changes take a reduced pipeline (the path list in `.gitlab-ci.yml` decides).
- **Protected CI variables make `main`'s environment differ from every MR's** — an MR can be green and `main` still go red. Diff the two before assuming a flake.
- A repo-wide reformat re-fingerprints triaged SAST findings, hard-blocking unrelated MRs as "new". Rebase the MR onto the reformatted `main` to clear it.
- Upgrades must step through minor versions sequentially; downgrades are unsupported.

### Cutting a release

A `vX.Y.Z` tag builds and publishes the versioned image. **Everything else is manual** — no CI job bumps a version or creates the GitLab Release object. Do these in order, on `main`, in **one commit before the tag**:

1. **Bump all three version values to the same number** — `package.json` `version`, and `charts/dlectroflow/Chart.yaml`'s `version` **and** `appVersion` (they're lockstep by decision; the reasoning is in `Chart.yaml`). Bump `package-lock.json`'s two `version` fields (root and `packages.""`) to match — `version-hygiene` does **not** check the lockfile, and it silently carried `0.3.0` through both the v0.4.0 and v0.5.0 cuts because of that.
2. **Close the CHANGELOG section**: the entries under `## [Unreleased]` move beneath a new `## [X.Y.Z] - <date>` heading, leaving `## [Unreleased]` empty **and keeping its meta-note** — the note documents the ritual, so it stays with the open section rather than being dragged into the release just closed. Then the link-reference definitions at the foot of the file gain a `[X.Y.Z]: …/compare/v<prev>...vX.Y.Z` line with `[Unreleased]` repointed at `…/compare/vX.Y.Z...main`.
3. `npx vitest run src/lib/version-hygiene.test.ts` — **the gate.** It fails until steps 1 and 2 agree with each other. #148 exists because this step didn't: v0.4.0's tag moved while `package.json` stayed on `0.3.0`, so the image published as `:v0.4.0` was built from a tree calling itself 0.3.0, and `Chart.yaml` still advertised the `helm create` scaffold's `appVersion: "1.0.0"` — which `helm list` prints to operators as the version of the app running.
4. Commit, push, **then** tag: `git tag vX.Y.Z && git push origin vX.Y.Z`. The bump must be *in* the tagged tree, which is why nothing automates it — a pipeline rewriting `package.json` on tag push creates a commit the tag doesn't contain.
5. Verify the `:vX.Y.Z` image landed in the registry, then **create the GitLab Release object by hand** and paste the CHANGELOG section into it.

## Deploy

Two targets, both documented in `docs/`:

- **Production** — GKE Autopilot (europe-west2) via `charts/`, at `dlectroflow.dev`. See `docs/deploy-runbook.md`.
- **Self-host** — Docker Compose + Caddy, from `docker/`. See `docs/self-host-vps.md`.

Prod deploys, cluster changes and deletes are owner-authorised only.

## Local development gotchas

- Local `npm` is allow-scripts-wrapped: regenerate lockfiles inside the CI image (`node:22-alpine`), not on the host.
- **Worktrees live in `.claude/worktrees/<name>`**, which `.gitignore`, `.dockerignore`, `.prettierignore` and `eslint.config.mjs` all exclude. Putting one anywhere else means every one of those tools walks into it.
- Worktrees share a symlinked `node_modules` including the generated Prisma client, and branches carry different schema columns. Seed a new worktree with `cp -Rc` from the main checkout, then `npx prisma generate` for that branch.
- Never `git stash` while other agents are working the repo — the stash is repo-wide and gets clobbered.
