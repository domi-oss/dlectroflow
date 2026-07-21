// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import TaskPage from "./page";

// Hoisted so the vi.mock factories (which run before imports) can close over them.
const {
  findFirstMock,
  getSettingsMock,
  currentWorkspaceIdMock,
  isOwnerRequestMock,
  getGoogleStatusMock,
  pushStepsToGoogleTasksMock,
  scheduleViaIcsMock,
  downloadIcsMock,
  refreshMock,
} = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  getSettingsMock: vi.fn(),
  currentWorkspaceIdMock: vi.fn(),
  isOwnerRequestMock: vi.fn(),
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
  isOwnerRequest: isOwnerRequestMock,
}));
vi.mock("@/lib/google", () => ({
  getGoogleStatus: getGoogleStatusMock,
}));
// BreakdownChat (the `editing` branch) pulls in a heavy tree of its own server
// actions (breakdown / anthropic) — none of our scenarios exercise it (task
// always has steps, `edit` is never "1"), so stub it like the Library hub test
// stubs the equally heavy <TaskSteps>.
vi.mock("@/components/breakdown/breakdown-chat", () => ({
  BreakdownChat: () => <div data-testid="breakdown-chat" />,
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

const renderPage = async (opts: { from?: string; taskId?: string } = {}) =>
  render(
    await TaskPage({
      params: Promise.resolve({ taskId: opts.taskId ?? "t1" }),
      searchParams: Promise.resolve(opts.from ? { from: opts.from } : {}),
    }),
  );

beforeEach(() => {
  findFirstMock.mockResolvedValue(task());
  getSettingsMock.mockResolvedValue({ voice: "plain" });
  currentWorkspaceIdMock.mockResolvedValue("owner");
  isOwnerRequestMock.mockResolvedValue(true);
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
  it("defaults the '← Back' link → /inbox when `from` is absent", async () => {
    await renderPage();
    const link = screen.getByRole("link", { name: /back/i });
    expect(link).toHaveTextContent("← Back");
    expect(link).toHaveAttribute("href", "/inbox");
  });

  it("`?from=library` sends the '← Back' link → /library?tab=sorted", async () => {
    await renderPage({ from: "library" });
    const link = screen.getByRole("link", { name: /back/i });
    // Label is a simple "← Back"; only the destination reflects the origin.
    expect(link).toHaveTextContent("← Back");
    expect(link).toHaveAttribute("href", "/library?tab=sorted");
  });

  it("an unknown `from` value falls back to /inbox rather than reflecting it into a path (no open redirect)", async () => {
    await renderPage({ from: "https://evil.example.com" });
    const link = screen.getByRole("link", { name: /back/i });
    expect(link).toHaveAttribute("href", "/inbox");
  });

  it("`?from=__proto__` (an inherited Object.prototype key, not an own key of BACK_TARGETS) falls back to /inbox instead of crashing", async () => {
    await renderPage({ from: "__proto__" });
    const link = screen.getByRole("link", { name: /back/i });
    expect(link).toHaveAttribute("href", "/inbox");
  });

  it("keeps the simple '← Back' label in playful voice (destination still /inbox)", async () => {
    getSettingsMock.mockResolvedValue({ voice: "playful" });
    await renderPage();
    const link = screen.getByRole("link", { name: /back/i });
    expect(link).toHaveTextContent("← Back");
    expect(link).toHaveAttribute("href", "/inbox");
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

  it("renders a SEPARATE Schedule control (owner + Google connected → 📅 pushes steps to Google Tasks)", async () => {
    pushStepsToGoogleTasksMock.mockResolvedValue({
      ok: true,
      scheduled: 2,
      listTitle: "Reclaim",
    });
    await renderPage();
    const scheduleButton = screen.getByRole("button", { name: /schedule/i });
    fireEvent.click(scheduleButton);
    await waitFor(() =>
      expect(pushStepsToGoogleTasksMock).toHaveBeenCalledWith("t1"),
    );
  });

  it("guest workspaces get the ICS 'Add to calendar' control, never a live Google one", async () => {
    isOwnerRequestMock.mockResolvedValue(false);
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
