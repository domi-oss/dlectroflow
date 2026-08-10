import { defineConfig, devices } from "@playwright/test";
import { config as readDotenvFile } from "dotenv";
import path from "node:path";
import {
  SESSION_SECRET,
  STORAGE_STATE,
  BASE_URL,
  MEMBER_STORAGE_STATE,
  MEMBER_BASE_URL,
  TOKEN_ENC_KEY,
} from "../e2e/constants";

// #133 — this file lives in `config/`, not the repo root. Playwright resolves
// `testDir` and `globalSetup` against THIS FILE's directory, and — the one that
// bites hardest — so does `webServer.cwd`, which defaults to the config's
// directory rather than to the project root. Every shell path in the server
// commands below (`.next/standalone/server.js`, `public`, `.next/static`) is
// relative to that cwd, so without the explicit `cwd` the suite would try to
// boot `config/.next/standalone/server.js` and fail the preflight check with a
// message about a missing build rather than about a misconfigured path.
const REPO_ROOT = path.resolve(__dirname, "..");

// ── The server under test is the artefact that ships (#97) ───────────────────
// `next.config.ts` sets `output: "standalone"`, so production runs
// `node server.js` out of the standalone bundle — see `CMD ["node",
// "server.js"]` in docker/Dockerfile and docker/Dockerfile.ci. This suite used to boot
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
//     exactly why docker/Dockerfile and docker/Dockerfile.ci both carry
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
// entrypoint. The two copies mirror the asset COPYs in docker/Dockerfile.ci's runner
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
// Absolute since #133, for the reason config/vitest.config.ts states at the
// same spot: dotenv resolves a relative path against `process.cwd()`, and a
// missed env file is silent — it drops DATABASE_URL rather than erroring, which
// is exactly the two-databases divergence the paragraph above is about.
const envFileValues: Record<string, string | undefined> = {};
for (const file of [".env", ".env.local"]) {
  Object.assign(
    envFileValues,
    readDotenvFile({ path: path.join(REPO_ROOT, file), processEnv: {} })
      .parsed ?? {},
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
  // What docker/Dockerfile and docker/Dockerfile.ci both set, and for the same reason: the
  // standalone entrypoint reads HOSTNAME, Docker sets HOSTNAME to the container
  // id on every container, and a server bound to the container's own address
  // does not answer on localhost. Not a test workaround — it is the production
  // value. src/lib/dockerfile-hygiene.test.ts asserts all three agree.
  HOSTNAME: "0.0.0.0",
  // Only when there is one to forward — otherwise leave the key unset rather
  // than handing the server an empty connection string.
  ...(DATABASE_URL ? { DATABASE_URL } : {}),
};

// #118 Phase C — the member project's server.
//
// The dummy Google OAuth client that makes the Tasks method OFFERED
// (`googleConfigured()`) is inherited from `bootGuardEnv`, which has carried it
// since #106 — this server does not restate it. !200 corrected the comment that
// used to sit here: it said the pair was kept off the shared server because
// setting GOOGLE_CLIENT_ID globally "flips the inbox 📅 control for EVERY spec",
// which is not what happens and not what the config does. `scheduleState` needs
// configured AND connected, so with no stored token the default project's rows
// resolve to "connect" with the client id present exactly as they would without
// it. What the second server actually buys is its own PUBLIC_ORIGIN and PORT.
//
// Deliberately not a working credential: no spec here pushes, so no request
// leaves the machine.
const memberServerEnv = {
  ...bootGuardEnv,
  // PUBLIC_ORIGIN must name THIS server, or requestOrigin() sends every redirect
  // (the OAuth start route included) at the other port.
  PUBLIC_ORIGIN: MEMBER_BASE_URL,
  PORT: String(new URL(MEMBER_BASE_URL).port),
};

/**
 * The specs that must run as the invited MEMBER rather than as the owner.
 *
 * A filename prefix rather than a list, and stated ONCE so the two projects
 * cannot disagree: `chromium` ignores exactly what `member` claims. A spec that
 * matched neither would silently never run, and one that matched both would run
 * a member's assertions against the owner's session and fail for the wrong
 * reason. Name a new one `member-*.spec.ts` and it lands in the right project.
 */
const MEMBER_SPECS = /member-[\w-]+\.spec\.ts/;

/**
 * The specs that make up the ACCESSIBILITY GATE — the only project that runs
 * with no retries (#127). See the `a11y` project below for why.
 *
 * Two shapes, because the gate grew in two places: the baseline-relative WCAG
 * scans live in `e2e/a11y/`, and the zero-tolerance contrast gate is the
 * single file `e2e/a11y-contrast.spec.ts` (deliberately left where it is —
 * moving it would churn the half-dozen `src/` comments that cite it by path
 * for no behavioural gain). `a11y` followed by `-` or a path separator catches
 * both and nothing else; anchoring on `/e2e/` keeps a checkout that happens to
 * sit under an `a11y/` directory from matching every spec in the suite.
 *
 * The `\.spec\.ts$` tail is load-bearing, not decoration: a project's
 * `testMatch` REPLACES the top-level `testMatch: "**\/*.spec.ts"` rather than
 * intersecting with it (MEMBER_SPECS above gets away with the same thing only
 * because it spells the extension out too). Without the tail this also matched
 * `e2e/a11y/axe-helpers.ts`, and Playwright refused to collect the suite at all
 * — "test file a11y-contrast.spec.ts should not import test file
 * a11y/axe-helpers.ts", once per importer.
 *
 * Put a new gate spec in `e2e/a11y/` and it lands here. Anything else keeps
 * the retry, which is the safe direction to fail: a spec in the wrong project
 * is over-tolerant, not silently unrun.
 */
const A11Y_SPECS = /[\\/]e2e[\\/]a11y[-\\/].*\.spec\.ts$/;

export default defineConfig({
  testDir: path.join(REPO_ROOT, "e2e"),
  testMatch: "**/*.spec.ts",
  globalSetup: path.join(REPO_ROOT, "e2e", "global-setup.ts"),
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // The default for the SMOKE projects only — the `a11y` project overrides it
  // to 0 and explains why (#127).
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
    // ── #127: the accessibility gate gets no second chance ───────────────────
    // `retries: 1` above is the right default for a smoke suite — a runner that
    // drops a connection or a container that stalls under load is noise, and
    // re-running it is cheaper than re-running a human. It is the WRONG default
    // here, because a retry-masked flake in these specs is INDISTINGUISHABLE
    // from a real AA regression that happens to be timing-dependent. Both read
    // as "failed once, passed once"; Playwright calls both green and files the
    // detail in a flaky-test summary that nothing gates on. One is noise, the
    // other is a shipped contrast bug, and the gate cannot tell you which.
    //
    // #110 was exactly that shape: a genuine 1 ms race the suite had been
    // quietly absorbing. It was found by instrumenting and CPU-throttling the
    // page, not by the gate — because the gate had a retry to spend.
    //
    // Chosen over the two alternatives #127 also lists, on evidence rather than
    // taste:
    //   * `retries: 0` for the WHOLE suite is stricter than the problem. The
    //     smoke specs boot two standalone servers against a real Postgres and
    //     drive redirect chains; a one-off there is genuinely more likely to be
    //     the infrastructure than the app, and the AA question is not on trial.
    //   * `failOnFlakyTests` is a TestConfig field with no TestProject
    //     equivalent (checked against @playwright/test 1.61's types), so it is
    //     all-or-nothing across projects and cannot express "strict here,
    //     tolerant there" at all.
    // Measured before committing to it, 2026-08-06: these 59 tests were run
    // 30x each locally (1,770 runs) at retries 0, zero failures. The gate is
    // not absorbing anything today, so zero tolerance costs nothing now and
    // starts failing loudly the day that stops being true.
    //
    // Runs FIRST, and that is now ENFORCED rather than assumed. Several of
    // these specs seed and delete rows in the shared owner workspace, so
    // running them after the smoke suite would change the database state they
    // scan against — a real behaviour change that a config reshuffle could
    // smuggle in.
    //
    // This used to rest on "with `workers: 1` Playwright runs projects in
    // declaration order". That is an observed implementation detail, not a
    // documented contract, and nothing verified it — so reordering this array
    // would have silently reintroduced the hazard (raised in review on !277).
    // The other two projects now declare `dependencies: ["a11y"]`, which makes
    // the runner itself responsible for the ordering, and
    // `e2e-project-split.test.ts` additionally pins the array position as a
    // second line of defence in case the dependencies are ever removed.
    //
    // The cost, stated because it is a real change to the CI signal: a failing
    // a11y project now SKIPS chromium and member rather than letting them run
    // independently. That is the right trade for this suite — the a11y gate
    // failing means the shared workspace state is not what the smoke specs
    // assume anyway, so their result would not have been trustworthy.
    {
      name: "a11y",
      testMatch: A11Y_SPECS,
      retries: 0,
      use: {
        ...devices["Desktop Chrome"],
        // Without this, `retries: 0` would cost this project its diagnostics:
        // the global `trace: "on-first-retry"` records nothing when there is no
        // first retry, so a failing contrast scan would arrive with no trace at
        // all — strictly worse than what it replaces. `retain-on-failure` is
        // the no-retry equivalent, and the html reporter inlines the trace into
        // `playwright-report/`, which e2e_test already uploads on failure.
        trace: "retain-on-failure",
      },
    },
    {
      name: "chromium",
      // Ordering, enforced by the runner — see the a11y project above.
      dependencies: ["a11y"],
      // The member specs need the member's own session, so they are excluded
      // here rather than skipped inside the spec: a spec that silently passes
      // against the wrong server is worse than one that does not run. The a11y
      // specs are excluded for a different reason — they are their own project
      // above, and matching here too would run every scan twice, the second
      // time with a retry that defeats the point.
      testIgnore: [MEMBER_SPECS, A11Y_SPECS],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // #153 renamed this from `member-google`: the project is "the member's own
      // session", and Google was merely its first occupant. Self-serve account
      // deletion is the second, and it is not a Google feature.
      name: "member",
      // Ordering, enforced by the runner — see the a11y project above.
      dependencies: ["a11y"],
      testMatch: MEMBER_SPECS,
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
      // #133: defaults to the CONFIG's directory, which is `config/` now.
      cwd: REPO_ROOT,
      url: `${BASE_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: bootGuardEnv,
    },
    {
      command: memberServerCommand,
      cwd: REPO_ROOT,
      url: `${MEMBER_BASE_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: memberServerEnv,
    },
  ],
});
