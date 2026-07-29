// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import TaskPage from "./page";

// Hoisted so the vi.mock factories (which run before imports) can close over them.
const {
  findFirstMock,
  getSettingsMock,
  currentWorkspaceIdMock,
  currentUserMock,
  getGoogleStatusMock,
  pushStepsToGoogleTasksMock,
  scheduleViaIcsMock,
  downloadIcsMock,
  refreshMock,
} = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  getSettingsMock: vi.fn(),
  currentWorkspaceIdMock: vi.fn(),
  currentUserMock: vi.fn(),
  getGoogleStatusMock: vi.fn(),
  pushStepsToGoogleTasksMock: vi.fn(),
  scheduleViaIcsMock: vi.fn(),
  downloadIcsMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock }),
  notFound: () => {
    throw new Error("notFound() called");
  },
}));
vi.mock("@/lib/db", () => ({
  prisma: { task: { findFirst: findFirstMock } },
  getSettings: getSettingsMock,
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  currentUser: currentUserMock,
}));
vi.mock("@/lib/google", () => ({
  getGoogleStatus: getGoogleStatusMock,
}));

// #118 Phase C — identity for this page is one currentUser() read, and the
// Google status is resolved for THAT id.
const OWNER_ID = "user-owner";
const OWNER_USER = {
  id: OWNER_ID,
  role: "owner" as const,
  workspaceId: "owner",
  provider: "gitlab",
  handle: "owner",
};
const MEMBER_ID = "user-member";
const MEMBER_USER = {
  id: MEMBER_ID,
  role: "member" as const,
  workspaceId: "ws-member",
  provider: "gitlab",
  handle: "member",
};
// BreakdownChat (the `editing` branch) pulls in a heavy tree of its own server
// actions (breakdown / anthropic), so it is stubbed like the Library hub test
// stubs the equally heavy <TaskSteps>. The stub RECORDS its props: #118's rule
// is about what crosses into the RSC payload, and a prop is serialised whether
// or not the component renders it — so "the section was hidden" is not the same
// assertion as "the status was never sent".
vi.mock("@/components/breakdown/breakdown-chat", () => ({
  BreakdownChat: (props: Record<string, unknown>) => {
    chatProps = props;
    return <div data-testid="breakdown-chat" />;
  },
}));
vi.mock("@/components/breakdown/task-steps", () => ({
  TaskSteps: ({ taskId }: { taskId: string }) => (
    <div data-testid="task-steps">{taskId}</div>
  ),
}));
// <TaskSchedule> is NOT stubbed — its wiring (owner/guest, scheduled indicator)
// is exactly what Fix 2 needs covered — but its own server-action imports are.
vi.mock("@/app/actions/google-schedule", () => ({
  pushStepsToGoogleTasks: pushStepsToGoogleTasksMock,
}));
vi.mock("@/app/actions/ics-schedule", () => ({
  scheduleViaIcs: scheduleViaIcsMock,
}));
vi.mock("@/lib/download-ics", () => ({
  downloadIcs: downloadIcsMock,
}));

const step = (order: number, overrides: Partial<{ done: boolean }> = {}) => ({
  id: `s${order}`,
  order,
  total: 2,
  text: `step ${order}`,
  subtaskEmoji: null,
  estMinutes: 10,
  done: overrides.done ?? false,
  focusSessions: [] as { id: string }[],
});

function task(overrides: Partial<{ scheduledAt: Date | null }> = {}) {
  return {
    id: "t1",
    title: "Plan the offsite",
    parentEmoji: null,
    scheduledAt: overrides.scheduledAt ?? null,
    steps: [step(1), step(2)],
  };
}

/** The last props <BreakdownChat> was handed — see the stub above. */
let chatProps: Record<string, unknown> | null = null;

const renderPage = async (
  opts: { from?: string; taskId?: string; edit?: string } = {},
) =>
  render(
    await TaskPage({
      params: Promise.resolve({ taskId: opts.taskId ?? "t1" }),
      searchParams: Promise.resolve({
        ...(opts.from ? { from: opts.from } : {}),
        ...(opts.edit ? { edit: opts.edit } : {}),
      }),
    }),
  );

beforeEach(() => {
  chatProps = null;
  findFirstMock.mockResolvedValue(task());
  getSettingsMock.mockResolvedValue({ voice: "plain" });
  currentWorkspaceIdMock.mockResolvedValue("owner");
  // #118 Phase C — the page reads currentUser() rather than isOwnerRequest():
  // it needs the acting account's id to resolve THEIR OWN Google status.
  currentUserMock.mockResolvedValue(OWNER_USER);
  getGoogleStatusMock.mockResolvedValue({
    configured: true,
    connected: true,
    needsReconnect: false,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TaskPage — back link (#8 follow-up, Fix 1)", () => {
  it("defaults the '← Back' link → / when `from` is absent", async () => {
    await renderPage();
    const link = screen.getByRole("link", { name: /back/i });
    expect(link).toHaveTextContent("← Back");
    expect(link).toHaveAttribute("href", "/");
  });

  it("`?from=library` sends the '← Back' link → /library?tab=sorted", async () => {
    await renderPage({ from: "library" });
    const link = screen.getByRole("link", { name: /back/i });
    // Label is a simple "← Back"; only the destination reflects the origin.
    expect(link).toHaveTextContent("← Back");
    expect(link).toHaveAttribute("href", "/library?tab=sorted");
  });

  it("an unknown `from` value falls back to / rather than reflecting it into a path (no open redirect)", async () => {
    await renderPage({ from: "https://evil.example.com" });
    const link = screen.getByRole("link", { name: /back/i });
    expect(link).toHaveAttribute("href", "/");
  });

  it("`?from=__proto__` (an inherited Object.prototype key, not an own key of BACK_TARGETS) falls back to / instead of crashing", async () => {
    await renderPage({ from: "__proto__" });
    const link = screen.getByRole("link", { name: /back/i });
    expect(link).toHaveAttribute("href", "/");
  });

  it("keeps the simple '← Back' label in playful voice (destination still /)", async () => {
    getSettingsMock.mockResolvedValue({ voice: "playful" });
    await renderPage();
    const link = screen.getByRole("link", { name: /back/i });
    expect(link).toHaveTextContent("← Back");
    expect(link).toHaveAttribute("href", "/");
  });
});

describe("TaskPage — Refine breakdown / Schedule split (#8 follow-up, Fix 2)", () => {
  it("keeps a separate 'Refine breakdown' link to the breakdown editor", async () => {
    await renderPage();
    const link = screen.getByRole("link", { name: /refine breakdown/i });
    expect(link).toHaveAttribute("href", "/tasks/t1?edit=1");
    // The old merged wording is gone.
    expect(screen.queryByText(/refine breakdown \/ schedule/i)).toBeNull();
  });

  // #106 — the page resolves the Schedule menu's prefill server-side, so 📅 opens
  // the menu and the push carries what the owner chose. The whole path in one
  // test: page → loadScheduleIntent → ScheduleControl → ScheduleMenu → action.
  it("renders a SEPARATE Schedule control whose 📅 opens the prefilled Schedule menu (owner + Google connected)", async () => {
    pushStepsToGoogleTasksMock.mockResolvedValue({
      ok: true,
      scheduled: 2,
      listTitle: "Reclaim",
    });
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    const dialog = screen.getByRole("dialog", { name: /plan the offsite/i });
    expect(pushStepsToGoogleTasksMock).not.toHaveBeenCalled();
    // Prefilled from the task's own (unset) columns, i.e. the shared defaults.
    expect(within(dialog).getByLabelText(/priority/i)).toHaveValue("high");

    fireEvent.click(
      within(dialog).getByRole("button", { name: /^schedule$/i }),
    );
    await waitFor(() =>
      expect(pushStepsToGoogleTasksMock).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({ priority: "high", hours: "work" }),
      ),
    );
  });

  it("guest workspaces get the ICS 'Add to calendar' control, never a live Google one", async () => {
    currentUserMock.mockResolvedValue(null);
    await renderPage();
    expect(
      screen.getByRole("button", { name: /add to calendar/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^schedule$/i })).toBeNull();
  });

  it("owner without a finished Google connection gets Connect Google, not a live 📅", async () => {
    getGoogleStatusMock.mockResolvedValue({
      configured: false,
      connected: false,
      needsReconnect: false,
    });
    await renderPage();
    expect(
      screen.getByRole("link", { name: /connect google/i }),
    ).toBeInTheDocument();
  });
});

describe("TaskPage — scheduled indicator (driven by task.scheduledAt, Fix 2)", () => {
  it("shows 'Not scheduled yet' when scheduledAt is null", async () => {
    await renderPage();
    expect(screen.getByText("Not scheduled yet")).toBeInTheDocument();
  });

  it("shows 'Scheduled ✓' when scheduledAt is set", async () => {
    findFirstMock.mockResolvedValue(task({ scheduledAt: new Date() }));
    await renderPage();
    expect(screen.getByText("Scheduled ✓")).toBeInTheDocument();
  });
});

describe("TaskPage — top redesign (!83): breadcrumb + distinct header + refine/schedule row order", () => {
  it("renders a 'Task' eyebrow inside the distinct header block", async () => {
    await renderPage();
    expect(screen.getByText("Task")).toBeInTheDocument();
  });

  it("orders the page top-to-bottom: back breadcrumb → header (title + meta) → refine/schedule row → step list", async () => {
    await renderPage();
    const back = screen.getByRole("link", { name: /back/i });
    const heading = screen.getByRole("heading", { name: /plan the offsite/i });
    const refine = screen.getByRole("link", { name: /refine breakdown/i });
    const steps = screen.getByTestId("task-steps");

    // a precedes b in document order.
    const precedes = (a: Element, b: Element) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

    expect(precedes(back, heading)).toBe(true);
    expect(precedes(heading, refine)).toBe(true);
    expect(precedes(refine, steps)).toBe(true);
  });

  it("the back breadcrumb is the first link on the page — no more isolated bottom instance", async () => {
    const { container } = await renderPage();
    const links = container.querySelectorAll("a");
    expect(links[0]).toHaveTextContent(/^← Back$/);
  });
});

describe("TaskPage — workspace scoping", () => {
  it("only ever reads the task for the current workspace", async () => {
    currentWorkspaceIdMock.mockResolvedValue("guest-42");
    await renderPage();
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "t1", workspaceId: "guest-42" }),
      }),
    );
  });
});

// ── #118 Phase C — the acting account's own status ─────────────────────────
//
// Two bugs, one fix. `owner ? googleStatus : null` is what made a member's 📅
// fall back to .ics even with their own Google account connected. And the
// editing branch passed the RAW, unfiltered status into <BreakdownChat> as a
// NON-NULLABLE prop while gating the section on a separate isGuest flag, so
// configured/connected/needsReconnect were serialised into the RSC payload for
// exactly the people the section was hidden from — the opposite of the rule
// integrations-panel.test.tsx already asserts.
describe("TaskPage — per-user Google status (#118)", () => {
  it("gives a MEMBER their own Google status, not a null fallback", async () => {
    currentUserMock.mockResolvedValue(MEMBER_USER);
    await renderPage();
    // Before #118 a member got `google = null` here and the .ics control with
    // it, which silently hid the feature this whole phase exists to ship.
    expect(
      screen.getByRole("button", { name: /^schedule$/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /add to calendar/i }),
    ).toBeNull();
  });

  it("resolves the status for the member's OWN id, never another account's", async () => {
    currentUserMock.mockResolvedValue(MEMBER_USER);
    await renderPage();
    expect(getGoogleStatusMock).toHaveBeenCalledWith(MEMBER_ID);
    expect(getGoogleStatusMock).not.toHaveBeenCalledWith(OWNER_ID);
  });

  it("asks for no status at all when nobody is signed in", async () => {
    currentUserMock.mockResolvedValue(null);
    await renderPage();
    // null, not an id: getGoogleStatus short-circuits before any query, so a
    // guest page load no longer materialises a credential row either.
    expect(getGoogleStatusMock).toHaveBeenCalledWith(null);
  });

  it("never puts a connection status in a GUEST's payload", async () => {
    currentUserMock.mockResolvedValue(null);
    await renderPage({ edit: "1" });
    // The prop must be null, not merely unrendered: a non-nullable prop is
    // serialised into the RSC payload whether or not the section renders it.
    expect(chatProps).not.toBeNull();
    expect(chatProps!.google).toBeNull();
    expect(chatProps).not.toHaveProperty("isGuest");
  });

  it("hands a MEMBER their own status in the editing branch", async () => {
    currentUserMock.mockResolvedValue(MEMBER_USER);
    await renderPage({ edit: "1" });
    expect(chatProps!.google).toEqual({
      configured: true,
      connected: true,
      needsReconnect: false,
    });
  });
});
