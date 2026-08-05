"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/workspace";
import {
  createOwnFeed,
  disableOwnFeed,
  feedUrl,
  regenerateOwnFeed,
} from "@/lib/calendar-feed";

/**
 * #154 — the calendar subscription feed, from the account's own settings.
 *
 * `src/app/actions/account.ts` Rule 1, applied to a credential that leaves the
 * building: **none of these actions takes an id.** The account acted on comes
 * from `currentUser()`, so there is nothing in a request for a hand-rolled POST
 * to point at somebody else's feed — and no `=== me.id` check for a later
 * refactor to drop, because there is no parameter to compare. `calendar-feed.test.ts`
 * asserts the arity, and asserts that an id passed anyway is ignored.
 *
 * Create and regenerate are deliberately SEPARATE actions rather than one
 * upsert. If "create" minted a token unconditionally, a double-click, a replayed
 * form post or a click from a tab left open since yesterday would silently
 * revoke a URL that is working in somebody's calendar — and they would find out
 * days later, when their week stopped updating. Rotation should be the thing you
 * asked for, never the thing you got.
 *
 * **Signed-in only.** A guest sandbox expires in about a day, so a subscription
 * URL for one is a link that quietly dies; guests keep the per-task download and
 * the data export (#129), both of which are one-shot by nature. That is the
 * opposite call to the export's, and for the opposite reason: an export is
 * exactly what a soon-to-expire sandbox needs.
 */

export type CalendarFeedResult =
  { ok: true; url: string } | { ok: false; error: "not_signed_in" };

export type CalendarFeedOffResult =
  { ok: true } | { ok: false; error: "not_signed_in" };

const NOT_SIGNED_IN = { ok: false, error: "not_signed_in" } as const;

/** Turn the feed on. Idempotent — see `createOwnFeed`. */
export async function createCalendarFeed(): Promise<CalendarFeedResult> {
  const me = await currentUser();
  if (!me) return NOT_SIGNED_IN;

  const { token } = await createOwnFeed(me.id);
  revalidatePath("/settings");
  return { ok: true, url: feedUrl(token) };
}

/** Mint a new URL. The old one stops working on the next request. */
export async function regenerateCalendarFeed(): Promise<CalendarFeedResult> {
  const me = await currentUser();
  if (!me) return NOT_SIGNED_IN;

  const { token } = await regenerateOwnFeed(me.id);
  revalidatePath("/settings");
  return { ok: true, url: feedUrl(token) };
}

/** Turn the feed off. Safe to repeat. */
export async function disableCalendarFeed(): Promise<CalendarFeedOffResult> {
  const me = await currentUser();
  if (!me) return NOT_SIGNED_IN;

  await disableOwnFeed(me.id);
  revalidatePath("/settings");
  return { ok: true };
}
