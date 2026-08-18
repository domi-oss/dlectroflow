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
    db: {
      brainDumpItem: { findMany: vi.fn() },
      // #199 — the summary's two reads. Both are only reached when
      // Settings.shoppingList is on, which the assertions below prove.
      shoppingSummary: { findUnique: vi.fn() },
      shoppingItem: { count: vi.fn() },
    },
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
// #211 — `GOOGLE_TIMEOUT_REASON` comes from the REAL module. The OAuth callback
// writes that token into the URL and this page reads it back out; a literal
// copied into the mock would keep passing after the two had stopped agreeing,
// which is the whole failure mode a shared constant exists to prevent.
vi.mock("@/lib/google", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google")>();
  return {
    GOOGLE_TIMEOUT_REASON: actual.GOOGLE_TIMEOUT_REASON,
    getGoogleStatus: vi.fn().mockResolvedValue({
      configured: false,
      connected: false,
      needsReconnect: false,
    }),
  };
});
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
    shoppingSummary,
  }: {
    newAccount?: AccountIdentity | null;
    // #44 — the mapped rows, so the page's own row mapper is observable. The
    // rendering is inbox-view.test.tsx's job; what only the PAGE can get wrong
    // is dropping a column on the way into the DTO, and that is invisible to
    // every component test.
    initialItems?: {
      id: string;
      notes?: string | null;
      itemNotes?: string | null;
    }[];
    /** #199 — the summary line's count, or null for "show nothing". */
    shoppingSummary?: { count: number } | null;
  }) => (
    <div
      data-testid="inbox-view"
      data-new-account={
        newAccount ? `${newAccount.label}/${newAccount.provider}` : "null"
      }
      data-notes={JSON.stringify(
        (initialItems ?? []).map((i) => [i.id, i.notes ?? null]),
      )}
      // #186 — the ITEM's own note column, exposed SEPARATELY. Merging the two
      // here would hide the exact bug this pins: `...item` brings
      // `BrainDumpItem.notes` in as `notes`, which the task's note then
      // overwrites, so one name for two columns made the item's unreachable.
      data-item-notes={JSON.stringify(
        (initialItems ?? []).map((i) => [i.id, i.itemNotes ?? null]),
      )}
      data-shopping-summary={
        shoppingSummary ? String(shoppingSummary.count) : "null"
      }
    />
  ),
}));

import InboxPage from "./page";

function renderInbox(searchParams: { google?: string; reason?: string } = {}) {
  return InboxPage({ searchParams: Promise.resolve(searchParams) });
}

/** The `newAccount` the page handed <InboxView>, as "label/provider" or "null". */
function newAccountProp(): string | undefined {
  return screen.getByTestId("inbox-view").dataset.newAccount;
}

beforeEach(() => {
  vi.clearAllMocks();
  settingsOverride.mockReturnValue({ ...settingsFixture });
  db.brainDumpItem.findMany.mockResolvedValue([]);
  db.shoppingSummary.findUnique.mockResolvedValue(null);
  db.shoppingItem.count.mockResolvedValue(0);
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

  it("carries BOTH note columns, under distinct names (#186)", async () => {
    // The shadowing regression, pinned. `items` spreads `...item` and then sets
    // `notes` from the task — so before #186 named the second one, an item that
    // had its own note handed the row the TASK's value under that name and the
    // item's was silently unreachable. Only the page can get this wrong, and no
    // component test can see it.
    db.brainDumpItem.findMany.mockResolvedValue([
      {
        id: "i3",
        text: "water the plants",
        createdAt: new Date(),
        status: "triaged",
        triagedAt: new Date(),
        remindedAt: null,
        snoozedUntil: null,
        freshenedAt: null,
        promptDismissedAt: null,
        completedAt: null,
        breakdownRequestedAt: null,
        taskId: "t3",
        workspaceId: "ws-test",
        estMinutes: null,
        notes: "stale item copy",
        task: {
          id: "t3",
          status: "active",
          scheduledAt: null,
          scheduleDueAt: null,
          schedulePriority: null,
          scheduleHours: null,
          notes: "live task note",
          steps: [],
        },
      },
    ]);
    render(await renderInbox());
    const view = screen.getByTestId("inbox-view");
    expect(JSON.parse(view.dataset.notes as string)).toEqual([
      ["i3", "live task note"],
    ]);
    expect(JSON.parse(view.dataset.itemNotes as string)).toEqual([
      ["i3", "stale item copy"],
    ]);
  });

  it("carries an untriaged row's own note, where no task note exists", async () => {
    // The grain #179 actually writes at capture. `taskId` null means `liveNote`
    // reads this column, so the page dropping it would make an inline capture
    // look like text that went missing.
    db.brainDumpItem.findMany.mockResolvedValue([
      {
        id: "i4",
        text: "water the plants",
        createdAt: new Date(),
        status: "inbox",
        triagedAt: null,
        remindedAt: null,
        snoozedUntil: null,
        freshenedAt: null,
        promptDismissedAt: null,
        completedAt: null,
        breakdownRequestedAt: null,
        taskId: null,
        workspaceId: "ws-test",
        estMinutes: null,
        notes: "can under sink",
        task: null,
      },
    ]);
    render(await renderInbox());
    const view = screen.getByTestId("inbox-view");
    expect(JSON.parse(view.dataset.itemNotes as string)).toEqual([
      ["i4", "can under sink"],
    ]);
    expect(JSON.parse(view.dataset.notes as string)).toEqual([["i4", null]]);
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

/**
 * #199 — the summary line's server half.
 *
 * The count is the whole point: it is read from the ITEMS on this request, never
 * from the summary row, so no state of the database can make the inbox claim a
 * number the list does not have. That is what the "row outlived the list" case
 * below proves — the row exists, is not dismissed, and the answer is still
 * nothing, because the count is zero.
 */
describe("Inbox page — the shopping-list summary (#199)", () => {
  const summaryProp = () =>
    screen.getByTestId("inbox-view").dataset.shoppingSummary;

  it("asks nothing at all while the feature is off", async () => {
    render(await renderInbox());
    expect(summaryProp()).toBe("null");
    expect(db.shoppingSummary.findUnique).not.toHaveBeenCalled();
    expect(db.shoppingItem.count).not.toHaveBeenCalled();
  });

  it("hands the DERIVED count when a live row meets a non-empty list", async () => {
    settingsOverride.mockReturnValue({
      ...settingsFixture,
      shoppingList: true,
    });
    db.shoppingSummary.findUnique.mockResolvedValue({ clearedAt: null });
    db.shoppingItem.count.mockResolvedValue(3);
    render(await renderInbox());
    expect(summaryProp()).toBe("3");
    // Scoped, and counting only what is still to buy — the same predicate
    // shoppingRemainingCount applies in memory on /shopping.
    expect(db.shoppingItem.count).toHaveBeenCalledWith({
      where: { workspaceId: "ws-test", done: false, savedForLater: false },
    });
    expect(db.shoppingSummary.findUnique).toHaveBeenCalledWith({
      where: { workspaceId: "ws-test" },
    });
  });

  it("hands nothing while the summary is dismissed", async () => {
    settingsOverride.mockReturnValue({
      ...settingsFixture,
      shoppingList: true,
    });
    db.shoppingSummary.findUnique.mockResolvedValue({
      clearedAt: new Date("2026-08-08T09:00:00Z"),
    });
    db.shoppingItem.count.mockResolvedValue(3);
    render(await renderInbox());
    expect(summaryProp()).toBe("null");
  });

  it("hands nothing when the row outlived the list, rather than a wrong count", async () => {
    // The failure mode a stored count would have: a missed sync leaves the row
    // behind. Because the number is derived, the worst outcome available is a
    // hidden line — never "0 items on your shopping list" or a stale 3.
    settingsOverride.mockReturnValue({
      ...settingsFixture,
      shoppingList: true,
    });
    db.shoppingSummary.findUnique.mockResolvedValue({ clearedAt: null });
    db.shoppingItem.count.mockResolvedValue(0);
    render(await renderInbox());
    expect(summaryProp()).toBe("null");
  });

  it("hands nothing in the first-run preview, and asks nothing either", async () => {
    // Duo review, !295 — the two queries used to run and have their result thrown
    // away one branch later. The page already short-circuits `workspaceHasHistory()`
    // on `firstRunPreview` for exactly this reason: the preview shows the inbox as a
    // brand-new workspace would see it, and a brand-new workspace has no shopping
    // list, so the answer cannot change anything.
    settingsOverride.mockReturnValue({
      ...settingsFixture,
      shoppingList: true,
      firstRunPreview: true,
    });
    db.shoppingSummary.findUnique.mockResolvedValue({ clearedAt: null });
    db.shoppingItem.count.mockResolvedValue(3);
    render(await renderInbox());
    expect(summaryProp()).toBe("null");
    expect(db.shoppingSummary.findUnique).not.toHaveBeenCalled();
    expect(db.shoppingItem.count).not.toHaveBeenCalled();
  });
});

/**
 * #211 — the OAuth return banner, and the one case that earns a control.
 *
 * This page is where every `?google=…` redirect lands, and the banner is the
 * only thing the person who clicked Connect ever sees. A timed-out exchange is
 * the one failure here that is worth retrying immediately and that wrote
 * nothing, so it is the one that gets an affordance rather than an instruction
 * to go and find one — every other reason keeps the generic copy, because
 * offering "try again" for a state mismatch or a refused grant sends someone
 * round a loop that cannot succeed.
 */
describe("Google connect banner (#211)", () => {
  const connectLink = () =>
    screen.queryByRole("link", {
      name: /connect/i,
    }) as HTMLAnchorElement | null;

  it("offers a reconnect when the exchange timed out", async () => {
    render(await renderInbox({ google: "error", reason: "timed_out" }));
    const link = connectLink();
    expect(link).not.toBeNull();
    // The same entry point every other connect control uses: it mints a fresh
    // PKCE verifier and state, which is exactly what the timed-out attempt's
    // cleared cookies no longer supply.
    expect(link!.getAttribute("href")).toBe("/api/google/oauth/start");
  });

  it("says what happened in words, not with the reason token", async () => {
    render(await renderInbox({ google: "error", reason: "timed_out" }));
    expect(screen.getByText(/did not answer in time/i)).toBeTruthy();
    // The token is machine-readable plumbing between the route and this page.
    expect(screen.queryByText(/timed_out/)).toBeNull();
  });

  it("says nothing was connected, because nothing was", async () => {
    // Load-bearing rather than reassurance: `exchangeCode` stores tokens only
    // after the response arrives, so a deadline leaves the account exactly as
    // it was. That is what makes pressing the control again safe to suggest.
    render(await renderInbox({ google: "error", reason: "timed_out" }));
    expect(screen.getByText(/nothing was connected/i)).toBeTruthy();
  });

  it("keeps the generic copy — and no control — for any other failure", async () => {
    render(await renderInbox({ google: "error", reason: "state_mismatch" }));
    expect(screen.getByText(/connection failed/i)).toBeTruthy();
    expect(screen.getByText(/state_mismatch/)).toBeTruthy();
    expect(connectLink()).toBeNull();
  });

  it("still congratulates a connection that worked", async () => {
    render(await renderInbox({ google: "connected" }));
    expect(screen.getByText(/Google Tasks connected/i)).toBeTruthy();
    expect(connectLink()).toBeNull();
  });

  it("shows no banner at all on an ordinary visit", async () => {
    render(await renderInbox());
    expect(screen.queryByText(/connection failed/i)).toBeNull();
    expect(screen.queryByText(/did not answer in time/i)).toBeNull();
    expect(connectLink()).toBeNull();
  });
});
