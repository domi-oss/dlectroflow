// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { FocusLauncher } from "@/components/focus/focus-launcher";
import type { FocusableStep } from "@/lib/focus-launcher";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function entry(overrides: Partial<FocusableStep> & { stepId: string }): FocusableStep {
  return {
    stepText: overrides.stepId,
    subtaskEmoji: null,
    estMinutes: 15,
    taskId: "task-" + overrides.stepId,
    taskTitle: "Task " + overrides.stepId,
    resumable: false,
    ...overrides,
  };
}

afterEach(cleanup);

describe("FocusLauncher", () => {
  it("renders one row per entry, each linking to /focus/[stepId] with task title + step text + estimate", () => {
    render(
      <FocusLauncher
        voice="plain"
        entries={[
          entry({ stepId: "s1", stepText: "Draft intro", taskTitle: "Write report", estMinutes: 25 }),
          entry({ stepId: "s2", stepText: "Book flights", taskTitle: "Plan trip", estMinutes: 10 }),
        ]}
      />,
    );

    const links = screen.getAllByRole("link");
    // Two focusable rows (no /inbox empty-state link present).
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "/focus/s1");
    expect(links[1]).toHaveAttribute("href", "/focus/s2");

    const first = within(links[0]);
    expect(first.getByText("Write report")).toBeInTheDocument();
    expect(first.getByText(/Draft intro/)).toBeInTheDocument();
    expect(first.getByText(/25m/)).toBeInTheDocument();

    // Intro copy is shown when there are entries.
    expect(screen.getByText("Pick a step to focus on.")).toBeInTheDocument();
  });

  it("shows the emoji when present", () => {
    render(
      <FocusLauncher
        voice="plain"
        entries={[entry({ stepId: "s1", stepText: "Draft", subtaskEmoji: "✍️" })]}
      />,
    );
    expect(screen.getByText(/✍️/)).toBeInTheDocument();
  });

  it("shows a paused badge only on resumable rows", () => {
    render(
      <FocusLauncher
        voice="plain"
        entries={[
          entry({ stepId: "s-resumable", stepText: "Draft", taskTitle: "Report", resumable: true }),
          entry({ stepId: "s-fresh", stepText: "Book", taskTitle: "Trip", resumable: false }),
        ]}
      />,
    );
    const badges = screen.getAllByText(/paused/i);
    expect(badges).toHaveLength(1);
    // The badge lives inside the resumable row's link.
    expect(screen.getByRole("link", { name: /paused/i })).toHaveAttribute(
      "href",
      "/focus/s-resumable",
    );
  });

  it("renders the empty state (copy + link to /inbox) when there are no entries", () => {
    render(<FocusLauncher voice="plain" entries={[]} />);
    expect(
      screen.getByText(
        "Nothing to focus yet. Capture something in your Inbox and break it into steps, then come back to focus.",
      ),
    ).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/inbox");
    // No focusable rows rendered in the empty state.
    expect(screen.queryByText("Pick a step to focus on.")).not.toBeInTheDocument();
  });

  it("is voice-aware (playful intro differs from plain)", () => {
    render(<FocusLauncher voice="playful" entries={[entry({ stepId: "s1" })]} />);
    expect(screen.getByText("Pick a bite to focus on.")).toBeInTheDocument();
  });
});
