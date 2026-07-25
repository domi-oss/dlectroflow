# Playwright E2E Smoke Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a thin, stable Playwright smoke suite (5 real-browser flows) that runs as a **blocking gate** on every MR, giving dlectroflow its first real-browser regression coverage.

**Architecture:** Playwright drives Chromium against a real `next start` server backed by a real Postgres. Authentication is handled without OAuth by **forging a valid signed owner session cookie** in `globalSetup` using the app's existing `signSession()` helper — no auth-bypass code is added to application source. In CI, a new `e2e_test` job runs the suite and is wired into `build_image.needs`, so a red suite blocks image build → all deploys.

**Tech Stack:** `@playwright/test` (Chromium only), Next 16 (`output: standalone`, served via `next start` on port 3000), Prisma + Postgres 16, `jose` (existing session signing), GitLab CI.

## Global Constraints

- **This is NOT stock Next.js.** Edge middleware lives in `src/proxy.ts` (not `middleware.ts`). Do not assume stock Next behavior — verify against the running app.
- **No `data-testid` convention exists.** Select by ARIA role + accessible name + visible text. The only stable structural hooks are `data-bucket="<id>"` on inbox buckets (`needsReview | multiStep | singleTask | savedLater | completed`).
- **Default voice is `plain`.** All expected button/label strings below are the plain-voice strings.
- **Node engine:** `>=20.19.0`; repo pins Node 22.
- **Session facts (verbatim):** cookie name `df_owner` (`OWNER_COOKIE`), algorithm HS256, secret env var `AUTH_SESSION_SECRET`, owner payload `{ kind: "owner", sub: "<string>" }`. `signSession(payload, secret)` is exported from `src/lib/auth/session.ts` and imports only `jose` (no app-internal side effects).
- **Prod boot guard:** `next start` runs with `NODE_ENV=production`, and the app refuses to boot unless these are set: `AUTH_PROVIDER`, `OWNER_ALLOWLIST`, `AUTH_SESSION_SECRET` (≥32 chars), `GITLAB_OAUTH_CLIENT_ID`, `GITLAB_OAUTH_CLIENT_SECRET`, `GUEST_IP_HASH_SALT` (≥16 chars), `TOKEN_ENC_KEY` (64 hex chars). The Playwright `webServer.env` block supplies test dummies for all of these.
- **Shared-DB determinism:** all specs run against one owner workspace DB. Run serially (`workers: 1`, `fullyParallel: false`) and scope every assertion to a **unique per-test string** (e.g. `` `E2E buy milk ${Date.now()}` ``) so repeated/interleaved runs never collide.
- **Flaky-element rules:** never assert on relative age text ("captured 3s ago"), the transient `role="status"` toast (auto-hides ~1500ms), or `opacity` transitions. Prefer the "Move to" menu over synthesizing drag-and-drop. Use `waitForURL` for async-then-navigate actions.
- **DRY / YAGNI / TDD / frequent commits.** Chromium only; no cross-browser, visual regression, or OAuth automation in v1.

---

## File Structure

- `playwright.config.ts` (create, root) — Chromium project, `webServer` (`next start` + boot-guard env), `globalSetup`, serial execution, `storageState`.
- `e2e/constants.ts` (create) — shared `SESSION_SECRET`, `OWNER_SUB`, `STORAGE_STATE` path, `BASE_URL`.
- `e2e/global-setup.ts` (create) — forge `df_owner` cookie via `signSession`, write `playwright/.auth/owner.json`.
- `e2e/smoke/app-loads.spec.ts` (create) — Flow 1.
- `e2e/smoke/brain-dump.spec.ts` (create) — Flow 2.
- `e2e/smoke/complete-task.spec.ts` (create) — Flow 4.
- `e2e/smoke/focus-timer.spec.ts` (create) — Flow 3.
- `e2e/smoke/library.spec.ts` (create) — Flow 5.
- `package.json` (modify) — add `@playwright/test` devDep + `test:e2e` script.
- `.gitignore` (modify) — ignore `playwright/.auth/`, `playwright-report/`, `test-results/`, `.playwright/`.
- `README.md` (modify) — "Running E2E tests" section.
- `.gitlab-ci.yml` (modify) — add `e2e_test` job; add it to `build_image.needs`.

---

### Task 1: Playwright scaffolding + forged-session auth + Flow 1 (app loads)

Deliverable: `npm run test:e2e` boots the app, authenticates via a forged owner cookie, and passes a spec proving the inbox renders.

**Files:**
- Create: `playwright.config.ts`, `e2e/constants.ts`, `e2e/global-setup.ts`, `e2e/smoke/app-loads.spec.ts`
- Modify: `package.json` (devDep + script), `.gitignore`

**Interfaces:**
- Produces (consumed by all later tasks):
  - `e2e/constants.ts`: `export const SESSION_SECRET: string`, `export const OWNER_SUB = "1"`, `export const STORAGE_STATE = "playwright/.auth/owner.json"`, `export const BASE_URL: string`.
  - `playwright.config.ts`: `testDir: "./e2e"`, `use.baseURL`, `use.storageState = STORAGE_STATE`, `workers: 1`, `webServer` with boot-guard env.
  - All specs start pre-authenticated as owner (via `storageState`) and use relative paths (`page.goto("/inbox")`).

- [ ] **Step 1: Install Playwright and add the npm script**

```bash
# from the repository root
npm install -D @playwright/test
npx playwright install chromium
```

Then edit `package.json` scripts to add (keep existing scripts):

```json
    "test:e2e": "playwright test"
```

Record the installed version — Task 7 pins the CI image to it:

```bash
node -p "require('@playwright/test/package.json').version"
```

- [ ] **Step 2: Create `e2e/constants.ts`**

```ts
// Shared config for the Playwright smoke suite.
// SESSION_SECRET must be identical for (a) the app the webServer boots and
// (b) global-setup, which forges the owner cookie. The fallback keeps local
// and CI self-consistent when AUTH_SESSION_SECRET is unset in the environment.
export const SESSION_SECRET =
  process.env.AUTH_SESSION_SECRET ?? "e2e-owner-session-secret-32bytes-minimum-0000";
export const OWNER_SUB = "1";
export const STORAGE_STATE = "playwright/.auth/owner.json";
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
```

- [ ] **Step 3: Create `e2e/global-setup.ts` (forge the owner cookie)**

```ts
import { chromium, type FullConfig } from "@playwright/test";
import { signSession, OWNER_COOKIE } from "../src/lib/auth/session";
import { SESSION_SECRET, OWNER_SUB, STORAGE_STATE, BASE_URL } from "./constants";

// Mint a real, valid owner session the same way the OAuth callback does,
// then persist it as Playwright storageState so every spec starts logged in.
// No auth-bypass path is added to application code.
export default async function globalSetup(_config: FullConfig): Promise<void> {
  const token = await signSession({ kind: "owner", sub: OWNER_SUB }, SESSION_SECRET);
  const url = new URL(BASE_URL);

  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: OWNER_COOKIE, // "df_owner"
      value: token,
      domain: url.hostname, // "localhost"
      path: "/",
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "Lax",
      expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
    },
  ]);
  await context.storageState({ path: STORAGE_STATE });
  await browser.close();
}
```

- [ ] **Step 4: Create `playwright.config.ts`**

```ts
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
  TOKEN_ENC_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
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
```

- [ ] **Step 5: Update `.gitignore`**

Append:

```gitignore
# Playwright
/playwright/.auth/
/playwright-report/
/test-results/
/.playwright/
```

- [ ] **Step 6: Create `e2e/smoke/app-loads.spec.ts` (Flow 1)**

```ts
import { test, expect } from "@playwright/test";

// Flow 1: authenticated app loads and the inbox renders.
// "/" hard-redirects to "/inbox". Assert on always-present shell elements
// (brand link + capture bar), NOT on data-dependent section headers.
test("authenticated inbox renders", async ({ page }) => {
  await page.goto("/inbox");
  await expect(page.getByRole("link", { name: "dlectroflow" })).toBeVisible();
  await expect(
    page.getByPlaceholder("Brain dump anything… (Enter to save, / to focus)"),
  ).toBeVisible();
});
```

- [ ] **Step 7: Ensure the app is built, then run the spec**

The `webServer` runs `next start`, which needs a prior build. Build once, then run:

```bash
npm run build
npm run test:e2e -- e2e/smoke/app-loads.spec.ts
```

Expected: `1 passed`. If the webServer times out, the boot guard rejected an env var — compare `bootGuardEnv` against `.env.example` and fix. If the assertion fails, the forged cookie was rejected (middleware redirected) — confirm `SESSION_SECRET` matches between `webServer.env` and global-setup.

- [ ] **Step 8: Verify tsc + lint still pass with the new files**

```bash
npx tsc --noEmit
npm run lint
```

Expected: both clean. (`@playwright/test` types resolve the `test`/`expect` imports.)

- [ ] **Step 9: Commit**

```bash
git add playwright.config.ts e2e/ package.json package-lock.json .gitignore
git commit -m "test(e2e): add Playwright harness with forged-session auth + inbox smoke"
```

---

### Task 2: Flow 2 — brain-dump → triage into a task

Deliverable: a spec that captures a brain-dump item and triages it into a single-task to-do.

**Files:**
- Create: `e2e/smoke/brain-dump.spec.ts`

**Interfaces:**
- Consumes: harness from Task 1 (owner storageState, baseURL).

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from "@playwright/test";

// Flow 2: brain-dump capture (Enter to submit) then triage into a to-do.
// The capture bar has no submit button. New items land in "Needs review";
// "Add to-do" moves the item into the single-task bucket.
test("brain-dump item triages into a single-task to-do", async ({ page }) => {
  const label = `E2E buy milk ${Date.now()}`;
  await page.goto("/inbox");

  const capture = page.getByPlaceholder(
    "Brain dump anything… (Enter to save, / to focus)",
  );
  await capture.fill(label);
  await capture.press("Enter");

  // Item appears in the Needs review bucket; triage it.
  const row = page.getByRole("listitem").filter({ hasText: label });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Add to-do" }).click();

  // It now lives in the single-task bucket with a Start Focus affordance.
  const singleTask = page.locator('[data-bucket="singleTask"]');
  await expect(singleTask).toContainText(label);
  await expect(
    singleTask.getByRole("listitem").filter({ hasText: label })
      .getByRole("button", { name: /Start Focus/ }),
  ).toBeVisible();
});
```

- [ ] **Step 2: Run the spec**

```bash
npm run test:e2e -- e2e/smoke/brain-dump.spec.ts
```

Expected: `1 passed`. If the "Add to-do" button is not found, re-check the plain-voice label in `src/components/inbox/inbox-view.tsx` and adjust the accessible name.

- [ ] **Step 3: Commit**

```bash
git add e2e/smoke/brain-dump.spec.ts
git commit -m "test(e2e): cover brain-dump capture and triage-to-todo"
```

---

### Task 3: Flow 4 — complete a task

Deliverable: a spec that completes an item and asserts it moves to the Completed bucket.

**Files:**
- Create: `e2e/smoke/complete-task.spec.ts`

**Interfaces:**
- Consumes: harness from Task 1. Completion is a `<button>` named "Complete" (no checkbox); completed items render in `[data-bucket="completed"]` with strikethrough.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from "@playwright/test";

// Flow 4: complete an item. Create a fresh brain-dump item, then click its
// "Complete" button (not a checkbox) and assert it lands in the Completed bucket.
test("completing an item moves it to the Completed bucket", async ({ page }) => {
  const label = `E2E finish report ${Date.now()}`;
  await page.goto("/inbox");

  const capture = page.getByPlaceholder(
    "Brain dump anything… (Enter to save, / to focus)",
  );
  await capture.fill(label);
  await capture.press("Enter");

  const row = page.getByRole("listitem").filter({ hasText: label });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Complete" }).click();

  await expect(page.locator('[data-bucket="completed"]')).toContainText(label);
});
```

- [ ] **Step 2: Run the spec**

```bash
npm run test:e2e -- e2e/smoke/complete-task.spec.ts
```

Expected: `1 passed`.

- [ ] **Step 3: Commit**

```bash
git add e2e/smoke/complete-task.spec.ts
git commit -m "test(e2e): cover completing an item into the Completed bucket"
```

---

### Task 4: Flow 3 — focus timer start → pause

Deliverable: a spec that reaches the focus timer, starts it, and pauses it.

**Files:**
- Create: `e2e/smoke/focus-timer.spec.ts`

**Interfaces:**
- Consumes: harness from Task 1. There is **no `/focus` index route** — reach the timer via a single-task's "▶ Start Focus" (async-then-navigate → use `waitForURL`). Start button: "▶ Start focusing"; pause toggles to "▶ Resume".

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from "@playwright/test";

// Flow 3: focus timer start → pause. Create a to-do, launch focus from it
// (navigates to /focus/{stepId}), start the timer, then pause it and assert
// the control toggles to Resume.
test("focus timer starts and pauses", async ({ page }) => {
  const label = `E2E focus task ${Date.now()}`;
  await page.goto("/inbox");

  const capture = page.getByPlaceholder(
    "Brain dump anything… (Enter to save, / to focus)",
  );
  await capture.fill(label);
  await capture.press("Enter");

  const row = page.getByRole("listitem").filter({ hasText: label });
  await row.getByRole("button", { name: "Add to-do" }).click();

  const todoRow = page
    .locator('[data-bucket="singleTask"]')
    .getByRole("listitem")
    .filter({ hasText: label });
  await todoRow.getByRole("button", { name: /Start Focus/ }).click();

  await page.waitForURL("**/focus/**");
  await page.getByRole("button", { name: "▶ Start focusing" }).click();

  await page.getByRole("button", { name: "⏸️ Pause" }).click();
  await expect(page.getByRole("button", { name: "▶ Resume" })).toBeVisible();
});
```

- [ ] **Step 2: Run the spec**

```bash
npm run test:e2e -- e2e/smoke/focus-timer.spec.ts
```

Expected: `1 passed`. If "▶ Start Focus" doesn't navigate, confirm the single-task row exposes it in `src/components/inbox/inbox-view.tsx`; if the timer labels differ, check `src/components/focus/focus-timer.tsx`.

- [ ] **Step 3: Commit**

```bash
git add e2e/smoke/focus-timer.spec.ts
git commit -m "test(e2e): cover focus timer start and pause"
```

---

### Task 5: Flow 5 — navigate to the Library hub

Deliverable: a spec that opens the nav menu and navigates to the Library page.

**Files:**
- Create: `e2e/smoke/library.spec.ts`

**Interfaces:**
- Consumes: harness from Task 1. Nav is behind a hamburger (`aria-label="Menu"`); the Library link's **visible text is "Everything"** (`href="/library"`); the page renders an `<h1>` "Everything".

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from "@playwright/test";

// Flow 5: open the hamburger nav and go to the Library hub.
// The link reads "Everything" (not "Library") and routes to /library.
test("navigates to the Library hub from the nav menu", async ({ page }) => {
  await page.goto("/inbox");

  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("link", { name: "Everything" }).click();

  await page.waitForURL("**/library");
  await expect(
    page.getByRole("heading", { level: 1, name: "Everything" }),
  ).toBeVisible();
});
```

- [ ] **Step 2: Run the full suite (all 5 specs, serial)**

```bash
npm run test:e2e
```

Expected: `5 passed`.

- [ ] **Step 3: Commit**

```bash
git add e2e/smoke/library.spec.ts
git commit -m "test(e2e): cover navigation to the Library hub"
```

---

### Task 6: Local-run docs

Deliverable: README documents how to run the suite locally.

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: `test:e2e` script from Task 1.

- [ ] **Step 1: Add a "Running E2E tests" section to `README.md`**

Insert near the existing testing/commands section:

```markdown
## Running E2E tests (Playwright)

Real-browser smoke suite (Chromium). Requires a local Postgres with the schema applied.

```bash
# One-time: install the browser
npx playwright install chromium

# Ensure the DB schema exists (uses your DATABASE_URL)
npm run db:deploy

# Build once (Playwright serves the app via `next start`)
npm run build

# Run the smoke suite
npm run test:e2e
```

Auth is handled automatically: `e2e/global-setup.ts` forges a valid owner session
cookie with `signSession()` — no OAuth login is performed and no bypass code exists
in application source. Specs run serially against one owner workspace and scope
assertions to unique per-run strings. On failure in CI, an HTML report is uploaded
as a job artifact (`playwright-report/`).
```

- [ ] **Step 2: Verify markdown renders (no broken fences) and commit**

```bash
git add README.md
git commit -m "docs: document running the Playwright E2E smoke suite"
```

---

### Task 7: CI `e2e_test` job + blocking gate

Deliverable: a new CI job runs the suite against a real Postgres and blocks `build_image` (and therefore all deploys) when red.

**Files:**
- Modify: `.gitlab-ci.yml`

**Interfaces:**
- Consumes: `test:e2e` script; the same Postgres service block used by `test_app`.
- Produces: `e2e_test` job added to `build_image.needs` with `artifacts: false` (mirrors the existing `test_app` gate).

- [ ] **Step 1: Add the `e2e_test` job**

Add after the `test_app` job. Replace `<PLAYWRIGHT_VERSION>` with the exact version recorded in Task 1, Step 1 (e.g. `v1.56.1-noble`). The Playwright image is Debian/glibc (required for the browsers) and ships Node.

```yaml
e2e_test:
  stage: build
  image: mcr.microsoft.com/playwright:<PLAYWRIGHT_VERSION>
  interruptible: true
  needs: []
  services:
    - postgres:16@sha256:17e67d7b9890c99b055ba1e0d5c5be4ec27c9d3a72bda32db24a5e5d8a85af0c
  variables:
    POSTGRES_USER: dlectroflow
    POSTGRES_PASSWORD: ci-test-only
    POSTGRES_DB: dlectroflow_test
    DATABASE_URL: "postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$POSTGRES_DB?schema=public"
  script:
    - npm ci --cache .npm --prefer-offline --no-audit --no-fund
    - npx prisma migrate deploy
    - npm run build
    - npx playwright test
  artifacts:
    when: on_failure
    paths:
      - playwright-report/
    expire_in: 1 week
  cache:
    key:
      files:
        - package-lock.json
    paths:
      - .npm/
    policy: pull
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $RENOVATE_RUN == "true"'
      when: never
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_COMMIT_BRANCH == "main"'
```

Notes: the boot-guard env vars come from `playwright.config.ts` `webServer.env`, so the job needs only the Postgres/DB vars. `npm ci` postinstall runs `prisma generate` (Debian engine downloads on the Playwright image — no `apk` needed).

- [ ] **Step 2: Wire the blocking gate into `build_image.needs`**

Edit the `build_image` job's `needs:` to add `e2e_test` (keep existing entries):

```yaml
  needs:
    - job: build_app
      artifacts: true
    - job: test_app
      artifacts: false
    - job: e2e_test
      artifacts: false
```

- [ ] **Step 3: Validate CI YAML locally**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.gitlab-ci.yml')); print('yaml ok')"
```

Expected: `yaml ok`.

- [ ] **Step 4: Commit**

```bash
git add .gitlab-ci.yml
git commit -m "ci: add blocking Playwright e2e_test gate before build_image"
```

- [ ] **Step 5: Prove the gate blocks (negative test, then revert)**

Temporarily break one flow to confirm the pipeline goes red and `build_image` does not run:

```bash
# Break a selector on purpose
sed -i.bak 's/name: "Menu"/name: "NOPE-Menu"/' e2e/smoke/library.spec.ts
git add e2e/smoke/library.spec.ts && git commit -m "test(e2e): TEMP break to verify gate"
git push   # observe: e2e_test fails, build_image is skipped/blocked, no deploy
```

After confirming the red gate in the pipeline UI, revert:

```bash
git revert --no-edit HEAD
git push
rm -f e2e/smoke/library.spec.ts.bak
```

Expected: pipeline green again; `build_image` runs only after `e2e_test` passes.

---

## Self-Review Notes

- **Spec coverage:** Flow 1 → Task 1; Flow 2 → Task 2; Flow 4 → Task 3; Flow 3 → Task 4; Flow 5 → Task 5; local docs → Task 6; blocking CI gate + negative test → Task 7. All issue #37 tasks and acceptance criteria are covered.
- **No prod bypass:** auth is forged entirely in `e2e/` test code via the existing `signSession`; no application source is modified. ✔ acceptance criterion.
- **Type consistency:** `SESSION_SECRET`, `OWNER_SUB`, `STORAGE_STATE`, `BASE_URL`, `OWNER_COOKIE` names are consistent across `constants.ts`, `global-setup.ts`, and `playwright.config.ts`.
- **Open verification points (resolve during execution, not assumptions):** exact plain-voice button strings ("Add to-do", "Complete", "▶ Start focusing", "⏸️ Pause"/"▶ Resume", "Menu", "Everything") and the focus-launch navigation are taken from a code read; each task's run step will confirm them and the plan says where to look if a label differs.
