# dlectroflow — Plan & Spec

An ADHD helper web app. Dual purpose: a learning project and a polished live-demo app for customer demos.

The core loop: **Capture → Clarify → Schedule → Focus → Reward → (come back tomorrow)**.

```
Brain Dump  →  Break down (Claude, conversational)  →  Schedule in Reclaim
     ↑                                                        │
 Rewards / streaks  ←  Focus timer on a step  ←───────────────┘
```

---

## Tech stack

| Concern | Choice |
|---|---|
| Framework | Next.js (App Router) + TypeScript |
| UI | Tailwind CSS + shadcn/ui + Framer Motion |
| Data | Prisma + SQLite (local) → Postgres for deploy |
| AI | Claude API (`@anthropic-ai/sdk`), model `claude-opus-4-8`, adaptive thinking, streaming |
| Reclaim | Official Reclaim MCP server `https://mcp.reclaim.ai` (OAuth), reached via Claude API remote MCP connector |
| Email (opt-in) | Resend + a scheduled job (only if round-up email enabled) |
| Notifications | Web Notifications API + service worker |
| Deploy | Dockerfile + `.gitlab-ci.yml` |

### Verified Claude API integration details
- Model `claude-opus-4-8`; `thinking: {type: "adaptive"}`; stream long/interactive responses via `.stream()` → `.finalMessage()`.
- **Remote MCP connector** (how the app writes to Reclaim): `client.beta.messages.create` with beta `mcp-client-2025-11-20`, and **both**:
  - `mcp_servers: [{ type: "url", url: "https://mcp.reclaim.ai", name: "reclaim", authorization_token: <reclaim bearer token> }]`
  - `tools: [{ type: "mcp_toolset", mcp_server_name: "reclaim" }]`
- Reclaim MCP is OAuth → run its OAuth authorize flow once, store the bearer token, pass it as `authorization_token`.
- Never log secrets. Keep `ANTHROPIC_API_KEY` and the Reclaim token server-side only.

---

## Feature 1 — 🧠 Brain Dump

Friction-free capture; easy triage; nothing rots in the inbox.

- **Capture:** always-reachable bar/hotkey + optional voice; Enter saves instantly, no required fields.
- **Triage visibility:** "Needs triage" zone pinned on top; "Triaged" collapsible below. Status pills 🔴 Untriaged / 🟡 Aging / 🟢 Triaged. Live "captured Xh ago" label warming to amber near the threshold.
- **Nav badge:** persistent count ("3 need triage"), **dismissable** (✕); once dismissed, reappears when a new item is captured or an item crosses into Aging; dismissal resets on reload.
- **Per-item actions:** `Break down →` · `Keep as task` · `Snooze` · `Delete`.
- **Reminders:** browser Web Notifications API + service worker. Item past threshold → 🟡 Aging + desktop notification + jumps to top; `remindedAt` prevents repeats.
- **Threshold:** user setting (default 4h) + demo override (~10s) to fire live on stage.

Data: `BrainDumpItem { id, text, createdAt, status: inbox|triaged|archived, triagedAt?, remindedAt?, taskId? }` · `Settings { agingThresholdMinutes, demoOverrideSeconds? }` · derived `isAging`.

---

## Feature 2 — ✂️ Task Breakdown → Reclaim (centerpiece)

Turn a vague/big task into tiny steps through a short conversation, then auto-schedule.

- **Trigger:** from a Brain Dump item or a new task; input is a title/phrase.
- **Conversational breakdown (Claude):** proposes a breakdown (no fixed count) with a **creative, varied opening line** generated fresh each time (warm, task-specific, ends inviting confirmation). Chat-style panel with quick replies: 👍 Looks right · ⬇️ Too big · ⬆️ Too small/too many · ✍️ free text. Per-chunk `Break this down further ↳`. Re-proposes until confirmed; chunks editable, each with `estMinutes`.
- **Push to Reclaim** (via Claude MCP connector): Claude creates each chunk as a Reclaim task; Reclaim auto-schedules onto the calendar.
- **Reclaim task naming convention:**
  `{parentEmoji} {Parent Task}: {n} of {total} {subtaskEmoji} {subtask name} ({estMinutes} mins)`
  e.g. `🎤 Prep the Customer Demo: 2 of 5 ✍️ Draft the opening script (25 mins)`
  - `parentEmoji`: one theme emoji for the whole task, repeated on every subtask.
  - `subtaskEmoji`: Claude picks one matching each step's action.
  - `{n} of {total}`: progress visible at a glance.
- **UI:** per-chunk Reclaim status (scheduled time / "scheduling…") + link out.
- **Graceful fallback:** if Reclaim auth is missing/expired, chunks save locally and the app prompts to reconnect — demo never hard-fails.

Data: `Task { id, title, source, createdAt, status, parentEmoji? }` · `Step { id, taskId, text, order, total, estMinutes, subtaskEmoji?, reclaimTaskId?, scheduledAt?, done }` · `BreakdownTurn { id, taskId, role, message, proposedSteps?, createdAt }`.

---

## Feature 3 — ⏱️ Focus Timer

Beat starting/sustaining attention; fight time blindness.

- **Start:** from any step; active step pinned. Duration user-settable, **defaults to the step's `estMinutes`**.
- **Visual timer:** large countdown + depleting progress ring, calm, distraction-free.
- **Controls:** ✅ Complete early · ➕ Add time (+5/+10) · ⏸️ Pause/give up (no guilt).
- **When time's up — confirm, never assume:** "Did you finish?" → ✅ Yes → completion flow · 🔁 Not yet → back to backlog, **Claude proposes a new estimate**, user confirms/adjusts, `estMinutes` updates and linked Reclaim task is updated/rescheduled.
- **Completion flow:** mark step done → feeds Rewards; **Reclaim sync** marks the linked task complete via MCP complete-task tool (graceful fallback if disconnected); tee up next step.
- **Stats (live):** focus minutes today · sessions · time per task.
- **🌇 End-of-day round-up:** user-set workday-end time (default ~5pm) fires a browser notification → in-app summary; plus a "trigger now" demo override. Claude writes a warm, personalized recap (wins first, guilt-free): steps done, focus minutes/sessions, points, streak, gentle carry-over. Delivery settings: in-app (always) · browser notification (default on) · **email opt-in** (Resend + scheduler; only when enabled). Optional "plan tomorrow" one-tap.

Data: `FocusSession { id, stepId?, taskId?, plannedMin, addedMin, startedAt, endedAt, durationMin, outcome: completed|requeued|gaveup, reclaimSynced? }` · `Step.estimateHistory?` · `TimerSettings { defaultFromEstimate, addTimeIncrementMin }` · `DayRollup { id, date, focusMin, sessions, stepsDone, pointsEarned, streakDay, narrative, emailedAt? }` · `Settings { workdayEndTime, roundupDemoOverride?, roundupEmailEnabled, roundupEmail }`.

---

## Feature 4 — 🎉 Rewards & Streaks

Immediate dopamine + a reason to return.

- **Points:** completing a step, finishing a focus session, triaging inbox to zero, confirming a breakdown / scheduling into Reclaim. Small, frequent, visible.
- **Instant celebration:** confetti + micro-animation + encouraging copy (Framer Motion), varied messages.
- **✨ Daily spark:** one encouraging quote per day, top of the dashboard. Claude-generated fresh daily, cached per day; curated fallback pool if offline. Reused as first-load-of-day opener and end-of-day round-up closer. "New spark" refresh option.
- **Streaks — working days only:** consecutive working days with ≥1 completion; non-working days skipped (weekend keeps it intact). Working days = user setting (default Mon–Fri). Missing a working day resets to 0.
- **🏆 Best-streaks leaderboard:** ended streaks save final length to a personal Top 3 (🥇🥈🥉 with counts + dates); a new streak surpassing an entry bumps in live.
- **🌱 Fresh-start encouragement:** starting a new streak after a reset → Claude offers warm, varied encouragement reframing the restart; guilt-free.
- **Badges (light):** first breakdown, first Reclaim schedule, 5-day streak, 10 steps in a day, beat your best streak.
- **Dashboard:** ✨ daily spark · today's points · current streak · Top 3 best streaks · focus minutes · steps done.

Data: `RewardEvent { id, type, points, createdAt }` · `Streak { current, lastActiveWorkday }` · `StreakRecord { id, length, startedAt, endedAt }` (Top 3 by length) · `Badge { id, key, earnedAt }` · `DailySpark { id, date, quote, source: ai|fallback }` · `Settings { workingDays: [Mon..Fri] }`.

---

## Build order (each a checkpoint)

1. **Scaffold** — Next.js + TS + Tailwind + shadcn/ui + Prisma/SQLite; app runs.
2. **Data models** — Prisma schema for all entities above; migrate.
3. **Brain Dump** — capture + inbox + triage zones + status pills + dismissable nav badge.
4. **Aging + notifications** — threshold setting + demo override; service worker + Web Notifications.
5. **Claude wiring** — `@anthropic-ai/sdk` server route; conversational breakdown (streaming, varied opener, refine loop).
6. **Reclaim OAuth + MCP connector** — one-time Reclaim OAuth authorize + token store; push chunks with the naming convention via the MCP connector; per-chunk status + fallback.
7. **Focus Timer** — visual timer + controls; time's-up confirm flow + re-estimate; completion + Reclaim complete-sync.
8. **Rewards & Streaks** — points, confetti, working-day streaks, Top 3 leaderboard, fresh-start encouragement, daily spark, dashboard.
9. **End-of-day round-up** — recap generation; in-app + notification; email opt-in (Resend + scheduler).
10. **Polish + deploy** — animations pass; Dockerfile + `.gitlab-ci.yml`; Postgres switch for deploy.

---

## Open implementation questions (to resolve as we build)
- Reclaim OAuth: confirm authorize/token endpoints and scopes for `mcp.reclaim.ai`; where to store the token (env for single-user demo vs. DB).
- Single-user demo vs. multi-user: assume single-user (you) for now; auth can come later.
- Postgres provider for deploy (only needed at step 10).
