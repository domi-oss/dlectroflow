import { describe, it, expect } from "vitest";
import {
  extractUsedEnvKeys,
  extractDocumentedEnvKeys,
  computeEnvDrift,
} from "./env-drift";

describe("extractUsedEnvKeys", () => {
  it("finds dot-notation process.env.KEY reads", () => {
    const src = `
      const a = process.env.FOO_BAR;
      if (process.env.BAZ === "x") doThing();
    `;
    expect(extractUsedEnvKeys(src).sort()).toEqual(["BAZ", "FOO_BAR"]);
  });

  it("finds bracket-notation process.env[\"KEY\"] and process.env['KEY'] reads", () => {
    const src = `
      const a = process.env["FOO_BAR"];
      const b = process.env['BAZ'];
    `;
    expect(extractUsedEnvKeys(src).sort()).toEqual(["BAZ", "FOO_BAR"]);
  });

  it("finds destructured reads and uses the source name, not the alias/default", () => {
    const src = `
      const { FOO, BAR: alias, QUX = "d" } = process.env;
    `;
    expect(extractUsedEnvKeys(src).sort()).toEqual(["BAR", "FOO", "QUX"]);
  });

  it("finds destructured reads spread across multiple lines", () => {
    const src = `
      const {
        NODE_ENV,
        PUBLIC_ORIGIN,
      } = process.env;
    `;
    expect(extractUsedEnvKeys(src).sort()).toEqual([
      "NODE_ENV",
      "PUBLIC_ORIGIN",
    ]);
  });

  it("dedupes repeated reads of the same key", () => {
    const src = `process.env.FOO; process.env.FOO; process.env.FOO;`;
    expect(extractUsedEnvKeys(src)).toEqual(["FOO"]);
  });

  it("returns an empty array when there is no process.env usage", () => {
    expect(extractUsedEnvKeys("const x = 1;")).toEqual([]);
  });
});

describe("extractDocumentedEnvKeys", () => {
  it("finds active KEY=value assignments", () => {
    const example = `
ANTHROPIC_API_KEY=
DATABASE_URL="postgresql://x"
`;
    expect(extractDocumentedEnvKeys(example).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "DATABASE_URL",
    ]);
  });

  it("finds commented-out optional KEY=value lines (the .env.example convention for optional vars)", () => {
    const example = `
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
`;
    expect(extractDocumentedEnvKeys(example).sort()).toEqual([
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ]);
  });

  it("ignores prose comments that are not KEY=value lines", () => {
    const example = `
# This is a comment explaining the section below.
#   cp .env.example .env
# Get a key at https://console.anthropic.com -> API keys.
REAL_KEY=value
`;
    expect(extractDocumentedEnvKeys(example)).toEqual(["REAL_KEY"]);
  });
});

describe("computeEnvDrift", () => {
  it("reports a key used in src/ but missing from .env.example", () => {
    const result = computeEnvDrift(["USED_BUT_UNDOCUMENTED"], [], []);
    expect(result.missingFromExample).toEqual(["USED_BUT_UNDOCUMENTED"]);
    expect(result.unusedInExample).toEqual([]);
  });

  it("reports a key documented in .env.example but never read in src/", () => {
    const result = computeEnvDrift([], ["DOCUMENTED_BUT_UNUSED"], []);
    expect(result.unusedInExample).toEqual(["DOCUMENTED_BUT_UNUSED"]);
    expect(result.missingFromExample).toEqual([]);
  });

  it("reports no drift when used and documented keys match exactly", () => {
    const result = computeEnvDrift(["FOO", "BAR"], ["BAR", "FOO"], []);
    expect(result.missingFromExample).toEqual([]);
    expect(result.unusedInExample).toEqual([]);
  });

  it("excludes allowlisted keys from both directions", () => {
    const result = computeEnvDrift(
      ["NODE_ENV", "REAL_MISSING"],
      ["ALLOWED_UNUSED"],
      ["NODE_ENV", "ALLOWED_UNUSED"],
    );
    expect(result.missingFromExample).toEqual(["REAL_MISSING"]);
    expect(result.unusedInExample).toEqual([]);
  });

  it("sorts output alphabetically for stable, readable diffs", () => {
    const result = computeEnvDrift(["ZED", "ALPHA", "MID"], [], []);
    expect(result.missingFromExample).toEqual(["ALPHA", "MID", "ZED"]);
  });
});
