// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { FocusLauncher } from "@/components/focus/focus-launcher";
import type { LauncherData, FocusableStep } from "@/lib/focus-launcher";

vi.mock("next/link", () => ({
  // Forward className so brand-CTA / hit-target class assertions can observe it.
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
// Render the lanes as light stand-ins — their interactivity is covered by
// focus-lanes.test.tsx; here we assert the shell's own structure.
vi.mock("@/components/focus/focus-lanes", () => ({
  SingleTaskLane: ({
    items,
  }: {
    items: { itemId: string; text: string }[];
  }) => (
    <ul data-testid="single-lane">
      {items.map((i) => (
        <li key={i.itemId}>{i.text}</li>
      ))}
    </ul>
  ),
  MultiStepLane: ({ items }: { items: FocusableStep[] }) => (
    <ul data-testid="multi-lane">
      {items.map((e) => (
        <li key={e.stepId}>{e.stepText}</li>
      ))}
    </ul>
  ),
}));

const hero = (
  o: Partial<FocusableStep> & { stepId: string },
): FocusableStep => ({
  stepText: o.stepId,
  subtaskEmoji: null,
  estMinutes: 12,
  taskId: "task-" + o.stepId,
  taskTitle: "Task " + o.stepId,
  resumable: true,
  resumeAt: 1,
  // #27 follow-up — defaults to match estMinutes (the common "not paused
  // mid-way" case); the dedicated remaining-time test overrides it.
  remainingMin: o.estMinutes ?? 12,
  stepIndex: 2,
  stepsDone: 1,
  stepsTotal: 4,
  nextStepText: null,
  nextStepEmoji: null,
  ...o,
});

const data = (over: Partial<LauncherData> = {}): LauncherData => ({
  resumeHero: null,
  singleTasks: [],
  multiStep: [],
  meta: { minutesToClear: 0 },
  ...over,
});

afterEach(cleanup);

describe("FocusLauncher shell", () => {
  it("renders ← Back to /, the title, and a meta line linking to /dashboard", () => {
    render(
      <FocusLauncher
        voice="plain"
        focusMinToday={30}
        currentStreak={4}
        clearedToday={false}
        data={data({
          singleTasks: [{ itemId: "i1", text: "Buy milk", estMinutes: 8 }],
          meta: { minutesToClear: 42 },
        })}
      />,
    );
    expect(screen.getByRole("link", { name: /back/i })).toHaveAttribute(
      "href",
      "/",
    );
    expect(
      screen.getByRole("heading", { name: /focus timer/i }),
    ).toBeInTheDocument();
    const meta = screen.getByRole("link", { name: /focused today/i });
    expect(meta).toHaveAttribute("href", "/dashboard");
    expect(within(meta).getByText(/30m/)).toBeInTheDocument();
    expect(within(meta).getByText(/4-day/)).toBeInTheDocument(); // streak count (unambiguous vs "42m")
    expect(within(meta).getByText(/42m/)).toBeInTheDocument();
  });

  // #136 — the shell hands each lane its rows and nothing else. The SubHeader
  // label, the count badge and the see-all deep link moved INTO the lane, whose
  // own tests assert them, because a count rendered out here could only ever
  // report the server's rows and so could not follow an optimistic ✓.
  it("hands each lane its rows, and renders no header of its own", () => {
    render(
      <FocusLauncher
        voice="plain"
        focusMinToday={0}
        currentStreak={0}
        clearedToday={false}
        data={data({
          singleTasks: [{ itemId: "i1", text: "Buy milk", estMinutes: 8 }],
          multiStep: [
            hero({ stepId: "m1", stepText: "Draft intro", resumable: false }),
          ],
        })}
      />,
    );
    expect(
      within(screen.getByTestId("single-lane")).getByText("Buy milk"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("multi-lane")).getByText("Draft intro"),
    ).toBeInTheDocument();
    // With the lanes stubbed out, nothing is left to render either header —
    // which is the assertion that the shell no longer owns a second count.
    expect(screen.queryByText("Single-task to-dos")).not.toBeInTheDocument();
    expect(screen.queryByText("Multi-step to-dos")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /see all/i }),
    ).not.toBeInTheDocument();
  });

  // A lane the server handed nothing is still rendered (the OTHER lane has rows
  // to show), and it is the lane that decides what an empty lane says.
  it("still renders a lane the server handed no rows", () => {
    render(
      <FocusLauncher
        voice="plain"
        focusMinToday={0}
        currentStreak={0}
        clearedToday={false}
        data={data({
          singleTasks: [{ itemId: "i1", text: "Buy milk", estMinutes: 8 }],
        })}
      />,
    );
    expect(screen.getByTestId("multi-lane")).toBeInTheDocument();
  });

  it("renders the resume hero with step X/Y, ~Nm left, a progressbar, and ▶ Resume → /focus/[stepId]", () => {
    render(
      <FocusLauncher
        voice="plain"
        focusMinToday={0}
        currentStreak={0}
        clearedToday={false}
        data={data({
          resumeHero: hero({
            stepId: "h1",
            stepText: "Wire the API",
            stepIndex: 2,
            stepsTotal: 4,
            estMinutes: 12,
          }),
        })}
      />,
    );
    expect(screen.getByText(/Wire the API/)).toBeInTheDocument();
    expect(screen.getByText(/2\/4/)).toBeInTheDocument();
    expect(screen.getByText(/12m/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "1",
    );
    const resume = screen.getByRole("link", { name: /resume focus/i });
    expect(resume).toHaveAttribute("href", "/focus/h1");
    // #40 Phase 3.3 — the primary focus CTA carries the brand gradient variant
    // (gradient fill + >=18.6px bold label) and keeps its >=44px hit target.
    expect(resume.className).toContain(
      "[background-image:var(--gradient-brand)]",
    );
    expect(resume.className).toContain("font-bold");
    expect(resume.className).toContain("min-h-[44px]");
  });

  // #27 follow-up — the paused banner shows the step's TRUE remaining time,
  // not its original estimate (a step paused partway through reads its real
  // remaining, which can be well under the full estimate).
  it("shows the paused step's true remaining time, not its full estimate", () => {
    render(
      <FocusLauncher
        voice="plain"
        focusMinToday={0}
        currentStreak={0}
        clearedToday={false}
        data={data({
          resumeHero: hero({
            stepId: "h1",
            stepText: "Wire the API",
            estMinutes: 25,
            remainingMin: 9,
          }),
        })}
      />,
    );
    expect(screen.getByText(/~9m/)).toBeInTheDocument();
    expect(screen.queryByText(/~25m/)).not.toBeInTheDocument();
  });

  it("shows the new-user empty state (Inbox card) when nothing is focusable and nothing was cleared", () => {
    render(
      <FocusLauncher
        voice="plain"
        focusMinToday={0}
        currentStreak={0}
        clearedToday={false}
        data={data()}
      />,
    );
    expect(screen.getByText(/Nothing to focus yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /inbox/i })).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.queryByText("Single-task to-dos")).not.toBeInTheDocument();
  });

  it("shows the all-cleared moment when nothing is focusable but work was done today", () => {
    render(
      <FocusLauncher
        voice="plain"
        focusMinToday={45}
        currentStreak={3}
        clearedToday
        data={data()}
      />,
    );
    expect(screen.getByText(/All caught up/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing to focus yet/i)).not.toBeInTheDocument();
  });

  it("is voice-aware (playful all-clear differs from plain)", () => {
    render(
      <FocusLauncher
        voice="playful"
        focusMinToday={45}
        currentStreak={3}
        clearedToday
        data={data()}
      />,
    );
    expect(screen.getByText(/Plates cleared/i)).toBeInTheDocument();
  });
});
