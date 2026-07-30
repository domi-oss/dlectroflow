import type { PrismaClient } from "@prisma/client";
import { encryptToken } from "../src/lib/crypto/token-cipher";
import { TOKEN_ENC_KEY } from "./constants";

/**
 * The suite's Google credential fixture, and the one place that decides which
 * key it is encrypted with.
 *
 * ── Why this module exists (!200) ────────────────────────────────────────────
 * `playwright.config.ts` hands both servers under test an EXPLICIT
 * `TOKEN_ENC_KEY` (the constant below), which overrides whatever the ambient
 * environment carries. The fixture side used to be the other way round:
 * global-setup pinned the same constant only `if (!process.env.TOKEN_ENC_KEY)`,
 * and schedule-menu.spec.ts called `encryptToken` with no pin at all — so the
 * ambient value won in the seeding processes and lost in the servers.
 *
 * On a merge-request ref that made no difference, because the project's
 * `TOKEN_ENC_KEY` CI/CD variable is PROTECTED and GitLab withholds protected
 * variables from unprotected refs: `process.env.TOKEN_ENC_KEY` was simply
 * unset, both sides used the constant, and the suite was green. On `main` — the
 * one protected branch — the real production key IS injected into every job,
 * including `e2e_test`. The fixtures then encrypted with the production key
 * while the servers decrypted with the constant, `decryptNullable` returned
 * null for a column that was plainly not null, and `getGoogleStatus` reported
 * `connected: false` + `needsReconnect: true`. The member's Settings rendered
 * "Reconnect needed", every 📅 control fell back to .ics, and four specs failed
 * on a tree that had passed twice an hour earlier. Same code, different ref.
 *
 * So the rule is: the suite owns this key outright, in EVERY process, and never
 * consults the environment for it. Pinning unconditionally is what makes the
 * suite's behaviour identical on a feature branch and on `main` — which is the
 * property that was actually missing, not any amount of extra timeout.
 *
 * The counterpart to `SESSION_SECRET`, which resolves the opposite way on
 * purpose (`process.env.AUTH_SESSION_SECRET ?? fallback`) and is safe there
 * *because* both sides read the same expression: `bootGuardEnv` gives the server
 * the value `e2e/constants.ts` computed, so runner and server agree whatever the
 * environment holds. A hard-coded constant cannot follow the environment like
 * that, so it must be forced instead.
 */

/** The scope the app itself requests — see `SCOPE` in src/lib/google.ts. */
const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";

/**
 * Force `TOKEN_ENC_KEY` to the suite's key for the CURRENT process.
 *
 * Unconditional, and deliberately not restored: token-cipher reads the variable
 * on every call, no process in the suite has any use for another key, and a
 * conditional pin is the exact bug described above. Called at the point of use
 * rather than once at import, so it holds in the runner (global-setup) and in
 * every worker process without depending on which of them loaded what first.
 */
export function pinTokenEncKey(): void {
  process.env.TOKEN_ENC_KEY = TOKEN_ENC_KEY;
}

/**
 * Encrypt a fixture token with the key the server under test decrypts with.
 * The only way this suite should ever produce a token ciphertext.
 */
export function encryptFixtureToken(plaintext: string): string {
  pinTokenEncKey();
  return encryptToken(plaintext);
}

/**
 * Give ONE user a connected Google credential, keyed on their `userId` (#118).
 *
 * No refresh token and no expiry, on create and on update alike: an expiry in
 * the past would send `getValidAccessToken` down the refresh path and a refresh
 * token would be offered to Google's revoke endpoint on disconnect, so the
 * absence of both is what keeps the suite off the network. Re-asserted rather
 * than created-if-missing, so a spec that disconnected cannot leak into the next
 * run.
 */
export async function seedConnectedGoogle(
  client: PrismaClient,
  userId: string,
  accessToken: string,
): Promise<void> {
  const encrypted = encryptFixtureToken(accessToken);
  await client.googleAuth.upsert({
    where: { userId },
    create: {
      userId,
      accessToken: encrypted,
      refreshToken: null,
      expiresAt: null,
      scope: TASKS_SCOPE,
      needsReconnect: false,
    },
    update: {
      accessToken: encrypted,
      refreshToken: null,
      expiresAt: null,
      scope: TASKS_SCOPE,
      needsReconnect: false,
    },
  });
}

/**
 * Put ONE user back to "configured but not connected" — the state every spec
 * outside the Google ones expects. The row is left in place (a spec that asserts
 * "no credential row" wants `disconnectGoogle` semantics, not this), and
 * `needsReconnect` is cleared too so the state is unambiguously "never
 * connected" rather than "connection went bad".
 */
export async function clearGoogleTokens(
  client: PrismaClient,
  userId: string,
): Promise<void> {
  await client.googleAuth.updateMany({
    where: { userId },
    data: {
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      needsReconnect: false,
    },
  });
}
