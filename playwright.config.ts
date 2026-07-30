import { defineConfig, devices } from "@playwright/test";
import { config as readDotenvFile } from "dotenv";
import {
  SESSION_SECRET,
  STORAGE_STATE,
  BASE_URL,
  MEMBER_STORAGE_STATE,
  MEMBER_BASE_URL,
  TOKEN_ENC_KEY,
} from "./e2e/constants";

// ── The server under test is the artefact that ships (#97) ───────────────────
// `next.config.ts` sets `output: "standalone"`, so production runs
// `node server.js` out of the standalone bundle — see `CMD ["node",
// "server.js"]` in Dockerfile and Dockerfile.ci. This suite used to boot
// `next start`, which Next 16 warns about on every run ("next start" does not
// work with "output: standalone" configuration) and which differs from the
// shipped artefact in ways that stay invisible until production:
//
//   * Working directory / env. `server.js` calls `process.chdir(__dirname)`, so
//     Next's env loader reads `.next/standalone/.env` — the copy taken at BUILD
//     time — while `next start` reads the live `.env` in the project root.
//     Measured on #97: point the root `.env` at a database that does not exist,
//     restart without rebuilding, and `next start` answers /api/health with 503
//     while the standalone server answers 200 from its snapshot. Same code,
//     opposite results.
//   * Assets. The standalone bundle deliberately omits `public/` and
//     `.next/static` (Next assumes a CDN serves them); the runtime image copies
//     them in. Skip that copy and every HTML route still returns 200 while
//     every stylesheet, client chunk and public file 404s — an app with no
//     styling and no hydration that a status-code smoke check calls healthy.
//   * The bind address. `server.js` honours `process.env.HOSTNAME`; `next start`
//     ignores it and always binds 0.0.0.0. Docker sets HOSTNAME to the container
//     id on every container, so inside CI the standalone server binds the
//     container's own address and `http://localhost:3000` is refused — which is
//     exactly why Dockerfile and Dockerfile.ci both carry
//     `ENV HOSTNAME=0.0.0.0`. Reproduced with `HOSTNAME=runner-abc123 node
//     .next/standalone/server.js`: `getaddrinfo ENOTFOUND runner-abc123`. The
//     first CI run of this change hit it, which is a fair advertisement for the
//     switch: `next start` cannot see this class of bug at all.
//   * Modules. Only the traced dependency subtree is present, which is exactly
//     the class of failure #76 was (`dotenv` resolving only by hoisting).
//
// Cost of the switch is the asset copy below (~31 MB, well under a second); the
// `next build` this needs was already being run by the e2e_test CI job.

// Assemble the bundle the way the runtime image does, then exec the same
// entrypoint. The two copies mirror the asset COPYs in Dockerfile.ci's runner
// stage (`public` → ./public, `ci-dist/static` → ./.next/static);
// src/lib/dockerfile-hygiene.test.ts keeps the two sides in lock-step.
//
//   * `rm -rf` first: `cp -R` onto an existing tree merges rather than replaces,
//     so a file deleted from `public/` would live on in the standalone copy.
//   * `exec` last: the shell is replaced by node, so Playwright's teardown
//     signals reach the server itself instead of a wrapping shell.
const standaloneServerCommand = [
  // A sentence a human can act on, instead of a bare `cp` ENOENT.
  'test -f .next/standalone/server.js || { echo "e2e: .next/standalone/server.js is missing - run npm run build first" >&2; exit 1; }',
  "rm -rf .next/standalone/public .next/standalone/.next/static",
  "cp -R public .next/standalone/public",
  "cp -R .next/static .next/standalone/.next/static",
  "exec node .next/standalone/server.js",
].join(" && ");

// #118 — the SECOND server (see `webServer` below) boots the SAME assembled
// bundle on another port, so it deliberately does NOT repeat the assembly.
// Playwright starts webServer entries as sequential setup tasks, so by the time
// this one runs the first server is already listening and serving out of
// `.next/standalone/public` — re-running `rm -rf` on those files would blank the
// running server's assets mid-suite, which is a far worse failure than a slow
// boot (a suite of 200s and no CSS).
const memberServerCommand = "exec node .next/standalone/server.js";

// #84's problem one layer out. `DATABASE_URL` lives in `.env`, and under the
// standalone server that file resolves to the build-time snapshot inside
// `.next/standalone/` while global-setup — a different process, cwd at the
// project root — reads the live file. Rebuild-forgetting is then silent: the
// server and the fixtures talk to two different databases and nothing errors.
// Forwarding the live value settles it, because a real process env var always
// beats an env file in Next's loader.
//
// Mirrors vitest.config.ts (#84): Next's own precedence (`.env.local` beats
// `.env`), a real environment variable beats both (that is how CI supplies its
// service database, where no env file exists), parsing goes into a throwaway
// object rather than mutating process.env, and only DATABASE_URL is forwarded —
// so the API keys and TOKEN_ENC_KEY in a developer's env file cannot reach the
// server under test and displace the dummies below.
const envFileValues: Record<string, string | undefined> = {};
for (const file of [".env", ".env.local"]) {
  Object.assign(
    envFileValues,
    readDotenvFile({ path: file, processEnv: {} }).parsed ?? {},
  );
}
const DATABASE_URL = process.env.DATABASE_URL ?? envFileValues.DATABASE_URL;

// Test dummies for the production boot guard: both `next start` and the
// standalone `server.js` run with NODE_ENV=production (server.js sets it
// outright, before anything else).
// AUTH_SESSION_SECRET MUST equal the value global-setup signs with.
const bootGuardEnv = {
  // requestOrigin() refuses to derive an origin from request headers under
  // NODE_ENV=production, and the middleware calls it on the guest-minting path
  // to decide the cookie's Secure flag. Nothing exercised that path until #35
  // added a guest spec — every other spec carries the forged signed-in cookie
  // and short-circuits before guest minting — so the suite booted without this
  // and never noticed.
  PUBLIC_ORIGIN: BASE_URL,
  AUTH_PROVIDER: "gitlab",
  OWNER_ALLOWLIST: "1",
  AUTH_SESSION_SECRET: SESSION_SECRET,
  GITLAB_OAUTH_CLIENT_ID: "e2e-client-id",
  GITLAB_OAUTH_CLIENT_SECRET: "e2e-client-secret",
  // #106: makes the Google Tasks method CONFIGURED, which is the first of the two
  // conditions `scheduleState` needs before a row offers "Schedule" instead of
  // "Connect Google →". The second — a stored token, i.e. `connected` — is seeded
  // and torn down by e2e/smoke/schedule-menu.spec.ts alone, because it changes
  // every row's control for the whole run and only that spec wants it.
  //
  // Deliberately NOT a working credential. Nothing here can reach Google: the
  // menu spec opens the popover and reads it, and never presses Schedule, so no
  // token is exchanged and no request leaves the machine. On its own this pair
  // changes nothing visible either — with no token, `scheduleState` resolves to
  // "connect" exactly as it did when the id was absent.
  GOOGLE_CLIENT_ID: "e2e-google-client-id",
  GOOGLE_CLIENT_SECRET: "e2e-google-client-secret",
  GUEST_IP_HASH_SALT: "e2e-guest-ip-hash-salt-000",
  // Read from e2e/constants.ts, not restated: the fixtures encrypt the seeded
  // Google tokens with the same value from a DIFFERENT PROCESS (#118), and a
  // drift between the two decrypts to null and quietly tests the "reconnect
  // needed" state instead of a connected one.
  //
  // Listing it here also OVERRIDES any ambient value, which on `main` is the real
  // production key (a protected CI/CD variable, withheld from unprotected refs) —
  // so the server is pinned. !200 is the other half: the fixture processes are
  // pinned too, in e2e/google-credential.ts, because they used to let the ambient
  // value win and the two sides then disagreed on `main` alone.
  // src/lib/__tests__/e2e-token-key.harness.test.ts keeps the two in lock-step.
  TOKEN_ENC_KEY,
  // What Dockerfile and Dockerfile.ci both set, and for the same reason: the
  // standalone entrypoint reads HOSTNAME, Docker sets HOSTNAME to the container
  // id on every container, and a server bound to the container's own address
  // does not answer on localhost. Not a test workaround — it is the production
  // value. src/lib/dockerfile-hygiene.test.ts asserts all three agree.
  HOSTNAME: "0.0.0.0",
  // Only when there is one to forward — otherwise leave the key unset rather
  // than handing the server an empty connection string.
  ...(DATABASE_URL ? { DATABASE_URL } : {}),
};

// #118 Phase C — the member project's server. A dummy Google OAuth client is what
// makes the Google Tasks method OFFERED (`googleConfigured()`), which is the only
// way a member's own connect/disconnect controls are reachable at all.
//
// Its own port and its own env, rather than adding these two variables to
// `bootGuardEnv`: setting GOOGLE_CLIENT_ID globally flips the inbox 📅 control
// from "Add to calendar (.ics)" to "Schedule" for EVERY spec, and
// schedule-ics.spec.ts finds the .ics entry in the ▾ menu BY that label. Two
// servers keep the default suite's behaviour byte-identical.
//
// Deliberately not a working credential: no spec here pushes, so no request
// leaves the machine.
const memberServerEnv = {
  ...bootGuardEnv,
  // PUBLIC_ORIGIN must name THIS server, or requestOrigin() sends every redirect
  // (the OAuth start route included) at the other port.
  PUBLIC_ORIGIN: MEMBER_BASE_URL,
  PORT: String(new URL(MEMBER_BASE_URL).port),
  GOOGLE_CLIENT_ID: "e2e-google-client-id",
  GOOGLE_CLIENT_SECRET: "e2e-google-client-secret",
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
  projects: [
    {
      name: "chromium",
      // The member specs need the Google-configured server, so they are excluded
      // here rather than skipped inside the spec: a spec that silently passes
      // against the wrong server is worse than one that does not run.
      testIgnore: /member-google\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "member-google",
      testMatch: /member-google\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: MEMBER_BASE_URL,
        storageState: MEMBER_STORAGE_STATE,
      },
    },
  ],
  // Two entries, started SEQUENTIALLY by Playwright (each webServer is its own
  // setup task, awaited in turn) — which is what makes it safe for the second to
  // reuse the bundle the first assembled. `baseURL` is set explicitly on both
  // projects because an array of webServers does not derive one.
  webServer: [
    {
      command: standaloneServerCommand,
      url: `${BASE_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: bootGuardEnv,
    },
    {
      command: memberServerCommand,
      url: `${MEMBER_BASE_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: memberServerEnv,
    },
  ],
});
