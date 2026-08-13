// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MoveToMenu } from "./move-to-menu";

afterEach(cleanup);

// #92 — the menu is now a Base UI `Menu`, which mounts its popup one tick after
// the trigger is pressed (it measures the popup against the viewport before
// painting it). Queries for its contents are therefore `findBy`/`waitFor`, not
// synchronous `getBy`. That is the only reason these tests changed shape; every
// assertion below is the one that was here before, plus the a11y wiring the
// hand-rolled version did not have.
const openMenu = async (name: string) => {
  await userEvent.click(screen.getByRole("button", { name }));
  return screen.findByRole("menu");
};

describe("MoveToMenu", () => {
  it("opens and lists the other buckets, excluding the current one", async () => {
    render(
      <MoveToMenu currentBucket="singleTask" voice="plain" onMove={vi.fn()} />,
    );
    await openMenu("Move to");
    expect(
      await screen.findByRole("menuitem", { name: /Needs review/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /Multi-step/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /Saved for later/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /Completed/ }),
    ).toBeInTheDocument();
    // current bucket is excluded
    expect(
      screen.queryByRole("menuitem", { name: /Single-task/ }),
    ).not.toBeInTheDocument();
  });

  it("calls onMove with the chosen bucket id", async () => {
    const onMove = vi.fn();
    render(
      <MoveToMenu currentBucket="singleTask" voice="plain" onMove={onMove} />,
    );
    await openMenu("Move to");
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Completed/ }),
    );
    expect(onMove).toHaveBeenCalledWith("completed");
  });

  // #253 — there is no longer a text variant to distinguish this from: the ▾ lists
  // name their destinations directly, so `MoveToMenu` is the inline 📥 only and the
  // `compact` prop went with the branch. The assertion is unchanged and is the one
  // that matters — the icon carries an accessible name, because a bare glyph does
  // not, and it still opens the bucket list.
  it("renders a 📥 icon trigger named 'Move to', not bare text, and opens the bucket list", async () => {
    render(
      <MoveToMenu currentBucket="singleTask" voice="plain" onMove={vi.fn()} />,
    );
    expect(
      screen.queryByRole("button", { name: "Move to…" }),
    ).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Move to" });
    expect(trigger).toHaveTextContent("📥");
    await userEvent.click(trigger);
    expect(
      await screen.findByRole("menuitem", { name: /Needs review/ }),
    ).toBeInTheDocument();
  });

  it("calls onMove with the chosen bucket id from the icon trigger", async () => {
    const onMove = vi.fn();
    render(
      <MoveToMenu currentBucket="singleTask" voice="plain" onMove={onMove} />,
    );
    await openMenu("Move to");
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Completed/ }),
    );
    expect(onMove).toHaveBeenCalledWith("completed");
  });

  it("Escape closes the open menu", async () => {
    render(
      <MoveToMenu currentBucket="singleTask" voice="plain" onMove={vi.fn()} />,
    );
    await openMenu("Move to");
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
  });

  it("clicking outside closes the menu without moving", async () => {
    const onMove = vi.fn();
    render(
      <div>
        <button type="button">outside</button>
        <MoveToMenu currentBucket="singleTask" voice="plain" onMove={onMove} />
      </div>,
    );
    await openMenu("Move to");
    await userEvent.click(screen.getByRole("button", { name: "outside" }));
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(onMove).not.toHaveBeenCalled();
  });

  // ── #92 a11y wiring ───────────────────────────────────────────────────────
  // Preserved (aria-haspopup/aria-expanded) or newly correct (aria-controls,
  // roving focus, focus restored on dismiss). Asserted because the fix replaced
  // the element that carried them.
  it("the trigger advertises the menu it controls, and only while it is open", async () => {
    render(
      <MoveToMenu currentBucket="singleTask" voice="plain" onMove={vi.fn()} />,
    );
    const trigger = screen.getByRole("button", { name: "Move to" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", menu.id);
  });

  it("is operable from the keyboard alone, and hands focus back to the trigger on dismiss", async () => {
    const onMove = vi.fn();
    render(
      <MoveToMenu currentBucket="singleTask" voice="plain" onMove={onMove} />,
    );
    const trigger = screen.getByRole("button", { name: "Move to" });
    trigger.focus();
    // ArrowDown on a menu button opens the menu with its first entry
    // highlighted — the entry the old markup left permanently off screen.
    await userEvent.keyboard("{ArrowDown}");
    await screen.findByRole("menu");
    await waitFor(() =>
      expect(
        screen.getByRole("menuitem", { name: /Needs review/ }),
      ).toHaveAttribute("data-highlighted"),
    );
    await userEvent.keyboard("{Enter}");
    expect(onMove).toHaveBeenCalledWith("needsReview");
    // Focus must not be left on a detached popup element.
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  // The row popup must never render a `<div>`: MoveToMenu is used inside
  // phrasing content (row titles, meta lines), where a `<div>` would be invalid
  // markup and, inside a `<p>`, would close the paragraph early.
  it("renders only phrasing-content elements, so it is valid wherever a row uses it", async () => {
    const { container } = render(
      <MoveToMenu currentBucket="singleTask" voice="plain" onMove={vi.fn()} />,
    );
    await openMenu("Move to");
    const host = container.firstElementChild!;
    // Guard the guard: an empty host has zero `div`s as well, so this passed
    // vacuously if the trigger ever stopped opening. Prove the menu rendered into
    // this host before asserting what it did NOT render.
    expect(
      host.querySelectorAll('[role="menuitem"]').length,
      "the Move-to menu did not open, so the phrasing-content check saw nothing",
    ).toBeGreaterThan(0);
    expect(host.querySelectorAll("div")).toHaveLength(0);
  });
});

/**
 * #253 — `Single-task to-dos` is suppressed for an item that HAS steps, because it
 * is not a destination such an item can reach.
 *
 * This is the SAME defect hidden on the Multi-step row's ▾ in the same MR, on a
 * second surface — one sweep rather than two issues. `moveItemToBucket(id,
 * "singleTask")` dispatches `triage`, which clears `breakdownRequestedAt` but leaves
 * the steps; `bucketOfItem` returns `multiStep` for any triaged item with
 * `stepsTotal > 1`. So the row does not move, while `movedAnnouncement` tells a
 * screen-reader user it landed in Single-task.
 *
 * ── The reachability path, traced link by link before this guard was written ──
 *
 * The menu only renders on the idle Saved row and the Done row, so a steps-bearing
 * item has to GET to one of those. It can:
 *
 *  1. A Multi-step row (`stepsTotal > 1`) offers `Send back to review`.
 *  2. `moveToReview` writes `status: Inbox`, `triagedAt: null`, `snoozedUntil: null`,
 *     `breakdownRequestedAt: null` — and touches **neither the Task nor its steps**,
 *     so `stepsTotal` (`task?.steps.length`) survives.
 *  3. `bucketOfItem` → `needsReview` (Inbox, not snoozed, not completed).
 *  4. That row offers `Save for later` → `snooze` → `snoozedUntil` in the future.
 *     (Step 2 clearing the snooze does not break the chain; this re-sets it.)
 *  5. `bucketOfItem` → `savedLater`, still `stepsTotal > 1`.
 *  6. The idle Saved row renders this menu **unconditionally** — no steps check —
 *     and `BUCKET_ORDER` minus `savedLater` includes `singleTask`.
 *  7. Press it → `triage` → `status: Triaged`, `snoozedUntil` NOT cleared.
 *  8. `bucketOfItem` → `multiStep`. The announcement said Single-task.
 *
 * Four deliberate steps, so unlikely rather than unreachable — and every link was
 * read rather than assumed, because a guard against a state nothing can enter is
 * worse than no guard.
 *
 * `stepsTotal === 1` is deliberately NOT suppressed: `bucket.ts` states that "a
 * one-step task IS a single to-do (its step exists so ▶ Focus has a target); only 2+
 * steps make it multi-step", so for that item the move genuinely works. The
 * threshold here is the same `> 1` the bucket split uses, and not `>= 1`.
 */
describe("MoveToMenu — Single-task is suppressed for a steps-bearing item (#253)", () => {
  const targets = async () =>
    (await screen.findAllByRole("menuitem")).map((el) => el.textContent);

  it("omits Single-task when the item has 2+ steps", async () => {
    render(
      <MoveToMenu
        currentBucket="savedLater"
        stepsTotal={3}
        voice="plain"
        onMove={vi.fn()}
      />,
    );
    await openMenu("Move to");
    expect(
      screen.queryByRole("menuitem", { name: /Single-task/ }),
      "a steps-bearing item was offered a bucket it cannot reach",
    ).not.toBeInTheDocument();
    // The other three are untouched — the suppression is one target, not a rewrite
    // of the list. Asserted as an exact set so a broader filter reds here.
    expect(await targets()).toEqual([
      "Needs review",
      "Multi-step to-dos",
      "Completed",
    ]);
  });

  it("keeps Single-task for a stepless item, where the move works", async () => {
    render(
      <MoveToMenu
        currentBucket="savedLater"
        stepsTotal={0}
        voice="plain"
        onMove={vi.fn()}
      />,
    );
    await openMenu("Move to");
    expect(
      await screen.findByRole("menuitem", { name: /Single-task/ }),
    ).toBeInTheDocument();
  });

  it("keeps it for a ONE-step item too — that is a single to-do by definition", async () => {
    render(
      <MoveToMenu
        currentBucket="savedLater"
        stepsTotal={1}
        voice="plain"
        onMove={vi.fn()}
      />,
    );
    await openMenu("Move to");
    expect(
      await screen.findByRole("menuitem", { name: /Single-task/ }),
    ).toBeInTheDocument();
  });

  it("defaults to offering it when the caller says nothing about steps", async () => {
    // Back-compatible: the prop is optional, and its absence must not silently
    // suppress a legitimate destination.
    render(
      <MoveToMenu currentBucket="savedLater" voice="plain" onMove={vi.fn()} />,
    );
    await openMenu("Move to");
    expect(
      await screen.findByRole("menuitem", { name: /Single-task/ }),
    ).toBeInTheDocument();
  });

  it("still dispatches the targets it does offer", async () => {
    const onMove = vi.fn();
    render(
      <MoveToMenu
        currentBucket="savedLater"
        stepsTotal={3}
        voice="plain"
        onMove={onMove}
      />,
    );
    await openMenu("Move to");
    await userEvent.click(screen.getByRole("menuitem", { name: /Multi-step/ }));
    expect(onMove).toHaveBeenCalledWith("multiStep");
  });
});
