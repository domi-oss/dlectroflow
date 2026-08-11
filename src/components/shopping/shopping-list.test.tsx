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
 * The capture form, found by tag rather than by an accessibility query (#235).
 *
 * A `screen.*` query walks the whole document and computes an accessible name
 * for every candidate, so its cost scales with the size of the rendered tree,
 * not with how specific the query looks. The two specs that render the list AT
 * its cap put ~1500 buttons in that tree, and there the SAME query costs orders
 * of magnitude more than when it is scoped to this form. Measured on one
 * 500-row tree — the scoped column is 0 because it lands below the timer's
 * resolution, so the true ratio is a floor, not a reading:
 *
 *   query                                        unscoped   scoped to the form
 *   getByLabelText(/add to the list/i)             501 ms                 0 ms
 *   getByRole("button", { name: /^add$/i })        265 ms                 0 ms
 *   the same getByRole again, cache warm           240 ms                 0 ms
 *
 * Rendering those 500 rows is only ~61 ms of it, so the tree is not what is
 * slow — searching it is. Scoping is therefore preferred over a raised
 * per-spec timeout, which would have kept the cost and only stopped counting
 * it, and over shrinking the fixture: a smaller list would need
 * `MAX_SHOPPING_ITEMS` mocked, and `shopping-list.tsx` also imports
 * `shoppingItemTextError`, `shoppingRemainingCount` and `splitShoppingList`
 * from that same module — so the mock would need an `importOriginal` spread and
 * would silently render the component against undefined exports if anyone
 * forgot (#160). Being at the cap is the thing those two specs test, so the
 * fixture stays at the true cap.
 *
 * There is exactly one `<form>` in the component: the capture field and its Add
 * button. Every other spec here renders a handful of rows, where the same two
 * unscoped queries cost 1 ms and 4 ms, so they are left alone.
 *
 * That "exactly one" is **asserted, not assumed**. The `screen`/`within`
 * queries this replaces throw when a selector matches more than one node, and
 * dropping to `querySelector` would have quietly given up that property: a
 * second `<form>` in the tree — a rename editor growing one, say — would scope
 * the two specs to the wrong subtree while their queries still resolved and
 * their assertions still passed. Silent lost coverage is worse than the slow
 * version this replaced, which at least announced itself
 * (Duo review round 2, !320). `getByRole("form")` is not the alternative: a
 * `<form>` only takes that role once it has an accessible name, and this one
 * has none.
 */
const captureForm = (container: HTMLElement): HTMLElement => {
  const forms = container.querySelectorAll("form");
  if (forms.length !== 1) {
    throw new Error(
      `captureForm: expected exactly one <form> in the rendered tree, found ` +
        `${forms.length}. The at-the-cap specs scope their queries to that ` +
        `form, so any other count would point them at the wrong subtree ` +
        `without failing.`,
    );
  }
  return forms[0];
};

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

/**
 * `scope` defaults to the whole document, which is what `screen` already
 * searches — so every existing caller is unchanged. The at-the-cap spec passes
 * {@link captureForm} instead, because there the field lookup is the single
 * most expensive statement in the test.
 */
const addViaField = async (value: string, scope?: HTMLElement) => {
  const field = (scope ? within(scope) : screen).getByLabelText(
    /add to the list/i,
  );
  fireEvent.change(field, { target: { value } });
  fireEvent.submit(field.closest("form")!);
  await flush();
  return field;
};

describe("the at-the-cap query scope", () => {
  /**
   * {@link captureForm} exists so the two at-the-cap specs can skip a
   * whole-document query, and it is only correct while the tree holds exactly
   * one `<form>`. Taking the first match silently would be the worst available
   * outcome: those specs would scope to the wrong subtree, their queries would
   * still resolve, their assertions would still pass, and the coverage they
   * claim would be gone with nothing saying so. A slow test at least tells you
   * it is slow. So the invariant the docblock relies on is asserted here rather
   * than trusted (Duo review round 2, !320).
   */
  it("refuses to guess when the tree holds more than one form", () => {
    const { container } = renderList([item({})]);
    container.appendChild(document.createElement("form"));
    expect(() => captureForm(container)).toThrow(
      /exactly one <form>.*\bfound 2\b/i,
    );
  });

  // The same guard catches the opposite drift: a component that stopped
  // rendering the capture form would otherwise hand back null and fail later,
  // somewhere that says nothing about the cause.
  it("refuses to guess when the tree holds no form at all", () => {
    expect(() => captureForm(document.createElement("div"))).toThrow(
      /exactly one <form>.*\bfound 0\b/i,
    );
  });
});

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

  // Queries scoped to the capture form rather than the 500-row document — see
  // `captureForm` (#235). The refusal this asserts on is the field's own, which
  // renders inside that form; that a server refusal does NOT instead raise the
  // failure notice is covered on an empty list by "does not dress a refusal up
  // as a failure".
  it("refuses to add past the cap, and says why", async () => {
    const full = Array.from({ length: MAX_SHOPPING_ITEMS }, (_, i) =>
      item({ id: `s${i}`, text: `thing ${i}`, order: i + 1 }),
    );
    const form = captureForm(renderList(full).container);
    await userEvent.type(
      within(form).getByLabelText(/add to the list/i),
      "one more",
    );
    await userEvent.click(within(form).getByRole("button", { name: /^add$/i }));
    expect(addMock).not.toHaveBeenCalled();
    expect(within(form).getByRole("alert")).toHaveTextContent(
      /full at 500 items/i,
    );
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
  // Queries scoped to the capture form, as in the other at-the-cap spec (#235).
  it("survives a pre-check that was stale by one write", async () => {
    const nearlyFull = Array.from({ length: MAX_SHOPPING_ITEMS - 1 }, (_, i) =>
      item({ id: `s${i}`, text: `thing ${i}`, order: i + 1 }),
    );
    addMock.mockResolvedValueOnce(WROTE).mockResolvedValueOnce(refused("full"));
    const form = captureForm(renderList(nearlyFull).container);

    await addViaField("oat milk", form);
    const field = await addViaField("bread", form);

    expect(addMock).toHaveBeenNthCalledWith(1, "oat milk");
    expect(addMock).toHaveBeenNthCalledWith(2, "bread");
    // The second one is the one that did not land, and it is the one still on
    // screen — in the field, ready to be re-sent once there is room.
    expect(field).toHaveValue("bread");
    expect(within(form).getByRole("alert")).toHaveTextContent(
      /full at 500 items/i,
    );
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

/**
 * Duo review round 6, !294 — **the notice outliving the thing it is about.**
 *
 * The five rounds above built the notice; this one is about when it goes away.
 * It recognised "the write this record is about has now succeeded" by comparing
 * the held closure by REFERENCE, and only the notice's own Retry ever hands the
 * same closure back — every ordinary control builds a fresh one on every render.
 * So a user who simply pressed Add again, or ticked the box again, could never
 * match: the banner from the earlier attempt stayed on screen beside the write
 * that had just landed, and its Retry then re-posted the OLD call with the OLD
 * arguments. For a rename that silently reverts the newer words; for an add it
 * stores the item twice.
 *
 * A failure belongs to a logical TARGET — this row's text, this row's tick, or,
 * for the add, the words themselves, because it has no row to name yet. The
 * closure is still held, but only to re-run; it is no longer an identity.
 *
 * The specs come in pairs on purpose: for every "this now clears" there is a
 * "and this still does not", because a key that is too coarse throws away a
 * failure the user has not been told about, which is the same family of bug from
 * the other side.
 */
describe("a fresh attempt at the same thing", () => {
  beforeEach(() => {
    for (const mock of [addMock, renameMock, doneMock, savedMock, deleteMock]) {
      mock.mockReset();
      mock.mockResolvedValue(WROTE);
    }
  });

  const tickApples = () =>
    act(async () => {
      screen.getByRole("checkbox", { name: /tick off apples/i }).click();
      await flushTicks();
    });

  const renameApplesTo = async (value: string) => {
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    const field = screen.getByRole("textbox", { name: /rename apples/i });
    await userEvent.clear(field);
    await userEvent.type(field, `${value}{Enter}`);
    await flush();
  };

  it("drops the notice when the same words are added again and land", async () => {
    addMock.mockRejectedValueOnce(new Error("offline"));
    renderList();
    await addViaField("oat milk");
    expect(await screen.findByRole("alert")).toHaveTextContent(/oat milk/);

    // The ordinary control, NOT the notice's Retry — which is the whole point.
    await addViaField("oat milk");

    expect(addMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    // No Retry left to press means no way to store "oat milk" a second time.
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  // The other half of keying an add by its words: two different things to buy
  // are two different requests, and the first one still has not been saved.
  it("keeps a failed add up while different words are added", async () => {
    addMock.mockRejectedValueOnce(new Error("offline"));
    renderList();
    await addViaField("oat milk");
    expect(await screen.findByRole("alert")).toHaveTextContent(/oat milk/);

    await addViaField("bread");

    expect(addMock).toHaveBeenLastCalledWith("bread");
    expect(screen.getByRole("alert")).toHaveTextContent(/oat milk/);
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
  });

  it("drops the notice when the same row control is used again and lands", async () => {
    doneMock.mockRejectedValueOnce(new Error("offline"));
    renderList([item({ id: "a", text: "Apples" })]);

    await tickApples();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Apples/);

    await tickApples();

    expect(doneMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  /**
   * The half of the finding that is a correctness bug rather than a display one.
   *
   * The first rename fails, the user renames the row again by hand and THAT one
   * lands. A notice that survives is holding `renameShoppingItem("a",
   * "Braeburns")`, so its Retry writes the superseded words back over the ones
   * the user just saved — a silent revert nothing on the page reports.
   */
  it("cannot revert a rename the user has since made", async () => {
    renameMock.mockRejectedValueOnce(new Error("offline"));
    renderList([item({ id: "a", text: "Apples" })]);

    await renameApplesTo("Braeburns");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Braeburns/);

    await renameApplesTo("Coxes");

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    expect(renameMock).toHaveBeenCalledTimes(2);
    expect(renameMock).toHaveBeenLastCalledWith("a", "Coxes");
  });

  // Round 4's rule, kept: a success says nothing about a DIFFERENT write's
  // failure, and clearing that one would be a silent no-op of its own.
  it("keeps a failure a different row's success says nothing about", async () => {
    doneMock.mockRejectedValueOnce(new Error("offline"));
    renderList([
      item({ id: "a", text: "Apples" }),
      item({ id: "b", text: "Bread", order: 2 }),
    ]);

    await tickApples();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Apples/);

    await act(async () => {
      screen.getByRole("checkbox", { name: /tick off bread/i }).click();
      await flushTicks();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/Apples/);
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
  });

  /**
   * Row AND field, not row alone. Ticking a row off does not save the words a
   * rename of that row failed to save, so the notice stays and its Retry still
   * means exactly what it says.
   */
  it("keeps a failed rename up when a tick of the same row lands", async () => {
    renameMock.mockRejectedValueOnce(new Error("offline"));
    renderList([item({ id: "a", text: "Apples" })]);

    await renameApplesTo("Braeburns");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Braeburns/);

    await tickApples();

    expect(screen.getByRole("alert")).toHaveTextContent(/Braeburns/);
    await clickRetry();
    expect(renameMock).toHaveBeenLastCalledWith("a", "Braeburns");
  });

  /**
   * The same target, twice, with the first one losing the race — an impatient
   * double-submit is the ordinary way to get here.
   *
   * The second add lands; the first then gives up. Reporting it would raise a
   * notice about words that ARE on the server, and the restore would put them
   * back in the field for the user to send a third time.
   */
  it("says nothing for an attempt a later one has already overtaken", async () => {
    let abandonFirst!: (reason: unknown) => void;
    addMock.mockReturnValueOnce(
      new Promise((_, reject) => {
        abandonFirst = reject;
      }),
    );
    renderList();
    const field = screen.getByLabelText(/add to the list/i);
    fireEvent.change(field, { target: { value: "oat milk" } });
    fireEvent.submit(field.closest("form")!);
    await flush();
    fireEvent.change(field, { target: { value: "oat milk" } });
    fireEvent.submit(field.closest("form")!);
    await flush();

    await act(async () => {
      abandonFirst(new Error("offline"));
      await flushTicks();
    });

    expect(addMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field).toHaveValue("");
  });

  /**
   * Re-issuing against a row that has gone is the same class of bug as re-issuing
   * stale arguments: the button offers something that cannot work. The server
   * would answer `missing`, but the page already knows — the row is not in the
   * `items` it is rendering — so it says so instead of offering the trip.
   */
  it("withdraws the Retry once the row it was aimed at has gone", async () => {
    savedMock.mockRejectedValueOnce(new Error("offline"));
    const { rerender } = renderList([item({ id: "a", text: "Apples" })]);

    await act(async () => {
      screen.getByRole("button", { name: /save for later: apples/i }).click();
      await flushTicks();
    });
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(/couldn't save that/i);
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();

    // What a `router.refresh()` after a delete in another tab renders.
    rerender(<ShoppingList items={[]} voice="plain" />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      /not on the list any more/i,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/Apples/);
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  // The add has no row, so it can never be orphaned by one going away.
  it("leaves the add's own Retry alone when the list empties", async () => {
    addMock.mockRejectedValueOnce(new Error("offline"));
    const { rerender } = renderList([item({ id: "a", text: "Apples" })]);
    await addViaField("oat milk");
    expect(await screen.findByRole("alert")).toHaveTextContent(/oat milk/);

    rerender(<ShoppingList items={[]} voice="plain" />);

    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
  });
});
