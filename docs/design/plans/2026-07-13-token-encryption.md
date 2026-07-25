# Token Encryption at Rest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encrypt the Reclaim + Google OAuth token columns at rest with an env-supplied key, so a DB leak alone can't expose usable tokens.

**Architecture:** A pure AES-256-GCM cipher module (`token-cipher.ts`) with a versioned envelope. Writes in `reclaim.ts`/`google.ts` encrypt before persisting; reads decrypt at point of use. A clean-slate migration clears the existing plaintext rows (owner reconnects once). The key comes from `TOKEN_ENC_KEY` (hex, 32 bytes) via env; the prod boot guard enforces it.

**Tech Stack:** Node `crypto` (built-in), Prisma/Postgres, Next 16, Vitest, Helm, GitLab CI.

## Global Constraints

- Spec: `docs/design/specs/2026-07-13-token-encryption-design.md`.
- Branch: `security/encrypt-oauth-tokens` (already exists, spec committed).
- Cipher: AES-256-GCM. Envelope: `"v1:" + base64( iv(12) ‖ authTag(16) ‖ ciphertext )`. Fresh random IV per encrypt.
- Key: `TOKEN_ENC_KEY` = 64 hex chars → 32 bytes. Already provisioned as a masked+hidden+protected CI variable.
- Encrypt ONLY: `ReclaimAuth.clientSecret`, `ReclaimAuth.accessToken`, `ReclaimAuth.refreshToken`, `GoogleAuth.accessToken`, `GoogleAuth.refreshToken`. Never encrypt `clientId`, `redirectUri`, `expiresAt`, `scope`.
- `null` tokens stay `null` (never encrypted or decrypted).
- Decryption REQUIRES the `v1:` envelope (no plaintext passthrough — the migration guarantees every stored value is null or ciphertext).
- TDD: failing test first. `vitest` env is `node`; a fixed test key is seeded in `vitest.setup.ts`. `tsc --noEmit` must stay clean. Commit after each task.
- `SINGLETON_ID = "singleton"`.

---

### Task 1: Cipher module + test seed

**Files:**
- Create: `src/lib/crypto/token-cipher.ts`
- Test: `src/lib/crypto/token-cipher.test.ts`
- Modify: `vitest.setup.ts` (seed a default test key)

**Interfaces:**
- Produces: `encryptToken(plaintext: string): string`, `decryptToken(stored: string): string`, `encryptNullable(v: string | null | undefined): string | null`, `decryptNullable(v: string | null | undefined): string | null`.

- [ ] **Step 1: Seed a default test key** in `vitest.setup.ts` (append after the existing import):

```ts
// Deterministic key so token-cipher tests have a valid TOKEN_ENC_KEY.
// (32 bytes of 0x00 as 64 hex chars.) Individual tests may override/delete it.
process.env.TOKEN_ENC_KEY ??= "0".repeat(64);
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/lib/crypto/token-cipher.test.ts
import { describe, it, expect, afterEach } from "vitest";
import {
  encryptToken,
  decryptToken,
  encryptNullable,
  decryptNullable,
} from "./token-cipher";

const KEY = "0".repeat(64);

afterEach(() => {
  process.env.TOKEN_ENC_KEY = KEY;
});

describe("token-cipher", () => {
  it("round-trips a value", () => {
    const secret = "ya29.a0AfB_reclaim-refresh-token";
    expect(decryptToken(encryptToken(secret))).toBe(secret);
  });

  it("produces a v1 envelope that is not the plaintext", () => {
    const out = encryptToken("hello");
    expect(out.startsWith("v1:")).toBe(true);
    expect(out).not.toContain("hello");
  });

  it("uses a fresh IV each call (same input → different ciphertext)", () => {
    expect(encryptToken("same")).not.toBe(encryptToken("same"));
  });

  it("rejects a tampered payload (auth-tag failure)", () => {
    const out = encryptToken("tamper-me");
    const flipped = out.slice(0, -2) + (out.endsWith("A") ? "B" : "A") + out.slice(-1);
    expect(() => decryptToken(flipped)).toThrow();
  });

  it("rejects a non-v1 / malformed envelope", () => {
    expect(() => decryptToken("plaintext-no-prefix")).toThrow();
    expect(() => decryptToken("v2:whatever")).toThrow();
  });

  it("rejects a key of the wrong length", () => {
    process.env.TOKEN_ENC_KEY = "abcd"; // 2 bytes
    expect(() => encryptToken("x")).toThrow(/32 bytes/);
  });

  it("throws when the key is missing", () => {
    delete process.env.TOKEN_ENC_KEY;
    expect(() => encryptToken("x")).toThrow(/TOKEN_ENC_KEY/);
  });

  it("nullable helpers pass null through and round-trip values", () => {
    expect(encryptNullable(null)).toBeNull();
    expect(encryptNullable(undefined)).toBeNull();
    expect(decryptNullable(null)).toBeNull();
    const enc = encryptNullable("v");
    expect(enc).not.toBeNull();
    expect(decryptNullable(enc)).toBe("v");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/lib/crypto/token-cipher.test.ts`
Expected: FAIL — cannot resolve `./token-cipher`.

- [ ] **Step 4: Implement the module**

```ts
// src/lib/crypto/token-cipher.ts
// AES-256-GCM encryption for OAuth token columns. Pure (no Prisma/SDK imports).
// Envelope: "v1:" + base64( iv(12) | authTag(16) | ciphertext ). See
// docs/design/specs/2026-07-13-token-encryption-design.md.
import crypto from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Load + validate the key on every call (cheap; avoids stale caching in tests). */
function getKey(): Buffer {
  const raw = process.env.TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error("TOKEN_ENC_KEY is not set (64 hex chars required).");
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENC_KEY must decode to ${KEY_BYTES} bytes (64 hex chars); got ${key.length}.`,
    );
  }
  return key;
}

export function encryptToken(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, ct]).toString("base64")}`;
}

export function decryptToken(stored: string): string {
  const sep = stored.indexOf(":");
  const version = sep === -1 ? "" : stored.slice(0, sep);
  const payload = sep === -1 ? "" : stored.slice(sep + 1);
  if (version !== VERSION || !payload) {
    throw new Error("Unrecognized token envelope (expected v1).");
  }
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error("Malformed token envelope.");
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function encryptNullable(v: string | null | undefined): string | null {
  return v ? encryptToken(v) : null;
}

export function decryptNullable(v: string | null | undefined): string | null {
  return v ? decryptToken(v) : null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/crypto/token-cipher.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/crypto/token-cipher.ts src/lib/crypto/token-cipher.test.ts vitest.setup.ts
git commit -m "feat: AES-256-GCM token cipher module (#21 P2)"
```

---

### Task 2: Boot guard requires the key in prod

**Files:**
- Modify: `src/lib/auth/config.ts` (`assertAuthConfig`)
- Test: `src/lib/auth/config.test.ts` (create)

**Interfaces:**
- Consumes: nothing new. Extends existing `assertAuthConfig()` (no signature change).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/auth/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertAuthConfig } from "./config";

const ENV = process.env;
beforeEach(() => {
  process.env = {
    ...ENV,
    NODE_ENV: "production",
    AUTH_SESSION_SECRET: "x".repeat(32),
    GITLAB_OAUTH_CLIENT_ID: "cid",
    GITLAB_OAUTH_CLIENT_SECRET: "csecret",
    OWNER_ALLOWLIST: "123",
    GUEST_IP_HASH_SALT: "y".repeat(16),
    TOKEN_ENC_KEY: "0".repeat(64),
  };
});
afterEach(() => {
  process.env = ENV;
});

describe("assertAuthConfig — TOKEN_ENC_KEY", () => {
  it("passes when all secrets incl. TOKEN_ENC_KEY are present", () => {
    expect(() => assertAuthConfig()).not.toThrow();
  });

  it("throws when TOKEN_ENC_KEY is missing", () => {
    delete process.env.TOKEN_ENC_KEY;
    expect(() => assertAuthConfig()).toThrow(/TOKEN_ENC_KEY/);
  });

  it("throws when TOKEN_ENC_KEY is not 64 hex chars", () => {
    process.env.TOKEN_ENC_KEY = "abc";
    expect(() => assertAuthConfig()).toThrow(/TOKEN_ENC_KEY/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/auth/config.test.ts`
Expected: FAIL — the "missing" and "not 64 hex" cases don't throw yet.

- [ ] **Step 3: Add the check** in `src/lib/auth/config.ts`, inside `assertAuthConfig()`, immediately after the `GUEST_IP_HASH_SALT` check and before `if (missing.length)`:

```ts
  const encKey = process.env.TOKEN_ENC_KEY ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(encKey))
    missing.push("TOKEN_ENC_KEY (64 hex chars)");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/auth/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/config.ts src/lib/auth/config.test.ts
git commit -m "feat: boot guard requires TOKEN_ENC_KEY in prod (#21 P2)"
```

---

### Task 3: Encrypt/decrypt Reclaim tokens

**Files:**
- Modify: `src/lib/reclaim.ts` (`storeTokens`, `ensureClient`, `exchangeCode`, `refreshAccessToken`, `getValidAccessToken`)
- Test: `src/lib/reclaim.test.ts` (create)

**Interfaces:**
- Consumes: `encryptToken`, `decryptNullable` from `@/lib/crypto/token-cipher`.
- Produces: unchanged public signatures (`getValidAccessToken(): Promise<string | null>`, etc.); behavior now encrypts on write / decrypts on read.

- [ ] **Step 1: Write the failing test** (mocks Prisma; asserts ciphertext at rest + plaintext round-trip)

```ts
// src/lib/reclaim.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { decryptToken } from "@/lib/crypto/token-cipher";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    reclaimAuth: {
      upsert: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.reclaimAuth.upsert.mockResolvedValue({ id: "singleton" });
});

describe("reclaim token encryption", () => {
  it("getValidAccessToken decrypts a stored (encrypted) access token", async () => {
    const { encryptToken } = await import("@/lib/crypto/token-cipher");
    prismaMock.reclaimAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: encryptToken("live-access-token"),
      refreshToken: null,
      clientId: "cid",
      clientSecret: null,
      expiresAt: null,
    });
    const { getValidAccessToken } = await import("./reclaim");
    expect(await getValidAccessToken()).toBe("live-access-token");
  });

  it("getValidAccessToken returns null when no token stored", async () => {
    prismaMock.reclaimAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: null,
      refreshToken: null,
      clientId: "cid",
      clientSecret: null,
      expiresAt: null,
    });
    const { getValidAccessToken } = await import("./reclaim");
    expect(await getValidAccessToken()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reclaim.test.ts`
Expected: FAIL — `getValidAccessToken` returns the raw ciphertext, not `"live-access-token"`.

- [ ] **Step 3: Wire encryption into `src/lib/reclaim.ts`.**

Add the import near the top (after the existing imports):

```ts
import { encryptToken, decryptNullable } from "@/lib/crypto/token-cipher";
```

In `storeTokens`, encrypt on write:

```ts
async function storeTokens(t: TokenResponse) {
  const expiresAt = t.expires_in
    ? new Date(Date.now() + t.expires_in * 1000)
    : null;
  await prisma.reclaimAuth.update({
    where: { id: SINGLETON_ID },
    data: {
      accessToken: encryptToken(t.access_token),
      // Reclaim may omit a new refresh_token on refresh — keep the old one.
      ...(t.refresh_token ? { refreshToken: encryptToken(t.refresh_token) } : {}),
      expiresAt,
      scope: t.scope ?? SCOPES,
    },
  });
}
```

In `ensureClient`, encrypt the stored `clientSecret` and decrypt on the cache-hit return path:

```ts
  const auth = await getAuth();
  if (auth.clientId && auth.redirectUri === redirectUri) {
    return { clientId: auth.clientId, clientSecret: decryptNullable(auth.clientSecret) };
  }
```

and in the post-registration `update`:

```ts
    data: {
      clientId: data.client_id,
      clientSecret: data.client_secret ? encryptToken(data.client_secret) : null,
      redirectUri,
      // new client ⇒ any previous tokens are invalid
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
    },
```

(The return at the end of `ensureClient` uses the fresh plaintext `data.client_secret` — leave that as-is; only the persisted value is encrypted.)

In `exchangeCode`, decrypt the client secret before using it:

```ts
  const clientSecret = decryptNullable(auth.clientSecret);
  if (clientSecret) body.set("client_secret", clientSecret);
```

In `refreshAccessToken`, decrypt the refresh token and client secret:

```ts
async function refreshAccessToken(): Promise<string | null> {
  const auth = await getAuth();
  const refreshToken = decryptNullable(auth.refreshToken);
  if (!auth.clientId || !refreshToken) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: auth.clientId,
  });
  const clientSecret = decryptNullable(auth.clientSecret);
  if (clientSecret) body.set("client_secret", clientSecret);
  // ...unchanged fetch + storeTokens...
}
```

In `getValidAccessToken`, decrypt the stored access token:

```ts
export async function getValidAccessToken(): Promise<string | null> {
  const auth = await getAuth();
  const accessToken = decryptNullable(auth.accessToken);
  if (!accessToken) return null;
  const soon = Date.now() + 60_000;
  if (auth.expiresAt && auth.expiresAt.getTime() <= soon) {
    return (await refreshAccessToken()) ?? null;
  }
  return accessToken;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reclaim.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reclaim.ts src/lib/reclaim.test.ts
git commit -m "feat: encrypt Reclaim tokens + clientSecret at rest (#21 P2)"
```

---

### Task 4: Encrypt/decrypt Google tokens

**Files:**
- Modify: `src/lib/google.ts` (`storeTokens`, `refreshAccessToken`, `getValidAccessToken`)
- Test: `src/lib/google.test.ts` (create)

**Interfaces:**
- Consumes: `encryptToken`, `decryptNullable` from `@/lib/crypto/token-cipher`.
- Produces: unchanged signatures; encrypt on write / decrypt on read.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/google.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    googleAuth: {
      upsert: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("google token encryption", () => {
  it("getValidAccessToken decrypts a stored (encrypted) access token", async () => {
    const { encryptToken } = await import("@/lib/crypto/token-cipher");
    prismaMock.googleAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: encryptToken("google-access-token"),
      refreshToken: null,
      expiresAt: null,
    });
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken()).toBe("google-access-token");
  });

  it("returns null when no token stored", async () => {
    prismaMock.googleAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
    });
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/google.test.ts`
Expected: FAIL — returns ciphertext, not `"google-access-token"`.

- [ ] **Step 3: Wire encryption into `src/lib/google.ts`.**

Add the import (after the existing imports):

```ts
import { encryptToken, decryptNullable } from "@/lib/crypto/token-cipher";
```

In `storeTokens`, encrypt in BOTH the `create` and `update` branches:

```ts
  await prisma.googleAuth.upsert({
    where: { id: SINGLETON_ID },
    create: {
      id: SINGLETON_ID,
      accessToken: encryptToken(t.access_token),
      refreshToken: t.refresh_token ? encryptToken(t.refresh_token) : null,
      expiresAt,
      scope,
    },
    update: {
      accessToken: encryptToken(t.access_token),
      ...(t.refresh_token ? { refreshToken: encryptToken(t.refresh_token) } : {}),
      expiresAt,
      scope,
    },
  });
```

In `refreshAccessToken`, decrypt the refresh token:

```ts
async function refreshAccessToken(): Promise<string | null> {
  const auth = await getAuth();
  const refreshToken = decryptNullable(auth.refreshToken);
  if (!refreshToken) return null;
  const { clientId, clientSecret } = googleClient();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  // ...unchanged fetch + storeTokens...
}
```

In `getValidAccessToken`, decrypt the stored access token:

```ts
export async function getValidAccessToken(): Promise<string | null> {
  const auth = await getAuth();
  const accessToken = decryptNullable(auth.accessToken);
  if (!accessToken) return null;
  const soon = Date.now() + 60_000;
  if (auth.expiresAt && auth.expiresAt.getTime() <= soon) {
    return (await refreshAccessToken()) ?? null;
  }
  return accessToken;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/google.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/google.ts src/lib/google.test.ts
git commit -m "feat: encrypt Google tokens at rest (#21 P2)"
```

---

### Task 5: Clean-slate migration (clear plaintext token rows)

**Files:**
- Create: `prisma/migrations/20260713170000_clear_oauth_tokens_for_encryption/migration.sql`

**Interfaces:** none (data migration).

- [ ] **Step 1: Create the migration SQL**

```sql
-- Clean slate for #21 P2 (token encryption): drop the singleton OAuth rows so
-- no plaintext token survives the transition. getAuth() re-upserts an empty
-- row on next access; the owner reconnects Google + Reclaim once, and all new
-- writes are encrypted. Reclaim rows are removed entirely so ensureClient()
-- re-registers a fresh client (its clientSecret is encrypted from birth).
DELETE FROM "ReclaimAuth";
DELETE FROM "GoogleAuth";
```

- [ ] **Step 2: Apply against the local dev DB and verify it runs clean**

Run: `npx prisma migrate deploy`
Expected: applies `20260713170000_clear_oauth_tokens_for_encryption`, no error. (If the local dev server is running, restart it after — stale Prisma client.)

- [ ] **Step 3: Confirm the schema is unchanged (DML only)**

Run: `npx prisma migrate status`
Expected: "Database schema is up to date!" — and `git status` shows only the new migration file (no `schema.prisma` diff).

- [ ] **Step 4: Commit**

```bash
git add prisma/migrations/20260713170000_clear_oauth_tokens_for_encryption/migration.sql
git commit -m "feat: clean-slate migration clears plaintext OAuth tokens (#21 P2)"
```

---

### Task 6: Key delivery — Helm chart, CI, .env.example

**Files:**
- Modify: `charts/dlectroflow/values.yaml`
- Modify: `charts/dlectroflow/templates/secret.yaml`
- Modify: `.gitlab-ci.yml` (`deploy_review`, `deploy_production`)
- Modify: `.env.example`

**Interfaces:** none (config).

- [ ] **Step 1: Add the value** to `charts/dlectroflow/values.yaml`, in the `secrets:` block (after `guestIpHashSalt: ""`):

```yaml
  # #21 P2 — AES-256-GCM key for OAuth token columns (64 hex chars). Boot guard
  # requires it in all envs. Prod: masked+hidden+protected CI var TOKEN_ENC_KEY.
  # Review: dummy generated per-deploy by CI.
  tokenEncKey: ""
```

- [ ] **Step 2: Add the env mapping** to `charts/dlectroflow/templates/secret.yaml`, in the all-envs block (after the `GUEST_IP_HASH_SALT` line):

```yaml
  TOKEN_ENC_KEY: {{ .Values.secrets.tokenEncKey | quote }}
```

- [ ] **Step 3: Wire CI — review dummy key.** In `.gitlab-ci.yml`, in `deploy_review`'s `script:`, add a generation line next to the existing `GUEST_IP_HASH_SALT_REVIEW=...` line. Generate hex from `/dev/urandom` (the deploy image is Alpine and the existing script avoids `openssl` — it uses `/proc/sys/kernel/random/uuid`; `od`/`tr` are busybox built-ins):

```yaml
    - TOKEN_ENC_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
```

and add this flag to the `deploy_review` helm command (e.g. after the `secrets.guestIpHashSalt` line):

```yaml
        --set-string secrets.tokenEncKey="$TOKEN_ENC_KEY"
```

- [ ] **Step 4: Wire CI — prod key.** In `deploy_production`'s helm command, add (after the `secrets.guestIpHashSalt` line):

```yaml
        --set-string secrets.tokenEncKey="$TOKEN_ENC_KEY"
```

(No `secrets:` block entry — `TOKEN_ENC_KEY` is a protected project CI variable, resolved automatically on `main`, matching `AUTH_SESSION_SECRET`.)

- [ ] **Step 5: Document in `.env.example`** (near `GUEST_IP_HASH_SALT`):

```bash
# AES-256-GCM key for OAuth token columns (#21 P2). 64 hex chars.
# Generate: openssl rand -hex 32
TOKEN_ENC_KEY=
```

- [ ] **Step 6: Verify the chart renders both ways**

Run:
```bash
helm template t charts/dlectroflow --set env=production --set-string image.tag=test \
  --set-string secrets.tokenEncKey=$(openssl rand -hex 32) 2>&1 | grep TOKEN_ENC_KEY
helm lint charts/dlectroflow --set env=production --set-string image.tag=test --set-string secrets.tokenEncKey=x
```
Expected: the `TOKEN_ENC_KEY:` line renders; `helm lint` → 0 failures.

- [ ] **Step 7: Commit**

```bash
git add charts/dlectroflow/values.yaml charts/dlectroflow/templates/secret.yaml .gitlab-ci.yml .env.example
git commit -m "feat: deliver TOKEN_ENC_KEY via Helm + CI; boot guard enforced (#21 P2)"
```

---

### Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full unit suite**

Run: `npx vitest run`
Expected: all green (existing + the new cipher/config/reclaim/google tests).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: builds clean (cipher module is lazy, so a missing key does not break the build).

- [ ] **Step 4: Commit any incidental fixes** (only if Steps 1–3 required changes)

```bash
git add -A
git commit -m "chore: token-encryption verification fixes (#21 P2)"
```

---

## Post-implementation (outside this plan — handled by workflow)

- Open MR → GitLab Duo review → apply sensible notes (with Claude Code attribution) → owner OK → merge.
- On merge, the migrate initContainer clears the token rows and the app boots with the key enforced.
- **Owner action:** reconnect Google + Reclaim once. Verify a subsequent backup dump shows the token columns as `v1:` ciphertext, not plaintext.
- Note in #21 P2 that the related "revoked-token cleanup / status-lies" item is separate and still open.
