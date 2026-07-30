// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { GoogleAccountHint, GOOGLE_ACCOUNT_HINT } from "./google-account-hint";

afterEach(cleanup);

describe("GoogleAccountHint (#128)", () => {
  it("renders the shared copy under the id its control points at", () => {
    render(<GoogleAccountHint id="hint-1" />);
    const hint = document.getElementById("hint-1");
    expect(hint).not.toBeNull();
    expect(hint).toHaveTextContent(GOOGLE_ACCOUNT_HINT);
  });

  it("keeps the muted hint styling and takes per-surface classes on top", () => {
    render(<GoogleAccountHint id="hint-2" className="basis-full text-xs" />);
    const hint = document.getElementById("hint-2")!;
    expect(hint.className).toContain("text-muted-foreground");
    expect(hint.className).toContain("basis-full");
    expect(hint.className).toContain("text-xs");
  });

  it("leads with the action, not the failure — this is a hint, not an error", () => {
    // "Use a personal Google account…" first, the caveat second. An error
    // banner would open with what went wrong; nothing here has gone wrong yet.
    expect(GOOGLE_ACCOUNT_HINT).toMatch(/^Use a personal Google account/);
    expect(GOOGLE_ACCOUNT_HINT).not.toMatch(/error|failed|blocked you|sorry/i);
  });

  it("stays vendor-neutral — this is a public, self-hostable app", () => {
    // The one and only proper noun may be Google. No employer, no university,
    // no instance operator: a self-hoster's users are not ours, and copy that
    // names one organisation is wrong for everybody else who runs this.
    const words = GOOGLE_ACCOUNT_HINT.match(/\b[A-Z][A-Za-z]+/g) ?? [];
    const named = words.filter(
      (w, i) => !(i === 0 && GOOGLE_ACCOUNT_HINT.startsWith(w)),
    );
    expect(named).toEqual(["Google"]);
  });

  it("renders inline-safe markup — it sits inside <span>-only popup surfaces", () => {
    // The ▾ row menu's popup is rendered as a <span> tree (row-actions.tsx), so
    // a <p> here would be invalid nesting and a hydration warning in the inbox.
    render(<GoogleAccountHint id="hint-3" />);
    expect(document.getElementById("hint-3")!.tagName).toBe("SPAN");
  });

  it("is discoverable by its text, so every surface can assert on one string", () => {
    render(<GoogleAccountHint id="hint-4" />);
    expect(screen.getByText(GOOGLE_ACCOUNT_HINT)).toBeInTheDocument();
  });
});
