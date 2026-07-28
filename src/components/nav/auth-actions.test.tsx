// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AuthActions } from "./auth-actions";

afterEach(cleanup);

// #35 Phase A — the header's auth affordance stops being owner-specific.
//
// It used to read "Owner sign in", because being signed in and being the owner
// were the same thing. With invite-only accounts an ordinary member signs in
// too, so the label is just "Sign in", and once you are signed in it flips to
// "Account" (design: deep-links to the Account group at /settings#account,
// which Phase C fills in).
describe("AuthActions", () => {
  it("shows 'Sign in' to a guest", () => {
    render(<AuthActions signedIn={false} />);
    const link = screen.getByRole("link", { name: /sign in/i });
    expect(link).toHaveAttribute("href", "/login");
  });

  it("does not say 'Owner sign in' any more", () => {
    render(<AuthActions signedIn={false} />);
    expect(screen.queryByText(/owner sign in/i)).not.toBeInTheDocument();
  });

  it("offers a guest no sign-out control", () => {
    render(<AuthActions signedIn={false} />);
    expect(
      screen.queryByRole("button", { name: /sign out/i }),
    ).not.toBeInTheDocument();
  });

  it("shows 'Account' to a signed-in user, linking to the account section", () => {
    render(<AuthActions signedIn />);
    const link = screen.getByRole("link", { name: /account/i });
    expect(link).toHaveAttribute("href", "/settings#account");
  });

  it("keeps sign-out available to a signed-in user", () => {
    render(<AuthActions signedIn />);
    expect(
      screen.getByRole("button", { name: /sign out/i }),
    ).toBeInTheDocument();
  });

  it("shows a signed-in user no 'Sign in' link", () => {
    render(<AuthActions signedIn />);
    expect(
      screen.queryByRole("link", { name: /^sign in$/i }),
    ).not.toBeInTheDocument();
  });

  // Logout is a state change, so it must stay a POST (CSRF-safe) — see #21
  // P5 batch B. A GET link would be triggerable cross-site.
  it("signs out through a POST form, never a link", () => {
    render(<AuthActions signedIn />);
    const form = screen
      .getByRole("button", { name: /sign out/i })
      .closest("form");
    expect(form).not.toBeNull();
    expect(form).toHaveAttribute("method", "post");
    expect(form).toHaveAttribute("action", "/api/auth/logout");
  });

  it("gives both controls a visible keyboard focus ring (WCAG-AA)", () => {
    const { container } = render(<AuthActions signedIn />);
    for (const el of container.querySelectorAll("a, button")) {
      expect(el.className).toContain("focus-visible:");
    }
  });
});
