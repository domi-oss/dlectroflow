import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SILENTLY_DEGRADING_VALUES,
  helmValue,
  parseHelmValues,
} from "./deploy-values";

const REPO_ROOT = join(__dirname, "..", "..");
const gitlabCiYml = readFileSync(join(REPO_ROOT, ".gitlab-ci.yml"), "utf8");

/** The three quoting shapes `.gitlab-ci.yml` actually uses, in one job. */
const SAMPLE = [
  "deploy_thing:",
  "  script:",
  "    - helm upgrade --install thing charts/thing",
  "        --namespace thing --create-namespace",
  "        --set env=production --set postgres.persistent=true",
  '        --set-string image.tag="main-$CI_COMMIT_SHORT_SHA"',
  '        --set-string "legacyHosts[0]=old.example.com"',
  "        --atomic --timeout 20m",
  "next_job:",
  "  stage: test",
].join("\n");

describe("parseHelmValues", () => {
  it("returns null for a job that is not in the file", () => {
    expect(parseHelmValues(SAMPLE, "nope")).toBeNull();
  });

  it("reads every --set and --set-string in the job, in order", () => {
    expect(parseHelmValues(SAMPLE, "deploy_thing")).toEqual([
      { key: "env", value: "production", stringly: false },
      { key: "postgres.persistent", value: "true", stringly: false },
      {
        key: "image.tag",
        value: "main-$CI_COMMIT_SHORT_SHA",
        stringly: true,
      },
      { key: "legacyHosts[0]", value: "old.example.com", stringly: true },
    ]);
  });

  it("does not mistake a flag that merely follows --set for a value", () => {
    // `--atomic --timeout 20m` trails the real flags in the live file; nothing
    // after the last `=` pair may be swept up as another chart value.
    const keys = parseHelmValues(SAMPLE, "deploy_thing")!.map((v) => v.key);
    expect(keys).not.toContain("--atomic");
    expect(keys).not.toContain("--timeout");
  });

  it("keeps an empty value rather than dropping the flag", () => {
    // `--set-string x=""` is a deliberate "explicitly blank", which is a
    // different statement from not passing the flag at all.
    const yml = [
      "j:",
      "  script:",
      '    - helm upgrade --set-string x=""',
    ].join("\n");
    expect(parseHelmValues(yml, "j")).toEqual([
      { key: "x", value: "", stringly: true },
    ]);
  });

  it("preserves a value containing an = sign", () => {
    const yml = [
      "j:",
      "  script:",
      '    - helm upgrade --set-string url="https://h/?a=b"',
    ].join("\n");
    expect(helmValue(yml, "j", "url")).toBe("https://h/?a=b");
  });

  it("ignores a commented-out flag", () => {
    // The failure this exists for: a guard that reads comments as code reports
    // a value as wired when the line is switched off. `# --set-string a=1`
    // is a YAML comment AND a shell comment, and neither is configuration.
    const yml = [
      "j:",
      "  script:",
      "    # --set-string ghost=yes",
      "    - helm upgrade --install j charts/j",
      "        --set-string real=yes   # --set-string trailing=yes",
    ].join("\n");
    expect(parseHelmValues(yml, "j")).toEqual([
      { key: "real", value: "yes", stringly: true },
    ]);
  });

  it("still strips a commented-out flag that follows an apostrophe", () => {
    // Worth pinning because the two rules interact and the wrong outcome is the
    // dangerous one. `stripShellComments` tracks `'` as a quote character, and
    // prose comments are full of apostrophes — if one opened a quote that
    // swallowed the following `#`, a switched-off flag would read back as live.
    // It does not, because the `#` that starts the apostrophe's own comment is
    // reached first and consumes the rest of that line, apostrophe included.
    // The real deploy_production block has 8 apostrophes across 64 comment
    // lines and strips to zero.
    const yml = [
      "j:",
      "  script:",
      "    # the reader's business",
      "    # --set-string ghost=yes",
      "    - helm upgrade --set-string real=yes",
    ].join("\n");
    expect(parseHelmValues(yml, "j")).toEqual([
      { key: "real", value: "yes", stringly: true },
    ]);
  });

  it("does not read a # inside a quoted value as a comment", () => {
    const yml = [
      "j:",
      "  script:",
      '    - helm upgrade --set-string a="x#y" --set-string b=2',
    ].join("\n");
    expect(helmValue(yml, "j", "a")).toBe("x#y");
    expect(helmValue(yml, "j", "b")).toBe("2");
  });

  it("does not leak values from the next top-level job", () => {
    const yml = [
      "j:",
      "  script:",
      "    - helm upgrade --set-string mine=1",
      "other:",
      "  script:",
      "    - helm upgrade --set-string theirs=1",
    ].join("\n");
    expect(parseHelmValues(yml, "j")!.map((v) => v.key)).toEqual(["mine"]);
  });
});

describe("helmValue", () => {
  it("returns null when the job never passes that chart path", () => {
    expect(helmValue(SAMPLE, "deploy_thing", "focus.catalogOrigin")).toBeNull();
  });

  it("returns the last occurrence, which is the one helm applies", () => {
    const yml = [
      "j:",
      "  script:",
      "    - helm upgrade --set-string a=first --set-string a=second",
    ].join("\n");
    expect(helmValue(yml, "j", "a")).toBe("second");
  });
});

describe("the real .gitlab-ci.yml", () => {
  it("parses deploy_production's helm invocation", () => {
    const values = parseHelmValues(gitlabCiYml, "deploy_production");
    expect(values).not.toBeNull();
    // A sanity floor: this job passes a substantial set of chart values, so a
    // parser returning almost nothing has silently stopped working and would
    // make every assertion below vacuously true.
    expect(values!.length).toBeGreaterThan(10);
  });

  it.each(SILENTLY_DEGRADING_VALUES)(
    "deploy_production passes $key",
    ({ key }) => {
      expect(helmValue(gitlabCiYml, "deploy_production", key)).not.toBeNull();
    },
  );

  it.each(SILENTLY_DEGRADING_VALUES)(
    "$key is wired to a CI variable rather than hardcoded",
    ({ key }) => {
      // Per-deployment configuration, so a literal committed here would be
      // wrong for every other deployment of this chart and would need a code
      // change to correct. The value is a variable reference, never a literal.
      expect(helmValue(gitlabCiYml, "deploy_production", key)).toMatch(
        /^\$\{?[A-Z0-9_]+\}?$/,
      );
    },
  );
});
