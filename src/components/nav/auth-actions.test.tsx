// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { AuthActions } from "./auth-actions";
import { UserRole } from "@/lib/constants";
import type { AccountIdentity } from "@/lib/identity";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    className,
  }: {
    children: ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

const OWNER: AccountIdentity = {
  label: "gitlab_dlectronique",
  provider: "GitLab",
  role: UserRole.Owner,
};
const MEMBER: AccountIdentity = {
  label: "dlectronique",
  provider: "GitLab",
  role: UserRole.Member,
};

// #35 Phase A made this component stop being owner-specific ("Owner sign in" →
// "Sign in" / "Account"). #100 makes the signed-in half say WHO: the anonymous
// word "Account" is replaced by the account's own handle, which is also the
// trigger for the identity popover (see account-menu.tsx). Three states, and a
// guest is deliberately one of them — their branch is byte-for-byte the one that
// shipped, so the zero-tolerance guest contrast gate keeps gating the same DOM.
describe("AuthActions — guest", () => {
  it("shows 'Sign in' to a guest", () => {
    render(<AuthActions identity={null} />);
    const link = screen.getByRole("link", { name: /sign in/i });
    expect(link).toHaveAttribute("href", "/login");
  });

  it("does not say 'Owner sign in' any more", () => {
    render(<AuthActions identity={null} />);
    expect(screen.queryByText(/owner sign in/i)).not.toBeInTheDocument();
  });

  it("offers a guest no sign-out control", () => {
    render(<AuthActions identity={null} />);
    expect(
      screen.queryByRole("button", { name: /sign out/i }),
    ).not.toBeInTheDocument();
  });

  // A guest has no account, so there is no identity to reveal and no popover to
  // open — not an empty one.
  it("gives a guest no identity control at all", () => {
    render(<AuthActions identity={null} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText(/signed in with/i)).not.toBeInTheDocument();
  });

  it("gives the guest link a visible keyboard focus ring (WCAG-AA)", () => {
    const { container } = render(<AuthActions identity={null} />);
    for (const el of container.querySelectorAll("a, button")) {
      expect(el.className).toContain("focus-visible:");
    }
  });
});

describe("AuthActions — signed in", () => {
  it("names the account in the header instead of the anonymous word 'Account'", () => {
    render(<AuthActions identity={OWNER} />);
    expect(
      screen.getByRole("button", { name: /account: gitlab_dlectronique/i }),
    ).toBeInTheDocument();
    // The bare word on its own is gone: it said nothing about WHICH account,
    // which is the whole of #100.
    expect(
      screen.queryByRole("link", { name: /^account$/i }),
    ).not.toBeInTheDocument();
  });

  it("names a member's own account, not the owner's", () => {
    render(<AuthActions identity={MEMBER} />);
    expect(
      screen.getByRole("button", { name: /account: dlectronique/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("gitlab_dlectronique")).not.toBeInTheDocument();
  });

  it("shows a signed-in user no 'Sign in' link", () => {
    render(<AuthActions identity={OWNER} />);
    expect(
      screen.queryByRole("link", { name: /^sign in$/i }),
    ).not.toBeInTheDocument();
  });

  // Sign-out moved one click deeper (into the identity popover) rather than
  // disappearing. It is still reachable, and still a POST.
  it("keeps sign-out reachable, still as a POST form", async () => {
    render(<AuthActions identity={OWNER} />);
    await userEvent.click(
      screen.getByRole("button", { name: /account: gitlab_dlectronique/i }),
    );
    await screen.findByRole("dialog");
    const form = screen
      .getByRole("button", { name: /^sign out$/i })
      .closest("form");
    expect(form).toHaveAttribute("method", "post");
    expect(form).toHaveAttribute("action", "/api/auth/logout");
  });

  // The reason this is one control and not three (#100: "without adding a sixth
  // element if avoidable"): the header bar is already collision-prone at 390px.
  it("contributes ONE element to the header, not three", () => {
    const { container } = render(<AuthActions identity={OWNER} />);
    expect(container.children).toHaveLength(1);
  });
});
