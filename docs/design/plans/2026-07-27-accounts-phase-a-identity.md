# Accounts Phase A — Identity Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `OWNER_WORKSPACE_ID = "owner"` binary with real `User` records that own workspaces, provisioned only from an invite allowlist, so #35's later phases have an identity to hang per-user integrations and AI policy on.

**Architecture:** The data layer is already workspace-scoped — every content model carries `workspaceId` with `onDelete: Cascade`. So this phase changes *who a workspace belongs to*, not how data is partitioned. A `User` row keyed on `(provider, providerSub)` gains a 1:1 `Workspace`; the OAuth callback provisions one only if an `Allowlist` row matches the incoming profile; the session payload changes from `{ kind: "owner", sub }` to `{ kind: "user", userId, wsId }`; and `resolveWorkspaceId()` returns the user's real workspace id instead of a constant. Guests are untouched throughout.

**Tech Stack:** Next.js (see `AGENTS.md` — read `node_modules/next/dist/docs/` before writing route/middleware code), Prisma + PostgreSQL, `jose` for JWTs, vitest + jsdom/RTL, Playwright for e2e.

**Spec:** `docs/design/specs/2026-07-27-accounts-per-user-foundation-design.md`. Issue: #35.

## Global Constraints

- **Production bar.** This is a live app with the owner's real data. Tests, error and edge-case handling, security, WCAG-AA a11y, and matching existing repo conventions are required on every task.
- **TDD, strictly.** Failing test first, watch it fail for the right reason, then implement. Several tasks below are security boundaries where a test that cannot fail is worse than no test — mutate the implementation to prove the test bites.
- **All three react-hooks rules are at `error`** as of !160 (#23). No set-state-in-effect, no ref reads during render, no `Math.random()` during render.
- **Conventional commits**, every message ending with the trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Pseudo-enum columns need CHECK constraints** mirrored in `src/lib/constants.ts` and registered with `src/lib/enum-constraint-sync.integration.test.ts`. That applies to `User.role`, `User.status` and `User.aiPolicy` in Task 1.
- **Integration tests need a real Postgres**, and vitest does not read `.env` — export `DATABASE_URL` with a unique `?schema=` per worker.
- **`openai` is declared but missing from local `node_modules`.** `npx tsc --noEmit` fails with `TS2307: Cannot find module 'openai'` until you run `npm install --no-save --ignore-scripts openai@^6.49.0` in your worktree. Do not "fix" it in the repo.
- **Gates before any task is done:** `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run format:check`. There is no `typecheck` script.
- **Never merge, never deploy.** The owner merges.

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | `User`, `Allowlist`, `UserAiUsage` models; `Workspace.userId`; drop `GoogleAuth` singleton default |
| `prisma/migrations/*/migration.sql` | The migration, including CHECK constraints and the owner's seed allowlist row |
| `src/lib/constants.ts` | `UserRole`, `UserStatus`, `AiPolicy` value unions + CHECK-constraint registration; **`OWNER_WORKSPACE_ID` deleted** |
| `src/lib/auth/providers.ts` | `AuthProvider.fetchProfile()` returning subject + username + email |
| `src/lib/auth/session.ts` | `{ kind: "user" }` payload, `signUserSession()` |
| `src/lib/auth/provisioning.ts` | **New.** The allowlist → account decision, in one testable place |
| `src/lib/auth/gate.ts` | `AUTHENTICATED_PREFIXES` + `isAuthenticatedOnlyPath()` |
| `src/app/api/auth/gitlab/callback/route.ts` | Calls provisioning, sets the new session cookie |
| `src/lib/workspace.ts` | `resolveWorkspaceId()` / `isOwnerRequest()` rewritten against `User`; `currentUser()` added |
| `src/lib/__tests__/scoping.harness.test.ts` | **New.** Enumerates `workspaceId`-carrying models and asserts each is filtered |
| `src/components/nav/app-menu.tsx` | "Sign in" → "Account" |
| `src/proxy.ts` | Guest minting must not fire for a valid user session |

---

### Task 1: Schema — `User`, `Allowlist`, `UserAiUsage`

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/lib/constants.ts`
- Create: `prisma/migrations/<timestamp>_accounts_identity/migration.sql`
- Test: `src/lib/enum-constraint-sync.integration.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `User`, `Allowlist`, `UserAiUsage`; `Workspace.userId String? @unique`; exported unions `UserRole = "owner" | "member"`, `UserStatus = "active" | "revoked"`, `AiPolicy = "uncapped" | "capped" | "own_key"`.

- [ ] **Step 1: Write the failing constraint test**

Extend the registry the existing integration test drives, adding the three new constraints:

```ts
// in the constraint registry consumed by enum-constraint-sync.integration.test.ts
{ table: "User", column: "role", constraint: "User_role_check", values: USER_ROLES },
{ table: "User", column: "status", constraint: "User_status_check", values: USER_STATUSES },
{ table: "User", column: "aiPolicy", constraint: "User_aiPolicy_check", values: AI_POLICIES },
```

- [ ] **Step 2: Run it and watch it fail**

Run: `DATABASE_URL="postgresql://...?schema=phaseA1" npx vitest run src/lib/enum-constraint-sync.integration.test.ts`
Expected: FAIL — the `User` table does not exist.

- [ ] **Step 3: Add the models**

```prisma
model User {
  id           String    @id @default(cuid())
  provider     String
  providerSub  String
  email        String?
  handle       String?
  role         String    @default("member")
  status       String    @default("active")
  aiPolicy     String    @default("capped")
  aiQuota      Int       @default(50)
  llmProvider  String?
  llmKeyEnc    String?
  revokedAt    DateTime?
  purgeAfter   DateTime?
  createdAt    DateTime  @default(now())
  lastSeenAt   DateTime  @default(now())
  workspace    Workspace?
  aiUsage      UserAiUsage?
  allowlistRow Allowlist?

  @@unique([provider, providerSub])
  @@index([status, purgeAfter])
}

model Allowlist {
  id          String    @id @default(cuid())
  provider    String
  identity    String
  note        String?
  // Grants role="owner" on claim. A DEDICATED column, never a sentinel value
  // in `note` — a free-text field deciding a privilege level means any row
  // that happens to carry the magic string escalates whoever claims it.
  isOwnerSeed Boolean   @default(false)
  invitedAt   DateTime  @default(now())
  claimedAt   DateTime?
  claimedById String?   @unique
  claimedBy   User?     @relation(fields: [claimedById], references: [id], onDelete: SetNull)

  @@unique([provider, identity])
}

model UserAiUsage {
  userId          String   @id
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  count           Int      @default(0)
  windowStartedAt DateTime @default(now())
  updatedAt       DateTime @updatedAt
}
```

Add to `Workspace`: `userId String? @unique` and `user User? @relation(fields: [userId], references: [id], onDelete: Cascade)`.

Add to `src/lib/constants.ts`, following the existing pseudo-enum pattern in that file:

```ts
export const USER_ROLES = ["owner", "member"] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const USER_STATUSES = ["active", "revoked"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export const AI_POLICIES = ["uncapped", "capped", "own_key"] as const;
export type AiPolicy = (typeof AI_POLICIES)[number];
```

- [ ] **Step 4: Write the migration with CHECK constraints**

Generate with `npx prisma migrate dev --name accounts_identity --create-only`, then hand-add the constraints to the generated SQL, matching how the existing `Settings_*_check` constraints are written:

```sql
ALTER TABLE "User" ADD CONSTRAINT "User_role_check" CHECK ("role" IN ('owner','member'));
ALTER TABLE "User" ADD CONSTRAINT "User_status_check" CHECK ("status" IN ('active','revoked'));
ALTER TABLE "User" ADD CONSTRAINT "User_aiPolicy_check" CHECK ("aiPolicy" IN ('uncapped','capped','own_key'));
```

- [ ] **Step 5: Run the constraint test to verify it passes**

Run: `DATABASE_URL="postgresql://...?schema=phaseA1" npx vitest run src/lib/enum-constraint-sync.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove the constraints actually bite**

Write an integration test that inserts `role = 'admin'` via raw SQL and expects a rejection:

```ts
await expect(
  prisma.$executeRawUnsafe(
    `INSERT INTO "User" (id, provider, "providerSub", role) VALUES ('t1','gitlab','1','admin')`,
  ),
).rejects.toThrow();
```

Expected: PASS (the insert is rejected). Delete the constraint locally, re-run, confirm it fails, restore.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/constants.ts src/lib/enum-constraint-sync.integration.test.ts
git commit -m "feat(db): add User, Allowlist and UserAiUsage models (#35)"
```

---

### Task 2: Provider profile — username and email, not just an opaque id

**Files:**
- Modify: `src/lib/auth/providers.ts`
- Test: `src/lib/auth/providers.test.ts`

**Interfaces:**
- Consumes: Task 1's constants (not required at runtime).
- Produces: `interface AuthProfile { subject: string; username?: string; email?: string }` and `AuthProvider.fetchProfile(accessToken: string): Promise<AuthProfile>`. Task 3 and Task 4 both depend on these exact names.

**Why:** `fetchIdentity()` currently returns only `String(data.id)`. The owner decided invites are typed as a **username**, so the profile has to carry one. The account still keys on `subject` (the numeric id), because usernames can be changed and reused — the typed value only matches the invite once.

- [ ] **Step 1: Write the failing test**

```ts
it("returns subject, username and email from the GitLab profile", async () => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ id: 42, username: "Domi", email: "d@example.com" }), { status: 200 }),
  ));
  const profile = await getAuthProvider().fetchProfile("tok");
  expect(profile).toEqual({ subject: "42", username: "domi", email: "d@example.com" });
});

it("tolerates a profile with no email (GitLab may withhold it)", async () => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ id: 42, username: "Domi" }), { status: 200 }),
  ));
  const profile = await getAuthProvider().fetchProfile("tok");
  expect(profile).toEqual({ subject: "42", username: "domi", email: undefined });
});
```

Note the lowercasing of `username`: matching is case-insensitive, and normalising at the boundary means every consumer compares like for like.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/auth/providers.test.ts`
Expected: FAIL — `fetchProfile is not a function`.

- [ ] **Step 3: Implement**

Replace `fetchIdentity` with `fetchProfile` on the interface and the GitLab implementation:

```ts
export interface AuthProfile {
  subject: string;
  username?: string;
  email?: string;
}

// on AuthProvider:
fetchProfile(accessToken: string): Promise<AuthProfile>;

// gitlabProvider:
async fetchProfile(accessToken) {
  const res = await fetch(`${GITLAB}/api/v4/user`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`GitLab user fetch failed (${res.status})`);
  const data = (await res.json()) as { id: number; username?: string; email?: string };
  return {
    subject: String(data.id),
    username: data.username?.trim().toLowerCase(),
    email: data.email?.trim().toLowerCase(),
  };
}
```

Delete `fetchIdentity` and the now-unused `isOwner()` helper — the env `OWNER_ALLOWLIST` check it served is replaced by the database allowlist in Task 3. Leave `authConfig().ownerAllowlist` in place for now; Task 3 uses it to seed.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/auth/providers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/providers.ts src/lib/auth/providers.test.ts
git commit -m "feat(auth): fetch username and email with the provider profile (#35)"
```

---

### Task 3: Provisioning — the allowlist decision, in one place

**Files:**
- Create: `src/lib/auth/provisioning.ts`
- Test: `src/lib/auth/provisioning.integration.test.ts`

**Interfaces:**
- Consumes: `AuthProfile` from Task 2; Prisma models from Task 1.
- Produces:

```ts
export type ProvisionResult =
  | { ok: true; userId: string; workspaceId: string; role: UserRole }
  | { ok: false; reason: "not_invited" | "revoked" };

export async function provisionFromProfile(
  provider: string,
  profile: AuthProfile,
): Promise<ProvisionResult>;
```

Task 4 depends on these exact names.

**Why one module:** this is the security boundary of the whole feature. Keeping it out of the route handler means it can be tested directly against a real database, without driving OAuth.

- [ ] **Step 1: Write the failing provisioning matrix**

```ts
describe("provisionFromProfile", () => {
  it("creates a user and workspace for an allowlisted username", async () => {
    await prisma.allowlist.create({ data: { provider: "gitlab", identity: "domi" } });
    const r = await provisionFromProfile("gitlab", { subject: "42", username: "domi" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ws = await prisma.workspace.findUnique({ where: { userId: r.userId } });
    expect(ws?.id).toBe(r.workspaceId);
    expect(ws?.kind).toBe("user");
    const row = await prisma.allowlist.findFirst({ where: { identity: "domi" } });
    expect(row?.claimedById).toBe(r.userId);
  });

  it("matches an allowlist entry by email as well as username", async () => {
    await prisma.allowlist.create({ data: { provider: "gitlab", identity: "d@example.com" } });
    const r = await provisionFromProfile("gitlab", { subject: "43", email: "d@example.com" });
    expect(r.ok).toBe(true);
  });

  it("refuses an identity that is not allowlisted, and creates NO user", async () => {
    const r = await provisionFromProfile("gitlab", { subject: "44", username: "stranger" });
    expect(r).toEqual({ ok: false, reason: "not_invited" });
    expect(await prisma.user.count()).toBe(0);
  });

  it("refuses a revoked user and does not resurrect them", async () => {
    const u = await prisma.user.create({
      data: { provider: "gitlab", providerSub: "45", status: "revoked" },
    });
    const r = await provisionFromProfile("gitlab", { subject: "45", username: "gone" });
    expect(r).toEqual({ ok: false, reason: "revoked" });
    expect((await prisma.user.findUnique({ where: { id: u.id } }))?.status).toBe("revoked");
  });

  it("returns the existing account on a second sign-in, without a second workspace", async () => {
    await prisma.allowlist.create({ data: { provider: "gitlab", identity: "domi" } });
    const first = await provisionFromProfile("gitlab", { subject: "42", username: "domi" });
    const second = await provisionFromProfile("gitlab", { subject: "42", username: "domi" });
    expect(second).toEqual(first);
    expect(await prisma.workspace.count()).toBe(1);
  });

  it("does not let a claimed invite be reused by a different subject", async () => {
    await prisma.allowlist.create({ data: { provider: "gitlab", identity: "domi" } });
    await provisionFromProfile("gitlab", { subject: "42", username: "domi" });
    const r = await provisionFromProfile("gitlab", { subject: "99", username: "domi" });
    expect(r).toEqual({ ok: false, reason: "not_invited" });
    expect(await prisma.user.count()).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `DATABASE_URL="postgresql://...?schema=phaseA3" npx vitest run src/lib/auth/provisioning.integration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { prisma } from "@/lib/db";
import type { AuthProfile } from "@/lib/auth/providers";
import type { UserRole } from "@/lib/constants";

export type ProvisionResult =
  | { ok: true; userId: string; workspaceId: string; role: UserRole }
  | { ok: false; reason: "not_invited" | "revoked" };

export async function provisionFromProfile(
  provider: string,
  profile: AuthProfile,
): Promise<ProvisionResult> {
  const existing = await prisma.user.findUnique({
    where: { provider_providerSub: { provider, providerSub: profile.subject } },
    include: { workspace: true },
  });

  if (existing) {
    if (existing.status === "revoked") return { ok: false, reason: "revoked" };
    await prisma.user.update({
      where: { id: existing.id },
      data: { lastSeenAt: new Date(), handle: profile.username, email: profile.email },
    });
    return {
      ok: true,
      userId: existing.id,
      workspaceId: existing.workspace!.id,
      role: existing.role as UserRole,
    };
  }

  const identities = [profile.username, profile.email].filter(
    (v): v is string => !!v,
  );
  if (identities.length === 0) return { ok: false, reason: "not_invited" };

  const invite = await prisma.allowlist.findFirst({
    where: { provider, identity: { in: identities }, claimedById: null },
  });
  if (!invite) return { ok: false, reason: "not_invited" };

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        provider,
        providerSub: profile.subject,
        handle: profile.username,
        email: profile.email,
      },
    });
    const ws = await tx.workspace.create({
      data: { kind: "user", userId: user.id },
    });
    await tx.allowlist.update({
      where: { id: invite.id },
      data: { claimedById: user.id, claimedAt: new Date() },
    });
    return {
      ok: true as const,
      userId: user.id,
      workspaceId: ws.id,
      role: user.role as UserRole,
    };
  });
}
```

Note `claimedById: null` in the invite lookup — that is what makes the reuse test pass.

- [ ] **Step 4: Run the matrix**

Run: `DATABASE_URL="postgresql://...?schema=phaseA3" npx vitest run src/lib/auth/provisioning.integration.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Seed the owner's invite in the migration**

Add to the Task 1 migration, so the owner is not locked out by their own feature:

```sql
INSERT INTO "Allowlist" (id, provider, identity, note, "invitedAt")
SELECT gen_random_uuid()::text, 'gitlab', lower(trim(x)), 'seeded from OWNER_ALLOWLIST', now()
FROM unnest(string_to_array(current_setting('app.owner_allowlist', true), ',')) AS x
WHERE trim(x) <> '';
```

The seeded rows must set `"isOwnerSeed" = true`. If setting a runtime GUC is awkward in the deploy path, use a small idempotent seed script invoked by the same job that runs `prisma migrate deploy`, reading `OWNER_ALLOWLIST` from the environment. Either way it must be idempotent and must run **before** the first sign-in attempt.

Then extend `provisionFromProfile` so a claimed invite with `isOwnerSeed === true` provisions `role: "owner"`, and everything else provisions `role: "member"`.

**Use the boolean column, never a sentinel string in `note`.** A free-text field deciding a privilege level is a privilege-escalation hole: any row that happens to carry the magic string — set by accident, by a future People UI, or by copy-paste — would silently make the claimer an owner. Add a test that an invite with `note: "seeded from OWNER_ALLOWLIST"` but `isOwnerSeed: false` provisions a **member**, so the sentinel can never quietly come back.

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth/provisioning.ts src/lib/auth/provisioning.integration.test.ts prisma/migrations
git commit -m "feat(auth): provision accounts from the invite allowlist (#35)"
```

---

### Task 4: Session shape — `{ kind: "user" }`

**Files:**
- Modify: `src/lib/auth/session.ts`
- Modify: `src/app/api/auth/gitlab/callback/route.ts`
- Test: `src/lib/auth/session.test.ts`, `src/app/api/auth/gitlab/callback/route.test.ts`

**Interfaces:**
- Consumes: `provisionFromProfile` (Task 3), `fetchProfile` (Task 2).
- Produces: `SessionPayload` gains `{ kind: "user"; userId: string; wsId: string }` and loses `{ kind: "owner"; sub: string }`; `signUserSession(payload: { kind: "user"; userId: string; wsId: string }, secret: string): Promise<string>` replaces `signOwnerSession`. `OWNER_COOKIE` keeps its name and value (`df_owner`) so nothing else has to change.

- [ ] **Step 1: Write the failing session tests**

```ts
it("round-trips a user session", async () => {
  const t = await signUserSession({ kind: "user", userId: "u1", wsId: "w1" }, SECRET);
  expect(await verifySession(t, SECRET)).toEqual({ kind: "user", userId: "u1", wsId: "w1" });
});

it("rejects a legacy owner token outright", async () => {
  // Hand-sign the old shape; it must no longer verify to anything usable.
  const legacy = await new SignJWT({ kind: "owner", sub: "42" })
    .setProtectedHeader({ alg: SESSION_ALG })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(new TextEncoder().encode(SECRET));
  expect(await verifySession(legacy, SECRET)).toBeNull();
});
```

The second test is the important one: it pins the deliberate cutover, so an old cookie fails closed rather than resolving to something.

- [ ] **Step 2: Run and watch both fail**

Run: `npx vitest run src/lib/auth/session.test.ts`
Expected: FAIL — `signUserSession` undefined; the legacy token still verifies.

- [ ] **Step 3: Implement the session change**

```ts
export type SessionPayload =
  | { kind: "user"; userId: string; wsId: string }
  | { kind: "guest"; wsId: string };

export async function signUserSession(
  payload: { kind: "user"; userId: string; wsId: string },
  secret: string,
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: SESSION_ALG })
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + USER_SESSION_TTL_SECONDS)
    .sign(key(secret));
}
```

(Do the `OWNER_SESSION_TTL_SECONDS` → `USER_SESSION_TTL_SECONDS` rename below *before* this snippet compiles.)

In `verifySession`, replace the `owner` branch:

```ts
if (
  payload.kind === "user" &&
  typeof payload.userId === "string" &&
  typeof payload.wsId === "string"
) {
  return { kind: "user", userId: payload.userId, wsId: payload.wsId };
}
```

Rename `OWNER_SESSION_TTL_SECONDS` to `USER_SESSION_TTL_SECONDS`, keeping the 30-day value and its comment about the owner's decision on !76.

- [ ] **Step 4: Rewrite the callback**

Replace the `isOwner(identity, ownerAllowlist)` check:

```ts
let profile: AuthProfile;
try {
  const provider = getAuthProvider();
  const token = await provider.exchangeCode({ code, codeVerifier: verifier, redirectUri: `${origin}/api/auth/gitlab/callback` });
  profile = await provider.fetchProfile(token);
} catch (err) {
  return fail(err instanceof Error ? err.message : "auth_failed");
}

const result = await provisionFromProfile(authConfig().provider, profile);
if (!result.ok) return fail("not_authorized");

const session = await signUserSession(
  { kind: "user", userId: result.userId, wsId: result.workspaceId },
  authConfig().sessionSecret,
);
```

**Return the same `not_authorized` reason for both `not_invited` and `revoked`.** A distinct message would let anyone probe whether an identity is known to the instance.

- [ ] **Step 5: Test the callback's failure parity**

```ts
it("returns an identical error for not-invited and revoked", async () => {
  // drive both paths, assert the redirect Location strings are byte-identical
});
```

- [ ] **Step 6: Run tests, then commit**

Run: `npx vitest run src/lib/auth src/app/api/auth`
Expected: PASS.

```bash
git add src/lib/auth src/app/api/auth
git commit -m "feat(auth): replace the owner session with a per-user session (#35)"
```

---

### Task 5: Workspace resolution — delete `OWNER_WORKSPACE_ID`

**Files:**
- Modify: `src/lib/workspace.ts`
- Modify: `src/lib/constants.ts` (delete the constant)
- Modify: `src/app/actions/google-schedule.ts:64,188,297,304`, `src/app/api/breakdown/route.ts:124,141`
- Test: `src/lib/workspace.test.ts`

**Interfaces:**
- Consumes: session payload from Task 4.
- Produces: `currentUser(): Promise<{ id: string; role: UserRole; workspaceId: string } | null>`; `isOwnerRequest()` keeps its name and boolean return so its five call sites do not change; `resolveWorkspaceId()` keeps its signature.

- [ ] **Step 1: Write the failing tests**

```ts
it("resolves a user session to that user's own workspace, not a constant", async () => {
  const token = await signUserSession({ kind: "user", userId: "u1", wsId: "ws-real" }, SECRET);
  expect(await resolveWorkspaceId({ owner: token })).toBe("ws-real");
});

it("treats a member as not-owner", async () => { /* role member → isOwnerRequest() false */ });
it("treats the owner role as owner", async () => { /* role owner → true */ });
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run src/lib/workspace.test.ts`
Expected: FAIL — still returns `"owner"`.

- [ ] **Step 3: Implement**

```ts
if (input.owner) {
  const p = await verifySession(input.owner, sessionSecret);
  if (p?.kind === "user") return p.wsId;
}
```

`touchWorkspace()` currently derives `kind` from `id === OWNER_WORKSPACE_ID`. Change it to take the kind explicitly rather than inferring it, since a workspace's kind is now a database fact:

```ts
export async function touchWorkspace(id: string, kind: "user" | "guest"): Promise<void>
```

`isOwnerRequest()` reads the session, loads the user, and returns `user?.role === "owner"`. Add `currentUser()` alongside it and implement `isOwnerRequest()` in terms of it so there is one query path.

Then delete `OWNER_WORKSPACE_ID` from `src/lib/constants.ts` and fix every call site. In `google-schedule.ts` the four `workspaceId !== OWNER_WORKSPACE_ID` guards become `!(await isOwnerRequest())` — Phase C makes them per-user, but in Phase A they stay owner-only. In `breakdown/route.ts:124`, `isGuest` becomes a check on the session kind (`p.kind === "guest"`), not a workspace-id comparison.

- [ ] **Step 4: Prove the constant is gone**

Run: `grep -rn "OWNER_WORKSPACE_ID" src/`
Expected: no output. Add this as an assertion in the scoping harness of Task 7 so it cannot come back.

- [ ] **Step 5: Run the full suite, then commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/lib src/app
git commit -m "feat(auth): resolve workspaces from the user record, deleting OWNER_WORKSPACE_ID (#35)"
```

---

### Task 6: `AUTHENTICATED_PREFIXES` route category

**Files:**
- Modify: `src/lib/auth/gate.ts`
- Modify: `src/proxy.ts`
- Test: `src/lib/auth/gate.test.ts`, `src/proxy.test.ts`

**Interfaces:**
- Consumes: session payload from Task 4.
- Produces: `AUTHENTICATED_PREFIXES: string[]` and `isAuthenticatedOnlyPath(pathname: string): boolean`.

**Why:** `gate.ts` has only `PUBLIC_PREFIXES` and `OWNER_ONLY_PREFIXES`, so anything not owner-only is reachable by a guest session. Phase C moves `/api/google/oauth/` out of owner-only; without this category first, that would open the OAuth callback to guests.

- [ ] **Step 1: Write the failing tests**

```ts
it("classifies an authenticated-only path", () => {
  expect(isAuthenticatedOnlyPath("/api/account/export")).toBe(true);
  expect(isAuthenticatedOnlyPath("/api/health")).toBe(false);
});

it("rejects a guest session on an authenticated-only path", async () => {
  // drive proxy.ts with a valid GUEST cookie against an AUTHENTICATED_PREFIXES path
  // expect a redirect to /login, NOT a 200
});

it("admits a user session on the same path", async () => { /* ... */ });
```

The middleware tests are the ones that matter — a helper that classifies correctly while the middleware ignores it is the bug this task exists to prevent.

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run src/lib/auth/gate.test.ts src/proxy.test.ts`
Expected: FAIL — `isAuthenticatedOnlyPath` undefined.

- [ ] **Step 3: Implement**

```ts
/** Paths that require a real signed-in user. A guest session is NOT enough.
 *  Distinct from OWNER_ONLY_PREFIXES: any member may use these, guests may not. */
export const AUTHENTICATED_PREFIXES = ["/api/account/"];

export function isAuthenticatedOnlyPath(pathname: string): boolean {
  return AUTHENTICATED_PREFIXES.some((p) => pathname.startsWith(p));
}
```

In `src/proxy.ts`, before guest minting: if `isAuthenticatedOnlyPath(pathname)` and the request has no valid `kind: "user"` session, redirect to `/login`. Also ensure guest minting does **not** fire when a valid user session cookie is present — otherwise a signed-in user picks up a guest workspace header alongside their own session.

- [ ] **Step 4: Run tests, then commit**

Run: `npx vitest run src/lib/auth/gate.test.ts src/proxy.test.ts`
Expected: PASS.

```bash
git add src/lib/auth/gate.ts src/proxy.ts src/lib/auth/gate.test.ts src/proxy.test.ts
git commit -m "feat(auth): add an authenticated-user route category (#35)"
```

---

### Task 7: Workspace-scoping harness

**Files:**
- Create: `src/lib/__tests__/scoping.harness.test.ts`
- Test: itself

**Interfaces:**
- Consumes: everything above.
- Produces: a failing build for any future model that carries `workspaceId` without scoped access.

**Why:** the spec's "usage only, never content" rule is only true if there is no cross-workspace read path. This is the mechanism that makes that structural instead of aspirational, and this codebase has shipped an IDOR bug before (#21).

- [ ] **Step 1: Write the harness**

The obvious version of this test is a trap. Asserting that the `workspaceId`-carrying models are not in an `EXEMPT` set is **tautological** — the filter already selected models that have `workspaceId`, so the assertion can only fail if someone adds `workspaceId` to an exempt model. It would pass forever while proving nothing.

What actually has to be true is that **every Prisma read/write against a scoped model carries a workspace filter**. That is a source-level property, so scan for it:

```ts
import { Prisma } from "@prisma/client";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

// Call sites reviewed and deliberately unscoped, each with a stated reason.
// Adding to this list is a security decision — it should show up in review.
const REVIEWED_UNSCOPED: Record<string, string> = {
  "src/lib/purge.ts": "deletes whole expired workspaces by design",
};

it("finds the scoped models at all (guards against the harness silently matching nothing)", () => {
  const scoped = Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === "workspaceId"))
    .map((m) => m.name);
  expect(scoped.length).toBeGreaterThanOrEqual(8);
});

it("every prisma call against a workspace-scoped model filters by workspaceId", () => {
  const scoped = Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === "workspaceId"))
    .map((m) => m.name[0].toLowerCase() + m.name.slice(1));

  const offenders: string[] = [];
  for (const file of globSync("src/**/*.{ts,tsx}").filter((f) => !f.includes(".test."))) {
    if (REVIEWED_UNSCOPED[file]) continue;
    const src = readFileSync(file, "utf8");
    for (const model of scoped) {
      // Match `prisma.<model>.<op>( ... )` and require workspaceId inside the
      // call's argument object.
      const re = new RegExp(
        `prisma\\.${model}\\.(findMany|findFirst|findUnique|update|updateMany|delete|deleteMany|count|aggregate)\\(([\\s\\S]*?)\\n\\s*\\)`,
        "g",
      );
      for (const m of src.matchAll(re)) {
        if (!m[2].includes("workspaceId")) offenders.push(`${file}: prisma.${model}.${m[1]}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

it("no source file references the removed owner-workspace constant", () => {
  const hits = globSync("src/**/*.{ts,tsx}").filter((f) =>
    readFileSync(f, "utf8").includes("OWNER_WORKSPACE_ID"),
  );
  expect(hits).toEqual([]);
});
```

If the regex proves too brittle against the real call sites, replace it with a Prisma client extension that throws at runtime when a scoped model is queried without `workspaceId`, and drive it from the integration tests — but **do not** fall back to the tautological version.

- [ ] **Step 2: Prove the harness bites**

Temporarily add a model with `workspaceId` and no scoping, run the harness, confirm it fails, then remove it. **Record that you did this in the MR** — a harness nobody has watched fail is decoration.

- [ ] **Step 3: Add cross-workspace IDOR tests**

For each of tasks, brain dump items and focus sessions: create two workspaces, write a row in A, and assert the read path returns nothing when called in B's context. Three tests, each of which must fail if the scoping filter is deleted — verify by deleting one.

- [ ] **Step 4: Run, then commit**

Run: `DATABASE_URL="postgresql://...?schema=phaseA7" npx vitest run src/lib/__tests__/scoping.harness.test.ts`
Expected: PASS.

```bash
git add src/lib/__tests__/scoping.harness.test.ts
git commit -m "test(security): add the workspace-scoping harness (#35)"
```

---

### Task 8: "Sign in" → "Account" in the app menu

**Files:**
- Modify: `src/components/nav/app-menu.tsx`
- Test: `src/components/nav/app-menu.test.tsx`

**Interfaces:**
- Consumes: `currentUser()` from Task 5.
- Produces: nothing downstream.

**Note:** !162 (#72) is reworking the Settings/Help section nav. Check whether it has landed before editing nav components, and rebase rather than resolving a conflict blind.

- [ ] **Step 1: Write the failing test**

```ts
it("shows 'Sign in' to a guest", () => {
  render(<AppMenu user={null} />);
  expect(screen.getByRole("link", { name: /sign in/i })).toBeInTheDocument();
});

it("shows 'Account' to a signed-in user, linking to the account section", () => {
  render(<AppMenu user={{ id: "u1", role: "member", workspaceId: "w1" }} />);
  const link = screen.getByRole("link", { name: /account/i });
  expect(link).toHaveAttribute("href", "/settings#account");
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run src/components/nav/app-menu.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**, following the existing menu-item markup exactly — same classes, same focus states, same voice-string usage if neighbouring items use `t()`.

- [ ] **Step 4: Run tests, then commit**

```bash
git add src/components/nav/app-menu.tsx src/components/nav/app-menu.test.tsx
git commit -m "feat(nav): show Account instead of Sign in when signed in (#35)"
```

---

### Task 9: End-to-end verification and the MR

- [ ] **Step 1: Full gates**

Run each and paste real output: `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run format:check`, `npm run check:env`, `npx playwright test`.

- [ ] **Step 2: Verify the owner can actually sign in**

The e2e suite forges an owner cookie in `e2e/global-setup.ts` — that forging code produces the **old** session shape and must be updated to the new one, or every e2e test will silently run as an unauthenticated user. Check this explicitly; it is the most likely way this phase looks green while being broken.

- [ ] **Step 3: Confirm guests are untouched**

Run the guest e2e specs and confirm a guest still gets a sandbox, the banner, and the AI cap. Phase A must not change guest behaviour at all.

- [ ] **Step 4: Open the MR**

```bash
glab mr create --fill --reviewer GitLabDuo --milestone v0.5.0 --assignee gitlab_dlectronique
```

Description must cover: what changed, the provisioning matrix results, evidence that the scoping harness and CHECK constraints were watched failing, the deliberate cutover (old owner cookies stop working — the owner signs in once after deploy), and the fact that Google Tasks sync is down until Phase C.

- [ ] **Step 5: Tick Phase A on #35** and post a short progress note.
