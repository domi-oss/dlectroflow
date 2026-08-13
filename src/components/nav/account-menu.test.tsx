// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { AccountMenu } from "./account-menu";
import { UserRole } from "@/lib/constants";
import type { AccountIdentity } from "@/lib/identity";

// next/link → plain <a>, the same idiom the other header specs use, so the
// popover's links resolve under vitest (no Next compiler).
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

/** The header's identity trigger, located the way a real user reaches it. */
const trigger = () => screen.getByRole("button", { name: /account:/i });

/** Open it and wait for Base UI to mount the popup (one tick — see #92). */
async function open(): Promise<HTMLElement> {
  await userEvent.click(trigger());
  return screen.findByRole("dialog");
}

describe("AccountMenu — the trigger", () => {
  // The owner's actual request (#100): "it would be great to see a name or
  // something in the corner if you're signed in." So the handle is VISIBLE at
  // rest, not only after a click.
  it("shows the handle without being opened", () => {
    render(<AccountMenu identity={OWNER} />);
    expect(trigger()).toHaveTextContent("gitlab_dlectronique");
  });

  // WCAG 2.5.3 (Label in Name): the visible words must be contained in the
  // accessible name, or voice control cannot address the control it can see.
  it("contains its visible text in its accessible name", () => {
    render(<AccountMenu identity={OWNER} />);
    expect(trigger()).toHaveAccessibleName(/gitlab_dlectronique/);
  });

  // #74's obligation on a POINTER user: hovering answers "which provider?"
  // without opening anything, and carries the full handle when it is truncated.
  it("names the provider on hover, via title", () => {
    render(<AccountMenu identity={OWNER} />);
    expect(trigger()).toHaveAttribute(
      "title",
      "Signed in as gitlab_dlectronique (GitLab)",
    );
  });

  it("is a real button with a 44x44 hit target and a focus ring", () => {
    render(<AccountMenu identity={OWNER} />);
    const el = trigger();
    expect(el.tagName).toBe("BUTTON");
    expect(el).not.toHaveAttribute("tabindex", "-1");
    // WCAG 2.5.5 — the shared `touchTarget` minimum, same as the theme toggle
    // and the menu trigger it sits between.
    expect(el.className).toContain("min-h-11");
    expect(el.className).toContain("min-w-11");
    expect(el.className).toContain("focus-visible:");
  });

  it("announces that it opens something, and whether it is open", async () => {
    render(<AccountMenu identity={OWNER} />);
    expect(trigger()).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    await open();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
  });

  // A long label must not be allowed to widen the header — the bar already
  // collides at phone widths (#72, #103). The cap is visual only; the popup and
  // the title still carry the whole thing.
  //
  // #252 tightened the phone cap to `max-w-16` (64px). The 16px it gave back is
  // the margin that lets the five-control bar fit a 360px viewport: measured
  // there, the cluster is 330px at an 80px cap against 328px of content width,
  // and 314px at a 64px one. `e2e/smoke/header-quick-access.spec.ts` is what
  // actually measures it; this only pins the class so the two cannot drift.
  it("caps the visible label's width, wider on desktop than on a phone", () => {
    render(
      <AccountMenu
        identity={{ ...OWNER, label: "a-very-long-provider-handle-indeed" }}
      />,
    );
    const label = screen.getByText("a-very-long-provider-handle-indeed");
    expect(label.className).toContain("truncate");
    expect(label.className).toContain("max-w-16");
    expect(label.className).toContain("sm:max-w-40");
  });
});

describe("AccountMenu — the popover", () => {
  it("is closed until asked for, so the provider line is not in the bar", () => {
    render(<AccountMenu identity={OWNER} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/signed in with/i)).not.toBeInTheDocument();
  });

  it("has an accessible name (axe aria-dialog-name)", async () => {
    render(<AccountMenu identity={OWNER} />);
    expect(await open()).toHaveAccessibleName("Account");
  });

  // #74's obligation: signing in with the wrong provider looks exactly like data
  // loss, so the provider must be discoverable on EVERY page, not only in
  // Settings. One click, from the header, in every state.
  it("names the provider and the role — owner", async () => {
    render(<AccountMenu identity={OWNER} />);
    const popup = await open();
    expect(popup).toHaveTextContent("Owner · signed in with GitLab");
  });

  it("names the provider and the role — member", async () => {
    render(<AccountMenu identity={MEMBER} />);
    const popup = await open();
    expect(popup).toHaveTextContent("Member · signed in with GitLab");
    expect(popup).not.toHaveTextContent(/owner/i);
  });

  it("shows the handle in full, uncapped, inside the popup", async () => {
    const long = "a-very-long-provider-handle-indeed";
    render(<AccountMenu identity={{ ...OWNER, label: long }} />);
    const popup = await open();
    const full = popup.querySelector("[data-account-label]");
    expect(full).not.toBeNull();
    expect(full).toHaveTextContent(long);
    expect(full!.className).not.toContain("truncate");
  });

  it("keeps the Account deep-link that the header used to hold", async () => {
    render(<AccountMenu identity={OWNER} />);
    const popup = await open();
    const link = screen.getByRole("link", { name: /account settings/i });
    expect(popup).toContainElement(link);
    expect(link).toHaveAttribute("href", "/settings#account");
  });

  // Logout is a state change → POST-only (CSRF-safe). Moving it into the
  // popover must not quietly turn it into a GET link (#21, P5 batch B).
  it("signs out through a POST form, never a link", async () => {
    render(<AccountMenu identity={OWNER} />);
    await open();
    const button = screen.getByRole("button", { name: /^sign out$/i });
    const form = button.closest("form");
    expect(form).not.toBeNull();
    expect(form).toHaveAttribute("method", "post");
    expect(form).toHaveAttribute("action", "/api/auth/logout");
    expect(
      screen.queryByRole("link", { name: /^sign out$/i }),
    ).not.toBeInTheDocument();
  });

  it("gives every entry a 44px-tall target and a focus ring", async () => {
    render(<AccountMenu identity={OWNER} />);
    const popup = await open();
    const entries = popup.querySelectorAll("a, button");
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const el of entries) {
      expect(el.className).toContain("min-h-11");
      expect(el.className).toContain("focus-visible:");
    }
  });
});

describe("AccountMenu — keyboard operation", () => {
  it("opens from the keyboard", async () => {
    render(<AccountMenu identity={OWNER} />);
    trigger().focus();
    expect(trigger()).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    render(<AccountMenu identity={OWNER} />);
    await open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });
});

describe("AccountMenu — what it must not publish", () => {
  // The component's whole input is an AccountIdentity, which identity.ts proves
  // carries no id and no email. This is the other end of that guarantee: nothing
  // in the rendered DOM may name anybody but the signed-in account.
  it("renders nothing beyond this account's own label, provider and role", async () => {
    const { container } = render(<AccountMenu identity={MEMBER} />);
    const popup = await open();
    const text = `${container.textContent ?? ""}${popup.textContent ?? ""}`;
    expect(text).toContain("dlectronique");
    expect(text).not.toMatch(/@/); // no email address anywhere
    expect(text).not.toMatch(/gitlab_dlectronique/); // no other account
  });
});

/**
 * #117 — a focus indicator faint enough that there is effectively none: **2.4.7
 * Focus Visible (AA)**, with the ring also clearing **2.4.13 Focus Appearance
 * (AAA)**. axe implements no rule for either, so no gate in the repo could see
 * that these entries' only focus treatment was `focus-visible:bg-accent` —
 * 1.09:1 against the popup surface in light, 1.24:1 in dark, where 1.4.11
 * Non-text Contrast (AA) asks 3:1 of the information identifying the state.
 *
 * The pairing with app-menu.tsx is the point of the issue, not a coincidence:
 * #117 was declined inside !192 because patching one of two popups that open
 * inches apart is worse than patching neither. So both entry kinds here — the
 * link and the submit button — and the app menu's links all assert the same
 * token.
 */
describe("AccountMenu — popup entries have a real focus indicator (#117)", () => {
  it("rings the link entry and the sign-out button alike", async () => {
    render(<AccountMenu identity={OWNER} />);
    const popup = await open();
    const link = screen.getByRole("link", { name: /account settings/i });
    const signOut = screen.getByRole("button", { name: /sign out/i });
    expect(popup).toContainElement(link);
    for (const entry of [link, signOut]) {
      expect(entry.className).toContain("focus-visible:inset-ring-2");
      expect(entry.className).toContain("focus-visible:inset-ring-ring");
    }
  });

  it("still swaps the background, so nothing about the hover look changes", async () => {
    render(<AccountMenu identity={OWNER} />);
    await open();
    const signOut = screen.getByRole("button", { name: /sign out/i });
    expect(signOut.className).toContain("hover:bg-accent");
    expect(signOut.className).toContain("focus-visible:bg-accent");
  });
});
