import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { prismaErrorsDuring } from "@/lib/__tests__/prisma-error-log";
import { awardBadge } from "@/lib/rewards";
import { consumeGuestBreakdown } from "@/lib/guest-quota";
import { consumeUserBreakdown } from "@/lib/user-quota";
import { BadgeKey } from "@/lib/constants";
import { invitePerson } from "@/app/actions/people";

// Real-Postgres proof for #158: the four call sites that still HANDLED a
// duplicate by catching P2002 no longer raise one at all.
//
// #156 established the defect and !240 closed it at two sites. The class:
// `log: ["error"]` (src/lib/db.ts) is Prisma's own client-level logger, so it
// prints the moment a query fails — strictly BEFORE the exception reaches our
// `catch`. A duplicate the code recovers from perfectly still printed
//
//     prisma:error  Invalid `prisma.badge.create()` invocation:
//                   Unique constraint failed on the fields: (`workspaceId`,`key`)
//
// which is indistinguishable in the logs from a real incident, and is exactly
// how #156 came to be reported as one when nobody had been affected.
//
// This file is not colocated because the property is cross-cutting — four
// unrelated modules claim it, and asserting it once per module would let three
// of them quietly stop claiming it (same reason `scoping.harness.test.ts` lives
// here rather than next to a model).
//
// It asserts from both sides, because "nothing printed" is also what a
// suppressed logger looks like:
//
//   1. each site emits NOTHING at error level for a duplicate it handles, and
//   2. a genuine Prisma failure still prints exactly as before.
//
// A zero nobody has seen fail is not a result, so this file was run against the
// pre-fix code first. One such run (2026-08-06) captured 59 `prisma:error`
// lines: 15 from rewards.ts:91, 15 from guest-quota.ts:163, 13 from
// guest-quota.ts:107, 15 from user-quota.ts:96 and 1 from people.ts:87. The
// races cap at 15 (5 trials x 3 losers of a 4-way burst); the 13 is a trial
// that partly serialised, which is why the counts are evidence rather than
// assertions.

// `invitePerson` is a server action whose whole job is the owner gate; this file
// is about the write underneath it, so the gate is stubbed and everything below
// it — including Prisma — is real.
vi.mock("@/lib/workspace", () => ({
  isOwnerRequest: () => Promise.resolve(true),
  currentUser: () => Promise.resolve(null),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const PREFIX = "itest-p2002";

// A duplicate can only happen once per subject, so one trial per site would be
// a single coin flip. Five subjects, each with four concurrent callers, makes a
// lost race effectively certain — and if a run does serialise completely it
// still passes, correctly; it just proves less that time.
const TRIALS = 5;
const CONCURRENCY = 4;
const subjects = Array.from({ length: TRIALS }, (_, i) => `${PREFIX}-${i}`);

beforeAll(async () => {
  await cleanup();

  // `vi.stubEnv` rather than assigning `process.env` directly, so that
  // `vi.unstubAllEnvs()` in afterAll RESTORES whatever each variable held
  // before — including "was not set at all". Six variables are set here and the
  // teardown used to clear exactly one, leaking the other five into whichever
  // file Vitest scheduled next in the same worker.
  //
  // Deleting all six in afterAll would fix the leak but introduce a quieter
  // bug: `delete` cannot tell "this file set it" from "the developer's shell
  // already had it set", so it would silently unset a real value for the rest
  // of the run. Stubbing is the only form of this that is correct both ways.
  vi.stubEnv("AUTH_PROVIDER", "gitlab");
  // Quotas well above CONCURRENCY: this file is about the first-use insert, not
  // about enforcement (that is guest-quota/user-quota.integration.test.ts).
  vi.stubEnv("GUEST_AI_QUOTA_PER_WINDOW", "100");
  vi.stubEnv("GUEST_AI_WINDOW_HOURS", "24");
  vi.stubEnv("GUEST_GLOBAL_DAILY_GUEST_CAP", "1000");
  vi.stubEnv("GUEST_IP_HASH_SALT", "test-salt");
  vi.stubEnv("USER_AI_WINDOW_HOURS", "24");

  await prisma.workspace.createMany({
    data: subjects.map((id) => ({ id, kind: "guest" })),
  });
  await prisma.user.createMany({
    data: subjects.map((id) => ({
      id,
      provider: "gitlab",
      providerSub: id,
      aiPolicy: "capped",
      aiQuota: 100,
    })),
  });

  // Open the connection pool before timing matters. Prisma connects lazily, so
  // the very first burst serialises on the handshake and would not race at all.
  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => prisma.workspace.count()),
  );
});

async function cleanup() {
  // Badge cascades from Workspace and UserAiUsage from User, so those two
  // deletes clear four tables. The rest key on nothing that cascades.
  await prisma.workspace.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.guestAiUsage.deleteMany({
    where: { ipHash: { startsWith: PREFIX } },
  });
  await prisma.guestDailyActivity.deleteMany({
    where: { ipHash: { startsWith: PREFIX } },
  });
  await prisma.allowlist.deleteMany({
    where: { identity: { startsWith: PREFIX } },
  });
}

afterAll(async () => {
  await cleanup();
  // Restores all six, to whatever they were before this file ran.
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe("a handled duplicate reaches no log at all (#158)", () => {
  it("awardBadge: concurrent first awards of one badge print nothing", async () => {
    // src/lib/rewards.ts — the findUnique→create pair is a TOCTOU by design:
    // every concurrent caller sees no badge and every one of them writes.
    const outcomes: boolean[][] = [];

    const errors = await prismaErrorsDuring(async () => {
      for (const workspaceId of subjects) {
        outcomes.push(
          await Promise.all(
            Array.from({ length: CONCURRENCY }, () =>
              awardBadge(workspaceId, BadgeKey.Streak5),
            ),
          ),
        );
      }
    });

    expect(errors).toEqual([]);

    // …and the answer is unchanged: the badge is awarded once, to one caller.
    for (const trial of outcomes) {
      expect(trial.filter(Boolean)).toHaveLength(1);
    }
    expect(
      await prisma.badge.count({
        where: { workspaceId: { startsWith: PREFIX }, key: BadgeKey.Streak5 },
      }),
    ).toBe(TRIALS);
  });

  it("consumeGuestBreakdown: concurrent first use for one IP prints nothing", async () => {
    // Two sites in one call: the `GuestDailyActivity` tally insert
    // (src/lib/guest-quota.ts) and the meter's `createFirstUse`
    // (src/lib/sliding-window-meter.ts, via the guest store).
    const errors = await prismaErrorsDuring(async () => {
      for (const ipHash of subjects) {
        const results = await Promise.all(
          Array.from({ length: CONCURRENCY }, () =>
            consumeGuestBreakdown(ipHash),
          ),
        );
        // Quota is 100 and the global cap 1000, so nothing here may be refused
        // — a block would mean the conversion changed enforcement.
        expect(results.every((r) => r.allowed)).toBe(true);
      }
    });

    expect(errors).toEqual([]);

    // Counted exactly once against the global distinct-guest tally per IP, and
    // every unit consumed: the losers of the insert race still incremented.
    expect(
      await prisma.guestDailyActivity.count({
        where: { ipHash: { startsWith: PREFIX } },
      }),
    ).toBe(TRIALS);
    for (const ipHash of subjects) {
      const row = await prisma.guestAiUsage.findUnique({ where: { ipHash } });
      expect(row?.count).toBe(CONCURRENCY);
    }
  });

  it("consumeUserBreakdown: concurrent first use for one account prints nothing", async () => {
    // src/lib/user-quota.ts — the same meter, keyed on a user instead of an IP.
    const errors = await prismaErrorsDuring(async () => {
      for (const userId of subjects) {
        const results = await Promise.all(
          Array.from({ length: CONCURRENCY }, () =>
            consumeUserBreakdown(userId),
          ),
        );
        expect(results.every((r) => r.blockedReason === null)).toBe(true);
      }
    });

    expect(errors).toEqual([]);

    for (const userId of subjects) {
      const row = await prisma.userAiUsage.findUnique({ where: { userId } });
      expect(row?.count).toBe(CONCURRENCY);
    }
  });

  it("invitePerson: re-inviting an existing identity prints nothing", async () => {
    // src/app/actions/people.ts — the only one of the four that is not a race.
    // "Already invited" is an ordinary, expected answer the owner sees whenever
    // they invite the same person twice, so this printed at error level on a
    // path with no concurrency in it at all.
    const identity = `${PREFIX}-grace`;
    expect(await invitePerson({ identity })).toEqual({ ok: true });

    let second: unknown;
    const errors = await prismaErrorsDuring(async () => {
      second = await invitePerson({ identity });
    });

    expect(second).toEqual({ ok: false, error: "already_invited" });
    expect(errors).toEqual([]);
    expect(await prisma.allowlist.count({ where: { identity } })).toBe(1);
  });

  it("still prints at error level for a genuine Prisma failure", async () => {
    // The other half of the requirement, and the reason none of the above may
    // be read as "the logger was turned off". A foreign-key violation is an
    // unambiguously real failure with no duplicate anywhere near it.
    let rejection: unknown;
    const errors = await prismaErrorsDuring(async () => {
      rejection = await prisma.badge
        .create({
          data: { key: BadgeKey.Streak5, workspaceId: `${PREFIX}-no-such-ws` },
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
    expect(errors[0]).toContain("Badge_workspaceId_fkey");
  });
});
