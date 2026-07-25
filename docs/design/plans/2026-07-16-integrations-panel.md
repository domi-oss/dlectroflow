# Integrations Panel + invalid_grant Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings gets an Integrations card for Google (connect/reconnect/disconnect with revoke), and dead refresh tokens (`invalid_grant`) clear themselves and surface a reconnect prompt instead of lying.

**Architecture:** One new `needsReconnect` flag on the `GoogleAuth` singleton row; `src/lib/google.ts` owns all token-state transitions (invalid_grant → clear+flag, disconnect → revoke+delete, reconnect → reset); a descriptor-driven `IntegrationsPanel` client component renders status from a server-fetched prop; breakdown-chat consumes the richer status for an inline reconnect CTA.

**Tech Stack:** Next 16 App Router (server components + server actions), Prisma 6 (Postgres), vitest + RTL (jsdom), existing AES-256-GCM token cipher.

## Global Constraints

- Next.js 16 has breaking changes vs training data — check `node_modules/next/dist/docs/` before using unfamiliar Next APIs. `params` is async.
- Prisma 6 pinned (NOT 7). After `prisma migrate dev`, the running dev server holds a stale client — tell the owner to restart it.
- Tokens are encrypted at rest: writes go through `encryptToken()`, reads through `decryptNullable()` (`@/lib/crypto/token-cipher`). Never store or log plaintext tokens.
- Owner gating pattern: `const workspaceId = await currentWorkspaceId(); if (workspaceId !== OWNER_WORKSPACE_ID) throw new Error("owner only");`
- All tests: `npx vitest run <file>`; full gate before MR: `npx tsc --noEmit && npm run lint && npx vitest run && npm run build`.
- Copy rule (#22): user-facing scheduling copy says **Google Tasks**; Reclaim appears only as "a Reclaim-synced list is scheduled automatically".
- Branch: `feat/integrations-panel` (exists, holds the spec). Commit after every green test cycle. Do not push `main`.

---

### Task 1: Schema — `needsReconnect` flag

**Files:**
- Modify: `prisma/schema.prisma:73-80` (model GoogleAuth)

**Interfaces:**
- Produces: `GoogleAuth.needsReconnect: boolean` (default `false`) — read/written by Tasks 2–4, surfaced by Task 3.

- [ ] **Step 1: Add the column**

```prisma
model GoogleAuth {
  id             String    @id @default("singleton")
  accessToken    String?
  refreshToken   String?
  expiresAt      DateTime?
  scope          String?
  needsReconnect Boolean   @default(false)
  updatedAt      DateTime  @updatedAt
}
```

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --name google_needs_reconnect`
Expected: new folder `prisma/migrations/*_google_needs_reconnect/` containing `ALTER TABLE "GoogleAuth" ADD COLUMN "needsReconnect" BOOLEAN NOT NULL DEFAULT false;`
(Requires the local dev DB: `docker compose up -d db` if not running. Remind the owner to restart any running dev server afterward.)

- [ ] **Step 3: Commit**

```bash
git add prisma/
git commit -m "feat(schema): GoogleAuth.needsReconnect flag for invalid_grant cleanup"
```

---

### Task 2: `invalid_grant` clears tokens and sets the flag

**Files:**
- Modify: `src/lib/google.ts` (function `refreshAccessToken`, ~line 118)
- Test: `src/lib/google.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `prisma.googleAuth.update` (mock exists), `TokenResponse`, existing `getAuth()`.
- Produces: refresh failure semantics used by Task 5 — after an `invalid_grant`, `getValidAccessToken()` returns `null` AND the row has `accessToken/refreshToken/expiresAt = null, needsReconnect = true`.

- [ ] **Step 1: Extend the prisma mock, write the failing tests**

In `src/lib/google.test.ts`, the hoisted mock needs `update` (already present). Append:

```ts
describe("invalid_grant handling", () => {
  function connectedRow() {
    const { encryptToken } = require("@/lib/crypto/token-cipher");
    return {
      id: "singleton",
      accessToken: encryptToken("stale-at"),
      refreshToken: encryptToken("dead-rt"),
      expiresAt: new Date(Date.now() - 1000), // forces refresh path
      needsReconnect: false,
    };
  }

  it("clears tokens and sets needsReconnect on invalid_grant", async () => {
    process.env.GOOGLE_CLIENT_ID = "google-cid";
    process.env.GOOGLE_CLIENT_SECRET = "google-csecret";
    prismaMock.googleAuth.upsert.mockResolvedValue(connectedRow());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant" }),
      }),
    );
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken()).toBeNull();
    expect(prismaMock.googleAuth.update).toHaveBeenCalledWith({
      where: { id: "singleton" },
      data: { accessToken: null, refreshToken: null, expiresAt: null, needsReconnect: true },
    });
  });

  it("leaves stored tokens untouched on transient refresh errors", async () => {
    process.env.GOOGLE_CLIENT_ID = "google-cid";
    process.env.GOOGLE_CLIENT_SECRET = "google-csecret";
    prismaMock.googleAuth.upsert.mockResolvedValue(connectedRow());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: "temporarily_unavailable" }),
      }),
    );
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken()).toBeNull();
    expect(prismaMock.googleAuth.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify both fail**

Run: `npx vitest run src/lib/google.test.ts`
Expected: FAIL — update not called with that shape (first test); second may pass already, keep it as regression.

- [ ] **Step 3: Implement in `refreshAccessToken`**

Replace the `if (!res.ok) return null;` in `refreshAccessToken` with:

```ts
  if (!res.ok) {
    let errCode: string | undefined;
    try {
      errCode = ((await res.json()) as { error?: string }).error;
    } catch {
      /* non-JSON error body — treat as transient */
    }
    if (errCode === "invalid_grant") {
      // The refresh token is dead (revoked/expired). Presence of stale tokens
      // is what makes `connected` lie — clear them and flag for reconnect.
      await prisma.googleAuth.update({
        where: { id: "singleton" },
        data: { accessToken: null, refreshToken: null, expiresAt: null, needsReconnect: true },
      });
    }
    return null;
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/google.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/google.ts src/lib/google.test.ts
git commit -m "feat(google): invalid_grant clears tokens and flags needsReconnect"
```

---

### Task 3: Status exposes the flag; reconnect heals it

**Files:**
- Modify: `src/lib/google.ts` (`getGoogleStatus` ~line 151, `storeTokens` ~line 75)
- Test: `src/lib/google.test.ts` (append)

**Interfaces:**
- Produces: `getGoogleStatus(): Promise<{ configured: boolean; connected: boolean; needsReconnect: boolean }>` — consumed by Tasks 5, 6, 7, 8.

- [ ] **Step 1: Failing tests**

```ts
describe("status + reconnect healing", () => {
  it("getGoogleStatus surfaces needsReconnect", async () => {
    prismaMock.googleAuth.upsert.mockResolvedValue({
      id: "singleton", accessToken: null, refreshToken: null,
      expiresAt: null, needsReconnect: true,
    });
    const { getGoogleStatus } = await import("./google");
    expect(await getGoogleStatus()).toMatchObject({ connected: false, needsReconnect: true });
  });

  it("storeTokens resets needsReconnect", async () => {
    process.env.GOOGLE_CLIENT_ID = "google-cid";
    process.env.GOOGLE_CLIENT_SECRET = "google-csecret";
    prismaMock.googleAuth.upsert.mockResolvedValue({ id: "singleton" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "g-at", refresh_token: "g-rt", expires_in: 3600 }),
      }),
    );
    const { exchangeCode } = await import("./google");
    await exchangeCode({ code: "c", redirectUri: "u", codeVerifier: "v" });
    const call = prismaMock.googleAuth.upsert.mock.calls.at(-1)![0];
    expect(call.update.needsReconnect).toBe(false);
    expect(call.create.needsReconnect).toBe(false);
  });
});
```

(If `exchangeCode`'s signature in `src/lib/google.ts` differs — check the existing
"exchangeCode persists encrypted tokens" test in this file and mirror its call exactly.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/google.test.ts` → FAIL.

- [ ] **Step 3: Implement**

In `getGoogleStatus` return `needsReconnect: Boolean(auth.needsReconnect)` alongside the
existing fields. In `storeTokens`, add `needsReconnect: false` to BOTH the `update` and
`create` branches of the upsert.

- [ ] **Step 4: Run tests** — PASS. **Step 5: Commit**

```bash
git add src/lib/google.ts src/lib/google.test.ts
git commit -m "feat(google): status surfaces needsReconnect; reconnect heals the flag"
```

---

### Task 4: `disconnectGoogle` — revoke best-effort, delete always

**Files:**
- Modify: `src/lib/google.ts` (new exported function)
- Test: `src/lib/google.test.ts` (append; add `deleteMany: vi.fn()` to the hoisted `googleAuth` mock)

**Interfaces:**
- Produces: `disconnectGoogle(): Promise<void>` — consumed by Task 5's server action.

- [ ] **Step 1: Failing tests**

```ts
describe("disconnectGoogle", () => {
  it("revokes the refresh token then deletes the row", async () => {
    const { encryptToken } = await import("@/lib/crypto/token-cipher");
    prismaMock.googleAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: encryptToken("at"), refreshToken: encryptToken("rt"),
      expiresAt: null, needsReconnect: false,
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const { disconnectGoogle } = await import("./google");
    await disconnectGoogle();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({ method: "POST" }),
    );
    expect(String(fetchMock.mock.calls[0][1].body)).toContain("token=rt");
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalled();
  });

  it("still deletes when revoke fails", async () => {
    const { encryptToken } = await import("@/lib/crypto/token-cipher");
    prismaMock.googleAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: encryptToken("at"), refreshToken: null,
      expiresAt: null, needsReconnect: false,
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net down")));
    const { disconnectGoogle } = await import("./google");
    await expect(disconnectGoogle()).resolves.toBeUndefined();
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalled();
  });

  it("is a no-op-safe delete when nothing is stored", async () => {
    prismaMock.googleAuth.upsert.mockResolvedValue({
      id: "singleton", accessToken: null, refreshToken: null,
      expiresAt: null, needsReconnect: false,
    });
    vi.stubGlobal("fetch", vi.fn());
    const { disconnectGoogle } = await import("./google");
    await disconnectGoogle();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL with "disconnectGoogle is not a function".

- [ ] **Step 3: Implement** (in `src/lib/google.ts`, after `getGoogleStatus`)

```ts
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/**
 * Disconnect Google: best-effort server-side revoke (refresh token preferred —
 * revoking it kills the whole grant), then delete the stored row regardless.
 * Idempotent; revoke failures must never keep dead tokens around.
 */
export async function disconnectGoogle(): Promise<void> {
  const auth = await getAuth();
  const token = decryptNullable(auth.refreshToken) ?? decryptNullable(auth.accessToken);
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
  await prisma.googleAuth.deleteMany({ where: { id: "singleton" } });
}
```

- [ ] **Step 4: Run tests** — PASS. **Step 5: Commit**

```bash
git add src/lib/google.ts src/lib/google.test.ts
git commit -m "feat(google): disconnectGoogle — best-effort revoke, guaranteed delete"
```

---

### Task 5: Server action + `reconnect_required` push reason

**Files:**
- Create: `src/app/actions/integrations.ts`
- Modify: `src/app/actions/google-schedule.ts:20-24` (failure union) and the `not_connected` return (~line 58)
- Test: `src/app/actions/integrations.test.ts`

**Interfaces:**
- Consumes: `disconnectGoogle()` (Task 4), `currentWorkspaceId` from `@/lib/workspace`, `OWNER_WORKSPACE_ID` from `@/lib/constants`.
- Produces: `disconnectGoogleAction(): Promise<{ ok: true }>` (throws "owner only" otherwise) — used by Task 6. Push failure union gains `"reconnect_required"` — used by Task 8.

- [ ] **Step 1: Failing test** (`src/app/actions/integrations.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { disconnectMock, workspaceMock } = vi.hoisted(() => ({
  disconnectMock: vi.fn(),
  workspaceMock: vi.fn(),
}));
vi.mock("@/lib/google", () => ({ disconnectGoogle: disconnectMock }));
vi.mock("@/lib/workspace", () => ({ currentWorkspaceId: workspaceMock }));

import { OWNER_WORKSPACE_ID } from "@/lib/constants";
import { disconnectGoogleAction } from "./integrations";

beforeEach(() => vi.clearAllMocks());

describe("disconnectGoogleAction", () => {
  it("disconnects for the owner", async () => {
    workspaceMock.mockResolvedValue(OWNER_WORKSPACE_ID);
    await expect(disconnectGoogleAction()).resolves.toEqual({ ok: true });
    expect(disconnectMock).toHaveBeenCalledOnce();
  });

  it("rejects guests without touching tokens", async () => {
    workspaceMock.mockResolvedValue("guest-ws");
    await expect(disconnectGoogleAction()).rejects.toThrow("owner only");
    expect(disconnectMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (module missing).

- [ ] **Step 3: Implement** (`src/app/actions/integrations.ts`)

```ts
"use server";

import { disconnectGoogle } from "@/lib/google";
import { currentWorkspaceId } from "@/lib/workspace";
import { OWNER_WORKSPACE_ID } from "@/lib/constants";
import { revalidatePath } from "next/cache";

export async function disconnectGoogleAction(): Promise<{ ok: true }> {
  const workspaceId = await currentWorkspaceId();
  if (workspaceId !== OWNER_WORKSPACE_ID) throw new Error("owner only");
  await disconnectGoogle();
  revalidatePath("/settings");
  return { ok: true };
}
```

- [ ] **Step 4: `reconnect_required` in the push action**

In `src/app/actions/google-schedule.ts`: add `"reconnect_required"` to the failure-reason
union (line ~22), and replace the `not_connected` early-return with:

```ts
  const token = await getValidAccessToken();
  if (!token) {
    const status = await getGoogleStatus();
    return { ok: false, reason: status.needsReconnect ? "reconnect_required" : "not_connected" };
  }
```

(`getGoogleStatus` is already imported at line 11.)

- [ ] **Step 5: Run** `npx vitest run src/app/actions/integrations.test.ts && npx tsc --noEmit` — PASS/clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/actions/integrations.ts src/app/actions/integrations.test.ts src/app/actions/google-schedule.ts
git commit -m "feat(actions): owner-gated Google disconnect + reconnect_required push reason"
```

---

### Task 6: `IntegrationsPanel` component

**Files:**
- Create: `src/components/settings/integrations-panel.tsx`
- Test: `src/components/settings/integrations-panel.test.tsx`

**Interfaces:**
- Consumes: `disconnectGoogleAction` (Task 5); status shape from Task 3 passed as prop.
- Produces: `<IntegrationsPanel google={{ configured, connected, needsReconnect }} />` — rendered by Task 7.

- [ ] **Step 1: Failing RTL tests** (`integrations-panel.test.tsx`; follow the jsdom/RTL setup used in `settings-panel.test.tsx` — same imports/render helpers)

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const { disconnectMock } = vi.hoisted(() => ({ disconnectMock: vi.fn() }));
vi.mock("@/app/actions/integrations", () => ({ disconnectGoogleAction: disconnectMock }));

import { IntegrationsPanel } from "./integrations-panel";

beforeEach(() => vi.clearAllMocks());

const base = { configured: true, connected: false, needsReconnect: false };

describe("IntegrationsPanel — Google card", () => {
  it("not connected → Connect link to the OAuth start route", () => {
    render(<IntegrationsPanel google={base} />);
    expect(screen.getByText(/not connected/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /connect google/i })).toHaveAttribute(
      "href", "/api/google/oauth/start",
    );
  });

  it("connected → Connected pill + Disconnect", () => {
    render(<IntegrationsPanel google={{ ...base, connected: true }} />);
    expect(screen.getByText(/^connected$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
  });

  it("needsReconnect → Reconnect pill + reconnect link", () => {
    render(<IntegrationsPanel google={{ ...base, needsReconnect: true }} />);
    expect(screen.getByText(/reconnect needed/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /reconnect google/i })).toHaveAttribute(
      "href", "/api/google/oauth/start",
    );
  });

  it("not configured → explains env vars, no actions", () => {
    render(<IntegrationsPanel google={{ ...base, configured: false }} />);
    expect(screen.getByText(/not configured/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /connect/i })).toBeNull();
  });

  it("disconnect asks for confirmation before firing the action", async () => {
    disconnectMock.mockResolvedValue({ ok: true });
    render(<IntegrationsPanel google={{ ...base, connected: true }} />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(disconnectMock).not.toHaveBeenCalled(); // confirm step first
    fireEvent.click(screen.getByRole("button", { name: /yes, disconnect/i }));
    expect(disconnectMock).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (module missing).

- [ ] **Step 3: Implement** (`integrations-panel.tsx` — client component; match the Tailwind idiom of `settings-panel.tsx` for cards/buttons)

```tsx
"use client";

import { useState, useTransition } from "react";
import { disconnectGoogleAction } from "@/app/actions/integrations";

type GoogleStatus = { configured: boolean; connected: boolean; needsReconnect: boolean };

/** Descriptor list = the extension point: future integrations add an entry here. */
function googleDescriptor(g: GoogleStatus) {
  const pill = !g.configured
    ? { label: "Not configured", tone: "muted" as const }
    : g.needsReconnect
      ? { label: "Reconnect needed", tone: "warn" as const }
      : g.connected
        ? { label: "Connected", tone: "ok" as const }
        : { label: "Not connected", tone: "muted" as const };
  return {
    id: "google",
    name: "Google Tasks",
    description:
      "Schedule steps and tasks into Google Tasks — a Reclaim-synced list is scheduled automatically.",
    pill,
    connectHref: g.configured && !g.connected ? "/api/google/oauth/start" : null,
    connectLabel: g.needsReconnect ? "Reconnect Google →" : "Connect Google →",
    canDisconnect: g.connected,
  };
}

export function IntegrationsPanel({ google }: { google: GoogleStatus }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const d = googleDescriptor(google);
  const pillClass =
    d.pill.tone === "ok"
      ? "bg-green-100 text-green-800"
      : d.pill.tone === "warn"
        ? "bg-red-100 text-red-700"
        : "bg-muted text-muted-foreground";

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Integrations</h2>
      <div className="rounded-lg border p-4">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="font-medium">{d.name}</p>
            <p className="text-muted-foreground text-sm">{d.description}</p>
          </div>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${pillClass}`}>
            {d.pill.label}
          </span>
        </div>
        {!google.configured && (
          <p className="text-muted-foreground mt-3 text-sm">
            Set <code>GOOGLE_CLIENT_ID</code> / <code>GOOGLE_CLIENT_SECRET</code> to enable
            (see the README).
          </p>
        )}
        <div className="mt-3 flex items-center gap-3">
          {d.connectHref && (
            <a
              href={d.connectHref}
              className="bg-primary text-primary-foreground rounded-md px-3 py-2 text-sm font-medium"
            >
              {d.connectLabel}
            </a>
          )}
          {d.canDisconnect && !confirming && (
            <button
              type="button"
              className="text-destructive rounded-md border px-3 py-2 text-sm font-medium"
              onClick={() => setConfirming(true)}
            >
              Disconnect
            </button>
          )}
          {d.canDisconnect && confirming && (
            <>
              <span className="text-sm">Remove access and delete stored tokens?</span>
              <button
                type="button"
                disabled={pending}
                className="bg-destructive rounded-md px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                onClick={() => startTransition(async () => { await disconnectGoogleAction(); setConfirming(false); })}
              >
                Yes, disconnect
              </button>
              <button type="button" className="rounded-md border px-3 py-2 text-sm" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
```

Note for the implementer: `needsReconnect` implies `connected === false` (tokens were
cleared), so the reconnect link renders via `connectHref` with the reconnect label.

- [ ] **Step 4: Run tests** — `npx vitest run src/components/settings/integrations-panel.test.tsx` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/integrations-panel.*
git commit -m "feat(settings): descriptor-driven Integrations panel (Google card)"
```

---

### Task 7: Wire the panel into `/settings` (owner-only)

**Files:**
- Modify: `src/app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes: `getGoogleStatus` (Task 3), `IntegrationsPanel` (Task 6), plus whatever owner/guest signal the page already computes — read the file first; it already renders `SettingsPanel` and the app distinguishes owner vs guest (`isOwnerRequest` from `@/lib/workspace` is the canonical check).

- [ ] **Step 1: Modify the page** — fetch status server-side and render the panel for the owner only:

```tsx
import { getGoogleStatus } from "@/lib/google";
import { isOwnerRequest } from "@/lib/workspace";
import { IntegrationsPanel } from "@/components/settings/integrations-panel";
// ...existing imports stay...

// inside the (async) page component, alongside existing data fetching:
const owner = await isOwnerRequest();
const google = owner ? await getGoogleStatus() : null;

// in the JSX, after the existing <SettingsPanel …/>:
{owner && google && <IntegrationsPanel google={google} />}
```

Adapt to the page's actual structure (keep existing props/layout untouched).

- [ ] **Step 2: Verify** — `npx tsc --noEmit && npm run build` → clean; then `npm run dev`, open `/settings`, see the card (owner session).

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/settings/page.tsx"
git commit -m "feat(settings): show Integrations panel to the owner"
```

---

### Task 8: Breakdown-chat reconnect CTA + #22 wording

**Files:**
- Modify: `src/components/breakdown/breakdown-chat.tsx:248-305` (schedule section) and its `google` prop type (~line 29-38)
- Modify: `src/app/(app)/tasks/[taskId]/page.tsx` (passes `getGoogleStatus()` result — shape already includes the new field after Task 3; verify the prop typing)
- Test: extend the component's existing test file if present; otherwise add `src/components/breakdown/breakdown-chat.schedule.test.tsx` with the two cases below.

**Interfaces:**
- Consumes: `google: { configured: boolean; connected: boolean; needsReconnect: boolean }`, push reason `"reconnect_required"` (Task 5).

- [ ] **Step 1: Failing tests** (render the schedule section states; mock heavy deps the way existing component tests in the repo do — check `src/components/settings/settings-panel.test.tsx` for the mocking idiom)

```tsx
it("shows a reconnect CTA when Google needs reconnecting", () => {
  renderChat({ google: { configured: true, connected: false, needsReconnect: true } });
  const link = screen.getByRole("link", { name: /reconnect google/i });
  expect(link).toHaveAttribute("href", "/api/google/oauth/start");
});

it("uses Google-first wording on the send button", () => {
  renderChat({ google: { configured: true, connected: true, needsReconnect: false } });
  expect(screen.getByRole("button", { name: /send to google tasks/i })).toBeInTheDocument();
});
```

(`renderChat` = local helper wrapping `render(<BreakdownChat …requiredProps/>)` with the
minimal props the component demands — copy the prop scaffold from the component's type.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** In the schedule section:
  - New branch ABOVE the `!google.connected` connect branch: if `google.needsReconnect`,
    render copy "Google needs reconnecting — your access expired or was revoked." plus
    `<a href="/api/google/oauth/start">Reconnect Google →</a>` (same styling as the
    existing connect link).
  - Wording (#22): button text `📅 Send to Google Tasks`; connect-branch copy
    "Connect Google Tasks — steps land in your task list, and a Reclaim-synced list is
    scheduled automatically."; sent-confirmation keeps list name but drops "Reclaim"
    framing: `Sent N tasks to your "X" list.`
  - Handle the push result `reason === "reconnect_required"` in the error branch with the
    same reconnect link.

- [ ] **Step 4: Run** the new tests + `npx vitest run` (whole suite) — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/breakdown/ "src/app/(app)/tasks/[taskId]/page.tsx"
git commit -m "feat(breakdown): reconnect CTA + Google-first scheduling copy (#22)"
```

---

### Task 9: README wording, full gate, MR

**Files:**
- Modify: `README.md` (scheduling/integration copy — grep `README.md` for `Reclaim` and align each user-facing sentence with the #22 rule; keep the architecture explanation of the Reclaim sync, just stop calling the button/flow "Reclaim")

- [ ] **Step 1: Update README copy** per above.

- [ ] **Step 2: Full gate**

Run: `npx tsc --noEmit && npm run lint && npx vitest run && npm run build`
Expected: all clean; suite ≥ previous count, all green.

- [ ] **Step 3: Runtime verify** (local prod build): with dev DB up and Google env unset →
`/settings` shows "Not configured"; with env set + not connected → Connect link; after a
fake connected row (insert via `npx prisma studio` or connect for real) → Connected +
Disconnect flow deletes the row. Kill the server after (`pkill -f next-server`).

- [ ] **Step 4: Commit + push + MR**

```bash
git add README.md
git commit -m "docs(readme): Google-first scheduling wording (#22)"
git push -u origin feat/integrations-panel
```

Create the MR (title `feat(settings): Integrations panel + invalid_grant token cleanup — #21 P2, #22`),
reviewers dlectronique + GitLabDuo, milestone v0.0.2, label `security`. Do NOT merge —
owner merges after Duo review per standing preference. Then tick the #21 P2 box +
#22 boxes as annotations ("MR !NN in review") and comment on both issues.
