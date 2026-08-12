/**
 * A decorative rule between two intent groups of a row's ▾ list (#253).
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 *
 * The owner's second complaint about that list was not only its sequence: eight or
 * nine `rowMenuEntry` rows in one undivided column have no rhythm, so the eye has
 * to read every label to find the one it wants. Ordering alone does not fix that —
 * the groups have to be VISIBLE.
 *
 * ── Why a `<span>`, and why it is not in `anchored-popup.ts` ────────────────
 *
 * `RowActions` renders its `Popover.Popup` with `render={<span />}`, so a ▾ entry
 * sits in a PHRASING context — the same constraint that makes every part of
 * `MoveToMenu` a span, and `move-to-menu.test.tsx` asserts on it. A `<div>` or an
 * `<hr>` here is invalid markup. An empty flex item in a `flex-col` surface
 * stretches to the popup's width and paints its `border-t` as the rule.
 *
 * It lives in its own module rather than beside `rowMenuEntry` because
 * `ui/anchored-popup.ts` is a `.ts` file — it holds the popup's class strings and
 * positioner policy, no JSX — and three renderers need this (`inbox/inbox-view.tsx`,
 * `library/library-rows.tsx`, `breakdown/task-steps.tsx`). Renaming that module to
 * `.tsx` to hold one element would churn every importer of the positioner.
 *
 * ── Why `aria-hidden` ───────────────────────────────────────────────────────
 *
 * Belt-and-braces rather than the mechanism: an empty element with no role
 * contributes nothing to the accessibility tree, so it cannot be announced as a
 * menu entry or counted by the target-size guards. It is written anyway because
 * that is how these rows already mark decoration sitting BETWEEN controls (the `·`
 * in each `deleteControl`'s armed confirm, the `w-3` spacer in the inbox's Done
 * bucket), and an unmarked separator is the thing a future refactor gives a role
 * to. Shaped after `nav/account-menu.tsx`'s `<div className="my-1 border-t" />`,
 * which is the repo's existing answer to the same problem in a header popup.
 */
export function rowMenuSeparator(key: string) {
  return <span key={key} aria-hidden="true" className="my-1 border-t" />;
}

/**
 * Joins a row ▾ list's intent groups with {@link rowMenuSeparator}.
 *
 * Falsy entries are dropped BEFORE the separators are placed, and an empty group
 * takes its separator with it. That is the whole reason this is a function rather
 * than separators written inline: the inbox's calendar group is
 * `[schedule, icsMenu]` and both are conditional — a workspace with no Google
 * connection renders one of them, a guest row can render neither — so inline rules
 * would leave a stray line against nothing, which is worse than no grouping at all.
 */
export function groupedRowMenu(groups: React.ReactNode[][]): React.ReactNode[] {
  return groups
    .map((group) => group.filter(Boolean))
    .filter((group) => group.length > 0)
    .flatMap((group, i) =>
      i === 0 ? group : [rowMenuSeparator(`row-menu-sep-${i}`), ...group],
    );
}
