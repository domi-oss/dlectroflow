# Accounts / per-user foundation — invite-only users, per-user integrations, owner-managed AI policy

Issue: #35 (sub-project **F** of epic #29). Milestone: **v0.5.0**.
Status: design approved by the owner 2026-07-27. Supersedes the "XL, needs its own spec" placeholder on #35.

## Goal

Replace the owner-binary model — `OWNER_WORKSPACE_ID = "owner"` plus a `GoogleAuth` row literally keyed `"singleton"` — with **real user records that own workspaces**, so that:

1. More than one human can use the hosted instance, by invitation only.
2. Integrations and LLM keys become **per user**, which is the precondition for the scheduling phases S2 (per-user ICS feed), S3 (per-user Google Tasks) and S4 (free/busy slot-finding).
3. The owner can manage what each person costs, without being able to read what they write.

## Decisions (owner, 2026-07-27)

| Question | Decision |
|---|---|
| Who can have an account | **Invite-only.** No open signup. |
| How you invite | **Allowlist an identity**, stored as a `(provider, identity)` pair so #74 (more OAuth providers) needs no migration. |
| Who pays for AI | **Owner-managed per-user policy**: `uncapped`, `capped`, or `own_key`. "Capped until you bring your key" is the capped state auto-yielding once a key is present. The owner's own account is `uncapped`. |
| What the owner can see | **Usage numbers only, never content.** |
| Guest who then signs in | **One-time prompted carryover** of their sandbox. |
| The existing `"owner"` workspace | **Export, then purge.** The owner starts fresh; no data migration. |
| Settings shape | **One page.** An **Account** group at the top of `/settings`; the menu item flips from "Sign in" to "Account" and deep-links to `/settings#account`. |
| Revoking access | **Freeze, then purge after 30 days**, reusing the guest-expiry purge job. |

## Non-goals

- Open signup, billing, teams/shared workspaces, or roles beyond `owner` / `member`.
- Account linking (one human, two providers) and additional providers themselves — that is #74.
- Owner impersonation or any support access to another user's content. Explicitly rejected: it would create the cross-workspace read path this design exists to avoid.
- Prompt-level or per-feature quotas beyond the breakdown cap.

## Current state

- `Workspace` (`prisma/schema.prisma:20`) already has `kind` (`owner | guest`) and every content model already carries `workspaceId` with `onDelete: Cascade`. **The data layer is already multi-tenant; only identity is missing.**
- `resolveWorkspaceId()` (`src/lib/workspace.ts:20`) maps a verified `kind: "owner"` session to the constant `OWNER_WORKSPACE_ID`, and a `kind: "guest"` session to its own `wsId`.
- `isOwnerRequest()` (`src/lib/workspace.ts:66`) is the single owner check; `OWNER_ONLY_PREFIXES` in `src/lib/auth/gate.ts:5` gates owner-only routes.
- `authProvider()` (`src/lib/auth/providers.ts:69`) switches on `AUTH_PROVIDER` with only `gitlab` implemented.
- `GoogleAuth` (`prisma/schema.prisma:100`) is a single row with `@default("singleton")`.
- `GuestAiUsage` (`:291`) already models metered AI usage per workspace — the per-user cap mirrors it rather than inventing a second mechanism.
- `src/lib/crypto/token-cipher.ts` already encrypts OAuth tokens at rest; per-user LLM keys reuse it unchanged.
- `guestSandboxTtlHours()` / the purge job (`src/lib/purge.ts`) already delete expired workspaces — revocation purge extends this, it does not add a second deleter.

## Design

### 1. Data model

```prisma
model User {
  id           String    @id @default(cuid())
  provider     String    // "gitlab" — see #74
  providerSub  String    // stable subject from the provider, never the email
  email        String?
  handle       String?
  role         String    @default("member")  // owner | member
  status       String    @default("active")  // active | revoked
  aiPolicy     String    @default("capped")  // uncapped | capped | own_key
  aiQuota      Int       @default(50)        // breakdowns per rolling 30 days when capped
  llmProvider  String?                       // null = instance default
  llmKeyEnc    String?                       // token-cipher ciphertext, never returned to a client
  revokedAt    DateTime?
  purgeAfter   DateTime?
  createdAt    DateTime  @default(now())
  lastSeenAt   DateTime  @default(now())
  workspace    Workspace?
  aiUsage      UserAiUsage[]

  @@unique([provider, providerSub])
  @@index([status, purgeAfter])
}

model Allowlist {
  id           String    @id @default(cuid())
  provider     String
  identity     String    // username or email as the owner typed it, lowercased
  note         String?
  invitedAt    DateTime  @default(now())
  claimedAt    DateTime?
  claimedById  String?   @unique

  @@unique([provider, identity])
}

model UserAiUsage {  // mirrors GuestAiUsage
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  day       DateTime @db.Date
  count     Int      @default(0)

  @@unique([userId, day])
}
```

`Workspace` gains `userId String? @unique` + relation, and `kind` gains the value `user`. `GoogleAuth` gains `userId String @unique` and loses its `@default("singleton")` id.

`role` and `status` are pseudo-enums, so both need CHECK constraints mirrored in `src/lib/constants.ts` and registered with the enum-constraint-sync integration test, exactly as `Settings.focusTimerStyle` does. `aiPolicy` likewise.

### 2. Sign-in and provisioning

`AuthProvider` gains a `subject` on its normalized profile. The callback:

1. Verify the provider callback as today.
2. Look up `User` by `(provider, providerSub)`.
   - Found and `status = active` → session.
   - Found and `status = revoked` → deny with a plain "access has been removed" page. **Never silently re-provision a revoked user.**
3. Not found → look up `Allowlist` by `(provider, identity)` against the profile's username **and** email, lowercased.
   - Hit → create `User` + `Workspace` + claim the allowlist row in one transaction, then session.
   - Miss → deny with "you need an invitation". No account is created, and the response is identical whether or not the identity exists, so it cannot be used to probe the allowlist.

Session payload changes from `{ kind: "owner" }` to `{ kind: "user", userId, wsId }`; `kind: "guest"` is untouched. `resolveWorkspaceId()` returns `wsId` from the user session instead of the constant, and `isOwnerRequest()` becomes `currentUser()?.role === "owner"`.

**`OWNER_WORKSPACE_ID` is deleted in this release**, along with the `kind: "owner"` session branch. Existing owner cookies stop validating, so the owner signs in again once — acceptable because the owner is the only holder of one.

### 3. AI policy enforcement

In `src/app/api/breakdown/route.ts`, resolution order for an authenticated user:

1. `own_key` **or** a key is present → decrypt `llmKeyEnc`, use their provider/key, no cap. (This is why "capped until you bring your key" needs no separate state: the presence of a key wins.)
2. `uncapped` → instance key, no cap.
3. `capped` → instance key, `UserAiUsage` incremented in the same transactional pattern `consumeGuestBreakdown` already uses for per-IP atomicity; over quota returns the same shaped error the guest cap returns.

Guests keep their existing quota path unchanged.

### 4. People screen (owner-only)

New `Account` group at the top of `/settings`, and within it a **People** panel visible only to `role = owner`:

- List: handle, provider, last seen, AI policy, usage this period against quota, whether their own key is set (boolean, never the key), status.
- Actions: add an allowlist entry, change a user's policy/quota, revoke.
- **No route in the codebase accepts a workspace id and returns content.** The People queries read `User`/`UserAiUsage` only. This is asserted by test, not just by convention (see Testing).

The rest of the Account group is per-user and visible to any signed-in user: identity + sign out, integrations (Google/Reclaim), own LLM key + model, export, delete account.

### 5. Per-user integrations

`GoogleAuth` becomes one row per user, keyed by `userId`. Every call site in `src/app/actions/google-schedule.ts` currently guards with `workspaceId !== OWNER_WORKSPACE_ID`; each becomes "load the current user's `GoogleAuth`", which is the same guard expressed correctly — a user without a connection simply has no row. The OAuth callback writes the row for the user who initiated it, and `OWNER_ONLY_PREFIXES` drops `/api/google/oauth/` because it is now per-user rather than owner-only.

### 6. Guest carryover

On first sign-in, if a valid signed guest cookie is present and its workspace has any rows, the Account group shows a one-time prompt. Accepting runs one transaction that repoints every content row from the guest workspace to the user's workspace and expires the guest workspace immediately. Declining does nothing and the sandbox expires on its normal TTL. The prompt is offered once; the decision is recorded so it does not reappear.

**Authorization:** the claim is authorized by the guest cookie's own signature, verified server-side — possession of the cookie is what proves the sandbox is theirs. The guest workspace id is never accepted from a request body.

### 7. Export, revocation, purge

- **Export** — an authenticated route streaming a JSON document of the caller's own workspace. Scoped to `currentWorkspaceId()`; it takes no id parameter.
- **Revoke** — sets `status = revoked`, `revokedAt = now`, `purgeAfter = now + 30d`. Sign-in is blocked immediately; data is untouched.
- **Purge** — the existing purge job gains a second sweep: delete workspaces whose user has `purgeAfter < now`. Cascade handles the content. The job logs counts before deleting and refuses to run if the count exceeds a sanity threshold, because this is the one code path in the app that destroys real data.
- **The legacy `"owner"` workspace** — the owner exports it via the same route, and a one-off script (not an automatic migration) deletes it afterwards. Deliberately manual: an automatic delete of production data on deploy is not worth the convenience.

## Testing (TDD)

Beyond per-unit tests, three suites carry the security weight:

1. **Scoping harness** — enumerate every Prisma model carrying `workspaceId` and assert each data-access function filters by it. This codebase has shipped an IDOR bug before; the harness is what makes "usage only, never content" structurally true rather than aspirational. A new model with no scoping fails the suite.
2. **Provisioning matrix** — allowlisted / not allowlisted / revoked / already-claimed, each asserting both the outcome and that no `User` row is created on the deny paths.
3. **Policy matrix** — `uncapped` / `capped` under and over quota / `own_key` with and without a key present, asserting which key is used and whether usage is metered.

Carryover gets an explicit negative test: a forged or absent guest cookie cannot claim another workspace's rows.

## Rollout / risk

| Risk | Mitigation |
|---|---|
| Owner locked out by the session-kind cutover | The allowlist is seeded with the owner's own identity in the same migration that adds it; the owner signs in once after deploy. Verify on the review app before production. |
| Purge job deletes live data | Count-and-log before delete, sanity threshold, and the legacy-owner purge is a manual script rather than a migration. |
| Google singleton migration | Fresh start means no token migration: the singleton row is dropped and the owner reconnects Google once. |
| Four phases racing five other v0.5.0 MRs | Phase A lands alone (it touches auth and session shape); B/C/D branch off it. |

## Phases

Each is a separate MR. A blocks the rest; B, C and D are independent of one another.

- **A — Identity foundation.** `User`/`Allowlist` models, provisioning, session shape, `resolveWorkspaceId`/`isOwnerRequest` rewrite, deletion of `OWNER_WORKSPACE_ID`, menu "Sign in" → "Account", scoping harness. *~1–2 days.*
- **B — People admin + AI policy.** People panel, policy/quota enforcement, `UserAiUsage`. *~1 day.*
- **C — Per-user integrations + key.** `GoogleAuth` per user, encrypted per-user LLM key, Account group in `/settings`. Unblocks S2/S3/S4. *~1.5 days.*
- **D — Lifecycle.** Guest carryover prompt, JSON export, revoke → freeze → 30-day purge, legacy-owner purge script. *~1 day.*
