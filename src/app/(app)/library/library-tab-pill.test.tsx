// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import LibraryPage from "./page";

// Regression guard for #48: the active Library tab's count pill failed
// WCAG-AA color-contrast. It rendered white `text-primary-foreground`
// (inherited from the active tab link) on a translucent
// `bg-primary-foreground/20`-over-`bg-primary` chip — the white overlay
// lightens the magenta *toward* the white text, dropping contrast to 3.90:1
// (light) / 4.44:1 (dark), both below AA-normal 4.5:1. The fix reuses the
// existing #40 tokens as a SOLID, opaque pairing — `bg-primary-foreground`
// (opaque) with explicit `text-primary` — which is 5.41:1 (light) / 6.32:1
// (dark). jsdom can't compute real contrast (no CSS-variable resolution), so
// the WCAG check itself lives in the zero-tolerance axe gate
// (e2e/a11y-contrast.spec.ts, now covering /library); this test locks the
// token contract so the failing translucent chip can't come back.

const { findMany, getSettingsMock, currentWorkspaceIdMock } = vi.hoisted(
  () => ({
    findMany: vi.fn(),
    getSettingsMock: vi.fn(),
    currentWorkspaceIdMock: vi.fn(),
  }),
);

// Forward ALL props (className, aria-current, …) so we can find the active
// tab via aria-current and inspect its pill's classes — the shared page test's
// Link mock deliberately drops them, which is why this lives in its own file.
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/db", () => ({
  prisma: { brainDumpItem: { findMany } },
  getSettings: getSettingsMock,
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/app/actions/braindump", () => ({
  ensureFocusStep: vi.fn().mockResolvedValue(null),
  completeItem: vi.fn().mockResolvedValue(undefined),
  deleteBrainDumpItem: vi.fn().mockResolvedValue(undefined),
  bulkBrainDumpAction: vi.fn().mockResolvedValue({ count: 0 }),
}));
vi.mock("@/components/breakdown/task-steps", () => ({
  TaskSteps: ({ taskId }: { taskId: string }) => (
    <div data-testid="task-steps">{taskId}</div>
  ),
}));

// Seed enough state that every tab has a non-zero count — mirrors the issue's
// "once accumulated DB state hits a certain count" repro so the pills render
// with real numbers, not zeros.
function raw(overrides: { id: string } & Record<string, unknown>) {
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
    estMinutes: null,
    task: null,
    ...overrides,
  };
}
const FIXTURE = [
  raw({ id: "Reply to Sam's email" }),
  raw({ id: "Buy milk" }),
  raw({ id: "Completed thing", completedAt: new Date() }),
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
  render(
    await LibraryPage({ searchParams: Promise.resolve(tab ? { tab } : {}) }),
  );

// The count pill is the trailing rounded-full <span> inside a tab link.
function pillOf(link: HTMLElement): HTMLElement {
  const pill = link.querySelector("span.rounded-full");
  if (!pill) throw new Error("no count pill found in tab link");
  return pill as HTMLElement;
}
const classesOf = (el: HTMLElement) =>
  el.className.split(/\s+/).filter(Boolean);

describe("Library tab-count pill — WCAG-AA token contract (#48)", () => {
  it("the ACTIVE tab pill uses an opaque, AA-safe token pairing (no translucent overlay)", async () => {
    await renderTab("plated");
    const nav = screen.getByRole("navigation", { name: /Library tabs/i });
    const activeLink = within(nav).getByRole("link", { current: "page" });
    const classes = classesOf(pillOf(activeLink));

    // Opaque brand-token pairing → AA (measured 5.41:1 light / 6.32:1 dark).
    expect(classes).toContain("bg-primary-foreground");
    expect(classes).toContain("text-primary");
    // The pre-#48 failing chip must never return.
    expect(classes).not.toContain("bg-primary-foreground/20");
  });

  it("INACTIVE tab pills keep the AA-safe secondary pairing", async () => {
    await renderTab("plated");
    const nav = screen.getByRole("navigation", { name: /Library tabs/i });
    const inactive = within(nav)
      .getAllByRole("link")
      .filter((l) => l.getAttribute("aria-current") !== "page");
    expect(inactive.length).toBeGreaterThan(0);
    for (const link of inactive) {
      const classes = classesOf(pillOf(link));
      expect(classes).toContain("bg-secondary");
      expect(classes).toContain("text-secondary-foreground");
    }
  });
});
