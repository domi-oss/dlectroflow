import { describe, it, expect } from "vitest";
import {
  resolveBackTarget,
  withFrom,
  DEFAULT_BACK_TARGET,
  BACK_TARGETS,
} from "./back";

describe("resolveBackTarget", () => {
  it("falls back to the inbox when `from` is absent", () => {
    expect(resolveBackTarget(undefined)).toEqual(DEFAULT_BACK_TARGET);
    expect(resolveBackTarget(null)).toEqual(DEFAULT_BACK_TARGET);
    expect(resolveBackTarget("")).toEqual(DEFAULT_BACK_TARGET);
    expect(DEFAULT_BACK_TARGET.href).toBe("/inbox");
  });

  it("resolves a whitelisted origin to its destination href", () => {
    expect(resolveBackTarget("library")).toEqual({ href: "/library?tab=sorted" });
    expect(resolveBackTarget("settings")).toEqual(BACK_TARGETS.settings);
    expect(resolveBackTarget("help")).toEqual(BACK_TARGETS.help);
  });

  it("falls back to the inbox for an unknown value (no open redirect)", () => {
    expect(resolveBackTarget("https://evil.example.com")).toEqual(DEFAULT_BACK_TARGET);
    expect(resolveBackTarget("/etc/passwd")).toEqual(DEFAULT_BACK_TARGET);
  });

  it("falls back to the inbox for inherited Object.prototype keys (no crash)", () => {
    expect(resolveBackTarget("__proto__")).toEqual(DEFAULT_BACK_TARGET);
    expect(resolveBackTarget("constructor")).toEqual(DEFAULT_BACK_TARGET);
    expect(resolveBackTarget("toString")).toEqual(DEFAULT_BACK_TARGET);
  });
});

describe("withFrom", () => {
  it("appends a whitelisted origin, choosing ? or & correctly", () => {
    expect(withFrom("/tasks/t1", "library")).toBe("/tasks/t1?from=library");
    expect(withFrom("/tasks/t1?edit=1", "library")).toBe("/tasks/t1?edit=1&from=library");
  });

  it("drops unknown/absent/hostile origins rather than reflecting them", () => {
    expect(withFrom("/tasks/t1", undefined)).toBe("/tasks/t1");
    expect(withFrom("/tasks/t1", "")).toBe("/tasks/t1");
    expect(withFrom("/tasks/t1", "__proto__")).toBe("/tasks/t1");
    expect(withFrom("/tasks/t1", "https://evil.example.com")).toBe("/tasks/t1");
  });
});
