# Token encryption at rest — design (#21 P2)

**Date:** 2026-07-13
**Work item:** #21 (blind-spot audit remediation), Priority 2.
**Depends on:** P1 backups (shipped + restore-verified 2026-07-13) — this includes a destructive migration, so a tested restore path must exist first. ✅

## Problem

Third-party OAuth credentials are stored **plaintext** in Postgres:
- `ReclaimAuth.clientSecret`, `ReclaimAuth.accessToken`, `ReclaimAuth.refreshToken`
- `GoogleAuth.accessToken`, `GoogleAuth.refreshToken`

These are long-lived credentials to the owner's **real** Google Tasks + Reclaim accounts. Any DB-read path (leaked backup, SQL injection, compromised pod, exposed `POSTGRES_PASSWORD`, curious operator) yields durable account takeover — not just app data. Confirmed by the 2026-07-13 audit and re-confirmed live: the P1 backup dump contained these tokens in plaintext.

## Goal

A DB leak alone must not expose usable tokens. Encrypt the sensitive columns at rest with a key that lives **outside** the database, so an attacker needs both the DB and the app's key material.

## Decisions (locked in brainstorm 2026-07-13)

1. **Key source — app-level AES-256-GCM with an env key.** 32-byte key delivered via GitLab Secrets Manager → Helm → env (`TOKEN_ENC_KEY`), same path as the other secrets. Rejected GCP KMS: the app pod has no Workload Identity today, per-decrypt KMS calls + IAM are meaningful infra, and against this app's threat model (DB leak) the marginal gain over an env key is small.
2. **Existing prod tokens — clean slate / reconnect.** The migration clears both singleton auth rows; the owner reconnects Google + Reclaim once. This removes any plaintext-passthrough code path and lets decryption *require* ciphertext (safer). Acceptable because the accounts are the owner's own and reconnect is one click each.

## Design

### Crypto module — `src/lib/crypto/token-cipher.ts` (new)

Pure, dependency-light, unit-testable. No Prisma/SDK imports.

- `encryptToken(plaintext: string): string`
  → `"v1:" + base64( iv(12 bytes) ‖ authTag(16 bytes) ‖ ciphertext )`, AES-256-GCM, a fresh random IV per call.
- `decryptToken(stored: string): string`
  → parses the `v1:` envelope, verifies the GCM auth tag, returns plaintext. **Throws** on a missing/unknown version prefix, malformed payload, or auth-tag failure (tamper). No plaintext passthrough.
- Key loading: read `TOKEN_ENC_KEY` (a 64-char **hex** string), hex-decode, assert exactly 32 bytes; throw a clear error otherwise. Lazy (loaded on first use), mirroring `getAnthropic()` so `next build` doesn't require the key. (Hex, not base64, so the value is cleanly maskable as a GitLab CI variable.)
- The `v1:` prefix is a forward hook for future key rotation (a later `v2:` with a new key). Rotation itself is **not** built now (YAGNI).

### Wiring — `src/lib/reclaim.ts`, `src/lib/google.ts`

Encrypt at the write choke points, decrypt at point of use. Null stays null (a disconnected/absent credential is `null`, never encrypted or decrypted).

- **Reclaim writes:** `storeTokens()` (accessToken, refreshToken) and the `clientSecret` write in `ensureClient()`.
- **Google writes:** `storeTokens()` (accessToken, refreshToken).
- **Reads (decrypt):** `getValidAccessToken()`, `refreshAccessToken()`, `exchangeCode()` (Reclaim `clientSecret` use), and the `clientSecret` use inside `ensureClient()`/token exchange.
- Non-secret fields are untouched: `clientId`, `redirectUri`, `expiresAt`, `scope`. Status checks (`getReclaimStatus`/`getGoogleStatus`) still key off `Boolean(accessToken)` — the *presence* of ciphertext is a fine connected-signal and needs no decrypt.

### Migration — clear both singleton rows

A Prisma migration deletes the `ReclaimAuth` and `GoogleAuth` singleton rows. `getAuth()` re-upserts an empty row on next access. Effect:
- Reclaim: no `clientId`/`redirectUri` → `ensureClient()` re-registers a fresh OAuth client on reconnect, so the new `clientSecret` is encrypted from birth (the orphaned old client is harmless for a demo).
- Google: tokens cleared; its client id/secret come from env, not the DB.
- Both report "disconnected" post-deploy until the owner clicks Connect.

Forward-only; rollback path is the pre-deploy backup (per runbook §13). Backups now exist and are restore-verified.

### Key delivery + boot guard

- **`values.yaml`:** add `secrets.tokenEncKey: ""`.
- **`secret.yaml`:** add `TOKEN_ENC_KEY: {{ .Values.secrets.tokenEncKey | quote }}` in the **all-envs** block (the image always runs `NODE_ENV=production`, so review apps enforce it too — same reasoning as `GUEST_IP_HASH_SALT`).
- **`.gitlab-ci.yml`:** `TOKEN_ENC_KEY` is a **masked + hidden + protected** project CI variable (already provisioned; same delivery pattern as `AUTH_SESSION_SECRET`, not the Secrets Manager `secrets:` block).
  - `deploy_production`: pass `--set-string secrets.tokenEncKey="$TOKEN_ENC_KEY"` (the protected var resolves on `main`).
  - `deploy_review`: generate a per-deploy dummy key `TOKEN_ENC_KEY=$(openssl rand -hex 32)` (mirrors the per-deploy `AUTH_SESSION_SECRET`; review apps hold no real tokens, and the protected var isn't exposed to unprotected MR branches anyway).
- **Boot guard (`src/lib/auth/config.ts`):** in `assertAuthConfig()`, require `TOKEN_ENC_KEY` present and hex-decoding to 32 bytes (64 hex chars); add to the `missing[]` list so prod refuses to boot without it (fail-closed, consistent with the existing checks).
- **`.env.example`:** document `TOKEN_ENC_KEY` with a generate hint (`openssl rand -hex 32`).

## Testing (TDD)

- **`token-cipher.test.ts` (pure):** encrypt→decrypt round-trip; ciphertext ≠ plaintext; a fresh IV per call (two encrypts of the same input differ); `decryptToken` rejects a tampered payload (GCM auth failure), a non-`v1:` value, and malformed base64; key-length validation (reject a non-32-byte key). Tests set a fixed test `TOKEN_ENC_KEY`.
- **`reclaim.ts` / `google.ts`:** with a mocked Prisma, assert `storeTokens()` persists ciphertext (the stored value starts with `v1:` and ≠ the plaintext) and that `getValidAccessToken()` returns the original plaintext (round-trips through the DB layer). Assert `null` tokens are stored/returned as `null`.
- Full existing suite stays green; `tsc` clean.

## Deploy sequencing (important)

1. **Provision `TOKEN_ENC_KEY` first** — ✅ **DONE 2026-07-13**: generated a 32-byte hex key and stored it as a **masked + hidden + protected** project CI variable on dlectroflow (value unrecoverable by design; the pipeline still injects it into the prod deploy). If this were absent when the change deploys, the boot guard would stop prod from starting.
2. Merge → migrate initContainer clears the token rows → app boots (guard satisfied) → owner reconnects Google + Reclaim → all writes encrypted.
3. Verify: reconnect both, confirm a subsequent backup dump shows the token columns as `v1:` ciphertext (not plaintext).

## Scope

- **New:** `src/lib/crypto/token-cipher.ts`, its test, one Prisma migration.
- **Edit:** `src/lib/reclaim.ts`, `src/lib/google.ts`, `src/lib/auth/config.ts`, `charts/dlectroflow/values.yaml`, `charts/dlectroflow/templates/secret.yaml`, `.gitlab-ci.yml`, `.env.example`.
- **Out of scope (tracked elsewhere):** key rotation mechanism; `sslmode=require` on the DB connection (audit item, separate); revoked-token cleanup / status-lies fix (audit #21 P2 item 4 — related but distinct, can follow).

## Non-goals / accepted

- Encrypting non-secret columns (`scope`, `expiresAt`, `clientId`, `redirectUri`) — no security value.
- Protecting against a fully compromised app pod (it holds the key in memory by necessity); the goal is defeating **DB-only** exposure.
