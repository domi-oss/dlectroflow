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
  const [, startTransition] = useTransition();
  const label = shoppingSummaryLabel(count, voice);

  return (
    <div className="flex items-center gap-2 rounded-lg border px-4 py-2 text-sm">
      <Link
        href="/shopping"
        // The count is IN the link's own text, so the accessible name carries it
        // without a separate aria-label to keep in step.
        className="focus-visible:ring-ring flex-1 rounded-md outline-none hover:underline focus-visible:ring-2"
      >
        {label}
      </Link>
      <span className="text-muted-foreground hidden text-xs sm:inline">
        {t("shopping.summaryDismissHint", voice)}
      </span>
      <button
        type="button"
        // Named with what it is dismissing: "Not now" on its own is
        // indistinguishable from every other dismiss control in a screen reader's
        // element list, and this card sits above an inbox full of rows.
        aria-label={`${t("shopping.summaryDismiss", voice)} — ${label}`}
        onClick={() =>
          startTransition(async () => {
            await dismissShoppingSummary();
            router.refresh();
          })
        }
        // 44px minimum target (WCAG 2.5.5) and a ring rather than a background
        // swap for the focus indicator (WCAG 2.4.11, which axe cannot see — #117).
        className="text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring inline-flex min-h-[44px] items-center rounded-md px-2 text-xs outline-none focus-visible:ring-2"
      >
        {t("shopping.summaryDismiss", voice)}
      </button>
    </div>
  );
}
