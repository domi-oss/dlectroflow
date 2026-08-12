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
    expect(host.querySelectorAll("div")).toHaveLength(0);
  });
});
