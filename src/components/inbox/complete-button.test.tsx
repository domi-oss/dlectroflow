// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CompleteButton } from "@/components/inbox/complete-button";

afterEach(cleanup);

describe("CompleteButton", () => {
  it("renders the voice-resolved label and fires onClick", () => {
    const onClick = vi.fn();
    render(<CompleteButton voice="plain" onClick={onClick} />);
    const btn = screen.getByRole("button", { name: /complete/i });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  // #253 — the label is a bare word, with NO leading glyph. Asserted as an exact
  // accessible name rather than `toHaveTextContent`, which is a substring match
  // and would pass on "✓ Complete" too — the very string this is guarding
  // against. This button is on every row of every list, so the glyph's width was
  // charged to all of them.
  it("renders the bare-word label — no leading checkmark", () => {
    render(<CompleteButton voice="plain" onClick={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Complete");
    expect(screen.getByRole("button").textContent).not.toContain("✓");
  });

  // Both voices, because `action.complete` is deliberately identical across them
  // (strings.ts) and a playful-only glyph creeping back would be invisible to
  // the plain-voice test above.
  it("carries no glyph in the playful voice either", () => {
    render(<CompleteButton voice="playful" onClick={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Complete");
  });

  it("a11y: has a ≥44px touch target (min-h-11 / min-w-11)", () => {
    render(<CompleteButton voice="plain" onClick={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /complete/i });
    expect(btn.className).toContain("min-h-11");
    expect(btn.className).toContain("min-w-11");
  });

  it("shape: matches its row siblings — rounded-md, no border, ghost hover (Duo shape-consistency fix)", () => {
    render(<CompleteButton voice="plain" onClick={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /complete/i });
    expect(btn.className).toContain("rounded-md");
    expect(btn.className).toContain("hover:bg-accent");
    expect(btn.className).not.toMatch(/\bborder\b/);
  });
});
