@AGENTS.md

# dlectroflow

ADHD-friendly productivity app: brain-dump → AI breaks tasks into tiny steps → schedule to calendar → focus timer → rewards/streaks. Public, AGPL-3.0-only, self-hostable. GitLab project `84020916` (`gl-demo-ultimate-dtop/domi-oss/dlectroflow`).

This is a **maintained production app, not a demo** — real users, real data. Tests, error/edge handling, security and WCAG-AA accessibility are part of "done", not follow-ups.

## Stack

- **Next.js 16** (App Router) + React 19, TypeScript 5.9, Node ≥20.19
- **Prisma 6** → PostgreSQL. Migrations run on container start.
- **Tailwind 4** + shadcn/ui + Base UI, `lucide-react` icons, `motion` for animation
- **LLM**: bring-your-own provider — `@anthropic-ai/sdk` and `openai` behind `src/lib/llm/`
- **Tests**: Vitest (unit/integration, jsdom + RTL) and Playwright (e2e, `@axe-core/playwright` for a11y)

Next.js 16 has breaking changes vs. older training data — read `node_modules/next/dist/docs/` before writing framework code (see `AGENTS.md`).

## Commands

```
npm run setup          docker compose up -d db && npm install && prisma migrate dev
npm run dev            dev server
npm test               vitest run (unit + integration; *.integration.test.ts need Postgres)
npm run test:e2e       playwright
npm run lint           eslint
npm run format:check   prettier --check .   <- CI gate, run before pushing
npm run db:migrate     prisma migrate dev
npm run check:env      env-drift check
```

`DATABASE_URL` is read from `.env` (Prisma's convention). `vitest.config.ts` forwards only that one variable into tests — deliberately, so no test can reach a secret it wasn't given.

## Architecture

- `src/app/(app)/` — authenticated pages. `src/app/api/` — route handlers. `src/app/login`, `/privacy`, `/terms` are public.
- `src/app/actions/` — server actions, one file per action, colocated tests.
- `src/lib/` — all domain logic, flat, colocated `*.test.ts`. Subfolders only where a cluster earns one: `auth/`, `llm/`, `crypto/`, `scheduling/`, `nav/`.
- `src/components/` — grouped by feature (`inbox/`, `focus/`, `library/`, `settings/`…); `ui/` is shadcn primitives.
- `prisma/schema.prisma` — 19 models. `Workspace` is the tenancy root.

### The scoping invariant

**Every query that touches user data must be scoped to the resolved workspace.** `src/lib/workspace.ts` resolves it from the session; an unscoped `prisma.<model>.findMany()` is an IDOR. Guest workspaces are real workspaces with a TTL, not a special case to branch on.

Auth path classification lives in `src/lib/auth/gate.ts` and is enforced by `src/proxy.ts`. `/privacy` and `/terms` are public because UK GDPR Art. 12(1) and Google's OAuth reviewers require it — don't "tidy" them behind the gate.

## Conventions

- Prettier: `semi`, double quotes, 2 spaces, `trailingComma: "all"`, `printWidth: 80`. These were measured off the existing tree, not copied from defaults.
- **Comments explain _why_, and cite the issue number.** Config files carry real prose (see `prettier.config.mjs`, `vitest.config.ts`, `src/lib/auth/gate.ts`). Match that density — a non-obvious constant or exclusion without its reasoning will get flagged in review.
- Tests colocate next to the code: `foo.ts` + `foo.test.ts`. `*.integration.test.ts` means it needs real Postgres.
- Path alias `@/` → `src/`.
- Conventional commits.

## Testing

TDD: failing test first, watch it fail, then implement.

The suite includes **hygiene tests that assert on the repo itself** — `dockerfile-hygiene`, `lockfile-hygiene`, `manifest-hygiene`, `env-drift`, `ci-docs-only`, `enum-constraint-sync`. If one fails, the repo drifted; fix the drift, don't relax the test.

## CI & release

Stages: `build` → `build_image` (Kaniko) → `test` (SAST, dependency, secret, container scanning) → `deploy` → `maintenance` (scheduled: Renovate, ops digest, registry prune).

- Docs-only changes take a reduced pipeline (the path list in `.gitlab-ci.yml` decides).
- **Protected CI variables make `main`'s environment differ from every MR's** — an MR can be green and `main` still go red. Diff the two before assuming a flake.
- A repo-wide reformat re-fingerprints triaged SAST findings, hard-blocking unrelated MRs as "new". Rebase the MR onto the reformatted `main` to clear it.
- Releases: a `vX.Y.Z` tag builds the versioned image, but **the GitLab Release object is a manual step** — no CI job creates it. Verify tag + CHANGELOG + image + Release when cutting.
- Upgrades must step through minor versions sequentially; downgrades are unsupported.

## Deploy

Two targets, both documented in `docs/`:

- **Production** — GKE Autopilot (europe-west2) via `charts/`, at `dlectroflow.dev`. See `docs/deploy-runbook.md`.
- **Self-host** — Docker Compose + Caddy. See `docs/self-host-vps.md`.

Prod deploys, cluster changes and deletes are owner-authorised only.

## Local development gotchas

- Local `npm` is allow-scripts-wrapped: regenerate lockfiles inside the CI image (`node:22-alpine`), not on the host.
- Worktrees share a symlinked `node_modules` including the generated Prisma client, and branches carry different schema columns. Seed a new worktree with `cp -Rc` from the main checkout, then `npx prisma generate` for that branch.
- Never `git stash` while other agents are working the repo — the stash is repo-wide and gets clobbered.
