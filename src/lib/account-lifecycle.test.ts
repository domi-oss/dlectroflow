import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// #126 — deleting an account has to WITHDRAW the Google grant, not just drop
// the row that holds the token. The FK cascade removes `GoogleAuth` when a
// `User` goes, which destroys the credential at this end and tells Google
// nothing: the grant stays live in the person's Google account, and every route
// the product had to withdraw it has just been deleted along with the account.
const { prismaMock, tryDisconnectGoogleMock } = vi.hoisted(() => ({
  prismaMock: { user: { deleteMany: vi.fn() } },
  tryDisconnectGoogleMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/google", () => ({
  tryDisconnectGoogle: tryDisconnectGoogleMock,
}));

import { deleteAccount } from "./account-lifecycle";

const USER = "user_alice";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.user.deleteMany.mockResolvedValue({ count: 1 });
  tryDisconnectGoogleMock.mockResolvedValue(true);
});

describe("deleteAccount", () => {
  it("deletes the account and reports that it existed", async () => {
    expect(await deleteAccount(USER)).toBe(true);
    expect(prismaMock.user.deleteMany).toHaveBeenCalledWith({
      where: { id: USER },
    });
  });

  it("revokes the Google grant BEFORE the row is deleted", async () => {
    await deleteAccount(USER);

    expect(tryDisconnectGoogleMock).toHaveBeenCalledWith(USER);
    // Order is the whole point. Afterwards the credential is gone — cascaded
    // away with its user — so there is no token left to revoke WITH.
    expect(tryDisconnectGoogleMock.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.user.deleteMany.mock.invocationCallOrder[0],
    );
  });

  it("deletes the account anyway when the revoke could not complete", async () => {
    // Erasure must not be blocked by Google being unreachable — a request under
    // Art. 17 has a one-month clock on it, and the fallback (withdrawing the
    // grant at Google's own permissions page) is always available.
    tryDisconnectGoogleMock.mockResolvedValue(false);
    expect(await deleteAccount(USER)).toBe(true);
    expect(prismaMock.user.deleteMany).toHaveBeenCalledWith({
      where: { id: USER },
    });
  });

  it("reports a miss for an account that is already gone", async () => {
    // deleteMany, not delete: deleting an account twice is the outcome the
    // caller wanted, not a P2025 thrown at a purge sweep mid-batch.
    prismaMock.user.deleteMany.mockResolvedValue({ count: 0 });
    expect(await deleteAccount("ghost")).toBe(false);
  });
});

// ── The chokepoint rule ─────────────────────────────────────────────────────
//
// `deleteAccount` is only worth having if it is the ONLY way an account gets
// deleted. A second call site that goes straight to `prisma.user.delete` gets
// the cascade — and reintroduces the bug in full, silently. So the rule is
// structural, in the style of src/lib/__tests__/scoping.harness.test.ts, rather
// than a note in a doc comment that a future writer will not read.
describe("no other module deletes a User (#126)", () => {
  const OWNER = "src/lib/account-lifecycle.ts";

  function sourceFiles(): string[] {
    return readdirSync("src", { recursive: true, encoding: "utf8" })
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes(".test."))
      .map((f) => path.join("src", f));
  }

  it("scans a real number of source files", () => {
    // Without this, a broken glob turns the rule below into a test that reads
    // nothing and passes forever.
    expect(sourceFiles().length).toBeGreaterThan(50);
  });

  it("the owning module still performs the delete it is trusted with", () => {
    // And without THIS, renaming or gutting the chokepoint leaves a rule that
    // polices an empty set.
    expect(readFileSync(OWNER, "utf8")).toContain("prisma.user.deleteMany(");
  });

  /**
   * The delete shapes this rule can see, as plain substrings — not a regex
   * assembled from a variable (semgrep `non-literal-regexp`, flagged on !175).
   * `.user.delete` covers `delete` and `deleteMany` alike, and the lowercased
   * copy makes the raw-SQL needle case-insensitive without one.
   *
   * WHAT IT CANNOT SEE, stated rather than implied: a Prisma client bound to
   * some other alias than the three this codebase uses, and raw SQL broken
   * across lines or built from fragments. Neither exists here, and both are
   * conspicuous in review in a way that a stray `prisma.user.delete` is not —
   * the failure mode worth catching is the ordinary one, written by someone who
   * did not know this function existed. Widen the list if a fourth alias ever
   * appears; do not let the gap become the argument for dropping the rule.
   */
  function deleteShapesIn(src: string): string[] {
    const lower = src.toLowerCase();
    const found: string[] = [];
    for (const receiver of ["prisma", "tx", "db"]) {
      const needle = `${receiver}.user.delete`;
      if (src.includes(needle)) found.push(needle);
    }
    if (lower.includes('delete from "user"')) found.push('DELETE FROM "User"');
    return found;
  }

  it("recognises both an ORM delete and a raw one", () => {
    // The fixture is the proof this scanner can fail — a matcher only ever
    // pointed at a clean tree is indistinguishable from one that matches
    // nothing (the same argument scoping.harness.test.ts makes).
    expect(
      deleteShapesIn(`
        await prisma.user.delete({ where: { id } });
        await tx.user.deleteMany({ where: { id } });
        await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE "id" = $1', id);
      `),
    ).toEqual(["prisma.user.delete", "tx.user.delete", 'DELETE FROM "User"']);
    // And that it is not merely matching everything.
    expect(
      deleteShapesIn(`await prisma.user.updateMany({ where: { id } });`),
    ).toEqual([]);
  });

  it("no other source file deletes a User", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file === OWNER) continue;
      for (const shape of deleteShapesIn(readFileSync(file, "utf8"))) {
        offenders.push(`${file}: ${shape}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
