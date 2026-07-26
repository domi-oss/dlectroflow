// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { FocusLauncher } from "@/components/focus/focus-launcher";
import { SingleTaskLane } from "@/components/focus/focus-lanes";
import type { LauncherData, FocusableStep } from "@/lib/focus-launcher";

vi.mock("next/link", () => ({
  // Forward className so the ≥44px hit-target assertion can observe it.
  default: ({
    children,
    href,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/app/actions/braindump", () => ({
  ensureFocusStep: vi.fn(),
  completeItem: vi.fn(),
}));
vi.mock("@/app/actions/focus", () => ({ completeStep: vi.fn() }));

const hero: FocusableStep = {
  stepId: "h1",
  stepText: "Wire the API",
  subtaskEmoji: null,
  estMinutes: 12,
  taskId: "t1",
  taskTitle: "Ship",
  resumable: true,
  resumeAt: 1,
  remainingMin: 12,
  stepIndex: 2,
  stepsDone: 1,
  stepsTotal: 4,
  nextStepText: null,
  nextStepEmoji: null,
};
const data: LauncherData = {
  resumeHero: hero,
  singleTasks: [],
  multiStep: [],
  meta: { minutesToClear: 12 },
};

afterEach(cleanup);

describe("launcher a11y sweep", () => {
  it("status is glyph + text, not colour-only: the paused hero shows the ⏸ 'paused' label", () => {
    render(
      <FocusLauncher
        voice="plain"
        focusMinToday={0}
        currentStreak={0}
        clearedToday={false}
        data={data}
      />,
    );
    expect(screen.getByText(/paused/i)).toBeInTheDocument(); // '⏸ paused'
  });

  it("the hero progress uses role=progressbar with numeric min/now/max (not colour alone)", () => {
    render(
      <FocusLauncher
        voice="plain"
        focusMinToday={0}
        currentStreak={0}
        clearedToday={false}
        data={data}
      />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuenow", "1");
    expect(bar).toHaveAttribute("aria-valuemax", "4");
  });

  it("the resume CTA is a ≥44px target", () => {
    render(
      <FocusLauncher
        voice="plain"
        focusMinToday={0}
        currentStreak={0}
        clearedToday={false}
        data={data}
      />,
    );
    expect(
      screen.getByRole("link", { name: /resume focus/i }).className,
    ).toMatch(/min-h-\[44px\]/);
  });

  it("lane Start + ✓ are ≥44px and the ✓ carries a text accessible name", () => {
    render(
      <SingleTaskLane
        voice="plain"
        items={[{ itemId: "i1", text: "Buy milk", estMinutes: 8 }]}
      />,
    );
    expect(screen.getByRole("button", { name: /start/i }).className).toMatch(
      /min-h-\[44px\]/,
    );
    const done = screen.getByRole("button", { name: /complete/i }); // text accessible name, not colour
    expect(done.className).toMatch(/min-h-11/);
    expect(done.className).toMatch(/min-w-11/);
  });
});
