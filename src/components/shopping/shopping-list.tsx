"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addShoppingItem,
  deleteShoppingItem,
  renameShoppingItem,
  setShoppingItemDone,
  setShoppingItemSavedForLater,
} from "@/app/actions/shopping";
import {
  MAX_SHOPPING_ITEMS,
  shoppingItemTextError,
  shoppingRemainingCount,
  splitShoppingList,
  type ShoppingItemView,
} from "@/lib/shopping";
import { COMPLETE_TEXT } from "@/lib/completion-style";
import { t, type Voice } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * #199 — shopping-list mode.
 *
 * ## What is not here is the point
 *
 * No estimate field, no "break into steps", no Schedule menu, no ▶ Focus. Every
 * other list surface in this app offers all four, and a row here that grew one
 * would put a shopping item into machinery the model deliberately keeps it out of
 * — so their absence is asserted in `shopping-list.test.tsx` rather than left to
 * be noticed. The intro copy says the same thing to the reader, because a list
 * that quietly lacks the app's usual affordances otherwise reads as unfinished.
 *
 * ## Server-rendered rows, client-side capture
 *
 * `items` are props from the `force-dynamic` page; each action revalidates
 * `/shopping` and this component calls `router.refresh()`, which is the pattern
 * the Settings sections use. Deliberately NOT an optimistic local copy: the list
 * is short, every write is one round trip, and an optimistic list is a second
 * source of truth for a count that #199 part 2 has to keep in sync with an inbox
 * row. One source of truth is worth more here than one frame of latency.
 *
 * ## The refusals are three messages, not one
 *
 * Empty, too long, and list-full are separate strings, and the field is marked
 * `aria-invalid` and wired to the message with `aria-describedby` (WCAG 3.3.1
 * Error Identification, 3.3.3 Error Suggestion). A capture field that fails
 * without saying which rule was broken is the failure mode that makes people stop
 * trusting it — and a silent no-op looks exactly like a lost item.
 */
export function ShoppingList({
  items,
  voice,
}: {
  items: readonly ShoppingItemView[];
  voice: Voice;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<"empty" | "too-long" | "full" | null>(
    null,
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  /**
   * Why the rename has its OWN refusal state rather than sharing `error`:
   * a rename can be refused while the capture field is untouched (and vice versa),
   * and one shared slot would let a rename's message appear under the Add field —
   * pointing `aria-describedby` at a message about a different control.
   *
   * Duo review, !294: a rename had no validation and no feedback at all. An
   * over-long or blanked value called the action, which returned silently, and the
   * row reverted with no explanation — the exact "a silent no-op looks like a lost
   * item" failure this file's docblock warns about for the Add flow. Both flows now
   * run through `shoppingItemTextError`.
   */
  const [editError, setEditError] = useState<"empty" | "too-long" | null>(null);
  const errorId = useId();
  const editErrorId = useId();
  const addFieldId = useId();

  /** Close the editor and drop any refusal with it — the message describes a value
   *  that is no longer on screen. */
  const stopEditing = () => {
    setEditingId(null);
    setEditError(null);
  };

  const run = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      await fn();
      router.refresh();
    });

  const { active, savedForLater } = splitShoppingList(items);
  const remaining = shoppingRemainingCount(items);

  const submit = () => {
    // The cap is checked first: at 500 rows "type something first" would be a
    // true but useless answer to why nothing happened.
    if (items.length >= MAX_SHOPPING_ITEMS) {
      setError("full");
      return;
    }
    const refusal = shoppingItemTextError(draft);
    if (refusal) {
      setError(refusal);
      return;
    }
    const text = draft;
    setDraft("");
    setError(null);
    run(() => addShoppingItem(text));
  };

  const refusalMessage = (
    refusal: "empty" | "too-long" | "full" | null,
  ): string | null =>
    refusal === "empty"
      ? t("shopping.errorEmpty", voice)
      : refusal === "too-long"
        ? t("shopping.errorTooLong", voice)
        : refusal === "full"
          ? t("shopping.errorFull", voice)
          : null;

  const errorMessage =
    error === "empty"
      ? t("shopping.errorEmpty", voice)
      : error === "too-long"
        ? t("shopping.errorTooLong", voice)
        : error === "full"
          ? t("shopping.errorFull", voice)
          : null;

  const countLabel = `${remaining} ${t(
    remaining === 1 ? "shopping.itemOne" : "shopping.itemMany",
    voice,
  )} ${t("shopping.stillToBuy", voice)}`;

  // 44px minimum touch target (WCAG 2.5.5), and the focus indicator is a RING
  // rather than a background swap: WCAG 2.4.11 Focus Appearance is AA in WCAG 2.2
  // and axe does not implement it, so a hover-coloured background alone would ship
  // green and fail (#117). --ring is the same token app-menu.tsx measured.
  const ICON_BUTTON =
    "text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md px-2 text-xs outline-none focus-visible:ring-2";

  const row = (i: ShoppingItemView, saved: boolean) => (
    <li key={i.id} className="flex min-h-[44px] items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={i.done}
        // The item's own text IS the accessible name. A checkbox named "Tick off"
        // twelve times down a list is unusable in a screen reader's element list,
        // which is the same reasoning every button below follows.
        aria-label={`${t("shopping.tickOff", voice)} ${i.text}`}
        onChange={(e) => run(() => setShoppingItemDone(i.id, e.target.checked))}
        // A checkbox is a 16px control inside a 44px row: the row supplies the
        // target height, and the label wrapping it is not used here because the
        // row also holds three buttons, which a <label> may not contain.
        className="focus-visible:ring-ring h-4 w-4 shrink-0 outline-none focus-visible:ring-2"
      />
      {editingId === i.id ? (
        <RenameInput
          initial={i.text}
          label={`${t("shopping.rename", voice)} ${i.text}`}
          invalid={editError !== null}
          describedBy={editError !== null ? editErrorId : undefined}
          onChange={() => setEditError(null)}
          onCancel={stopEditing}
          onSave={(value) => {
            // Unchanged is not a refusal: it is a no-op, and the editor closes.
            if (value === i.text) {
              stopEditing();
              return;
            }
            const refusal = shoppingItemTextError(value);
            if (refusal) {
              // Editor stays OPEN. Reverting would throw away what they typed as
              // well as failing silently, which is worse than either alone.
              setEditError(refusal);
              return;
            }
            stopEditing();
            run(() => renameShoppingItem(i.id, value));
          }}
        />
      ) : (
        <span
          // The strike comes from the shared completion token, never a hard-coded
          // `line-through`: it is an Appearance setting and re-hardcoding it is
          // what completion-style.ts exists to prevent. Ticked state is also
          // carried by the checkbox itself, so this is never colour-or-decoration
          // only (WCAG 1.4.1).
          className={cn("min-w-0 flex-1 break-words", i.done && COMPLETE_TEXT)}
        >
          {i.text}
        </span>
      )}
      <button
        type="button"
        aria-label={`${t("shopping.rename", voice)} ${i.text}`}
        onClick={() => setEditingId(i.id)}
        className={ICON_BUTTON}
      >
        {t("shopping.rename", voice)}
      </button>
      <button
        type="button"
        // `<action> <item>`, the same shape as the tick, rename and delete names
        // above. Deliberately not an interpolated sentence ("Save Apples for
        // later"): that needs the string to carry a placeholder in a fixed
        // grammatical position, and #86's voice layer is a flat label table with
        // no interpolation. A consistent `label — item` reads correctly in both
        // voices and stays correct if a label is reworded.
        aria-label={`${
          saved
            ? t("shopping.moveBackUp", voice)
            : t("shopping.saveForLater", voice)
        }: ${i.text}`}
        onClick={() => run(() => setShoppingItemSavedForLater(i.id, !saved))}
        className={ICON_BUTTON}
      >
        {saved
          ? t("shopping.moveBackUp", voice)
          : t("shopping.saveForLater", voice)}
      </button>
      <button
        type="button"
        aria-label={`${t("shopping.delete", voice)} ${i.text}`}
        onClick={() => run(() => deleteShoppingItem(i.id))}
        className={ICON_BUTTON}
      >
        {t("shopping.delete", voice)}
      </button>
    </li>
  );

  /** The refusal for a rename in progress, rendered as its own list item so it sits
   *  under the row it belongs to rather than beside the row's controls. */
  const renameRefusal = (i: ShoppingItemView) =>
    editingId === i.id && editError !== null ? (
      <li key={`${i.id}-refusal`} className="pb-1">
        <p id={editErrorId} role="alert" className="text-destructive text-sm">
          {refusalMessage(editError)}
        </p>
      </li>
    ) : null;

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        {t("shopping.intro", voice)}
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-1"
      >
        <label htmlFor={addFieldId} className="block text-sm font-medium">
          {t("shopping.addLabel", voice)}
        </label>
        <div className="flex gap-2">
          <input
            id={addFieldId}
            value={draft}
            placeholder={t("shopping.addPlaceholder", voice)}
            // Only set when there IS an error: a permanent `aria-invalid="false"`
            // is noise, and the attribute's absence is the accessible default.
            aria-invalid={error !== null || undefined}
            aria-describedby={error !== null ? errorId : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              // Clearing on the next keystroke rather than on submit: a message
              // that outlives the mistake gets read as the field's own state.
              if (error !== null) setError(null);
            }}
            className="border-input bg-background focus-visible:ring-ring min-w-0 flex-1 rounded-md border px-2 py-2 text-sm outline-none focus-visible:ring-2"
          />
          <button
            type="submit"
            className="bg-primary text-primary-foreground focus-visible:ring-ring focus-visible:ring-offset-background inline-flex min-h-[44px] items-center rounded-md px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          >
            {t("shopping.add", voice)}
          </button>
        </div>
        {errorMessage && (
          // `role="alert"` so the refusal is announced without moving focus. The
          // element only exists while there is a message, which is what makes the
          // announcement fire — a permanently-present live region that changes
          // text is announced inconsistently across screen readers.
          <p id={errorId} role="alert" className="text-destructive text-sm">
            {errorMessage}
          </p>
        )}
      </form>

      {/* `region` + an accessible name carrying the count, so the count is
          reachable without hunting for the heading it sits beside. */}
      <section
        aria-label={`${t("shopping.sectionActive", voice)} — ${countLabel}`}
      >
        <h2 className="text-sm font-semibold">
          {t("shopping.sectionActive", voice)}{" "}
          <span className="text-muted-foreground font-normal tabular-nums">
            ({countLabel})
          </span>
        </h2>
        {active.length === 0 ? (
          <p className="text-muted-foreground mt-1 text-sm">
            {t("shopping.empty", voice)}
          </p>
        ) : (
          <ul className="mt-1 divide-y">
            {active.flatMap((i) => [row(i, false), renameRefusal(i)])}
          </ul>
        )}
      </section>

      {/* Rendered only when it holds something. An always-present empty section
          below an empty list is two headings and no content on a brand-new
          workspace; the per-row "Save … for later" button is how the section is
          discovered, and it appears the moment there is something in it. */}
      {savedForLater.length > 0 && (
        <section aria-label={t("shopping.sectionSaved", voice)}>
          <h2 className="text-sm font-semibold">
            {t("shopping.sectionSaved", voice)}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {t("shopping.savedHint", voice)}
          </p>
          <ul className="mt-1 divide-y">
            {savedForLater.flatMap((i) => [row(i, true), renameRefusal(i)])}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Inline text editor swapped in for a row's text. Enter saves, Escape cancels —
 *  mirrors `EditTitleInput` in inbox-view.tsx and the step editor in
 *  task-steps.tsx, which is the established shape for this in the repo. */
function RenameInput({
  initial,
  label,
  invalid,
  describedBy,
  onChange,
  onSave,
  onCancel,
}: {
  initial: string;
  label: string;
  /** Set when the last attempt was refused — WCAG 3.3.1 Error Identification. */
  invalid: boolean;
  /** The id of the refusal message, so the field points at its own explanation. */
  describedBy?: string;
  /** Editing again clears the refusal: a message that outlives the mistake gets
   *  read as the field's own state. */
  onChange: () => void;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      value={value}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(e) => {
        setValue(e.target.value);
        onChange();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSave(value.trim());
        }
        if (e.key === "Escape") onCancel();
      }}
      className="border-input bg-background focus-visible:ring-ring min-w-0 flex-1 rounded-md border px-2 py-1 text-sm outline-none focus-visible:ring-2"
    />
  );
}
