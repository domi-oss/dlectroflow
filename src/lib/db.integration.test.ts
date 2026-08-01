import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, getSettings, getStreak } from "@/lib/db";

// Real-DB proof for #156, and the only place the actual defect is observable.
//
// The bug was never a wrong result — the old upsert-and-catch returned the
// right row every time. It was that Prisma's *client-level* logger prints a
// failed query the moment it fails, before the exception reaches any `catch`,
// so an expected, self-healing first-use race printed
//
//     prisma:error  Invalid `prisma.settings.upsert()` invocation:
//                   Unique constraint failed on the fields: (`id`)
//
// and got reported as a production incident. Mocks cannot show that: the log
// line comes from the real client talking to a real Postgres. So this file
// asserts on Prisma's own log output, from both sides —
//
//   1. a genuinely concurrent first use emits nothing at error level, and
//   2. an unrelated, genuine Prisma failure still does.
//
// (2) is what stops the fix being "turn the error log off". Same shape as
// guest-quota.integration.test.ts: only real concurrency demonstrates it.

const WS_PREFIX = "test-ws-first-use-race";
// Fresh workspace per trial — a first-use race can only happen once per
// workspace, so one trial would be a single coin flip. Five trials, each with
// four concurrent readers of both tables, makes a lost race effectively
// certain: run as-is against the pre-fix upsert, this captured 26 `prisma:error`
// lines. (If a run ever does serialise completely it still passes, correctly —
// no race, no line — it just proves less that time.)
const TRIALS = 5;
const CONCURRENCY = 4;
const workspaceIds = Array.from(
  { length: TRIALS },
  (_, i) => `${WS_PREFIX}-${i}`,
);

/**
 * Capture Prisma's client-level error log for the duration of a call.
 *
 * `log: ["error"]` (src/lib/db.ts) is Prisma's *stdout* logger: it writes to
 * `console.log`, one argument, prefixed `prisma:error` — verified against
 * @prisma/client 6.19, and the reason this hooks `console.log` rather than the
 * `console.error` you would expect. Everything else is passed through so a
 * failing run still prints whatever it was going to print.
 */
async function prismaErrorsDuring(fn: () => Promise<void>): Promise<string[]> {
  const captured: string[] = [];
  const passThrough = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith("prisma:error")) captured.push(line);
    else passThrough(...args);
  };
  try {
    await fn();
  } finally {
    console.log = passThrough;
  }
  return captured;
}

beforeAll(async () => {
  await cleanup();
  await prisma.workspace.createMany({
    data: workspaceIds.map((id) => ({ id, kind: "guest" })),
  });
  // Open the connection pool before timing matters. Prisma establishes
  // connections lazily, so the very first burst serialises on the handshake
  // and would not race at all.
  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => prisma.workspace.count()),
  );
});

async function cleanup() {
  // Settings and Streak cascade from Workspace, so this clears all three.
  await prisma.workspace.deleteMany({
    where: { id: { startsWith: WS_PREFIX } },
  });
}

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("first-use race logging (#156)", () => {
  it("emits nothing at error level when first use is genuinely concurrent", async () => {
    const settled: { settings: string[]; streaks: string[] }[] = [];

    const errors = await prismaErrorsDuring(async () => {
      for (const workspaceId of workspaceIds) {
        // Both helpers together, because a real sign-in hits both: the app
        // layout reads settings while the page under it reads the streak.
        const [settings, streaks] = await Promise.all([
          Promise.all(
            Array.from({ length: CONCURRENCY }, () => getSettings(workspaceId)),
          ),
          Promise.all(
            Array.from({ length: CONCURRENCY }, () => getStreak(workspaceId)),
          ),
        ]);
        settled.push({
          settings: settings.map((r) => r.id),
          streaks: streaks.map((r) => r.id),
        });
      }
    });

    // The log line is the bug, so assert it first and print it when it fires.
    expect(errors).toEqual([]);

    // …and the behaviour it used to accompany is unchanged: every caller gets
    // the one row that exists, and exactly one row exists.
    for (const [i, ids] of settled.entries()) {
      expect(new Set(ids.settings)).toEqual(new Set([workspaceIds[i]]));
      expect(new Set(ids.streaks)).toEqual(new Set([workspaceIds[i]]));
    }
    expect(
      await prisma.settings.count({
        where: { workspaceId: { startsWith: WS_PREFIX } },
      }),
    ).toBe(TRIALS);
    expect(
      await prisma.streak.count({
        where: { workspaceId: { startsWith: WS_PREFIX } },
      }),
    ).toBe(TRIALS);
  });

  it("still emits at error level for a genuine Prisma failure", async () => {
    // The other half of the requirement: the fix must not have bought silence
    // by lowering or dropping Prisma's error log. A foreign-key violation is
    // an unambiguously real failure, unrelated to any first-use race.
    let rejection: unknown;
    const errors = await prismaErrorsDuring(async () => {
      rejection = await prisma.settings
        .create({
          data: {
            id: `${WS_PREFIX}-orphan`,
            workspaceId: `${WS_PREFIX}-no-such-workspace`,
          },
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
    });

    expect(rejection).toMatchObject({ code: "P2003" });
    expect(errors).toHaveLength(1);
    // Assert on the constraint, not on the rendered call: Prisma prints the
    // invocation as `.create()` (without the delegate) when the call spans
    // several source lines, which is a formatting detail, not the signal.
    expect(errors[0]).toContain("Settings_workspaceId_fkey");
  });
});
