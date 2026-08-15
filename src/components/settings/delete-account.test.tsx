// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";

/**
 * #153 — the member-facing erasure control.
 *
 * Three things are being defended here, and only the first is ordinary UI:
 *
 *  • IT IS NOT A ONE-CLICK BUTTON. The trigger opens a dialog, and the dialog's
 *    confirm control stays disabled until the word is typed. Two deliberate
 *    acts, because the cost of the accidental one is somebody's account.
 *  • IT IS A REAL DIALOG. `role="alertdialog"`, focus moves in, Escape and
 *    Cancel both get you out, and focus returns to the trigger. `confirm()`
 *    would have satisfied "a confirmation step" and none of that.
 *  • THE COPY IS THE FEATURE. What is destroyed, what is kept, for how long,
 *    and the one part that is not automatic yet — asserted, because a wording
 *    change that quietly turns the honest sentence into a promise is exactly
 *    the regression nobody reviews for.
 */
const { deleteMock, replaceMock, refreshMock } = vi.hoisted(() => ({
  deleteMock: vi.fn(),
  replaceMock: vi.fn(),
  refreshMock: vi.fn(),
}));
vi.mock("@/app/actions/account", () => ({ deleteOwnAccount: deleteMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, refresh: refreshMock }),
}));

import { DeleteAccount } from "./delete-account";

beforeEach(() => {
  vi.clearAllMocks();
  deleteMock.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

type Props = React.ComponentProps<typeof DeleteAccount>;

const props: Props = { isOwner: false, purgeGraceDays: 30 };

/** A member's view of the section — the only one with a control on it. */
function renderMember(overrides: Partial<Props> = {}) {
  render(<DeleteAccount {...props} {...overrides} />);
}

/** The trigger, located the way a member reaches it. */
const trigger = () =>
  screen.getByRole("button", { name: /delete my account/i });

/** Open the dialog and wait for Base UI to mount it. */
async function open(): Promise<HTMLElement> {
  await userEvent.click(trigger());
  return screen.findByRole("alertdialog");
}

/** The confirm control INSIDE the dialog — the trigger shares its wording. */
function confirmButton(dialog: HTMLElement): HTMLButtonElement {
  const [button] = Array.from(
    dialog.querySelectorAll<HTMLButtonElement>("button"),
  ).filter((b) => /delete my account/i.test(b.textContent ?? ""));
  return button;
}

describe("DeleteAccount — the owner", () => {
  it("gets no delete control at all", () => {
    // Same refusal revokePerson makes, and for the same reason. The action
    // enforces it too; this is so the owner is never shown a control that can
    // only fail.
    renderMember({ isOwner: true });
    expect(
      screen.queryByRole("button", { name: /delete my account/i }),
    ).not.toBeInTheDocument();
  });

  it("is told why, rather than shown nothing", () => {
    renderMember({ isOwner: true });
    expect(screen.getByText(/only account that can manage/i)).toBeVisible();
  });
});

describe("DeleteAccount — the confirmation is a real dialog", () => {
  beforeEach(() => renderMember());

  it("opens an alertdialog with an accessible name", async () => {
    const dialog = await open();
    expect(dialog).toHaveAccessibleName(/delete your account/i);
  });

  it("moves focus into the dialog when it opens", async () => {
    const dialog = await open();
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    await open();
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(trigger()).toHaveFocus();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("closes on Cancel without deleting anything", async () => {
    const dialog = await open();
    await userEvent.click(
      Array.from(dialog.querySelectorAll("button")).find((b) =>
        /cancel/i.test(b.textContent ?? ""),
      )!,
    );
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(deleteMock).not.toHaveBeenCalled();
  });
});

describe("DeleteAccount — a deliberate act, not one click", () => {
  beforeEach(() => renderMember());

  it("keeps the confirm control disabled until the word is typed", async () => {
    const dialog = await open();
    expect(confirmButton(dialog)).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/type/i), "delete");
    expect(confirmButton(dialog)).toBeEnabled();
  });

  it("stays disabled for a near miss", async () => {
    const dialog = await open();
    await userEvent.type(screen.getByLabelText(/type/i), "delet");
    expect(confirmButton(dialog)).toBeDisabled();
  });

  it("accepts the word whatever a phone capitalised it to", async () => {
    // A confirmation that fails because the on-screen keyboard capitalised the
    // first letter is a confirmation that teaches people to distrust it.
    const dialog = await open();
    await userEvent.type(screen.getByLabelText(/type/i), "  Delete ");
    expect(confirmButton(dialog)).toBeEnabled();
  });

  it("deletes, then leaves the page the deleted account was on", async () => {
    const dialog = await open();
    await userEvent.type(screen.getByLabelText(/type/i), "delete");
    await userEvent.click(confirmButton(dialog));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    // No argument: the action derives the account from the session, and the
    // panel has no id to hand it even if it wanted to.
    expect(deleteMock).toHaveBeenCalledWith();
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/"));
    expect(refreshMock).toHaveBeenCalled();
  });

  it("submits once for repeated Enter presses while the request is in flight", async () => {
    // Duo review on !237: the confirm button carries `disabled={!confirmed ||
    // pending}` and the field's Enter handler only ever checked `confirmed`, so
    // the keyboard path could start a second delete while the first was still
    // running. The second one arrives after the session cookie is already gone,
    // comes back `not_signed_in`, and paints a "you are no longer signed in"
    // error over a deletion that in fact succeeded. Both paths go through
    // `submit()`, so the guard belongs there rather than being spelled twice.
    let release: (value: { ok: true }) => void = () => {};
    deleteMock.mockReturnValue(
      new Promise<{ ok: true }>((resolve) => {
        release = resolve;
      }),
    );

    await open();
    const field = screen.getByLabelText(/type/i);
    await userEvent.type(field, "delete");

    await userEvent.type(field, "{Enter}");
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    await userEvent.type(field, "{Enter}");
    await userEvent.type(field, "{Enter}");

    expect(deleteMock).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a refusal in an alert and stays put", async () => {
    // Reachable when the role changed under the open dialog: the server is the
    // gate, not this component.
    deleteMock.mockResolvedValue({ ok: false, error: "owner_cannot_delete" });
    const dialog = await open();
    await userEvent.type(screen.getByLabelText(/type/i), "delete");
    await userEvent.click(confirmButton(dialog));

    expect(await screen.findByRole("alert")).toHaveTextContent(/owner/i);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("reports a failed request rather than looking like it worked", async () => {
    deleteMock.mockRejectedValue(new Error("offline"));
    const dialog = await open();
    await userEvent.type(screen.getByLabelText(/type/i), "delete");
    await userEvent.click(confirmButton(dialog));

    expect(await screen.findByRole("alert")).toHaveTextContent(/again/i);
    expect(replaceMock).not.toHaveBeenCalled();
  });
});

describe("DeleteAccount — what the confirmation says", () => {
  beforeEach(() => renderMember());

  it("states that you are signed out and cannot sign back in", async () => {
    const dialog = await open();
    expect(dialog).toHaveTextContent(/signed out/i);
    expect(dialog).toHaveTextContent(/cannot sign back in/i);
  });

  it("states that the Google grant is withdrawn at Google, not just here", async () => {
    // #126 — worded exactly as the People panel and /privacy word it: the
    // tokens here are always deleted, the grant at Google's end is a request.
    const dialog = await open();
    expect(dialog).toHaveTextContent(/asks Google to revoke/i);
  });

  it("names the recovery window, in days", async () => {
    const dialog = await open();
    expect(dialog).toHaveTextContent(/30 days/);
  });

  it("takes the window from its prop rather than hardcoding a number", async () => {
    cleanup();
    renderMember({ purgeGraceDays: 45 });
    const dialog = await open();
    expect(dialog).toHaveTextContent(/45 days/);
  });

  it("says what is KEPT, not only what goes", async () => {
    const dialog = await open();
    expect(dialog).toHaveTextContent(/invitation/i);
    expect(dialog).toHaveTextContent(/backup/i);
  });

  it("does not promise an automatic deletion the app does not perform", async () => {
    // `User.purgeAfter` is written and never read — prisma/scheduled-purge.ts
    // sweeps guest workspaces and guest counters only. /privacy has said so
    // since #123 ("Being honest about a gap"), and this dialog must not be the
    // place that quietly starts claiming otherwise.
    //
    // `/by hand/i` ALONE could not do that job, and this test is the proof:
    // the copy it was written against also said "After that they are deleted"
    // one clause earlier, so the dialog promised an automatic purge AND denied
    // one, and this assertion passed on the half that was true. A review round
    // caught it in the prose, not here. So the negative is asserted too — that
    // is what makes this a guard rather than a spot-check.
    const dialog = await open();
    expect(dialog).toHaveTextContent(/by hand/i);
    expect(
      dialog,
      "the dialog is promising a deletion at the end of the window; nothing performs one",
    ).not.toHaveTextContent(/after that (they|it) (are|is) deleted/i);
    expect(dialog).toHaveTextContent(/nothing deletes the content/i);
  });

  it("does not rely on colour alone to say the action is destructive", async () => {
    // WCAG 1.4.1. The word does the work; the red is decoration on top of it.
    const dialog = await open();
    expect(dialog).toHaveTextContent(/permanent/i);
    expect(confirmButton(dialog)).toHaveAccessibleName(/delete my account/i);
  });
});
