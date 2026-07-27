import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { provisionFromProfile } from "./provisioning";

// #35 Phase A — the provisioning matrix. This module is the security boundary
// of the whole accounts feature: it is the ONLY place that decides whether an
// OAuth identity becomes an account. Driving it directly against a real
// Postgres (rather than through the OAuth callback) is what makes the deny
// paths assertable, including the part that matters most — that a denial
// creates no User row at all.
//
// Dedicated client so $disconnect() here can't tear the connection out from
// under sibling integration tests.
const prisma = new PrismaClient();

// A provider name unique to this file. Sibling integration tests share the
// schema, so scoping every write AND every count to this provider is what keeps
// the "creates NO user" assertions from reading another file's rows.
const PROVIDER = "prov-test";

async function reset(): Promise<void> {
  // Allowlist first: its claimedById FK is SET NULL, so deleting users first
  // would leave claimed-but-dangling rows behind for the next test.
  await prisma.allowlist.deleteMany({ where: { provider: PROVIDER } });
  await prisma.user.deleteMany({ where: { provider: PROVIDER } });
}

async function userCount(): Promise<number> {
  return prisma.user.count({ where: { provider: PROVIDER } });
}

async function workspaceCount(): Promise<number> {
  return prisma.workspace.count({ where: { user: { provider: PROVIDER } } });
}

beforeEach(reset);

afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

describe("provisionFromProfile", () => {
  it("creates a user and workspace for an allowlisted username", async () => {
    await prisma.allowlist.create({
      data: { provider: PROVIDER, identity: "domi" },
    });

    const r = await provisionFromProfile(PROVIDER, {
      subject: "42",
      username: "domi",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ws = await prisma.workspace.findUnique({
      where: { userId: r.userId },
    });
    expect(ws?.id).toBe(r.workspaceId);
    expect(ws?.kind).toBe("user");
    // A user workspace never expires — only guest sandboxes carry a TTL.
    expect(ws?.expiresAt).toBeNull();
    const row = await prisma.allowlist.findFirst({
      where: { provider: PROVIDER, identity: "domi" },
    });
    expect(row?.claimedById).toBe(r.userId);
    expect(row?.claimedAt).toBeInstanceOf(Date);
  });

  it("matches an allowlist entry by email as well as username", async () => {
    await prisma.allowlist.create({
      data: { provider: PROVIDER, identity: "d@example.com" },
    });

    const r = await provisionFromProfile(PROVIDER, {
      subject: "43",
      email: "d@example.com",
    });

    expect(r.ok).toBe(true);
  });

  // The env var this allowlist is seeded from, OWNER_ALLOWLIST, documents itself
  // as "GitLab numeric user id" (.env.example) — which is the provider SUBJECT,
  // not a username or an email. Matching only username/email would seed the
  // owner's own invite in a form that can never match, locking them out of
  // their own instance on the first deploy.
  it("matches an allowlist entry by the provider subject (a numeric id invite)", async () => {
    await prisma.allowlist.create({
      data: { provider: PROVIDER, identity: "1234567" },
    });

    const r = await provisionFromProfile(PROVIDER, {
      subject: "1234567",
      username: "domi",
      email: "d@example.com",
    });

    expect(r.ok).toBe(true);
    expect(await userCount()).toBe(1);
  });

  it("refuses an identity that is not allowlisted, and creates NO user", async () => {
    const r = await provisionFromProfile(PROVIDER, {
      subject: "44",
      username: "stranger",
    });

    expect(r).toEqual({ ok: false, reason: "not_invited" });
    expect(await userCount()).toBe(0);
    expect(await workspaceCount()).toBe(0);
  });

  it("refuses a profile carrying no identity at all", async () => {
    await prisma.allowlist.create({
      data: { provider: PROVIDER, identity: "" },
    });

    // Empty-string username/email are normalised away upstream, so a profile
    // can arrive with nothing but a subject. It must not match a blank invite.
    const r = await provisionFromProfile(PROVIDER, { subject: "" });

    expect(r).toEqual({ ok: false, reason: "not_invited" });
    expect(await userCount()).toBe(0);
  });

  it("does not honour an invitation issued for a different provider", async () => {
    await prisma.allowlist.create({
      data: { provider: `${PROVIDER}-other`, identity: "domi" },
    });

    const r = await provisionFromProfile(PROVIDER, {
      subject: "45",
      username: "domi",
    });

    expect(r).toEqual({ ok: false, reason: "not_invited" });
    expect(await userCount()).toBe(0);
    await prisma.allowlist.deleteMany({
      where: { provider: `${PROVIDER}-other` },
    });
  });

  it("refuses a revoked user and does not resurrect them", async () => {
    const u = await prisma.user.create({
      data: { provider: PROVIDER, providerSub: "46", status: "revoked" },
    });
    // Even with a live invitation sitting there, revocation wins.
    await prisma.allowlist.create({
      data: { provider: PROVIDER, identity: "gone" },
    });

    const r = await provisionFromProfile(PROVIDER, {
      subject: "46",
      username: "gone",
    });

    expect(r).toEqual({ ok: false, reason: "revoked" });
    expect(
      (await prisma.user.findUnique({ where: { id: u.id } }))?.status,
    ).toBe("revoked");
    expect(await userCount()).toBe(1);
  });

  it("returns the existing account on a second sign-in, without a second workspace", async () => {
    await prisma.allowlist.create({
      data: { provider: PROVIDER, identity: "domi" },
    });

    const first = await provisionFromProfile(PROVIDER, {
      subject: "42",
      username: "domi",
    });
    const second = await provisionFromProfile(PROVIDER, {
      subject: "42",
      username: "domi",
    });

    expect(second).toEqual(first);
    expect(await workspaceCount()).toBe(1);
    expect(await userCount()).toBe(1);
  });

  it("refreshes handle, email and lastSeenAt on a repeat sign-in", async () => {
    await prisma.allowlist.create({
      data: { provider: PROVIDER, identity: "domi" },
    });
    const first = await provisionFromProfile(PROVIDER, {
      subject: "42",
      username: "domi",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await prisma.user.update({
      where: { id: first.userId },
      data: { lastSeenAt: new Date("2020-01-01") },
    });

    await provisionFromProfile(PROVIDER, {
      subject: "42",
      username: "domi-renamed",
      email: "new@example.com",
    });

    const u = await prisma.user.findUnique({ where: { id: first.userId } });
    expect(u?.handle).toBe("domi-renamed");
    expect(u?.email).toBe("new@example.com");
    expect(u!.lastSeenAt.getTime()).toBeGreaterThan(
      new Date("2020-01-02").getTime(),
    );
  });

  it("does not let a claimed invite be reused by a different subject", async () => {
    await prisma.allowlist.create({
      data: { provider: PROVIDER, identity: "domi" },
    });
    await provisionFromProfile(PROVIDER, { subject: "42", username: "domi" });

    const r = await provisionFromProfile(PROVIDER, {
      subject: "99",
      username: "domi",
    });

    expect(r).toEqual({ ok: false, reason: "not_invited" });
    expect(await userCount()).toBe(1);
  });

  // The role comes from an explicit Allowlist.role column rather than being
  // inferred from the free-text `note`: a human label must never be what
  // decides whether an account can administer the instance.
  it("provisions the owner role from an invite that confers it", async () => {
    await prisma.allowlist.create({
      data: {
        provider: PROVIDER,
        identity: "1234567",
        role: "owner",
        note: "seeded from OWNER_ALLOWLIST",
      },
    });

    const r = await provisionFromProfile(PROVIDER, { subject: "1234567" });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.role).toBe("owner");
    expect(
      (await prisma.user.findUnique({ where: { id: r.userId } }))?.role,
    ).toBe("owner");
  });

  it("provisions the member role by default", async () => {
    await prisma.allowlist.create({
      data: { provider: PROVIDER, identity: "someone" },
    });

    const r = await provisionFromProfile(PROVIDER, {
      subject: "50",
      username: "someone",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.role).toBe("member");
  });

  it("returns the stored role on a repeat sign-in, not a recomputed one", async () => {
    await prisma.allowlist.create({
      data: { provider: PROVIDER, identity: "1234567", role: "owner" },
    });
    const first = await provisionFromProfile(PROVIDER, { subject: "1234567" });
    const second = await provisionFromProfile(PROVIDER, { subject: "1234567" });

    expect(second.ok).toBe(true);
    if (!second.ok || !first.ok) return;
    expect(second.role).toBe("owner");
    expect(second.userId).toBe(first.userId);
  });

  // Two browser tabs finishing OAuth at once must not produce two accounts, two
  // workspaces, or a 500. The unique (provider, providerSub) index is the
  // backstop; this asserts the module copes with losing that race.
  it("is safe under a concurrent first sign-in for the same subject", async () => {
    await prisma.allowlist.create({
      data: { provider: PROVIDER, identity: "racer" },
    });

    const [a, b] = await Promise.all([
      provisionFromProfile(PROVIDER, { subject: "77", username: "racer" }),
      provisionFromProfile(PROVIDER, { subject: "77", username: "racer" }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.userId).toBe(b.userId);
    expect(a.workspaceId).toBe(b.workspaceId);
    expect(await userCount()).toBe(1);
    expect(await workspaceCount()).toBe(1);
  });
});
