// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  renderHook,
  act,
} from "@testing-library/react";
import {
  SaveIndicator,
  SAVE_STALL_MS,
  useSaveStatus,
} from "@/components/settings/use-save-status";

afterEach(cleanup);

describe("SaveIndicator", () => {
  it("renders nothing while idle", () => {
    const { container } = render(<SaveIndicator status="idle" voice="plain" />);
    expect(container).toBeEmptyDOMElement();
  });

  // #72 review finding: four section headings now sit inside a band that turns
  // magenta while you are reading that section, and the band forces its inline
  // badges to inherit its foreground so they stay legible. The save indicator
  // must be spared that, because its COLOUR is its meaning — green saved, red
  // failed. `data-save-status` is the hook globals.css keys the carve-out off,
  // so it has to exist on every visible state.
  it.each([
    ["saving", "status"],
    ["saved", "status"],
    ["error", "alert"],
    ["stalled", "status"],
  ] as const)(
    "tags the %s state so a highlighted band leaves its colour alone",
    (status, role) => {
      render(<SaveIndicator status={status} voice="plain" />);
      expect(screen.getByRole(role)).toHaveAttribute(
        "data-save-status",
        status,
      );
    },
  );

  it("keeps saved and failed visually distinct, not just textually", () => {
    const saved = render(<SaveIndicator status="saved" voice="plain" />);
    const savedClass = screen.getByRole("status").className;
    saved.unmount();

    render(<SaveIndicator status="error" voice="plain" />);
    const errorClass = screen.getByRole("alert").className;

    expect(savedClass).toMatch(/green/);
    expect(errorClass).toMatch(/red/);
    expect(savedClass).not.toBe(errorClass);
  });

  // #109 — both indicators are 12px, so the 4.5:1 NORMAL-text threshold applies,
  // not the 3:1 large-text one. `text-green-600` measured 3.03:1 and
  // `text-red-600` 4.48:1 on the light --background; each only paints for the
  // moment after a save resolves, so /settings' zero-tolerance contrast gate has
  // only ever scanned an idle page. green-700 is 4.65:1, red-700 is 6.04:1.
  it.each([
    ["saved", "status", "text-green-700", "dark:text-green-400", "green-600"],
    ["error", "alert", "text-red-700", "dark:text-red-400", "red-600"],
  ] as const)(
    "paints the %s state with the AA-tuned pair, not the sub-AA %s",
    (status, role, light, dark, banned) => {
      render(<SaveIndicator status={status} voice="plain" />);
      const className = screen.getByRole(role).className;
      expect(className).toContain(light);
      expect(className).toContain(dark);
      expect(className).not.toContain(`text-${banned}`);
    },
  );
});

/**
 * #227 — the state the hook did not have: **the action never answered.**
 *
 * `SaveStatus` was `idle | saving | saved | error`, so a write that neither
 * resolves nor rejects — a pod rolling mid-request, a connection that never
 * closes — left the indicator on `saving` for as long as the page stayed open.
 * "…" reads as "still working", which is the one thing it is not; the user is
 * given no reason to try anything else. It is the same third failure mode
 * `withActionTimeout` names on the capture surfaces, arriving here through the
 * shared hook so five sections cannot each invent their own answer to it.
 *
 * It is deliberately NOT `error`. The client cannot tell a hung write from a
 * slow one that will land, so claiming "couldn't save" would be a claim it has
 * no evidence for — and would invite a rollback that undoes a value the server
 * may already hold.
 */
describe("useSaveStatus: a save that never answers", () => {
  it("stops claiming to be working once the wait passes the stall bound", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useSaveStatus());
      act(() => result.current.markSaving());
      expect(result.current.status).toBe("saving");

      act(() => void vi.advanceTimersByTime(SAVE_STALL_MS - 1));
      expect(result.current.status).toBe("saving");

      act(() => void vi.advanceTimersByTime(1));
      expect(result.current.status).toBe("stalled");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["markSaved", "saved"],
    ["markError", "error"],
  ] as const)(
    "does not stall a save that answered — %s wins",
    (mark, expected) => {
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useSaveStatus());
        act(() => result.current.markSaving());
        act(() => result.current[mark]());
        act(() => void vi.advanceTimersByTime(SAVE_STALL_MS * 2));
        // "saved" fades back to idle; what matters is that neither ever became
        // "stalled" after its answer had already arrived.
        expect(["idle", expected]).toContain(result.current.status);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("still reports a late answer that arrives after the stall", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useSaveStatus());
      act(() => result.current.markSaving());
      act(() => void vi.advanceTimersByTime(SAVE_STALL_MS));
      expect(result.current.status).toBe("stalled");

      act(() => result.current.markError());
      expect(result.current.status).toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms the bound for a second save rather than stalling on the first clock", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useSaveStatus());
      act(() => result.current.markSaving());
      act(() => void vi.advanceTimersByTime(SAVE_STALL_MS - 100));
      act(() => result.current.markSaving());

      act(() => void vi.advanceTimersByTime(200));
      expect(result.current.status).toBe("saving");
      act(() => void vi.advanceTimersByTime(SAVE_STALL_MS));
      expect(result.current.status).toBe("stalled");
    } finally {
      vi.useRealTimers();
    }
  });

  // A section unmounted mid-save (the settings page navigated away) must not
  // have its timer fire into a dead component.
  it("drops the pending bound when the section unmounts", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { result, unmount } = renderHook(() => useSaveStatus());
      act(() => result.current.markSaving());
      unmount();
      act(() => void vi.advanceTimersByTime(SAVE_STALL_MS * 2));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  // Amber, not red: "we do not know" is not "it failed", and the two must not
  // look alike at 12px in a heading band. amber-700/amber-400 is the AA-tuned
  // pair #57 settled on for "attention, not alarm" and aging-section already
  // uses for its demo-override badge.
  it("paints the stalled state amber, distinct from the failed red", () => {
    const stalled = render(<SaveIndicator status="stalled" voice="plain" />);
    const stalledClass = screen.getByRole("status").className;
    stalled.unmount();

    render(<SaveIndicator status="error" voice="plain" />);
    const errorClass = screen.getByRole("alert").className;

    expect(stalledClass).toContain("text-amber-700");
    expect(stalledClass).toContain("dark:text-amber-400");
    expect(stalledClass).not.toContain("text-amber-600");
    expect(stalledClass).not.toBe(errorClass);
  });

  // WCAG 4.1.3 and #218 in one assertion. The message has to be announced, so
  // it needs a live region — but a POLITE one, because the honest content is
  // "no answer yet" rather than a failure demanding immediate attention, and
  // because `role="status"` keeps it the same live region `saving` already
  // rendered in this slot instead of inserting a second, assertive one beside
  // it. #218 is about a polite region nested inside an assertive one; this
  // keeps the settings indicator a single flat region either way.
  it("announces politely rather than adding a second, assertive region", () => {
    render(<SaveIndicator status="stalled" voice="plain" />);
    const el = screen.getByRole("status");
    expect(el).toHaveAttribute("data-save-status", "stalled");
    expect(el.textContent).toMatch(/may not have saved/i);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
