"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { dismissShoppingSummary } from "@/app/actions/shopping";
import { shoppingSummaryLabel } from "@/lib/shopping-summary";
import { t, type Voice } from "@/lib/strings";

/**
 * #199 — the inbox's shopping-list summary line.
 *
 * ## Why this is a card and not an inbox row
 *
 * Every row in the inbox list is a `BrainDumpItem` — `bucketItems` files them by
 * `status`, `snoozedUntil` and `completedAt`, and the row controls (rename, move
 * to…, break into steps, schedule, complete) all mean something to a captured
 * item and nothing to a generated one. Rendering this as one of those rows would
 * mean suppressing six affordances in a 2,400-line component and would put the
 * line into the Library's tabs, the freshness clock, the untriaged nav badge and
 * `maybeAwardInboxZero` — that last one would make **inbox zero unreachable** for
 * anybody who keeps a shopping list.
 *
 * So it sits above the buckets, beside the resume banner and the welcome card,
 * which is where the inbox already puts things that are about the inbox rather
 * than in it. See `src/lib/shopping-summary.ts` for the storage side of the same
 * decision.
 *
 * ## The count is a prop, and the prop is derived
 *
 * `count` comes from a `count()` over `ShoppingItem` on the request that rendered
 * the page, never from anything stored on the summary row — the row holds only
 * whether to show a summary at all. So this component cannot display a stale
 * number: there is no stored number for it to read.
 *
 * ## "Not now", not "dismiss"
 *
 * The line comes back the next time the list grows, and the hint says so beside
 * the control. Without it the button reads as a delete, and this card is the only
 * place that behaviour is explained — a control whose effect is temporary and
 * unexplained is one people stop pressing.
 */
export function ShoppingSummaryCard({
  count,
  voice,
}: {
  count: number;
  voice: Voice;
}) {
  const router = useRouter();
  // The pending flag used to be discarded (Duo review, !295), so nothing guarded
  // the control while the dismiss was in flight and a double press fired
  // `dismissShoppingSummary()` and `router.refresh()` twice. The write is
  // idempotent — `clearShoppingSummary` is an `updateMany` setting a timestamp —
  // so the second one corrupted nothing, but it is a second server action and a
  // second full refresh of the inbox for a press the user meant once. The rest of
  // the inbox already keys a pending state per action for exactly this (#169's
  // `schedulingIds` in `inbox-view.tsx`); this card has ONE action, so the
  // transition's own flag is that per-action state rather than a keyed set.
  const [pending, startTransition] = useTransition();
  const label = shoppingSummaryLabel(count, voice);

  return (
    // `flex-wrap`, and the hint is NEVER hidden (Duo review, !295). It used to be
    // `hidden sm:inline`, which meant the one explanation of what "Not now" does
    // vanished on exactly the viewports this app is built for — contradicting the
    // reasoning three lines below it. Wrapping costs a second line on a narrow screen;
    // hiding costs the reader the only place the behaviour is written down.
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-4 py-2 text-sm">
      <Link
        href="/shopping"
        // The count is IN the link's own text, so the accessible name carries it
        // without a separate aria-label to keep in step. `basis-full sm:basis-auto`
        // so the link takes its own line when the row wraps, rather than the hint
        // and the button being pushed onto one cramped line under it.
        className="focus-visible:ring-ring basis-full rounded-md outline-none hover:underline focus-visible:ring-2 sm:flex-1 sm:basis-auto"
      >
        {label}
      </Link>
      <span className="text-muted-foreground text-xs">
        {t("shopping.summaryDismissHint", voice)}
      </span>
      <button
        type="button"
        // Named with what it is dismissing: "Not now" on its own is
        // indistinguishable from every other dismiss control in a screen reader's
        // element list, and this card sits above an inbox full of rows.
        aria-label={`${t("shopping.summaryDismiss", voice)} — ${label}`}
        // `aria-disabled`, NOT `disabled` — the same call `inbox-view.tsx` makes
        // on the capture Retry CTA, and for the same reason: a disabled element
        // cannot hold focus, so the browser drops focus to <body> the instant the
        // press lands and a keyboard user loses their place in the middle of their
        // own interaction. A disabled element is also skipped by most screen
        // readers, so the busy state it is meant to convey is the one thing it
        // cannot convey. `aria-disabled` keeps the button focusable and in the
        // accessibility tree, and the state change is announced precisely because
        // focus is still on it; the press itself is refused in the handler below,
        // which is what actually stops the second write.
        //
        // (`row-actions.tsx` uses real `disabled` for the ▾ menu's items — those
        // live in a popup that is unmounted for the whole pending window, so no
        // focus can be stranded there. This control is the pressed element.)
        aria-disabled={pending}
        onClick={() => {
          if (pending) return;
          startTransition(async () => {
            await dismissShoppingSummary();
            router.refresh();
          });
        }}
        // 44px minimum target (WCAG 2.5.5) and a ring rather than a background
        // swap for the focus indicator (WCAG 2.4.11, which axe cannot see — #117).
        // The 50% dim is the tree's one busy affordance — `disabled:opacity-50` on
        // the row actions, `aria-disabled:opacity-50` on the Retry CTA; the variant
        // differs only because the mechanism does. WCAG 1.4.3 exempts an inactive
        // component from its contrast minimum, and the handler above makes this one
        // genuinely inactive for exactly as long as it is dimmed.
        className="text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring inline-flex min-h-[44px] items-center rounded-md px-2 text-xs outline-none focus-visible:ring-2 aria-disabled:opacity-50"
      >
        {t("shopping.summaryDismiss", voice)}
      </button>
    </div>
  );
}
