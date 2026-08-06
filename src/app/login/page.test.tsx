// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import LoginPage from "./page";

afterEach(cleanup);

/** The page rendered for one `?error=` value, as one normalised string. */
async function textFor(error?: string): Promise<string> {
  const ui = await LoginPage({ searchParams: Promise.resolve({ error }) });
  const { container } = render(ui);
  return container.textContent!.replace(/\s+/g, " ");
}

describe("Login page", () => {
  it("offers the sign-in link with no error present", async () => {
    render(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(
      screen.getByRole("link", { name: /sign in with gitlab/i }),
    ).toHaveAttribute("href", "/api/auth/gitlab/start");
  });

  it("says nothing about a failure when there is no error", async () => {
    expect(await textFor()).not.toMatch(/failed|expired/i);
  });

  it("keeps the not-authorized message distinct", async () => {
    expect(await textFor("not_authorized")).toMatch(/isn't the owner/i);
  });

  // #174 — an expired attempt is RECOVERABLE, and "Sign-in failed. Please try
  // again." reads as a rejection. The distinction matters most here: the
  // reporter's phone showed that one sentence on every retry, which is why the
  // failure was described as a hang rather than as an error.
  describe("an expired attempt (#174)", () => {
    it("says the attempt expired, not that sign-in failed", async () => {
      const text = await textFor("expired");
      expect(text).toMatch(/expired/i);
      expect(text).not.toMatch(/sign-in failed/i);
    });

    it("names the other cause it could be, because the server cannot tell them apart", async () => {
      // The state and PKCE cookies are simply absent by the time the callback
      // runs; "it timed out" and "it began in a different browser" leave no
      // trace that distinguishes them. Saying both is honest and actionable.
      expect(await textFor("expired")).toMatch(/different browser/i);
    });

    it("tells the reader what to do next", async () => {
      expect(await textFor("expired")).toMatch(/start again/i);
    });

    it("still offers the sign-in link to start again with", async () => {
      render(
        await LoginPage({
          searchParams: Promise.resolve({ error: "expired" }),
        }),
      );
      expect(
        screen.getByRole("link", { name: /sign in with gitlab/i }),
      ).toBeInTheDocument();
    });
  });

  it("falls back to the generic message for any other reason", async () => {
    expect(await textFor("state_mismatch")).toMatch(/sign-in failed/i);
  });

  // A provider error string arrives straight off the query string. It is only
  // ever compared, never interpolated into the page — this pins that down, so
  // nobody later "helpfully" renders the raw reason to the user.
  it("never echoes the raw error value back to the page", async () => {
    const text = await textFor("GitLab token exchange failed (400)");
    expect(text).not.toMatch(/token exchange/i);
    expect(text).toMatch(/sign-in failed/i);
  });
});
