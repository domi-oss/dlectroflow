// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "@/components/inbox/status-pill";

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
});
