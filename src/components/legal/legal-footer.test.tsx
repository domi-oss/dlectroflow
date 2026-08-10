// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SOURCE_REPO_URL } from "@/lib/legal";
import { LegalFooter } from "./legal-footer";

afterEach(cleanup);

describe("LegalFooter", () => {
  it("links to the privacy policy and the terms", () => {
    // The reason this component exists: Google's OAuth verification requires the
    // privacy policy to be reachable FROM the app. A page nobody can navigate to
    // fails review even when it renders perfectly.
    render(<LegalFooter />);
    expect(
      screen.getByRole("link", { name: "Privacy (opens in a new tab)" }),
    ).toHaveAttribute("href", "/privacy");
    expect(
      screen.getByRole("link", { name: "Terms (opens in a new tab)" }),
    ).toHaveAttribute("href", "/terms");
  });

  it("offers the source, which is how AGPL-3.0 §13 is met for this instance", () => {
    render(<LegalFooter />);
    expect(
      screen.getByRole("link", { name: "Source (opens in a new tab)" }),
    ).toHaveAttribute("href", SOURCE_REPO_URL);
  });

  // The footer renders under EVERY screen, including the inbox. The previous
  // rule here — no `target`, because "all state is server-side" — was wrong on
  // its own premise: text typed into the capture bar and a note whose debounced
  // save has not flushed are both client-side, and both are destroyed by
  // navigating away. Reading the terms should never cost someone a thought they
  // were mid-way through writing down.
  it.each(["Privacy", "Terms", "Source"])(
    "opens %s in a new tab so nothing in progress is lost",
    (name) => {
      render(<LegalFooter />);
      expect(
        screen.getByRole("link", { name: new RegExp(`^${name}`) }),
      ).toHaveAttribute("target", "_blank");
    },
  );

  it("announces the new tab in every link's accessible name", () => {
    // WCAG 3.2.5: opening a new window unannounced is a change of context the
    // user did not request. Sighted users get the tab appearing; a screen-reader
    // user gets nothing unless it is in the name. This is the cost the old
    // comment correctly identified — it is now a cost worth paying, not a reason
    // to keep the links in-tab.
    render(<LegalFooter />);
    for (const name of ["Privacy", "Terms", "Source"]) {
      expect(
        screen.getByRole("link", { name: `${name} (opens in a new tab)` }),
      ).toBeInTheDocument();
    }
  });

  it("gives every external-target link rel=noopener noreferrer", () => {
    // `noopener` is the security-relevant half: without it the opened page gets
    // a `window.opener` handle back into this one. Modern browsers imply it for
    // `target="_blank"`, but it is one attribute against a silent tabnabbing
    // regression on any engine that does not.
    render(<LegalFooter />);
    for (const name of ["Privacy", "Terms", "Source"]) {
      const rel =
        screen
          .getByRole("link", { name: new RegExp(`^${name}`) })
          .getAttribute("rel") ?? "";
      expect(rel).toContain("noopener");
      expect(rel).toContain("noreferrer");
    }
  });

  it("is a landmark with an accessible name", () => {
    // Rendered under every screen in the app, so it has to be skippable and
    // identifiable rather than three anonymous links after the main content.
    render(<LegalFooter />);
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Legal and source" }),
    ).toBeInTheDocument();
  });

  it("passes a caller's className through without dropping its own", () => {
    const { container } = render(<LegalFooter className="mt-10" />);
    const footer = container.querySelector("footer")!;
    expect(footer).toHaveClass("mt-10");
    expect(footer).toHaveClass("border-t");
  });

  it("gives every link a visible focus ring", () => {
    // The footer is the last stop in the tab order on every page; a keyboard user
    // who cannot see where they are has effectively lost the legal links.
    render(<LegalFooter />);
    for (const name of ["Privacy", "Terms", "Source"]) {
      expect(
        screen.getByRole("link", { name: new RegExp(`^${name}`) }),
      ).toHaveClass("focus-visible:ring-2");
    }
  });
});
