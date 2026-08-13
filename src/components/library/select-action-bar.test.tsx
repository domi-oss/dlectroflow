// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SelectActionBar } from "@/components/library/select-action-bar";

afterEach(cleanup);

const props = () => ({
  count: 2,
  voice: "plain" as const,
  pending: false,
  onComplete: vi.fn(),
  onSaveForLater: vi.fn(),
  onDelete: vi.fn(),
});

/**
 * #205's `select-action-bar.tsx` leg, folded into #253 because the detick opened
 * this file anyway (it is the one surface that calls `t("action.complete")`
 * without going through `CompleteButton`).
 *
 * All five buttons here are label-only, so a bare `touchTarget` is the whole fix
 * — no icon sizing, no glyph, nothing else to compose. The bar is `sticky` at the
 * bottom of the viewport on a phone, which is where a sub-44px target is worst:
 * it sits under the thumb, and one of the five deletes everything selected.
 *
 * Both states are asserted. The confirm state REPLACES Complete / Save for later
 * with Delete / Cancel, so a guard that only ever renders the idle bar leaves two
 * of the five unmeasured — the same blind spot #251 found four times over in the
 * row-level delete confirms.
 */
describe("SelectActionBar — 44px targets (#205 leg)", () => {
  const expect44 = (el: HTMLElement) => {
    expect(el.className, `"${el.textContent}" is not ≥44px`).toContain(
      "min-h-11",
    );
    expect(el.className, `"${el.textContent}" is not ≥44px`).toContain(
      "min-w-11",
    );
  };

  it("every idle-state button carries the 44px touch target", () => {
    render(<SelectActionBar {...props()} />);
    const names = ["Complete", "Save for later", "Delete"];
    for (const name of names) {
      expect44(screen.getByRole("button", { name }));
    }
    // Guard the guard: if the bar ever stops rendering three buttons, the loop
    // above would pass by measuring fewer of them.
    expect(screen.getAllByRole("button")).toHaveLength(names.length);
  });

  it("the armed delete confirm's pair carries it too", () => {
    render(<SelectActionBar {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    for (const name of ["Delete", "Cancel"]) {
      expect44(screen.getByRole("button", { name }));
    }
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("the confirm is still two-step: arming does not delete", () => {
    const p = props();
    render(<SelectActionBar {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(p.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(p.onDelete).toHaveBeenCalledOnce();
  });

  it("Cancel disarms without deleting, and the idle bar comes back", () => {
    const p = props();
    render(<SelectActionBar {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(p.onDelete).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Complete" }),
    ).toBeInTheDocument();
  });

  // The disabled reasons this bar already had, pinned so the class change cannot
  // quietly drop them: nothing selected, or a bulk call already in flight.
  it("nothing selected disables the three actions", () => {
    render(<SelectActionBar {...props()} count={0} />);
    for (const name of ["Complete", "Save for later", "Delete"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });

  it("a bulk call in flight disables them as well", () => {
    render(<SelectActionBar {...props()} pending />);
    for (const name of ["Complete", "Save for later", "Delete"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });
});
