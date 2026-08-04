// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HyperFocusToggle } from "@/components/focus/hyper-focus-toggle";
import { HYPER_FOCUS_STORAGE_KEY } from "@/lib/hyper-focus";

// This jsdom build exposes no `localStorage` at all (Node's own is gated behind
// --localstorage-file and shadows jsdom's), so the theme-toggle test simply
// swallows the failure and asserts nothing about persistence. Here persistence
// IS the behaviour under test, so stand up a real Storage-shaped object. The
// semantics it is driven through — strict "1", never throwing — are covered
// against a plain object in hyper-focus.test.ts; this proves the component is
// wired to the browser's storage rather than to component state.
function installStorage(): Storage {
  const map = new Map<string, string>();
  const storage = {
    get length() {
      return map.size;
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  return storage;
}

let store: Storage;
beforeEach(() => {
  store = installStorage();
});
afterEach(cleanup);

describe("HyperFocusToggle (#142)", () => {
  it("is off by default", () => {
    render(<HyperFocusToggle voice="plain" />);
    expect(
      screen.getByRole("button", { name: /hyper focus mode/i }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("turning it on persists it", async () => {
    const user = userEvent.setup();
    render(<HyperFocusToggle voice="plain" />);
    await user.click(screen.getByRole("button", { name: /hyper focus mode/i }));
    expect(
      screen.getByRole("button", { name: /hyper focus mode/i }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(store.getItem(HYPER_FOCUS_STORAGE_KEY)).toBe("1");
  });

  it("picks up a value stored before it mounted", () => {
    store.setItem(HYPER_FOCUS_STORAGE_KEY, "1");
    render(<HyperFocusToggle voice="plain" />);
    expect(
      screen.getByRole("button", { name: /hyper focus mode/i }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("two mounted readers agree — flipping one updates the other", async () => {
    const user = userEvent.setup();
    render(
      <>
        <HyperFocusToggle voice="plain" />
        <HyperFocusToggle voice="plain" />
      </>,
    );
    const [first, second] = screen.getAllByRole("button", {
      name: /hyper focus mode/i,
    });
    await user.click(first);
    expect(second).toHaveAttribute("aria-pressed", "true");
  });

  it("says what it does, not just what it is called", () => {
    render(<HyperFocusToggle voice="plain" />);
    expect(screen.getByText(/single-task/i)).toBeInTheDocument();
  });

  it("state is carried by text and aria-pressed, never by colour alone (WCAG 1.4.1)", async () => {
    const user = userEvent.setup();
    render(<HyperFocusToggle voice="plain" />);
    const toggle = screen.getByRole("button", { name: /hyper focus mode/i });
    expect(toggle).toHaveTextContent(/off/i);
    await user.click(toggle);
    expect(toggle).toHaveTextContent(/on/i);
  });

  it("is a ≥44px target", () => {
    render(<HyperFocusToggle voice="plain" />);
    expect(
      screen.getByRole("button", { name: /hyper focus mode/i }),
    ).toHaveClass("min-h-[44px]");
  });
});
