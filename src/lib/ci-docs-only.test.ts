import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  DOCS_ONLY_PATHS,
  parseCodeChangeGlobs,
  globCoversTopLevel,
  classifyTopLevelPath,
} from "./ci-docs-only";

const REPO_ROOT = join(__dirname, "..", "..");

const codeGlobs = parseCodeChangeGlobs(
  readFileSync(join(REPO_ROOT, ".gitlab-ci.yml"), "utf8"),
);

/**
 * Committed top-level entries only. `git ls-tree` rather than `readdirSync` so
 * the set is identical locally and in CI — an untracked `node_modules/`, `.env`
 * or editor droppings must not influence a CI invariant.
 */
function committedTopLevelPaths(): string[] {
  const out = execFileSync("git", ["ls-tree", "--name-only", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

describe("parseCodeChangeGlobs", () => {
  it("reads the quoted items of the .code_changes block", () => {
    const yml = [
      "some_key: value",
      ".code_changes: &code_changes",
      "  # a comment inside the block",
      '  - "src/**/*"',
      '  - "*.ts"',
      "",
      ".next_key: &other",
      '  - "not-part-of-it"',
    ].join("\n");
    expect(parseCodeChangeGlobs(yml)).toEqual(["src/**/*", "*.ts"]);
  });

  it("throws if the anchor is missing, rather than silently passing", () => {
    expect(() => parseCodeChangeGlobs("workflow:\n  rules: []\n")).toThrow(
      /\.code_changes/,
    );
  });

  it("throws if the anchor is present but empty", () => {
    expect(() =>
      parseCodeChangeGlobs(".code_changes: &code_changes\nother_key: x\n"),
    ).toThrow(/empty/);
  });
});

describe("globCoversTopLevel", () => {
  it("covers a directory entry via its recursive glob", () => {
    expect(globCoversTopLevel("src/**/*", "src")).toBe(true);
    expect(globCoversTopLevel("src/**/*", "srcs")).toBe(false);
  });

  it("matches root-level extension globs without crossing directories", () => {
    expect(globCoversTopLevel("*.ts", "next.config.ts")).toBe(true);
    expect(globCoversTopLevel("*.ts", "src/index.ts")).toBe(false);
  });

  it("matches a trailing-wildcard name", () => {
    expect(globCoversTopLevel("Dockerfile*", "Dockerfile")).toBe(true);
    expect(globCoversTopLevel("Dockerfile*", "Dockerfile.ci")).toBe(true);
    expect(globCoversTopLevel("Dockerfile*", "my.Dockerfile")).toBe(false);
  });

  it("matches a literal dotfile and does not treat the dot as a wildcard", () => {
    expect(globCoversTopLevel(".nvmrc", ".nvmrc")).toBe(true);
    expect(globCoversTopLevel(".nvmrc", "xnvmrc")).toBe(false);
  });

  it("does not let a bare * glob swallow dotfiles the way the shell would", () => {
    expect(globCoversTopLevel("*.yml", "docker-compose.yml")).toBe(true);
    // `.gitlab-ci.yml` IS matched by *.yml here, which is what GitLab does for
    // an explicit extension glob — the guard below is what keeps that honest.
    expect(globCoversTopLevel("*.yml", ".gitlab-ci.yml")).toBe(true);
  });
});

describe("docs-only CI fast path covers every committed top-level path", () => {
  const paths = committedTopLevelPaths();

  it("finds a plausible repo root (sanity check on the git call)", () => {
    expect(paths).toContain("package.json");
    expect(paths).toContain("src");
    expect(paths.length).toBeGreaterThan(10);
  });

  it("classifies every top-level entry as either code or docs", () => {
    const unclassified = paths.filter(
      (p) => classifyTopLevelPath(p, codeGlobs) === "unclassified",
    );
    expect(
      unclassified,
      `These top-level paths are matched by neither .code_changes in .gitlab-ci.yml nor DOCS_ONLY_PATHS, so a merge request touching only them would SKIP the entire test/build/scan gate. Add each one to .code_changes (it can affect the app) or to DOCS_ONLY_PATHS (it cannot): ${unclassified.join(", ")}`,
    ).toEqual([]);
  });

  it("never classifies a path as both code and docs", () => {
    const both = DOCS_ONLY_PATHS.filter((p) =>
      codeGlobs.some((g) => globCoversTopLevel(g, p)),
    );
    expect(
      both,
      `Listed as documentation but also matched by .code_changes, so the fast path can never trigger for it: ${both.join(", ")}`,
    ).toEqual([]);
  });

  it("treats the things that must never be fast-pathed as code", () => {
    for (const critical of [
      "src",
      "e2e",
      "prisma",
      "charts",
      "package.json",
      "package-lock.json",
      "Dockerfile",
      "Dockerfile.ci",
      ".gitlab-ci.yml",
      ".env.example",
    ]) {
      expect(
        classifyTopLevelPath(critical, codeGlobs),
        `${critical} must trigger the full gate`,
      ).toBe("code");
    }
  });

  it("treats documentation as documentation", () => {
    for (const doc of ["README.md", "CHANGELOG.md", "docs"]) {
      expect(classifyTopLevelPath(doc, codeGlobs)).toBe("docs");
    }
  });
});
