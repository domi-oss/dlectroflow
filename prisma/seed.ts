/**
 * Review-app seed (#25 fast-follow).
 *
 * Fresh guest workspaces on GitLab review-app environments start empty, which
 * makes the row redesign hard to eyeball. This seeds a small, realistic demo
 * data set into ONE shared demo workspace so a review deploy has content across
 * the inbox buckets (Needs review / Single-task / Multi-step).
 *
 * How it runs: the Helm chart adds a review-ONLY `seed` initContainer (see
 * charts/dlectroflow/templates/deployment.yaml) that runs `npx tsx prisma/seed.ts`
 * after `prisma migrate deploy`, and the proxy seats review guests into
 * REVIEW_DEMO_WS so they actually land on this content. It is NEVER wired into
 * the staging/production deploy, and `assertReviewEnv` is a second, belt-and-
 * braces guard that refuses to run anywhere that looks like production.
 *
 * Self-contained on purpose: imports only `@prisma/client` (present in the app
 * image's traced node_modules) and uses no `@/` path aliases, so `tsx` can run
 * it straight out of the container with no app source present.
 */
import { PrismaClient } from "@prisma/client";

/** Default demo workspace id. The proxy uses REVIEW_DEMO_WS (set to this by the
 * review deploy) to seat guests here; keep the two in sync via that env var. */
export const REVIEW_DEMO_WORKSPACE_ID = "review-demo";

type SeedEnv = Record<string, string | undefined>;

function hasReviewSignal(env: SeedEnv): boolean {
  return (
    env.SEED_REVIEW_APP === "1" ||
    env.APP_ENV === "review" ||
    (env.CI_ENVIRONMENT_NAME?.startsWith("review/") ?? false)
  );
}

function isProductionEnv(env: SeedEnv): boolean {
  // NOTE: NODE_ENV is deliberately NOT consulted — the review app image boots
  // with NODE_ENV=production too, so it can't distinguish review from prod.
  return env.APP_ENV === "production" || env.CI_ENVIRONMENT_NAME === "production";
}

// Allowlist: an environment marker is acceptable only when it's a review value
// or absent. Any OTHER value (staging, qa, sandbox, …) is treated as hostile.
function appEnvAllowed(env: SeedEnv): boolean {
  return !env.APP_ENV || env.APP_ENV === "review";
}
function ciEnvAllowed(env: SeedEnv): boolean {
  return !env.CI_ENVIRONMENT_NAME || env.CI_ENVIRONMENT_NAME.startsWith("review/");
}

/**
 * Guard: throw unless the environment is unambiguously a review app. Uses
 * ALLOWLIST semantics — a blocklist that only refused "production" would let a
 * non-review env like `APP_ENV=staging` (plus SEED_REVIEW_APP=1) slip through.
 * So we require, in order: (1) not production, (2) APP_ENV/CI_ENVIRONMENT_NAME
 * are each a review value OR absent, (3) a positive review signal is present.
 */
export function assertReviewEnv(env: SeedEnv): void {
  // (1) Explicit production hard-refuse first, for a clear, prod-specific error.
  if (isProductionEnv(env)) {
    throw new Error(
      "refusing to run review seed: production environment detected (APP_ENV/CI_ENVIRONMENT_NAME)",
    );
  }
  // (2) Any non-review, non-absent env marker (staging, etc.) is refused.
  if (!appEnvAllowed(env) || !ciEnvAllowed(env)) {
    throw new Error(
      "refusing to run review seed: APP_ENV/CI_ENVIRONMENT_NAME is set to a non-review environment",
    );
  }
  // (3) Require a positive review signal so an all-absent env can't seed either.
  if (!hasReviewSignal(env)) {
    throw new Error(
      "refusing to run review seed: no review environment signal (set SEED_REVIEW_APP=1 or APP_ENV=review)",
    );
  }
}

// A minimal Prisma surface — just what the seed touches. Lets the exported
// function accept either the app's shared client or a fresh one.
type SeedClient = {
  workspace: {
    upsert(args: unknown): Promise<unknown>;
  };
  task: {
    upsert(args: unknown): Promise<unknown>;
  };
  step: {
    upsert(args: unknown): Promise<unknown>;
  };
  brainDumpItem: {
    upsert(args: unknown): Promise<unknown>;
  };
};

/**
 * Idempotently seed demo content for `workspaceId`. Every row uses a stable id
 * derived from the workspace id, so re-running (e.g. on every review re-deploy)
 * updates in place instead of piling up duplicates.
 */
export async function seedReviewApp(
  db: SeedClient,
  workspaceId: string = REVIEW_DEMO_WORKSPACE_ID,
): Promise<void> {
  const id = (suffix: string) => `${workspaceId}-${suffix}`;

  // A guest workspace that never expires, so the guest-TTL purge can't sweep the
  // demo content while a reviewer is poking at it.
  await db.workspace.upsert({
    where: { id: workspaceId },
    create: { id: workspaceId, kind: "guest", expiresAt: null },
    update: { kind: "guest", expiresAt: null },
  });

  // ── Multi-step demo task (lands in the "Multi-step" bucket) ────────────────
  const taskId = id("task-present");
  await db.task.upsert({
    where: { id: taskId },
    create: {
      id: taskId,
      title: "Prepare the quarterly presentation",
      source: "braindump",
      status: "active",
      parentEmoji: "📊",
      workspaceId,
    },
    update: { title: "Prepare the quarterly presentation", status: "active", workspaceId },
  });

  const steps: { suffix: string; order: number; text: string; emoji: string; min: number }[] = [
    { suffix: "step-1", order: 1, text: "Pull last quarter's numbers", emoji: "🔢", min: 20 },
    { suffix: "step-2", order: 2, text: "Draft the three key slides", emoji: "🖊️", min: 30 },
    { suffix: "step-3", order: 3, text: "Rehearse the walkthrough", emoji: "🎤", min: 15 },
  ];
  for (const s of steps) {
    await db.step.upsert({
      where: { id: id(s.suffix) },
      create: {
        id: id(s.suffix),
        taskId,
        text: s.text,
        order: s.order,
        total: steps.length,
        estMinutes: s.min,
        subtaskEmoji: s.emoji,
        done: false,
      },
      update: { text: s.text, order: s.order, total: steps.length, estMinutes: s.min },
    });
  }

  // ── Single-task demo (triaged, one step → "Single-task" bucket) ────────────
  const soloTaskId = id("task-solo");
  await db.task.upsert({
    where: { id: soloTaskId },
    create: {
      id: soloTaskId,
      title: "Water the office plants",
      source: "braindump",
      status: "active",
      parentEmoji: "🪴",
      workspaceId,
    },
    update: { title: "Water the office plants", status: "active", workspaceId },
  });
  await db.step.upsert({
    where: { id: id("solo-step") },
    create: {
      id: id("solo-step"),
      taskId: soloTaskId,
      text: "Water the office plants",
      order: 1,
      total: 1,
      estMinutes: 10,
      subtaskEmoji: "🪴",
      done: false,
    },
    update: { text: "Water the office plants", order: 1, total: 1, estMinutes: 10 },
  });

  // ── Brain-dump items across the buckets ────────────────────────────────────
  const now = new Date();
  const items: {
    suffix: string;
    text: string;
    status: string;
    taskId?: string;
    triagedAt?: Date;
  }[] = [
    // Needs review (fresh inbox captures)
    { suffix: "bdi-inbox-1", text: "Buy groceries for the week", status: "inbox" },
    { suffix: "bdi-inbox-2", text: "Reply to the landlord about the lease", status: "inbox" },
    { suffix: "bdi-inbox-3", text: "Book the dentist appointment", status: "inbox" },
    // Triaged → linked to the demo tasks above
    {
      suffix: "bdi-multi",
      text: "Prepare the quarterly presentation",
      status: "triaged",
      taskId,
      triagedAt: now,
    },
    {
      suffix: "bdi-solo",
      text: "Water the office plants",
      status: "triaged",
      taskId: soloTaskId,
      triagedAt: now,
    },
  ];
  for (const it of items) {
    await db.brainDumpItem.upsert({
      where: { id: id(it.suffix) },
      create: {
        id: id(it.suffix),
        text: it.text,
        status: it.status,
        taskId: it.taskId ?? null,
        triagedAt: it.triagedAt ?? null,
        workspaceId,
      },
      update: {
        text: it.text,
        status: it.status,
        taskId: it.taskId ?? null,
        triagedAt: it.triagedAt ?? null,
        workspaceId,
      },
    });
  }
}

/**
 * CLI entrypoint (review-app initContainer runs `npx tsx prisma/seed.ts`).
 * Best-effort: a seed failure must never block a review deploy — the worst case
 * is an empty review app, exactly as today. The guard is the only hard stop, and
 * it only ever fires outside a review environment (where seeding must not run).
 */
async function main(): Promise<void> {
  try {
    assertReviewEnv(process.env);
  } catch (err) {
    console.warn(`[seed] ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const workspaceId = process.env.REVIEW_DEMO_WS || REVIEW_DEMO_WORKSPACE_ID;
  const prisma = new PrismaClient();
  try {
    await seedReviewApp(prisma, workspaceId);
    console.log(`[seed] review demo content ready in workspace "${workspaceId}"`);
  } catch (err) {
    console.error(`[seed] review seed skipped (non-fatal):`, err);
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked directly (tsx/node), not when imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
