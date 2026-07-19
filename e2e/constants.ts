// Shared config for the Playwright smoke suite.
// SESSION_SECRET must be identical for (a) the app the webServer boots and
// (b) global-setup, which forges the owner cookie. The fallback keeps local
// and CI self-consistent when AUTH_SESSION_SECRET is unset in the environment.
export const SESSION_SECRET =
  process.env.AUTH_SESSION_SECRET ?? "e2e-owner-session-secret-32bytes-minimum-0000";
export const OWNER_SUB = "1";
export const STORAGE_STATE = "playwright/.auth/owner.json";
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
