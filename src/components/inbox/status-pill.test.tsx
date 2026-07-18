// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { StatusPill } from "@/components/inbox/status-pill";

afterEach(cleanup);

describe("StatusPill", () => {
  it("renders dot + word per tier (recent, plain)", () => {
    render(<StatusPill tier="recent" voice="plain" />);
    expect(screen.getByText(/Recent/)).toBeInTheDocument();
    expect(screen.getByText("🟢")).toBeInTheDocument();
  });

  it("renders dot + word per tier (aging, plain)", () => {
    render(<StatusPill tier="aging" voice="plain" />);
    expect(screen.getByText(/Aging/)).toBeInTheDocument();
    expect(screen.getByText("🟡")).toBeInTheDocument();
  });

  it("renders dot + word per tier (overdue, plain)", () => {
    render(<StatusPill tier="overdue" voice="plain" />);
    expect(screen.getByText(/Overdue/)).toBeInTheDocument();
    expect(screen.getByText("🟠")).toBeInTheDocument();
  });

  it("renders dot + word per tier (wayOverdue, plain)", () => {
    render(<StatusPill tier="wayOverdue" voice="plain" />);
    expect(screen.getByText(/Way overdue/)).toBeInTheDocument();
    expect(screen.getByText("🔴")).toBeInTheDocument();
  });

  it("playful voice uses Fresh/Softening/Soggy/Stale labels", () => {
    render(<StatusPill tier="overdue" voice="playful" />);
    expect(screen.getByText(/Soggy/)).toBeInTheDocument();

    render(<StatusPill tier="recent" voice="playful" />);
    expect(screen.getByText(/Fresh/)).toBeInTheDocument();

    render(<StatusPill tier="aging" voice="playful" />);
    expect(screen.getByText(/Softening/)).toBeInTheDocument();

    render(<StatusPill tier="wayOverdue" voice="playful" />);
    expect(screen.getByText(/Stale/)).toBeInTheDocument();
  });

  it("a11y: state is not colour-only — the dot is decorative (aria-hidden) and a text word label carries the tier", () => {
    const { container } = render(<StatusPill tier="overdue" voice="plain" />);
    // Word label is real text (perceivable without colour).
    expect(screen.getByText(/Overdue/)).toBeInTheDocument();
    // The coloured dot is decorative only.
    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent("🟠");
  });

  it("a11y: uses AA-tuned per-theme colour tokens (-700 light / dark:-400), not a fixed low-contrast hex", () => {
    const { container } = render(<StatusPill tier="recent" voice="plain" />);
    const pill = container.querySelector("span");
    expect(pill?.className).toContain("text-green-700");
    expect(pill?.className).toContain("dark:text-green-400");
    // The pre-a11y hardcoded hex is gone.
    expect(pill?.getAttribute("style") ?? "").not.toContain("#2f7d32");
  });
});
