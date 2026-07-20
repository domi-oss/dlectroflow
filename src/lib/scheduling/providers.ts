// The scheduling-provider registry — exactly the two shipped methods (`ics`,
// `googleTasks`) behind one interface (#34, epic #29 S1). NOT a plugin system:
// no dynamic registration/discovery, sized for the two methods that exist today.
//
// Client-safe: the providers wrap the existing `"use server"` actions (which
// import as RPC references, never bundling prisma/google into the client), and
// `isAvailable` is a pure predicate — so both server pages AND client components
// can import `availableProviders`/`isProviderAvailable` for the single
// "which methods can this workspace use?" answer.
import { scheduleViaIcs } from "@/app/actions/ics-schedule";
import { pushStepsToGoogleTasks } from "@/app/actions/google-schedule";
import { SchedulingMethod } from "./types";
import type {
  GoogleConnStatus,
  ScheduleOpts,
  ScheduleResult,
  SchedulingContext,
  SchedulingProvider,
  SchedulingProviderId,
} from "./types";

export const icsProvider: SchedulingProvider = {
  id: "ics",
  labelKey: "action.addToCalendar",
  // Universal, zero-OAuth baseline (#12 §4): guests, owner, self-hosters — all.
  isAvailable: () => true,
  async schedule(taskId: string, _ctx: SchedulingContext, opts?: ScheduleOpts): Promise<ScheduleResult> {
    // Preserve the exact single-arg call for stepless-default scheduling — no
    // trailing `undefined` opts, so call-site behavior/tests stay identical.
    const res =
      opts?.durationMin != null
        ? await scheduleViaIcs(taskId, { durationMin: opts.durationMin })
        : await scheduleViaIcs(taskId);
    return res.ok
      ? { ok: true, via: SchedulingMethod.Ics, ics: res.ics, icsFilename: res.icsFilename }
      : { ok: false, reason: res.reason, message: res.message };
  },
};

export const googleTasksProvider: SchedulingProvider = {
  id: "googleTasks",
  labelKey: "action.schedule",
  // Owner-only TODAY because Google is the singleton owner connection guests
  // must never touch. When F (#35) lands this predicate becomes per-user (a
  // ctx.google resolved for any user with their own connection) — the ONLY
  // change, no call-site churn. Gates on `configured`, not `connected`: the
  // connect/reconnect/needsReconnect nuances stay in `scheduleState`; this
  // answers only "is the method offered at all."
  isAvailable: (ctx) => ctx.isOwner && (ctx.google?.configured ?? false),
  // Google Tasks are date-based, so `opts.durationMin` doesn't apply and `ctx`
  // isn't needed today — both are declared with a `_` prefix so the interface
  // contract is satisfied explicitly and the omission is intentional, not silent
  // (matches icsProvider, which does consume `opts`).
  async schedule(taskId: string, _ctx: SchedulingContext, _opts?: ScheduleOpts): Promise<ScheduleResult> {
    const res = await pushStepsToGoogleTasks(taskId);
    return res.ok
      ? { ok: true, via: SchedulingMethod.GoogleTasks, scheduled: res.scheduled, listTitle: res.listTitle }
      : { ok: false, reason: res.reason, message: res.message };
  },
};

/** Static registry — two entries, not a plugin system. */
export const schedulingProviders: Record<SchedulingProviderId, SchedulingProvider> = {
  ics: icsProvider,
  googleTasks: googleTasksProvider,
};

/** The single "which methods can this workspace use?" answer. */
export function availableProviders(ctx: SchedulingContext): SchedulingProvider[] {
  return Object.values(schedulingProviders).filter((p) => p.isAvailable(ctx));
}

/** Convenience predicate for a single provider against a context. */
export function isProviderAvailable(provider: SchedulingProvider, ctx: SchedulingContext): boolean {
  return provider.isAvailable(ctx);
}

/**
 * The method a workspace's schedule *control* leads with (the rest go in the ▾
 * overflow), given the owner's resolved Google status (`null` = guest / non-owner,
 * mirroring the page's `owner ? googleStatus : null`). Owners lead with Google
 * Tasks — rendered as a Connect/Reconnect affordance by `scheduleState` until it
 * is actually usable — and keep ICS as the universal alternative; guests get ICS.
 *
 * This is the UI's control-visibility choice, deliberately distinct from
 * {@link isProviderAvailable} (which gates whether a method can run *right now*,
 * owner + configured): an unconfigured owner still LEADS with the Google control
 * even though `googleTasks` isn't yet available (spec §127 — the Connect
 * affordance is separate from availability). Centralizes the rule the three
 * client call sites previously each expressed as `effectiveGoogle ? … : ics` /
 * `google ? … : ics` / `!isGuest`.
 */
export function leadSchedulingMethod(google: GoogleConnStatus | null): SchedulingProviderId {
  return google != null ? "googleTasks" : "ics";
}
