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
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute(
      "href",
      "/terms",
    );
  });

  it("offers the source, which is how AGPL-3.0 §13 is met for this instance", () => {
    render(<LegalFooter />);
    expect(screen.getByRole("link", { name: "Source" })).toHaveAttribute(
      "href",
      SOURCE_REPO_URL,
    );
  });

  it("does not force the source link into a new tab", () => {
    // Nothing in this app is lost by navigating away (all state is server-side),
    // so target="_blank" would only remove the reader's choice and add an "opens
    // in a new tab" announcement to a link that does not need one.
    render(<LegalFooter />);
    expect(screen.getByRole("link", { name: "Source" })).not.toHaveAttribute(
      "target",
    );
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
      expect(screen.getByRole("link", { name })).toHaveClass(
        "focus-visible:ring-2",
      );
    }
  });
});
