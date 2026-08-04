/**
 * #163 — what a screen reader is told when an inbox item moves.
 *
 * `@dnd-kit/core` shipped these for free. `@atlaskit/pragmatic-drag-and-drop`
 * deliberately does not: its accessibility guidelines say the core package
 * "does not enable accessible controls automatically, as there is no one
 * pattern that works well for all situations", and hand the job to the
 * consumer. That hand-off is the single most likely silent regression in this
 * migration, because nothing automated can see it — axe cannot tell a live
 * region that says the right thing from one that says nothing.
 *
 * Pure module, no React and no DOM, so the wording is unit-testable on its own
 * (the split `move-dispatch`, `bucket` and every `*-hygiene` module use). The
 * live region that reads these out lives in `inbox-view.tsx`.
 *
 * Two rules the tests pin, both learned from dnd-kit's version:
 *
 *  1. **Name both ends of a move.** dnd-kit announced only the destination
 *     ("was dropped over droppable area completed"). Someone who cannot see the
 *     board has no other way to learn which list the item left.
 *  2. **Never claim a move that did not happen.** A drop can resolve to a
 *     no-op (`dropPlan` returns `{ kind: "noop" }` for a same-bucket drop), and
 *     a drag can be cancelled. Both say so.
 */

import { t, type Voice } from "@/lib/strings";
import { BUCKET_LABEL, type BucketId } from "@/components/inbox/bucket";

/**
 * A bucket's name as it should be *spoken*: the reader's own voice, minus the
 * decorative glyph the playful voice prefixes section names with.
 *
 * A live region reads an emoji out by its CLDR name, so "✅ Sorted" is
 * announced as "check mark button Sorted" — noise in the one channel a screen
 * reader user has for move feedback. The visible heading keeps its glyph; only
 * the announcement drops it.
 *
 * Filtering by code point rather than matching `\p{Extended_Pictographic}`
 * because that escape needs an ES2018 target and `tsconfig.json` targets
 * ES2017. Iterating the string (not `.split("")`) walks whole code points, so
 * surrogate pairs and variation selectors go together. Every Latin letter,
 * digit and punctuation mark a bucket name uses is below U+2000; every
 * pictographic block is above it.
 */
export function spokenBucketName(bucket: BucketId, voice: Voice): string {
  const label = t(BUCKET_LABEL[bucket], voice);
  return [...label]
    .filter((ch) => (ch.codePointAt(0) ?? 0) < 0x2000)
    .join("")
    .trim();
}

/**
 * The description attached to a row's move control.
 *
 * pragmatic-drag-and-drop is built on the platform's own drag and drop, which
 * has no keyboard equivalent — so this control is not a fallback for dragging,
 * it *is* the keyboard and assistive-technology path (WCAG 2.1.1 Keyboard, and
 * 2.5.7 Dragging Movements). The description says so plainly rather than
 * describing a keyboard drag that no longer exists.
 *
 * Rendered as a real node in the tree with a `useId` id, which is the other
 * half of #94: dnd-kit derived this id from a per-render counter and rendered
 * the node into a portal that never server-rendered, so on every hard load the
 * `aria-describedby` pointed at nothing.
 */
export const MOVE_INSTRUCTIONS =
  "Move to opens a list of destinations for this item. Dragging its grip does the same thing with a pointer.";

/** Quoting the title keeps a multi-word item from running into the sentence. */
const quoted = (itemText: string) => `“${itemText}”`;

/** Lift: the item and the list it is leaving. */
export function liftAnnouncement(
  itemText: string,
  from: BucketId,
  voice: Voice,
): string {
  return `Lifted ${quoted(itemText)} from ${spokenBucketName(from, voice)}.`;
}

/** Hovering a drop target: where releasing would put it. */
export function overAnnouncement(
  itemText: string,
  over: BucketId,
  voice: Voice,
): string {
  return `${quoted(itemText)} is over ${spokenBucketName(over, voice)}. Release to move it there.`;
}

/** A move that actually happened — by drop or by menu, the same sentence. */
export function movedAnnouncement(
  itemText: string,
  from: BucketId,
  to: BucketId,
  voice: Voice,
): string {
  return `Moved ${quoted(itemText)} from ${spokenBucketName(from, voice)} to ${spokenBucketName(to, voice)}.`;
}

/**
 * A drop that resolved to nothing — a same-bucket drop, or a pair `dropPlan`
 * maps to `{ kind: "noop" }`. Names the item's *current* list, so the outcome
 * is unambiguous rather than merely negative.
 */
export function notMovedAnnouncement(
  itemText: string,
  from: BucketId,
  voice: Voice,
): string {
  return `${quoted(itemText)} was not moved. It is still in ${spokenBucketName(from, voice)}.`;
}

/** Escape, or a drop outside every bucket. */
export function cancelledAnnouncement(
  itemText: string,
  from: BucketId,
  voice: Voice,
): string {
  return `Move cancelled. ${quoted(itemText)} is still in ${spokenBucketName(from, voice)}.`;
}
