import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  parseOwnerAllowlist,
  seedOwnerAllowlist,
} from "../../prisma/seed-allowlist";
import { provisionFromProfile } from "@/lib/auth/provisioning";

// #35 Phase A — the lockout regression.
//
// The single most expensive way this phase can fail is: it deploys, sign-in
// becomes invite-only, and the owner's own seeded invitation is in a form that
// can never match their profile. That is not hypothetical — OWNER_ALLOWLIST is
// documented as "GitLab numeric user id" (.env.example), i.e. the provider
// SUBJECT, while the design matched invitations against username and email
// only. This suite drives the real seed into a real database and then signs the
// owner in through the real provisioning path.
const prisma = new PrismaClient();

const PROVIDER = "seed-test";

async function reset(): Promise<void> {
  await prisma.allowlist.deleteMany({ where: { provider: PROVIDER } });
  await prisma.user.deleteMany({ where: { provider: PROVIDER } });
}

beforeEach(reset);

afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

describe("owner allowlist seed → first sign-in", () => {
  it("admits the owner when OWNER_ALLOWLIST holds their numeric provider id", async () => {
    await seedOwnerAllowlist(
      prisma,
      PROVIDER,
      parseOwnerAllowlist("  1234567 "),
    );

    const r = await provisionFromProfile(PROVIDER, {
      subject: "1234567",
      username: "domi",
      email: "d@example.com",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.role).toBe("owner");
  });

  it("admits the owner when OWNER_ALLOWLIST holds their username instead", async () => {
    await seedOwnerAllowlist(prisma, PROVIDER, parseOwnerAllowlist("Domi"));

    const r = await provisionFromProfile(PROVIDER, {
      subject: "1234567",
      username: "domi",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.role).toBe("owner");
  });

  it("is idempotent across deploys and keeps the claim intact", async () => {
    const identities = parseOwnerAllowlist("1234567");
    await seedOwnerAllowlist(prisma, PROVIDER, identities);
    const first = await provisionFromProfile(PROVIDER, { subject: "1234567" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Every deploy re-runs the seed, including deploys after the owner has
    // already signed in. Re-seeding must not release their claim.
    await seedOwnerAllowlist(prisma, PROVIDER, identities);
    await seedOwnerAllowlist(prisma, PROVIDER, identities);

    const rows = await prisma.allowlist.findMany({
      where: { provider: PROVIDER },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].claimedById).toBe(first.userId);

    // And the owner still signs in to the SAME account afterwards.
    const again = await provisionFromProfile(PROVIDER, { subject: "1234567" });
    expect(again).toEqual(first);
    expect(await prisma.user.count({ where: { provider: PROVIDER } })).toBe(1);
  });

  it("does not admit anyone who is not on the list", async () => {
    await seedOwnerAllowlist(prisma, PROVIDER, parseOwnerAllowlist("1234567"));

    const r = await provisionFromProfile(PROVIDER, {
      subject: "9999999",
      username: "stranger",
      email: "stranger@example.com",
    });

    expect(r).toEqual({ ok: false, reason: "not_invited" });
    expect(await prisma.user.count({ where: { provider: PROVIDER } })).toBe(0);
  });

  it("seeds nothing at all when OWNER_ALLOWLIST is empty", async () => {
    await seedOwnerAllowlist(prisma, PROVIDER, parseOwnerAllowlist(""));

    expect(
      await prisma.allowlist.count({ where: { provider: PROVIDER } }),
    ).toBe(0);
    // …and an empty list must not become an open door.
    const r = await provisionFromProfile(PROVIDER, {
      subject: "1",
      username: "anyone",
    });
    expect(r).toEqual({ ok: false, reason: "not_invited" });
  });
});
