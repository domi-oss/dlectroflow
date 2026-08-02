// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// #118 Phase C — the panel that writes a member's own LLM key. The rule the
// tests below keep returning to: the key goes IN and never comes back out. The
// panel is handed a boolean, the field is cleared on success, and no outcome
// message ever echoes what was typed.
const { saveMock, removeMock, refreshMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  removeMock: vi.fn(),
  refreshMock: vi.fn(),
}));
// `deleteOwnAccount` is here because the panel REACHES it, not because this
// file exercises it: `AccountPanel` renders `DeleteAccount` whenever `isOwner`
// is false, and that pulls the export in from this same module. A factory mock
// replaces the module wholesale, so an omission is `undefined` rather than the
// real function. Passes either way today; the cost lands on whoever first opens
// the dialog here and gets "not a function" instead of a failing assertion.
// Second site of the same miss — see section-headings.test.tsx (!237).
vi.mock("@/app/actions/account", () => ({
  saveOwnLlmKey: saveMock,
  removeOwnLlmKey: removeMock,
  deleteOwnAccount: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

import { AccountPanel } from "./account-panel";

beforeEach(() => {
  vi.clearAllMocks();
  saveMock.mockResolvedValue({ ok: true });
  removeMock.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

const props = {
  handle: "alice",
  provider: "gitlab",
  keyPresent: false,
  activeModelName: "claude-sonnet-4-6",
  // #153 — a MEMBER by default: the delete control is the member's, and the
  // owner's refusal has its own specs in delete-account.test.tsx.
  isOwner: false,
  purgeGraceDays: 30,
  defaultExpanded: true,
} as const;

describe("AccountPanel", () => {
  it("names the signed-in account and the provider that authenticated it", () => {
    // #74 — the provider has to be stated wherever identity is shown, and
    // CurrentUser.provider carries the one this account was PROVISIONED under.
    render(<AccountPanel {...props} />);
    expect(screen.getByText(/alice/)).toBeInTheDocument();
    expect(screen.getByText(/gitlab/i)).toBeInTheDocument();
  });

  it("falls back gracefully when the provider withheld a username", () => {
    // AuthProfile.username is optional, so handle is genuinely nullable.
    render(<AccountPanel {...props} handle={null} />);
    expect(screen.getByText(/gitlab/i)).toBeInTheDocument();
  });

  it("labels the key field and masks what is typed", async () => {
    render(<AccountPanel {...props} />);
    const field = screen.getByLabelText(/api key/i);
    expect(field).toHaveAttribute("type", "password");
    // Off, all of it: a secret must not land in a browser's autofill store or
    // be corrected into something else.
    expect(field).toHaveAttribute("autocomplete", "off");
    expect(field).toHaveAttribute("spellcheck", "false");
    await userEvent.type(field, "sk-ant-secret");
    expect(field).toHaveValue("sk-ant-secret");
  });

  it("names which model and provider the key will be used against", () => {
    // The one thing a user cannot discover: their key is used against the
    // INSTANCE's configured provider. There is deliberately no base-URL field.
    render(<AccountPanel {...props} />);
    expect(screen.getByText(/claude-sonnet-4-6/)).toBeInTheDocument();
  });

  it("saves the key and clears the field afterwards", async () => {
    render(<AccountPanel {...props} />);
    await userEvent.type(screen.getByLabelText(/api key/i), "sk-ant-secret");
    await userEvent.click(screen.getByRole("button", { name: /^save/i }));
    expect(saveMock).toHaveBeenCalledWith("sk-ant-secret");
    // Leaving a secret in a mounted input is a shoulder-surfing and screenshot
    // problem for no benefit — it is stored, not editable.
    expect(screen.getByLabelText(/api key/i)).toHaveValue("");
  });

  it("announces success without ever echoing the key", async () => {
    render(<AccountPanel {...props} />);
    await userEvent.type(screen.getByLabelText(/api key/i), "sk-ant-secret");
    await userEvent.click(screen.getByRole("button", { name: /^save/i }));
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/saved/i);
    expect(status).not.toHaveTextContent("sk-ant-secret");
  });

  it("reports a rejected key in the same place, and keeps what was typed", async () => {
    saveMock.mockResolvedValue({ ok: false, error: "invalid_key" });
    render(<AccountPanel {...props} />);
    await userEvent.type(screen.getByLabelText(/api key/i), "sk-nope");
    await userEvent.click(screen.getByRole("button", { name: /^save/i }));
    expect(screen.getByRole("status")).toHaveTextContent(
      /not accepted|invalid/i,
    );
    // Not cleared on failure — clearing a rejected value forces a re-paste.
    expect(screen.getByLabelText(/api key/i)).toHaveValue("sk-nope");
  });

  it("reports a lost session distinctly from a bad key", async () => {
    // "Invalid key" for an expired session sends the user hunting for a problem
    // in their key that isn't there.
    saveMock.mockResolvedValue({ ok: false, error: "not_signed_in" });
    render(<AccountPanel {...props} />);
    await userEvent.type(screen.getByLabelText(/api key/i), "sk-ant-secret");
    await userEvent.click(screen.getByRole("button", { name: /^save/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/sign(ed)? in/i);
  });

  it("refuses to submit an empty field without calling the server", async () => {
    render(<AccountPanel {...props} />);
    await userEvent.click(screen.getByRole("button", { name: /^save/i }));
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("shows a key is stored WITHOUT showing any part of it", () => {
    render(<AccountPanel {...props} keyPresent />);
    expect(screen.getByText(/your own key is in use/i)).toBeInTheDocument();
    expect(screen.queryByText(/sk-/)).toBeNull();
  });

  it("says what a stored key actually changes", () => {
    // consumeUserBreakdown's rule 1 in plain words: a present key pays for that
    // account's breakdowns, so no instance cap applies. Scoped to the in-use
    // sentence — the field's hint says the same thing to someone who has no key
    // yet, and asserting on the page would match either.
    render(<AccountPanel {...props} keyPresent />);
    expect(screen.getByText(/your own key is in use/i).textContent).toMatch(
      /no instance usage limit/i,
    );
  });

  it("confirms before removing a stored key, and says what happens next", async () => {
    render(<AccountPanel {...props} keyPresent />);
    await userEvent.click(screen.getByRole("button", { name: /^remove/i }));
    expect(removeMock).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(/instance/i);
    await userEvent.click(screen.getByRole("button", { name: /yes, remove/i }));
    expect(removeMock).toHaveBeenCalled();
  });

  it("offers no Remove control when there is no key", () => {
    render(<AccountPanel {...props} />);
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("gives every control a 44x44 hit target (WCAG 2.5.5)", () => {
    render(<AccountPanel {...props} keyPresent />);
    for (const name of [/^save/i, /^remove/i]) {
      expect(
        screen.getByRole("button", { name }).className,
        String(name),
      ).toContain("min-h-11");
    }
  });

  it("is fully operable from the keyboard", async () => {
    render(<AccountPanel {...props} />);
    const field = screen.getByLabelText(/api key/i);
    field.focus();
    await userEvent.keyboard("sk-ant-secret");
    await userEvent.tab();
    expect(screen.getByRole("button", { name: /^save/i })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(saveMock).toHaveBeenCalledWith("sk-ant-secret");
  });

  it("does not leave focus on <body> after the remove confirmation resolves", async () => {
    render(<AccountPanel {...props} keyPresent />);
    await userEvent.click(screen.getByRole("button", { name: /^remove/i }));
    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(removeMock).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(document.body);
  });
});
