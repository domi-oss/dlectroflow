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
  // #123 — the published Privacy Policy and Terms of Service.
  //
  // These MUST be public. Google's OAuth verification reviewers fetch both URLs
  // with no session at all; the middleware redirects anything unmatched to
  // /login, so leaving them out means the reviewer sees a sign-in wall and
  // verification fails with nothing in the app looking broken.
  it("the legal pages are public (#123)", () => {
    expect(isPublicPath("/privacy")).toBe(true);
    expect(isPublicPath("/terms")).toBe(true);
  });
  it("does not treat lookalike legal paths as public (#123)", () => {
    // The match is exact-or-`prefix + "/"`, so a hostile sibling route must not
    // inherit the exemption.
    expect(isPublicPath("/privacyhack")).toBe(false);
    expect(isPublicPath("/terms-and-conditions-evil")).toBe(false);
  });
  // #154 — the per-user calendar subscription feed.
  //
  // This one MUST be public for a structural reason rather than a legal one: a
  // calendar client fetching a subscription has no cookie to send and no way to
  // sign in, so the capability token in the path is the entire authorization.
  // Anything not matched here is redirected to /login by src/proxy.ts, which a
  // calendar app reads as a broken feed — silently, in everybody's calendar.
  it("the calendar subscription feed is public (#154)", () => {
    expect(isPublicPath("/api/ics/feed/" + "T".repeat(43))).toBe(true);
    expect(isPublicPath("/api/ics/feed")).toBe(true);
  });

  it("does not open the rest of the ICS surface with it (#154)", () => {
    // The per-task download is session-scoped and must stay that way: it takes a
    // task id, which is guessable in a way a 256-bit token is not.
    expect(isPublicPath("/api/ics/some-task-id")).toBe(false);
    expect(isPublicPath("/api/ics")).toBe(false);
    // Exact-or-`prefix + "/"` matching, so a hostile sibling cannot inherit it.
    expect(isPublicPath("/api/ics/feedhack")).toBe(false);
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
