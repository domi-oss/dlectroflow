import { describe, it, expect, afterEach } from "vitest";
import { shortBuildSha } from "./build-info";

describe("shortBuildSha", () => {
  it("shortens a full 40-char SHA to git's 7-char form", () => {
    expect(shortBuildSha("cafc16d2f4b8a9e1c3d5069a7b8c9d0e1f2a3b4c")).toBe(
      "cafc16d",
    );
  });

  it("reports the same value for the same commit whichever width was baked in", () => {
    // Instance A bakes $CI_COMMIT_SHA (40 chars); a self-hoster may bake
    // $CI_COMMIT_SHORT_SHA / `git rev-parse --short HEAD` (8 / 7). All three
    // must reduce to one string, or "are both instances on the same commit?"
    // can never be answered by comparing the two /api/health bodies.
    const full = "cafc16d2f4b8a9e1c3d5069a7b8c9d0e1f2a3b4c";
    expect(shortBuildSha(full)).toBe(shortBuildSha(full.slice(0, 8)));
    expect(shortBuildSha(full)).toBe(shortBuildSha(full.slice(0, 7)));
  });

  it("lower-cases an upper-case SHA so the two instances compare equal", () => {
    expect(shortBuildSha("CAFC16D2F4B8A9E1C3D5069A7B8C9D0E1F2A3B4C")).toBe(
      "cafc16d",
    );
  });

  it("trims surrounding whitespace (a `git rev-parse` newline survives --build-arg)", () => {
    expect(shortBuildSha("  cafc16d2f4b8a9e1c3d5069a7b8c9d0e1f2a3b4c\n")).toBe(
      "cafc16d",
    );
  });

  it("returns null when BUILD_SHA was never baked in", () => {
    expect(shortBuildSha(undefined)).toBeNull();
    expect(shortBuildSha("")).toBeNull();
    expect(shortBuildSha("   ")).toBeNull();
  });

  it("returns null rather than echoing a non-hex value", () => {
    // /api/health is unauthenticated, so whatever this returns is reflected to
    // any caller and into whatever scrapes it. Validating keeps a bad build
    // arg from planting arbitrary text there.
    expect(shortBuildSha("not-a-sha")).toBeNull();
    expect(shortBuildSha("<script>alert(1)</script>")).toBeNull();
    expect(shortBuildSha("cafc16d; rm -rf /")).toBeNull();
    expect(shortBuildSha("v0.6.0")).toBeNull();
  });

  it("returns null for a value too short to identify a commit", () => {
    expect(shortBuildSha("cafc16")).toBeNull();
  });

  it("returns null for a value longer than a SHA-1", () => {
    expect(shortBuildSha("c".repeat(41))).toBeNull();
  });

  describe("default argument", () => {
    const original = process.env.BUILD_SHA;
    afterEach(() => {
      if (original === undefined) delete process.env.BUILD_SHA;
      else process.env.BUILD_SHA = original;
    });

    it("reads process.env.BUILD_SHA when called with no argument", () => {
      process.env.BUILD_SHA = "cafc16d2f4b8a9e1c3d5069a7b8c9d0e1f2a3b4c";
      expect(shortBuildSha()).toBe("cafc16d");
    });

    it("is read per call, not captured at module load", () => {
      process.env.BUILD_SHA = "aaaaaaaaaa";
      expect(shortBuildSha()).toBe("aaaaaaa");
      process.env.BUILD_SHA = "bbbbbbbbbb";
      expect(shortBuildSha()).toBe("bbbbbbb");
    });
  });
});
