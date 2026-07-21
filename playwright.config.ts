import { defineConfig, devices } from "@playwright/test";
import { SESSION_SECRET, STORAGE_STATE, BASE_URL } from "./e2e/constants";

// Test dummies for the production boot guard (next start ⇒ NODE_ENV=production).
// AUTH_SESSION_SECRET MUST equal the value global-setup signs with.
const bootGuardEnv = {
  AUTH_PROVIDER: "gitlab",
  OWNER_ALLOWLIST: "1",
  AUTH_SESSION_SECRET: SESSION_SECRET,
  GITLAB_OAUTH_CLIENT_ID: "e2e-client-id",
  GITLAB_OAUTH_CLIENT_SECRET: "e2e-client-secret",
  GUEST_IP_HASH_SALT: "e2e-guest-ip-hash-salt-000",
  TOKEN_ENC_KEY:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: BASE_URL,
    storageState: STORAGE_STATE,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run start",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: bootGuardEnv,
  },
});
