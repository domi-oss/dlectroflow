# Accounts Phase C — per-user integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an invited member connect **their own** Google account and bring **their own** LLM key, so scheduling and AI stop being owner-only — and make "a user's credentials are unreachable by any other account, the owner included" structural rather than a code-review promise.

**Architecture:** `GoogleAuth` stops being one instance-wide row keyed on the string `"singleton"` and becomes one row per `User`, keyed on `userId`. `src/lib/google.ts` is the **only** file in the repo that touches `prisma.googleAuth`, so every read and write funnels through six functions in one file — each gains a `userId` parameter and there is no id parameter anywhere for a caller to point at somebody else's row. The four owner gates in `src/app/actions/google-schedule.ts` become "signed in, acting on your own credential", `/api/google/oauth/` moves from `OWNER_ONLY_PREFIXES` to `AUTHENTICATED_PREFIXES`, and the scoping harness learns to police `userId`-keyed models the way it already polices `workspaceId`-keyed ones.

**Tech Stack:** TypeScript, Next.js 16.2, Prisma + Postgres, `@/lib/crypto/token-cipher` (AES-GCM `v1:` envelopes), vitest 4.1 + jsdom/RTL, `vitest-axe`, Playwright.

**Spec:** [`docs/design/specs/2026-07-27-accounts-per-user-foundation-design.md`](../specs/2026-07-27-accounts-per-user-foundation-design.md) §5, §Rollout, §Phases (C).
**Issue:** #118. **Also closes #96.**

**Depends on #119** (confidential security fix), which adds the handler-layer owner gate to both OAuth routes, corrects the wrong `prisma/schema.prisma` comment, and adds the first non-owner negative test to `src/app/actions/google-schedule.push.test.ts`. **Cut this branch from #119's branch (`fix/119-google-oauth-owner-gate`), or from `main` after #119 merges.** Several tasks below *evolve* files #119 creates; starting from plain `main` will produce merge conflicts in `src/app/api/google/oauth/{start,callback}/route.test.ts` and in `push.test.ts`.

## Where the spec is wrong, and what to trust

The spec's §Rollout risk table says: *"This means Google Tasks sync is down between the Phase A and Phase C deploys."* **It is not, and never was.** Phase A dropped the database `@default("singleton")` and deleted the rows, but `src/lib/google.ts:41` and `:81` still supply `id: "singleton"` **explicitly from application code**, so the row is re-created on the next read. #119 corrects the schema comment that repeated this. The practical consequence for this plan: there is no "restore sync" work. There is a **live production row holding real encrypted refresh tokens with `userId = NULL`**, and Task 3 destroys it.

Everywhere else the spec and #118's description disagree, **#118 is right** — its description is a verified, file:line-cited recon of the code as it stands.

## Decisions already taken — do not re-open these

1. **The live orphan `GoogleAuth` row (`userId = NULL`) is DELETED in the migration, not bound to the owner.** The owner reconnects once, after the deploy. Deleting destroys a stale credential rather than silently keeping an unreachable one, and it matches the spec's own "the owner is starting fresh anyway and would have had to reconnect regardless" posture. The migration is explicit and logged (`RAISE NOTICE` with the row count), following the repair-before-enforce convention in `prisma/migrations/20260727194512_step_est_minutes_check/migration.sql`.

2. **`GoogleAuth.userId` stays NULLABLE in this release.** `SET NOT NULL` was considered and rejected *for this MR*: the currently-deployed code writes `create: { id: SINGLETON_ID }` with no `userId` on **every page load including a guest's**, so a `NOT NULL` applied while old pods are still serving a rolling update would turn the inbox into a 500 for the length of the rollout. The structural guard is Task 1's harness instead, which fails **in CI** rather than in production — strictly better. A follow-up release, once no deployed code can write NULL, can add `SET NOT NULL` safely; see "Follow-ups" at the end.

3. **#119's negative test is EVOLVED, not deleted.** #119 added `"rejects a non-owner without touching Google"` to `push.test.ts` and four owner-gate cases to the two OAuth route tests. Phase C changes what "allowed" means, so a member must go from **403 to allowed-for-their-own-row**, and must **still never reach another user's row**. Task 4 rewrites those assertions in place and adds the cross-account negative that replaces the role negative. Deleting them would throw away the only tests that ever proved this surface is gated.

4. **Phase D is OUT.** Guest carryover, JSON export, revoke → freeze → 30-day purge, and the legacy-owner purge script are a separate issue.

5. **#96 is IN** (Task 8). It is the same change as C's "own key **and model**", it is one file plus one call site, and leaving it out would ship a member who pays with their own key and is handed the cheapest guest model anyway.

6. **The dead `googleStatus()` server action is DELETED, not re-gated** (Task 4). It has zero non-test callers and is a reachable RPC endpoint; re-gating it would carry a live endpoint forward for nobody.

## Global Constraints

- **`AGENTS.md` applies:** this is **Next.js 16.2** and its APIs differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before touching framework code.
- **No new npm dependencies.** Everything needed exists: `encryptToken`/`decryptNullable` in `src/lib/crypto/token-cipher.ts`, `currentUser()` in `src/lib/workspace.ts`, `CollapsibleSection`, `t()`.
- **`currentUser()` (`src/lib/workspace.ts:123-150`) is the ONLY source of the acting user id.** No route, action or function added by this plan may accept a user id, workspace id or credential id as a parameter. That is the entire isolation argument: if there is no id to pass, there is no id to tamper with. `isOwnerRequest()` is implemented in terms of `currentUser()`, so reading `currentUser()` directly costs no extra round trip.
- **A decrypted token is server-only by construction.** Never log it, never put it in a response, never hand it to a client component, never select `llmKeyEnc` into an object graph a page's props are built from (`src/lib/people.ts` is the model to copy).
- **Pseudo-enum columns get CHECK constraints** named `<Table>_<column>_check`, mirroring a const object in `src/lib/constants.ts`, and **must be registered** in `src/lib/enum-constraint-sync.integration.test.ts`'s `REGISTRY` — the suite fails if a managed constraint exists without a registry entry or vice versa. Nullable columns need an `IS NULL` allowance in the constraint and `nullable: true` in the registry; the suite asserts both directions.
- **Migrations repair before they enforce** (`prisma/migrations/20260727194512_step_est_minutes_check/migration.sql`): if a column could hold a violating value, `UPDATE`/`DELETE` it first so `prisma migrate deploy` cannot wedge a release halfway.
- **Accessibility is a gate, not a polish pass.** Every control added to `/settings` needs a real label, full keyboard operation, a 44×44 minimum touch target via `touchTarget` from `src/lib/utils.ts`, WCAG-AA contrast (no `opacity-*` washes over `text-muted-foreground` — see the `#90` regression lock in `integrations-panel.test.tsx:106-125`), and a clean `vitest-axe` pass.
- **Error and edge handling is part of every task.** An undecryptable ciphertext, a missing row, a revoked account mid-request, a rotated `TOKEN_ENC_KEY`, a `userId` that no longer resolves — each has a stated behaviour below. "It cannot happen" is not one of them.
- **Match the file's existing idiom.** These files carry long explanatory comments that state *why*, including rejected alternatives. New code is expected to do the same; a bare mechanical diff will read as foreign.
- **Never use `git stash`.** It is shared across worktrees and concurrent agents will clobber it. Commit, or write a patch file.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Gates before the MR: `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run format:check`, `npm run build && npm run test:e2e`.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/__tests__/scoping.harness.test.ts` **(modify, Tasks 1 · 2 · 7)** | Learns `userId`-keyed models; confines `prisma.googleAuth.*` to one file; registers Task 7's key-writing module in `KEY_CIPHERTEXT_FILES`. |
| `src/lib/google.ts` **(modify, Task 2)** | Every function takes the acting user's id. `getAuth` becomes a genuine `findUnique`. The whole `prisma.googleAuth` surface, unchanged in size. |
| `src/lib/google.test.ts` **(rewrite, Task 2)** | The singleton `where` is asserted verbatim at `:102-110` and `id: "singleton"` is hard-coded at eight sites. Rewritten, not extended. |
| `src/lib/constants.ts` **(modify, Tasks 2 · 3)** | `SINGLETON_ID` deleted (Task 2); `LlmProvider` added (Task 3). |
| `prisma/schema.prisma` **(modify, Task 3)** | Comment only — the model shape does not change. |
| `prisma/migrations/<ts>_google_auth_orphan_purge/migration.sql` **(create, Task 3)** | Destroys the orphan credential, logged. Adds `User_llmProvider_check`. |
| `src/lib/google-auth-orphan.integration.test.ts` **(create, Task 3)** | Behavioural proof: no `userId IS NULL` rows survive, and the FK cascades from `User`. |
| `src/lib/auth/gate.ts` **(modify, Task 4)** | `/api/google/oauth/` moves category. |
| `src/app/actions/google-schedule.ts` **(modify, Tasks 2 · 4)** | Four gates become "signed in, own credential"; `googleStatus()` deleted. |
| `src/lib/scheduling/providers.ts` **(modify, Task 4)** | `googleTasksProvider.isAvailable` loses its `isOwner` term. |
| `src/app/(app)/page.tsx` · `src/app/(app)/tasks/[taskId]/page.tsx` **(modify, Tasks 2 · 5)** | Resolve status for the acting user; stop discarding it for members; stop leaking it to guests. |
| `src/components/breakdown/breakdown-chat.tsx` **(modify, Task 5)** | `google` prop becomes nullable; `isGuest` prop deleted (null status *is* "guest"). |
| `src/app/(app)/settings/page.tsx` **(modify, Tasks 2 · 6 · 7)** | Member gets the real Integrations panel; guest keeps the shell; new Account section. |
| `src/components/settings/integrations-panel.tsx` **(modify, Task 6)** | Copy + a11y for "your own connection" rather than "the owner's". |
| `src/app/actions/account.ts` **(create, Task 7)** | The caller's own LLM key: save and remove. The only new write surface. |
| `src/components/settings/account-panel.tsx` **(create, Task 7)** | The key field. Presentational; never renders a key back. |
| `src/lib/section-nav.ts` · `src/lib/strings.ts` **(modify, Task 7)** | One new section id; new voice-aware copy. |
| `src/lib/models.ts` · `src/app/api/breakdown/route.ts` **(modify, Task 8)** | #96 — `owner \| member \| guest` tier instead of a boolean. |
| `e2e/constants.ts` · `e2e/global-setup.ts` · `playwright.config.ts` **(modify, Task 9)** | A **connected member** fixture. |
| `e2e/smoke/member-google.spec.ts` **(create, Task 9)** | The member path in a production build. |
| `docs/self-hosting.md` (or the README's self-host section) **(modify, Task 9)** | Publish your OAuth consent screen. |

**Why the tasks are ordered this way.** Task 1 builds the harness mechanism and proves it bites against a fixture, so it lands green. Task 2 then *turns the repo-wide rule on*, which is genuinely RED against real code — that is the failing test that drives the `google.ts` rewrite. Tasks 2 and 3 change **no external behaviour** (the owner stays the only account that can use Google), so the security-relevant change is isolated in Task 4 and a reviewer can accept or reject the plumbing and the opening-up independently. Task 2 has to update `google.ts` **and every call site in the same commit** — the signatures change, so any split leaves `npx tsc --noEmit` red, which the "never broken intermediate state" rule forbids.

Nothing in this list is over ~200 lines of change. The largest single-file diff is the `google.test.ts` rewrite (~200 of its 330 lines; the `#79` URL-construction block at `:223+` is untouched).

---

### Task 1: Teach the scoping harness about `userId`-keyed models

**Files:**
- Modify: `src/lib/__tests__/scoping.harness.test.ts`

**Interfaces:**
- Produces (test-local, not exported from the file): `userKeyedModels(): string[]`, `scanUserScope(src: string, models: string[]): string[]`

**Why this is first and why it is its own task.** The harness at `:59-63` builds its model list by filtering `Prisma.dmmf` on the presence of a **`workspaceId`** field. `GoogleAuth` is keyed by `userId` and has no `workspaceId`, so **every `prisma.googleAuth.*` call in the repo is invisible to it** — the mechanism the design nominates to make per-user isolation structural has no view of the one model this whole issue makes per-user. This repo has shipped an IDOR bug before (#21); that is why the harness exists instead of a review promise, and it is why this is load-bearing rather than polish.

This task ships the **mechanism plus its proof** (a fixture the scanner must flag) and the one repo-wide rule that is already true today (confinement to a single file). The repo-wide *user-scope* rule is deliberately left switched off until Task 2, where turning it on is the failing test that drives the rewrite. Doing it that way keeps `npm test` green at every task boundary without adding a debt allow-list.

- [x] **Step 1: Write the failing tests**

Read the whole existing file first. Note in particular the module comment at `:6-32` (why the "obvious" version of this test was rejected as tautological), the `REVIEWED_UNSCOPED` allow-map idiom at `:34-36`, and the "guards against silently matching nothing" test at `:169-172` — the new block mirrors all three.

Append to `src/lib/__tests__/scoping.harness.test.ts`, inside the existing `describe("workspace-scoping harness")` block, after the `OWNER_WORKSPACE_ID` test:

```ts
  // ── #35 Phase C (#118) — user-keyed models ────────────────────────────────
  //
  // Everything above polices models that carry `workspaceId`. `GoogleAuth` does
  // not: it is keyed on `userId`, which means every `prisma.googleAuth.*` call in
  // the repo was invisible to this harness — including the ones Phase C makes
  // per-user. A credential row is the highest-value thing in the schema, so it
  // gets the same structural treatment content does, not a weaker one.
  //
  // ONE rule here, not two. The workspace side needs a GUARDED_OPS escape hatch
  // because this codebase writes by primary key after a scoped `findFirst`
  // guard. There is no such idiom for a user-keyed credential: the row IS
  // addressed by `userId` (it is a unique column), so every operation without
  // exception must name it in its own arguments. Stricter, and simpler to argue
  // about in review.

  /**
   * Models whose `userId` is an OWNERSHIP link rather than the key access is
   * granted by, each with a stated reason. Same idea as REVIEWED_UNSCOPED above:
   * adding an entry is a security decision to argue for in review.
   */
  const NOT_USER_SCOPED: Record<string, string> = {
    workspace:
      "the scoping SUBJECT — every content model's workspaceId points at it, and the rules above are what police reaching it. touchWorkspace legitimately upserts by its own id, taken from a verified signed token, so requiring a userId here would be a different and weaker rule than the one already enforced.",
  };

  /** Prisma models keyed on a user rather than a workspace, camelCased as the
   *  client exposes them. Excludes anything carrying `workspaceId` — those are
   *  already covered by the rules above and must not be policed twice under a
   *  weaker key — and anything in NOT_USER_SCOPED. */
  function userKeyedModels(): string[] {
    return Prisma.dmmf.datamodel.models
      .filter(
        (m) =>
          m.fields.some((f) => f.name === "userId") &&
          !m.fields.some((f) => f.name === "workspaceId"),
      )
      .map((m) => m.name[0].toLowerCase() + m.name.slice(1))
      .filter((m) => !NOT_USER_SCOPED[m]);
  }

  const USER_KEYED_OPS = [
    "findMany",
    "findFirst",
    "findFirstOrThrow",
    "findUnique",
    "findUniqueOrThrow",
    "aggregate",
    "groupBy",
    "count",
    "create",
    "createMany",
    "update",
    "updateMany",
    "upsert",
    "delete",
    "deleteMany",
  ] as const;

  /**
   * Scan one file's source for user-keyed calls that do not name `userId`.
   *
   * Takes the source as a string rather than a path so the tests below can prove
   * it BITES against a fixture. A scanner that is only ever pointed at a clean
   * repo cannot be distinguished from a scanner that matches nothing, which is
   * the exact failure mode the module comment above warns about.
   */
  function scanUserScope(src: string, models: string[]): string[] {
    const offenders: string[] = [];
    for (const model of models) {
      const re = new RegExp(
        `(?:prisma|tx|db)\\.${model}\\.(${USER_KEYED_OPS.join("|")})\\(`,
        "g",
      );
      for (const m of src.matchAll(re)) {
        const args = callArgs(src, m.index + m[0].length - 1);
        if (!args.includes("userId")) offenders.push(`${model}.${m[1]}`);
      }
    }
    return offenders;
  }

  it("finds exactly the user-keyed models, and finds them at all", () => {
    // Pinned as an exact set rather than a `toContain`: a NEW user-keyed model
    // must fail this test and force a decision (policed, or NOT_USER_SCOPED with
    // a reason) instead of arriving unpoliced. And without the "at all" half,
    // every rule below would vacuously pass if `userId` were renamed.
    expect(userKeyedModels().sort()).toEqual(["googleAuth", "userAiUsage"]);
  });

  it("does not police a workspace-keyed model under the weaker user rule", () => {
    // Anything carrying workspaceId belongs to the strict rules above; being
    // caught by both would let the weaker rule look like coverage.
    for (const model of userKeyedModels()) {
      expect(scopedModels()).not.toContain(model);
    }
  });

  it("every NOT_USER_SCOPED entry names a real model and states a reason", () => {
    // An entry for a model that no longer exists is a stale exemption that reads
    // like considered coverage.
    const all = Prisma.dmmf.datamodel.models.map(
      (m) => m.name[0].toLowerCase() + m.name.slice(1),
    );
    for (const [model, reason] of Object.entries(NOT_USER_SCOPED)) {
      expect(all, `${model} is not a model`).toContain(model);
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it("flags a user-keyed call that does not name userId", () => {
    // The fixture is the proof this rule can fail. Both shapes below are exactly
    // what a Phase C regression looks like: the old singleton key, and a lookup
    // by primary key with no user constraint at all.
    const bad = `
      await prisma.googleAuth.upsert({ where: { id: SINGLETON_ID }, create: {}, update: {} });
      await prisma.googleAuth.findUnique({ where: { id } });
      await prisma.googleAuth.deleteMany({ where: { id: SINGLETON_ID } });
    `;
    expect(scanUserScope(bad, ["googleAuth"])).toEqual([
      "googleAuth.upsert",
      "googleAuth.findUnique",
      "googleAuth.deleteMany",
    ]);
  });

  it("accepts a user-keyed call that does name userId", () => {
    const good = `
      await prisma.googleAuth.findUnique({ where: { userId } });
      await prisma.googleAuth.upsert({ where: { userId }, create: { userId }, update: {} });
      await tx.googleAuth.deleteMany({ where: { userId } });
    `;
    expect(scanUserScope(good, ["googleAuth"])).toEqual([]);
  });

  it("is not fooled by a nested object closing early", () => {
    // callArgs balances parentheses; a non-greedy regex would stop at the first
    // `)` and miss the userId that follows it.
    const good = `
      await prisma.googleAuth.upsert({
        where: { userId },
        create: { userId, expiresAt: new Date(Date.now() + 3600) },
        update: {},
      });
    `;
    expect(scanUserScope(good, ["googleAuth"])).toEqual([]);
  });

  // The only modules allowed to touch a user-keyed model, each with its reason.
  // #118's recon found both of these were already the sole touchers; pinning it
  // is what keeps the blast radius one file per model FOREVER, instead of one
  // file today. Adding an entry is a security decision to argue for in review.
  const USER_KEYED_OWNERS: Record<string, string> = {
    "src/lib/google.ts":
      "the entire prisma.googleAuth surface — six functions, each keyed on the acting user",
    "src/lib/user-quota.ts":
      "the entire prisma.userAiUsage surface — the per-user AI meter, every statement bound to one userId",
  };

  it("the credential modules exist where this test thinks they do", () => {
    // Without this, renaming one of them turns the rule below into a test that
    // reads no files and passes forever — the same guard the People block uses.
    for (const file of Object.keys(USER_KEYED_OWNERS)) {
      expect(
        () => readFileSync(file, "utf8"),
        `${file} is missing`,
      ).not.toThrow();
    }
  });

  it("only the named module touches a user-keyed model", () => {
    // Plain substring search per (receiver, model) pair rather than a regex
    // assembled from a variable (semgrep `non-literal-regexp`, flagged on !175).
    const models = userKeyedModels();
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (USER_KEYED_OWNERS[file]) continue;
      const src = readFileSync(file, "utf8");
      for (const receiver of ["prisma", "tx", "db"]) {
        for (const model of models) {
          const needle = `${receiver}.${model}.`;
          if (src.includes(needle)) offenders.push(`${file}: ${needle}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/__tests__/scoping.harness.test.ts`

Expected: FAIL — `callArgs is not defined` is possible if the new block was pasted outside the module scope where `callArgs`, `scopedModels`, `sourceFiles` and `readFileSync` live; the fixture tests fail on `scanUserScope is not defined` before that. Both are the same signal: the block is not wired in yet.

The two repo-wide tests ("the credential module exists", "only the named module touches") must **PASS** once the block compiles — #118's recon verified `src/lib/google.ts` is already the only file touching `prisma.googleAuth`. If either fails, a second file has appeared since the recon: stop and report it, because it changes the blast radius this whole plan is sized against.

- [x] **Step 3: Confirm the model list is exactly what the code assumes**

The raw DMMF filter (before `NOT_USER_SCOPED`) returns **three** models on `main` @ 6845bfb, verified:

```
["userAiUsage", "workspace", "googleAuth"]
```

`workspace` is the one that has to be excluded, and the reason is not cosmetic: `Workspace` is what every content model's `workspaceId` *points at*, and `touchWorkspace` (`src/lib/workspace.ts:90`), `workspace-kind.ts`, `provisioning.ts` and `(app)/layout.tsx` all legitimately reach it **by its own id**, taken from a verified signed token. Requiring a `userId` there would be a weaker rule than the one already enforced, dressed up as a stronger one. Hence `NOT_USER_SCOPED`, with the reason in the code.

`Allowlist.claimedById` is not named `userId`, so `Allowlist` is correctly out. `User` itself has `id`, not `userId`, so it is out too — the `llmKeyEnc` rules further down are what police it.

Verify:

```bash
npx vitest run src/lib/__tests__/scoping.harness.test.ts -t "finds exactly the user-keyed models"
```

Expected: PASS with `["googleAuth", "userAiUsage"]`. **If a third name appears, a model was added since this plan was written — stop and decide** whether it is policed (nothing to do) or exempt (`NOT_USER_SCOPED` with a reason). Do not widen the filter to make the failure go away.

Also verified for `USER_KEYED_OWNERS`: `prisma.googleAuth.*` appears only in `src/lib/google.ts`, and `prisma.userAiUsage.*` only in `src/lib/user-quota.ts`. `src/lib/people.ts` reads usage through a **relation include** (`aiUsage: { select: … }` inside `user.findMany`), never as `prisma.userAiUsage.`, so it needs no entry.

- [x] **Step 4: Run the full harness and the whole suite**

Run: `npx vitest run src/lib/__tests__/scoping.harness.test.ts && npm test`

Expected: PASS. The repo-wide *user-scope* assertion is not written yet — that is Task 2, Step 1.

- [x] **Step 5: Commit**

```bash
git add src/lib/__tests__/scoping.harness.test.ts
git commit -m "test(security): teach the scoping harness about userId-keyed models (#118)

The harness filtered Prisma's DMMF on the presence of a workspaceId field, so
GoogleAuth - keyed on userId, no workspaceId - was invisible to it. Every
prisma.googleAuth.* call in the repo went unpoliced by the one mechanism the
accounts design nominates to make per-user isolation structural rather than
aspirational. This codebase has shipped an IDOR bug before (#21); a credential
table deserves at least the treatment content models get.

One rule, not two: the workspace side needs a guarded-by-primary-key escape
hatch because that is how this codebase writes. A user-keyed credential is
addressed BY userId, so every operation must name it in its own arguments.

The scanner takes source as a string so the tests can prove it BITES against a
fixture. A scanner only ever pointed at a clean repo is indistinguishable from
one that matches nothing - the trap the module comment already warns about.

The repo-wide user-scope assertion is deliberately NOT switched on here: it is
red against today's singleton code, and it is the failing test that opens the
google.ts rewrite. No debt allow-list, and npm test stays green.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `GoogleAuth` becomes per-user

**Files:**
- Modify: `src/lib/__tests__/scoping.harness.test.ts` (turn the repo-wide rule on)
- Rewrite: `src/lib/google.test.ts`
- Modify: `src/lib/google.ts`
- Modify: `src/lib/constants.ts:94` (delete `SINGLETON_ID`)
- Modify: `src/app/actions/google-schedule.ts` (pass the acting user's id; gates unchanged)
- Modify: `src/app/(app)/page.tsx`, `src/app/(app)/tasks/[taskId]/page.tsx`, `src/app/(app)/settings/page.tsx`
- Modify: `src/app/api/google/oauth/callback/route.ts` + its `route.test.ts` (both from #119)

**Interfaces:**
- Consumes: `currentUser()` from `@/lib/workspace`, `UserRole` from `@/lib/constants`.
- Produces (all of `src/lib/google.ts`'s credential surface):
  ```ts
  export async function exchangeCode(
    userId: string, code: string, codeVerifier: string, redirectUri: string,
  ): Promise<void>;
  export async function getValidAccessToken(userId: string): Promise<string | null>;
  /** `null` = no signed-in account. Returns configured-only, WITHOUT a query. */
  export async function getGoogleStatus(userId: string | null): Promise<{
    configured: boolean; connected: boolean; needsReconnect: boolean;
  }>;
  export async function disconnectGoogle(userId: string): Promise<void>;
  ```
  `googleConfigured`, `buildAuthorizeUrl`, `createPkce`, `randomState`, `listTaskLists`, `findReclaimList`, `createGoogleTask`, `patchGoogleTask`, `upsertGoogleTask` are **unchanged** — they take a token as a parameter, so only token *resolution* moves.

**This task deliberately changes no external behaviour.** Every gate stays owner-only; the owner is still the only account that can use Google. What changes is *which row* the owner's credential lives in and *who can see it*. The opening-up is Task 4.

- [ ] **Step 1: Write the failing tests — part A, turn the harness rule on**

In `src/lib/__tests__/scoping.harness.test.ts`, add one test to the Phase C block from Task 1:

```ts
  it("every prisma call against a user-keyed model names userId", () => {
    const models = userKeyedModels();
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const call of scanUserScope(readFileSync(file, "utf8"), models)) {
        offenders.push(`${file}: ${call}`);
      }
    }
    // A credential row that a call can reach without naming its owner is an
    // IDOR waiting for a second account (#21, #119).
    expect(offenders).toEqual([]);
  });
```

- [ ] **Step 2: Write the failing tests — part B, rewrite `src/lib/google.test.ts`**

The existing file hard-codes `id: "singleton"` at `:27, 80, 103, 134, 150, 174, 195, 209` and asserts the singleton `where` clause verbatim at `:102-110`. **Rewrite the file down to (but not including) `describe("Google Tasks URL construction (#79)")` at `:223`. Leave the `#79` block exactly as it is** — it tests `tasksUrl`/`pathSegment`, which this task does not touch.

Replace lines 1–221 with:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decryptToken, encryptToken } from "@/lib/crypto/token-cipher";

// #118 Phase C — GoogleAuth is one row per USER, keyed on `userId`. Every test
// below asserts the `where` clause, not just the outcome: the outcome of a
// correctly-keyed read and of a read that reaches somebody else's row look
// identical from the return value, and only one of them is acceptable.
//
// getAuth() is a genuine `findUnique` now, not an `upsert`. That is a real
// behaviour change worth naming: the old version MATERIALISED a credential row
// on every read, so an anonymous guest page load created one (via the
// unconditional getGoogleStatus() at src/app/(app)/page.tsx:65). A read that
// writes is also a read that cannot answer "is there a row?" honestly.
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    googleAuth: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn(),
    },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const USER = "user_alice";
const OTHER = "user_mallory";

/** A connected row for USER. `expiresAt` in the past forces the refresh path. */
function connectedRow(over: Record<string, unknown> = {}) {
  return {
    id: "ga_1",
    userId: USER,
    accessToken: encryptToken("stale-at"),
    refreshToken: encryptToken("dead-rt"),
    expiresAt: new Date(Date.now() - 1000),
    needsReconnect: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.googleAuth.update.mockResolvedValue({});
  process.env.GOOGLE_CLIENT_ID = "google-cid";
  process.env.GOOGLE_CLIENT_SECRET = "google-csecret";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reads are keyed on the acting user", () => {
  it("getValidAccessToken looks the row up BY userId and nothing else", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({ expiresAt: null, accessToken: encryptToken("live-at") }),
    );
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken(USER)).toBe("live-at");
    expect(prismaMock.googleAuth.findUnique).toHaveBeenCalledWith({
      where: { userId: USER },
    });
  });

  it("returns null for a user with no row — not connected, not an error", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(null);
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken(OTHER)).toBeNull();
  });

  it("returns null when the row exists but holds no token", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({ accessToken: null, refreshToken: null, expiresAt: null }),
    );
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken(USER)).toBeNull();
  });

  it("never reads without a userId in the where clause", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(null);
    const { getValidAccessToken, getGoogleStatus, disconnectGoogle } =
      await import("./google");
    await getValidAccessToken(USER);
    await getGoogleStatus(USER);
    await disconnectGoogle(USER);
    for (const call of prismaMock.googleAuth.findUnique.mock.calls) {
      expect(call[0].where).toEqual({ userId: USER });
    }
  });
});

describe("writes are bound to the acting user", () => {
  function stubTokenExchange() {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: "g-at",
          refresh_token: "g-rt",
          expires_in: 3600,
        }),
      }),
    );
  }

  it("exchangeCode upserts on userId and encrypts both tokens", async () => {
    stubTokenExchange();
    prismaMock.googleAuth.upsert.mockResolvedValue(connectedRow());
    const { exchangeCode } = await import("./google");
    await exchangeCode(USER, "code", "verifier", "https://app/cb");

    const call = prismaMock.googleAuth.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ userId: USER });
    // The CREATE branch must bind the row to the user. Without this the unique
    // index on a nullable column lets Postgres hold many userId IS NULL rows,
    // so a forgotten userId accumulates orphans silently instead of failing.
    expect(call.create.userId).toBe(USER);
    expect(call.create.accessToken).toMatch(/^v1:/);
    expect(decryptToken(call.create.accessToken)).toBe("g-at");
    expect(decryptToken(call.create.refreshToken)).toBe("g-rt");
    expect(decryptToken(call.update.accessToken)).toBe("g-at");
    expect(decryptToken(call.update.refreshToken)).toBe("g-rt");
  });

  it("never lets the UPDATE branch move a row to another user", async () => {
    stubTokenExchange();
    prismaMock.googleAuth.upsert.mockResolvedValue(connectedRow());
    const { exchangeCode } = await import("./google");
    await exchangeCode(USER, "code", "verifier", "https://app/cb");
    // Re-keying an existing row is how one account's connection becomes
    // another's. The update branch writes tokens, never ownership.
    expect(
      prismaMock.googleAuth.upsert.mock.calls[0][0].update,
    ).not.toHaveProperty("userId");
  });

  it("resets needsReconnect on a successful connect", async () => {
    stubTokenExchange();
    prismaMock.googleAuth.upsert.mockResolvedValue(connectedRow());
    const { exchangeCode } = await import("./google");
    await exchangeCode(USER, "code", "verifier", "https://app/cb");
    const call = prismaMock.googleAuth.upsert.mock.calls.at(-1)![0];
    expect(call.create.needsReconnect).toBe(false);
    expect(call.update.needsReconnect).toBe(false);
  });

  it("keeps an existing refresh token when Google returns none", async () => {
    // Google omits refresh_token on a re-consent. Overwriting it with null
    // would silently end the grant on the next expiry.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "g-at2", expires_in: 3600 }),
      }),
    );
    prismaMock.googleAuth.upsert.mockResolvedValue(connectedRow());
    const { exchangeCode } = await import("./google");
    await exchangeCode(USER, "code", "verifier", "https://app/cb");
    expect(
      prismaMock.googleAuth.upsert.mock.calls[0][0].update,
    ).not.toHaveProperty("refreshToken");
  });

  it("throws, and writes nothing, when Google refuses the exchange", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "" }),
    );
    const { exchangeCode } = await import("./google");
    await expect(
      exchangeCode(USER, "code", "verifier", "https://app/cb"),
    ).rejects.toThrow(/Google token exchange failed \(400\)/);
    expect(prismaMock.googleAuth.upsert).not.toHaveBeenCalled();
  });
});

describe("invalid_grant handling stays scoped to the acting user", () => {
  it("clears that user's tokens and flags them for reconnect", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(connectedRow());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant" }),
      }),
    );
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken(USER)).toBeNull();
    expect(prismaMock.googleAuth.update).toHaveBeenCalledWith({
      where: { userId: USER },
      data: {
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        needsReconnect: true,
      },
    });
  });

  it("leaves stored tokens untouched on a transient refresh error", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(connectedRow());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: "temporarily_unavailable" }),
      }),
    );
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken(USER)).toBeNull();
    expect(prismaMock.googleAuth.update).not.toHaveBeenCalled();
  });

  it("treats a non-JSON error body as transient rather than fatal", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(connectedRow());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error("not json");
        },
      }),
    );
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken(USER)).toBeNull();
    expect(prismaMock.googleAuth.update).not.toHaveBeenCalled();
  });
});

describe("getGoogleStatus", () => {
  it("answers a guest WITHOUT touching the database", async () => {
    // The old getAuth() was an upsert, so an anonymous page load materialised a
    // credential row. A guest has no account, so there is nothing to look up -
    // and a guest must never learn anything about anyone's connection.
    const { getGoogleStatus } = await import("./google");
    expect(await getGoogleStatus(null)).toEqual({
      configured: true,
      connected: false,
      needsReconnect: false,
    });
    expect(prismaMock.googleAuth.findUnique).not.toHaveBeenCalled();
  });

  it("reports not-connected for a signed-in user with no row", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(null);
    const { getGoogleStatus } = await import("./google");
    expect(await getGoogleStatus(USER)).toEqual({
      configured: true,
      connected: false,
      needsReconnect: false,
    });
  });

  it("surfaces needsReconnect", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        needsReconnect: true,
      }),
    );
    const { getGoogleStatus } = await import("./google");
    expect(await getGoogleStatus(USER)).toMatchObject({
      connected: false,
      needsReconnect: true,
    });
  });

  it("reports configured:false when the instance has no OAuth client", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    prismaMock.googleAuth.findUnique.mockResolvedValue(null);
    const { getGoogleStatus } = await import("./google");
    expect(await getGoogleStatus(USER)).toMatchObject({ configured: false });
  });

  it("says NOT connected when the ciphertext cannot be decrypted", async () => {
    // `connected` used to be Boolean(auth.accessToken) - ciphertext PRESENCE.
    // After a TOKEN_ENC_KEY rotation the UI read "Connected" while every push
    // failed with "not connected", which is the worst of both answers.
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({
        accessToken: "v1:not-a-real-envelope",
        refreshToken: null,
        expiresAt: null,
      }),
    );
    const { getGoogleStatus } = await import("./google");
    expect(await getGoogleStatus(USER)).toMatchObject({
      connected: false,
      // And it is actionable: an unreadable credential is exactly the state a
      // reconnect fixes, so say so rather than showing a bare "Not connected".
      needsReconnect: true,
    });
  });
});

describe("disconnectGoogle", () => {
  it("revokes the refresh token then deletes that user's row only", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({
        accessToken: encryptToken("at"),
        refreshToken: encryptToken("rt"),
        expiresAt: null,
      }),
    );
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const { disconnectGoogle } = await import("./google");
    await disconnectGoogle(USER);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({ method: "POST" }),
    );
    // The refresh token is preferred: revoking it kills the whole grant.
    expect(String(fetchMock.mock.calls[0][1].body)).toContain("token=rt");
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER },
    });
  });

  it("falls back to the access token when there is no refresh token", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({
        accessToken: encryptToken("at"),
        refreshToken: null,
        expiresAt: null,
      }),
    );
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const { disconnectGoogle } = await import("./google");
    await disconnectGoogle(USER);
    expect(String(fetchMock.mock.calls[0][1].body)).toContain("token=at");
  });

  it("still deletes when revoke fails — a dead token must not survive", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(
      connectedRow({ accessToken: encryptToken("at"), refreshToken: null, expiresAt: null }),
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net down")));
    const { disconnectGoogle } = await import("./google");
    await expect(disconnectGoogle(USER)).resolves.toBeUndefined();
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER },
    });
  });

  it("is idempotent for a user with no row and calls no revoke", async () => {
    prismaMock.googleAuth.findUnique.mockResolvedValue(null);
    vi.stubGlobal("fetch", vi.fn());
    const { disconnectGoogle } = await import("./google");
    await expect(disconnectGoogle(USER)).resolves.toBeUndefined();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER },
    });
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

```bash
npx vitest run src/lib/__tests__/scoping.harness.test.ts src/lib/google.test.ts
```

Expected:
- harness: **FAIL** with three offenders in `src/lib/google.ts` — `googleAuth.upsert` (twice) and `googleAuth.update`, plus `googleAuth.deleteMany`. That failure list *is* #118's finding, reproduced by a test.
- `google.test.ts`: **FAIL** — `getValidAccessToken` takes no arguments, `findUnique` is never called (the code upserts), `getGoogleStatus(null)` queries anyway.

- [ ] **Step 4: Rewrite the credential surface in `src/lib/google.ts`**

Delete the `SINGLETON_ID` import at `:2`. Replace `getAuth` (`:39-45`) and `storeTokens` (`:74-100`), and thread `userId` through `exchangeCode`, `refreshAccessToken`, `getValidAccessToken`, `getGoogleStatus` and `disconnectGoogle`:

```ts
/**
 * One user's Google credential, or null.
 *
 * #118 Phase C: a genuine `findUnique`, not the `upsert` it used to be. The old
 * version MATERIALISED a row on every read, so the unconditional
 * `getGoogleStatus()` on the inbox page created a credential row for anonymous
 * guests — and a read that writes cannot answer "is there a row?" honestly.
 *
 * `userId` is a unique column, so this is a primary-key-grade lookup. There is
 * no `id` parameter anywhere in this file's public surface: the row is reached
 * BY the acting user, so there is nothing a caller could point somewhere else.
 * `src/lib/__tests__/scoping.harness.test.ts` asserts that structurally.
 */
async function getAuth(userId: string) {
  return prisma.googleAuth.findUnique({ where: { userId } });
}

async function storeTokens(userId: string, t: TokenResponse) {
  const expiresAt = t.expires_in
    ? new Date(Date.now() + t.expires_in * 1000)
    : null;
  const scope = t.scope ?? SCOPE;
  // upsert (not update): this user may be connecting for the first time.
  //
  // `userId` is in `create` and deliberately NOT in `update`. The unique index
  // sits on a NULLABLE column, so Postgres will happily hold many
  // `userId IS NULL` rows — a create that forgot the binding would accumulate
  // orphaned credentials silently instead of failing. And an update that wrote
  // `userId` could RE-KEY an existing row, which is precisely how one account's
  // connection becomes another's (#119).
  await prisma.googleAuth.upsert({
    where: { userId },
    create: {
      userId,
      accessToken: encryptToken(t.access_token),
      refreshToken: t.refresh_token ? encryptToken(t.refresh_token) : null,
      expiresAt,
      scope,
      needsReconnect: false,
    },
    update: {
      accessToken: encryptToken(t.access_token),
      // Google omits refresh_token on a re-consent; overwriting it with null
      // would silently end the grant at the next expiry.
      ...(t.refresh_token
        ? { refreshToken: encryptToken(t.refresh_token) }
        : {}),
      expiresAt,
      scope,
      needsReconnect: false,
    },
  });
}

export async function exchangeCode(
  userId: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<void> {
  // … body unchanged … then:
  await storeTokens(userId, (await res.json()) as TokenResponse);
}

async function refreshAccessToken(userId: string): Promise<string | null> {
  const auth = await getAuth(userId);
  const refreshToken = decryptNullable(auth?.refreshToken);
  if (!refreshToken) return null;
  // … request unchanged … then, in the invalid_grant branch:
      await prisma.googleAuth.update({
        where: { userId },
        data: {
          accessToken: null,
          refreshToken: null,
          expiresAt: null,
          needsReconnect: true,
        },
      });
  // … then:
  await storeTokens(userId, data);
  return data.access_token;
}

export async function getValidAccessToken(
  userId: string,
): Promise<string | null> {
  const auth = await getAuth(userId);
  if (!auth) return null;
  const accessToken = decryptNullable(auth.accessToken);
  if (!accessToken) return null;
  const soon = Date.now() + 60_000;
  if (auth.expiresAt && auth.expiresAt.getTime() <= soon) {
    return (await refreshAccessToken(userId)) ?? null;
  }
  return accessToken;
}

/**
 * One user's connection status, or the instance-level answer for nobody.
 *
 * `userId === null` means "no signed-in account" (a guest, or an anonymous
 * request) and short-circuits BEFORE any query: a guest has no credential to
 * report and must learn nothing about anyone else's.
 *
 * `connected` is derived from DECRYPTABILITY, not from ciphertext presence. The
 * old `Boolean(auth.accessToken)` meant that after a TOKEN_ENC_KEY rotation the
 * UI said "Connected" while every push returned "not connected". An unreadable
 * credential also sets `needsReconnect`, because reconnecting is exactly the
 * action that fixes it — a bare "Not connected" tells the user nothing about a
 * row that is sitting right there.
 */
export async function getGoogleStatus(userId: string | null): Promise<{
  configured: boolean;
  connected: boolean;
  needsReconnect: boolean;
}> {
  const configured = googleConfigured();
  if (!userId) return { configured, connected: false, needsReconnect: false };
  const auth = await getAuth(userId);
  if (!auth) return { configured, connected: false, needsReconnect: false };
  const connected = Boolean(decryptNullable(auth.accessToken));
  return {
    configured,
    connected,
    needsReconnect:
      Boolean(auth.needsReconnect) || (Boolean(auth.accessToken) && !connected),
  };
}

/**
 * Disconnect ONE user's Google account: best-effort server-side revoke (refresh
 * token preferred — revoking it kills the whole grant), then delete that user's
 * row regardless. Idempotent; revoke failures must never keep dead tokens
 * around. `deleteMany` rather than `delete` so a user with no row is a no-op
 * instead of a thrown `RecordNotFound`.
 */
export async function disconnectGoogle(userId: string): Promise<void> {
  const auth = await getAuth(userId);
  const token =
    decryptNullable(auth?.refreshToken) ?? decryptNullable(auth?.accessToken);
  if (token) {
    try {
      await fetch(REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      });
    } catch {
      // Best-effort: the row still gets deleted below.
    }
  }
  await prisma.googleAuth.deleteMany({ where: { userId } });
}
```

Then delete `SINGLETON_ID` from `src/lib/constants.ts:94`. Replace it with a note in the same place, matching the style of the `OWNER_WORKSPACE_ID` note two lines below:

```ts
// #118 Phase C: SINGLETON_ID is GONE. GoogleAuth is one row per User, keyed on
// `userId` (src/lib/google.ts) — there is no instance-wide credential left for a
// magic id to name. The scoping harness asserts every call names its user.
```

- [ ] **Step 5: Update the call sites — the action file**

In `src/app/actions/google-schedule.ts`, add `currentUser` to the `@/lib/workspace` import and `UserRole` to the `@/lib/constants` import. In **`pushStepsToGoogleTasks`** and **`scheduleSingleTask`**, replace the gate:

```ts
  const workspaceId = await currentWorkspaceId();
  // #118 Phase C — the acting USER, not just their role: their id is what keys
  // their own GoogleAuth row. This is the same query isOwnerRequest() made
  // (it is implemented in terms of currentUser()), so it costs nothing extra.
  // The gate itself is UNCHANGED here on purpose: this commit moves the
  // credential, it does not widen who may use it. That is #118's next commit.
  const me = await currentUser();
  if (me?.role !== UserRole.Owner) throw new Error("owner only");
```

and every credential call becomes user-scoped:

```ts
  const token = await getValidAccessToken(me.id);
  if (!token) {
    const status = await getGoogleStatus(me.id);
```

`googleStatus()` and `disconnectGoogleTasks()` likewise:

```ts
export async function googleStatus() {
  const me = await currentUser();
  if (me?.role !== UserRole.Owner)
    return { configured: false, connected: false, needsReconnect: false };
  return getGoogleStatus(me.id);
}

export async function disconnectGoogleTasks(): Promise<{ ok: true }> {
  const me = await currentUser();
  if (me?.role !== UserRole.Owner) throw new Error("owner only");
  await disconnectGoogle(me.id);
  revalidatePath("/settings");
  return { ok: true };
}
```

Update the three action test files' `@/lib/workspace` mocks (`google-schedule.push.test.ts:63-66`, `google-schedule.single.test.ts`, `google-schedule.disconnect.test.ts`) to supply `currentUser` alongside `isOwnerRequest`:

```ts
const OWNER_ID = "user-owner";
// … in vi.hoisted: currentUserMock: vi.fn(),
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: workspaceMock,
  isOwnerRequest: isOwnerMock,
  currentUser: currentUserMock,
}));
// … in beforeEach:
currentUserMock.mockResolvedValue({
  id: OWNER_ID,
  role: "owner",
  workspaceId: OWNER_WS,
  provider: "gitlab",
  handle: "owner",
});
```

`isOwnerMock` stays in the mock object — other code paths in those files still reference it, and #119's negative test drives it. Keep both in sync: in each test that sets `isOwnerMock.mockResolvedValue(false)`, also set `currentUserMock` to a **member** (`role: "member"`), or the two mocks describe two different people and the test proves nothing. Add one assertion per file that the token was resolved for the acting user:

```ts
  it("resolves the token for the ACTING user, never a fixed id", async () => {
    taskFindFirstMock.mockResolvedValue(baseTask());
    await pushStepsToGoogleTasks("task-1");
    expect(tokenMock).toHaveBeenCalledWith(OWNER_ID);
  });
```

- [ ] **Step 6: Update the call sites — the three pages**

`src/app/(app)/page.tsx`: `getGoogleStatus()` is inside the `Promise.all` at `:65` and needs an id that `isOwnerRequest()` in the same batch is about to resolve. Reuse **one** `currentUser()` promise rather than hoisting a serial round trip (Duo removed a serial hop here once already):

```ts
  // #118 — ONE identity resolution, awaited inside the batch. isOwnerRequest()
  // is implemented in terms of currentUser(), so this is the same query it made,
  // and chaining the status off it keeps page-load latency flat.
  const mePromise = currentUser();
  const [rawItems, settings, sp, me, googleStatus] = await Promise.all([
    prisma.brainDumpItem.findMany({ /* unchanged */ }),
    getSettings(workspaceId),
    searchParams,
    mePromise,
    // Resolved for the ACTING user. A guest/anonymous caller is passed null,
    // which short-circuits before any query — getAuth() used to be an upsert,
    // so an anonymous page load MATERIALISED the credential row.
    mePromise.then((u) => getGoogleStatus(u ? u.id : null)),
  ]);
  const owner = me?.role === UserRole.Owner;
  // Task 5 of #118 changes this line. Left as-is here so this commit ships no
  // behaviour change: a member still falls back to .ics.
  const google = owner ? googleStatus : null;
```

Replace the `isOwnerRequest()` entry in the batch and its `owner` destructuring accordingly; import `currentUser` and `UserRole`.

`src/app/(app)/tasks/[taskId]/page.tsx`: identical treatment for the `getGoogleStatus()` / `isOwnerRequest()` pair at `:46-47`.

`src/app/(app)/settings/page.tsx:45`: `me` is already resolved before the second batch, so this is one argument:

```ts
    owner ? getGoogleStatus(me!.id) : Promise.resolve(null),
```

Prefer a narrowed local (`const meId = me?.id`) over `!` if the surrounding code allows — the repo's Duo reviews have objected to bare `!` before (`integrations-panel.test.tsx:116-123`).

- [ ] **Step 7: Update the call sites — the OAuth callback route**

`src/app/api/google/oauth/callback/route.ts` (as #119 left it) must now pass the acting user's id into `exchangeCode`. Replace #119's `isOwnerRequest()` gate with a `currentUser()` read that yields both the role and the id:

```ts
import { currentUser } from "@/lib/workspace";
import { UserRole } from "@/lib/constants";

  // #119's owner gate, now reading the identity it needs anyway: the exchange
  // binds tokens to THIS account's row (#118), so the id and the role come from
  // one lookup. Still 403, still before the cookie jar is read, so a rejected
  // caller holding a state + verifier pair completes nothing. #118's next commit
  // relaxes the ROLE test; the "acting on your own credential" part does not
  // move, because there is no id parameter to move it to.
  const me = await currentUser();
  if (me?.role !== UserRole.Owner) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  // … unchanged checks … then:
    await exchangeCode(
      me.id,
      code,
      verifier,
      `${origin}/api/google/oauth/callback`,
    );
```

In `src/app/api/google/oauth/callback/route.test.ts` (#119's file), change the `@/lib/workspace` mock from `{ isOwnerRequest: isOwnerMock }` to `{ currentUser: currentUserMock }`, replace `isOwnerMock.mockResolvedValue(true/false)` with a resolved owner / member object, and extend #119's `"still completes the exchange for the owner"` case:

```ts
  it("binds the exchange to the ACTING user (#118)", async () => {
    currentUserMock.mockResolvedValue(ownerUser());
    await GET(new Request(CALLBACK_URL));
    expect(exchangeCodeMock).toHaveBeenCalledWith(
      OWNER_ID,
      "c",
      "ver",
      "https://dlectroflow.test/api/google/oauth/callback",
    );
  });
```

`src/app/api/google/oauth/start/route.ts` is **not touched in this task** — it writes nothing, so it needs no id. Task 4 changes its gate.

- [ ] **Step 8: Run everything**

```bash
npx vitest run src/lib/google.test.ts src/lib/__tests__/scoping.harness.test.ts
npx tsc --noEmit
npm test
```

Expected: PASS, harness offenders empty, `tsc` clean. If `tsc` reports a `getGoogleStatus()` call with no argument, a call site was missed — `grep -rn "getGoogleStatus\|getValidAccessToken\|disconnectGoogle\|exchangeCode" src/ | grep -v "\.test\."` finds them all.

- [ ] **Step 9: Commit**

```bash
git add src/lib/google.ts src/lib/google.test.ts src/lib/constants.ts \
  src/lib/__tests__/scoping.harness.test.ts src/app/actions/google-schedule.ts \
  src/app/actions/google-schedule.push.test.ts \
  src/app/actions/google-schedule.single.test.ts \
  src/app/actions/google-schedule.disconnect.test.ts \
  "src/app/(app)/page.tsx" "src/app/(app)/tasks/[taskId]/page.tsx" \
  "src/app/(app)/settings/page.tsx" \
  src/app/api/google/oauth/callback/route.ts \
  src/app/api/google/oauth/callback/route.test.ts
git commit -m "feat(google): key the credential on the acting user, not a singleton (#118)

GoogleAuth becomes one row per User. Every function in src/lib/google.ts - the
only file in the repo that touches prisma.googleAuth - takes the acting user's
id, and there is no id PARAMETER anywhere in its public surface: the row is
reached BY the caller, so there is nothing to point at somebody else's. The
scoping harness now asserts that structurally rather than trusting review.

Three fixes fall out of the rewrite:

  * getAuth() was an upsert, so every 'read' MATERIALISED a row - an anonymous
    guest page load created a credential record. It is a findUnique now, and a
    caller with no account short-circuits before any query at all.
  * userId is written in the upsert's CREATE branch and deliberately not in
    UPDATE. The unique index sits on a nullable column, so a forgotten binding
    would accumulate orphans silently, and an update that wrote userId could
    re-key an existing row - which is exactly #119.
  * `connected` was ciphertext PRESENCE, so after a TOKEN_ENC_KEY rotation the
    UI read 'Connected' while every push failed. It is decryptability now, and
    an unreadable credential also sets needsReconnect, because reconnecting is
    what fixes it.

No behaviour change for anyone: the four gates stay owner-only. This commit
moves the credential; it does not widen who may use it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Destroy the orphan credential

**Files:**
- Create: `prisma/migrations/<timestamp>_google_auth_orphan_purge/migration.sql`
- Modify: `prisma/schema.prisma` (`model GoogleAuth` comment only)
- Modify: `src/lib/constants.ts` (add `LlmProvider`)
- Modify: `src/lib/llm/index.ts` (derive `PROVIDER_IDS` from the constant)
- Modify: `src/lib/enum-constraint-sync.integration.test.ts` (`REGISTRY`)
- Create: `src/lib/google-auth-orphan.integration.test.ts`

**Interfaces:**
- Produces: `LlmProvider = { Anthropic: "anthropic", OpenAICompatible: "openai-compatible" }` in `src/lib/constants.ts`; DB constraint `User_llmProvider_check`.

**Why the migration comes AFTER the code.** The production row has `userId = NULL`. Once Task 2's reads key on `userId` it is unreachable and invisible — not an error, a silent "not connected" — and `disconnectGoogle` no longer matches it either, leaving a row that holds an encrypted refresh token with no user, no workspace, and no cascade path (the FK cascades from `User`, which a NULL `userId` never reaches). Running the DELETE *after* the code means nothing re-creates it. Running it before would work too, but the still-deployed singleton code would upsert an empty row straight back, so the sequence would need a caveat it does not need this way round.

**Why `User_llmProvider_check` rides along.** Task 7 makes `llmKeyEnc` writable, which makes `llmProvider`'s null-vs-value distinction load-bearing for the first time: `user-quota.ts:153` hands it to `getLLM`, which picks an *adapter* from it. An unconstrained pseudo-enum feeding an adapter factory is the gap the repo's `#38` convention exists to close, and the same migration is the cheapest place to close it.

- [x] **Step 1: Write the failing integration test**

Read `src/lib/step-est-minutes-check.integration.test.ts` first — it is the template for how this repo proves a migration behaviourally.

Create `src/lib/google-auth-orphan.integration.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db";

/**
 * #118 Phase C — the credential table after the orphan purge.
 *
 * Two properties, both of which were false before this migration:
 *
 *  1. No `userId IS NULL` row survives. The pre-Phase-C singleton held real
 *     encrypted refresh tokens for the whole instance; the moment reads key on
 *     userId it becomes unreachable AND uncascadable, so it is destroyed rather
 *     than kept as a credential nobody can revoke.
 *  2. Deleting the User cascades the credential away. That was only ever true
 *     for a row with a userId — the FK cascades FROM User, and a NULL userId
 *     never reaches it.
 */
describe("GoogleAuth after the orphan purge", () => {
  const ids: string[] = [];

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it("holds no credential that belongs to nobody", async () => {
    const orphans = await prisma.googleAuth.count({
      where: { userId: null },
    });
    expect(orphans).toBe(0);
  });

  it("cascades a credential away with its user", async () => {
    const user = await prisma.user.create({
      data: {
        provider: "gitlab",
        providerSub: `orphan-test-${Date.now()}`,
        role: "member",
        status: "active",
      },
    });
    ids.push(user.id);
    await prisma.googleAuth.create({
      data: { userId: user.id, accessToken: "v1:whatever" },
    });
    expect(
      await prisma.googleAuth.count({ where: { userId: user.id } }),
    ).toBe(1);

    await prisma.user.delete({ where: { id: user.id } });
    ids.pop();
    expect(
      await prisma.googleAuth.count({ where: { userId: user.id } }),
    ).toBe(0);
  });
});

describe("User.llmProvider CHECK constraint", () => {
  it("accepts the two adapter ids and NULL", async () => {
    for (const p of ["anthropic", "openai-compatible", null]) {
      const user = await prisma.user.create({
        data: {
          provider: "gitlab",
          providerSub: `prov-${p}-${Date.now()}`,
          role: "member",
          status: "active",
          llmProvider: p,
        },
      });
      expect(user.llmProvider).toBe(p);
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it("rejects a provider no adapter can serve", async () => {
    // getLLM() falls back to LLM_PROVIDER for an unknown value, so a bad row is
    // not a crash - it is a user silently billed to their own key against the
    // wrong vendor's endpoint. The DB is where that stops being possible.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "User" ("id","provider","providerSub","role","status","aiPolicy","aiQuota","llmProvider","createdAt","lastSeenAt")
         VALUES ('u_bad_prov','gitlab','bad-prov','member','active','capped',50,'gpt-cheapest',now(),now())`,
      ),
    ).rejects.toThrow(/User_llmProvider_check/);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/google-auth-orphan.integration.test.ts`

Expected: the `llmProvider` rejection test FAILS (no constraint yet — the raw insert succeeds). Clean up the row it leaves behind: `npx prisma db execute --stdin <<< 'DELETE FROM "User" WHERE id = '"'"'u_bad_prov'"'"';'`. The orphan-count test may pass locally (a dev database may hold no NULL row) — that is fine; it is production this migration is for, and the cascade test is the one that proves the mechanism.

- [x] **Step 3: Add the `LlmProvider` constant**

In `src/lib/constants.ts`, next to the other pseudo-enum objects:

```ts
/**
 * Which LLM adapter serves a request — `LLM_PROVIDER` for the instance, or a
 * user's `User.llmProvider` for an account that brought its own key (#35 Phase
 * B/C). Mirrored by the `User_llmProvider_check` constraint; NULL on a User
 * means "use the instance default".
 *
 * Lives here rather than in src/lib/llm/index.ts because constants.ts is the
 * single source of truth the CHECK-constraint sync test reads, and importing
 * llm/index.ts into a test would pull the provider SDKs in with it.
 */
export const LlmProvider = {
  Anthropic: "anthropic",
  OpenAICompatible: "openai-compatible",
} as const;
export type LlmProvider = (typeof LlmProvider)[keyof typeof LlmProvider];
```

In `src/lib/llm/index.ts:8`, derive rather than restate:

```ts
import { LlmProvider } from "@/lib/constants";

/** The adapter ids `LLM_PROVIDER` (and a user's `llmProvider`) may name. */
const PROVIDER_IDS = Object.values(LlmProvider);
```

Keep `type ProviderId = (typeof PROVIDER_IDS)[number]` working — if `Object.values` widens it to `string`, use `const PROVIDER_IDS = [LlmProvider.Anthropic, LlmProvider.OpenAICompatible] as const;` instead and let the constraint test be the thing that catches a value added to one and not the other.

- [x] **Step 4: Write the migration**

Create `prisma/migrations/<timestamp>_google_auth_orphan_purge/migration.sql` with a timestamp later than `20260728130100`:

```sql
-- #118 Phase C — the pre-accounts Google credential is destroyed, not adopted.
--
-- BACKGROUND, because the schema comment was wrong about this until #119. Phase
-- A dropped the `@default("singleton")` id and DELETEd every row, but
-- src/lib/google.ts kept passing `id: 'singleton'` explicitly from application
-- code, so one instance-wide row was re-created on the next read and Google
-- Tasks sync never went down. What production therefore holds today is a row
-- with `userId = NULL` carrying REAL encrypted access + refresh tokens.
--
-- Phase C keys every read and write on `userId`. That makes this row:
--
--   * unreachable  — findUnique({ where: { userId } }) never matches it, and the
--                    UI reports a plain "Not connected" rather than an error;
--   * unrevocable  — disconnectGoogle's deleteMany({ where: { userId } }) does
--                    not match it either;
--   * uncascadable — the FK cascades FROM User, and a NULL userId never reaches
--                    a User row. Deleting every account would leave it behind.
--
-- So the choice is "bind it to the owner" or "destroy it". DESTROY, per the
-- owner's decision on #118: it removes a stale credential instead of silently
-- keeping one nobody can reach or revoke, and it matches the design's own
-- "the owner is starting fresh anyway and would have had to reconnect
-- regardless" posture (spec §Rollout). Cost is one manual reconnect, once,
-- after this deploy. That reconnect is a RELEASE STEP - see the plan's
-- "Post-deploy" checklist.
--
-- Ordering note: this runs AFTER the application code stopped writing
-- `id: 'singleton'` (same MR). Nothing re-creates the row.
--
-- Repair-before-enforce (see 20260727194512_step_est_minutes_check): this is the
-- repair half. `userId` deliberately stays NULLABLE in this release - see the
-- plan's Decision 2: the code being replaced writes a NULL userId on every page
-- load, so a SET NOT NULL applied while old pods still serve a rolling update
-- would 500 the inbox for the length of the rollout. The structural guard is
-- src/lib/__tests__/scoping.harness.test.ts, which fails in CI instead.
--
-- Logged, not silent: this destroys real credentials, so it says how many.
DO $$
DECLARE
  purged integer;
BEGIN
  DELETE FROM "GoogleAuth" WHERE "userId" IS NULL;
  GET DIAGNOSTICS purged = ROW_COUNT;
  RAISE NOTICE '#118: purged % orphaned GoogleAuth row(s) (userId IS NULL)', purged;
END $$;

-- ── User.llmProvider ← LlmProvider (anthropic | openai-compatible) ──────────
--
-- Phase C makes `llmKeyEnc` writable from the UI, which makes this column's
-- null-vs-value distinction load-bearing for the first time: user-quota.ts hands
-- it to getLLM(), which selects an ADAPTER from it and falls back to
-- LLM_PROVIDER for anything unrecognised. So a bad value is not a crash - it is
-- an account billed to its own key against the wrong vendor's endpoint. NULL
-- stays legal and means "use the instance default".
--
-- Mirrors LlmProvider in src/lib/constants.ts and is registered in
-- src/lib/enum-constraint-sync.integration.test.ts, so dropping it out of band
-- fails the suite.

-- Repair first. Nothing in the repo writes this column today, so this is
-- expected to match zero rows; it exists so a hand-edited value REPAIRS to the
-- documented default instead of wedging `prisma migrate deploy` halfway.
-- Idempotent: matches zero rows on any re-run.
UPDATE "User"
   SET "llmProvider" = NULL
 WHERE "llmProvider" IS NOT NULL
   AND "llmProvider" NOT IN ('anthropic', 'openai-compatible');

ALTER TABLE "User"
  ADD CONSTRAINT "User_llmProvider_check"
  CHECK ("llmProvider" IS NULL OR "llmProvider" IN ('anthropic', 'openai-compatible'));
```

- [x] **Step 5: Register the constraint**

In `src/lib/enum-constraint-sync.integration.test.ts`, add `LlmProvider` to the `@/lib/constants` import and append to `REGISTRY` after the `User_aiPolicy_check` entry:

```ts
  {
    // #118 Phase C — the column feeds getLLM()'s adapter choice for an account
    // paying with its own key. NULL = the instance default.
    constraint: "User_llmProvider_check",
    table: "User",
    column: "llmProvider",
    values: LlmProvider,
    nullable: true,
  },
```

- [x] **Step 6: Correct the schema comment**

`prisma/schema.prisma`'s `model GoogleAuth` comment. #119 already rewrote it to say the shared row is *not* gone; Phase C makes that stale in the other direction. **Read what #119 actually left there before editing** — if #119 has not merged, its version is the base you are amending:

```prisma
// ── Google Tasks OAuth (tokens obtained at runtime) ───────────────────────
// client_id/secret come from env (GOOGLE_CLIENT_ID/SECRET); only tokens here.
//
// #118 Phase C: ONE ROW PER USER, keyed on `userId`. src/lib/google.ts is the
// only module that touches this table, every function there takes the acting
// user's id, and none of them accepts a row id — so there is nothing a caller
// could point at another account's credential.
//
// History, because two earlier comments here were wrong and the wrong one was
// load-bearing: Phase A dropped the `@default("singleton")` id and DELETEd every
// row, but application code kept supplying `id: "singleton"` explicitly, so one
// instance-wide row was re-created on demand and sync never went down (#119).
// Phase C's migration destroys that orphan (userId IS NULL) rather than adopting
// it, and the owner reconnects once.
//
// `userId` is still NULLABLE, deliberately: the code this release replaces wrote
// a NULL userId on every page load, so SET NOT NULL during a rolling update
// would 500 the inbox. src/lib/__tests__/scoping.harness.test.ts is the guard —
// it fails CI if any prisma.googleAuth.* call does not name userId.
model GoogleAuth {
```

- [x] **Step 7: Apply and verify**

```bash
npx prisma migrate dev --name google_auth_orphan_purge
npx vitest run src/lib/google-auth-orphan.integration.test.ts \
  src/lib/enum-constraint-sync.integration.test.ts
npm test && npx tsc --noEmit
```

Expected: PASS. If the sync test reports an unmanaged constraint, the name in the migration and the name in `REGISTRY` disagree — fix the registry, since the SQL name follows the `<Table>_<column>_check` convention.

- [x] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/constants.ts \
  src/lib/llm/index.ts src/lib/enum-constraint-sync.integration.test.ts \
  src/lib/google-auth-orphan.integration.test.ts
git commit -m "feat(db): destroy the orphaned Google credential (#118)

Production holds a GoogleAuth row with userId = NULL carrying real encrypted
access and refresh tokens - the pre-accounts singleton, which survived Phase A
because application code kept supplying id: 'singleton' after the database
default was dropped (#119). Once reads key on userId that row is unreachable,
unrevocable AND uncascadable: the FK cascades from User, and a NULL userId never
reaches one, so deleting every account would leave it sitting there.

Destroyed rather than adopted, per the owner's decision on #118: it removes a
stale credential instead of silently keeping one nobody can revoke, and it
matches the design's own 'the owner is starting fresh anyway' posture. Cost is
one manual reconnect after the deploy. The DELETE is logged with a row count -
this is a code path that destroys real secrets.

userId stays nullable on purpose. The code this release replaces writes a NULL
userId on every page load, so SET NOT NULL during a rolling update would 500 the
inbox; the scoping harness fails in CI instead, which is strictly better.

Rider: User_llmProvider_check. Phase C makes llmKeyEnc writable, which makes
this column load-bearing for the first time - user-quota.ts hands it to
getLLM(), which picks an ADAPTER from it and silently falls back for anything
unrecognised. An unconstrained pseudo-enum feeding a provider factory is exactly
what the #38 convention exists to stop.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Open Google to any signed-in member

**Files:**
- Modify: `src/lib/auth/gate.ts` + `src/lib/auth/gate.test.ts`
- Modify: `src/app/api/google/oauth/start/route.ts` + `route.test.ts` (#119's)
- Modify: `src/app/api/google/oauth/callback/route.test.ts` (#119's)
- Modify: `src/app/actions/google-schedule.ts`
- Modify: `src/app/actions/google-schedule.push.test.ts` (evolve #119's negative), `.single.test.ts`, `.disconnect.test.ts`
- Modify: `src/lib/scheduling/providers.ts` + `providers.test.ts`
- Modify: `src/proxy.test.ts`

**Interfaces:**
- Changes: `OWNER_ONLY_PREFIXES: readonly string[]` becomes empty; `AUTHENTICATED_PREFIXES` gains `"/api/google/oauth/"`.
- Changes: `googleTasksProvider.isAvailable = (ctx) => ctx.google?.configured ?? false`.
- Removes: `googleStatus()` from `src/app/actions/google-schedule.ts`.

**This is the security-relevant commit.** Everything before it moved the credential without widening access. Read #119's three test files in full before writing anything here: this task **evolves** their assertions and must not delete the negative coverage that made a missing gate visible in the first place.

- [x] **Step 1: Write the failing tests — the route category**

In `src/lib/auth/gate.test.ts`, replace the two owner-only OAuth cases (`:29-34`) and extend the authenticated-only block:

```ts
  it("integration oauth is NOT owner-only any more (#118 Phase C)", () => {
    // Google is per-user now: a member connecting their OWN account is the
    // intended behaviour, not a hijack. See AUTHENTICATED_PREFIXES below.
    expect(isOwnerOnlyPath("/api/google/oauth/start")).toBe(false);
  });

  it("owner-only is deliberately empty, not accidentally so", () => {
    // Kept as a named category rather than deleted: Phase D's revoke/purge
    // routes may need it, and at the MIDDLEWARE layer it means exactly what
    // AUTHENTICATED_PREFIXES means ("signed in") — the role half has to live in
    // the handler because the Edge runtime has no Prisma client (src/proxy.ts).
    // #119 is what happens when that handler half is assumed instead of written.
    expect(OWNER_ONLY_PREFIXES).toEqual([]);
  });
```

and in the authenticated-only block:

```ts
  it("integration oauth is authenticated-only — members yes, guests no", () => {
    expect(isAuthenticatedOnlyPath("/api/google/oauth/start")).toBe(true);
    expect(isAuthenticatedOnlyPath("/api/google/oauth/callback")).toBe(true);
  });
```

Add `OWNER_ONLY_PREFIXES` to the file's import.

In `src/proxy.test.ts`, add to the `describe("proxy: authenticated-only paths")` block (read the existing three cases at `:61-85` for the request-forging helper this file uses):

```ts
  it("still redirects a guest away from the Google OAuth start (#118)", async () => {
    // The whole risk of moving this route out of owner-only: it must not become
    // guest-reachable. A valid GUEST session is not enough.
    // …forge a guest cookie exactly as the sibling test above does…
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("lets a signed-in member through to the Google OAuth start (#118)", async () => {
    // …forge a user cookie exactly as this file's signed-in helper does…
    expect(res.headers.get("location")).toBeNull();
  });
```

- [x] **Step 2: Write the failing tests — the action gates**

In `src/app/actions/google-schedule.push.test.ts`, **replace** #119's `"rejects a non-owner without touching Google"` with the evolved trio. Keep its comment history — the note about *why* that test exists is the most valuable line in the file:

```ts
  // #119 added a non-owner rejection here because this file's beforeEach pins
  // ownership true, so nothing asserted a rejection and a missing gate on the
  // OAuth routes went unnoticed. #118 Phase C changes what "allowed" means: the
  // credential is per user, so a MEMBER acting on THEIR OWN row is the intended
  // behaviour. The negative case is not deleted, it MOVES — from "wrong role" to
  // "wrong person" and "no account at all", which are the two failures that can
  // still happen.
  const MEMBER_ID = "user-member";
  const memberUser = () => ({
    id: MEMBER_ID,
    role: "member" as const,
    workspaceId: "ws-member",
    provider: "gitlab",
    handle: "member",
  });

  it("lets a MEMBER push against their OWN credential (was 403 in #119)", async () => {
    currentUserMock.mockResolvedValue(memberUser());
    isOwnerMock.mockResolvedValue(false);
    taskFindFirstMock.mockResolvedValue(baseTask());

    const res = await pushStepsToGoogleTasks("task-1");

    expect(res.ok).toBe(true);
    // Their own row, resolved by their own id. This assertion is the isolation
    // guarantee: there is no id parameter, so there is no other row to reach.
    expect(tokenMock).toHaveBeenCalledWith(MEMBER_ID);
  });

  it("never resolves another account's credential", async () => {
    currentUserMock.mockResolvedValue(memberUser());
    taskFindFirstMock.mockResolvedValue(baseTask());
    await pushStepsToGoogleTasks("task-1");
    for (const [arg] of tokenMock.mock.calls) {
      expect(arg).toBe(MEMBER_ID);
    }
    expect(tokenMock).not.toHaveBeenCalledWith(OWNER_ID);
  });

  it("refuses a caller with no signed-in account, touching Google not at all", async () => {
    // A guest, or a revoked account (currentUser() returns null for status
    // revoked, so revocation takes effect on the NEXT request).
    currentUserMock.mockResolvedValue(null);
    taskFindFirstMock.mockResolvedValue(baseTask());

    await expect(pushStepsToGoogleTasks("task-1")).rejects.toThrow(
      /sign in required/,
    );
    expect(tokenMock).not.toHaveBeenCalled();
    expect(upsertGoogleTaskMock).not.toHaveBeenCalled();
    expect(createGoogleTaskMock).not.toHaveBeenCalled();
    expect(taskUpdateMock).not.toHaveBeenCalled();
    expect(logRewardMock).not.toHaveBeenCalled();
  });
```

**Clean up `isOwnerMock` while you are here.** After Task 2, `src/app/actions/google-schedule.ts` no longer imports `isOwnerRequest` at all, and after this task no test in these three files drives it — so drop `isOwnerRequest` from each file's `vi.mock("@/lib/workspace", …)` factory and delete the now-unused hoisted `isOwnerMock`, or `npm run lint` will flag it. `currentUserMock` is the single identity mock from here on: two mocks for one question is how a test ends up describing two different people.

Mirror the "member allowed / no-account refused / own id only" trio in `google-schedule.single.test.ts` and `google-schedule.disconnect.test.ts`. In the disconnect file add specifically:

```ts
  it("disconnects the ACTING user's connection, never another's", async () => {
    currentUserMock.mockResolvedValue(memberUser());
    await disconnectGoogleTasks();
    expect(disconnectGoogleMock).toHaveBeenCalledWith(MEMBER_ID);
  });
```

- [x] **Step 3: Write the failing tests — the seam predicate**

In `src/lib/scheduling/providers.test.ts`, replace the owner-predicate cases:

```ts
  it("offers Google Tasks to a MEMBER with a configured instance (#118)", () => {
    expect(
      googleTasksProvider.isAvailable({
        workspaceId: "ws-member",
        isOwner: false,
        google: { configured: true, connected: false, needsReconnect: false },
      }),
    ).toBe(true);
  });

  it("does not offer it to a guest — a null status is the guest signal", () => {
    expect(
      googleTasksProvider.isAvailable({
        workspaceId: "ws-guest",
        isOwner: false,
        google: null,
      }),
    ).toBe(false);
  });

  it("does not offer it when the instance has no OAuth client", () => {
    expect(
      googleTasksProvider.isAvailable({
        workspaceId: "ws-member",
        isOwner: false,
        google: { configured: false, connected: false, needsReconnect: false },
      }),
    ).toBe(false);
  });
```

- [x] **Step 4: Write the failing test — the OAuth start gate**

In `src/app/api/google/oauth/start/route.test.ts` (#119's), swap the `@/lib/workspace` mock from `isOwnerRequest` to `currentUser`, then evolve:

```ts
describe("google oauth start — authenticated gate (#118, was owner-only in #119)", () => {
  it("lets a signed-in MEMBER start their own connect flow", async () => {
    currentUserMock.mockResolvedValue(memberUser());
    const res = await GET(new Request(START_URL));
    expect(res.status).toBe(307);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("google_pkce_verifier=ver");
  });

  it("rejects a caller with no signed-in account with 403", async () => {
    // The middleware already stops guests (AUTHENTICATED_PREFIXES), so this is
    // defence in depth — and it also covers a REVOKED account, which holds a
    // valid signed cookie and resolves to null (workspace.ts:142).
    currentUserMock.mockResolvedValue(null);
    const res = await GET(new Request(START_URL));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
  });

  // #119's "hands a rejected caller no PKCE or state cookie" case is KEPT
  // verbatim below, with currentUserMock → null instead of isOwner → false. It
  // is the assertion that the gate runs FIRST.
});
```

Do the same in `callback/route.test.ts`: keep #119's `"rejects a non-owner holding a valid state + verifier"` case but retarget it to a **null** user, and add a member-completes-the-exchange case asserting `exchangeCodeMock` was called with the **member's** id.

- [x] **Step 5: Run them all to verify they fail**

```bash
npx vitest run src/lib/auth/gate.test.ts src/proxy.test.ts \
  src/lib/scheduling/providers.test.ts src/app/actions/google-schedule.*.test.ts \
  "src/app/api/google/oauth/**/route.test.ts"
```

Expected: FAIL across the board — the OAuth prefix is still owner-only, the actions still throw `"owner only"` for a member, `isAvailable` still requires `ctx.isOwner`.

- [x] **Step 6: Implement**

`src/lib/auth/gate.ts`:

```ts
/**
 * Paths only the instance owner may reach. **Deliberately empty since #118.**
 *
 * Kept as a named category rather than deleted, for two reasons. At the
 * middleware layer this means exactly what AUTHENTICATED_PREFIXES means — the
 * Edge runtime has no Prisma client, so "role = owner" can only be checked at
 * the handler (see src/proxy.ts) — and #119 is what happens when that handler
 * half is assumed rather than written. And Phase D's revoke/purge routes are the
 * next likely occupant. Its middleware branch is retained on the same grounds.
 */
export const OWNER_ONLY_PREFIXES: readonly string[] = [];

/**
 * Paths that require a real signed-in account. A guest session is NOT enough.
 * … existing comment …
 *
 * #118 Phase C moved `/api/google/oauth/` in here, which is the move this
 * category was created for: `GoogleAuth` is keyed on `userId` now, so a member
 * connecting their OWN account is the intended behaviour. The handler still
 * checks `currentUser()` itself — the middleware proves "signed in", never "who".
 */
export const AUTHENTICATED_PREFIXES = [
  "/api/account/",
  "/api/google/oauth/",
];
```

`src/app/api/google/oauth/start/route.ts` — replace #119's owner gate:

```ts
import { currentUser } from "@/lib/workspace";

  // #118 Phase C — any signed-in account may connect THEIR OWN Google account.
  // The middleware already rejects guests (AUTHENTICATED_PREFIXES); this is the
  // handler half, and it is not redundant: a REVOKED account still holds a valid
  // signed cookie and passes the middleware, while currentUser() resolves it to
  // null (src/lib/workspace.ts:142). 403 rather than a redirect — bouncing a
  // rejected caller into Google's consent screen walks them through the very
  // flow being denied. First, so nothing usable is minted.
  if (!(await currentUser())) {
    return new NextResponse("Forbidden", { status: 403 });
  }
```

`src/app/api/google/oauth/callback/route.ts` — same, keeping the id:

```ts
  const me = await currentUser();
  if (!me) return new NextResponse("Forbidden", { status: 403 });
```

`src/app/actions/google-schedule.ts` — the four gates become three (`googleStatus` is deleted). In `pushStepsToGoogleTasks` and `scheduleSingleTask`:

```ts
  // #118 Phase C — "signed in, acting on their own credential" replaces the
  // owner check. Note what is NOT here and never will be: an id parameter. The
  // credential is looked up BY me.id, so there is no other row to reach — which
  // is the whole isolation argument, and why the scoping harness can assert it.
  // Also covers revocation: a revoked account resolves to null on its very next
  // request, without waiting for a 30-day cookie to expire.
  const me = await currentUser();
  if (!me) throw new Error("sign in required");
```

`disconnectGoogleTasks` likewise. **Delete `googleStatus()` entirely** (`:327-331`) and its test in `google-schedule.disconnect.test.ts` (or wherever it lives — `grep -rn "googleStatus" src/`), replacing the test with a note:

```ts
// #118 — the `googleStatus()` server action is GONE. It was owner-gated with
// zero non-test callers and still a reachable RPC endpoint; every real caller
// reads getGoogleStatus() at the server boundary instead. Deleted rather than
// re-gated: carrying a live endpoint forward for nobody is how a surface grows.
```

`src/lib/scheduling/providers.ts:52-58`:

```ts
  // #118 Phase C — per-user. `ctx.google` is resolved for the ACTING user at the
  // server boundary and is `null` only when there is no signed-in account, so a
  // non-null status IS the "this person has an account" signal and the `isOwner`
  // term is gone. Gates on `configured`, not `connected`: the
  // connect/reconnect/needsReconnect nuances stay in `scheduleState`; this
  // answers only "is the method offered at all."
  isAvailable: (ctx) => ctx.google?.configured ?? false,
```

Leave `SchedulingContext.isOwner` in place — it is still the honest name for the role, and Task 5 is what stops it standing in for "is a guest".

Update `leadSchedulingMethod`'s doc comment (`providers.ts:104-118`), which says *"`null` = guest / non-owner, mirroring the page's `owner ? googleStatus : null`"*. That mirror is what Task 5 removes; say so:

```ts
 * `null` now means "no signed-in account" (a guest) rather than "not the owner"
 * — #118 Phase C gave members their own connection, so a member leads with the
 * Google control too.
```

- [x] **Step 7: Run the tests and the whole suite**

```bash
npx vitest run src/lib/auth/gate.test.ts src/proxy.test.ts \
  src/lib/scheduling/providers.test.ts src/app/actions/google-schedule.*.test.ts
npm test && npx tsc --noEmit
```

Expected: PASS. `npm test` will also surface any component test that assumed `isAvailable` needs an owner — fix those assumptions rather than the predicate.

- [x] **Step 8: Commit**

```bash
git add src/lib/auth/gate.ts src/lib/auth/gate.test.ts src/proxy.test.ts \
  src/lib/scheduling/providers.ts src/lib/scheduling/providers.test.ts \
  src/app/actions/google-schedule.ts src/app/actions/google-schedule.*.test.ts \
  src/app/api/google/oauth
git commit -m "feat(google): any signed-in member may connect their own account (#118)

/api/google/oauth/ moves from OWNER_ONLY_PREFIXES into AUTHENTICATED_PREFIXES -
the category Phase A created for exactly this move and which has been enforced
against nothing since. Guests are still rejected, at the middleware AND at the
handler: a revoked account holds a valid signed cookie and passes the
middleware, while currentUser() resolves it to null, so the handler check is not
redundant.

The three surviving action gates become 'signed in, acting on their own
credential'. There is no id parameter anywhere in this path - the credential is
looked up BY the acting user - so there is no other row to reach. That is the
isolation argument, and the scoping harness asserts it structurally.

#119's negative tests are EVOLVED, not deleted. A member goes from 403 to
allowed-for-their-own-row; the negative case moves from 'wrong role' to 'wrong
person' and 'no account at all', which are the two failures that can still
happen. Losing that coverage is how the missing gate went unnoticed the first
time.

googleStatus() is deleted rather than re-gated: owner-gated, zero non-test
callers, still a reachable RPC endpoint. Carrying a live endpoint forward for
nobody is how a surface grows.

OWNER_ONLY_PREFIXES stays as an empty named category. At the middleware layer it
means what AUTHENTICATED_PREFIXES means - the Edge runtime cannot tell an owner
from a member - and Phase D is its next likely occupant.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: A member sees their own status; a guest sees none of it

**Files:**
- Modify: `src/app/(app)/page.tsx` (the `owner ? googleStatus : null` line)
- Modify: `src/app/(app)/tasks/[taskId]/page.tsx` (`:56-60` and `:88-89`)
- Modify: `src/components/breakdown/breakdown-chat.tsx` (`google` prop nullable, `isGuest` prop deleted)
- Modify: `src/app/(app)/tasks/[taskId]/page.test.tsx`, `src/components/breakdown/*.test.tsx` (whichever pass `google`/`isGuest` — `grep -rn "isGuest" src/`)

**Two bugs in one place.** `owner ? googleStatus : null` is what makes the 📅 fall back to `.ics` for a member who has their own connection. And `tasks/[taskId]/page.tsx:88-89` passes the **raw, un-filtered** `google` object into `breakdown-chat.tsx` — a non-nullable prop — while gating the section on `isGuest`, so `configured`/`connected`/`needsReconnect` land in the RSC payload for people who should not see them. That is the precise opposite of the rule `integrations-panel.test.tsx:126` asserts ("never leaks the owner's real connection status to guests"). After Phase C the two are the same fix: **a non-null status means "this is the acting account's own status", and `null` means "no account".**

- [x] **Step 1: Write the failing tests**

Add to `src/app/(app)/tasks/[taskId]/page.test.tsx` (read the file's existing render harness first — do not guess how it mounts an async server component):

```tsx
  it("gives a MEMBER their own Google status, not a null fallback (#118)", async () => {
    // The member has their own connection now. Falling back to .ics silently
    // hid the feature this whole phase exists to ship.
    // …arrange currentUser() → member, getGoogleStatus(member.id) → connected…
    // …assert the rendered scheduling control is the Google one, not .ics…
  });

  it("never puts a connection status in a GUEST's payload (#118)", async () => {
    // …arrange currentUser() → null…
    // The prop must be null, not merely unrendered: an un-nullable prop is
    // serialised into the RSC payload whether or not the section renders it.
    expect(passedProps.google).toBeNull();
  });

  it("never hands one account another's status", async () => {
    // …arrange currentUser() → member…
    expect(getGoogleStatusMock).toHaveBeenCalledWith(MEMBER_ID);
    expect(getGoogleStatusMock).not.toHaveBeenCalledWith(OWNER_ID);
  });
```

Add to the breakdown-chat test file:

```tsx
  it("renders no Google section when there is no status (#118)", () => {
    render(<BreakdownChat {...baseProps} google={null} />);
    expect(screen.queryByText(/schedule onto your calendar/i)).toBeNull();
    // The universal .ics export is still there — it needs no integration.
    expect(screen.getByText(/add to your calendar/i)).toBeInTheDocument();
  });

  it("renders the Connect affordance for a member who has not connected", () => {
    render(
      <BreakdownChat
        {...baseProps}
        google={{ configured: true, connected: false, needsReconnect: false }}
      />,
    );
    expect(
      screen.getByRole("link", { name: /connect google/i }),
    ).toHaveAttribute("href", "/api/google/oauth/start");
  });
```

- [x] **Step 2: Run to verify they fail**

```bash
npx vitest run "src/app/(app)/tasks/[taskId]/page.test.tsx" src/components/breakdown
```

Expected: FAIL — `google={null}` is a type error and the member case renders `.ics`.

- [x] **Step 3: Implement**

`src/app/(app)/page.tsx` — delete the owner filter:

```ts
  // #118 Phase C — the ACTING ACCOUNT's own status. Was `owner ? googleStatus :
  // null`, which is what made a member's 📅 fall back to .ics even when they had
  // their own connection. getGoogleStatus() already returns the not-connected
  // shape without a query for a caller with no account, so `null` here means
  // exactly one thing: nobody is signed in.
  const google = me ? googleStatus : null;
```

`src/app/(app)/tasks/[taskId]/page.tsx` — same for `ctx.google`, and fix the payload leak:

```ts
  const isGuest = me == null;
  const ctx: SchedulingContext = {
    workspaceId,
    isOwner: owner,
    // #118 — this account's own status. `null` only when nobody is signed in.
    google: isGuest ? null : googleStatus,
  };
  // …and at the BreakdownChat call site:
        // #118 — the same nullable status the seam gets. It used to receive the
        // RAW object with the guest/owner split carried by a separate isGuest
        // prop, so configured/connected/needsReconnect were serialised into the
        // RSC payload for people the section was hidden from.
        google={ctx.google}
```

Delete the `isGuest={!ctx.isOwner}` prop from the call site.

`src/components/breakdown/breakdown-chat.tsx`:

```ts
  /**
   * The acting account's own Google status, or `null` when nobody is signed in.
   *
   * #118 Phase C: nullable, and the `isGuest` prop is gone. A null status IS the
   * guest signal — a signed-in member with no connection still gets a status
   * object (`connected: false`) so they see the Connect affordance, and a guest
   * gets nothing, which is also what keeps it out of the RSC payload.
   */
  google: GoogleConnStatus | null;
```

and at `:245-246`:

```ts
  const showGoogleSection =
    google != null && leadSchedulingMethod(google) === "googleTasks";
```

The explicit `google != null` is what narrows the type for the `google.configured` dereference at `:288` — `leadSchedulingMethod` returning `"googleTasks"` implies non-null logically but TypeScript cannot see it.

Remove the `isGuest` parameter and its type entirely (`grep -n "isGuest" src/components/breakdown/breakdown-chat.tsx` should return nothing afterwards), and fix every other caller and test the grep across `src/` turns up.

- [x] **Step 4: Run the tests and the whole suite**

```bash
npx vitest run "src/app/(app)" src/components/breakdown
npm test && npx tsc --noEmit
```

- [x] **Step 5: Commit**

```bash
git add "src/app/(app)/page.tsx" "src/app/(app)/tasks/[taskId]/page.tsx" \
  "src/app/(app)/tasks/[taskId]/page.test.tsx" src/components/breakdown
git commit -m "feat(scheduling): a member's 📅 uses their own connection (#118)

Two bugs, one fix. \`owner ? googleStatus : null\` is what made a member's 📅
fall back to .ics even with their own Google account connected - it hid the
feature this phase exists to ship. And the task page passed the RAW, unfiltered
status object into BreakdownChat as a NON-NULLABLE prop while gating the section
on a separate isGuest flag, so configured/connected/needsReconnect were
serialised into the RSC payload for exactly the people the section was hidden
from - the opposite of the rule integrations-panel.test.tsx already asserts.

After Phase C both are the same statement: a non-null status is the ACTING
account's own, and null means nobody is signed in. So the isGuest prop is gone
too - a null status IS the guest signal, and a member with no connection still
gets a status object so they see the Connect affordance.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: A member manages their own connection in `/settings`

**Files:**
- Modify: `src/app/(app)/settings/page.tsx` (`:44-47`, `:58`, `:143-156`)
- Modify: `src/components/settings/integrations-panel.tsx`
- Modify: `src/components/settings/integrations-panel.test.tsx`, `src/app/(app)/settings/page.test.tsx`

**Today a member gets the same 🔒 owner-only shell a guest gets** (`settings/page.tsx:151`). That branch becomes "any signed-in account sees their own panel; a guest sees the shell". The shell's copy also stops being true — it says the integration is owner-only, which it no longer is.

- [x] **Step 1: Write the failing tests**

In `src/app/(app)/settings/page.test.tsx` (read its existing harness first):

```tsx
  it("gives a MEMBER the real Integrations panel, not the owner-only shell (#118)", async () => {
    // …arrange currentUser() → member, getGoogleStatus(member.id) → not connected…
    expect(
      screen.getByRole("link", { name: /connect google/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/owner-only/i)).toBeNull();
  });

  it("resolves the status for the member's OWN id", async () => {
    expect(getGoogleStatusMock).toHaveBeenCalledWith(MEMBER_ID);
  });

  it("still gives a GUEST the read-only shell with no real status", async () => {
    // …arrange currentUser() → null…
    expect(screen.getByText(/owner-only|sign in/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /connect google/i })).toBeNull();
    expect(getGoogleStatusMock).toHaveBeenCalledWith(null);
  });

  it("lists Integrations in the section nav for a member", async () => {
    // showIntegrations is computed from `owner ? google != null : true`, which
    // a member now falls through in the wrong direction if left alone.
    expect(
      screen.getByRole("link", { name: /integrations/i }),
    ).toBeInTheDocument();
  });
```

In `src/components/settings/integrations-panel.test.tsx`, keep every existing test (including the `#90` `opacity-` regression lock and the `"never leaks the owner's real connection status to guests"` case — the leak rule is unchanged, only the word "owner" in it) and add:

```tsx
  it("says the connection is YOURS, not the instance's (#118)", () => {
    render(
      <IntegrationsPanel
        google={{ configured: true, connected: true, needsReconnect: false }}
        defaultExpanded
      />,
    );
    // Copy matters here: a member reading "the owner's Google account" would
    // reasonably assume disconnecting affects somebody else.
    expect(screen.getByText(/your google/i)).toBeInTheDocument();
  });

  it("the read-only shell no longer claims the integration is owner-only", () => {
    // #118 — it is per-user now. The shell is for a caller with no ACCOUNT.
    render(<IntegrationsPanel google={null} readOnly defaultExpanded />);
    expect(screen.queryByText(/owner-only/i)).toBeNull();
    expect(screen.getByText(/sign in/i)).toBeInTheDocument();
  });

  it("has no axe violations in either presentation", async () => {
    for (const props of [
      { google: base, defaultExpanded: true },
      { google: null, readOnly: true, defaultExpanded: true },
    ] as const) {
      const { container, unmount } = render(<IntegrationsPanel {...props} />);
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });

  it("keeps the Disconnect confirmation reachable from the keyboard", async () => {
    render(<IntegrationsPanel google={{ configured: true, connected: true, needsReconnect: false }} defaultExpanded />);
    await userEvent.tab();
    // …tab to Disconnect, press Enter, assert the confirm row appears, press
    // Escape or activate Cancel, assert focus is not lost…
  });
```

- [x] **Step 2: Run to verify they fail**

```bash
npx vitest run "src/app/(app)/settings/page.test.tsx" src/components/settings/integrations-panel.test.tsx
```

Expected: FAIL — a member gets the shell, the shell says "Owner-only", no `/your google/i` copy exists.

- [x] **Step 3: Implement the page branch**

`src/app/(app)/settings/page.tsx`. The Google read stops being owner-gated (the People read does not — it stays owner-only):

```ts
  const [google, people] = await Promise.all([
    // #118 Phase C — every signed-in account has its own connection, so this is
    // resolved for whoever is asking. A caller with no account is passed null
    // and getGoogleStatus() answers without a query.
    getGoogleStatus(me?.id ?? null),
    // Still owner-only. loadPeopleAdmin re-checks the role itself and returns
    // null for anyone else, so the panel cannot render for a member even if this
    // call site were ever changed to drop the gate.
    owner ? loadPeopleAdmin(me?.id) : Promise.resolve(null),
  ]);
```

`:58` — the nav's conditional:

```ts
  // #72 + #118 — the nav lists what this render actually put on the page. Both
  // presentations of the Integrations section render something now (own panel or
  // signed-out shell), so it is always listed; People remains owner-only.
  const sections = SETTINGS_SECTIONS.filter(
    (section) => section.id !== "settings-people" || people != null,
  );
```

`:143-156` — the three-way branch collapses to two:

```tsx
      <div className="border-t pt-4">
        {me ? (
          // #118 Phase C — YOUR OWN connection, owner or member alike. Was
          // `owner && google`, with a member falling into the guest shell below.
          <IntegrationsPanel google={google} voice={voice} />
        ) : (
          // #11 — a caller with no account sees the section EXISTS, read-only,
          // with no status fetched and none shown.
          <IntegrationsPanel google={null} readOnly voice={voice} />
        )}
      </div>
```

The old "owner but no status object → render nothing" arm goes: `getGoogleStatus` always returns an object, and `me` is now the only condition.

- [x] **Step 4: Implement the panel copy and a11y**

`src/components/settings/integrations-panel.tsx`:

```ts
// Shared copy so the panel and the signed-out shell never drift.
const GOOGLE_NAME = "Google Tasks";
// #118 Phase C — "your", not the instance's. A member reading about "the
// owner's Google account" would reasonably assume Disconnect affects somebody
// else's connection, which is the opposite of true.
const GOOGLE_DESCRIPTION =
  "Schedule your steps and tasks into your own Google Tasks — a Reclaim-synced list is scheduled automatically.";
```

Update the `readOnly` branch: replace the two `t("settings.ownerOnly", voice)` labels and `t("settings.integrationsOwnerHint", voice)` with sign-in copy. Add the two new keys to `src/lib/strings.ts` beside the existing `settings.integrationsOwnerHint` (`:690`):

```ts
  "settings.integrationsSignedOut": {
    plain: "Sign in",
    playful: "Sign in",
  },
  "settings.integrationsSignInHint": {
    plain: "Sign in to connect your own Google account. Your connection is yours alone — nobody else on this instance can see or use it.",
    playful: "Sign in to hook up your own Google account. Yours alone — nobody else gets a peek. 🔒",
  },
```

Keep `settings.ownerOnly` — `BreakdownModelSection` still uses it. Leave `settings.integrationsOwnerHint` in place if anything else references it (`grep -rn "integrationsOwnerHint" src/`); delete it if nothing does.

Two more things the tests above demand:
- The **Disconnect** and **Yes, disconnect** buttons need `touchTarget` from `@/lib/utils` (44×44). Check every button in this file; the existing `px-3 py-2 text-sm` is ~34px tall.
- The confirmation row is an `aria-live` concern: wrap the *"Remove access and delete stored tokens?"* text in `role="status"` so a screen-reader user learns the confirmation appeared, and give the destructive button an `aria-describedby` pointing at it. Keep the visible text; do not replace it with an `aria-label`.

Do **not** re-introduce an `opacity-*` wash on either card — `integrations-panel.test.tsx`'s `#90` lock and `e2e/a11y/axe-guest-surfaces.spec.ts` both police it.

- [x] **Step 5: Run the tests and the whole suite**

```bash
npx vitest run src/components/settings "src/app/(app)/settings"
npm test && npx tsc --noEmit && npm run lint
```

- [x] **Step 6: Commit**

```bash
git add "src/app/(app)/settings/page.tsx" "src/app/(app)/settings/page.test.tsx" \
  src/components/settings/integrations-panel.tsx \
  src/components/settings/integrations-panel.test.tsx src/lib/strings.ts
git commit -m "feat(settings): a member connects their own Google account (#118)

A member used to get the identical 🔒 owner-only shell a guest gets, so the one
account type this phase exists for had no way to reach the connect flow from the
UI at all. The branch is now 'signed in → your own panel, no account → the
read-only shell'.

The shell's copy stopped being true as well: the integration is per-user, so
'Owner-only' becomes 'Sign in', and the description says YOUR Google account -
a member reading about the owner's account would reasonably assume Disconnect
affects somebody else's connection.

a11y with it, not after it: 44x44 touch targets on both destructive controls,
the disconnect confirmation announced through role=status and wired to the
button via aria-describedby, and an axe assertion over both presentations. The
#90 opacity regression lock is untouched.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The per-user LLM key — the write side

**Files:**
- Create: `src/app/actions/account.ts`
- Create: `src/app/actions/account.test.ts`
- Create: `src/components/settings/account-panel.tsx`
- Create: `src/components/settings/account-panel.test.tsx`
- Modify: `src/app/(app)/settings/page.tsx`
- Modify: `src/lib/section-nav.ts`, `src/lib/strings.ts`
- Modify: `src/lib/__tests__/scoping.harness.test.ts` (`KEY_CIPHERTEXT_FILES`)

**Interfaces:**
- Produces:
  ```ts
  export type AccountActionResult =
    | { ok: true }
    | { ok: false; error: "not_signed_in" | "invalid_key" | "not_found" };
  export async function saveOwnLlmKey(apiKey: string): Promise<AccountActionResult>;
  export async function removeOwnLlmKey(): Promise<AccountActionResult>;
  /** Presence only — never the key, never its ciphertext. */
  export async function ownLlmKeyPresent(): Promise<boolean>;
  ```

Phase B built the whole read side: `getLLM(creds)` takes a per-request key, `user-quota.ts:149` decrypts `llmKeyEnc`, and a present key short-circuits both policy and metering (`:150-157`). **Nothing in the repo writes the column.** This task writes it, and registers itself in the harness's `KEY_CIPHERTEXT_FILES` map at `:236-241`, whose comment says in as many words that Phase C's key-writing UI must appear there.

**A present key is what lifts the cap** — see `consumeUserBreakdown`'s resolution order. So saving a key must NOT touch `aiPolicy`: a member on `capped` who brings a key is already uncapped by construction, and writing `own_key` into the policy column from a member-facing action would let a member edit a field the owner administers.

- [x] **Step 1: Write the failing tests for the action**

Create `src/app/actions/account.test.ts`, mirroring `src/app/actions/people.test.ts`'s mocking style (read it first):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { decryptToken } from "@/lib/crypto/token-cipher";

const {
  currentUserMock,
  userUpdateMock,
  userUpdateManyMock,
  userFindUniqueMock,
  revalidateMock,
} = vi.hoisted(() => ({
  currentUserMock: vi.fn(),
  userUpdateMock: vi.fn(),
  userUpdateManyMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  revalidateMock: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      update: userUpdateMock,
      updateMany: userUpdateManyMock,
      findUnique: userFindUniqueMock,
    },
  },
}));
vi.mock("@/lib/workspace", () => ({ currentUser: currentUserMock }));

import { saveOwnLlmKey, removeOwnLlmKey, ownLlmKeyPresent } from "./account";

const ME = "user_alice";
const me = () => ({
  id: ME, role: "member" as const, workspaceId: "ws_a",
  provider: "gitlab", handle: "alice",
});

beforeEach(() => {
  vi.clearAllMocks();
  currentUserMock.mockResolvedValue(me());
  userUpdateMock.mockResolvedValue({});
  userUpdateManyMock.mockResolvedValue({ count: 1 });
});

describe("saveOwnLlmKey", () => {
  it("encrypts the key and writes it to the CALLER's own row", async () => {
    expect(await saveOwnLlmKey("sk-ant-secret")).toEqual({ ok: true });
    const call = userUpdateMock.mock.calls[0][0];
    // No id parameter exists on this action, so there is no other row to write.
    expect(call.where).toEqual({ id: ME });
    expect(call.data.llmKeyEnc).toMatch(/^v1:/);
    expect(decryptToken(call.data.llmKeyEnc)).toBe("sk-ant-secret");
  });

  it("never writes the plaintext", async () => {
    await saveOwnLlmKey("sk-ant-secret");
    expect(JSON.stringify(userUpdateMock.mock.calls[0][0])).not.toContain(
      "sk-ant-secret",
    );
  });

  it("does not touch aiPolicy, aiQuota or role", async () => {
    // A present key already lifts the cap (consumeUserBreakdown's order), so
    // there is nothing to change - and these are fields the OWNER administers.
    await saveOwnLlmKey("sk-ant-secret");
    const { data } = userUpdateMock.mock.calls[0][0];
    expect(data).not.toHaveProperty("aiPolicy");
    expect(data).not.toHaveProperty("aiQuota");
    expect(data).not.toHaveProperty("role");
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("llmProvider");
  });

  it("trims surrounding whitespace — a pasted key carries it", async () => {
    await saveOwnLlmKey("  sk-ant-secret\n");
    expect(decryptToken(userUpdateMock.mock.calls[0][0].data.llmKeyEnc)).toBe(
      "sk-ant-secret",
    );
  });

  it("rejects an empty key rather than storing an encrypted empty string", async () => {
    // An encrypted "" decrypts to "" which is falsy, so the account would
    // silently fall back to the instance key while the UI said 'key saved'.
    expect(await saveOwnLlmKey("   ")).toEqual({
      ok: false, error: "invalid_key",
    });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects a key longer than any real API key", async () => {
    expect(await saveOwnLlmKey("x".repeat(601))).toEqual({
      ok: false, error: "invalid_key",
    });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects a key containing control characters or newlines", async () => {
    // A header-bound secret with a newline in it is a request-splitting shape.
    expect(await saveOwnLlmKey("sk-ant\nX-Evil: 1")).toEqual({
      ok: false, error: "invalid_key",
    });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("refuses a caller with no signed-in account", async () => {
    currentUserMock.mockResolvedValue(null);
    expect(await saveOwnLlmKey("sk-ant-secret")).toEqual({
      ok: false, error: "not_signed_in",
    });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("reports a row that vanished mid-request rather than throwing", async () => {
    userUpdateMock.mockRejectedValue(
      Object.assign(new Error("nope"), { code: "P2025" }),
    );
    expect(await saveOwnLlmKey("sk-ant-secret")).toEqual({
      ok: false, error: "not_found",
    });
  });
});

describe("removeOwnLlmKey", () => {
  it("nulls the caller's own ciphertext", async () => {
    expect(await removeOwnLlmKey()).toEqual({ ok: true });
    // updateMany, not update: removing a key that is not there must read as
    // success, not as a thrown RecordNotFound.
    expect(userUpdateManyMock).toHaveBeenCalledWith({
      where: { id: ME },
      data: { llmKeyEnc: null },
    });
  });

  it("is idempotent for an account with no key", async () => {
    userUpdateManyMock.mockResolvedValue({ count: 0 });
    expect(await removeOwnLlmKey()).toEqual({ ok: true });
    expect(await removeOwnLlmKey()).toEqual({ ok: true });
  });

  it("refuses a caller with no signed-in account", async () => {
    currentUserMock.mockResolvedValue(null);
    expect(await removeOwnLlmKey()).toEqual({
      ok: false, error: "not_signed_in",
    });
    expect(userUpdateManyMock).not.toHaveBeenCalled();
  });
});

describe("ownLlmKeyPresent", () => {
  it("answers presence WITHOUT selecting the ciphertext", async () => {
    userFindUniqueMock.mockResolvedValue({ id: ME });
    expect(await ownLlmKeyPresent()).toBe(true);
    const { select, where } = userFindUniqueMock.mock.calls[0][0];
    expect(where).toMatchObject({ id: ME });
    // Same rule people.ts follows: never pull a secret into an object graph a
    // component's props are built from. Presence is a where-clause question.
    expect(select).toEqual({ id: true });
    expect(JSON.stringify(select)).not.toContain("llmKeyEnc");
  });

  it("is false for an account with no key and for no account at all", async () => {
    userFindUniqueMock.mockResolvedValue(null);
    expect(await ownLlmKeyPresent()).toBe(false);
    currentUserMock.mockResolvedValue(null);
    expect(await ownLlmKeyPresent()).toBe(false);
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/actions/account.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement the action**

Create `src/app/actions/account.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/workspace";
import { encryptToken } from "@/lib/crypto/token-cipher";

/**
 * #35 Phase C (#118) — the caller's OWN account settings.
 *
 * Phase B built the entire read side of the per-user LLM key: getLLM(creds)
 * takes a per-request credential, user-quota.ts decrypts `llmKeyEnc`, and a
 * present key short-circuits policy and metering. Nothing wrote the column.
 * This is the writer, and it is deliberately the narrowest one possible.
 *
 * Three rules hold it up:
 *
 *  1. NO ID PARAMETER. Every write is `where: { id: me.id }`, resolved from the
 *     session by currentUser(). There is nothing for a caller to point at
 *     somebody else's row — a server action is a public POST endpoint, so this
 *     is the only shape that is safe by construction rather than by review.
 *  2. THE CIPHERTEXT IS NEVER READ BACK. The panel is told a boolean. A "reveal
 *     my key" affordance would put a decrypted secret in an RSC payload for the
 *     convenience of confirming something the user already knows.
 *  3. IT WRITES ONE COLUMN. Not aiPolicy, not aiQuota, not llmProvider, not
 *     role or status. A present key already lifts the cap (see
 *     consumeUserBreakdown's resolution order — "capped until you bring your
 *     key" needs no policy change), and every other field on that list is one
 *     the OWNER administers from the People panel.
 *
 * src/lib/__tests__/scoping.harness.test.ts names this file in
 * KEY_CIPHERTEXT_FILES, which is the review conversation that list exists to
 * force.
 */

export type AccountActionResult =
  | { ok: true }
  | { ok: false; error: "not_signed_in" | "invalid_key" | "not_found" };

/**
 * Longest key we will store. Anthropic and OpenAI-compatible keys are ~100–200
 * characters; 600 is generous headroom. The bound exists so a paste accident
 * cannot put an arbitrary blob through the cipher and into the column.
 */
const MAX_KEY_LENGTH = 600;

/**
 * Control characters, including newlines and tabs. This value ends up in an HTTP
 * Authorization header; a newline in it is a request-splitting shape.
 *
 * Written with explicit `\u` escapes rather than literal control characters: a
 * literal one is invisible in a diff, which is the last property you want in a
 * validation regex. Covers C0 (NUL-US) and DEL.
 */
// eslint-disable-next-line no-control-regex -- deliberate: this IS the check.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

const NOT_SIGNED_IN = { ok: false, error: "not_signed_in" } as const;
const INVALID_KEY = { ok: false, error: "invalid_key" } as const;

export async function saveOwnLlmKey(
  apiKey: string,
): Promise<AccountActionResult> {
  const me = await currentUser();
  if (!me) return NOT_SIGNED_IN;

  // Trimmed because a pasted key carries whitespace, and validated because an
  // encrypted "" decrypts to "" — falsy — so the account would fall silently
  // back onto the instance key while the UI reported a saved key.
  const key = apiKey.trim();
  if (!key || key.length > MAX_KEY_LENGTH || CONTROL_CHARS.test(key)) {
    return INVALID_KEY;
  }

  try {
    await prisma.user.update({
      where: { id: me.id },
      data: { llmKeyEnc: encryptToken(key) },
    });
  } catch (err) {
    // P2025 = the row is gone (account deleted mid-request). Reported, not
    // thrown: the caller holds a verified session, so this is a real state.
    if ((err as { code?: string }).code === "P2025") {
      return { ok: false, error: "not_found" };
    }
    throw err;
  }

  revalidatePath("/settings");
  return { ok: true };
}

export async function removeOwnLlmKey(): Promise<AccountActionResult> {
  const me = await currentUser();
  if (!me) return NOT_SIGNED_IN;
  // updateMany, not update: removing a key that is not there is a no-op the
  // user should experience as success, not as a thrown RecordNotFound.
  await prisma.user.updateMany({
    where: { id: me.id },
    data: { llmKeyEnc: null },
  });
  revalidatePath("/settings");
  return { ok: true };
}

/**
 * Does the caller have their own key? Presence only.
 *
 * `select: { id: true }` with the presence test in the WHERE clause, exactly as
 * src/lib/people.ts:116 does it — `select: { llmKeyEnc: true }` would pull an
 * encrypted secret into the object graph a component's props are built from,
 * one careless spread away from the client.
 */
export async function ownLlmKeyPresent(): Promise<boolean> {
  const me = await currentUser();
  if (!me) return false;
  const row = await prisma.user.findUnique({
    where: { id: me.id, llmKeyEnc: { not: null } },
    select: { id: true },
  });
  return row != null;
}
```

If Prisma's `findUnique` rejects the extra `llmKeyEnc` filter in `where` (it accepts non-unique filters alongside a unique field, but check the generated types), use `findFirst` with the same `where` and `select` — the id is unique either way, and the harness rule for `llmKeyEnc` cares about the *file*, not the operation.

- [x] **Step 4: Register the file in the harness**

`src/lib/__tests__/scoping.harness.test.ts:236-241` — its comment already says Phase C's key UI belongs here:

```ts
  const KEY_CIPHERTEXT_FILES: Record<string, string> = {
    "src/lib/user-quota.ts":
      "decrypts it to bill the request to the user's own key",
    "src/lib/people.ts":
      "presence only — `{ llmKeyEnc: { not: null } }`, selecting ids",
    // #118 Phase C — the writer. Encrypts and stores the CALLER's own key
    // (`where: { id: me.id }`, no id parameter exists) and answers presence with
    // the same where-clause trick people.ts uses. It never reads the ciphertext
    // back: the panel is told a boolean, so no decrypted secret can reach an RSC
    // payload.
    "src/app/actions/account.ts":
      "writes the caller's own key, encrypted; presence-only read, never selected",
  };
```

Add a matching entry to the harness's existing "exists where this test thinks it does" guard so a rename cannot turn the rule into a test that reads no files.

- [x] **Step 5: Run action tests + harness**

```bash
npx vitest run src/app/actions/account.test.ts src/lib/__tests__/scoping.harness.test.ts
```

Expected: PASS. If the harness reports `src/app/actions/account.ts` as an offender, the `KEY_CIPHERTEXT_FILES` key does not match the path `sourceFiles()` produces — it joins with `path.join("src", f)`, so the key must be exactly `src/app/actions/account.ts`.

- [x] **Step 6: Write the failing tests for the panel**

Create `src/components/settings/account-panel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

const { saveMock, removeMock, refreshMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  removeMock: vi.fn(),
  refreshMock: vi.fn(),
}));
vi.mock("@/app/actions/account", () => ({
  saveOwnLlmKey: saveMock,
  removeOwnLlmKey: removeMock,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

import { AccountPanel } from "./account-panel";

beforeEach(() => {
  vi.clearAllMocks();
  saveMock.mockResolvedValue({ ok: true });
  removeMock.mockResolvedValue({ ok: true });
});

const props = {
  handle: "alice",
  provider: "gitlab",
  keyPresent: false,
  activeModelName: "claude-sonnet-4-6",
  defaultExpanded: true,
} as const;

describe("AccountPanel", () => {
  it("names the signed-in account and the provider that authenticated it", () => {
    render(<AccountPanel {...props} />);
    expect(screen.getByText(/alice/)).toBeInTheDocument();
    expect(screen.getByText(/gitlab/i)).toBeInTheDocument();
  });

  it("labels the key field and masks what is typed", async () => {
    render(<AccountPanel {...props} />);
    const field = screen.getByLabelText(/api key/i);
    expect(field).toHaveAttribute("type", "password");
    // Off, all of it: a secret must not land in a browser's autofill store or
    // be corrected into something else.
    expect(field).toHaveAttribute("autoComplete", "off");
    expect(field).toHaveAttribute("spellCheck", "false");
    await userEvent.type(field, "sk-ant-secret");
    expect(field).toHaveValue("sk-ant-secret");
  });

  it("saves the key and clears the field afterwards", async () => {
    render(<AccountPanel {...props} />);
    await userEvent.type(screen.getByLabelText(/api key/i), "sk-ant-secret");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(saveMock).toHaveBeenCalledWith("sk-ant-secret");
    // Leaving a secret in a mounted input is a shoulder-surfing and
    // screenshot problem for no benefit — it is stored, not editable.
    expect(screen.getByLabelText(/api key/i)).toHaveValue("");
  });

  it("announces success without ever echoing the key", async () => {
    render(<AccountPanel {...props} />);
    await userEvent.type(screen.getByLabelText(/api key/i), "sk-ant-secret");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/saved/i);
    expect(status).not.toHaveTextContent("sk-ant-secret");
  });

  it("reports a rejected key in the same place, and keeps what was typed", async () => {
    saveMock.mockResolvedValue({ ok: false, error: "invalid_key" });
    render(<AccountPanel {...props} />);
    await userEvent.type(screen.getByLabelText(/api key/i), "  ");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/not.*accepted|invalid/i);
    // Not cleared on failure — clearing a rejected value forces a re-paste.
    expect(screen.getByLabelText(/api key/i)).toHaveValue("  ");
  });

  it("shows a key is stored WITHOUT showing any part of it", () => {
    render(<AccountPanel {...props} keyPresent />);
    expect(screen.getByText(/your own key is in use/i)).toBeInTheDocument();
    expect(screen.queryByText(/sk-/)).toBeNull();
  });

  it("confirms before removing a stored key", async () => {
    render(<AccountPanel {...props} keyPresent />);
    await userEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(removeMock).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(/instance/i);
    await userEvent.click(screen.getByRole("button", { name: /yes, remove/i }));
    expect(removeMock).toHaveBeenCalled();
  });

  it("offers no Remove control when there is no key", () => {
    render(<AccountPanel {...props} />);
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("has no axe violations in either state", async () => {
    for (const keyPresent of [false, true]) {
      const { container, unmount } = render(
        <AccountPanel {...props} keyPresent={keyPresent} />,
      );
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });

  it("is fully operable from the keyboard", async () => {
    render(<AccountPanel {...props} />);
    await userEvent.tab();
    await userEvent.keyboard("sk-ant-secret");
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(saveMock).toHaveBeenCalledWith("sk-ant-secret");
  });
});
```

- [x] **Step 7: Run to verify they fail, then implement the panel**

Run: `npx vitest run src/components/settings/account-panel.test.tsx` → FAIL, module not found.

Create `src/components/settings/account-panel.tsx`. Copy the shape of `src/components/settings/breakdown-model-section.tsx` — `"use client"`, `useState` + `useTransition`, `useRouter().refresh()` after a write, wrapped in `<CollapsibleSection id="settings-account">`. Requirements the tests above pin down:

- Props: `{ handle: string | null; provider: string; keyPresent: boolean; activeModelName: string; voice?: Voice; defaultExpanded?: boolean }`. **No key, no ciphertext, no policy, no quota** — the panel is told a boolean.
- Identity line naming the handle **and** the provider that authenticated the session. `#74` requires the provider to be stated wherever identity is shown, and `CurrentUser.provider` carries it for exactly this reason (it is the provider the account was *provisioned* under, not the current `AUTH_PROVIDER`).
- A `<input type="password">` labelled **API key**, with `autoComplete="off"`, `spellCheck={false}`, and `touchTarget` on the Save button.
- One `role="status"` region for every outcome — saved, removed, rejected. `aria-live` polite; it changes on submit, not on keystroke.
- The field is cleared on success and **kept** on failure.
- When `keyPresent`, a plain sentence that the account is using its own key plus a two-step **Remove** (confirm, then *"Yes, remove"*), mirroring the Disconnect confirmation in `integrations-panel.tsx`. State in the confirmation what happens next: *"AI will go back to this instance's key and its usage limits."*
- Copy must explain the consequence, because it is the one thing a user cannot discover: **a stored key is used for that account's breakdowns instead of the instance's, and its usage is not counted against a cap.** That is `consumeUserBreakdown`'s rule 1 in plain words.
- Explicitly **no** provider or base-URL field. `LLMCredentials` has no `baseUrl` on purpose — "letting a per-user value choose the endpoint would turn a settings field into an SSRF primitive" (`src/lib/llm/types.ts`). A user's key is for the instance's configured provider; show `activeModelName` read-only so they know which.
- Add the new copy to `src/lib/strings.ts` in both voices, next to the existing `settings.*` keys.

- [x] **Step 8: Wire it into the page**

`src/lib/section-nav.ts` — add one entry to `SETTINGS_SECTIONS`, **before** `settings-people` (administration stays last) and after `settings-integrations`:

```ts
  { id: "settings-account", heading: { text: "Account" } },
```

`src/app/(app)/settings/page.tsx` — add `ownLlmKeyPresent()` to the second `Promise.all` and render the section only for a signed-in account:

```tsx
      {me && (
        <div className="border-t pt-4">
          <AccountPanel
            handle={me.handle}
            provider={me.provider}
            keyPresent={keyPresent}
            activeModelName={resolveUtilityModel()}
            voice={voice}
          />
        </div>
      )}
```

Filter `settings-account` out of `sections` when `me` is null, exactly as `settings-people` is filtered — `src/app/(app)/settings/page.test.tsx` locks the section order, so update that expectation too.

- [x] **Step 9: Run everything**

```bash
npx vitest run src/components/settings src/app/actions/account.test.ts \
  "src/app/(app)/settings" src/lib/__tests__/scoping.harness.test.ts
npm test && npx tsc --noEmit && npm run lint && npm run format:check
```

- [x] **Step 10: Commit**

```bash
git add src/app/actions/account.ts src/app/actions/account.test.ts \
  src/components/settings/account-panel.tsx \
  src/components/settings/account-panel.test.tsx \
  "src/app/(app)/settings/page.tsx" "src/app/(app)/settings/page.test.tsx" \
  src/lib/section-nav.ts src/lib/strings.ts \
  src/lib/__tests__/scoping.harness.test.ts
git commit -m "feat(settings): a member brings their own LLM key (#118)

Phase B built the entire read side - getLLM(creds) takes a per-request
credential, user-quota.ts decrypts llmKeyEnc, and a present key short-circuits
both policy and metering. Nothing in the repo wrote the column. This is the
writer, and it is the narrowest one that can work.

No id parameter exists on either action: every write is where: { id: me.id }
resolved from the session, because a server action is a public POST endpoint and
'we always pass the right id' is a review promise, not a guarantee. The
ciphertext is never read back - the panel is told a boolean, and presence is
answered by a where-clause exactly as people.ts does it, so no decrypted secret
can reach an RSC payload. And it writes ONE column: a present key already lifts
the cap (consumeUserBreakdown's resolution order), and aiPolicy/aiQuota are
fields the owner administers.

No provider or base-URL field, deliberately. LLMCredentials has no baseUrl
because a per-user endpoint is an SSRF primitive; a user's key is for the
instance's configured provider, and the panel shows which one read-only.

Registered in the scoping harness's KEY_CIPHERTEXT_FILES, whose comment asked
for exactly this entry - which is the review conversation that list exists to
force.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: A member stops resolving to the guest model tier (#96)

**Files:**
- Modify: `src/lib/models.ts`
- Modify: `src/lib/models.test.ts` (find it: `grep -rln "resolveBreakdownModel" src/`)
- Modify: `src/app/api/breakdown/route.ts` (`:211-214`, and the `owner ? getSettings(wsId) : null` at `:207`)
- Modify: `src/app/api/breakdown/route.test.ts`

**Interfaces:**
- Changes:
  ```ts
  export type ModelTier = "owner" | "member" | "guest";
  export function resolveBreakdownModel(opts: {
    tier: ModelTier;
    ownerSetting?: string | null;
    hasOwnKey?: boolean;
  }): string;
  ```
  `{ isOwner: boolean }` is **replaced**, not kept alongside. A boolean is what let accounts silently inherit the guest tier; leaving it callable invites the same bug from the next role.

`resolveBreakdownModel` only knows owner-vs-not. Before accounts that was a true binary. An invited `member` is now a third thing and lands in the `!isOwner` branch, so every member gets Haiku — the tier chosen as a **guest cost lever** — including a member **paying for their own API calls**. Nothing is insecure; it is a quality-of-service bug that bites the first time somebody is invited.

- [x] **Step 1: Write the failing tests**

Add to `src/lib/models.test.ts` (read its existing env-stubbing style first — these functions read `process.env` on every call):

```ts
describe("resolveBreakdownModel — tiers, not a boolean (#96)", () => {
  it("a guest still gets the cheap tier — the cost lever must survive", () => {
    expect(resolveBreakdownModel({ tier: "guest" })).toBe("claude-haiku-4-5");
  });

  it("a guest still honours GUEST_BREAKDOWN_MODEL", () => {
    process.env.GUEST_BREAKDOWN_MODEL = "claude-haiku-4-5";
    expect(resolveBreakdownModel({ tier: "guest" })).toBe("claude-haiku-4-5");
  });

  it("a member with their OWN key gets the owner-grade tier — they are paying", () => {
    // Handing the cheapest model to someone billed for their own usage is the
    // wrong way round, and it is the sharp end of #96.
    expect(
      resolveBreakdownModel({ tier: "member", hasOwnKey: true }),
    ).toBe("claude-sonnet-4-6");
  });

  it("a member with their own key ignores GUEST_BREAKDOWN_MODEL entirely", () => {
    process.env.GUEST_BREAKDOWN_MODEL = "claude-haiku-4-5";
    expect(
      resolveBreakdownModel({ tier: "member", hasOwnKey: true }),
    ).not.toBe("claude-haiku-4-5");
  });

  it("a member on the instance key follows the owner's configured tier", () => {
    // A member on the instance key is the owner's cost decision, and the owner
    // already has a control for it. It is NOT the guest lever.
    expect(
      resolveBreakdownModel({ tier: "member", ownerSetting: "claude-opus-4-8" }),
    ).toBe("claude-opus-4-8");
  });

  it("the owner is unchanged: their setting wins, then env, then the default", () => {
    expect(
      resolveBreakdownModel({ tier: "owner", ownerSetting: "claude-opus-4-8" }),
    ).toBe("claude-opus-4-8");
    process.env.OWNER_BREAKDOWN_MODEL = "claude-haiku-4-5";
    expect(resolveBreakdownModel({ tier: "owner" })).toBe("claude-haiku-4-5");
    delete process.env.OWNER_BREAKDOWN_MODEL;
    expect(resolveBreakdownModel({ tier: "owner" })).toBe("claude-sonnet-4-6");
  });

  it("ignores an un-allowlisted ownerSetting for every tier", () => {
    for (const tier of ["owner", "member"] as const) {
      expect(
        resolveBreakdownModel({ tier, ownerSetting: "gpt-cheapest" }),
      ).toBe("claude-sonnet-4-6");
    }
  });

  it("openai-compatible: only a guest gets LLM_GUEST_MODEL", () => {
    process.env.LLM_PROVIDER = "openai-compatible";
    process.env.LLM_MODEL = "local-base";
    process.env.LLM_GUEST_MODEL = "local-tiny";
    process.env.LLM_OWNER_MODEL = "local-big";
    expect(resolveBreakdownModel({ tier: "guest" })).toBe("local-tiny");
    expect(resolveBreakdownModel({ tier: "member" })).toBe("local-big");
    expect(resolveBreakdownModel({ tier: "owner" })).toBe("local-big");
  });
});
```

And in `src/app/api/breakdown/route.test.ts`:

```ts
  it("passes the member tier, not isOwner:false, and reads their key state (#96)", async () => {
    // …arrange a signed-in member with own_key…
    expect(resolveBreakdownModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "member", hasOwnKey: true }),
    );
  });

  it("gives a member a model preference to read at all", async () => {
    // getSettings was gated on `owner`, so a member had no ownerSetting to
    // follow even once the tier existed.
    expect(getSettingsMock).toHaveBeenCalled();
  });
```

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/models.test.ts src/app/api/breakdown/route.test.ts`
Expected: FAIL — `tier` is not a parameter.

- [x] **Step 3: Implement**

`src/lib/models.ts`:

```ts
/**
 * Which model tier serves this request.
 *
 * #96 — this was `{ isOwner: boolean }`. Before accounts that was a true binary:
 * you were the owner or you were a guest, so "not the owner" meaning "cheapest
 * tier" was correct. An invited member is a third thing, and it landed in the
 * guest branch — so every member got Haiku, the tier chosen as a GUEST COST
 * LEVER, including a member paying for their own API calls. A named tier is what
 * stops the next role inheriting the same default silently.
 */
export type ModelTier = "owner" | "member" | "guest";

function resolveAnthropicModel(opts: {
  tier: ModelTier;
  ownerSetting?: string | null;
  hasOwnKey?: boolean;
}): string {
  // A guest is the only tier the cost lever applies to.
  if (opts.tier === "guest") {
    return process.env.GUEST_BREAKDOWN_MODEL || GUEST_BREAKDOWN_MODEL_DEFAULT;
  }
  // A member paying with their own key gets the owner-grade default rather than
  // whatever the owner set for instance-funded work — it is not the owner's
  // spend to economise on. Their own explicit preference, if the settings UI
  // ever grows one, would slot in here.
  if (opts.tier === "member" && opts.hasOwnKey) {
    return OWNER_BREAKDOWN_MODEL_DEFAULT;
  }
  if (isAllowlisted(opts.ownerSetting)) return opts.ownerSetting as string;
  const envDefault = process.env.OWNER_BREAKDOWN_MODEL;
  if (isAllowlisted(envDefault)) return envDefault as string;
  return OWNER_BREAKDOWN_MODEL_DEFAULT;
}

function resolveOpenAICompatibleModel(opts: { tier: ModelTier }): string {
  const split =
    opts.tier === "guest"
      ? process.env.LLM_GUEST_MODEL
      : process.env.LLM_OWNER_MODEL;
  // … unchanged from here …
}

export function resolveBreakdownModel(opts: {
  tier: ModelTier;
  ownerSetting?: string | null;
  hasOwnKey?: boolean;
}): string { /* dispatch unchanged */ }
```

`resolveUtilityModel()` calls `resolveOpenAICompatibleModel({ isOwner: true })` at `:119` — change to `{ tier: "owner" }`. Its doc comment ("guests never reach any of these") stays true.

`src/app/api/breakdown/route.ts` — extend the existing `@/lib/models` import at `:20` to `import { resolveBreakdownModel, breakdownParamsFor, type ModelTier } from "@/lib/models";`, then:

```ts
  // #96 — a NAMED tier. `owner` is still the owner; a signed-in member is a
  // member, not a not-owner; anyone else is a guest.
  const tier: ModelTier = owner ? "owner" : user ? "member" : "guest";
  const [settings, breakdownContext] = await Promise.all([
    // #96 — a member gets a model preference to read. This was gated on `owner`,
    // so even with the tier fixed a member had no ownerSetting to follow. It is
    // the OWNER's Settings row either way — wsId is the requester's own
    // workspace, and a member's row is theirs. Guests keep null.
    user ? getSettings(wsId) : Promise.resolve(null),
    /* unchanged */
  ]);
  const model = resolveBreakdownModel({
    tier,
    ownerSetting: settings?.breakdownModel ?? null,
    // `access.ownKey` is the DECRYPTED credential — this passes only whether one
    // exists. The key itself never leaves llmCredentials.
    hasOwnKey: llmCredentials != null,
  });
```

Check the `owner` and `user` locals' names against the real file before writing this — `grep -n "const owner\|const user" src/app/api/breakdown/route.ts`.

- [x] **Step 4: Run the tests and the whole suite**

```bash
npx vitest run src/lib/models.test.ts src/app/api/breakdown/route.test.ts
npm test && npx tsc --noEmit
```

`tsc` will point at every remaining `{ isOwner: ... }` call site — that is the point of replacing the parameter rather than adding to it.

- [x] **Step 5: Commit**

```bash
git add src/lib/models.ts src/lib/models.test.ts src/app/api/breakdown/route.ts \
  src/app/api/breakdown/route.test.ts
git commit -m "fix(ai): a member is not a guest for model selection (#96)

resolveBreakdownModel took { isOwner: boolean }. Before accounts that was a true
binary - owner or guest - so 'not the owner' meaning 'cheapest tier' was
correct. An invited member is a third thing and landed in the guest branch, so
every member got Haiku: the tier chosen as a GUEST COST LEVER. Including a
member on their own key, billed for their own usage and handed the cheapest
model anyway, which is the wrong way round.

Replaced by a named tier rather than extended, so the next role cannot silently
inherit the guest default. The boolean is gone, which makes tsc enumerate the
call sites instead of leaving one behind.

A member with their own key gets the owner-grade default: it is not the owner's
spend to economise on. A member on the instance key follows the owner's
configured tier, which is the owner's cost decision and already has a control.
A guest still gets GUEST_BREAKDOWN_MODEL - the cost lever survives, asserted.

getSettings was also gated on `owner` in the same route, so a member had no
model preference to read even once the tier existed. Fixed with it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Prove it in a production build, and write down what the console needs

**Files:**
- Modify: `e2e/constants.ts`, `e2e/global-setup.ts`, `playwright.config.ts`
- Create: `e2e/smoke/member-google.spec.ts`
- Modify: `e2e/smoke/schedule-ics.spec.ts` (comment only), `e2e/smoke/row-menu-viewport-fit.spec.ts` (comment only), `e2e/a11y-contrast.spec.ts` (comment only)
- Modify: the self-hosting docs (`grep -rln "GOOGLE_CLIENT_ID" docs/ README.md`)

**Which E2E specs change, and which deliberately do not.**

| Spec | Change | Why |
|---|---|---|
| `e2e/smoke/schedule-ics.spec.ts` | **Comment only.** | Its preamble at `:8-11` asserts in prose *"there is no GOOGLE_CLIENT_ID and no `GoogleAuth` row, so `scheduleState` resolves every Google control to `connect`"*. The first half stays true — the new fixture is a **second Playwright project** with its own env, so the default project still boots with no Google client. Reword `:8-13` to say which project it runs in and stop claiming the *instance* has no row. Do **not** change its assertions. |
| `e2e/smoke/row-menu-viewport-fit.spec.ts` | **Comment only.** | `:311-316` says the 📅 duration popover "for the OWNER only appears with Google connected, which this environment has no way to be". That is now false in the new project and still true in the default one. State which. |
| `e2e/a11y-contrast.spec.ts` | **Comment only.** | `:383-394` documents the Disconnect confirm CTA as unreachable because `google.configured` is always false. The new project makes it reachable — say so and point at the new spec, which scans it. |
| `e2e/smoke/guest-unaffected.spec.ts` | **No change.** | It runs with no cookies. Phase C gives guests nothing, so it must keep passing untouched — that is its value here. |
| `e2e/a11y/axe-guest-surfaces.spec.ts` | **No change.** | Guest surfaces are unchanged by design. If it fails, Task 5 or 6 leaked something into a guest render. |
| `e2e/smoke/people-admin.spec.ts` | **No change** unless it asserts the "own key" column. Check: Task 7 makes that column reachable, so a spec that asserted "nobody has a key" may need the connected-member fixture's key state accounted for. |
| `e2e/smoke/member-google.spec.ts` | **New.** | The member path in a production build. |
| `e2e/smoke/settings-disclosure.spec.ts` | **Check.** Task 7 adds a section to `SETTINGS_SECTIONS`; if this spec counts disclosures or asserts the nav's entries, it needs the new one. |

**Why a second Playwright project rather than a global env flag.** Setting `GOOGLE_CLIENT_ID` in `bootGuardEnv` would flip the 📅 control's label from *"Add to calendar (.ics)"* to *"Schedule"* for **every** existing spec, and `schedule-ics.spec.ts` depends on that label to find the `.ics` entry in the ▾ menu. A second project with its own `webServer` keeps the default suite's behaviour byte-identical.

- [ ] **Step 1: Add the connected-member fixture**

`e2e/constants.ts` — the member needs their own storage state and a stable id for the credential row:

```ts
/**
 * #118 Phase C — the member fixture becomes a CONNECTED member.
 *
 * Phase B seeded MEMBER_USER_ID so the People panel had a row that is not the
 * owner's. Phase C needs the same account signed IN, with its own GoogleAuth
 * row, because "a member uses their own connection" is the whole feature and the
 * owner's session cannot exercise it.
 */
export const MEMBER_STORAGE_STATE = "playwright/.auth/member.json";

/** A fake but well-formed encrypted access token for the member's credential.
 *  Produced by encryptToken() in global-setup with the same TOKEN_ENC_KEY the
 *  server under test uses — a hand-written string would decrypt to null and the
 *  status would read "reconnect needed", which is not the state we want to test. */
export const MEMBER_GOOGLE_ACCESS_TOKEN = "e2e-member-google-access-token";
```

`e2e/global-setup.ts` — after the existing member upserts, seed the credential and mint the member's cookie. **Encrypt with the app's own cipher** so the server can read it:

```ts
import { encryptToken } from "../src/lib/crypto/token-cipher";

    // #118 — the member's OWN Google credential. Encrypted with the app's own
    // token-cipher against the same TOKEN_ENC_KEY playwright.config.ts hands the
    // server, so `connected` is true rather than "present but undecryptable".
    // No refresh token and no expiry: the specs read status and open controls,
    // they never push, so nothing ever calls Google. An expiry in the past would
    // trigger the refresh path and a real network call.
    await prisma.googleAuth.upsert({
      where: { userId: MEMBER_USER_ID },
      create: {
        userId: MEMBER_USER_ID,
        accessToken: encryptToken(MEMBER_GOOGLE_ACCESS_TOKEN),
        expiresAt: null,
        scope: "https://www.googleapis.com/auth/tasks",
        needsReconnect: false,
      },
      update: {
        accessToken: encryptToken(MEMBER_GOOGLE_ACCESS_TOKEN),
        refreshToken: null,
        expiresAt: null,
        needsReconnect: false,
      },
    });
```

and a second storage state, mirroring the owner block at `:112-133`:

```ts
  const memberToken = await signUserSession(
    { kind: "user", userId: MEMBER_USER_ID, wsId: MEMBER_WS_ID },
    SESSION_SECRET,
  );
  // …newContext / addCookies / storageState({ path: MEMBER_STORAGE_STATE })…
```

`TOKEN_ENC_KEY` must be identical in `global-setup` and in the server's env. `bootGuardEnv` already pins it (`playwright.config.ts:99-100`); `global-setup` runs in a different process, so **read it from the same place** rather than restating the literal — export it from `e2e/constants.ts` and have `bootGuardEnv` use that export. If the two ever drift, the ciphertext decrypts to null and the member reads "reconnect needed" — a silent, confusing failure. Assert it in `global-setup` before seeding:

```ts
  if (!process.env.TOKEN_ENC_KEY) process.env.TOKEN_ENC_KEY = TOKEN_ENC_KEY;
```

`playwright.config.ts` — a `member-google` project with the extra env and the member's storage state:

```ts
  {
    name: "member-google",
    testMatch: /member-google\.spec\.ts/,
    use: { ...devices["Desktop Chrome"], storageState: MEMBER_STORAGE_STATE },
  },
```

and its own `webServer` entry (or extend the existing one) carrying:

```ts
      // #118 — makes the Google Tasks method OFFERED so a member's own control
      // is reachable. Deliberately not a working credential: the spec reads
      // status and opens controls, and never pushes, so no request leaves the
      // machine. Scoped to this project so every other spec's 📅 label is
      // unchanged — schedule-ics.spec.ts finds the .ics entry by that label.
      GOOGLE_CLIENT_ID: "e2e-google-client-id",
      GOOGLE_CLIENT_SECRET: "e2e-google-client-secret",
```

Playwright's `webServer` is global, not per-project. If two servers on two ports is more machinery than this is worth, the acceptable alternative is **one** server with the Google env set plus a `testIgnore`-free audit of the label-dependent specs — but then `schedule-ics.spec.ts` and `row-menu-viewport-fit.spec.ts` must be updated to pin `.ics` explicitly, and the MR must say which specs changed and why. **Try two ports first**; fall back only if the config fights you, and record the decision in the MR either way.

- [ ] **Step 2: Write the spec**

Create `e2e/smoke/member-google.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { captureItem, needsReviewRow, MOBILE } from "../helpers";

/**
 * #118 Phase C — an invited MEMBER, signed in, with their own Google connection,
 * in a production build.
 *
 * This is the claim the whole phase makes, and it is not testable from the
 * owner's session: before Phase C a member got `google = null`, the .ics
 * fallback, and a 🔒 owner-only shell in Settings. Every assertion below was
 * false a commit ago.
 *
 * Nothing here pushes to Google. The credential is a dummy, so a push would make
 * a real request with a token Google will reject; the spec reads status and
 * opens controls instead.
 */

test("a member's Settings shows THEIR OWN Google connection, not a locked shell", async ({
  page,
}) => {
  await page.goto("/settings");

  const integrations = page.locator("#settings-integrations");
  await expect(integrations).toBeVisible();
  // The 🔒 shell is what a member used to get. Its absence is the fix.
  await expect(integrations.getByText(/owner-only/i)).toHaveCount(0);
  await expect(integrations.getByText("Connected")).toBeVisible();
  await expect(
    integrations.getByRole("button", { name: /disconnect/i }),
  ).toBeVisible();
});

test("a member's Account section offers a key field and never echoes one", async ({
  page,
}) => {
  await page.goto("/settings");
  const account = page.locator("#settings-account");
  await expect(account).toBeVisible();
  const field = account.getByLabel(/api key/i);
  await expect(field).toHaveAttribute("type", "password");
  await field.fill("sk-e2e-not-a-real-key");
  await account.getByRole("button", { name: /save/i }).click();
  // Cleared, and the value is nowhere in the rendered page.
  await expect(field).toHaveValue("");
  await expect(page.getByText("sk-e2e-not-a-real-key")).toHaveCount(0);
  // Clean up so the next run starts without a key.
  await account.getByRole("button", { name: /remove/i }).click();
  await account.getByRole("button", { name: /yes, remove/i }).click();
});

test("a member's inbox 📅 leads with Google, not the .ics fallback", async ({
  page,
}) => {
  const label = `E2E member ${Date.now()}`;
  await page.goto("/");
  await captureItem(page, label);
  const row = needsReviewRow(page, label);
  await expect(row).toBeVisible();
  // Before #118 this row showed "Add to calendar (.ics)" for a member.
  await expect(row.getByRole("button", { name: "Schedule" })).toBeVisible();
});

test("the disconnect confirmation is reachable and reads correctly at 390px", async ({
  page,
}) => {
  // e2e/a11y-contrast.spec.ts documented this control as unreachable because no
  // environment could have Google connected. This one can.
  await page.setViewportSize(MOBILE);
  await page.goto("/settings");
  const integrations = page.locator("#settings-integrations");
  await integrations.getByRole("button", { name: /^disconnect$/i }).click();
  await expect(integrations.getByRole("status")).toContainText(
    /remove access/i,
  );
  const confirm = integrations.getByRole("button", { name: /yes, disconnect/i });
  await expect(confirm).toBeVisible();
  const box = await confirm.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  // Do NOT confirm: the fixture's connection is re-asserted per run by
  // global-setup, but leaving it connected keeps the specs above order-independent.
  await integrations.getByRole("button", { name: /^cancel$/i }).click();
});
```

- [ ] **Step 3: Run the full E2E suite, both projects**

```bash
npm run build && npm run test:e2e
```

Expected: all green. If a **pre-existing** spec fails because a 📅 label changed, the Google env leaked out of the `member-google` project — fix the config, not the spec. If a spec fails because a section was added to `/settings`, update that spec's expectation and say so in the MR.

- [ ] **Step 4: Write down what the Google Cloud console needs**

The app requests `https://www.googleapis.com/auth/tasks` (`src/lib/google.ts:12`), which Google classifies as **sensitive**. Two console states produce failures that look exactly like bugs in our refresh code. Add to the self-hosting docs (find the file: `grep -rln "GOOGLE_CLIENT_ID" docs/ README.md`):

```markdown
### Google Tasks: publish your OAuth consent screen

The Google Tasks scope (`.../auth/tasks`) is **sensitive**, and two consent-screen
states break sync in ways that look like application bugs:

| Console state | What your users see |
|---|---|
| Consent screen in **Testing**, user type External | Connecting works, then sync dies **about seven days later**: Google expires refresh tokens for testing apps after 7 days. `GoogleAuth.needsReconnect` starts firing and it reads exactly like a token-refresh bug in the app. |
| **Production** but unverified, on a sensitive scope | An *"Google hasn't verified this app"* interstitial before consent, and a hard cap of **100 users**. Not a blocker at small scale, but it is an alarming screen to hand somebody you just invited. |

**Publish the consent screen** before inviting anyone. Verification is only
needed above 100 users. This is a console setting; nothing in `src/lib/google.ts`
can work around it.
```

Then add a line to the MR description flagging the **post-deploy verification**: connect Google with a real non-owner allowlisted account and check back after **7+ days** that sync still works. If it breaks on roughly that schedule, the fix is in the console, not in the code.

- [ ] **Step 5: Run every gate**

```bash
npm test
npx tsc --noEmit
npm run lint
npm run format:check
npm run build && npm run test:e2e
```

Expected: all green. Pre-existing `.next/` validator errors from a stale build are pre-existing.

- [ ] **Step 6: Screenshot the member's `/settings` in both themes, at 390px and desktop**

Save to `/Users/gitlab_dlectronique/workdev/118-member-shots/` and attach to #118. The owner reviews visual work by eye; a green suite is not the same evidence. Include: the member's Integrations panel connected, the Account section empty and with a key stored, and the disconnect confirmation at 390px.

- [ ] **Step 7: Commit and open the MR**

```bash
git add e2e playwright.config.ts docs README.md
git commit -m "test(e2e): a connected member, in a production build (#118)

Every E2E spec assumed Google was unconfigured - schedule-ics.spec.ts asserts it
in prose - so the member path this phase exists for had no production-build
coverage at all. A second Playwright project supplies a dummy Google client and
the member's own signed session plus a seeded, properly-encrypted credential
row; the default project's env is untouched, because setting GOOGLE_CLIENT_ID
globally flips the 📅 control's label and schedule-ics.spec.ts finds the .ics
entry by that label.

The credential is encrypted with the app's own token-cipher against the same
TOKEN_ENC_KEY the server gets, not a hand-written string: an undecryptable
ciphertext would read as 'reconnect needed' and quietly test the wrong state.
No spec pushes, so no request leaves the machine.

It also reaches a control two existing specs documented as unreachable - the
disconnect confirmation, whose destructive token pairing a11y-contrast.spec.ts
could only reason about by analogy.

Docs: publish your OAuth consent screen. A Testing-state screen expires external
refresh tokens after 7 days, so sync dies a week after each member connects and
looks exactly like a bug in our refresh code. Console setting, no code can work
around it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin HEAD
```

MR: `--reviewer GitLabDuo --milestone v0.5.0 --assignee gitlab_dlectronique`, description containing `Closes #118` and `Closes #96`, ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. **Not** `--fill` — it copies the commit body and drags the `Co-Authored-By` trailer into the description.

The description must state:
1. **The owner must reconnect Google once after this deploys.** The migration destroys the orphan credential; that is the accepted cost.
2. The **7-day consent-screen check** (Step 4) as an open post-deploy verification.
3. That `userId` stays nullable and why, with the `SET NOT NULL` follow-up.
4. Which E2E project arrangement was chosen (two ports, or one server plus label pins) and why.

---

## Final verification

- [ ] `npm test` green, count up
- [ ] `npx tsc --noEmit` clean
- [ ] `npm run lint`, `npm run format:check` clean
- [ ] `npm run build && npm run test:e2e` green — **both** Playwright projects
- [ ] `src/lib/__tests__/scoping.harness.test.ts` green, and its user-scope offender list empty
- [ ] `src/lib/enum-constraint-sync.integration.test.ts` green — it fails loudly if `User_llmProvider_check` and the `REGISTRY` disagree
- [ ] Migration applied cleanly; `src/lib/google-auth-orphan.integration.test.ts` green
- [ ] `grep -rn "SINGLETON_ID" src/` returns nothing but comments
- [ ] `grep -rn "isGuest" src/components/breakdown/` returns nothing
- [ ] `grep -rn "isOwner:" src/lib/models.ts src/app/api/breakdown/route.ts` returns nothing
- [ ] axe clean on both Integrations presentations and both Account states (asserted in the component tests, not eyeballed)
- [ ] Screenshots attached to #118
- [ ] #118 and #96 status set to **Done**; MR open with @GitLabDuo as reviewer, **not merged**

## Post-deploy (release steps, not code)

- [ ] **The owner reconnects Google.** `/settings` → Integrations → *Connect Google →*. The orphan credential was destroyed by the migration; nothing is wrong.
- [ ] Confirm the migration's `NOTICE` in the deploy log names the purged row count. If it says `0`, either the row was already gone or the migration ran against the wrong database — check before assuming the former.
- [ ] Connect Google as a **real non-owner allowlisted member** and re-check **7+ days later**. A failure on roughly that schedule is the Testing-state consent screen, not `src/lib/google.ts`.

## Spec-coverage map (self-review)

| #118 scope item | Task |
|---|---|
| Bind the write path; delete `SINGLETON_ID` | 2 |
| Scope every read path through `getAuth` | 2 |
| Move `/api/google/oauth/*` to `AUTHENTICATED_PREFIXES` + middleware test per category | 4 |
| Drop the four owner gates on use; `isAvailable` loses `isOwner` | 4 |
| Stop discarding status for members | 5 |
| Per-user LLM key, write side + UI + `KEY_CIPHERTEXT_FILES` | 7 |
| Account group in `/settings`; member panel vs guest shell | 6 (Google) · 7 (key) |
| #96 — member resolves to the guest model tier | 8 |
| The live orphan row | 3 |
| Extend the scoping harness to user-keyed models | 1 (mechanism) · 2 (repo-wide rule) |
| `connected` from ciphertext presence, not decryptability | 2 |
| Status crossing into the client for guests and members | 5 |
| `googleStatus()` dead server action | 4 (deleted) |
| Guest page loads materialise the credential row | 2 (`getAuth` is a find; `null` short-circuits) |
| `google.test.ts` rewritten, not extended | 2 |
| E2E connected-member fixture; which specs change | 9 |
| Hosted-instance OAuth consent screen | 9 (docs + post-deploy step) |
| Spec §5 "the OAuth callback writes the row for the user who initiated it" | 2 (`exchangeCode(me.id, …)`) |
| Spec §Testing — policy matrix `own_key` with and without a key | 7 (action) · 8 (tier) — Phase B already covers `consumeUserBreakdown` |

## Deliberately not here

- **Phase D** — guest carryover prompt, JSON export, revoke → freeze → 30-day purge, legacy-owner purge script. Separate issue.
- **`GoogleAuth.userId SET NOT NULL`** — see Decision 2. Safe in the release *after* this one, once no deployed code can write a NULL `userId`. Worth filing as a one-line follow-up so it is not forgotten; the harness covers the same ground in CI meanwhile.
- **A per-user model picker.** Task 8 gives a member with their own key the owner-grade default. Letting them *choose* a tier is a new settings control with its own copy and a11y work, and nobody has asked for it. `resolveAnthropicModel` has the branch it would slot into.
- **A per-user `llmProvider` / base URL.** Rejected on the same grounds `LLMCredentials` has no `baseUrl`: a per-user endpoint is an SSRF primitive. A user's key is for the instance's configured provider.
- **Reclaim as a separate integration.** `/api/reclaim/oauth/` was removed in #36; Reclaim is reached through the Google Tasks list, and the spec's "integrations (Google/Reclaim)" wording describes one connection, not two.
