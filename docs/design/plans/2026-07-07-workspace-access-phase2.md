# Workspace-access Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add guest cost controls (IP-scoped AI allowance + global cap), per-role breakdown models with an owner Settings picker, `.ics` local scheduling, a 24h guest sandbox with a status chip/banner, and a dark-mode toggle.

**Architecture:** Extends Phase 1 (workspace-scoped data + owner/guest sessions). New pure libs (`models`, `guest-quota`, `ics`) are unit-tested; the breakdown route becomes workspace-aware (chooses model by role, enforces the guest allowance, and falls back to a canned local breakdown non-silently); guest sandboxes get a 24h JWT lifetime with opportunistic DB purge; guests never call Claude outside breakdowns. UI adds a guest banner+chip, an owner model picker, a calendar-export button, and a dark toggle.

**Tech Stack:** Next.js 16 (App Router, `src/proxy.ts`), TypeScript, Prisma 6 + PostgreSQL, `@anthropic-ai/sdk`, `jose` (JWT), Tailwind v4 + shadcn, vitest.

## Global Constraints

- **Next.js 16:** interception file is `src/proxy.ts` exporting `proxy` (NOT middleware). Read `node_modules/next/dist/docs/` before writing Next code (per AGENTS.md). `params` is async.
- **Prisma 6** (not 7). Values for status/kind columns are Strings mirrored in `src/lib/constants.ts`. After any `prisma migrate`, the dev server holds a stale client — restart `npm run dev`.
- **Claude model IDs (exact):** `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-8`, `claude-fable-5`. Owner allowlist = haiku/sonnet/opus only; **`claude-fable-5` is never selectable/honored** (UI shows it disabled). Per-model params: do NOT send `output_config.effort` to `claude-haiku-4-5` (errors); adaptive thinking + effort are Opus/Sonnet-tier.
- **Model defaults:** guest → `claude-haiku-4-5`; owner → `Settings.breakdownModel` → env `OWNER_BREAKDOWN_MODEL` → `claude-sonnet-4-6`.
- **Numbers (env, tunable):** `GUEST_AI_QUOTA_PER_WINDOW=5`, `GUEST_AI_WINDOW_HOURS=24`, `GUEST_GLOBAL_DAILY_GUEST_CAP=10`, `GUEST_SANDBOX_TTL_HOURS=24`.
- **Owner workspace id** = `"owner"` (`OWNER_WORKSPACE_ID` in constants). Guest = any other id. `id !== OWNER_WORKSPACE_ID` ⇒ guest.
- **Privacy:** store only a salted **hash** of the client IP (`GUEST_IP_HASH_SALT`), never the raw IP.
- **Prod:** secrets via GitLab CI/CD vars (Phase 1 pattern); non-secret tunables baked into `.gitlab-ci.yml`. Review apps use dummy values.
- Existing tests must stay green: `npm run test` (vitest). Commit after each task.

---

### Task 1: Data model + migration

**Files:**
- Modify: `prisma/schema.prisma` (Workspace, Settings; add GuestAiUsage, GuestDailyActivity)
- Modify: `src/lib/constants.ts` (add `BreakdownModel` allowlist constant)

**Interfaces:**
- Produces: `Workspace.expiresAt DateTime?`; `Settings.breakdownModel String?`; models `GuestAiUsage { ipHash @unique, count, windowStartedAt, updatedAt }` and `GuestDailyActivity { day, ipHash, @@id([day, ipHash]) }`; `OWNER_BREAKDOWN_ALLOWLIST: readonly string[]` and `GUEST_BREAKDOWN_MODEL_DEFAULT`, `OWNER_BREAKDOWN_MODEL_DEFAULT` in constants.

- [ ] **Step 1: Edit `prisma/schema.prisma`** — add `expiresAt` to Workspace and `breakdownModel` to Settings, and two new models.

In `model Workspace`, add under `lastSeenAt`:
```prisma
  expiresAt DateTime? // guest sandbox TTL (null = owner / no expiry)
```

In `model Settings`, add above `workspaceId`:
```prisma
  // Phase 2 — owner-selected breakdown model (null = env/default)
  breakdownModel        String?
```

Append two new models at the end of the file:
```prisma
// ── Phase 2 — guest AI allowance (IP-hash scoped, rolling window) ──────────
// No PII: ipHash is a salted hash of the client IP. count/window enforce the
// per-guest breakdown allowance; rows are self-expiring by window.
model GuestAiUsage {
  ipHash          String   @id
  count           Int      @default(0)
  windowStartedAt DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

// ── Phase 2 — global daily distinct-guest tally (circuit breaker) ──────────
// One row per (UTC day, ipHash); count of rows for a day = distinct guests
// that used AI that day. Presence = "this guest used AI today".
model GuestDailyActivity {
  day       String   // UTC date YYYY-MM-DD
  ipHash    String
  createdAt DateTime @default(now())

  @@id([day, ipHash])
  @@index([day])
}
```

- [ ] **Step 2: Add the model allowlist to `src/lib/constants.ts`** — append:
```typescript
// ── Phase 2 — breakdown model selection ───────────────────────────────────
// Owner-selectable models (validated server-side). claude-fable-5 is shown in
// the UI but deliberately NOT allowlisted — it can never be selected/honored.
export const OWNER_BREAKDOWN_ALLOWLIST = [
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-8",
] as const;
export type BreakdownModel = (typeof OWNER_BREAKDOWN_ALLOWLIST)[number];

export const OWNER_BREAKDOWN_MODEL_DEFAULT = "claude-sonnet-4-6";
export const GUEST_BREAKDOWN_MODEL_DEFAULT = "claude-haiku-4-5";
```

- [ ] **Step 3: Create the migration**

Run: `export PATH="$HOME/.rd/bin:$PATH"; export DOCKER_HOST="unix://$HOME/.rd/docker.sock"; docker compose up -d db && npx prisma migrate dev --name phase2-guest-controls`
Expected: migration created under `prisma/migrations/`, `prisma generate` runs, exit 0.

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors from the new fields/models.

- [ ] **Step 5: Commit**
```bash
git add prisma/schema.prisma prisma/migrations src/lib/constants.ts
git commit -m "feat(phase2): schema — guest AI usage tables, sandbox TTL, owner model field"
```

---

### Task 2: Breakdown model resolution helper

**Files:**
- Create: `src/lib/models.ts`
- Test: `src/lib/models.test.ts`

**Interfaces:**
- Consumes: `OWNER_BREAKDOWN_ALLOWLIST`, `OWNER_BREAKDOWN_MODEL_DEFAULT`, `GUEST_BREAKDOWN_MODEL_DEFAULT` (Task 1).
- Produces:
  - `resolveBreakdownModel(opts: { isOwner: boolean; ownerSetting?: string | null }): string`
  - `breakdownParamsFor(model: string): { model: string; thinking?: { type: "adaptive" }; output_config?: { effort: "low" } }` — Haiku gets neither thinking nor effort; Sonnet/Opus get adaptive thinking + low effort.

- [ ] **Step 1: Write the failing test** — `src/lib/models.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { resolveBreakdownModel, breakdownParamsFor } from "./models";

describe("resolveBreakdownModel", () => {
  it("guest always gets haiku regardless of owner setting", () => {
    expect(resolveBreakdownModel({ isOwner: false, ownerSetting: "claude-opus-4-8" })).toBe("claude-haiku-4-5");
  });
  it("owner uses a valid stored setting", () => {
    expect(resolveBreakdownModel({ isOwner: true, ownerSetting: "claude-opus-4-8" })).toBe("claude-opus-4-8");
  });
  it("owner with no setting falls back to the default", () => {
    expect(resolveBreakdownModel({ isOwner: true, ownerSetting: null })).toBe("claude-sonnet-4-6");
  });
  it("owner with an off-allowlist value (e.g. fable) falls back to default", () => {
    expect(resolveBreakdownModel({ isOwner: true, ownerSetting: "claude-fable-5" })).toBe("claude-sonnet-4-6");
  });
});

describe("breakdownParamsFor", () => {
  it("haiku gets no thinking and no effort", () => {
    const p = breakdownParamsFor("claude-haiku-4-5");
    expect(p.thinking).toBeUndefined();
    expect(p.output_config).toBeUndefined();
  });
  it("sonnet/opus get adaptive thinking + low effort", () => {
    const p = breakdownParamsFor("claude-sonnet-4-6");
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config).toEqual({ effort: "low" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/models.test.ts`
Expected: FAIL — module `./models` not found.

- [ ] **Step 3: Create `src/lib/models.ts`**
```typescript
import {
  OWNER_BREAKDOWN_ALLOWLIST,
  OWNER_BREAKDOWN_MODEL_DEFAULT,
  GUEST_BREAKDOWN_MODEL_DEFAULT,
} from "@/lib/constants";

function isAllowlisted(m: string | null | undefined): boolean {
  return !!m && (OWNER_BREAKDOWN_ALLOWLIST as readonly string[]).includes(m);
}

/** Pick the breakdown model by role. Guests are fixed to Haiku (cost lever). */
export function resolveBreakdownModel(opts: {
  isOwner: boolean;
  ownerSetting?: string | null;
}): string {
  if (!opts.isOwner) {
    return process.env.GUEST_BREAKDOWN_MODEL || GUEST_BREAKDOWN_MODEL_DEFAULT;
  }
  if (isAllowlisted(opts.ownerSetting)) return opts.ownerSetting as string;
  const envDefault = process.env.OWNER_BREAKDOWN_MODEL;
  if (isAllowlisted(envDefault)) return envDefault as string;
  return OWNER_BREAKDOWN_MODEL_DEFAULT;
}

/**
 * Per-model request params. Haiku 4.5 rejects `output_config.effort` and is not
 * an adaptive-thinking tier; Sonnet/Opus take adaptive thinking + low effort
 * (low keeps the interactive breakdown snappy).
 */
export function breakdownParamsFor(model: string): {
  model: string;
  thinking?: { type: "adaptive" };
  output_config?: { effort: "low" };
} {
  if (model === "claude-haiku-4-5") return { model };
  return { model, thinking: { type: "adaptive" }, output_config: { effort: "low" } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/models.test.ts`
Expected: PASS (6 assertions).

- [ ] **Step 5: Commit**
```bash
git add src/lib/models.ts src/lib/models.test.ts
git commit -m "feat(phase2): per-role breakdown model resolution + per-model params"
```

---

### Task 3: Guest AI allowance library (IP hash + counters + global cap)

**Files:**
- Create: `src/lib/guest-quota.ts`
- Test: `src/lib/guest-quota.test.ts`

**Interfaces:**
- Consumes: `prisma` from `@/lib/db`.
- Produces:
  - `clientIpHash(headers: Headers): string | null` — reads `x-forwarded-for` (leftmost) then `x-real-ip`; returns `sha256(salt + ip)` hex, or `null` if no IP.
  - `guestQuotaConfig(): { quota: number; windowHours: number; globalCap: number }`.
  - `type AllowanceResult = { allowed: boolean; remaining: number; reason?: "quota" | "global_cap" }`.
  - `peekGuestAllowance(ipHash: string): Promise<{ remaining: number }>` — read-only (for the chip).
  - `consumeGuestBreakdown(ipHash: string): Promise<AllowanceResult>` — enforces per-IP window + global daily cap and increments on success.

- [ ] **Step 1: Write the failing test** — `src/lib/guest-quota.test.ts` (mocks prisma):
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = {
  guestAiUsage: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  guestDailyActivity: { findUnique: vi.fn(), count: vi.fn(), create: vi.fn() },
};
vi.mock("@/lib/db", () => ({ prisma: db }));

import { clientIpHash, consumeGuestBreakdown } from "./guest-quota";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GUEST_IP_HASH_SALT = "test-salt";
  process.env.GUEST_AI_QUOTA_PER_WINDOW = "5";
  process.env.GUEST_AI_WINDOW_HOURS = "24";
  process.env.GUEST_GLOBAL_DAILY_GUEST_CAP = "10";
});

describe("clientIpHash", () => {
  it("hashes the leftmost x-forwarded-for IP deterministically", () => {
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    const a = clientIpHash(h);
    const b = clientIpHash(new Headers({ "x-forwarded-for": "1.2.3.4" }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("returns null when no IP header present", () => {
    expect(clientIpHash(new Headers())).toBeNull();
  });
});

describe("consumeGuestBreakdown", () => {
  it("allows and increments when under quota and under global cap", async () => {
    db.guestDailyActivity.findUnique.mockResolvedValue(null);
    db.guestDailyActivity.count.mockResolvedValue(3);
    db.guestAiUsage.findUnique.mockResolvedValue({ count: 1, windowStartedAt: new Date() });
    db.guestAiUsage.upsert.mockResolvedValue({});
    const r = await consumeGuestBreakdown("iphash");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(3); // 5 - (1+1)
  });
  it("blocks with reason=quota when the per-IP window is exhausted", async () => {
    db.guestDailyActivity.findUnique.mockResolvedValue({ day: "x", ipHash: "iphash" });
    db.guestAiUsage.findUnique.mockResolvedValue({ count: 5, windowStartedAt: new Date() });
    const r = await consumeGuestBreakdown("iphash");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("quota");
  });
  it("blocks a NEW guest with reason=global_cap when the day is full", async () => {
    db.guestDailyActivity.findUnique.mockResolvedValue(null); // not counted today
    db.guestDailyActivity.count.mockResolvedValue(10); // cap reached
    db.guestAiUsage.findUnique.mockResolvedValue({ count: 0, windowStartedAt: new Date() });
    const r = await consumeGuestBreakdown("iphash");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("global_cap");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/guest-quota.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/guest-quota.ts`**
```typescript
import { createHash } from "crypto";
import { prisma } from "@/lib/db";

export function guestQuotaConfig() {
  return {
    quota: Number(process.env.GUEST_AI_QUOTA_PER_WINDOW ?? 5),
    windowHours: Number(process.env.GUEST_AI_WINDOW_HOURS ?? 24),
    globalCap: Number(process.env.GUEST_GLOBAL_DAILY_GUEST_CAP ?? 10),
  };
}

/** Salted SHA-256 of the client IP; never store the raw IP. */
export function clientIpHash(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  const ip = (xff ? xff.split(",")[0] : headers.get("x-real-ip"))?.trim();
  if (!ip) return null;
  const salt = process.env.GUEST_IP_HASH_SALT ?? "";
  return createHash("sha256").update(salt + ip).digest("hex");
}

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export type AllowanceResult = {
  allowed: boolean;
  remaining: number;
  reason?: "quota" | "global_cap";
};

/** Read-only remaining allowance for the chip (does not consume). */
export async function peekGuestAllowance(ipHash: string): Promise<{ remaining: number }> {
  const { quota, windowHours } = guestQuotaConfig();
  const row = await prisma.guestAiUsage.findUnique({ where: { ipHash } });
  if (!row) return { remaining: quota };
  const expired = Date.now() - row.windowStartedAt.getTime() >= windowHours * 3600_000;
  const used = expired ? 0 : row.count;
  return { remaining: Math.max(0, quota - used) };
}

/**
 * Enforce the per-IP rolling window AND the global distinct-guest daily cap,
 * incrementing on success. Order: check per-IP window first; then, for a guest
 * not yet counted today, check the global cap; then record + increment.
 */
export async function consumeGuestBreakdown(ipHash: string): Promise<AllowanceResult> {
  const { quota, windowHours, globalCap } = guestQuotaConfig();
  const now = new Date();

  const usage = await prisma.guestAiUsage.findUnique({ where: { ipHash } });
  const windowExpired =
    !!usage && now.getTime() - usage.windowStartedAt.getTime() >= windowHours * 3600_000;
  const used = !usage || windowExpired ? 0 : usage.count;

  if (used >= quota) return { allowed: false, remaining: 0, reason: "quota" };

  // Global cap: only gates guests who have NOT already used AI today.
  const day = utcDay(now);
  const countedToday = await prisma.guestDailyActivity.findUnique({
    where: { day_ipHash: { day, ipHash } },
  });
  if (!countedToday) {
    const distinct = await prisma.guestDailyActivity.count({ where: { day } });
    if (distinct >= globalCap) return { allowed: false, remaining: quota - used, reason: "global_cap" };
    await prisma.guestDailyActivity.create({ data: { day, ipHash } });
  }

  const newCount = used + 1;
  await prisma.guestAiUsage.upsert({
    where: { ipHash },
    create: { ipHash, count: newCount, windowStartedAt: now },
    update: windowExpired
      ? { count: newCount, windowStartedAt: now }
      : { count: { increment: 1 } },
  });

  return { allowed: true, remaining: Math.max(0, quota - newCount) };
}
```

Note: the composite unique in Prisma is queried as `where: { day_ipHash: { day, ipHash } }` (generated from `@@id([day, ipHash])`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/guest-quota.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/guest-quota.ts src/lib/guest-quota.test.ts
git commit -m "feat(phase2): guest AI allowance lib — IP-hash window + global daily cap"
```

---

### Task 4: Breakdown route — role-aware model, allowance enforcement, non-silent canned fallback

**Files:**
- Modify: `src/lib/breakdown.ts` (add `StreamEvent` `fallback` variant + `localBreakdown()`)
- Test: `src/lib/breakdown.test.ts` (localBreakdown)
- Modify: `src/app/api/breakdown/route.ts` (role + allowance + model + fallback)
- Modify: `src/components/breakdown/breakdown-chat.tsx` (handle `fallback` event)

**Interfaces:**
- Consumes: `resolveBreakdownModel`, `breakdownParamsFor` (Task 2); `clientIpHash`, `consumeGuestBreakdown` (Task 3); `isOwnerRequest`, `currentWorkspaceId` (workspace.ts); `getSettings`.
- Produces: `StreamEvent` gains `{ type: "fallback"; reason: "quota" | "global_cap" | "error"; data: Proposal }`; `localBreakdown(title: string): Proposal`.

- [ ] **Step 1: Write the failing test** — `src/lib/breakdown.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { localBreakdown } from "./breakdown";

describe("localBreakdown", () => {
  it("returns a non-empty ordered proposal with positive estimates", () => {
    const p = localBreakdown("Write the quarterly report");
    expect(p.parentEmoji).toBeTruthy();
    expect(p.steps.length).toBeGreaterThanOrEqual(3);
    for (const s of p.steps) {
      expect(s.text.length).toBeGreaterThan(0);
      expect(s.estMinutes).toBeGreaterThan(0);
      expect(s.subtaskEmoji).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/breakdown.test.ts`
Expected: FAIL — `localBreakdown` not exported.

- [ ] **Step 3: Edit `src/lib/breakdown.ts`** — extend `StreamEvent` and add the canned generator.

Change the `StreamEvent` union to add a fallback variant:
```typescript
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "steps"; data: Proposal }
  | { type: "fallback"; reason: "quota" | "global_cap" | "error"; data: Proposal }
  | { type: "done" }
  | { type: "error"; message: string };
```

Append the canned generator (pure, no SDK — used when Claude is unavailable/blocked):
```typescript
/**
 * Deterministic local breakdown used when Claude is unavailable or a guest is
 * over their allowance. Generic scaffolding steps derived from the task title —
 * intentionally simple; the point is that the app still works without AI.
 */
export function localBreakdown(title: string): Proposal {
  const t = title.trim() || "this task";
  return {
    parentEmoji: "🗂️",
    steps: [
      { text: `Write down exactly what "done" looks like for: ${t}`, estMinutes: 5, subtaskEmoji: "🎯" },
      { text: "Gather anything you need to start (files, links, tools)", estMinutes: 10, subtaskEmoji: "🧰" },
      { text: "Do the smallest first piece for 10 minutes", estMinutes: 10, subtaskEmoji: "🌱" },
      { text: "Continue the main work in one focused block", estMinutes: 25, subtaskEmoji: "🚀" },
      { text: "Review, tidy up, and mark it complete", estMinutes: 10, subtaskEmoji: "✅" },
    ],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/breakdown.test.ts`
Expected: PASS.

- [ ] **Step 5: Edit `src/app/api/breakdown/route.ts`** — make it role-aware.

Add imports at top:
```typescript
import { headers } from "next/headers";
import { isOwnerRequest, currentWorkspaceId } from "@/lib/workspace";
import { getSettings } from "@/lib/settings-read";
import { resolveBreakdownModel, breakdownParamsFor } from "@/lib/models";
import { clientIpHash, consumeGuestBreakdown } from "@/lib/guest-quota";
import { localBreakdown } from "@/lib/breakdown";
import { OWNER_WORKSPACE_ID } from "@/lib/constants";
```

Immediately after the JSON parse (after `body` is assigned, before `const encoder = ...`), insert role + allowance resolution:
```typescript
  // ── Role + allowance resolution ────────────────────────────────────────────
  const owner = await isOwnerRequest();
  const wsId = await currentWorkspaceId();
  const isGuest = wsId !== OWNER_WORKSPACE_ID;

  let blockedReason: "quota" | "global_cap" | null = null;
  if (isGuest) {
    const hdrs = await headers();
    const ipHash = clientIpHash(hdrs);
    // No resolvable IP ⇒ treat as global-cap-style block (can't meter safely).
    if (!ipHash) {
      blockedReason = "global_cap";
    } else {
      const res = await consumeGuestBreakdown(ipHash);
      if (!res.allowed) blockedReason = res.reason ?? "quota";
    }
  }

  // Resolve model (owner setting → env → default; guest → haiku).
  const settings = owner ? await getSettings(OWNER_WORKSPACE_ID) : null;
  const model = resolveBreakdownModel({ isOwner: owner, ownerSetting: settings?.breakdownModel ?? null });
```

Replace the body of the `ReadableStream` `start(controller)` so a blocked guest short-circuits to the canned fallback (no Claude call), and Claude errors also fall back:
```typescript
    async start(controller) {
      const send = (e: StreamEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));

      // Blocked guest → non-silent canned fallback, NO Claude call.
      if (blockedReason) {
        send({ type: "fallback", reason: blockedReason, data: localBreakdown(body.title) });
        send({ type: "done" });
        controller.close();
        return;
      }

      try {
        const anthropic = getAnthropic();
        const ms = anthropic.messages.stream({
          ...breakdownParamsFor(model),
          max_tokens: 6000,
          system: SYSTEM,
          tools: [PROPOSE_TOOL],
          messages: [{ role: "user", content: buildUserPrompt(body) }],
        });
        ms.on("text", (delta) => send({ type: "text", delta }));
        const final = await ms.finalMessage();
        const tool = final.content.find(
          (b) => b.type === "tool_use" && b.name === "propose_steps",
        );
        if (tool && tool.type === "tool_use") {
          send({ type: "steps", data: tool.input as unknown as Proposal });
        }
        send({ type: "done" });
      } catch {
        // Claude failed → canned fallback rather than a dead end.
        send({ type: "fallback", reason: "error", data: localBreakdown(body.title) });
        send({ type: "done" });
      } finally {
        controller.close();
      }
    },
```

Remove the now-unused `BREAKDOWN_MODEL` import if present; `breakdownParamsFor(model)` supplies `model`.

- [ ] **Step 6: Edit `src/components/breakdown/breakdown-chat.tsx`** — handle the `fallback` event.

Add state near the other `useState` calls:
```typescript
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
```

In the stream parse loop, add a branch alongside the existing `ev.type` checks:
```typescript
          } else if (ev.type === "fallback") {
            setProposal(ev.data);
            setFallbackNote(
              ev.reason === "quota"
                ? "⚡ You're out of AI breakdowns for now — but here's a solid starter plan you can tweak, and the focus list still works."
                : ev.reason === "global_cap"
                  ? "🚦 The demo's shared AI is maxed out for today — here's a hand-built plan to get you moving. Still fully usable."
                  : "🔌 The AI hiccuped, so here's a reliable starter plan. Edit away and add it to your focus list.",
            );
```

Render the note (place above the `{error && ...}` block):
```tsx
      {fallbackNote && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700">
          {fallbackNote}
        </div>
      )}
```

Reset it at the start of `request()` (next to `setError(null)`): `setFallbackNote(null);`.

- [ ] **Step 7: Verify build + tests**

Run: `npm run test && npx tsc --noEmit && npm run build`
Expected: tests PASS; no type errors; build succeeds. (Note: `getSettings`/`settings-read` is created in Task 10 Step 1 — if building this task in isolation before Task 10, add the tiny read helper first; see Task 10.)

- [ ] **Step 8: Commit**
```bash
git add src/lib/breakdown.ts src/lib/breakdown.test.ts src/app/api/breakdown/route.ts src/components/breakdown/breakdown-chat.tsx
git commit -m "feat(phase2): breakdown route role-aware model + guest allowance + non-silent fallback"
```

---

### Task 5: Guest sandbox 24h TTL + opportunistic purge

**Files:**
- Modify: `src/proxy.ts` (guest JWT expiry = TTL; cookie maxAge = TTL)
- Modify: `src/lib/workspace.ts` (`touchWorkspace` sets `expiresAt` on create; add `purgeExpiredGuests()`, call opportunistically)
- Create: `src/lib/purge.ts` (`purgeWorkspace`, `purgeExpiredGuests`)
- Test: `src/lib/purge.test.ts`

**Interfaces:**
- Produces: `purgeWorkspace(id: string): Promise<void>` (deletes all workspace-scoped rows in a transaction); `purgeExpiredGuests(): Promise<number>` (deletes guest workspaces past `expiresAt`, returns count). `guestSandboxTtlHours(): number`.

- [ ] **Step 1: Write the failing test** — `src/lib/purge.test.ts` (mock prisma; assert delete fan-out + owner protection):
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const tx = {
  brainDumpItem: { deleteMany: vi.fn() },
  step: { deleteMany: vi.fn() },
  breakdownTurn: { deleteMany: vi.fn() },
  focusSession: { deleteMany: vi.fn() },
  dayRollup: { deleteMany: vi.fn() },
  rewardEvent: { deleteMany: vi.fn() },
  streak: { deleteMany: vi.fn() },
  streakRecord: { deleteMany: vi.fn() },
  badge: { deleteMany: vi.fn() },
  dailySpark: { deleteMany: vi.fn() },
  settings: { deleteMany: vi.fn() },
  task: { deleteMany: vi.fn() },
  workspace: { delete: vi.fn() },
};
const db = {
  $transaction: vi.fn(async (fn: any) => fn(tx)),
  workspace: { findMany: vi.fn() },
};
vi.mock("@/lib/db", () => ({ prisma: db }));

import { purgeWorkspace, purgeExpiredGuests } from "./purge";

beforeEach(() => vi.clearAllMocks());

describe("purgeWorkspace", () => {
  it("refuses to purge the owner workspace", async () => {
    await expect(purgeWorkspace("owner")).rejects.toThrow();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("deletes across scoped models then the workspace row", async () => {
    await purgeWorkspace("guest-123");
    expect(tx.task.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "guest-123" } });
    expect(tx.workspace.delete).toHaveBeenCalledWith({ where: { id: "guest-123" } });
  });
});

describe("purgeExpiredGuests", () => {
  it("purges each expired guest and returns the count", async () => {
    db.workspace.findMany.mockResolvedValue([{ id: "g1" }, { id: "g2" }]);
    const n = await purgeExpiredGuests();
    expect(n).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/purge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/purge.ts`**
```typescript
import { prisma } from "@/lib/db";
import { OWNER_WORKSPACE_ID } from "@/lib/constants";

export function guestSandboxTtlHours(): number {
  return Number(process.env.GUEST_SANDBOX_TTL_HOURS ?? 24);
}

/** Delete every workspace-scoped row for a guest workspace, then the row. */
export async function purgeWorkspace(id: string): Promise<void> {
  if (id === OWNER_WORKSPACE_ID) throw new Error("refusing to purge the owner workspace");
  await prisma.$transaction(async (tx) => {
    const w = { workspaceId: id };
    // Children first (Step/BreakdownTurn cascade from Task; delete explicitly to be safe).
    await tx.step.deleteMany({ where: { task: { workspaceId: id } } });
    await tx.breakdownTurn.deleteMany({ where: { task: { workspaceId: id } } });
    await tx.brainDumpItem.deleteMany({ where: w });
    await tx.focusSession.deleteMany({ where: w });
    await tx.dayRollup.deleteMany({ where: w });
    await tx.rewardEvent.deleteMany({ where: w });
    await tx.streak.deleteMany({ where: w });
    await tx.streakRecord.deleteMany({ where: w });
    await tx.badge.deleteMany({ where: w });
    await tx.dailySpark.deleteMany({ where: w });
    await tx.settings.deleteMany({ where: w });
    await tx.task.deleteMany({ where: w });
    await tx.workspace.delete({ where: { id } });
  });
}

/** Opportunistic purge of guest workspaces past their TTL. Returns count purged. */
export async function purgeExpiredGuests(): Promise<number> {
  const expired = await prisma.workspace.findMany({
    where: { kind: "guest", expiresAt: { lt: new Date() } },
    select: { id: true },
    take: 25, // bound the work per call
  });
  for (const w of expired) {
    try {
      await purgeWorkspace(w.id);
    } catch {
      // best-effort; skip on error
    }
  }
  return expired.length;
}
```

Note: `tx.step.deleteMany({ where: { task: { workspaceId: id } } })` — adjust the test mock's `step.deleteMany` expectation accordingly (relation filter, not flat `workspaceId`). Update the test's step assertion if you assert on it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/purge.test.ts`
Expected: PASS.

- [ ] **Step 5: Edit `src/lib/workspace.ts`** — set `expiresAt` on guest create + opportunistic purge.

Add import:
```typescript
import { guestSandboxTtlHours, purgeExpiredGuests } from "@/lib/purge";
```

Rewrite `touchWorkspace` so guest workspaces get an `expiresAt` on creation (never on the owner):
```typescript
export async function touchWorkspace(id: string): Promise<void> {
  const kind = id === OWNER_WORKSPACE_ID ? "owner" : "guest";
  const expiresAt =
    kind === "guest"
      ? new Date(Date.now() + guestSandboxTtlHours() * 3600_000)
      : null;
  await prisma.workspace.upsert({
    where: { id },
    create: { id, kind, lastSeenAt: new Date(), expiresAt },
    update: { kind, lastSeenAt: new Date() }, // don't extend TTL on touch
  });
}
```

In `currentWorkspaceId`, after `await touchWorkspace(id);`, add a throttled opportunistic purge (fire-and-forget so it never blocks the request):
```typescript
  void purgeExpiredGuests().catch(() => {});
```

- [ ] **Step 6: Edit `src/proxy.ts`** — guest JWT lifetime = TTL (drives "fresh sandbox on expiry"); align cookie maxAge.

Compute TTL once near the top of `proxy` (after `const { sessionSecret } = authConfig();`):
```typescript
  const guestTtlHours = Number(process.env.GUEST_SANDBOX_TTL_HOURS ?? 24);
```

Change the inline guest-token sign expiration from `"30d"` to the TTL:
```typescript
      guestToken = await new SignJWT({ kind: "guest", wsId })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime(`${guestTtlHours}h`)
        .sign(new TextEncoder().encode(sessionSecret));
```

Change the guest cookie `maxAge`:
```typescript
    maxAge: 60 * 60 * guestTtlHours,
```

(When the JWT expires, `verifySession` returns null in `proxy`, so a brand-new `wsId` + token is minted — the fresh sandbox. The old workspace is purged opportunistically by `purgeExpiredGuests`.)

- [ ] **Step 7: Verify build + tests**

Run: `npm run test && npx tsc --noEmit && npm run build`
Expected: all green.

- [ ] **Step 8: Commit**
```bash
git add src/lib/purge.ts src/lib/purge.test.ts src/lib/workspace.ts src/proxy.ts
git commit -m "feat(phase2): 24h guest sandbox TTL + opportunistic purge on access"
```

---

### Task 6: Guests never call Claude outside breakdowns (spark / rollup / re-estimate)

**Files:**
- Modify: `src/lib/spark.ts` (skip Claude for guests)
- Modify: `src/lib/rollup.ts` (skip Claude for guests)
- Modify: `src/app/actions/focus.ts` (`proposeNewEstimate` skips Claude for guests)
- Test: `src/lib/ai-scope.test.ts`

**Interfaces:**
- Consumes: `OWNER_WORKSPACE_ID`.
- Produces: `isGuestWorkspace(id: string): boolean` exported from `src/lib/constants.ts` (add it), reused by spark/rollup/focus.

- [ ] **Step 1: Add `isGuestWorkspace` to `src/lib/constants.ts`**
```typescript
export function isGuestWorkspace(workspaceId: string): boolean {
  return workspaceId !== OWNER_WORKSPACE_ID;
}
```

- [ ] **Step 2: Write the failing test** — `src/lib/ai-scope.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { isGuestWorkspace } from "./constants";

describe("isGuestWorkspace", () => {
  it("owner id is not a guest", () => expect(isGuestWorkspace("owner")).toBe(false));
  it("any other id is a guest", () => expect(isGuestWorkspace("abc-123")).toBe(true));
});
```

- [ ] **Step 3: Run test to verify it fails, then passes after Step 1**

Run: `npm run test -- src/lib/ai-scope.test.ts`
Expected: PASS (Step 1 already added the function).

- [ ] **Step 4: Edit `src/lib/spark.ts`** — guests use the fallback pool, no Claude.

Add import: `import { SparkSource, isGuestWorkspace } from "@/lib/constants";` (replace existing SparkSource import).

In `getTodaySpark` and `refreshTodaySpark`, replace the `generateQuote()` call with a guest-aware choice. Simplest: add a helper and use it:
```typescript
async function quoteFor(workspaceId: string): Promise<{ quote: string; source: string }> {
  if (isGuestWorkspace(workspaceId)) {
    return { quote: randomFallback(), source: SparkSource.Fallback };
  }
  return generateQuote();
}
```
Then in both functions replace `const { quote, source } = await generateQuote();` with `const { quote, source } = await quoteFor(workspaceId);`.

- [ ] **Step 5: Edit `src/lib/rollup.ts`** — guests get the local narrative, no Claude.

Read `generateTodayRollup` around lines 110–120 (the `getAnthropic()` block). Wrap the Claude call so guests skip it. Add `isGuestWorkspace` to the constants import, then guard the AI branch:
```typescript
  // Guests never call Claude — use the local narrative builder.
  if (isGuestWorkspace(workspaceId)) {
    // fall through to the existing fallbackNarrative(...) path
  } else {
    try {
      const anthropic = getAnthropic();
      // ...existing Claude call, assign narrative...
    } catch {
      // existing fallback
    }
  }
```
Concretely: locate the existing `try { const anthropic = getAnthropic(); ... } catch { ... }` in `generateTodayRollup` and gate it behind `if (!isGuestWorkspace(workspaceId)) { <existing try/catch> }`, leaving the local `fallbackNarrative(...)` as the default when the guard is skipped. Do not change the persisted shape.

- [ ] **Step 6: Edit `src/app/actions/focus.ts`** — `proposeNewEstimate` skips Claude for guests.

Add `isGuestWorkspace` to the constants import. At the top of `proposeNewEstimate`, after resolving `workspaceId` and loading `step`:
```typescript
  if (isGuestWorkspace(workspaceId)) return step.estMinutes + 10;
```
(placed before the `try { getAnthropic() ... }` block, after the `if (!step) return 15;` guard).

- [ ] **Step 7: Verify build + tests**

Run: `npm run test && npx tsc --noEmit && npm run build`
Expected: green.

- [ ] **Step 8: Commit**
```bash
git add src/lib/constants.ts src/lib/ai-scope.test.ts src/lib/spark.ts src/lib/rollup.ts src/app/actions/focus.ts
git commit -m "feat(phase2): guests never call Claude outside breakdowns (spark/rollup/re-estimate)"
```

---

### Task 7: `.ics` "Add to calendar" (guest + owner)

**Files:**
- Create: `src/lib/ics.ts`
- Test: `src/lib/ics.test.ts`
- Create: `src/app/api/ics/[taskId]/route.ts`
- Modify: `src/app/(app)/tasks/[taskId]/page.tsx` (pass `isGuest` to BreakdownChat)
- Modify: `src/components/breakdown/breakdown-chat.tsx` (calendar button; hide Google/Reclaim for guests)

**Interfaces:**
- Produces: `buildTaskIcs(input: { title: string; parentEmoji?: string | null; steps: { text: string; estMinutes: number; subtaskEmoji?: string | null }[]; start?: Date }): string`.
- Consumes: `currentWorkspaceId`, `isOwnerRequest`, prisma.

- [ ] **Step 1: Write the failing test** — `src/lib/ics.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { buildTaskIcs } from "./ics";

describe("buildTaskIcs", () => {
  const ics = buildTaskIcs({
    title: "Ship the thing",
    parentEmoji: "🚀",
    steps: [
      { text: "Plan", estMinutes: 15, subtaskEmoji: "📝" },
      { text: "Build", estMinutes: 30, subtaskEmoji: "🔨" },
    ],
    start: new Date("2026-07-08T09:00:00Z"),
  });
  it("is a valid VCALENDAR with one VEVENT per step", () => {
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
  });
  it("sequences events back-to-back using durations", () => {
    // first event 09:00–09:15, second 09:15–09:45 (floating local time, no Z)
    expect(ics).toContain("DTSTART:20260708T090000");
    expect(ics).toContain("DTSTART:20260708T091500");
  });
  it("escapes commas in summaries", () => {
    const s = buildTaskIcs({ title: "A, B", steps: [{ text: "x, y", estMinutes: 5 }] });
    expect(s).toContain("x\\, y");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/ics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/ics.ts`**
```typescript
type IcsStep = { text: string; estMinutes: number; subtaskEmoji?: string | null };

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
/** Floating local time stamp: YYYYMMDDTHHMMSS (no trailing Z). */
function floating(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
function nextTopOfHour(from = new Date()): Date {
  const d = new Date(from);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

/** Build a downloadable .ics: one back-to-back VEVENT per step (floating local time). */
export function buildTaskIcs(input: {
  title: string;
  parentEmoji?: string | null;
  steps: IcsStep[];
  start?: Date;
}): string {
  const start = input.start ?? nextTopOfHour();
  let cursor = new Date(start);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//dlectroflow//phase2//EN",
    "CALSCALE:GREGORIAN",
  ];
  input.steps.forEach((s, i) => {
    const dur = Math.max(1, Math.round(s.estMinutes || 25));
    const end = new Date(cursor.getTime() + dur * 60_000);
    const emoji = s.subtaskEmoji ? `${s.subtaskEmoji} ` : "";
    const summary = `${input.parentEmoji ? input.parentEmoji + " " : ""}${input.title}: ${emoji}${s.text}`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${floating(cursor)}-${i}@dlectroflow`,
      `DTSTAMP:${floating(new Date())}`,
      `DTSTART:${floating(cursor)}`,
      `DTEND:${floating(end)}`,
      `SUMMARY:${esc(summary)}`,
      "END:VEVENT",
    );
    cursor = end;
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/ics.test.ts`
Expected: PASS.

- [ ] **Step 5: Create `src/app/api/ics/[taskId]/route.ts`** — workspace-scoped download.
```typescript
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { buildTaskIcs } from "@/lib/ics";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  const { taskId } = await ctx.params;
  const workspaceId = await currentWorkspaceId();
  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!task) return new Response("Not found", { status: 404 });

  const ics = buildTaskIcs({
    title: task.title,
    parentEmoji: task.parentEmoji,
    steps: task.steps.map((s) => ({
      text: s.text,
      estMinutes: s.estMinutes,
      subtaskEmoji: s.subtaskEmoji,
    })),
  });
  const safe = task.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 40) || "task";
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="dlectroflow-${safe}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}
```

- [ ] **Step 6: Edit `src/app/(app)/tasks/[taskId]/page.tsx`** — pass `isGuest` to `BreakdownChat`.

Add `import { isOwnerRequest } from "@/lib/workspace";` (currentWorkspaceId already imported). Before rendering `<BreakdownChat .../>`, compute `const owner = await isOwnerRequest();` and pass `isGuest={!owner}` as a new prop.

- [ ] **Step 7: Edit `src/components/breakdown/breakdown-chat.tsx`** — add `isGuest` prop, calendar button, hide Google/Reclaim for guests.

Add `isGuest` to the component props type and destructure it (default `false`).

In the confirmed view, wrap the existing "📅 Schedule onto your calendar" block so guests don't see the Google/Reclaim connect UI, and add the calendar-export link for everyone:
```tsx
        {/* Calendar export — always available, no integrations needed */}
        <div className="space-y-2 rounded-lg border p-4 text-sm">
          <p className="font-medium">📅 Add to your calendar</p>
          <p className="text-muted-foreground">
            Download an .ics with each step as a timed event — import into Google,
            Apple, or Outlook. No account needed.
          </p>
          <a
            href={`/api/ics/${taskId}`}
            className="bg-primary text-primary-foreground inline-block rounded-md px-3 py-2 font-medium"
          >
            ⬇️ Download calendar (.ics)
          </a>
        </div>

        {!isGuest && (
          {/* existing Google Tasks / Reclaim scheduling block goes here */}
        )}
```
Move the existing Google/Reclaim `<div className="space-y-2 rounded-lg border p-4 text-sm">…</div>` inside the `{!isGuest && ( … )}` guard.

- [ ] **Step 8: Verify build + tests**

Run: `npm run test && npx tsc --noEmit && npm run build`
Expected: green.

- [ ] **Step 9: Commit**
```bash
git add src/lib/ics.ts src/lib/ics.test.ts "src/app/api/ics/[taskId]/route.ts" "src/app/(app)/tasks/[taskId]/page.tsx" src/components/breakdown/breakdown-chat.tsx
git commit -m "feat(phase2): .ics calendar export (guest+owner); hide integrations for guests"
```

---

### Task 8: Guest indicator — banner + persistent chip

**Files:**
- Create: `src/components/guest/guest-indicator.tsx` (client component: banner + chip + countdown)
- Modify: `src/app/(app)/layout.tsx` (compute guest status, render indicator)

**Interfaces:**
- Consumes: `isOwnerRequest`, `currentWorkspaceId`, `peekGuestAllowance`, `clientIpHash`, `guestQuotaConfig`, prisma (Workspace.expiresAt).
- Produces: `<GuestIndicator remaining={number} quota={number} expiresAt={string /* ISO */} />`.

- [ ] **Step 1: Create `src/components/guest/guest-indicator.tsx`**
```tsx
"use client";

import { useEffect, useState } from "react";

const BANNER =
  "👋 You're in guest mode — a private sandbox just for this browser session. You get 5 AI-powered task breakdowns per session (on a speedy model), plus the focus timer, rewards, and one-click calendar export — all yours. Live integrations (Google/Reclaim) are owner-only for now. Self-hosted option and BYOK coming soon.";

function useCountdown(expiresAtIso: string): string {
  const [label, setLabel] = useState("");
  useEffect(() => {
    const tick = () => {
      const ms = new Date(expiresAtIso).getTime() - Date.now();
      if (ms <= 0) return setLabel("expiring…");
      const h = Math.floor(ms / 3600_000);
      const m = Math.floor((ms % 3600_000) / 60_000);
      setLabel(h > 0 ? `${h}h ${m}m` : `${m}m`);
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [expiresAtIso]);
  return label;
}

export function GuestIndicator({
  remaining,
  quota,
  expiresAt,
}: {
  remaining: number;
  quota: number;
  expiresAt: string;
}) {
  const [dismissed, setDismissed] = useState(true); // start collapsed to avoid flash
  const left = useCountdown(expiresAt);

  useEffect(() => {
    setDismissed(sessionStorage.getItem("df-guest-banner") === "1");
  }, []);

  const dismiss = () => {
    sessionStorage.setItem("df-guest-banner", "1");
    setDismissed(true);
  };

  if (!dismissed) {
    return (
      <div className="border-b bg-amber-500/10 px-4 py-2 text-sm text-amber-800">
        <div className="mx-auto flex max-w-3xl items-start justify-between gap-3">
          <p>{BANNER}</p>
          <button onClick={dismiss} aria-label="Dismiss" className="shrink-0 font-medium">
            ✕
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={() => setDismissed(false)}
      title="Guest mode — click for details"
      className="border-b bg-amber-500/5 px-4 py-1 text-xs text-amber-800 hover:bg-amber-500/10"
    >
      <span className="mx-auto flex max-w-3xl items-center gap-3">
        🎫 Guest · ⚡ {remaining}/{quota} breakdowns · ⏳ {left} left
      </span>
    </button>
  );
}
```

- [ ] **Step 2: Edit `src/app/(app)/layout.tsx`** — compute guest status server-side and render the indicator above the header.

Replace the file body with (keeps the existing header/nav; adds guest computation + indicator):
```tsx
import Link from "next/link";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { isOwnerRequest, currentWorkspaceId } from "@/lib/workspace";
import { clientIpHash, guestQuotaConfig, peekGuestAllowance } from "@/lib/guest-quota";
import { GuestIndicator } from "@/components/guest/guest-indicator";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const owner = await isOwnerRequest();

  let guest: { remaining: number; quota: number; expiresAt: string } | null = null;
  if (!owner) {
    const wsId = await currentWorkspaceId();
    const ws = await prisma.workspace.findUnique({ where: { id: wsId }, select: { expiresAt: true } });
    const { quota } = guestQuotaConfig();
    const ipHash = clientIpHash(await headers());
    const remaining = ipHash ? (await peekGuestAllowance(ipHash)).remaining : quota;
    guest = {
      remaining,
      quota,
      expiresAt: (ws?.expiresAt ?? new Date(Date.now() + 24 * 3600_000)).toISOString(),
    };
  }

  return (
    <div className="flex min-h-full flex-col">
      {guest && (
        <GuestIndicator remaining={guest.remaining} quota={guest.quota} expiresAt={guest.expiresAt} />
      )}
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-3">
          <Link href="/inbox" className="text-lg font-semibold tracking-tight">
            dlectroflow
          </Link>
          <nav className="text-muted-foreground flex items-center gap-4 text-sm">
            <Link href="/inbox" className="hover:text-foreground transition-colors">
              🧠 Inbox
            </Link>
            <Link href="/dashboard" className="hover:text-foreground transition-colors">
              🎉 Dashboard
            </Link>
            {owner ? (
              <a href="/api/auth/logout" className="text-xs text-muted-foreground">Sign out</a>
            ) : (
              <a href="/login" className="text-xs text-muted-foreground">Owner sign in</a>
            )}
          </nav>
        </div>
      </header>
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">{children}</div>
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

Run: `npx tsc --noEmit && npm run build`
Expected: green.

- [ ] **Step 4: Commit**
```bash
git add src/components/guest/guest-indicator.tsx "src/app/(app)/layout.tsx"
git commit -m "feat(phase2): guest banner + persistent status chip (allowance + sandbox countdown)"
```

---

### Task 9: Dark mode toggle

**Files:**
- Modify: `src/app/layout.tsx` (no-FOUC inline script + `suppressHydrationWarning`)
- Create: `src/components/theme-toggle.tsx`

**Interfaces:**
- Produces: `<ThemeToggle />` client component; localStorage key `df-theme` (`light` | `dark`); `dark` class on `<html>`.

- [ ] **Step 1: Edit `src/app/layout.tsx`** — add the no-FOUC script + `suppressHydrationWarning`.

Add `suppressHydrationWarning` to `<html>` and a `<head>` with the inline script (runs before hydration):
```tsx
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{if(localStorage.getItem('df-theme')==='dark'){document.documentElement.classList.add('dark')}}catch(e){}",
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
```

- [ ] **Step 2: Create `src/components/theme-toggle.tsx`**
```tsx
"use client";

import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("df-theme", next ? "dark" : "light");
    } catch {}
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className="hover:bg-accent rounded-md border px-3 py-1.5 text-sm"
      aria-pressed={dark}
    >
      {dark ? "☀️ Light mode" : "🌙 Dark mode"}
    </button>
  );
}
```

- [ ] **Step 3: Verify build**

Run: `npx tsc --noEmit && npm run build`
Expected: green. (The toggle is wired into the Settings panel in Task 10.)

- [ ] **Step 4: Commit**
```bash
git add src/app/layout.tsx src/components/theme-toggle.tsx
git commit -m "feat(phase2): dark-mode theme toggle + no-FOUC boot script"
```

---

### Task 10: Owner breakdown-model picker in Settings (+ read helper, action, dark toggle wiring)

**Files:**
- Create: `src/lib/settings-read.ts` (`getSettings(workspaceId)` — used by Task 4 route too)
- Modify: `src/app/actions/settings.ts` (add `updateBreakdownModel`)
- Modify: `src/components/inbox/settings-panel.tsx` (Appearance + owner model picker with rotating Fable line + dark toggle)
- Modify: `src/components/inbox/inbox-view.tsx` (pass `isOwner` + `breakdownModel`)
- Modify: `src/app/(app)/inbox/page.tsx` (load `isOwner` + settings.breakdownModel)

**Interfaces:**
- Consumes: `OWNER_BREAKDOWN_ALLOWLIST`, `isOwnerRequest`, `currentWorkspaceId`.
- Produces: `getSettings(workspaceId: string): Promise<Settings | null>`; server action `updateBreakdownModel(model: string): Promise<void>` (owner-only, allowlist-validated).

- [ ] **Step 1: Create `src/lib/settings-read.ts`**
```typescript
import { prisma } from "@/lib/db";

export async function getSettings(workspaceId: string) {
  return prisma.settings.findUnique({ where: { workspaceId } });
}
```

- [ ] **Step 2: Add `updateBreakdownModel` to `src/app/actions/settings.ts`**

Add imports at top: `import { isOwnerRequest } from "@/lib/workspace";` and `import { OWNER_BREAKDOWN_ALLOWLIST } from "@/lib/constants";`. Append:
```typescript
/** Phase 2 — owner picks their breakdown model (allowlist-validated, owner-only). */
export async function updateBreakdownModel(model: string) {
  if (!(await isOwnerRequest())) return; // guests can't set a model
  if (!(OWNER_BREAKDOWN_ALLOWLIST as readonly string[]).includes(model)) return;
  const workspaceId = await currentWorkspaceId();
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, breakdownModel: model },
    update: { breakdownModel: model },
  });
  revalidatePath("/inbox");
}
```

- [ ] **Step 3: Edit `src/app/(app)/inbox/page.tsx`** — load owner flag + current model.

Add `import { isOwnerRequest } from "@/lib/workspace";` and `import { getSettings } from "@/lib/settings-read";`. Where the page loads settings for `<InboxView>`, also compute `const owner = await isOwnerRequest();` and `const full = await getSettings(workspaceId);` and pass `isOwner={owner}` and `breakdownModel={full?.breakdownModel ?? null}` down to `<InboxView>`.

- [ ] **Step 4: Edit `src/components/inbox/inbox-view.tsx`** — thread props to `SettingsPanel`.

Add `isOwner` and `breakdownModel` to `InboxView`'s props, and change line 191 to:
```tsx
      <SettingsPanel settings={settings} isOwner={isOwner} breakdownModel={breakdownModel} />
```

- [ ] **Step 5: Edit `src/components/inbox/settings-panel.tsx`** — add Appearance (dark toggle) + owner model picker with rotating Fable line.

Add imports:
```typescript
import { ThemeToggle } from "@/components/theme-toggle";
import { updateBreakdownModel } from "@/app/actions/settings";
import { OWNER_BREAKDOWN_ALLOWLIST } from "@/lib/constants";
```

Extend the component signature:
```typescript
export function SettingsPanel({
  settings,
  isOwner,
  breakdownModel,
}: {
  settings: AgingSettings;
  isOwner: boolean;
  breakdownModel: string | null;
}) {
```

Add the rotating Fable pool + model labels as module constants (above the component):
```typescript
const FABLE_LINES = [
  "Our most capable model. Also $50/M tokens. To split ‘clean the kitchen’ into 3 steps? We love you, but no.",
  "We tried it. It wrote a dissertation on the philosophy of procrastination instead of your task. Disabled for everyone’s safety.",
  "Reserved for problems harder than ‘remember to buy milk.’ 💸",
  "Bringing a frontier reasoning model to a to-do list felt… irresponsible.",
  "It kept trying to solve P vs NP instead of your laundry. Locked.",
  "Overkill detector tripped. Fable stays in its cage for this one.",
];
const MODEL_LABELS: Record<string, string> = {
  "claude-haiku-4-5": "Haiku 4.5 — fastest, cheapest",
  "claude-sonnet-4-6": "Sonnet 4.6 — balanced (default)",
  "claude-opus-4-8": "Opus 4.8 — deepest reasoning, slower",
};
```

Inside the component, add state + save + a random Fable line chosen per open:
```typescript
  const [model, setModel] = useState<string>(breakdownModel ?? "claude-sonnet-4-6");
  const [fable] = useState(() => FABLE_LINES[Math.floor(Math.random() * FABLE_LINES.length)]);

  const saveModel = (m: string) =>
    startTransition(async () => {
      setModel(m);
      await updateBreakdownModel(m);
      router.refresh();
    });
```

Add two new sections inside the `<details>` body (after the existing aging controls). **Appearance** (everyone):
```tsx
        <div className="mt-4 border-t pt-3">
          <p className="text-muted-foreground mb-2 text-xs">🎨 Appearance</p>
          <ThemeToggle />
        </div>
```
**Breakdown model** (owner only):
```tsx
        {isOwner && (
          <div className="mt-4 border-t pt-3">
            <p className="text-muted-foreground mb-2 text-xs">🧠 Breakdown model</p>
            <div className="flex flex-col gap-1">
              {OWNER_BREAKDOWN_ALLOWLIST.map((m) => (
                <label key={m} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="breakdown-model"
                    checked={model === m}
                    disabled={pending}
                    onChange={() => saveModel(m)}
                  />
                  {MODEL_LABELS[m]}
                </label>
              ))}
              <label className="flex items-center gap-2 text-sm opacity-50" title={fable}>
                <input type="radio" name="breakdown-model" disabled />
                🔒 Fable 5 — {fable}
              </label>
            </div>
          </div>
        )}
```

- [ ] **Step 6: Verify build + tests**

Run: `npm run test && npx tsc --noEmit && npm run build`
Expected: green.

- [ ] **Step 7: Commit**
```bash
git add src/lib/settings-read.ts src/app/actions/settings.ts "src/app/(app)/inbox/page.tsx" src/components/inbox/inbox-view.tsx src/components/inbox/settings-panel.tsx
git commit -m "feat(phase2): owner breakdown-model picker (rotating Fable lock) + dark toggle in settings"
```

---

### Task 11: Config, boot guard, env docs + final verification

**Files:**
- Modify: `src/lib/auth/config.ts` (extend `assertAuthConfig` for `GUEST_IP_HASH_SALT`)
- Modify: `.env.example` (document all new vars)
- Modify: `README.md` (Phase 2 config section — brief)

**Interfaces:**
- Consumes: existing `assertAuthConfig` boot-guard pattern.

- [ ] **Step 1: Edit `src/lib/auth/config.ts`** — fail fast in prod if the IP-hash salt is missing.

In `assertAuthConfig`, after the existing `missing` checks, add:
```typescript
  if (!process.env.GUEST_IP_HASH_SALT || process.env.GUEST_IP_HASH_SALT.length < 16)
    missing.push("GUEST_IP_HASH_SALT (>=16 chars)");
```

- [ ] **Step 2: Edit `.env.example`** — append the Phase 2 block:
```bash
# ── Phase 2: guest cost controls + models ───────────────────────────────────
GUEST_AI_QUOTA_PER_WINDOW=5
GUEST_AI_WINDOW_HOURS=24
GUEST_GLOBAL_DAILY_GUEST_CAP=10
GUEST_SANDBOX_TTL_HOURS=24
OWNER_BREAKDOWN_MODEL=claude-sonnet-4-6
GUEST_BREAKDOWN_MODEL=claude-haiku-4-5
# Secret — salts the guest IP hash (never stores the raw IP). >=16 chars.
GUEST_IP_HASH_SALT=CHANGEME-long-random-value
```

- [ ] **Step 3: Add a brief Phase 2 note to `README.md`** (under the existing config/deploy section): document that guest AI is capped (5/IP/24h + 10 guests/day, Haiku), owner model is selectable in Settings, `.ics` export needs no integration, dark mode persists in localStorage, and the new env vars (secret `GUEST_IP_HASH_SALT` via CI vars; tunables via `.gitlab-ci.yml`).

- [ ] **Step 4: Full verification**

Run: `npm run test && npx tsc --noEmit && npm run lint && npm run build`
Expected: all green.

- [ ] **Step 5: Local smoke (guest path, no ANTHROPIC key needed for fallback)**

Run a self-contained start→curl→kill (per project verification gotcha — always kill `next start` after):
```bash
export PATH="$HOME/.rd/bin:$PATH"; export DOCKER_HOST="unix://$HOME/.rd/docker.sock"
docker compose up -d db
npm run build && (npm run start & SERVER=$!; sleep 4; \
  curl -s localhost:3000/api/health; echo; \
  kill $SERVER)
```
Expected: `/api/health` → 200 `{"status":"ok"}`.

- [ ] **Step 6: Commit**
```bash
git add src/lib/auth/config.ts .env.example README.md
git commit -m "feat(phase2): boot guard for GUEST_IP_HASH_SALT + env/docs"
```

---

## Notes for execution

- **Task 4 depends on `getSettings`** (`src/lib/settings-read.ts`) created in Task 10 Step 1. If executing strictly in order, create that one-file helper during Task 4 (move Task 10 Step 1 earlier), or stub it. Recommended: create `src/lib/settings-read.ts` first if a subagent hits Task 4 before Task 10.
- **Prod deploy** (after merge, human-run): add the 6 tunables to `.gitlab-ci.yml` prod job env + `GUEST_IP_HASH_SALT` as a masked/protected CI var; the `checksum/secret` chart annotation (from !19) rolls pods on the new secret. Review apps get a dummy salt via CI (per Phase 1 pattern).
- **Deploy gotcha (secret rollout):** `envFrom: secretRef` alone won't roll pods on a same-image deploy — rely on the `checksum/secret` annotation, or the pods keep stale env (see workspace-access memory).
```
