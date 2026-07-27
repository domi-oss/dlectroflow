import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lockTreeEntries, distinctLockVersions } from "./lockfile-hygiene";

const HOISTED_ONLY = {
  "": { name: "root" },
  "node_modules/esbuild": { version: "0.28.1" },
  "node_modules/tsx": { version: "4.23.1" },
};

const NESTED_DUPLICATE = {
  "": { name: "root" },
  "node_modules/esbuild": { version: "0.23.1" },
  "node_modules/vitest/node_modules/esbuild": { version: "0.28.1" },
  // Same-name prefixes must not be mistaken for the package itself.
  "node_modules/esbuild-register": { version: "3.6.0" },
};

describe("lockTreeEntries", () => {
  it("finds the hoisted entry", () => {
    expect(lockTreeEntries(HOISTED_ONLY, "esbuild")).toEqual([
      { path: "node_modules/esbuild", version: "0.28.1" },
    ]);
  });

  it("finds nested entries as well as the hoisted one", () => {
    expect(lockTreeEntries(NESTED_DUPLICATE, "esbuild")).toEqual([
      { path: "node_modules/esbuild", version: "0.23.1" },
      { path: "node_modules/vitest/node_modules/esbuild", version: "0.28.1" },
    ]);
  });

  it("does not match a package whose name merely starts the same", () => {
    expect(lockTreeEntries(NESTED_DUPLICATE, "esbuild")).not.toContainEqual(
      expect.objectContaining({ path: "node_modules/esbuild-register" }),
    );
  });

  it("returns nothing for an absent package", () => {
    expect(lockTreeEntries(HOISTED_ONLY, "rollup")).toEqual([]);
  });
});

describe("distinctLockVersions", () => {
  it("collapses one version to a single entry", () => {
    expect(distinctLockVersions(HOISTED_ONLY, "esbuild")).toEqual(["0.28.1"]);
  });

  it("reports every version present, sorted", () => {
    expect(distinctLockVersions(NESTED_DUPLICATE, "esbuild")).toEqual([
      "0.23.1",
      "0.28.1",
    ]);
  });

  // Duo review (#67): a bare .sort() orders lexicographically, so "0.9.0" would
  // land AFTER "0.10.0" because "9" > "1". The guard itself only counts
  // versions, but the exported contract says sorted, so it has to be true.
  it("orders numeric segments by value, not by digit (0.9.0 before 0.10.0)", () => {
    const packages = {
      "node_modules/esbuild": { version: "0.10.0" },
      "node_modules/a/node_modules/esbuild": { version: "0.9.0" },
      "node_modules/b/node_modules/esbuild": { version: "0.10.2" },
    };
    expect(distinctLockVersions(packages, "esbuild")).toEqual([
      "0.9.0",
      "0.10.0",
      "0.10.2",
    ]);
  });

  it("keeps prerelease tags deterministically ordered rather than unsorted", () => {
    const packages = {
      "node_modules/esbuild": { version: "1.0.0-beta.10" },
      "node_modules/a/node_modules/esbuild": { version: "1.0.0-beta.2" },
    };
    expect(distinctLockVersions(packages, "esbuild")).toEqual([
      "1.0.0-beta.2",
      "1.0.0-beta.10",
    ]);
  });

  it("de-duplicates repeated versions", () => {
    const packages = {
      "node_modules/esbuild": { version: "0.28.1" },
      "node_modules/a/node_modules/esbuild": { version: "0.28.1" },
    };
    expect(distinctLockVersions(packages, "esbuild")).toEqual(["0.28.1"]);
  });
});

/**
 * #67 regression guard. Renovate regenerates lockfiles with a newer npm than CI
 * installs with (npm 11 vs npm 10). When two dependents needed incompatible
 * esbuild ranges, npm 11 dropped the nested subtree while keeping the nested
 * vite that required it — an internally inconsistent lockfile that CI's `npm ci`
 * rejected, blocking every dependency MR. Keeping esbuild on ONE version means
 * there is no nested subtree to drop, so both npm versions agree.
 *
 * If this fails, a dependency has reintroduced a second esbuild range (most
 * likely tsx being pinned below 4.22, whose esbuild range stopped overlapping
 * vite's). Realign the ranges rather than deleting this test — see #67.
 */
describe("package-lock.json hygiene (#67)", () => {
  const lock = JSON.parse(
    readFileSync(join(process.cwd(), "package-lock.json"), "utf8"),
  ) as { packages: Record<string, { version?: string }> };

  it("resolves esbuild to exactly one version, with no nested copy", () => {
    expect(distinctLockVersions(lock.packages, "esbuild")).toHaveLength(1);
    expect(
      lockTreeEntries(lock.packages, "esbuild").map((e) => e.path),
    ).toEqual(["node_modules/esbuild"]);
  });
});
