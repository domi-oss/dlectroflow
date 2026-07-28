import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #35 Phase B — the owner-only People read.
//
// The rule this file exists to enforce is "usage numbers only, never content":
// the queries touch `User`, `UserAiUsage` and `Allowlist` and nothing else, and
// the ENCRYPTED KEY COLUMN IS NEVER SELECTED — presence is answered by a second,
// id-only query, so the ciphertext never enters this process's object graph at
// all. `scoping.harness.test.ts` asserts that structurally; these tests assert
// the behaviour.

const db = vi.hoisted(() => ({
  user: { findMany: vi.fn() },
  allowlist: { findMany: vi.fn() },
}));
const isOwnerRequestMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/workspace", () => ({ isOwnerRequest: isOwnerRequestMock }));

import { loadPeopleAdmin } from "./people";

const NOW = Date.now();

function userRow(over: Record<string, unknown> = {}) {
  return {
    id: "u-1",
    provider: "gitlab",
    handle: "ada",
    role: "member",
    status: "active",
    aiPolicy: "capped",
    aiQuota: 50,
    createdAt: new Date(NOW - 10 * 86_400_000),
    lastSeenAt: new Date(NOW - 3_600_000),
    aiUsage: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.USER_AI_WINDOW_HOURS;
  isOwnerRequestMock.mockResolvedValue(true);
  db.user.findMany.mockResolvedValue([]);
  db.allowlist.findMany.mockResolvedValue([]);
});

afterEach(() => {
  delete process.env.USER_AI_WINDOW_HOURS;
});

describe("loadPeopleAdmin — the owner gate", () => {
  it("returns null for a request that is not the owner's, and reads NOTHING", async () => {
    isOwnerRequestMock.mockResolvedValue(false);

    expect(await loadPeopleAdmin()).toBeNull();
    // The gate comes before the queries: a member must not even cause a read of
    // everybody else's usage.
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(db.allowlist.findMany).not.toHaveBeenCalled();
  });

  it("returns a view for the owner", async () => {
    const view = await loadPeopleAdmin();
    expect(view).not.toBeNull();
    expect(view!.people).toEqual([]);
    expect(view!.invitations).toEqual([]);
    expect(view!.windowHours).toBe(720);
  });
});

describe("loadPeopleAdmin — what it reports per person", () => {
  it("reports handle, provider, last seen, policy, quota and status", async () => {
    const lastSeenAt = new Date(NOW - 7_200_000);
    db.user.findMany.mockResolvedValueOnce([
      userRow({ handle: "ada", lastSeenAt, aiPolicy: "uncapped", aiQuota: 25 }),
    ]);

    const person = (await loadPeopleAdmin())!.people[0];

    expect(person).toMatchObject({
      id: "u-1",
      handle: "ada",
      label: "ada",
      provider: "gitlab",
      role: "member",
      status: "active",
      aiPolicy: "uncapped",
      lastSeenAt,
      hasOwnKey: false,
    });
  });

  it("labels a handle-less account by a short id rather than by its email", async () => {
    // The design is explicit that the owner sees usage, never content, and the
    // provider subject is never the email. A missing handle must therefore not
    // fall back to an address.
    db.user.findMany.mockResolvedValueOnce([
      userRow({ id: "abcdef1234567890", handle: null }),
    ]);

    const person = (await loadPeopleAdmin())!.people[0];

    expect(person.handle).toBeNull();
    expect(person.label).toBe("#abcdef12");
  });

  it("reports usage against the quota using the SAME numbers enforcement uses", async () => {
    const windowStartedAt = new Date(NOW - 5 * 86_400_000);
    db.user.findMany.mockResolvedValueOnce([
      userRow({ aiQuota: 50, aiUsage: { count: 12, windowStartedAt } }),
    ]);

    const person = (await loadPeopleAdmin())!.people[0];

    expect(person.usage).toEqual({
      used: 12,
      quota: 50,
      remaining: 38,
      windowStartedAt,
      windowEndsAt: new Date(windowStartedAt.getTime() + 720 * 3600_000),
    });
  });

  it("reports a LAPSED window as spent, matching what the next consume will see", async () => {
    process.env.USER_AI_WINDOW_HOURS = "24";
    const windowStartedAt = new Date(NOW - 48 * 3600_000);
    db.user.findMany.mockResolvedValueOnce([
      userRow({ aiQuota: 50, aiUsage: { count: 50, windowStartedAt } }),
    ]);

    const person = (await loadPeopleAdmin())!.people[0];

    expect(person.usage.used).toBe(0);
    expect(person.usage.remaining).toBe(50);
  });

  it("reports no usage at all for someone who has never used AI", async () => {
    db.user.findMany.mockResolvedValueOnce([userRow({ aiUsage: null })]);

    const person = (await loadPeopleAdmin())!.people[0];

    expect(person.usage).toEqual({
      used: 0,
      quota: 50,
      remaining: 50,
      windowStartedAt: null,
      windowEndsAt: null,
    });
  });

  it("marks the owner's own row so the UI can refuse to let them revoke themselves", async () => {
    db.user.findMany.mockResolvedValueOnce([
      userRow({ id: "u-1" }),
      userRow({ id: "u-2", handle: "grace" }),
    ]);
    db.user.findMany.mockResolvedValueOnce([]); // no keys
    isOwnerRequestMock.mockResolvedValue(true);

    const view = await loadPeopleAdmin("u-2");

    expect(view!.people.map((p) => p.isSelf)).toEqual([false, true]);
  });
});

describe("loadPeopleAdmin — the encrypted key is a boolean, never a value", () => {
  it("never selects llmKeyEnc, and answers presence with an id-only query", async () => {
    db.user.findMany
      .mockResolvedValueOnce([userRow({ id: "u-1" }), userRow({ id: "u-2" })])
      .mockResolvedValueOnce([{ id: "u-2" }]);

    const view = await loadPeopleAdmin();

    expect(view!.people.map((p) => p.hasOwnKey)).toEqual([false, true]);

    // The listing query must not ask for the ciphertext...
    const listSelect = db.user.findMany.mock.calls[0][0].select;
    expect(listSelect).not.toHaveProperty("llmKeyEnc");
    expect(listSelect).not.toHaveProperty("llmProvider");
    // ...and the presence query asks for nothing but ids.
    expect(db.user.findMany.mock.calls[1][0]).toEqual({
      where: { llmKeyEnc: { not: null } },
      select: { id: true },
    });
  });

  it("puts no key material and no email on any returned object", async () => {
    db.user.findMany.mockResolvedValueOnce([userRow()]);

    const view = await loadPeopleAdmin();

    for (const person of view!.people) {
      expect(person).not.toHaveProperty("llmKeyEnc");
      expect(person).not.toHaveProperty("llmProvider");
      expect(person).not.toHaveProperty("email");
      expect(person).not.toHaveProperty("providerSub");
    }
  });
});

describe("loadPeopleAdmin — invitations", () => {
  it("lists invitations newest first, with their claimed state", async () => {
    const invitedAt = new Date(NOW - 86_400_000);
    const claimedAt = new Date(NOW - 3_600_000);
    db.allowlist.findMany.mockResolvedValue([
      {
        id: "a-1",
        provider: "gitlab",
        identity: "grace",
        note: "new teammate",
        invitedAt,
        claimedAt: null,
      },
      {
        id: "a-2",
        provider: "gitlab",
        identity: "ada",
        note: null,
        invitedAt,
        claimedAt,
      },
    ]);

    const view = await loadPeopleAdmin();

    expect(db.allowlist.findMany.mock.calls[0][0].orderBy).toEqual({
      invitedAt: "desc",
    });
    expect(view!.invitations).toEqual([
      {
        id: "a-1",
        provider: "gitlab",
        identity: "grace",
        note: "new teammate",
        invitedAt,
        claimed: false,
      },
      {
        id: "a-2",
        provider: "gitlab",
        identity: "ada",
        note: null,
        invitedAt,
        claimed: true,
      },
    ]);
  });

  it("never exposes isOwnerSeed, so the panel cannot be read as a way to grant ownership", async () => {
    // Only prisma/seed-allowlist.ts sets that flag; surfacing it here would
    // invite a future "make owner" control on a screen that must not have one.
    await loadPeopleAdmin();
    const select = db.allowlist.findMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty("isOwnerSeed");
  });
});

describe("loadPeopleAdmin — ordering", () => {
  it("puts the OWNER first, then members oldest-account-first", async () => {
    // Caught by eyeballing the !175 screenshots: the query ordered by
    // `role: "asc"`, and "member" sorts before "owner" alphabetically, so the
    // owner's own row landed at the BOTTOM of the list — while the comment above
    // the query claimed "owner first". The owner's row is the one they look at
    // first (it is theirs, and it is the only one they cannot revoke), so it
    // leads. Sorted in code rather than by `orderBy`, because expressing
    // "owner first" in SQL means relying on the alphabetical accident that
    // "owner" > "member", which the next role would break.
    db.user.findMany.mockResolvedValueOnce([
      userRow({ id: "u-m1", handle: "grace", role: "member" }),
      userRow({ id: "u-m2", handle: "ada", role: "member" }),
      userRow({ id: "u-own", handle: "domi", role: "owner" }),
    ]);

    const view = await loadPeopleAdmin("u-own");

    expect(view!.people.map((p) => p.label)).toEqual(["domi", "grace", "ada"]);
  });

  it("keeps the database's order among members", async () => {
    db.user.findMany.mockResolvedValueOnce([
      userRow({ id: "u-a", handle: "first", role: "member" }),
      userRow({ id: "u-b", handle: "second", role: "member" }),
      userRow({ id: "u-c", handle: "third", role: "member" }),
    ]);

    const view = await loadPeopleAdmin();

    expect(view!.people.map((p) => p.label)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});
