// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { UserRole } from "@/lib/constants";
import type { AccountIdentity } from "@/lib/identity";

/**
 * #111 — the Inbox page's server-side half of "new account, not emptied".
 *
 * The copy itself is inbox-view.test.tsx's job and the new-vs-emptied rule is
 * workspace-history.test.ts's. What only the PAGE can get wrong is the wiring:
 * who is allowed to see the state at all, and — because the probe is four extra
 * round trips — whether it is asked on requests where its answer cannot matter.
 * Both are asserted here.
 */

const settingsFixture = {
  agingThresholdMinutes: 45,
  demoOverrideSeconds: null,
  agingHours: 24,
  overdueHours: 48,
  wayOverdueHours: 72,
  firstRunPreview: false,
  notifyAging: false,
  welcomeDismissedAt: new Date("2026-01-01T00:00:00Z"),
};

const OWNER = {
  id: "cowner1234567",
  handle: "ada",
  provider: "gitlab",
  role: UserRole.Owner,
  workspaceId: "ws-test",
};

const { db, currentUserMock, hasHistoryMock, settingsOverride } = vi.hoisted(
  () => ({
    db: { brainDumpItem: { findMany: vi.fn() } },
    currentUserMock: vi.fn(),
    hasHistoryMock: vi.fn(),
    settingsOverride: vi.fn(),
  }),
);

vi.mock("@/lib/db", () => ({
  prisma: db,
  getSettings: vi.fn(async () => settingsOverride()),
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: vi.fn().mockResolvedValue("ws-test"),
  currentUser: () => currentUserMock(),
}));
vi.mock("@/lib/google", () => ({
  getGoogleStatus: vi.fn().mockResolvedValue({
    configured: false,
    connected: false,
    needsReconnect: false,
  }),
}));
vi.mock("@/lib/workspace-history", async (importOriginal) => {
  // The pure decision keeps its REAL implementation — this test is about the
  // page's use of it, not a second copy of its rules — while the four-table
  // probe becomes observable.
  const actual =
    await importOriginal<typeof import("@/lib/workspace-history")>();
  return { ...actual, workspaceHasHistory: hasHistoryMock };
});

// The whole inbox reduced to the one prop this page decides. Typed with the
// REAL `AccountIdentity` rather than the two fields this stub happens to read
// (!215 review): structural typing would accept a narrower annotation, but it
// would quietly stop describing the prop contract the moment the identity gains
// or loses a field, which is exactly the drift identity.test.ts guards against.
vi.mock("@/components/inbox/inbox-view", () => ({
  InboxView: ({
    newAccount,
    initialItems,
  }: {
    newAccount?: AccountIdentity | null;
    // #44 — the mapped rows, so the page's own row mapper is observable. The
    // rendering is inbox-view.test.tsx's job; what only the PAGE can get wrong
    // is dropping a column on the way into the DTO, and that is invisible to
    // every component test.
    initialItems?: { id: string; notes?: string | null }[];
  }) => (
    <div
      data-testid="inbox-view"
      data-new-account={
        newAccount ? `${newAccount.label}/${newAccount.provider}` : "null"
      }
      data-notes={JSON.stringify(
        (initialItems ?? []).map((i) => [i.id, i.notes ?? null]),
      )}
    />
  ),
}));

import InboxPage from "./page";

function renderInbox() {
  return InboxPage({ searchParams: Promise.resolve({}) });
}

/** The `newAccount` the page handed <InboxView>, as "label/provider" or "null". */
function newAccountProp(): string | undefined {
  return screen.getByTestId("inbox-view").dataset.newAccount;
}

beforeEach(() => {
  vi.clearAllMocks();
  settingsOverride.mockReturnValue({ ...settingsFixture });
  db.brainDumpItem.findMany.mockResolvedValue([]);
  currentUserMock.mockResolvedValue(OWNER);
  hasHistoryMock.mockResolvedValue(false);
});

afterEach(cleanup);

describe("Inbox page — brand-new account empty state (#111)", () => {
  it("hands <InboxView> the identity when the workspace has never held anything", async () => {
    render(await renderInbox());
    expect(newAccountProp()).toBe("ada/GitLab");
  });

  // The distinction the issue is about. Everything completed, or everything
  // captured and then deleted, is an EMPTIED account and keeps "Inbox zero".
  it("hands null when the empty workspace has history", async () => {
    hasHistoryMock.mockResolvedValue(true);
    render(await renderInbox());
    expect(newAccountProp()).toBe("null");
  });

  // A guest has no account to name and already gets the sandbox banner, so the
  // issue is explicit that their copy is unchanged — and there is nothing to
  // ask the database about.
  it("hands null for a guest, without running the probe", async () => {
    currentUserMock.mockResolvedValue(null);
    render(await renderInbox());
    expect(newAccountProp()).toBe("null");
    expect(hasHistoryMock).not.toHaveBeenCalled();
  });

  // The probe is four round trips. It must not sit on the ordinary request.
  it("does not run the probe when there is anything on screen", async () => {
    db.brainDumpItem.findMany.mockResolvedValue([
      {
        id: "i-1",
        text: "something",
        createdAt: new Date(),
        status: "inbox",
        triagedAt: null,
        remindedAt: null,
        snoozedUntil: null,
        freshenedAt: null,
        promptDismissedAt: null,
        completedAt: null,
        estMinutes: null,
        breakdownRequestedAt: null,
        taskId: null,
        workspaceId: "ws-test",
        task: null,
      },
    ]);
    render(await renderInbox());
    expect(newAccountProp()).toBe("null");
    expect(hasHistoryMock).not.toHaveBeenCalled();
  });

  // Settings' first-run preview (#8) renders the inbox "as a brand-new
  // workspace would see it" — which now includes this state, and answers
  // without touching the database.
  it("the first-run preview shows the state without running the probe", async () => {
    settingsOverride.mockReturnValue({
      ...settingsFixture,
      firstRunPreview: true,
    });
    db.brainDumpItem.findMany.mockResolvedValue([]);
    render(await renderInbox());
    expect(newAccountProp()).toBe("ada/GitLab");
    expect(hasHistoryMock).not.toHaveBeenCalled();
  });

  it("scopes the probe to the resolved workspace", async () => {
    render(await renderInbox());
    expect(hasHistoryMock).toHaveBeenCalledExactlyOnceWith("ws-test");
  });
});

// ── #44 — the task note has to survive the page's row mapper ────────────────
//
// The Library shipped this gap: the component was correct and the surface never
// received the data. A component test cannot see that, and neither can a test
// that only checks what InboxView renders — so this asserts the PROP.
describe("Inbox page — the task note reaches the rows (#44)", () => {
  it("carries Task.notes onto the item the row renders", async () => {
    db.brainDumpItem.findMany.mockResolvedValue([
      {
        id: "i1",
        text: "Renew the passport",
        createdAt: new Date(),
        status: "triaged",
        triagedAt: new Date(),
        remindedAt: null,
        snoozedUntil: null,
        freshenedAt: null,
        promptDismissedAt: null,
        completedAt: null,
        breakdownRequestedAt: null,
        taskId: "t1",
        workspaceId: "ws-test",
        estMinutes: null,
        task: {
          id: "t1",
          status: "active",
          scheduledAt: null,
          scheduleDueAt: null,
          schedulePriority: null,
          scheduleHours: null,
          notes: "photo booth on the high street",
          steps: [],
        },
      },
    ]);
    render(await renderInbox());
    expect(
      JSON.parse(screen.getByTestId("inbox-view").dataset.notes as string),
    ).toEqual([["i1", "photo booth on the high street"]]);
  });

  it("carries null for a row whose task has no note", async () => {
    db.brainDumpItem.findMany.mockResolvedValue([
      {
        id: "i2",
        text: "no note",
        createdAt: new Date(),
        status: "triaged",
        triagedAt: new Date(),
        remindedAt: null,
        snoozedUntil: null,
        freshenedAt: null,
        promptDismissedAt: null,
        completedAt: null,
        breakdownRequestedAt: null,
        taskId: "t2",
        workspaceId: "ws-test",
        estMinutes: null,
        task: {
          id: "t2",
          status: "active",
          scheduledAt: null,
          scheduleDueAt: null,
          schedulePriority: null,
          scheduleHours: null,
          notes: null,
          steps: [],
        },
      },
    ]);
    render(await renderInbox());
    expect(
      JSON.parse(screen.getByTestId("inbox-view").dataset.notes as string),
    ).toEqual([["i2", null]]);
  });
});
