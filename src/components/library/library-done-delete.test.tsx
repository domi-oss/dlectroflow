// @vitest-environment jsdom
/**
 * #251 — the Library's Done tab had no controls at all.
 *
 * `LibraryRow` in library/page.tsx is a read-only server component: the
 * `plated`/`pantry` tabs render the interactive `<LibraryRows>` (delete
 * included) while Done rendered a static row, so a completed to-do could not be
 * removed from the hub either. This is the narrow client island that fixes it —
 * see the component's own doc comment for why it is not `<LibraryRows>`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  LibraryDoneDelete,
  LIB_PANEL_HEADING_ID,
  LIBRARY_ACTION_TIMEOUT_MS,
} from "./library-done-delete";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));
vi.mock("@/app/actions/braindump", () => ({
  deleteBrainDumpItem: vi.fn().mockResolvedValue(undefined),
}));

import { deleteBrainDumpItem } from "@/app/actions/braindump";

/**
 * The row in its panel. The heading is what `library/page.tsx` renders as the
 * panel's `aria-labelledby` target, and it is the element focus is handed to
 * once the row is gone — so a fixture without it would prove nothing about the
 * hand-off.
 */
function renderRow(id = "done-1") {
  return render(
    <section aria-labelledby={LIB_PANEL_HEADING_ID}>
      <p id={LIB_PANEL_HEADING_ID} tabIndex={-1}>
        Finished, for the record.
      </p>
      <ul>
        <li>
          <span>Reply to recruiter</span>
          <LibraryDoneDelete id={id} title="Reply to recruiter" voice="plain" />
        </li>
      </ul>
    </section>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("LibraryDoneDelete (#251)", () => {
  it("is a two-step confirm — the first press arms, the second deletes", async () => {
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(deleteBrainDumpItem).toHaveBeenCalledWith("done-1"),
    );
    // The hub's own read is what has to be refreshed: the action revalidates
    // the routes it knows about, not whichever one the press came from.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("Cancel disarms without deleting, and the control comes back", async () => {
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("names the resting icon control, which is otherwise a bare glyph", () => {
    renderRow();
    const control = screen.getByRole("button", { name: "Delete" });
    // The visible label is 🗑, so `aria-label` is the whole accessible name
    // (WCAG 4.1.2) and `title` is the pointer user's half of the same fact.
    expect(control).toHaveAttribute("aria-label", "Delete");
    expect(control).toHaveAttribute("title", "Delete");
  });

  it("clears the house 44px minimum, resting and armed", async () => {
    const user = userEvent.setup();
    renderRow();

    const resting = screen.getByRole("button", { name: "Delete" });
    expect(resting.className).toContain("min-h-11");
    expect(resting.className).toContain("min-w-11");

    await user.click(resting);
    for (const name of ["Delete", "Cancel"]) {
      const control = screen.getByRole("button", { name });
      expect(control.className, `"${name}" is under 44px tall`).toContain(
        "min-h-11",
      );
      expect(control.className, `"${name}" is under 44px wide`).toContain(
        "min-w-11",
      );
    }
  });

  it("hands focus to the panel heading rather than leaving it on <body>", async () => {
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    // The confirming button unmounts with the press and the row goes with the
    // refresh, so the browser has already dropped focus on <body> (WCAG 2.4.3).
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.getElementById(LIB_PANEL_HEADING_ID),
      ),
    );
  });

  it("does not take focus back from somewhere the user moved it", async () => {
    // Repair, not steal: a press that lands while the user has gone elsewhere
    // must leave them there. `document.activeElement` being anything but
    // <body> is the whole test — the hand-off is for focus that was lost.
    const user = userEvent.setup();
    renderRow();
    const elsewhere = document.createElement("button");
    elsewhere.textContent = "somewhere else";
    document.body.appendChild(elsewhere);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    elsewhere.focus();

    await waitFor(() => expect(deleteBrainDumpItem).toHaveBeenCalled());
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});

// ── #251 review — the failure path this component shipped without ──────────
//
// Every spec above mocks `deleteBrainDumpItem` as `mockResolvedValue(undefined)`,
// which is exactly why the gap survived: the success path was the only one that
// existed. `setConfirming(false)` runs synchronously, so the confirming button
// unmounts and the resting 🗑 comes back WHILE the write is still in flight — and
// with no `try`, a rejection propagated out of the transition as an unhandled
// rejection, `router.refresh()` and the focus hand-off never ran, and the user was
// left on `<body>` with nothing said and a live button that would start a second
// concurrent delete.
//
// This is the failure class #210 and #225 exist for. The notice follows
// `focus-timer.tsx`'s shape rather than the inbox/shopping `errorSave*` matrix,
// because that matrix's whole purpose is the `rowGone` dimension — a write that
// needs a row to act on becomes un-retryable once the row vanishes. For a DELETE
// the row being gone is the goal, not a failure, so those cells could never be
// honestly selected. See the component's doc comment.
describe("LibraryDoneDelete — when the write does not land (#251)", () => {
  const arm = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
  };

  it("announces a rejection in an alert that names the item, and offers a retry", async () => {
    const user = userEvent.setup();
    vi.mocked(deleteBrainDumpItem).mockRejectedValueOnce(new Error("offline"));
    renderRow();

    await arm(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn't delete/i);
    // Naming the row is the point: the Done pile is uncapped, so "it failed" with
    // no subject leaves the user guessing which of forty rows it was about.
    expect(alert).toHaveTextContent(/Reply to recruiter/);
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
  });

  it("puts focus on the notice rather than leaving it on <body>", async () => {
    const user = userEvent.setup();
    vi.mocked(deleteBrainDumpItem).mockRejectedValueOnce(new Error("offline"));
    renderRow();

    await arm(user);

    // The confirming button unmounted with the press, so the browser has already
    // dropped focus. A notice nobody is sent to is a notice a keyboard user never
    // meets (WCAG 2.4.3).
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /try again/i }),
      ),
    );
  });

  it("does not steal focus back from somewhere the user moved it", async () => {
    const user = userEvent.setup();
    let reject: (e: Error) => void = () => {};
    vi.mocked(deleteBrainDumpItem).mockReturnValueOnce(
      new Promise<void>((_, r) => {
        reject = r;
      }),
    );
    renderRow();
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);

    await arm(user);
    elsewhere.focus();
    await act(async () => {
      reject(new Error("offline"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("retrying re-posts the delete and clears the notice when it lands", async () => {
    const user = userEvent.setup();
    vi.mocked(deleteBrainDumpItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    renderRow();

    await arm(user);
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(deleteBrainDumpItem).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(refresh).toHaveBeenCalled();
  });

  it("offers a reload and no retry when the bundle is from another deployment", async () => {
    // A stale action id cannot be re-posted: the running deployment has forgotten
    // it, so a Retry is a button whose only outcome is the message already shown.
    const user = userEvent.setup();
    // The marker `isStaleActionError` actually recognises — a digest string is
    // not one of them, and using one would have made this pass on the generic
    // cell while claiming to test the stale one.
    const stale = Object.assign(new Error("stale"), {
      name: "UnrecognizedActionError",
    });
    vi.mocked(deleteBrainDumpItem).mockRejectedValueOnce(stale);
    renderRow();

    await arm(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(/reload/i);
    expect(
      screen.getByRole("button", { name: /reload the page/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("keeps the polite announcer rendered and empty until there is a wait to announce", async () => {
    // #218's shape: a live region that first appears WITH its message is silent,
    // because assistive technology announces a change to a region already in the
    // tree. It is also a SIBLING of the alert, never inside it — politeness
    // applies to a whole subtree, so a polite region nested in an assertive one
    // is just the assertive one re-reading itself.
    const user = userEvent.setup();
    vi.mocked(deleteBrainDumpItem).mockRejectedValueOnce(new Error("offline"));
    renderRow();

    await arm(user);
    await screen.findByRole("alert");

    const announcer = screen.getByTestId("library-delete-announcer");
    expect(announcer).toHaveTextContent("");
    expect(announcer.closest('[role="alert"]')).toBeNull();
  });

  it("a second press while the write is in flight does not start a second delete", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    vi.mocked(deleteBrainDumpItem).mockReturnValueOnce(
      new Promise<void>((r) => {
        settle = () => r();
      }),
    );
    renderRow();

    await arm(user);
    // The confirm has collapsed and the resting control is back on screen, which
    // is what made this reachable at all. Its accessible name now carries the
    // busy reason, because `aria-disabled`/`disabled` would drop focus.
    const resting = screen.getByRole("button", { name: /^Delete/ });
    expect(resting).toHaveAttribute("aria-busy", "true");
    await user.click(resting);
    await user.click(screen.getByRole("button", { name: /^Delete/ }));

    expect(deleteBrainDumpItem).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle();
      await Promise.resolve();
    });
  });

  it("announces the wait and refuses the press for a SECOND attempt, not only a Retry", async () => {
    // #251 review — the announced wait was gated on `failure.retrying`, which is
    // only raised by the Retry button. A user who has met the notice once and goes
    // back to the 🗑 they already know takes the other route to the same state:
    // the confirm collapses, the write runs, and the notice re-renders with a
    // Retry reading `aria-disabled="false"` that silently eats the press, with
    // nothing announcing that anything is happening. `focus-timer.tsx` gates the
    // same three things on `pending` and has no such hole.
    const user = userEvent.setup();
    let settle: () => void = () => {};
    vi.mocked(deleteBrainDumpItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(
        new Promise<void>((r) => {
          settle = () => r();
        }),
      );
    renderRow();

    await arm(user);
    await screen.findByRole("alert");

    // Back to the 🗑, not the Retry: arm, then confirm.
    await user.click(screen.getByRole("button", { name: /^Delete/ }));
    await user.click(screen.getByRole("button", { name: /^Delete/ }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /try again/i }),
      ).toHaveAttribute("aria-disabled", "true"),
    );
    // The wait is SAID, not just implied by a greyed button.
    expect(screen.getByTestId("library-delete-announcer")).toHaveTextContent(
      /trying again/i,
    );
    // And the description retracts to it, so a user landing on the control hears
    // why it is refusing them.
    const retry = screen.getByRole("button", { name: /try again/i });
    const described = (retry.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(described).toMatch(/trying again/i);

    await act(async () => {
      settle();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it("still hands focus to the heading when the 🗑 was armed again mid-flight", async () => {
    // #251 review — the state the single-flight guard exists to serve, which the
    // hand-off could not survive.
    //
    // `confirm()` collapses the confirm and the resting 🗑 is live again while the
    // write runs (deliberately — `inFlight` is what refuses a second delete, not
    // `disabled`, because a disabled element cannot hold focus). So a user on a
    // slow write taps 🗑 again, which ARMS the confirm even though it starts no
    // second delete. React then reconciles the resting `<span>` against the
    // confirming `<span>`, reuses the node and DETACHES `rootRef` — the confirming
    // branch never carried it — so `rootRef.current` is null exactly while focus
    // is sitting inside the subtree it is supposed to be measuring.
    // `focusIsOursToMove()` collapses to "is focus on <body>", which it is not,
    // the hand-off is skipped, and `router.refresh()` then unmounts the row out
    // from under the user. That is the WCAG 2.4.3 fault `7405bed` was written to
    // close, reached from the one press this control is designed to tolerate.
    const user = userEvent.setup();
    let settle: () => void = () => {};
    vi.mocked(deleteBrainDumpItem).mockReturnValueOnce(
      new Promise<void>((r) => {
        settle = () => r();
      }),
    );
    renderRow();

    await user.click(screen.getByRole("button", { name: /^Delete/ })); // arm
    await user.click(screen.getByRole("button", { name: /^Delete/ })); // confirm
    // The second tap. It re-arms and starts nothing — asserted, so this stays a
    // test about focus rather than about double-writes.
    await user.click(screen.getByRole("button", { name: /^Delete/ }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(deleteBrainDumpItem).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.getElementById(LIB_PANEL_HEADING_ID),
      ),
    );
  });

  it("says the verdict is unknown when the write never answers", async () => {
    // A timeout is not a failure: the delete may well have landed, so the copy
    // must not claim it did not. Retry stays on offer here — unlike the inbox and
    // shopping surfaces, re-posting a delete that already landed is a no-op that
    // reaches the state the user asked for, so the button cannot mislead.
    vi.useFakeTimers();
    vi.mocked(deleteBrainDumpItem).mockReturnValueOnce(
      new Promise<void>(() => {}),
    );
    renderRow();

    await act(async () => {
      screen.getByRole("button", { name: /^Delete/ }).click();
      await Promise.resolve();
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Delete/ }).click();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(LIBRARY_ACTION_TIMEOUT_MS);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/no answer from the server/i);
    expect(alert).toHaveTextContent(/may already have been deleted/i);
    expect(alert.textContent).not.toMatch(/nothing changed/i);
  });
});
