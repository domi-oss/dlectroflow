/**
 * #199 — the pure half of shopping-list mode.
 *
 * A shopping list is deliberately NOT a `Task` with `Step`s. `Step.estMinutes`
 * is NOT NULL with `CHECK ("estMinutes" >= 1)`, and `beginFocus`/`completeStep`
 * do no kind-check, so a shopping item stored as a step would carry a fabricated
 * estimate AND become focusable and streak-earning by default. `ShoppingItem` is
 * its own table for that reason: the focus, scheduling and reward machinery
 * cannot see it, so there is nothing to subtract.
 *
 * Everything here is arithmetic over a list of rows, with no Prisma and no
 * React, so the ordering rules and the bounds are unit-testable without a
 * database — the split `focus-playlists.ts` (#185) uses, for the same reason.
 *
 * The bounds are the module's other job, and they are not decoration: every
 * value below arrives from a client-callable server action, so a workspace's
 * row count and each row's size are the only things standing between an
 * authenticated session (including a guest sandbox) and storage exhaustion.
 */

/**
 * Longest item text, in CHARACTERS.
 *
 * 200 is generous for "oat milk, the blue one" and far short of a paste of
 * somebody's clipboard. The rows render single-line in a list whose whole job is
 * to be scannable, and the text is read out whole in three accessible names
 * ("Tick off …", "Save … for later", "Delete …"), so anything longer is
 * truncated on screen and unlistenable in a screen reader.
 *
 * Mirrored by `ShoppingItem_text_check` (see the migration), which measures with
 * `char_length` for the same reason {@link normaliseShoppingItemText} counts code
 * points: `octet_length` differs by up to 4x on astral characters, so a byte
 * bound would reject an all-emoji entry a quarter the length of a Latin one it
 * accepts. Registered in LENGTH_REGISTRY in
 * `src/lib/enum-constraint-sync.integration.test.ts`, so dropping the constraint
 * out of band fails the suite rather than silently unbounding the column.
 */
export const SHOPPING_ITEM_TEXT_MAX_LENGTH = 200;

/**
 * Most items one workspace's list may hold.
 *
 * `addShoppingItem` is an authenticated, client-callable write with no other
 * rate limit in front of it, so an unbounded row count per workspace is storage
 * exhaustion available to anyone with a session. 500 is far above any honest
 * shopping list and still bounds the table.
 *
 * Enforced in the action rather than in SQL: a per-workspace row cap is not
 * something a CHECK constraint can express, and the action is the only writer.
 */
export const MAX_SHOPPING_ITEMS = 500;

/** Why an entry was refused, so the field can say which rule it broke. */
export type ShoppingItemTextError = "empty" | "too-long";

/**
 * The shape every surface here needs of a stored item. Deliberately not the
 * Prisma row: `createdAt` and `workspaceId` are nobody's business up here, and
 * taking a structural type keeps this module testable without a database.
 */
export type ShoppingItemView = {
  id: string;
  text: string;
  done: boolean;
  /** #199 — the undated "saved for later" section. No date, no snooze, no
   *  scheduler: nothing here reappears on its own, it is pulled back by hand. */
  savedForLater: boolean;
  order: number;
};

/** Code points, not UTF-16 units: `"🥑".length` is 2, and a bound that counted
 *  that way would reject an emoji entry half the length of the Latin one beside
 *  it. Matches `char_length` in Postgres. */
function characterCount(value: string): number {
  return [...value].length;
}

/**
 * The stored form of an entry: trimmed, internal whitespace runs collapsed to
 * one space, or `null` if that leaves nothing or overruns the bound.
 *
 * Collapsing BEFORE measuring is deliberate — padding an entry should not cost
 * the user characters they can see. Collapsing at all is what stops `"oat  milk"`
 * and `"oat milk"` rendering as two visually identical rows in a list whose only
 * distinguishing feature is the text.
 */
export function normaliseShoppingItemText(raw: string): string | null {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return null;
  if (characterCount(collapsed) > SHOPPING_ITEM_TEXT_MAX_LENGTH) return null;
  return collapsed;
}

/**
 * Which refusal {@link normaliseShoppingItemText} would give, or `null` if it
 * would accept.
 *
 * Separate from the normaliser because the field has to say WHY: a lone `null`
 * cannot tell "you typed nothing" from "that is too long", and a silent no-op is
 * the failure mode that makes a capture surface untrustworthy.
 */
export function shoppingItemTextError(
  raw: string,
): ShoppingItemTextError | null {
  if (raw.trim().length === 0) return "empty";
  if (normaliseShoppingItemText(raw) === null) return "too-long";
  return null;
}

/**
 * Capture order, with a deterministic tie-break.
 *
 * `order` is allocated as `max + 1` by {@link nextShoppingOrder}, which two
 * concurrent adds can read at the same time and therefore duplicate. That is a
 * cosmetic outcome and cheaper than serialising every add, but only if the tie
 * is broken the same way on every read — otherwise the list silently reshuffles
 * between page loads. The id is stable and unique, so it is the tie-break.
 */
const byCaptureOrder = (a: ShoppingItemView, b: ShoppingItemView): number =>
  a.order - b.order || a.id.localeCompare(b.id);

/**
 * The two sections the page renders: the live list, and the undated
 * saved-for-later pile below it.
 *
 * A TICKED item stays in the active section on purpose. "Done" and "not this
 * trip" are different facts, and moving a ticked item out from under the finger
 * that just tapped it is the interaction that makes a checklist feel broken.
 */
export function splitShoppingList(items: readonly ShoppingItemView[]): {
  active: ShoppingItemView[];
  savedForLater: ShoppingItemView[];
} {
  const active = items.filter((i) => !i.savedForLater).sort(byCaptureOrder);
  const savedForLater = items
    .filter((i) => i.savedForLater)
    .sort(byCaptureOrder);
  return { active, savedForLater };
}

/**
 * How many things are still to buy.
 *
 * **Ticked items and saved-for-later items are both excluded**, and the reading
 * is "things I still need to buy": a ticked item is in the basket, and a
 * saved-for-later item has been explicitly deferred out of this trip. Anything
 * that counted the deferred pile would make the number go UP when the user tidied
 * their list, which is the opposite of what the gesture means.
 *
 * One definition, used by every surface that shows a count, so two of them can
 * never disagree about what the number means.
 */
export function shoppingRemainingCount(
  items: readonly Pick<ShoppingItemView, "done" | "savedForLater">[],
): number {
  return items.filter((i) => !i.done && !i.savedForLater).length;
}

/**
 * The `order` a newly captured item takes: one past the highest in the list.
 *
 * Deliberately not `items.length + 1` — deleting from the middle would then
 * re-issue an order already held by a later row, and the new item would land in
 * the middle of the list instead of at the end.
 */
export function nextShoppingOrder(
  items: readonly Pick<ShoppingItemView, "order">[],
): number {
  return items.reduce((max, i) => Math.max(max, i.order), 0) + 1;
}
