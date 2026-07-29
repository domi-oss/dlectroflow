// Shared config for the Playwright smoke suite.
// SESSION_SECRET must be identical for (a) the app the webServer boots and
// (b) global-setup, which forges the owner cookie. The fallback keeps local
// and CI self-consistent when AUTH_SESSION_SECRET is unset in the environment.
export const SESSION_SECRET =
  process.env.AUTH_SESSION_SECRET ??
  "e2e-owner-session-secret-32bytes-minimum-0000";

/** The provider subject the forged session's account is keyed on. */
export const OWNER_SUB = "1";

// #35 Phase A — the session payload now names a REAL account and a REAL
// workspace, both of which global-setup writes to the database. A signed
// session pointing at a user row that does not exist still VERIFIES, and then
// resolves to nobody: currentUser() returns null, isOwnerRequest() is false,
// and every spec would quietly run as an unauthenticated visitor while
// continuing to pass. These ids are fixed rather than generated so specs that
// seed content (e2e/a11y-contrast.spec.ts) write into the same workspace the
// session resolves to.
export const OWNER_USER_ID = "e2e-owner-user";
export const OWNER_WS_ID = "e2e-owner-ws";
/** The forged owner's provider handle. #100 puts it on screen in the header, so
 *  it stops being an incidental fixture value and becomes something specs
 *  assert on — hence a named constant rather than a literal in global-setup. */
export const OWNER_HANDLE = "e2e-owner";

/**
 * A second, ordinary account (#35 Phase B). The People panel is unreviewable with
 * one row: the owner's own card deliberately has no Revoke control, so with only
 * the owner seeded there is nothing to exercise the revoke confirmation or the
 * capped-quota presentation against, and "the owner's row is FIRST" is a claim
 * about a list of one. Seeded active and capped; specs may open its revoke
 * confirmation but must not confirm it.
 */
export const MEMBER_USER_ID = "e2e-member-user";
export const MEMBER_WS_ID = "e2e-member-ws";
export const MEMBER_HANDLE = "e2e-member";

export const STORAGE_STATE = "playwright/.auth/owner.json";
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

/**
 * #118 Phase C — the member fixture becomes a CONNECTED, SIGNED-IN member.
 *
 * Phase B seeded MEMBER_USER_ID so the People panel had a row that is not the
 * owner's. Phase C needs that same account signed IN, with its own GoogleAuth
 * row, because "a member uses their own connection" is the whole feature and the
 * owner's session cannot exercise it.
 */
export const MEMBER_STORAGE_STATE = "playwright/.auth/member.json";

/**
 * The member's server runs on its own port with its own env, because
 * `GOOGLE_CLIENT_ID` is what makes the Google method OFFERED and setting it
 * globally would flip the 📅 control's label for EVERY existing spec —
 * schedule-ics.spec.ts finds the .ics entry in the ▾ menu BY that label.
 * Playwright's `webServer` is global rather than per-project, but the entries are
 * started SEQUENTIALLY, which is what makes two servers over one standalone
 * bundle safe (see playwright.config.ts).
 */
export const MEMBER_BASE_URL =
  process.env.E2E_MEMBER_BASE_URL ?? "http://localhost:3100";

/**
 * The token-encryption key the server under test runs with.
 *
 * Exported rather than restated in playwright.config.ts because global-setup
 * runs in a DIFFERENT PROCESS and has to encrypt the member's access token with
 * the same key: if the two ever drifted, the ciphertext would decrypt to null,
 * `getGoogleStatus` would report "reconnect needed", and the member specs would
 * quietly test the wrong state instead of failing.
 */
export const TOKEN_ENC_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/**
 * A fake but well-formed access token for the member's credential. Encrypted by
 * global-setup with the app's own cipher, so `connected` reads true. Deliberately
 * NOT a working credential: the member specs read status and open controls, they
 * never push, so no request ever leaves the machine.
 */
export const MEMBER_GOOGLE_ACCESS_TOKEN = "e2e-member-google-access-token";
