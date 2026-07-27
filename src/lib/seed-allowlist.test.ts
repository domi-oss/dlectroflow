import { describe, it, expect, vi } from "vitest";
import {
  parseOwnerAllowlist,
  seedOwnerAllowlist,
  OWNER_SEED_NOTE,
} from "../../prisma/seed-allowlist";

// Pure/fake-client tests — no DB. The DB-backed proof that a seeded invitation
// actually admits the owner lives in seed-allowlist.integration.test.ts.
describe("parseOwnerAllowlist", () => {
  it("splits, trims and lowercases", () => {
    expect(parseOwnerAllowlist(" 1234567 , Domi ,D@Example.COM")).toEqual([
      "1234567",
      "domi",
      "d@example.com",
    ]);
  });

  it("drops empty entries so a trailing comma can't create a blank invite", () => {
    // A blank identity would be matched by any profile whose username/email were
    // normalised away — i.e. it would be an open door.
    expect(parseOwnerAllowlist("1234567,,  ,")).toEqual(["1234567"]);
  });

  it("de-duplicates identities that differ only by case or padding", () => {
    expect(parseOwnerAllowlist("Domi, domi ,DOMI")).toEqual(["domi"]);
  });

  it("returns an empty list for unset or empty input", () => {
    expect(parseOwnerAllowlist(undefined)).toEqual([]);
    expect(parseOwnerAllowlist("")).toEqual([]);
    expect(parseOwnerAllowlist("   ")).toEqual([]);
  });

  it("normalises the same way the provider profile does", () => {
    // fetchProfile lowercases + trims username/email; if these two ever diverge
    // the seeded invitation silently stops matching the owner's profile.
    expect(parseOwnerAllowlist("  MiXeD  ")).toEqual(["mixed"]);
  });
});

describe("seedOwnerAllowlist", () => {
  function fakeDb() {
    const upsert = vi.fn().mockResolvedValue({});
    return { db: { allowlist: { upsert } }, upsert };
  }

  it("upserts one owner invitation per identity", async () => {
    const { db, upsert } = fakeDb();

    const n = await seedOwnerAllowlist(db, "gitlab", ["1234567", "domi"]);

    expect(n).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledWith({
      where: { provider_identity: { provider: "gitlab", identity: "1234567" } },
      create: {
        provider: "gitlab",
        identity: "1234567",
        isOwnerSeed: true,
        note: OWNER_SEED_NOTE,
      },
      update: { isOwnerSeed: true },
    });
  });

  it("confers ownership through the dedicated boolean, never through the note", async () => {
    const { db, upsert } = fakeDb();

    await seedOwnerAllowlist(db, "gitlab", ["domi"]);

    const [args] = upsert.mock.calls[0] as [
      {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      },
    ];
    // `note` is a human label; isOwnerSeed is the authorization fact. If the
    // note ever became load-bearing, any row carrying the string would mint an
    // owner — see provisioning.integration.test.ts for the matching guard.
    expect(args.create.isOwnerSeed).toBe(true);
    expect(args.update).toEqual({ isOwnerSeed: true });
    expect(args.update).not.toHaveProperty("note");
  });

  it("never writes claimedById/claimedAt on re-run", async () => {
    const { db, upsert } = fakeDb();

    await seedOwnerAllowlist(db, "gitlab", ["domi"]);

    // Re-seeding must not un-claim an invitation the owner already used —
    // that would hand their invite to whoever signed in next.
    const [{ update }] = upsert.mock.calls[0] as [
      { update: Record<string, unknown> },
    ];
    expect(update).not.toHaveProperty("claimedById");
    expect(update).not.toHaveProperty("claimedAt");
  });

  it("is a no-op for an empty identity list", async () => {
    const { db, upsert } = fakeDb();

    expect(await seedOwnerAllowlist(db, "gitlab", [])).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("scopes the invitation to the configured provider (#74)", async () => {
    const { db, upsert } = fakeDb();

    await seedOwnerAllowlist(db, "someprovider", ["domi"]);

    const [args] = upsert.mock.calls[0] as [
      { where: { provider_identity: { provider: string } } },
    ];
    expect(args.where.provider_identity.provider).toBe("someprovider");
  });
});
