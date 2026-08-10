// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DemoSection } from "@/components/settings/demo-section";

// Split out of settings-panel.test.tsx by #101.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/app/actions/settings", () => ({
  updateFirstRunPreview: vi.fn().mockResolvedValue(undefined),
}));

import { updateFirstRunPreview } from "@/app/actions/settings";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe("DemoSection: first-run preview toggle", () => {
  it("auto-saves on toggle, calling updateFirstRunPreview(true) then (false)", async () => {
    const user = userEvent.setup();
    render(
      <DemoSection firstRunPreview={false} voice="plain" defaultExpanded />,
    );

    const toggle = screen.getByRole("checkbox", { name: /first-run preview/i });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    expect(updateFirstRunPreview).toHaveBeenCalledWith(true);

    await user.click(toggle);
    expect(updateFirstRunPreview).toHaveBeenCalledWith(false);
  });

  it("seeds from the stored preference", () => {
    render(<DemoSection firstRunPreview voice="plain" defaultExpanded />);
    expect(
      screen.getByRole("checkbox", { name: /first-run preview/i }),
    ).toBeChecked();
  });

  it("says the preview is non-destructive, where the checkbox is", () => {
    // It shows the app as a brand-new user sees it, which looks exactly like
    // "my data is gone". The reassurance has to be next to the control.
    render(
      <DemoSection firstRunPreview={false} voice="plain" defaultExpanded />,
    );
    expect(screen.getByText(/non-destructive/i)).toBeVisible();
  });

  it("rests collapsed like every other section (#101)", () => {
    render(<DemoSection firstRunPreview={false} voice="plain" />);
    expect(
      document.querySelector('[data-section-toggle="settings-demo"]'),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("checkbox", { name: /first-run preview/i }),
    ).toBeNull();
  });
});

/**
 * #227 — **the checkbox that kept a value the write never saved.**
 *
 * `toggleFirstRun` set `firstRun` optimistically and awaited
 * `updateFirstRunPreview` inside a transition with no `try`/`catch`, and this
 * was the one settings section that did not use `useSaveStatus` at all. So a
 * rejected write had nowhere to go — an unhandled rejection inside the
 * transition — and the checkbox sat there showing the value the server had
 * refused, with nothing on screen saying so, until the next server render.
 *
 * Both halves, and the second is the one that is easy to skip: **say so, and
 * put the control back.** Reporting alone leaves "couldn't save" beside a
 * checkbox still reading "on", which is a worse lie than the silent one — it
 * asks the user to choose between two things the page is telling them, and the
 * control looks more authoritative than the message.
 *
 * Same vocabulary as `!294`'s shopping switch and the four other sections:
 * `useSaveStatus` / `SaveIndicator`, deliberately NOT the shopping page's own
 * failure notice, which quotes the words at stake and offers a Retry — neither
 * of which means anything for a boolean.
 */
describe("DemoSection: when the toggle's write fails", () => {
  const checkbox = () =>
    screen.getByRole("checkbox", { name: /first-run preview/i });
  const failing = () =>
    vi
      .mocked(updateFirstRunPreview)
      .mockRejectedValueOnce(new Error("offline"));

  it("says the save failed rather than looking like it worked", async () => {
    failing();
    const user = userEvent.setup();
    render(
      <DemoSection firstRunPreview={false} voice="plain" defaultExpanded />,
    );
    await user.click(checkbox());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't save/i,
    );
  });

  it("puts the checkbox back where the server still has it", async () => {
    failing();
    const user = userEvent.setup();
    render(
      <DemoSection firstRunPreview={false} voice="plain" defaultExpanded />,
    );
    await user.click(checkbox());

    await waitFor(() => expect(checkbox()).not.toBeChecked());
  });

  it("rolls back the other direction too", async () => {
    failing();
    const user = userEvent.setup();
    render(<DemoSection firstRunPreview voice="plain" defaultExpanded />);
    await user.click(checkbox());

    await waitFor(() => expect(checkbox()).toBeChecked());
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  // A failed auto-save the user cannot retry by simply pressing again would be a
  // dead switch with an explanation beside it.
  it("clears the message and keeps the new value once a later save lands", async () => {
    failing();
    const user = userEvent.setup();
    render(
      <DemoSection firstRunPreview={false} voice="plain" defaultExpanded />,
    );
    await user.click(checkbox());
    await screen.findByRole("alert");
    await waitFor(() => expect(checkbox()).toBeEnabled());

    await user.click(checkbox());

    await waitFor(() => expect(checkbox()).toBeChecked());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(updateFirstRunPreview).toHaveBeenLastCalledWith(true);
  });

  it("says nothing at all when the save works", async () => {
    const user = userEvent.setup();
    render(
      <DemoSection firstRunPreview={false} voice="plain" defaultExpanded />,
    );
    await user.click(checkbox());

    await waitFor(() => expect(updateFirstRunPreview).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(checkbox()).toBeChecked();
  });

  /**
   * The rollback is a functional updater guarded on the value THIS attempt set,
   * so it can only ever undo its own optimistic write.
   *
   * Two attempts cannot actually interleave in this section — `disabled={pending}`
   * holds the checkbox shut for the whole write, so a slow failure has no newer
   * value to clobber. The guard is kept anyway, because the thing making it
   * unreachable is one `disabled` prop away from being removed, and a rollback
   * that trusts a closure is exactly the bug that replaces this one. The
   * interleaving itself is proved where it IS reachable: `revert-optimistic.test.ts`
   * and the notifications section, whose switches stay live during a save.
   *
   * What this asserts is the half that is reachable — the write stays shut until
   * it answers, and the value it puts back is the one the server still holds.
   */
  it("holds the control shut for the whole write, then restores the stored value", async () => {
    let rejectWrite!: (reason: Error) => void;
    vi.mocked(updateFirstRunPreview).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectWrite = reject;
        }),
    );

    const user = userEvent.setup();
    render(
      <DemoSection firstRunPreview={false} voice="plain" defaultExpanded />,
    );
    await user.click(checkbox()); // → true, and hangs there
    expect(checkbox()).toBeChecked();
    await waitFor(() => expect(checkbox()).toBeDisabled());

    rejectWrite(new Error("offline"));

    await waitFor(() => expect(checkbox()).not.toBeChecked());
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(checkbox()).toBeEnabled();
  });
});
