import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  IGNORED_FOR_VULNERABILITY_ALERTS,
  ignoredKeysUnderVulnerabilityAlerts,
  type RenovateConfigShape,
} from "./renovate-hygiene";

describe("ignoredKeysUnderVulnerabilityAlerts", () => {
  it("reports nothing for a block that only sets labels", () => {
    expect(
      ignoredKeysUnderVulnerabilityAlerts({
        labels: ["dependencies", "security"],
      }),
    ).toEqual([]);
  });

  it("reports nothing for an absent block", () => {
    expect(ignoredKeysUnderVulnerabilityAlerts(undefined)).toEqual([]);
  });

  // The exact key #243 proposed adding, and the reason this module exists.
  it("reports prConcurrentLimit", () => {
    expect(
      ignoredKeysUnderVulnerabilityAlerts({ prConcurrentLimit: 0 }),
    ).toEqual(["prConcurrentLimit"]);
  });

  it("reports a limit key even when its value would mean unlimited", () => {
    // `0` really does mean "no limit" for prConcurrentLimit — that is not the
    // problem. The problem is that the key is never consulted here at all, so
    // both `0` and `5` are equally inert and equally misleading to a reader.
    expect(
      ignoredKeysUnderVulnerabilityAlerts({ prConcurrentLimit: 5 }),
    ).toEqual(["prConcurrentLimit"]);
  });

  it("reports every documented key, in the documented order", () => {
    const block = Object.fromEntries(
      IGNORED_FOR_VULNERABILITY_ALERTS.map((key) => [key, 0]),
    );
    expect(ignoredKeysUnderVulnerabilityAlerts(block)).toEqual([
      ...IGNORED_FOR_VULNERABILITY_ALERTS,
    ]);
  });

  it("leaves keys Renovate does honour alone", () => {
    expect(
      ignoredKeysUnderVulnerabilityAlerts({
        labels: ["security"],
        automerge: true,
        vulnerabilityFixStrategy: "highest",
        enabled: true,
      }),
    ).toEqual([]);
  });

  // The `in` operator throws a TypeError on a primitive, and this reads a JSON
  // file nothing has shape-validated by the time it is called.
  it("reports nothing for a block that is not an object", () => {
    for (const block of ["a string", 7, null, ["x"], true]) {
      expect(
        ignoredKeysUnderVulnerabilityAlerts(
          block as unknown as Record<string, unknown>,
        ),
      ).toEqual([]);
    }
  });
});

/**
 * #243 regression guard, against the real config.
 *
 * The issue proposed `"vulnerabilityAlerts": { "prConcurrentLimit": 0 }` as a
 * one-line fix for "a security MR is queued behind routine digest bumps". That
 * property already holds unconditionally, so the key would have been a no-op that
 * reads like a control — and the next person to touch the concurrency cap would
 * have believed removing it reopened a risk that never existed.
 */
describe("renovate.json's vulnerabilityAlerts block (#243)", () => {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), ".gitlab", "renovate.json"), "utf8"),
  ) as RenovateConfigShape;

  it("carries no key Renovate ignores for vulnerability-fix PRs", () => {
    expect(
      ignoredKeysUnderVulnerabilityAlerts(config.vulnerabilityAlerts),
      "Renovate always creates security PRs, even if the concurrent PR limit " +
        "is already reached — so a limit or schedule set here is never read. " +
        "Adding one back would restate a guarantee as if it were a setting " +
        "(#243).",
    ).toEqual([]);
  });
});
