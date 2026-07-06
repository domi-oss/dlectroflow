import { describe, it, expect } from "vitest";
import { isPublicPath, isOwnerOnlyPath } from "./gate";

describe("gate paths", () => {
  it("health is public", () => {
    expect(isPublicPath("/api/health")).toBe(true);
  });
  it("login + auth routes are public", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/auth/gitlab/callback")).toBe(true);
  });
  it("app root is not public", () => {
    expect(isPublicPath("/inbox")).toBe(false);
  });
  it("does not treat lookalike paths as public", () => {
    expect(isPublicPath("/loginhack")).toBe(false);
    expect(isPublicPath("/api/health-evil")).toBe(false);
  });
  it("still matches exact + subpaths of public prefixes", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/health")).toBe(true);
    expect(isPublicPath("/api/auth/gitlab/start")).toBe(true);
  });
  it("integration oauth is owner-only", () => {
    expect(isOwnerOnlyPath("/api/google/oauth/start")).toBe(true);
    expect(isOwnerOnlyPath("/api/reclaim/oauth/callback")).toBe(true);
  });
  it("inbox is not owner-only", () => {
    expect(isOwnerOnlyPath("/inbox")).toBe(false);
  });
});
