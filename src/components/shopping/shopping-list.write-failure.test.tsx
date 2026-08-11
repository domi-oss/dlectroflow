// @vitest-environment jsdom
/**
 * #246 / #236 — the two defects the shopping list's write-failure notice carried
 * on `main`, and the behaviour that replaces them.
 *
 * A separate file from `shopping-list.test.tsx` for two reasons. It is the shape
 * `!306` used for the same subject on the inbox
 * (`inbox-view.write-failure.test.tsx`), and `shopping-list.test.tsx` is `!320`'s
 * file — a second MR editing it would collide for no benefit, since nothing here
 * needs that file's fixtures.
 *
 * `write-notice-hygiene.test.ts` is the guard that stops this pair recurring on a
 * fourth surface. These are the specs that say what the fix actually does, which
 * a string-table guard cannot see: the notice's own words and the live region they
 * arrive in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, cleanup } from "@testing-library/react";
import {
  ShoppingList,
  SHOPPING_ACTION_TIMEOUT_MS,
} from "@/components/shopping/shopping-list";

const WROTE = { ok: true } as const;

const { addMock, renameMock, doneMock, savedMock, deleteMock, refreshMock } =
  vi.hoisted(() => ({
    addMock: vi.fn().mockResolvedValue({ ok: true }),
    renameMock: vi.fn().mockResolvedValue({ ok: true }),
    doneMock: vi.fn().mockResolvedValue({ ok: true }),
    savedMock: vi.fn().mockResolvedValue({ ok: true }),
    deleteMock: vi.fn().mockResolvedValue({ ok: true }),
    refreshMock: vi.fn(),
  }));

vi.mock("@/app/actions/shopping", () => ({
  addShoppingItem: addMock,
  renameShoppingItem: renameMock,
  setShoppingItemDone: doneMock,
  setShoppingItemSavedForLater: savedMock,
  deleteShoppingItem: deleteMock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

type Items = Parameters<typeof ShoppingList>[0]["items"];

const item = (over: Partial<Items[number]> = {}): Items[number] => ({
  id: "a",
  text: "Apples",
  done: false,
  savedForLater: false,
  order: 1,
  ...over,
});

/** Same flush budget as `shopping-list.test.tsx` and `inbox-view.test.tsx`. */
const flushTicks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of [addMock, renameMock, doneMock, savedMock, deleteMock]) {
    mock.mockReset();
    mock.mockResolvedValue(WROTE);
  }
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const RETRY = /try again/i;
const RELOAD = /reload/i;

/**
 * A tick that hangs past the timeout, leaving a failure whose verdict is unknown
 * and whose target is a row the caller can then take off the list.
 */
const hangingTick = async () => {
  doneMock.mockReturnValueOnce(new Promise(() => {}));
  const view = render(<ShoppingList items={[item()]} voice="plain" />);
  await act(async () => {
    screen.getByRole("checkbox", { name: /tick off apples/i }).click();
    await flushTicks();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SHOPPING_ACTION_TIMEOUT_MS);
  });
  return view;
};

describe("a timed-out write on a row that has since gone (#246)", () => {
  beforeEach(() => vi.useFakeTimers());

  /**
   * `writeFailureKey` put `timedOut` above `rowGone`, which is right on its own: a
   * timeout cannot support "nothing changed", because the row may be absent
   * BECAUSE the write it is unsure about landed. `writeFailureRemedy` put
   * `rowGone` first, which is also right on its own: every one of these actions is
   * a `findFirst`-then-write against a row id, so a row the list no longer holds
   * makes each of them a no-op again, every time.
   *
   * Both right, and together incoherent — "check the list before trying again"
   * printed above no button to try again with. The copy is the half that had to
   * move, because the button is the half that cannot: retrying either re-posts a
   * write that already landed or matches nothing, and both settle as a silent
   * success that clears the notice. A false "saved this time" is worse than the
   * dead end it would replace.
   */
  it("stops telling the user to try again, because there is nothing left to press", async () => {
    const { rerender } = await hangingTick();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /check the list before trying again/i,
    );

    // The refresh that took the row off the list is not this write's — the
    // failure path never refreshes — so this is the page observing, independently,
    // that the row has gone.
    await act(async () => {
      rerender(<ShoppingList items={[]} voice="plain" />);
      await flushTicks();
    });

    const alert = screen.getByRole("alert");
    expect(alert).not.toHaveTextContent(/trying again/i);
    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
    expect(screen.queryByRole("button", { name: RELOAD })).toBeNull();
  });

  it("keeps saying what it does not know, and never hardens into “nothing changed”", async () => {
    const { rerender } = await hangingTick();
    await act(async () => {
      rerender(<ShoppingList items={[]} voice="plain" />);
      await flushTicks();
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/no answer from the server/i);
    expect(alert).toHaveTextContent(/may already have saved/i);
    // The one claim a timeout can never make: the row may be absent precisely
    // because the write landed.
    expect(alert).not.toHaveTextContent(/nothing changed/i);
  });

  it("says the row has gone, and still names the item it was about", async () => {
    const { rerender } = await hangingTick();
    await act(async () => {
      rerender(<ShoppingList items={[]} voice="plain" />);
      await flushTicks();
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/not on the list any more/i);
    expect(alert).toHaveTextContent(/Apples/);
  });

  /**
   * The regression this MR is named for. While the row is still rendered the
   * Retry is real, so the copy that asks for one is right — the new cell must not
   * swallow the ordinary timeout.
   */
  it("leaves the ordinary timeout alone while the row is still on the list", async () => {
    await hangingTick();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/check the list before trying again/i);
    expect(alert).not.toHaveTextContent(/not on the list any more/i);
    expect(screen.getByRole("button", { name: RETRY })).toBeInTheDocument();
  });

  /**
   * A refusal and a timeout are mutually exclusive by construction — `declineWrite`
   * sets `timedOut: false` — so a server that says `missing` still gets the copy
   * that can honestly claim nothing changed.
   */
  it("does not take over the server's own “that row is gone” answer", async () => {
    vi.useRealTimers();
    doneMock.mockResolvedValueOnce({ ok: false, refused: "missing" });
    render(<ShoppingList items={[item()]} voice="plain" />);
    await act(async () => {
      screen.getByRole("checkbox", { name: /tick off apples/i }).click();
      await flushTicks();
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/nothing changed/i);
    expect(alert).not.toHaveTextContent(/no answer from the server/i);
  });

  /**
   * WCAG 4.1.3, and the defect a sibling MR found on another surface: two live
   * regions describing opposite outcomes of the same write, contradicting each
   * other. This page has no polite confirmation region at all, and the timeout
   * path never reaches `setError`, so the notice is the only thing that speaks —
   * asserted rather than assumed, because "there is no other region" is exactly
   * the sort of claim that quietly stops being true.
   */
  it("speaks from one region, with nothing to contradict it", async () => {
    const { rerender } = await hangingTick();
    await act(async () => {
      rerender(<ShoppingList items={[]} voice="plain" />);
      await flushTicks();
    });

    // One alert, not two: the capture field's own refusal slot stays empty,
    // because a timeout is not a refusal.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    // The only other live region is the wait announcer, and no retry is running.
    for (const status of screen.getAllByRole("status", { hidden: true }))
      expect(status).toHaveTextContent("");
  });
});

describe("the retry wait reaches a screen reader (#236)", () => {
  /**
   * `aria-describedby` cannot carry this alone. A description is computed when
   * focus LANDS on a control, and Retry is pressed on a control that already holds
   * focus and keeps it by design (`aria-disabled`, not `disabled`), so the value
   * gaining `savingId` mid-flight is a change nothing goes back to re-read.
   */
  const failThenRetry = async () => {
    doneMock.mockRejectedValueOnce(new Error("offline"));
    render(<ShoppingList items={[item()]} voice="plain" />);
    await act(async () => {
      screen.getByRole("checkbox", { name: /tick off apples/i }).click();
      await flushTicks();
    });
    const notice = await screen.findByRole("alert");
    doneMock.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => {
      screen.getByRole("button", { name: RETRY }).click();
      await flushTicks();
    });
    return notice;
  };

  /**
   * Rendered with the notice and EMPTY until there is something to say: assistive
   * technology announces a CHANGE to a region already in the accessibility tree,
   * so a region arriving together with its first message is silent.
   */
  it("mounts the announcer empty, before any retry", async () => {
    doneMock.mockRejectedValueOnce(new Error("offline"));
    render(<ShoppingList items={[item()]} voice="plain" />);
    await act(async () => {
      screen.getByRole("checkbox", { name: /tick off apples/i }).click();
      await flushTicks();
    });
    await screen.findByRole("alert");

    const announcer = screen.getByTestId("shopping-saving-announcer");
    expect(announcer).toBeInTheDocument();
    expect(announcer).toHaveTextContent("");
    expect(announcer).toHaveAttribute("aria-live", "polite");
    expect(announcer).toHaveAttribute("aria-atomic", "true");
    expect(announcer).toHaveClass("sr-only");
  });

  it("announces the wait from a region, once the retry is in flight", async () => {
    await failThenRetry();
    expect(screen.getByTestId("shopping-saving-announcer")).toHaveTextContent(
      /saving/i,
    );
  });

  /**
   * A SIBLING of the alert, never a descendant. A polite region nested inside an
   * assertive one inherits the container's politeness across its whole subtree, so
   * it does not announce politely — it makes the alert re-read itself, which is
   * #218's original bug rather than a fix for it.
   */
  it("puts the announcer outside the alert, not inside it", async () => {
    const notice = await failThenRetry();
    expect(notice).not.toContainElement(
      screen.getByTestId("shopping-saving-announcer"),
    );
  });

  /**
   * One sentence in two nodes is how it gets said twice — and a VISIBLE child
   * appearing inside an assertive, atomic alert mid-retry re-reads the whole
   * notice over the polite announcement. Nothing changes on screen.
   */
  it("keeps the sighted copy, hidden from the accessibility tree", async () => {
    const notice = await failThenRetry();
    const visible = screen.getByTestId("shopping-saving-visible");
    expect(notice).toContainElement(visible);
    expect(visible).toHaveAttribute("aria-hidden", "true");
    // Still on screen: this is an a11y fix, not a visual change.
    expect(visible).toHaveTextContent(/saving/i);
  });

  /**
   * The Retry keeps pointing at the announcer, so the mirror-image path still
   * works: a notice that mounts with a retry already in flight moves focus nowhere,
   * and the description is what a screen reader reads when the user arrives at the
   * button.
   */
  it("leaves the Retry's description resolving to real text", async () => {
    await failThenRetry();
    const retry = screen.getByRole("button", { name: RETRY });
    const ids = (retry.getAttribute("aria-describedby") ?? "").split(" ");
    const announcerId = screen.getByTestId("shopping-saving-announcer").id;
    expect(ids).toContain(announcerId);
    expect(announcerId).not.toBe("");
  });
});
