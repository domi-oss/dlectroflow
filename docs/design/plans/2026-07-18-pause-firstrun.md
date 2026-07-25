# Phase 5 (pause-firstrun) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship #8 Phase 5 — first-run welcome + empty states, a light Pause-for-now with an Inbox resume banner, a Settings "Demo: First-run preview" toggle, and delete-confirm coverage.

**Architecture:** Additive-only. Two nullable/defaulted `Settings` columns drive the welcome + demo view; the welcome card and demo override are pure presentation on the Inbox page; Pause-for-now reuses the existing open-`FocusSession` → `resumable` heuristic (no new persistence — true pause is #27); the resume banner is derived from the resumable steps the inbox page already loads. No new scheduling/notification behavior.

**Tech Stack:** Next.js (modified fork), React client components, Prisma/Postgres, Vitest + Testing Library (jsdom).

## Global Constraints
- **Modified Next.js fork** — read `node_modules/next/dist/docs/` before any Next-specific API; `inbox/page.tsx` stays a Server Component.
- **Voice layer:** user-facing text via `t(key, voice)`; `t()` returns STATIC strings (compose values in JSX); Plain = no decorative emoji (the 👋 in the welcome title is allowed in both voices per the wireframe).
- **Workspace isolation:** every action resolves `currentWorkspaceId()` + filters by it.
- **Migration additive + nullable**, no backfill. No DB in the worktree → hand-author migration SQL + `npx prisma generate` (mirror how prior phases did it; do NOT run `prisma migrate dev`).
- **Gates before each commit:** `npx tsc --noEmit` clean · `npm run lint` 0 errors · `npx vitest run --exclude '**/*.integration.test.ts'` all green; pristine output (use the repo's `@vitest-environment jsdom` docblock + `afterEach(cleanup)` in RTL files).
- Branch `feat/pause-firstrun`; TDD; one commit per task; `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do NOT merge.
- Work from `/Users/gitlab_dlectronique/workdev/dlectroflow/.claude/worktrees/pause-firstrun`.

## File Structure
- Modify `prisma/schema.prisma` (Settings) + new migration dir.
- Modify `src/app/actions/settings.ts` — add `updateFirstRunPreview` + `dismissWelcome`.
- Create `src/components/inbox/welcome-card.tsx` + test.
- Modify `src/lib/strings.ts` — welcome + pause + resume-banner + demo keys.
- Modify `src/app/(app)/inbox/page.tsx` — pass welcome/demo/resume props; demo empty override.
- Modify `src/components/inbox/inbox-view.tsx` — render welcome card + resume banner; accept new props.
- Modify `src/components/focus/focus-timer.tsx` — Pause-for-now control.
- Modify `src/components/settings/settings-panel.tsx` — Demo section (auto-save).
- Delete-confirm coverage — test only (see Task 7).

---

## Task 1: Settings schema (`welcomeDismissedAt`, `firstRunPreview`) + actions

**Files:** `prisma/schema.prisma`; `prisma/migrations/20260718170000_settings_firstrun/migration.sql` (create); `src/app/actions/settings.ts`; test `src/app/actions/firstrun-settings.test.ts`.

**Interfaces produced:**
- `Settings.welcomeDismissedAt DateTime?`, `Settings.firstRunPreview Boolean @default(false)`
- `dismissWelcome(): Promise<void>` (sets welcomeDismissedAt = now, workspace-scoped)
- `updateFirstRunPreview(enabled: boolean): Promise<void>` (workspace-scoped upsert)

- [ ] **Step 1: Schema** — in `model Settings`, add after `voice`:
```prisma
  // Phase 5 — first-run welcome + demo preview
  welcomeDismissedAt    DateTime?
  firstRunPreview       Boolean  @default(false)
```

- [ ] **Step 2: Migration** — create `prisma/migrations/20260718170000_settings_firstrun/migration.sql` (sorts after the newest existing migration):
```sql
-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "welcomeDismissedAt" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "firstRunPreview" BOOLEAN NOT NULL DEFAULT false;
```
Then regenerate: `npx prisma generate` (prefix `DATABASE_URL="postgresql://u:p@localhost:5432/db"` if it complains). Do NOT run `prisma migrate dev` (no DB).

- [ ] **Step 3: Write failing tests** (`src/app/actions/firstrun-settings.test.ts`) — mirror `src/app/actions/snooze.test.ts`'s mock shape (mock `@/lib/db` prisma with `settings.upsert`, `@/lib/workspace`, `next/cache`). Assert `dismissWelcome` upserts `welcomeDismissedAt` (a Date) scoped to `workspaceId`; `updateFirstRunPreview(true)`/`(false)` upserts `firstRunPreview` boolean scoped to `workspaceId`.

- [ ] **Step 4: Implement** — append to `src/app/actions/settings.ts`:
```ts
/** Phase 5 — persist that the workspace dismissed the first-run welcome card. */
export async function dismissWelcome() {
  const workspaceId = await currentWorkspaceId();
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, welcomeDismissedAt: new Date() },
    update: { welcomeDismissedAt: new Date() },
  });
  revalidatePath("/inbox");
}

/** Phase 5 — Demo: First-run preview toggle (auto-saved). Forces the Inbox to
 * render as a brand-new user sees it (welcome + empty), non-destructively. */
export async function updateFirstRunPreview(enabled: boolean) {
  const workspaceId = await currentWorkspaceId();
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, firstRunPreview: Boolean(enabled) },
    update: { firstRunPreview: Boolean(enabled) },
  });
  revalidatePath("/inbox");
}
```

- [ ] **Step 5:** Run tests + `tsc` — expect green/clean.
- [ ] **Step 6: Commit** `feat(#8): Settings.welcomeDismissedAt + firstRunPreview + actions`.

---

## Task 2: Welcome card component + strings

**Files:** create `src/components/inbox/welcome-card.tsx` + `src/components/inbox/welcome-card.test.tsx`; modify `src/lib/strings.ts`.

**Interfaces:** `WelcomeCard({ voice }: { voice: Voice })` — client component; renders the welcome, a Plain/Playful voice toggle (reuse `updateVoice`), a "How it works →" link to `/help`, and a Dismiss button calling `dismissWelcome`.

- [ ] **Step 1: Strings** — add to `src/lib/strings.ts` (plain/playful; 👋 allowed in both per wireframe):
```ts
  "welcome.title":   { plain: "👋 Welcome to dlectroflow", playful: "👋 Welcome to dlectroflow" },
  "welcome.body":    { plain: "Jot anything on your mind in the box above. Break big things into steps, focus one at a time, and tick them off — everything you capture lives in your Library.", playful: "Brain full? Dump it in the box above. Snack-size the big stuff into steps, focus one bite at a time, and check them off — it all keeps in your Larder." },
  "welcome.help":    { plain: "How it works →", playful: "How it works →" },
  "welcome.dismiss": { plain: "Got it",         playful: "Got it" },
```

- [ ] **Step 2: Write failing test** (`welcome-card.test.tsx`, `@vitest-environment jsdom` + `afterEach(cleanup)`; mock `@/app/actions/settings` `dismissWelcome`/`updateVoice`). Assert: renders `welcome.title`+`welcome.body` text; a link with href `/help`; a voice toggle (two buttons/options); Dismiss button click calls `dismissWelcome`.

- [ ] **Step 3: Implement** `src/components/inbox/welcome-card.tsx`:
```tsx
"use client";
import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { dismissWelcome, updateVoice } from "@/app/actions/settings";
import { t, type Voice } from "@/lib/strings";

export function WelcomeCard({ voice }: { voice: Voice }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const setVoice = (v: Voice) => start(async () => { await updateVoice(v); router.refresh(); });
  const dismiss = () => start(async () => { await dismissWelcome(); router.refresh(); });
  return (
    <section
      aria-label="Welcome"
      className="rounded-xl border border-green-700/40 bg-green-50 p-4 dark:bg-green-950/20"
    >
      <h2 className="text-sm font-semibold">{t("welcome.title", voice)}</h2>
      <p className="text-muted-foreground mt-1 text-sm">{t("welcome.body", voice)}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <div className="inline-flex rounded-md border" role="group" aria-label="Voice preference">
          <button
            type="button" aria-pressed={voice === "plain"} disabled={pending}
            onClick={() => setVoice("plain")}
            className={"rounded-l-md px-3 py-1 " + (voice === "plain" ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
          >Plain</button>
          <button
            type="button" aria-pressed={voice === "playful"} disabled={pending}
            onClick={() => setVoice("playful")}
            className={"rounded-r-md px-3 py-1 " + (voice === "playful" ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
          >Playful</button>
        </div>
        <Link href="/help" className="text-green-800 hover:underline dark:text-green-300">
          {t("welcome.help", voice)}
        </Link>
        <span className="flex-1" />
        <button type="button" onClick={dismiss} disabled={pending} className="hover:bg-accent rounded-md border px-3 py-1">
          {t("welcome.dismiss", voice)}
        </button>
      </div>
    </section>
  );
}
```
> Confirm `updateVoice` exists in `settings.ts` (it does). Match the existing voice-toggle styling in `settings-panel.tsx` if it differs.

- [ ] **Step 4:** tests + `tsc` + `lint` green. **Step 5: Commit** `feat(#8): first-run WelcomeCard (voice choice + /help + dismiss)`.

---

## Task 3: Inbox wiring — welcome render, demo empty override, resume banner

**Files:** `src/app/(app)/inbox/page.tsx`; `src/components/inbox/inbox-view.tsx`; test additions in `src/components/inbox/inbox-view.test.tsx`.

**Context:** `inbox/page.tsx` already loads items with per-step `resumable` (open FocusSession). `InboxView` is a client component taking `initialItems`, `settings`, `google`; voice via `useVoice()`.

**Interfaces:** extend `InboxView` props with `welcomeVisible: boolean`, `resumeStep: { id: string; text: string } | null`. Page computes both + applies the demo empty override.

- [ ] **Step 1: Page** (`inbox/page.tsx`):
  - After `getSettings`, compute:
    ```ts
    const firstRun = settings.firstRunPreview;
    const welcomeVisible = firstRun || settings.welcomeDismissedAt == null;
    // Most-recent resumable step (open focus session) for the resume banner.
    const resumeStep = (() => {
      for (const it of items) {
        const s = it.steps.find((st) => st.resumable);
        if (s) return { id: s.id, text: s.text };
      }
      return null;
    })();
    ```
  - Pass to `<InboxView>`: `initialItems={firstRun ? [] : items}`, `welcomeVisible={welcomeVisible}`, `resumeStep={firstRun ? null : resumeStep}` (demo view shows no resume banner), keep `settings`/`google`.

- [ ] **Step 2: Failing tests** (`inbox-view.test.tsx`): (a) `welcomeVisible` → `WelcomeCard` (query by "Welcome" region / title text) renders; false → absent. (b) `resumeStep` set → a resume banner with the step text + a "resume" link to `/focus/<id>`; null → no banner. (Mock `@/components/inbox/welcome-card` if convenient, or assert on its text.)

- [ ] **Step 3: Implement `InboxView`:**
  - Add props `welcomeVisible: boolean; resumeStep: { id: string; text: string } | null` to the component's props type + signature.
  - Import `WelcomeCard` + `Link`. At the very top of the returned tree (before `NavBadge`/capture), render:
    ```tsx
    {welcomeVisible && <WelcomeCard voice={voice} />}
    {resumeStep && (
      <div role="status" className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-50 px-4 py-2 text-sm dark:bg-amber-950/20">
        <span className="flex-1">{t("focus.pausedBanner", voice)} <strong>&ldquo;{resumeStep.text}&rdquo;</strong></span>
        <Link href={`/focus/${resumeStep.id}`} className="text-amber-800 hover:underline dark:text-amber-300">{t("focus.resumeArrow", voice)}</Link>
      </div>
    )}
    ```
  - Add strings in `strings.ts`: `"focus.pausedBanner": { plain: "⏸ Paused focus step —", playful: "⏸ Paused focus step —" }`, `"focus.resumeArrow": { plain: "resume →", playful: "resume →" }`. (⏸ is a functional status glyph, allowed in Plain.)

- [ ] **Step 4:** full suite + `tsc` + `lint` green (watch for existing inbox-view tests needing the two new required props — supply defaults `welcomeVisible={false} resumeStep={null}` in existing test renders). **Step 5: Commit** `feat(#8): Inbox welcome card + resume banner + demo empty override`.

---

## Task 4: Pause-for-now on the Focus timer

**Files:** `src/components/focus/focus-timer.tsx`; `src/lib/strings.ts`; test `src/components/focus/focus-timer.test.tsx` (create or extend).

**Design:** light exit — leaves the FocusSession OPEN (endedAt null → step stays `resumable`) and navigates to `/inbox`, where Task 3's banner surfaces it. Distinct from the countdown ⏸️ Pause (phase toggle) and from Give up (`giveUpFocus`, which ends the session). **Flag in the report:** the existing "Give up" now overlaps conceptually — leave it for the owner to decide (do NOT remove it).

- [ ] **Step 1: String** — add `"focus.pauseForNow": { plain: "⏸️ Pause for now", playful: "⏸️ Pause for now" }`.

- [ ] **Step 2: Failing test** — render `FocusTimer` in `running` phase (you'll need to drive it to running: click Start → it calls `beginFocus` (mock to return an id) → running). Assert a "Pause for now" control exists and clicking it calls `router.push("/inbox")` (mock `next/navigation` `useRouter`). Assert it does NOT call `giveUpFocus`/`completeFocus` (mock those; not called).
  > If driving to `running` via `beginFocus` mock is awkward, factor the Pause-for-now handler so it's testable, but keep the assertion behavioral (navigates to /inbox, no session-ending action called).

- [ ] **Step 3: Implement** — in `focus-timer.tsx`, add a handler and a button in the `running || paused` controls block (near the Give up button, ~line 342):
```tsx
  const pauseForNow = () => router.push("/inbox");
```
```tsx
          <button
            onClick={pauseForNow}
            className="text-muted-foreground hover:text-foreground rounded-md px-3 py-2 text-sm"
          >
            {t("focus.pauseForNow", voice)}
          </button>
```
Leaves the open session intact (no server call) so the step is resumable + the Inbox banner shows.

- [ ] **Step 4:** tests + `tsc` + `lint` green. **Step 5: Commit** `feat(#8): Focus 'Pause for now' — low-shame exit to Inbox resume banner`.

---

## Task 5: Demo "First-run preview" toggle in Settings (auto-save)

**Files:** `src/components/settings/settings-panel.tsx`; test extension.

**Context:** `settings-panel.tsx` already auto-saves the voice + model on change via `useTransition` + `updateVoice`/`updateBreakdownModel`. Add a "Demo" section mirroring that pattern, calling `updateFirstRunPreview` (Task 1) on toggle. Panel receives its `settings` prop from the settings page — thread `firstRunPreview` through.

- [ ] **Step 1: Failing test** — render the panel with `settings.firstRunPreview=false`; toggling the "First-run preview" control calls `updateFirstRunPreview(true)` (mock `@/app/actions/settings`).

- [ ] **Step 2: Implement** — add to the panel's settings prop type `firstRunPreview: boolean`; import `updateFirstRunPreview`; add a transition + handler; render a new `<section className="space-y-2 border-t pt-4">` with an `<h2>Demo</h2>`, a checkbox/toggle labelled "First-run preview" + description ("Show the app as a brand-new user sees it — welcome card + empty Inbox. Non-destructive."), auto-saving on change:
```tsx
  const [frPending, startFr] = useTransition();
  const [firstRun, setFirstRun] = useState(settings.firstRunPreview);
  const toggleFirstRun = (v: boolean) => { setFirstRun(v); startFr(() => updateFirstRunPreview(v)); };
```
```tsx
  <section className="space-y-2 border-t pt-4">
    <h2 className="font-semibold">Demo</h2>
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={firstRun} disabled={frPending} onChange={(e) => toggleFirstRun(e.target.checked)} className="mt-1" />
      <span><span className="font-medium">First-run preview</span><br /><span className="text-muted-foreground">Show the app as a brand-new user sees it — welcome card + empty Inbox. Non-destructive.</span></span>
    </label>
  </section>
```

- [ ] **Step 3: Thread the prop** — in the settings page that renders `<SettingsPanel>`, add `firstRunPreview: settings.firstRunPreview` to the settings object passed in (grep the page for the existing settings prop object). Run `tsc` to confirm no other caller breaks.

- [ ] **Step 4:** tests + gates green. **Step 5: Commit** `feat(#8): Settings 'Demo: First-run preview' toggle (auto-save)`.

---

## Task 6: Delete-confirm coverage (verify; YAGNI on draft removes)

**Files:** test only — `src/components/inbox/inbox-view.test.tsx` already asserts the two-step confirm (lines ~199–211); add a short assertion for the library rows if not already covered (it is, in `library-rows.test.tsx`), and document coverage.

**Finding (from audit):** every destructive/persisted delete already uses the two-step confirm — inbox rows (`inbox-view.tsx:463–490`), library rows (`library-rows.tsx`), integrations disconnect (`integrations-panel.tsx:86`). The only one-tap removes are the **breakdown-editor draft steps** (`breakdown-chat.tsx:527,574`), which are unpersisted quick-edits where a confirm harms UX. **Owner-flagged recommendation: leave those as-is.**

- [ ] **Step 1:** Confirm (via reading the tests) that inbox + library delete-confirm behavior is covered by existing tests; if any gap, add one focused assertion. Do NOT add confirms to `breakdown-chat.tsx` draft-step removes unless the owner asks.
- [ ] **Step 2:** No code change expected. If nothing to add, record that in the report (task is a verified no-op) and skip the commit; otherwise commit the added test `test(#8): assert delete-confirm coverage`.

> This task may legitimately be a no-op — the slice was satisfied by earlier phases. Surfaced to the owner separately.

---

## Task 7: Gates + manual verification + finish

- [ ] **Step 1:** `npx tsc --noEmit` · `npm run lint` · `npx vitest run --exclude '**/*.integration.test.ts'` · `npm run build` — all green (record vitest count).
- [ ] **Step 2:** Local app-driving needs no DB for the pure-UI paths but the inbox reads the DB; rely on the review-app deploy for visual QA (note in the finish summary).
- [ ] **Step 3:** Push `feat/pause-firstrun`; open the MR (ties #8 Phase 5 + v0.1.0; @GitLabDuo reviewer); do NOT merge.

## Self-Review (author)
- **Spec coverage:** welcome (T2/T3) · empty/demo override (T1/T3/T5) · pause-for-now + resume banner (T3/T4) · delete confirms (T6, verified-done) · schema (T1). ✓
- **Types:** `welcomeVisible`/`resumeStep` prop types identical across T3 page+view; `firstRunPreview`/`welcomeDismissedAt` field names consistent T1↔T3↔T5; action signatures `dismissWelcome()`/`updateFirstRunPreview(boolean)` consistent.
- **Known flags for owner:** (1) delete-confirm slice already satisfied — no draft-remove confirms (T6); (2) "Give up" vs "Pause for now" overlap on the focus timer — left both, owner decides (T4); (3) `firstRunPreview` is Inbox-scoped (not Library/dashboard) per spec.
