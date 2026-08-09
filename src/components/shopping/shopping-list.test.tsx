// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MAX_SHOPPING_ITEMS,
  SHOPPING_ITEM_TEXT_MAX_LENGTH,
} from "@/lib/shopping";
import {
  ShoppingList,
  SHOPPING_ACTION_TIMEOUT_MS,
} from "@/components/shopping/shopping-list";

/**
 * #199 — the shopping list surface.
 *
 * The assertions worth having here are the ones about what this page is NOT: no
 * estimate, no "break into steps", no schedule, no focus affordance. Those are
 * the four things every other list in this app offers, and a row that grew one
 * would put a shopping item into machinery the model deliberately keeps it out of.
 */

/**
 * Duo review round 5, !294 — the actions answer `{ ok: true }` now, not
 * `undefined`. That IS the fix under test: "it resolved" and "it wrote" used to
 * be the same signal, so a mock resolving to nothing would keep asserting the
 * behaviour the round removed.
 */
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

const item = (
  over: Partial<Parameters<typeof ShoppingList>[0]["items"][number]>,
) => ({
  id: "s1",
  text: "Milk",
  done: false,
  savedForLater: false,
  order: 1,
  ...over,
});

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const renderList = (items: Parameters<typeof ShoppingList>[0]["items"] = []) =>
  render(<ShoppingList items={items} voice="plain" />);

/**
 * `fireEvent` rather than `userEvent`: some specs below drive fake timers, and
 * userEvent's own timer plumbing has to be wired to them separately. Same
 * precedent, and the same flush budget, as `inbox-view.test.tsx`.
 *
 * Module scope rather than inside one `describe`, because the two blocks that
 * need them — a write that failed and a write the server refused — are siblings,
 * and two copies of a flush budget is how they drift apart.
 */
const flushTicks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
const flush = () => act(async () => flushTicks());

const addViaField = async (value: string) => {
  const field = screen.getByLabelText(/add to the list/i);
  fireEvent.change(field, { target: { value } });
  fireEvent.submit(field.closest("form")!);
  await flush();
  return field;
};

const clickRetry = () =>
  act(async () => {
    screen.getByRole("button", { name: /try again/i }).click();
    await flushTicks();
  });

describe("capturing", () => {
  it("adds the typed text and clears the field", async () => {
    renderList();
    const field = screen.getByLabelText(/add to the list/i);
    await userEvent.type(field, "oat milk");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(addMock).toHaveBeenCalledWith("oat milk");
    expect(field).toHaveValue("");
  });

  it("refuses a blank submit visibly, and does not call the action", async () => {
    renderList();
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(addMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /type something first/i,
    );
  });

  it("says the entry is too long rather than truncating it", async () => {
    renderList();
    const field = screen.getByLabelText(/add to the list/i);
    // `paste` rather than `type`: 201 keystrokes is a slow test for no extra
    // coverage, and paste is how an over-long entry actually arrives.
    await userEvent.click(field);
    await userEvent.paste("x".repeat(SHOPPING_ITEM_TEXT_MAX_LENGTH + 1));
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(addMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/200 characters/i);
  });

  it("marks the field invalid and points at the message (WCAG 3.3.1)", async () => {
    renderList();
    const field = screen.getByLabelText(/add to the list/i);
    expect(field).not.toHaveAttribute("aria-invalid", "true");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(field).toHaveAttribute("aria-invalid", "true");
    const describedBy = field.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent(
      /type something first/i,
    );
  });

  it("clears the error once the field is being used again", async () => {
    renderList();
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/add to the list/i), "M");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refuses to add past the cap, and says why", async () => {
    const full = Array.from({ length: MAX_SHOPPING_ITEMS }, (_, i) =>
      item({ id: `s${i}`, text: `thing ${i}`, order: i + 1 }),
    );
    renderList(full);
    await userEvent.type(screen.getByLabelText(/add to the list/i), "one more");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(addMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/full at 500 items/i);
  });
});

describe("the two sections", () => {
  it("puts un-saved items under To buy, in capture order", () => {
    renderList([
      item({ id: "b", text: "Bread", order: 2 }),
      item({ id: "a", text: "Apples", order: 1 }),
    ]);
    const active = screen.getByRole("region", { name: /to buy/i });
    const texts = within(active)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(texts[0]).toContain("Apples");
    expect(texts[1]).toContain("Bread");
  });

  it("shows a count of what is still to buy, excluding ticked and saved rows", () => {
    renderList([
      item({ id: "a", text: "Apples" }),
      item({ id: "b", text: "Bread", done: true }),
      item({ id: "c", text: "Cheese", savedForLater: true }),
    ]);
    expect(
      screen.getByRole("region", { name: /to buy/i }),
    ).toHaveAccessibleName(/1 item still to buy/i);
  });

  it("keeps a ticked item where it is rather than moving it", () => {
    renderList([item({ id: "a", text: "Apples", done: true })]);
    const active = screen.getByRole("region", { name: /to buy/i });
    expect(within(active).getByText("Apples")).toBeInTheDocument();
  });

  it("renders the saved-for-later section only when something is in it", () => {
    const { unmount } = renderList([item({ id: "a" })]);
    expect(
      screen.queryByRole("region", { name: /saved for later/i }),
    ).not.toBeInTheDocument();
    unmount();
    renderList([item({ id: "a", savedForLater: true })]);
    expect(
      screen.getByRole("region", { name: /saved for later/i }),
    ).toBeInTheDocument();
  });

  it("says nothing here comes back on its own", () => {
    renderList([item({ id: "a", savedForLater: true })]);
    expect(
      within(
        screen.getByRole("region", { name: /saved for later/i }),
      ).getByText(/comes back on its own/i),
    ).toBeInTheDocument();
  });

  it("shows an empty state instead of a bare heading", () => {
    renderList();
    expect(screen.getByText(/nothing on the list yet/i)).toBeInTheDocument();
  });
});

describe("row controls", () => {
  it("ticks and un-ticks", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(screen.getByRole("checkbox", { name: /apples/i }));
    expect(doneMock).toHaveBeenCalledWith("a", true);
    cleanup();
    renderList([item({ id: "a", text: "Apples", done: true })]);
    await userEvent.click(screen.getByRole("checkbox", { name: /apples/i }));
    expect(doneMock).toHaveBeenCalledWith("a", false);
  });

  it("moves an item down to saved for later, and back up again", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /save for later: apples/i }),
    );
    expect(savedMock).toHaveBeenCalledWith("a", true);
    cleanup();
    renderList([item({ id: "a", text: "Apples", savedForLater: true })]);
    await userEvent.click(
      screen.getByRole("button", { name: /move back to the list: apples/i }),
    );
    expect(savedMock).toHaveBeenCalledWith("a", false);
  });

  it("deletes", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /delete apples/i }),
    );
    expect(deleteMock).toHaveBeenCalledWith("a");
  });

  it("renames in place, on Enter", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    const field = screen.getByRole("textbox", { name: /rename apples/i });
    await userEvent.clear(field);
    await userEvent.type(field, "Braeburns{Enter}");
    expect(renameMock).toHaveBeenCalledWith("a", "Braeburns");
  });

  it("abandons a rename on Escape without writing", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: /rename apples/i }),
      "Pears{Escape}",
    );
    expect(renameMock).not.toHaveBeenCalled();
    expect(screen.getByText("Apples")).toBeInTheDocument();
  });

  // Duo review, !294 — a rename had no validation and no feedback: an over-long or
  // blanked value called the action, which returned silently, and the row simply
  // reverted with no explanation. That is the exact "a silent no-op looks like a
  // lost item" failure this component's own docblock warns about for the Add flow,
  // so the two flows now share one validator.
  it("refuses an over-long rename visibly, and keeps the editor open", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    const field = screen.getByRole("textbox", { name: /rename apples/i });
    await userEvent.clear(field);
    await userEvent.paste("x".repeat(SHOPPING_ITEM_TEXT_MAX_LENGTH + 1));
    await userEvent.keyboard("{Enter}");
    expect(renameMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/200 characters/i);
    // Still editing: dropping back to the old text would throw away what they
    // typed as well as failing silently.
    expect(
      screen.getByRole("textbox", { name: /rename apples/i }),
    ).toBeInTheDocument();
  });

  it("refuses a blanked rename visibly rather than reverting", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    const field = screen.getByRole("textbox", { name: /rename apples/i });
    await userEvent.clear(field);
    await userEvent.type(field, "   {Enter}");
    expect(renameMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /type something first/i,
    );
  });

  it("clears a rename refusal once the value changes", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    const field = screen.getByRole("textbox", { name: /rename apples/i });
    await userEvent.clear(field);
    await userEvent.type(field, "  {Enter}");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.type(field, "Braeburns");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  /**
   * Found while fixing the two round-4 findings, and the same fault one level
   * down from the one round 3 fixed: `editError` is a single slot shared by every
   * row, so opening a DIFFERENT row's editor while a refusal was showing carried
   * that refusal across — the new field rendered `aria-invalid="true"` and pointed
   * `aria-describedby` at a message about the row above it. Which is verbatim what
   * the comment on `editError` says the state exists to prevent, so the file
   * contradicted itself.
   */
  it("does not carry one row's refusal into another row's editor", async () => {
    renderList([
      item({ id: "a", text: "Apples" }),
      item({ id: "b", text: "Bread", order: 2 }),
    ]);
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    const fieldA = screen.getByRole("textbox", { name: /rename apples/i });
    await userEvent.clear(fieldA);
    await userEvent.type(fieldA, "  {Enter}");
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: /rename bread/i }),
    );
    const fieldB = screen.getByRole("textbox", { name: /rename bread/i });
    expect(fieldB).not.toHaveAttribute("aria-invalid", "true");
    expect(fieldB).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("abandons a refused rename on Escape, taking the message with it", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    const field = screen.getByRole("textbox", { name: /rename apples/i });
    await userEvent.clear(field);
    await userEvent.type(field, "  {Enter}");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Apples")).toBeInTheDocument();
  });

  // Duo review round 2, !294 — while a row is being edited the Rename trigger was
  // still rendered right after the textbox it opened, so two controls carried the
  // identical accessible name "Rename Apples" at once and a keyboard user tabbing
  // out of the field landed on a button that re-opens the editor already open.
  it("hides the Rename trigger while that row's editor is open", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    expect(
      screen.getByRole("button", { name: /rename apples/i }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    // Exactly one control named "Rename Apples" remains, and it is the textbox.
    expect(screen.queryByRole("button", { name: /rename apples/i })).toBeNull();
    expect(
      screen.getByRole("textbox", { name: /rename apples/i }),
    ).toBeInTheDocument();
  });

  it("brings the trigger back when the editor closes", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    await userEvent.keyboard("{Escape}");
    expect(
      screen.getByRole("button", { name: /rename apples/i }),
    ).toBeInTheDocument();
  });

  it("leaves ANOTHER row's trigger alone while one row is being edited", () => {
    // The control for the rule above: hiding every trigger would be a different bug.
    renderList([
      item({ id: "a", text: "Apples" }),
      item({ id: "b", text: "Bread", order: 2 }),
    ]);
    expect(
      screen.getByRole("button", { name: /rename bread/i }),
    ).toBeInTheDocument();
  });

  it("names the item in every control, so a screen-reader list is usable", () => {
    renderList([item({ id: "a", text: "Apples" })]);
    // "Delete" twelve times over is what this is guarding against.
    for (const name of [
      /delete apples/i,
      /rename apples/i,
      /save for later: apples/i,
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });
});

describe("what this page deliberately does not offer", () => {
  it("has no estimate, breakdown, schedule or focus control", () => {
    renderList([item({ id: "a", text: "Apples" })]);
    // Queried as CONTROLS, not as text: the intro copy names all four in order to
    // say the page does not have them, so a text query would find the sentence
    // promising their absence and call it a failure.
    for (const pattern of [
      /break into steps/i,
      /snack-size/i,
      /schedule/i,
      /focus/i,
      /estimate/i,
      /minutes/i,
    ]) {
      expect(screen.queryByRole("button", { name: pattern })).toBeNull();
      expect(screen.queryByRole("link", { name: pattern })).toBeNull();
      expect(screen.queryByRole("spinbutton", { name: pattern })).toBeNull();
    }
    // The row's whole control surface, enumerated: tick, rename, save, delete and
    // the capture field's Add. Anything else on a row is a new affordance that
    // has to be argued for, and this is where it shows up.
    expect(
      screen
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent),
    ).toEqual([
      "Add",
      "Rename Apples",
      "Save for later: Apples",
      "Delete Apples",
    ]);
  });

  it("says so on the page, so the absence reads as deliberate", () => {
    renderList();
    expect(screen.getByText(/does not touch your streak/i)).toBeInTheDocument();
  });
});

/**
 * Duo review round 4, !294 (raised on the review scaffold !297) — closing the
 * rename editor unmounted the focused `<input>` with no hand-off, so the browser
 * dropped focus to `<body>` and a keyboard or screen-reader user lost their place
 * on the page the instant they finished editing (WCAG 2.4.3 Focus Order).
 *
 * The file already reasoned carefully about focus on the way IN (`autoFocus`, and
 * hiding the trigger rather than disabling it); this is the same reasoning applied
 * to the way out. Asserted as real focus, not a snapshot: the whole defect is
 * invisible in markup.
 */
describe("focus when the rename editor closes", () => {
  const openEditor = async () => {
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    return screen.getByRole("textbox", { name: /rename apples/i });
  };

  it("hands focus back to the trigger on Escape", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await openEditor();
    await userEvent.keyboard("{Escape}");
    expect(
      screen.getByRole("button", { name: /rename apples/i }),
    ).toHaveFocus();
  });

  it("hands focus back to the trigger when the rename saves", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    const field = await openEditor();
    await userEvent.clear(field);
    await userEvent.type(field, "Braeburns{Enter}");
    expect(renameMock).toHaveBeenCalledWith("a", "Braeburns");
    expect(
      screen.getByRole("button", { name: /rename apples/i }),
    ).toHaveFocus();
  });

  // The third exit: Enter on an unchanged value is a no-op that still closes the
  // editor, so it drops focus exactly like the other two and is easy to miss.
  it("hands focus back to the trigger when an unchanged value just closes it", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    const field = await openEditor();
    await userEvent.type(field, "{Enter}");
    expect(renameMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /rename apples/i }),
    ).toHaveFocus();
  });

  // The control for the rule above: a refused rename keeps the editor open, so
  // moving focus would take the user away from the field holding the value they
  // still have to fix.
  it("leaves focus in the field when the rename is refused", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    const field = await openEditor();
    await userEvent.clear(field);
    await userEvent.type(field, "  {Enter}");
    expect(
      screen.getByRole("textbox", { name: /rename apples/i }),
    ).toHaveFocus();
  });

  // The other control: switching straight to another row's editor is not a close,
  // and yanking focus back to the first row's trigger would fight the autoFocus
  // the user just asked for.
  it("does not steal focus back when another row's editor is opened", async () => {
    renderList([
      item({ id: "a", text: "Apples" }),
      item({ id: "b", text: "Bread", order: 2 }),
    ]);
    await openEditor();
    await userEvent.click(
      screen.getByRole("button", { name: /rename bread/i }),
    );
    expect(
      screen.getByRole("textbox", { name: /rename bread/i }),
    ).toHaveFocus();
  });
});

/**
 * Duo review round 4, !294 (raised on the review scaffold !297) — `run()` awaited
 * the action with no `catch`, so a genuine server or database failure in add,
 * rename, tick, save-for-later or delete gave the user nothing at all: the item
 * simply did not appear or change. That is this component's own docblock warning
 * come true — "a silent no-op looks exactly like a lost item" — and for an add it
 * is worse than a no-op, because `submit()` clears the field first.
 *
 * Modelled on #210's inbox capture notice, deliberately, so the app's two capture
 * surfaces fail the same way: the same three-way stale / timed-out / generic
 * split from `server-action-failure.ts`, the same `role="alert"` notice quoting
 * the words, the same `aria-disabled` (never `disabled`) Retry.
 */
describe("when a write fails", () => {
  /**
   * `vi.clearAllMocks()` in the global beforeEach drops recorded calls but NOT a
   * queued `mockRejectedValueOnce`, so each spec here resets the queue and puts
   * the resolving default back rather than leaving a rejection for the next one.
   */
  beforeEach(() => {
    for (const mock of [addMock, renameMock, doneMock, savedMock, deleteMock]) {
      mock.mockReset();
      mock.mockResolvedValue(WROTE);
    }
  });
  afterEach(() => vi.useRealTimers());

  /** What Next 16's client throws when the action id is from another build. */
  const staleActionError = () =>
    Object.assign(
      new Error(
        'Server Action "40bef5efc6c80527f80d35d95a902c7e0bc4056eb0" was not found on the server.',
      ),
      { name: "UnrecognizedActionError" },
    );

  it("says the add failed instead of losing it silently", async () => {
    addMock.mockRejectedValueOnce(new Error("offline"));
    renderList();
    await addViaField("oat milk");

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(/couldn't save that/i);
    // The words are IN the notice, not only in a variable: that is what makes
    // them recoverable however the field has moved on.
    expect(notice).toHaveTextContent(/oat milk/);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("puts the cleared words back in the capture field", async () => {
    addMock.mockRejectedValueOnce(new Error("offline"));
    renderList();
    const field = await addViaField("oat milk");
    expect(field).toHaveValue("oat milk");
  });

  // The restore must never become a second kind of data loss: a ten-second hang
  // is long enough to type the next thing, and overwriting THAT is the same bug
  // wearing the other hat.
  it("does not clobber words typed while the failed add was still in flight", async () => {
    let rejectWrite!: (reason: unknown) => void;
    addMock.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectWrite = reject;
      }),
    );
    renderList();
    const field = screen.getByLabelText(/add to the list/i);
    fireEvent.change(field, { target: { value: "oat milk" } });
    fireEvent.submit(field.closest("form")!);
    await flush();
    fireEvent.change(field, { target: { value: "bread" } });
    await act(async () => {
      rejectWrite(new Error("offline"));
      await flushTicks();
    });

    expect(field).toHaveValue("bread");
    expect(await screen.findByRole("alert")).toHaveTextContent(/oat milk/);
  });

  it("retries the exact write that failed, and drops the notice once it lands", async () => {
    addMock.mockRejectedValueOnce(new Error("offline"));
    renderList();
    await addViaField("oat milk");
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    await clickRetry();

    expect(addMock).toHaveBeenCalledTimes(2);
    expect(addMock).toHaveBeenLastCalledWith("oat milk");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(refreshMock).toHaveBeenCalled();
  });

  it("a stale deployment offers a reload and no Retry, which could never work", async () => {
    addMock.mockRejectedValueOnce(staleActionError());
    renderList();
    await addViaField("oat milk");

    expect(await screen.findByRole("alert")).toHaveTextContent(/app updated/i);
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("says a timed-out write MAY have landed, rather than asserting it did not", async () => {
    vi.useFakeTimers();
    addMock.mockReturnValueOnce(new Promise(() => {}));
    renderList();
    await addViaField("oat milk");
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHOPPING_ACTION_TIMEOUT_MS);
    });

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent(/may already have saved/i);
    expect(notice).not.toHaveTextContent(/couldn't save that/i);
    // Retry stays: a duplicate line on a shopping list is one tap to delete,
    // whereas an item that never landed is noticed at the checkout.
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
  });

  // Not just the add. Every row control goes through the same `run()`, and a
  // tick or a delete that silently does nothing is the identical failure.
  it.each([
    ["tick", () => doneMock, /tick off apples/i, "checkbox" as const],
    ["delete", () => deleteMock, /delete apples/i, "button" as const],
    [
      "save for later",
      () => savedMock,
      /save for later: apples/i,
      "button" as const,
    ],
  ])(
    "surfaces a failed %s, naming the item",
    async (_label, mock, name, role) => {
      mock().mockRejectedValueOnce(new Error("offline"));
      renderList([item({ id: "a", text: "Apples" })]);

      await act(async () => {
        screen.getByRole(role, { name }).click();
        await flushTicks();
      });

      const notice = await screen.findByRole("alert");
      expect(notice).toHaveTextContent(/couldn't save that/i);
      expect(notice).toHaveTextContent(/Apples/);
    },
  );

  it("surfaces a failed rename, keeping the new words on screen", async () => {
    renameMock.mockRejectedValueOnce(new Error("offline"));
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    const field = screen.getByRole("textbox", { name: /rename apples/i });
    await userEvent.clear(field);
    await userEvent.type(field, "Braeburns{Enter}");

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(/couldn't save that/i);
    expect(notice).toHaveTextContent(/Braeburns/);
  });

  // `aria-disabled`, not `disabled`: a disabled element cannot hold focus, so the
  // browser would drop it to <body> the moment the retry starts — the same
  // WCAG 2.4.3 fault as the rename editor above, in the control that reports it.
  it("keeps the Retry focusable while its write is in flight, and guards the press", async () => {
    addMock.mockRejectedValueOnce(new Error("offline"));
    let resolveRetry!: (result: typeof WROTE) => void;
    addMock.mockReturnValueOnce(
      new Promise<typeof WROTE>((resolve) => {
        resolveRetry = resolve;
      }),
    );
    renderList();
    await addViaField("oat milk");

    const retry = await screen.findByRole("button", { name: /try again/i });
    retry.focus();
    await clickRetry();

    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(retry).not.toHaveAttribute("disabled");
    expect(retry).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent(/saving/i);
    // A second press while the first is outstanding must not post the words twice.
    await clickRetry();
    expect(addMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveRetry(WROTE);
      await flushTicks();
    });
  });

  // WCAG 2.4.3 again, at the other end: the notice unmounting under a focused
  // Retry would drop focus to <body>, so it is handed to the capture field.
  it("hands focus to the capture field when a successful Retry unmounts the notice", async () => {
    addMock.mockRejectedValueOnce(new Error("offline"));
    renderList();
    await addViaField("oat milk");

    const retry = await screen.findByRole("button", { name: /try again/i });
    retry.focus();
    await clickRetry();

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByLabelText(/add to the list/i)).toHaveFocus();
  });
});

/**
 * Duo review round 5, !294 — **the write the server declined.**
 *
 * A third outcome, and the one nothing on this page could see. `attempt()` read
 * "the action did not throw" as "the write landed", but `addShoppingItem`'s cap
 * check `return`s from inside its transaction, so a blocked add resolved exactly
 * like a stored one: the draft was cleared, `router.refresh()` ran, and the typed
 * words were gone with no message at all.
 *
 * The client's own pre-check cannot close this — it reads the last
 * server-rendered `items` prop, which is behind by a round trip the moment a
 * second submission or another tab is involved. So the page has to be told, and
 * these specs are about being told: what is said, where it is said, and whether
 * the control offered could actually work.
 */
describe("when the server refuses a write", () => {
  beforeEach(() => {
    for (const mock of [addMock, renameMock, doneMock, savedMock, deleteMock]) {
      mock.mockReset();
      mock.mockResolvedValue(WROTE);
    }
  });

  const refused = (reason: string) => ({ ok: false, refused: reason });

  it("keeps the typed words and says the list is full", async () => {
    addMock.mockResolvedValueOnce(refused("full"));
    renderList();
    const field = await addViaField("oat milk");

    expect(field).toHaveValue("oat milk");
    expect(screen.getByRole("alert")).toHaveTextContent(/full at 500 items/i);
  });

  /**
   * The race the finding describes, driven rather than asserted about.
   *
   * The list is rendered ONE short of the cap, so the client's own pre-check
   * passes and the call goes out. The first add lands and takes the last slot;
   * the second is submitted before `router.refresh()` has re-rendered `items`,
   * so the pre-check passes on a count that is now wrong and the server is the
   * only thing left that can refuse it.
   */
  it("survives a pre-check that was stale by one write", async () => {
    const nearlyFull = Array.from({ length: MAX_SHOPPING_ITEMS - 1 }, (_, i) =>
      item({ id: `s${i}`, text: `thing ${i}`, order: i + 1 }),
    );
    addMock.mockResolvedValueOnce(WROTE).mockResolvedValueOnce(refused("full"));
    renderList(nearlyFull);

    await addViaField("oat milk");
    const field = await addViaField("bread");

    expect(addMock).toHaveBeenNthCalledWith(1, "oat milk");
    expect(addMock).toHaveBeenNthCalledWith(2, "bread");
    // The second one is the one that did not land, and it is the one still on
    // screen — in the field, ready to be re-sent once there is room.
    expect(field).toHaveValue("bread");
    expect(screen.getByRole("alert")).toHaveTextContent(/full at 500 items/i);
  });

  // A refusal is not a breakage, so the notice's "couldn't save that just now"
  // and its Retry — which would post the same refused call again — must stay away.
  it("does not dress a refusal up as a failure", async () => {
    addMock.mockResolvedValueOnce(refused("full"));
    renderList();
    await addViaField("oat milk");

    expect(screen.queryByText(/couldn't save that/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  // The server knows something the page does not: `items` is behind. The same
  // fetch that corrects the list is what un-staleps the pre-check.
  it("re-reads the list, because the count it refused on is the true one", async () => {
    addMock.mockResolvedValueOnce(refused("full"));
    renderList();
    await addViaField("oat milk");
    expect(refreshMock).toHaveBeenCalled();
  });

  /**
   * The restore has the same rule as the failure path — it never overwrites a
   * field the user has since typed into — which leaves one gap the failure path
   * closes with the notice: words that could not go back must still be on
   * screen somewhere. They go into the refusal message, which is the one place
   * already saying why they did not save.
   */
  it("quotes the words when the field has moved on without them", async () => {
    let answer!: (result: unknown) => void;
    addMock.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    renderList();
    const field = screen.getByLabelText(/add to the list/i);
    fireEvent.change(field, { target: { value: "oat milk" } });
    fireEvent.submit(field.closest("form")!);
    await flush();
    fireEvent.change(field, { target: { value: "bread" } });
    await act(async () => {
      answer(refused("full"));
      await flushTicks();
    });

    expect(field).toHaveValue("bread");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/full at 500 items/i);
    expect(alert).toHaveTextContent(/oat milk/);
  });

  // Every row control goes through the same `run()`, and `updateMany` matching
  // no rows is the siblings' version of the identical fault.
  it.each([
    ["tick", () => doneMock, /tick off apples/i, "checkbox" as const],
    ["delete", () => deleteMock, /delete apples/i, "button" as const],
    [
      "save for later",
      () => savedMock,
      /save for later: apples/i,
      "button" as const,
    ],
  ])(
    "says so when a %s hits a row that is gone",
    async (_l, mock, name, role) => {
      mock().mockResolvedValueOnce(refused("missing"));
      renderList([item({ id: "a", text: "Apples" })]);

      await act(async () => {
        screen.getByRole(role, { name }).click();
        await flushTicks();
      });

      const notice = await screen.findByRole("alert");
      expect(notice).toHaveTextContent(/not on the list any more/i);
      expect(notice).toHaveTextContent(/Apples/);
      // Re-posting matches zero rows again, every time.
      expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
      // The row on screen is the thing that is wrong, so the list is re-read.
      expect(refreshMock).toHaveBeenCalled();
    },
  );

  it("surfaces a rename onto a row that is gone, naming the new words", async () => {
    renameMock.mockResolvedValueOnce(refused("missing"));
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    const field = screen.getByRole("textbox", { name: /rename apples/i });
    await userEvent.clear(field);
    await userEvent.type(field, "Braeburns{Enter}");

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(/not on the list any more/i);
    expect(notice).toHaveTextContent(/Braeburns/);
  });

  // Shopping-list mode switched off in another tab. A retry re-posts into an
  // action that will refuse it again; only a reload shows where the user is.
  it("offers a reload, not a retry, when the feature was switched off", async () => {
    addMock.mockResolvedValueOnce(refused("unavailable"));
    renderList();
    await addViaField("oat milk");

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(/switched off/i);
    expect(notice).toHaveTextContent(/oat milk/);
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  // Two write conflicts in a row: the list has room and nothing is wrong with
  // the request, so this is the one refusal a retry is the right answer to.
  it("offers a retry when the write simply lost twice", async () => {
    addMock.mockResolvedValueOnce(refused("conflict"));
    renderList();
    await addViaField("oat milk");

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(/couldn't save that/i);
    expect(notice).toHaveTextContent(/oat milk/);

    addMock.mockResolvedValueOnce(WROTE);
    await clickRetry();
    expect(addMock).toHaveBeenCalledTimes(2);
    expect(addMock).toHaveBeenLastCalledWith("oat milk");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  /**
   * An action from another build can resolve to something that is not a result
   * at all. Believing it is the exact bug this round removes, so an
   * unrecognised answer is reported rather than taken for a success.
   */
  it("does not take an unrecognised answer for a success", async () => {
    addMock.mockResolvedValueOnce(undefined);
    renderList();
    const field = await addViaField("oat milk");

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(/couldn't save that/i);
    expect(notice).toHaveTextContent(/oat milk/);
    expect(field).toHaveValue("oat milk");
  });
});
