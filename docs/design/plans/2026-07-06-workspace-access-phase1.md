# Workspace Access — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the owner's data private (reachable only after GitLab login) while any visitor can use the app in their own isolated, per-browser workspace — with zero data loss for existing rows.

**Architecture:** Introduce a `Workspace` row that owns every user-data record. The **owner** is one fixed workspace (`id = "owner"`), unlocked by a signed session cookie set after GitLab OAuth (identity checked against `OWNER_ALLOWLIST`). Each **guest** gets a `Workspace` created lazily, keyed by a signed guest cookie that **middleware** issues on first visit. A single resolver, `currentWorkspaceId()`, reads the request cookies and returns the active workspace id; every data-access function is scoped by it. Auth is behind a small provider interface (`AuthProvider`) so GitLab can be swapped/extended later. This is the deployable data-privacy milestone; guest AI caps + banner (Phase 2) and guest cleanup (Phase 3) are separate plans.

**Tech Stack:** Next.js 16.2 (App Router, Server Actions, middleware), React 19, TypeScript 5, Prisma 6 + PostgreSQL, `jose` (cookie signing), `vitest` (new test harness). Hand-rolled OAuth mirroring `src/lib/google.ts`.

## Global Constraints

- **No new heavy auth deps.** Only `jose` (session cookies) and dev-only `vitest`/`@vitejs/plugin-react` are added. Auth.js/next-auth is explicitly rejected for now.
- **Prisma stays v6** (`^6.19.3`); `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` unchanged. Postgres everywhere.
- **String status columns** (no enums); mirror allowed values in `src/lib/constants.ts`.
- **Never log secrets.** Session secret, client secret, tokens never printed.
- **Owner workspace id is the literal `"owner"`.** Guest workspace ids are UUIDs.
- **Reuse `requestOrigin(req)` from `src/lib/origin.ts`** for all redirect URIs (host-header-injection fix already in place).
- **Cookie options** (match existing google OAuth): `httpOnly:true, secure: origin.startsWith("https"), sameSite:"lax", path:"/"`.
- **`/api/health` must return 200 unauthenticated** (k8s probe) — never gate it.
- **Prod boot guard:** in `NODE_ENV=production`, missing owner-auth env (`AUTH_SESSION_SECRET`, provider client id/secret, `OWNER_ALLOWLIST`) must throw at startup.
- **Config values (this instance):** `AUTH_PROVIDER=gitlab`, `OWNER_ALLOWLIST=1234567`.

---

### Task 1: Test harness + `jose` dependency

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/lib/__tests__/smoke.test.ts`

**Interfaces:**
- Produces: `npm test` (runs vitest once), `npm run test:watch`.

- [ ] **Step 1: Install deps**

```bash
npm install jose@^5
npm install -D vitest@^2 @vitejs/plugin-react@^4
```

- [ ] **Step 2: Add test scripts to `package.json`**

In the `"scripts"` block add:

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
```

- [ ] **Step 4: Create smoke test `src/lib/__tests__/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";

describe("test harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run and verify PASS**

Run: `npm test`
Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/lib/__tests__/smoke.test.ts
git commit -m "chore: add vitest harness + jose dependency"
```

---

### Task 2: Signed session cookie helpers

Stateless, `jose`-signed (JWS/HS256) session payloads used for the owner cookie and the guest cookie.

**Files:**
- Create: `src/lib/auth/session.ts`
- Create: `src/lib/auth/session.test.ts`

**Interfaces:**
- Produces:
  - `type SessionPayload = { kind: "owner"; sub: string } | { kind: "guest"; wsId: string }`
  - `async function signSession(payload: SessionPayload, secret: string): Promise<string>`
  - `async function verifySession(token: string, secret: string): Promise<SessionPayload | null>` (null on any failure)
  - `const OWNER_COOKIE = "df_owner"`, `const GUEST_COOKIE = "df_guest"`

- [ ] **Step 1: Write failing test `src/lib/auth/session.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { signSession, verifySession } from "./session";

const SECRET = "test-secret-at-least-32-bytes-long-xxxxx";

describe("session cookie", () => {
  it("round-trips an owner payload", async () => {
    const token = await signSession({ kind: "owner", sub: "1234567" }, SECRET);
    expect(await verifySession(token, SECRET)).toEqual({
      kind: "owner",
      sub: "1234567",
    });
  });

  it("round-trips a guest payload", async () => {
    const token = await signSession({ kind: "guest", wsId: "abc" }, SECRET);
    expect(await verifySession(token, SECRET)).toEqual({
      kind: "guest",
      wsId: "abc",
    });
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSession({ kind: "guest", wsId: "abc" }, SECRET);
    expect(await verifySession(token, "another-secret-32-bytes-long-yyyyyyyy")).toBeNull();
  });

  it("returns null for garbage", async () => {
    expect(await verifySession("not.a.jwt", SECRET)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npm test -- session`
Expected: FAIL (cannot find `./session`).

- [ ] **Step 3: Implement `src/lib/auth/session.ts`**

```ts
import { SignJWT, jwtVerify } from "jose";

export const OWNER_COOKIE = "df_owner";
export const GUEST_COOKIE = "df_guest";
// Middleware forwards the resolved guest workspace id on this request header so
// the SAME request's server components can read it before the cookie round-trips.
// Homed here (pure, Edge-safe) so both middleware and workspace.ts can import it.
export const GUEST_WS_HEADER = "x-guest-ws";

export type SessionPayload =
  | { kind: "owner"; sub: string }
  | { kind: "guest"; wsId: string };

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSession(
  payload: SessionPayload,
  secret: string,
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(key(secret));
}

export async function verifySession(
  token: string,
  secret: string,
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret));
    if (payload.kind === "owner" && typeof payload.sub === "string") {
      return { kind: "owner", sub: payload.sub };
    }
    if (payload.kind === "guest" && typeof payload.wsId === "string") {
      return { kind: "guest", wsId: payload.wsId };
    }
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `npm test -- session`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/session.ts src/lib/auth/session.test.ts
git commit -m "feat(auth): signed session cookie helpers (jose)"
```

---

### Task 3: Auth config + GitLab provider + owner allowlist

**Files:**
- Create: `src/lib/auth/config.ts`
- Create: `src/lib/auth/providers.ts`
- Create: `src/lib/auth/providers.test.ts`

**Interfaces:**
- Consumes: `requestOrigin` is not used here (routes pass redirectUri in Task 7).
- Produces:
  - `config.ts`: `function authConfig(): { provider: string; ownerAllowlist: string[]; sessionSecret: string; clientId: string; clientSecret: string }` and `function assertAuthConfig(): void` (throws in production if unset).
  - `providers.ts`:
    - `interface AuthProvider { buildAuthorizeUrl(a:{redirectUri:string; state:string; codeChallenge:string}): string; exchangeCode(a:{code:string; codeVerifier:string; redirectUri:string}): Promise<string>; fetchIdentity(accessToken:string): Promise<string> }`
    - `function getAuthProvider(): AuthProvider`
    - `function isOwner(identity: string, allowlist: string[]): boolean`

- [ ] **Step 1: Write failing test `src/lib/auth/providers.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { isOwner, getAuthProvider } from "./providers";

describe("isOwner", () => {
  it("matches an allowlisted id", () => {
    expect(isOwner("1234567", ["1234567"])).toBe(true);
  });
  it("is case-insensitive and trims", () => {
    expect(isOwner("  Me@x.com ", ["me@x.com"])).toBe(true);
  });
  it("rejects a non-listed identity", () => {
    expect(isOwner("999", ["1234567"])).toBe(false);
  });
  it("rejects empty identity", () => {
    expect(isOwner("", ["1234567"])).toBe(false);
  });
});

describe("gitlab provider authorize url", () => {
  it("includes client_id, PKCE and read_user scope", () => {
    process.env.AUTH_PROVIDER = "gitlab";
    process.env.GITLAB_OAUTH_CLIENT_ID = "cid";
    const url = getAuthProvider().buildAuthorizeUrl({
      redirectUri: "https://x/api/auth/gitlab/callback",
      state: "st",
      codeChallenge: "ch",
    });
    expect(url).toContain("client_id=cid");
    expect(url).toContain("scope=read_user");
    expect(url).toContain("code_challenge=ch");
    expect(url).toContain("code_challenge_method=S256");
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npm test -- providers`
Expected: FAIL (cannot find `./providers`).

- [ ] **Step 3: Implement `src/lib/auth/config.ts`**

```ts
export function authConfig() {
  return {
    provider: process.env.AUTH_PROVIDER ?? "gitlab",
    ownerAllowlist: (process.env.OWNER_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    sessionSecret: process.env.AUTH_SESSION_SECRET ?? "",
    clientId: process.env.GITLAB_OAUTH_CLIENT_ID ?? "",
    clientSecret: process.env.GITLAB_OAUTH_CLIENT_SECRET ?? "",
  };
}

/** In production, fail fast if owner auth is not fully configured. */
export function assertAuthConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  const c = authConfig();
  const missing: string[] = [];
  if (!c.sessionSecret || c.sessionSecret.length < 32)
    missing.push("AUTH_SESSION_SECRET (>=32 chars)");
  if (!c.clientId) missing.push("GITLAB_OAUTH_CLIENT_ID");
  if (!c.clientSecret) missing.push("GITLAB_OAUTH_CLIENT_SECRET");
  if (c.ownerAllowlist.length === 0) missing.push("OWNER_ALLOWLIST");
  if (missing.length) {
    throw new Error(
      `Owner auth misconfigured — refusing to boot with data reachable. Missing: ${missing.join(", ")}`,
    );
  }
}
```

- [ ] **Step 4: Implement `src/lib/auth/providers.ts`**

```ts
import { authConfig } from "./config";

export interface AuthProvider {
  buildAuthorizeUrl(a: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
  }): string;
  exchangeCode(a: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<string>;
  /** Returns a stable identity string (e.g. GitLab numeric id). */
  fetchIdentity(accessToken: string): Promise<string>;
}

export function isOwner(identity: string, allowlist: string[]): boolean {
  const id = identity.trim().toLowerCase();
  if (!id) return false;
  return allowlist.some((a) => a.trim().toLowerCase() === id);
}

const GITLAB = "https://gitlab.com";

const gitlabProvider: AuthProvider = {
  buildAuthorizeUrl({ redirectUri, state, codeChallenge }) {
    const { clientId } = authConfig();
    const u = new URL(`${GITLAB}/oauth/authorize`);
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "read_user");
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    return u.toString();
  },
  async exchangeCode({ code, codeVerifier, redirectUri }) {
    const { clientId, clientSecret } = authConfig();
    const res = await fetch(`${GITLAB}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });
    if (!res.ok) throw new Error(`GitLab token exchange failed (${res.status})`);
    const data = (await res.json()) as { access_token: string };
    return data.access_token;
  },
  async fetchIdentity(accessToken) {
    const res = await fetch(`${GITLAB}/api/v4/user`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`GitLab user fetch failed (${res.status})`);
    const data = (await res.json()) as { id: number };
    return String(data.id);
  },
};

export function getAuthProvider(): AuthProvider {
  const { provider } = authConfig();
  switch (provider) {
    case "gitlab":
      return gitlabProvider;
    default:
      throw new Error(`Unsupported AUTH_PROVIDER: ${provider}`);
  }
}
```

- [ ] **Step 5: Run to verify PASS**

Run: `npm test -- providers`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth/config.ts src/lib/auth/providers.ts src/lib/auth/providers.test.ts
git commit -m "feat(auth): config-driven auth provider (GitLab) + owner allowlist"
```

---

### Task 4: Workspace data model + backfill migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_workspaces/migration.sql` (generated)
- Modify: `src/lib/constants.ts`

**Interfaces:**
- Produces: `Workspace` model; `workspaceId` on all user-data models; `OWNER_WORKSPACE_ID = "owner"` and `WorkspaceKind` constants in `constants.ts`.

- [ ] **Step 1: Add constants to `src/lib/constants.ts`**

Append:

```ts
export const OWNER_WORKSPACE_ID = "owner";

export const WorkspaceKind = {
  Owner: "owner",
  Guest: "guest",
} as const;
export type WorkspaceKind = (typeof WorkspaceKind)[keyof typeof WorkspaceKind];
```

- [ ] **Step 2: Edit `prisma/schema.prisma` — add the `Workspace` model**

Add after the `datasource` block:

```prisma
// ── Workspaces (owner = private singleton "owner"; guests = ephemeral) ─────
model Workspace {
  id        String   @id @default(uuid())
  kind      String   @default("guest") // owner | guest
  createdAt DateTime @default(now())
  lastSeenAt DateTime @default(now())

  @@index([lastSeenAt])
}
```

- [ ] **Step 3: Add `workspaceId` to user-data models in `prisma/schema.prisma`**

Add `workspaceId String` + `@@index([workspaceId])` to: `BrainDumpItem`, `Task`, `FocusSession`, `RewardEvent`, `StreakRecord`, `Badge`. For the singleton-style models, add a **unique** `workspaceId`:
- `Settings`: add `workspaceId String @unique` (keep existing `id`).
- `Streak`: add `workspaceId String @unique`.
Change composite uniqueness:
- `DayRollup`: remove `@unique` from `date`; add `workspaceId String` and `@@unique([workspaceId, date])`.
- `DailySpark`: remove `@unique` from `date`; add `workspaceId String` and `@@unique([workspaceId, date])`.
- `Badge`: remove `@unique` from `key`; add `@@unique([workspaceId, key])`.

(Child models `Step`, `BreakdownTurn` are scoped via their parent `Task` — do **not** add `workspaceId` to them.)

- [ ] **Step 4: Create the migration WITHOUT applying, so we can inject backfill SQL**

Run: `npx prisma migrate dev --create-only --name workspaces`
Expected: a new folder `prisma/migrations/<ts>_workspaces/migration.sql` is created (not yet applied).

- [ ] **Step 5: Prepend backfill SQL to the generated `migration.sql`**

The generated file will add columns as `NOT NULL` with no default and fail on existing rows. Edit it so the sequence is: (a) create `Workspace` table (leave as generated), (b) add columns as **nullable**, (c) seed owner workspace, (d) backfill, (e) set `NOT NULL`, (f) add indexes/uniques. Concretely, ensure the file contains, in order:

```sql
-- 1. Workspace table (generated CREATE TABLE "Workspace" ... stays first)

-- 2. Seed the owner workspace
INSERT INTO "Workspace" ("id","kind","createdAt","lastSeenAt")
VALUES ('owner','owner', now(), now())
ON CONFLICT ("id") DO NOTHING;

-- 3. Add workspaceId as NULLABLE first (edit each generated ADD COLUMN to allow null)
ALTER TABLE "BrainDumpItem" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "Task"          ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "FocusSession"  ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "RewardEvent"   ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "StreakRecord"  ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "Badge"         ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "DayRollup"     ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "DailySpark"    ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "Settings"      ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "Streak"        ADD COLUMN "workspaceId" TEXT;

-- 4. Backfill every existing row to the owner workspace
UPDATE "BrainDumpItem" SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;
UPDATE "Task"          SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;
UPDATE "FocusSession"  SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;
UPDATE "RewardEvent"   SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;
UPDATE "StreakRecord"  SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;
UPDATE "Badge"         SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;
UPDATE "DayRollup"     SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;
UPDATE "DailySpark"    SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;
UPDATE "Settings"      SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;
UPDATE "Streak"        SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;

-- 5. Enforce NOT NULL now that data is backfilled
ALTER TABLE "BrainDumpItem" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Task"          ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "FocusSession"  ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "RewardEvent"   ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "StreakRecord"  ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Badge"         ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "DayRollup"     ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "DailySpark"    ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Settings"      ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Streak"        ALTER COLUMN "workspaceId" SET NOT NULL;

-- 6. Keep the generated DROP INDEX for old @unique(date/key) and the new
--    CREATE UNIQUE INDEX for (workspaceId,date)/(workspaceId,key)/Settings/Streak,
--    and CREATE INDEX on workspaceId + Workspace(lastSeenAt).
```

Delete any generated `ADD COLUMN "workspaceId" TEXT NOT NULL` lines that duplicate step 3 (avoid double-add).

- [ ] **Step 6: Apply the migration against local Postgres**

Run: `docker compose up -d db && npx prisma migrate dev`
Expected: "Migration applied"; `npx prisma generate` runs. No data-loss prompt.

- [ ] **Step 7: Verify backfill**

Run:
```bash
docker compose exec -T db psql -U dlectroflow -d dlectroflow -c "SELECT count(*) FROM \"BrainDumpItem\" WHERE \"workspaceId\"<>'owner';"
```
Expected: `0`.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/constants.ts
git commit -m "feat(db): add Workspace model + workspaceId scoping + backfill migration"
```

---

### Task 5: Workspace resolver

Resolves the active workspace id from request cookies. Owner cookie → `"owner"`. Guest cookie → its `wsId`. Also creates/touches the `Workspace` row.

**Files:**
- Create: `src/lib/workspace.ts`
- Create: `src/lib/workspace.test.ts`

**Interfaces:**
- Consumes: `verifySession`, `OWNER_COOKIE`, `GUEST_COOKIE` (Task 2); `authConfig` (Task 3); `OWNER_WORKSPACE_ID` (Task 4); `prisma` (`src/lib/db.ts`).
- Produces:
  - `function resolveWorkspaceId(cookies: { owner?: string; guest?: string; header?: string }): Promise<string>` — pure-ish (secret from config), verifies owner first, else guest, else header (middleware-forwarded first-request value), else throws `MissingWorkspaceError`.
  - `class MissingWorkspaceError extends Error`
  - `async function currentWorkspaceId(): Promise<string>` — reads `next/headers` `cookies()`/`headers()`, calls `resolveWorkspaceId`, then `touchWorkspace(id)`.
  - `async function touchWorkspace(id: string): Promise<void>` — upserts Workspace row, sets `lastSeenAt=now()`.

- [ ] **Step 1: Write failing test `src/lib/workspace.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { resolveWorkspaceId, MissingWorkspaceError } from "./workspace";
import { signSession } from "./auth/session";

const SECRET = "test-secret-at-least-32-bytes-long-xxxxx";
beforeEach(() => {
  process.env.AUTH_SESSION_SECRET = SECRET;
});

describe("resolveWorkspaceId", () => {
  it("returns 'owner' for a valid owner cookie", async () => {
    const owner = await signSession({ kind: "owner", sub: "1" }, SECRET);
    expect(await resolveWorkspaceId({ owner })).toBe("owner");
  });

  it("returns the guest wsId for a valid guest cookie", async () => {
    const guest = await signSession({ kind: "guest", wsId: "g-123" }, SECRET);
    expect(await resolveWorkspaceId({ guest })).toBe("g-123");
  });

  it("prefers owner over guest", async () => {
    const owner = await signSession({ kind: "owner", sub: "1" }, SECRET);
    const guest = await signSession({ kind: "guest", wsId: "g-1" }, SECRET);
    expect(await resolveWorkspaceId({ owner, guest })).toBe("owner");
  });

  it("falls back to the forwarded header", async () => {
    expect(await resolveWorkspaceId({ header: "g-hdr" })).toBe("g-hdr");
  });

  it("throws when nothing resolves", async () => {
    await expect(resolveWorkspaceId({})).rejects.toBeInstanceOf(
      MissingWorkspaceError,
    );
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npm test -- workspace`
Expected: FAIL (cannot find `./workspace`).

- [ ] **Step 3: Implement `src/lib/workspace.ts`**

```ts
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/db";
import {
  verifySession,
  OWNER_COOKIE,
  GUEST_COOKIE,
  GUEST_WS_HEADER,
} from "@/lib/auth/session";
import { authConfig } from "@/lib/auth/config";
import { OWNER_WORKSPACE_ID } from "@/lib/constants";

export class MissingWorkspaceError extends Error {
  constructor() {
    super("No workspace context on request");
    this.name = "MissingWorkspaceError";
  }
}

export async function resolveWorkspaceId(input: {
  owner?: string;
  guest?: string;
  header?: string;
}): Promise<string> {
  const { sessionSecret } = authConfig();
  if (input.owner) {
    const p = await verifySession(input.owner, sessionSecret);
    if (p?.kind === "owner") return OWNER_WORKSPACE_ID;
  }
  if (input.guest) {
    const p = await verifySession(input.guest, sessionSecret);
    if (p?.kind === "guest") return p.wsId;
  }
  if (input.header) return input.header;
  throw new MissingWorkspaceError();
}

export async function touchWorkspace(id: string): Promise<void> {
  const kind = id === OWNER_WORKSPACE_ID ? "owner" : "guest";
  await prisma.workspace.upsert({
    where: { id },
    create: { id, kind, lastSeenAt: new Date() },
    update: { lastSeenAt: new Date() },
  });
}

export async function currentWorkspaceId(): Promise<string> {
  const jar = await cookies();
  const hdrs = await headers();
  const id = await resolveWorkspaceId({
    owner: jar.get(OWNER_COOKIE)?.value,
    guest: jar.get(GUEST_COOKIE)?.value,
    header: hdrs.get(GUEST_WS_HEADER) ?? undefined,
  });
  await touchWorkspace(id);
  return id;
}

export async function isOwnerRequest(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(OWNER_COOKIE)?.value;
  if (!token) return false;
  const p = await verifySession(token, authConfig().sessionSecret);
  return p?.kind === "owner";
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `npm test -- workspace`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workspace.ts src/lib/workspace.test.ts
git commit -m "feat(auth): workspace resolver (owner/guest/header)"
```

---

### Task 6: Middleware — issue guest cookie, gate owner-only paths

**Files:**
- Create: `src/middleware.ts`
- Create: `src/lib/auth/gate.ts`
- Create: `src/lib/auth/gate.test.ts`

**Interfaces:**
- Consumes: `verifySession`, cookie names (Task 2); `authConfig` (Task 3); `GUEST_WS_HEADER` (Task 5).
- Produces (`gate.ts`, pure decision logic so it is unit-testable without a NextRequest):
  - `const PUBLIC_PREFIXES: string[]` and `const OWNER_ONLY_PREFIXES: string[]`
  - `function isPublicPath(pathname: string): boolean`
  - `function isOwnerOnlyPath(pathname: string): boolean`

- [ ] **Step 1: Write failing test `src/lib/auth/gate.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { isPublicPath, isOwnerOnlyPath } from "./gate";

describe("gate paths", () => {
  it("health is public", () => {
    expect(isPublicPath("/api/health")).toBe(true);
  });
  it("login + auth routes are public", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/auth/gitlab/callback")).toBe(true);
  });
  it("app root is not public", () => {
    expect(isPublicPath("/inbox")).toBe(false);
  });
  it("integration oauth is owner-only", () => {
    expect(isOwnerOnlyPath("/api/google/oauth/start")).toBe(true);
    expect(isOwnerOnlyPath("/api/reclaim/oauth/callback")).toBe(true);
  });
  it("inbox is not owner-only", () => {
    expect(isOwnerOnlyPath("/inbox")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npm test -- gate`
Expected: FAIL.

- [ ] **Step 3: Implement `src/lib/auth/gate.ts`**

```ts
export const PUBLIC_PREFIXES = ["/api/health", "/login", "/api/auth/"];

// Integration connect/callback routes touch the owner's global Google/Reclaim
// tokens — guests must never reach them.
export const OWNER_ONLY_PREFIXES = [
  "/api/google/oauth/",
  "/api/reclaim/oauth/",
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p),
  );
}

export function isOwnerOnlyPath(pathname: string): boolean {
  return OWNER_ONLY_PREFIXES.some((p) => pathname.startsWith(p));
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `npm test -- gate`
Expected: 5 passed.

- [ ] **Step 5: Implement `src/middleware.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import {
  verifySession,
  OWNER_COOKIE,
  GUEST_COOKIE,
  GUEST_WS_HEADER,
} from "@/lib/auth/session";
import { authConfig } from "@/lib/auth/config";
import { isPublicPath, isOwnerOnlyPath } from "@/lib/auth/gate";

export const config = {
  // Skip Next internals + static assets; run on everything else.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.\\w+$).*)"],
};

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const { sessionSecret } = authConfig();

  const ownerToken = req.cookies.get(OWNER_COOKIE)?.value;
  const ownerPayload = ownerToken
    ? await verifySession(ownerToken, sessionSecret)
    : null;
  const isOwner = ownerPayload?.kind === "owner";

  // Owner-only paths: block guests.
  if (isOwnerOnlyPath(pathname) && !isOwner) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  if (isPublicPath(pathname)) return NextResponse.next();

  // Owner passes through untouched.
  if (isOwner) return NextResponse.next();

  // Guest: ensure a guest workspace cookie exists; forward its id so the
  // SAME request's server components/actions can resolve it immediately.
  let guestToken = req.cookies.get(GUEST_COOKIE)?.value;
  let wsId: string | null = null;
  if (guestToken) {
    const p = await verifySession(guestToken, sessionSecret);
    if (p?.kind === "guest") wsId = p.wsId;
  }
  if (!wsId) {
    wsId = crypto.randomUUID();
    // Sign inline (Edge-compatible via jose used in verifySession's module).
    const { SignJWT } = await import("jose");
    guestToken = await new SignJWT({ kind: "guest", wsId })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(new TextEncoder().encode(sessionSecret));
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(GUEST_WS_HEADER, wsId);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.cookies.set(GUEST_COOKIE, guestToken!, {
    httpOnly: true,
    secure: req.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
```

- [ ] **Step 6: Verify build compiles**

Run: `npm run build`
Expected: build succeeds (middleware compiles for the Edge runtime; `jose` is Edge-safe).

- [ ] **Step 7: Commit**

```bash
git add src/middleware.ts src/lib/auth/gate.ts src/lib/auth/gate.test.ts
git commit -m "feat(auth): middleware issues guest workspace + gates owner-only paths"
```

---

### Task 7: GitLab login routes + login page + logout

**Files:**
- Create: `src/app/api/auth/gitlab/start/route.ts`
- Create: `src/app/api/auth/gitlab/callback/route.ts`
- Create: `src/app/api/auth/logout/route.ts`
- Create: `src/app/login/page.tsx`

**Interfaces:**
- Consumes: `getAuthProvider`, `isOwner`, `authConfig` (Task 3); `signSession`, `OWNER_COOKIE` (Task 2); `createPkce`, `randomState` (`src/lib/reclaim.ts`); `requestOrigin` (`src/lib/origin.ts`).

- [ ] **Step 1: Implement `src/app/api/auth/gitlab/start/route.ts`**

```ts
import { NextResponse } from "next/server";
import { getAuthProvider } from "@/lib/auth/providers";
import { createPkce, randomState } from "@/lib/reclaim";
import { requestOrigin } from "@/lib/origin";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const origin = requestOrigin(req);
  const redirectUri = `${origin}/api/auth/gitlab/callback`;
  const { verifier, challenge } = createPkce();
  const state = randomState();
  const res = NextResponse.redirect(
    getAuthProvider().buildAuthorizeUrl({
      redirectUri,
      state,
      codeChallenge: challenge,
    }),
  );
  const opts = {
    httpOnly: true,
    secure: origin.startsWith("https"),
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  };
  res.cookies.set("gitlab_pkce_verifier", verifier, opts);
  res.cookies.set("gitlab_oauth_state", state, opts);
  return res;
}
```

- [ ] **Step 2: Implement `src/app/api/auth/gitlab/callback/route.ts`**

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthProvider, isOwner } from "@/lib/auth/providers";
import { authConfig } from "@/lib/auth/config";
import { signSession, OWNER_COOKIE } from "@/lib/auth/session";
import { requestOrigin } from "@/lib/origin";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const origin = requestOrigin(req);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const jar = await cookies();
  const expectedState = jar.get("gitlab_oauth_state")?.value;
  const verifier = jar.get("gitlab_pkce_verifier")?.value;

  const fail = (reason: string) => {
    const res = NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(reason)}`,
    );
    res.cookies.delete("gitlab_oauth_state");
    res.cookies.delete("gitlab_pkce_verifier");
    return res;
  };

  if (oauthError) return fail(oauthError);
  if (!code || !state || !verifier) return fail("missing_oauth_params");
  if (state !== expectedState) return fail("state_mismatch");

  let identity: string;
  try {
    const provider = getAuthProvider();
    const token = await provider.exchangeCode({
      code,
      codeVerifier: verifier,
      redirectUri: `${origin}/api/auth/gitlab/callback`,
    });
    identity = await provider.fetchIdentity(token);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "auth_failed");
  }

  const { ownerAllowlist, sessionSecret } = authConfig();
  if (!isOwner(identity, ownerAllowlist)) return fail("not_authorized");

  const session = await signSession({ kind: "owner", sub: identity }, sessionSecret);
  const res = NextResponse.redirect(`${origin}/inbox`);
  res.cookies.set(OWNER_COOKIE, session, {
    httpOnly: true,
    secure: origin.startsWith("https"),
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  res.cookies.delete("gitlab_oauth_state");
  res.cookies.delete("gitlab_pkce_verifier");
  return res;
}
```

- [ ] **Step 3: Implement `src/app/api/auth/logout/route.ts`**

```ts
import { NextResponse } from "next/server";
import { OWNER_COOKIE } from "@/lib/auth/session";
import { requestOrigin } from "@/lib/origin";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const res = NextResponse.redirect(`${requestOrigin(req)}/inbox`);
  res.cookies.delete(OWNER_COOKIE);
  return res;
}
```

- [ ] **Step 4: Implement `src/app/login/page.tsx`**

```tsx
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-2xl font-semibold">Owner sign-in</h1>
      <p className="text-sm text-muted-foreground">
        This unlocks the private owner workspace. Everyone else can keep using
        the app as a guest.
      </p>
      {error === "not_authorized" ? (
        <p className="text-sm text-red-500">
          That account isn&apos;t the owner of this instance.
        </p>
      ) : error ? (
        <p className="text-sm text-red-500">Sign-in failed: {error}</p>
      ) : null}
      <a
        href="/api/auth/gitlab/start"
        className="rounded-md bg-foreground px-4 py-2 text-background"
      >
        Sign in with GitLab
      </a>
    </main>
  );
}
```

- [ ] **Step 5: Manual verification (local)**

Run: `npm run dev`, set `AUTH_PROVIDER=gitlab`, `OWNER_ALLOWLIST=1234567`, `AUTH_SESSION_SECRET`, `GITLAB_OAUTH_CLIENT_ID/SECRET` in `.env.local`, visit `http://localhost:3000/login`, complete GitLab OAuth.
Expected: redirects to `/inbox`; `df_owner` cookie present.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/auth src/app/login
git commit -m "feat(auth): GitLab login/callback/logout routes + login page"
```

---

### Task 8: Scope the shared data layer (db + lib helpers)

Thread `workspaceId` through the shared helpers so callers must pass it.

**Files:**
- Modify: `src/lib/db.ts`
- Modify: `src/lib/rewards.ts`
- Modify: `src/lib/rollup.ts`
- Modify: `src/lib/spark.ts`

**Interfaces:**
- Produces (new required first parameter `workspaceId: string`):
  - `getSettings(workspaceId)`, `getStreak(workspaceId)`
  - `rewards.ts`: every exported function that reads/writes gains `workspaceId` as its first arg and adds `where:{ workspaceId }` / `data:{ workspaceId }` to each query listed in the inventory.
  - `rollup.ts`, `spark.ts`: same pattern.

- [ ] **Step 1: Update `src/lib/db.ts` helpers**

```ts
/** Fetch (creating on first use) the Settings row for a workspace. */
export function getSettings(workspaceId: string) {
  return prisma.settings.upsert({
    where: { workspaceId },
    create: { workspaceId },
    update: {},
  });
}

/** Fetch (creating on first use) the Streak row for a workspace. */
export function getStreak(workspaceId: string) {
  return prisma.streak.upsert({
    where: { workspaceId },
    create: { workspaceId },
    update: {},
  });
}
```

(Remove the now-unused `SINGLETON_ID` import if nothing else in the file uses it.)

- [ ] **Step 2: Scope `src/lib/rewards.ts`**

Add `workspaceId: string` as the first parameter to each exported function (`recordReward`, badge helpers, `getDashboardData`, and any streak/inbox-zero helpers). For every query in the inventory, add scoping:
- `prisma.rewardEvent.create` → `data: { ...existing, workspaceId }`
- `prisma.rewardEvent.aggregate/count` → `where: { ...existing, workspaceId }`
- `prisma.brainDumpItem.count` → `where: { ...existing, workspaceId }`
- `prisma.badge.findUnique({ where:{ key } })` → `where: { workspaceId_key: { workspaceId, key } }`
- `prisma.badge.create({ data:{ key } })` → `data: { key, workspaceId }`
- `prisma.badge.findMany` / `prisma.streakRecord.findMany` / `prisma.focusSession.findMany` → add `where: { workspaceId }`
- `prisma.streakRecord.create` → `data: { ...existing, workspaceId }`
- `prisma.streakRecord.aggregate` (`_max.length`) → `where: { workspaceId }`
- `prisma.streak.update` → `where: { workspaceId }`
- `getSettings()` / `getStreak()` calls → pass `workspaceId`.

- [ ] **Step 3: Scope `src/lib/rollup.ts`**

Add `workspaceId` first param to exported functions (`gatherDayData`, `generateTodayRollup`, `getTodayRollup`, `markRollupEmailed`). Scope:
- `prisma.dayRollup.findUnique({ where:{ date } })` → `where: { workspaceId_date: { workspaceId, date } }`
- `prisma.dayRollup.upsert` → `where: { workspaceId_date: { workspaceId, date } }`, `create: { ...existing, workspaceId }`
- `prisma.dayRollup.update` → `where: { workspaceId_date: { workspaceId, date } }`
- `prisma.focusSession.findMany` / `prisma.rewardEvent.aggregate` / `prisma.step.findMany` → add `where: { workspaceId }` (for `step.findMany`, scope via the related task: `where: { task: { workspaceId } }`)
- `getStreak()` → `getStreak(workspaceId)`

- [ ] **Step 4: Scope `src/lib/spark.ts`**

Add `workspaceId` first param. Scope:
- `prisma.dailySpark.findUnique({ where:{ date } })` → `where: { workspaceId_date: { workspaceId, date } }`
- `prisma.dailySpark.upsert` → `where: { workspaceId_date: { workspaceId, date } }`, `create: { ...existing, workspaceId }`

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: errors ONLY at call sites in `actions/` and `app/` pages (fixed in Tasks 9–10). Confirm no errors inside `lib/` itself.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db.ts src/lib/rewards.ts src/lib/rollup.ts src/lib/spark.ts
git commit -m "refactor(scope): thread workspaceId through shared data helpers"
```

---

### Task 9: Scope the server actions

**Files:**
- Modify: `src/app/actions/braindump.ts`
- Modify: `src/app/actions/breakdown.ts`
- Modify: `src/app/actions/focus.ts`
- Modify: `src/app/actions/google-schedule.ts`
- Modify: `src/app/actions/reclaim.ts`
- Modify: `src/app/actions/rollup.ts`
- Modify: `src/app/actions/settings.ts`
- Modify: `src/app/actions/spark.ts`

**Interfaces:**
- Consumes: `currentWorkspaceId` (Task 5); scoped lib helpers (Task 8).
- Pattern: at the top of every exported action, `const workspaceId = await currentWorkspaceId();` then scope each query and pass `workspaceId` to lib calls.

- [ ] **Step 1: Scope `braindump.ts`**

At the top of each action add `const workspaceId = await currentWorkspaceId();`. Then:
- `prisma.brainDumpItem.create({ data:{ text } })` → `data: { text, workspaceId }`
- Every `prisma.brainDumpItem.update/delete/findUnique({ where:{ id } })` → `where: { id, workspaceId }` (use `updateMany`/`deleteMany` when adding a non-unique field to `where`; switch `.update`→`.updateMany`, `.delete`→`.deleteMany`, and treat 0-count as "not found in this workspace").
- `prisma.task.create({ data:{...} })` → add `workspaceId`.
- Any reward/streak lib call → pass `workspaceId`.

Import: `import { currentWorkspaceId } from "@/lib/workspace";`

- [ ] **Step 2: Scope `breakdown.ts`**

- `const workspaceId = await currentWorkspaceId();` at top of each exported action.
- `prisma.brainDumpItem.findUnique({ where:{ id: itemId } })` → `findFirst({ where:{ id: itemId, workspaceId } })`
- `prisma.task.create` → add `workspaceId` to `data`.
- `prisma.brainDumpItem.update({ where:{ id } })` → `updateMany({ where:{ id, workspaceId } })`
- `prisma.task.update({ where:{ id: taskId } })` → guard ownership first: `findFirst({ where:{ id: taskId, workspaceId } })`; if null, throw. Then update by id.
- `prisma.step.deleteMany({ where:{ taskId } })` and `createMany` → unchanged in shape but only after the task-ownership guard above.

- [ ] **Step 3: Scope `focus.ts`**

- `const workspaceId = await currentWorkspaceId();` at top of each exported action.
- `prisma.step.findUnique({ where:{ id: stepId } })` → `findFirst({ where:{ id: stepId, task: { workspaceId } } })`
- `prisma.focusSession.create` → add `workspaceId` to `data`.
- `prisma.focusSession.update/findMany` → add `workspaceId` to `where`.
- `prisma.rewardEvent.count` → add `workspaceId` to `where`.
- `prisma.step.findFirst` (next step) → add `task: { workspaceId }` to `where`.
- `prisma.step.update({ where:{ id } })` → guard via `findFirst({ where:{ id, task:{ workspaceId } } })` then update by id.
- `prisma.task.findUnique({ where:{ id: step.taskId } })` → `findFirst({ where:{ id: step.taskId, workspaceId } })`.
- Pass `workspaceId` to any `rewards`/`getSettings` calls.

- [ ] **Step 4: Scope `google-schedule.ts` and `reclaim.ts`**

These are owner-only (route-gated in Task 6) but still assert it defensively:
- Add at top: `const workspaceId = await currentWorkspaceId(); if (workspaceId !== OWNER_WORKSPACE_ID) throw new Error("owner only");` (import `OWNER_WORKSPACE_ID` from `@/lib/constants`).
- `prisma.task.findUnique({ where:{ id } })` → `findFirst({ where:{ id, workspaceId } })`
- `prisma.step.update({ where:{ id } })` → guard via `findFirst({ where:{ id, task:{ workspaceId } } })` then update by id.

- [ ] **Step 5: Scope `rollup.ts` and `spark.ts` actions**

- `rollup.ts`: `const workspaceId = await currentWorkspaceId();`; `getSettings()` → `getSettings(workspaceId)`; pass `workspaceId` to `generateTodayRollup`/`getTodayRollup`/`markRollupEmailed`.
- `spark.ts` action (if it triggers generation): `const workspaceId = await currentWorkspaceId();` and pass through to the scoped `spark.ts` lib functions.

- [ ] **Step 6: Scope `settings.ts`**

- `const workspaceId = await currentWorkspaceId();` at top of both actions.
- `prisma.settings.upsert({ where:{ id: SINGLETON_ID }, create:{ id: SINGLETON_ID, ... } })` → `where: { workspaceId }, create: { workspaceId, ... }`. Remove the `SINGLETON_ID` import if unused.

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: errors ONLY remain in `app/**/page.tsx` (fixed in Task 10).

- [ ] **Step 8: Commit**

```bash
git add src/app/actions
git commit -m "refactor(scope): workspace-scope all server actions"
```

---

### Task 10: Scope the pages + guest-aware nav

**Files:**
- Modify: `src/app/(app)/inbox/page.tsx`
- Modify: `src/app/(app)/dashboard/page.tsx`
- Modify: `src/app/(app)/focus/[stepId]/page.tsx`
- Modify: `src/app/(app)/tasks/[taskId]/page.tsx`
- Modify: `src/app/(app)/layout.tsx` (add owner/guest indicator: "Sign in" link for guests, "Sign out" for owner)

**Interfaces:**
- Consumes: `currentWorkspaceId`, `isOwnerRequest` (Task 5); scoped lib helpers (Task 8).

- [ ] **Step 1: Scope `inbox/page.tsx`**

- Add `import { currentWorkspaceId } from "@/lib/workspace";` and `const workspaceId = await currentWorkspaceId();`.
- `prisma.brainDumpItem.findMany({ ... })` → add `where: { workspaceId }` (merge with any existing where).
- `getSettings()` → `getSettings(workspaceId)`.

- [ ] **Step 2: Scope `dashboard/page.tsx`**

- `const workspaceId = await currentWorkspaceId();`
- `getSettings()` → `getSettings(workspaceId)`; pass `workspaceId` to `getDashboardData`, `getTodayRollup`, spark generation.

- [ ] **Step 3: Scope `focus/[stepId]/page.tsx`**

- `const workspaceId = await currentWorkspaceId();`
- `prisma.step.findUnique({ where:{ id: stepId } })` → `findFirst({ where:{ id: stepId, task:{ workspaceId } } })`.
- `prisma.step.findFirst({...})` (next step) → add `task: { workspaceId }`.
- `getSettings()` → `getSettings(workspaceId)`.
- If the step is not found (null), render the existing not-found path.

- [ ] **Step 4: Scope `tasks/[taskId]/page.tsx`**

- `const workspaceId = await currentWorkspaceId();`
- `prisma.task.findUnique({ where:{ id: taskId }, include:{...} })` → `findFirst({ where:{ id: taskId, workspaceId }, include:{...} })`.

- [ ] **Step 5: Guest/owner indicator in `(app)/layout.tsx`**

Add near the nav:

```tsx
import { isOwnerRequest } from "@/lib/workspace";
// ... inside the async layout component:
const owner = await isOwnerRequest();
// render:
{owner ? (
  <a href="/api/auth/logout" className="text-xs text-muted-foreground">Sign out</a>
) : (
  <a href="/login" className="text-xs text-muted-foreground">Owner sign in</a>
)}
```

- [ ] **Step 6: Type-check + build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)"
git commit -m "refactor(scope): workspace-scope pages + owner/guest nav"
```

---

### Task 11: Boot guard + config docs

**Files:**
- Create: `src/instrumentation.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `assertAuthConfig` (Task 3).

- [ ] **Step 1: Add `src/instrumentation.ts` (Next runs `register()` at startup)**

```ts
export async function register() {
  const { assertAuthConfig } = await import("@/lib/auth/config");
  assertAuthConfig();
}
```

- [ ] **Step 2: Append auth config to `.env.example`**

```bash
# ── Owner auth (workspace access) ────────────────────────────────────────────
# Owner login gates the private owner workspace; everyone else uses a guest
# sandbox. In production the app refuses to boot if these are unset.
AUTH_PROVIDER=gitlab
# Comma-separated owner identities (GitLab numeric user id for the gitlab provider).
OWNER_ALLOWLIST=
# Random 32+ byte string, e.g. `openssl rand -base64 48`.
AUTH_SESSION_SECRET=
# GitLab OAuth application (Settings → Applications). Redirect URIs:
#   https://<host>/api/auth/gitlab/callback  and  http://localhost:3000/api/auth/gitlab/callback
# Scope: read_user.
GITLAB_OAUTH_CLIENT_ID=
GITLAB_OAUTH_CLIENT_SECRET=

# ── LLM provider seam (future BYO-LLM / self-host) ───────────────────────────
# Only "anthropic" is implemented today; the seam keeps other providers open.
LLM_PROVIDER=anthropic
```

- [ ] **Step 3: Verify prod guard fails without secrets**

Run:
```bash
NODE_ENV=production node -e "import('./src/lib/auth/config.ts').catch(()=>{}); " 2>/dev/null || true
```
(Definitive check is Task 12's build/start smoke.) Confirm `assertAuthConfig` throws when `AUTH_SESSION_SECRET` unset by a quick unit assertion in `providers.test.ts` if desired.

- [ ] **Step 4: Commit**

```bash
git add src/instrumentation.ts .env.example
git commit -m "feat(auth): prod boot guard + document auth/LLM config"
```

---

### Task 12: Cross-workspace isolation integration test + local smoke

The critical security test: data written under one workspace must be invisible to another. Uses the local Postgres.

**Files:**
- Create: `src/lib/__tests__/scoping.integration.test.ts`
- Modify: `vitest.config.ts` (add a `test:integration` path is optional; this test runs under `npm test` and requires `DATABASE_URL`)

**Interfaces:**
- Consumes: `prisma`, scoped helpers.

- [ ] **Step 1: Write the isolation test `src/lib/__tests__/scoping.integration.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";

const A = "test-ws-A";
const B = "test-ws-B";

describe("workspace isolation", () => {
  beforeAll(async () => {
    await prisma.workspace.createMany({
      data: [
        { id: A, kind: "guest" },
        { id: B, kind: "guest" },
      ],
      skipDuplicates: true,
    });
    await prisma.brainDumpItem.create({ data: { text: "secret-A", workspaceId: A } });
  });

  afterAll(async () => {
    await prisma.brainDumpItem.deleteMany({ where: { workspaceId: { in: [A, B] } } });
    await prisma.workspace.deleteMany({ where: { id: { in: [A, B] } } });
    await prisma.$disconnect();
  });

  it("workspace B cannot see workspace A's item", async () => {
    const seen = await prisma.brainDumpItem.findMany({ where: { workspaceId: B } });
    expect(seen).toHaveLength(0);
  });

  it("workspace A sees only its own item", async () => {
    const seen = await prisma.brainDumpItem.findMany({ where: { workspaceId: A } });
    expect(seen.map((i) => i.text)).toEqual(["secret-A"]);
  });
});
```

- [ ] **Step 2: Run against local Postgres**

Run: `docker compose up -d db && npm test -- scoping`
Expected: 2 passed.

- [ ] **Step 3: Local end-to-end smoke**

Run `npm run build && npm run start` with full `.env.local`. Verify:
- `curl -s localhost:3000/api/health` → `{"status":"ok"}` (no cookie).
- Visit `/inbox` in a fresh private window → usable as guest; a `df_guest` cookie is set; add a brain-dump item.
- Complete owner login at `/login` → land on `/inbox` with `df_owner` cookie → your original (backfilled) data is visible, the guest's item is NOT.
- As guest, `curl -s -o /dev/null -w "%{http_code}" localhost:3000/api/google/oauth/start` → `307` redirect to `/login`.

Then `pkill -f next-server` (avoid stale BUILD_ID per project gotcha).

- [ ] **Step 4: Commit**

```bash
git add src/lib/__tests__/scoping.integration.test.ts vitest.config.ts
git commit -m "test: cross-workspace data isolation + smoke checklist"
```

---

## Deployment note (post-merge, owner-run)

Before the first prod deploy of this branch, add to GitLab Secrets Manager:
`AUTH_SESSION_SECRET`, `GITLAB_OAUTH_CLIENT_ID`, `GITLAB_OAUTH_CLIENT_SECRET`,
and set `AUTH_PROVIDER=gitlab`, `OWNER_ALLOWLIST=1234567`. Create a GitLab OAuth
application (redirect `https://dlectroflow.dev/api/auth/gitlab/callback`,
scope `read_user`). The prod boot guard (Task 11) will otherwise refuse to start —
by design, so data is never served ungated. Run `prisma migrate deploy` (the
existing migrate initContainer) to apply the backfill migration.

## Out of scope (later plans)

- **Phase 2:** guest AI daily quota (5/day + global cap), local-only scheduling enforcement for guests, guest banner.
- **Phase 3:** guest workspace 48h TTL cleanup (GitLab schedule → secret-protected purge endpoint) + per-guest item caps.
- **Backlog:** self-serve accounts, BYO-LLM/local-model adapters, per-user integration tokens, git-history secret scan before open-sourcing.
