# dlectroflow

An ADHD helper web app — capture, clarify, schedule, focus, and get rewarded.

The core loop: **Capture → Clarify → Schedule → Focus → Reward → (come back tomorrow)**

## Features
- 🧠 **Brain Dump** — friction-free quick-capture inbox with clear triage and aging reminders.
- ✂️ **Task Breakdown → Reclaim** — Claude conversationally breaks a task into tiny steps and schedules them into [Reclaim](https://reclaim.ai) via the official MCP connector.
- ⏱️ **Focus Timer** — visual Pomodoro that defaults to each step's estimate; confirms completion (never assumes) and syncs completion back to Reclaim.
- 🎉 **Rewards & Streaks** — points, confetti, working-day streaks, a personal best-streaks leaderboard, and a daily spark of inspiration.

## Tech stack
Next.js (App Router) + TypeScript · Tailwind CSS + shadcn/ui + Framer Motion · Prisma + SQLite (→ Postgres for deploy) · Claude API (`claude-opus-4-8`) · Reclaim MCP connector · Dockerfile + GitLab CI/CD.

## Status
Early scaffolding. See [docs/dlectroflow-plan.md](docs/dlectroflow-plan.md) for the full spec and build plan.
