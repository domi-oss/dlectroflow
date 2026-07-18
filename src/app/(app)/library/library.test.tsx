// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import LibraryPage from "./page";

// Hoisted so the vi.mock factory (which runs before imports) can close over them.
const { findMany, getSettingsMock, currentWorkspaceIdMock } = vi.hoisted(() => ({
  findMany: vi.fn(),
  getSettingsMock: vi.fn(),
  currentWorkspaceIdMock: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/lib/db", () => ({
  prisma: { brainDumpItem: { findMany } },
  getSettings: getSettingsMock,
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
}));

const DAY = 86_400_000;

// Minimal raw `brainDumpItem` (findMany with `include: { task: { steps } }` shape).
function raw(
  overrides: Partial<{
    id: string;
    text: string;
    createdAt: Date;
    status: string;
    snoozedUntil: Date | null;
    completedAt: Date | null;
    breakdownRequestedAt: Date | null;
    taskId: string | null;
    task: unknown;
  }> & { id: string },
) {
  return {
    text: overrides.id,
    createdAt: new Date(Date.now() - 2 * 3600_000),
    status: "triaged",
    triagedAt: null,
    remindedAt: null,
    snoozedUntil: null,
    freshenedAt: null,
    promptDismissedAt: null,
    completedAt: null,
    breakdownRequestedAt: null,
    taskId: null,
    workspaceId: "owner",
    task: null,
    ...overrides,
  };
}

const step = (done: boolean, order: number) => ({
  id: `s${order}`,
  order,
  text: `step ${order}`,
  done,
  estMinutes: 10,
  subtaskEmoji: null,
});

// One item per tab (+ the graduation edge cases).
const FIXTURE = [
  // plated (Single-task): triaged, no steps
  raw({ id: "Reply to Sam's email", text: "Reply to Sam's email" }),
  // pantry (Saved for later): inbox, snoozed into the future
  raw({ id: "Book dentist", text: "Book dentist", status: "inbox", snoozedUntil: new Date(Date.now() + DAY) }),
  // sorted (Multi-step): partial progress, not scheduled → stays in Multi-step
  raw({
    id: "Plan the offsite",
    text: "Plan the offsite",
    taskId: "t-sorted",
    task: { status: "active", scheduledAt: null, steps: [step(true, 0), step(false, 1), step(false, 2)] },
  }),
  // done (graduated): all steps done → graduates out of Multi-step into Done
  raw({
    id: "Sort the tax docs",
    text: "Sort the tax docs",
    taskId: "t-done",
    task: { status: "active", scheduledAt: new Date(), steps: [step(true, 0), step(true, 1)] },
  }),
  // done (completed to-do): explicitly completed single item, no steps
  raw({ id: "Reply to recruiter", text: "Reply to recruiter", completedAt: new Date() }),
];

beforeEach(() => {
  findMany.mockResolvedValue(FIXTURE);
  getSettingsMock.mockResolvedValue({ voice: "plain" });
  currentWorkspaceIdMock.mockResolvedValue("owner");
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderTab = async (tab?: string) =>
  render(await LibraryPage({ searchParams: Promise.resolve(tab ? { tab } : {}) }));

describe("LibraryPage — tabs render their correct set", () => {
  it("Single-task (plated) lists only single-task to-dos", async () => {
    await renderTab("plated");
    expect(screen.getByText("Reply to Sam's email")).toBeInTheDocument();
    expect(screen.queryByText("Plan the offsite")).not.toBeInTheDocument();
    expect(screen.queryByText("Book dentist")).not.toBeInTheDocument();
    expect(screen.queryByText("Sort the tax docs")).not.toBeInTheDocument();
  });

  it("Saved for later (pantry) lists snoozed items with a wake time", async () => {
    await renderTab("pantry");
    expect(screen.getByText("Book dentist")).toBeInTheDocument();
    // "wakes <time>" row meta (not the hint sentence that ends "…wakes.")
    expect(screen.getByText(/wakes \w/)).toBeInTheDocument();
    expect(screen.queryByText("Reply to Sam's email")).not.toBeInTheDocument();
  });

  it("Multi-step (sorted) lists in-progress tasks with a progress pill", async () => {
    await renderTab("sorted");
    expect(screen.getByText("Plan the offsite")).toBeInTheDocument();
    expect(screen.getByText(/1\/3 done · not scheduled/)).toBeInTheDocument();
    // graduated + completed items are NOT here
    expect(screen.queryByText("Sort the tax docs")).not.toBeInTheDocument();
  });

  it("defaults to the Single-task tab when ?tab is absent/invalid", async () => {
    await renderTab(undefined);
    expect(screen.getByText("Reply to Sam's email")).toBeInTheDocument();
    cleanup();
    await renderTab("bogus");
    expect(screen.getByText("Reply to Sam's email")).toBeInTheDocument();
  });
});

describe("LibraryPage — Done graduation", () => {
  it("shows all-steps-done tasks AND completed to-dos, but not partial ones", async () => {
    await renderTab("done");
    expect(screen.getByText("Sort the tax docs")).toBeInTheDocument(); // all steps done
    expect(screen.getByText("Reply to recruiter")).toBeInTheDocument(); // completed to-do
    expect(screen.getByText(/2\/2 done/)).toBeInTheDocument();
    // partial multi-step must NOT have graduated
    expect(screen.queryByText("Plan the offsite")).not.toBeInTheDocument();
  });
});

describe("LibraryPage — workspace scoping", () => {
  it("only ever reads items for the current workspace", async () => {
    currentWorkspaceIdMock.mockResolvedValue("guest-42");
    await renderTab("plated");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "guest-42" }),
      }),
    );
  });
});

describe("LibraryPage — voice-aware", () => {
  it("uses the playful tab labels when the voice is playful", async () => {
    getSettingsMock.mockResolvedValue({ voice: "playful" });
    await renderTab("plated");
    expect(screen.getByText("😋 Quick bites")).toBeInTheDocument();
    expect(screen.getByText("🥫 Pantry")).toBeInTheDocument();
  });
});
