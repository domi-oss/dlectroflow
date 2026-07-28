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

export const STORAGE_STATE = "playwright/.auth/owner.json";
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
