import { describe, it, expect } from "vitest";
import {
  isPublicPath,
  isOwnerOnlyPath,
  isAuthenticatedOnlyPath,
  AUTHENTICATED_PREFIXES,
  OWNER_ONLY_PREFIXES,
} from "./gate";

describe("gate paths", () => {
  it("health is public", () => {
    expect(isPublicPath("/api/health")).toBe(true);
  });
  it("login + auth routes are public", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/auth/gitlab/callback")).toBe(true);
  });
  it("app root is not public", () => {
    expect(isPublicPath("/")).toBe(false);
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
  it("integration oauth is NOT owner-only any more (#118 Phase C)", () => {
    // Google is per-user now: a member connecting their OWN account is the
    // intended behaviour, not a hijack. See AUTHENTICATED_PREFIXES below.
    expect(isOwnerOnlyPath("/api/google/oauth/start")).toBe(false);
  });

  it("owner-only is deliberately empty, not accidentally so", () => {
    // Kept as a named category rather than deleted: Phase D's revoke/purge
    // routes may need it, and at the MIDDLEWARE layer it means exactly what
    // AUTHENTICATED_PREFIXES means ("signed in") — the role half has to live in
    // the handler because the Edge runtime has no Prisma client (src/proxy.ts).
    // #119 is what happens when that handler half is assumed instead of written.
    expect(OWNER_ONLY_PREFIXES).toEqual([]);
  });
  it("the removed Reclaim oauth path is no longer owner-only (#36)", () => {
    expect(isOwnerOnlyPath("/api/reclaim/oauth/callback")).toBe(false);
  });
  it("app root is not owner-only", () => {
    expect(isOwnerOnlyPath("/")).toBe(false);
  });
});

// #35 Phase A — a third category. Before this, gate.ts knew only "public" and
// "owner-only", so anything that was not owner-only was reachable by a guest
// session. Phase C moves /api/google/oauth/ out of owner-only; without this
// category to move it INTO, that would open the OAuth callback to guests.
describe("authenticated-only paths", () => {
  it("classifies an authenticated-only path", () => {
    expect(isAuthenticatedOnlyPath("/api/account/export")).toBe(true);
    expect(isAuthenticatedOnlyPath("/api/health")).toBe(false);
  });

  it("app root is not authenticated-only (guests use the app)", () => {
    expect(isAuthenticatedOnlyPath("/")).toBe(false);
  });

  it("does not treat lookalike paths as authenticated-only", () => {
    expect(isAuthenticatedOnlyPath("/api/accounts-evil")).toBe(false);
    expect(isAuthenticatedOnlyPath("/api/account-evil/export")).toBe(false);
  });

  it("matches subpaths of every declared prefix", () => {
    for (const prefix of AUTHENTICATED_PREFIXES) {
      expect(isAuthenticatedOnlyPath(`${prefix}anything/deeper`)).toBe(true);
    }
  });

  it("integration oauth is authenticated-only — members yes, guests no", () => {
    expect(isAuthenticatedOnlyPath("/api/google/oauth/start")).toBe(true);
    expect(isAuthenticatedOnlyPath("/api/google/oauth/callback")).toBe(true);
  });

  it("declares every prefix with a trailing slash", () => {
    // A prefix without one ("/api/account") would also match
    // "/api/accountant", quietly gating an unrelated future route.
    for (const prefix of AUTHENTICATED_PREFIXES) {
      expect(prefix.endsWith("/")).toBe(true);
    }
  });
});
