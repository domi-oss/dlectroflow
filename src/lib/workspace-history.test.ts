import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #111 — "has this workspace EVER held anything?" is the question that separates
// a NEW account from an EMPTIED one, so these tests are mostly about the tables
// that are consulted, not just the boolean that comes out. `prisma` is mocked
// (the same pattern as rewards.test.ts / people.test.ts) so the query SHAPE is
// asserted too: every call has to be workspace-scoped, and every call has to be
// id-only — this is a "does a row exist" question and must never pull a row's
// content, least of all a brain-dump item's text.
const db = vi.hoisted(() => ({
  brainDumpItem: { findFirst: vi.fn() },
  task: { findFirst: vi.fn() },
  rewardEvent: { findFirst: vi.fn() },
  badge: { findFirst: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));

import {
  emptyInboxIsNewAccount,
  workspaceHasHistory,
} from "./workspace-history";

const WS = "ws-1";

/** Every probe answers "no row" unless a test says otherwise. */
function nothingAnywhere() {
  db.brainDumpItem.findFirst.mockResolvedValue(null);
  db.task.findFirst.mockResolvedValue(null);
  db.rewardEvent.findFirst.mockResolvedValue(null);
  db.badge.findFirst.mockResolvedValue(null);
}

beforeEach(() => {
  vi.clearAllMocks();
  nothingAnywhere();
});

describe("workspaceHasHistory", () => {
  it("a workspace with nothing in any table has no history", async () => {
    expect(await workspaceHasHistory(WS)).toBe(false);
  });

  // The four probes, one per test, because each is here for a DIFFERENT reason
  // and a single "any of them" test would let three of them be deleted silently.

  // Captures of every status, including archived and completed ones, which the
  // inbox page's own query filters out — an account that completed everything
  // still HAS everything, so it is emptied, not new.
  it("an archived or completed capture counts as history", async () => {
    db.brainDumpItem.findFirst.mockResolvedValue({ id: "i-1" });
    expect(await workspaceHasHistory(WS)).toBe(true);
  });

  // A Task can outlive the capture it came from: BrainDumpItem.taskId is
  // onDelete: SetNull, so an orphaned task is still a thing this account made.
  it("a task counts as history", async () => {
    db.task.findFirst.mockResolvedValue({ id: "t-1" });
    expect(await workspaceHasHistory(WS)).toBe(true);
  });

  // THE case content-counting alone gets wrong. Captures are hard-deleted, so
  // "captured three things and deleted them all" leaves no BrainDumpItem row —
  // but deleting the last one runs maybeAwardInboxZero(), which writes a reward
  // event. That trace is what stops an emptied account being called new.
  it("a reward event counts as history even with no content left", async () => {
    db.rewardEvent.findFirst.mockResolvedValue({ id: "r-1" });
    expect(await workspaceHasHistory(WS)).toBe(true);
  });

  // Badges are awarded once ever and never deleted — the longest-lived trace.
  it("a badge counts as history even with no content left", async () => {
    db.badge.findFirst.mockResolvedValue({ id: "b-1" });
    expect(await workspaceHasHistory(WS)).toBe(true);
  });

  it("scopes every probe to the workspace (the scoping invariant)", async () => {
    await workspaceHasHistory(WS);
    for (const model of [db.brainDumpItem, db.task, db.rewardEvent, db.badge]) {
      expect(model.findFirst).toHaveBeenCalledTimes(1);
      expect(model.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: WS } }),
      );
    }
  });

  it("selects ids only — never a row's content", async () => {
    await workspaceHasHistory(WS);
    for (const model of [db.brainDumpItem, db.task, db.rewardEvent, db.badge]) {
      expect(model.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ select: { id: true } }),
      );
    }
  });
});

// !215 review — the failure path, which is a decision and not a detail. A probe
// that never answered is not evidence that there is nothing to find, and the
// docstring's own rule is that the generous error is the worse one: telling
// someone who really does have data that their account is "new" is the data-loss
// ambiguity this whole change exists to remove.
describe("workspaceHasHistory — when a probe fails", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("answers 'has history' rather than throwing, when one probe rejects", async () => {
    db.rewardEvent.findFirst.mockRejectedValue(new Error("connection reset"));
    await expect(workspaceHasHistory(WS)).resolves.toBe(true);
  });

  // A transient failure must degrade to the OLD copy, never to a crashed inbox:
  // this probe is the only database work the page does that it can survive
  // without, so it must not become a new way for the inbox to 500.
  it("never rejects, even when every probe fails", async () => {
    const boom = () => Promise.reject(new Error("db down"));
    db.brainDumpItem.findFirst.mockImplementation(boom);
    db.task.findFirst.mockImplementation(boom);
    db.rewardEvent.findFirst.mockImplementation(boom);
    db.badge.findFirst.mockImplementation(boom);
    await expect(workspaceHasHistory(WS)).resolves.toBe(true);
  });

  // Degrading quietly is not the same as degrading silently — a probe that keeps
  // failing is a real fault and has to be visible in the logs.
  it("warns about the failure instead of swallowing it", async () => {
    const err = new Error("connection reset");
    db.badge.findFirst.mockRejectedValue(err);
    await workspaceHasHistory(WS);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[workspace-history]"),
      err,
    );
  });

  it("still answers from the probes that DID resolve", async () => {
    db.task.findFirst.mockRejectedValue(new Error("connection reset"));
    db.brainDumpItem.findFirst.mockResolvedValue({ id: "i-1" });
    await expect(workspaceHasHistory(WS)).resolves.toBe(true);
  });
});

describe("emptyInboxIsNewAccount", () => {
  it("no visible items and no history → new account", () => {
    expect(
      emptyInboxIsNewAccount({
        visibleItems: 0,
        hasHistory: false,
        firstRunPreview: false,
      }),
    ).toBe(true);
  });

  // The distinction #111 is about: an account that had tasks and completed them
  // all is NOT new, and keeps "Inbox zero. Nothing to review."
  it("no visible items but history → emptied, not new", () => {
    expect(
      emptyInboxIsNewAccount({
        visibleItems: 0,
        hasHistory: true,
        firstRunPreview: false,
      }),
    ).toBe(false);
  });

  it("visible items → not an empty state at all", () => {
    expect(
      emptyInboxIsNewAccount({
        visibleItems: 3,
        hasHistory: false,
        firstRunPreview: false,
      }),
    ).toBe(false);
  });

  // Settings' first-run preview (#8) exists to show the inbox "as a brand-new
  // workspace would see it" — with the real workspace's rows still in the
  // database. It has to win over both other inputs or the preview would show
  // the one empty state a brand-new workspace can never see.
  it("the first-run preview always reads as new, whatever the real data says", () => {
    expect(
      emptyInboxIsNewAccount({
        visibleItems: 7,
        hasHistory: true,
        firstRunPreview: true,
      }),
    ).toBe(true);
  });
});
