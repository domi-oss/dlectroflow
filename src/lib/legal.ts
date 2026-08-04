/**
 * Canonical facts for the public Privacy Policy and Terms of Service (#123).
 *
 * These live in ONE place because they appear in both legal pages, in the docs,
 * and on the Google OAuth consent screen — and a contact address that is right
 * in two of those four and stale in the others is worse than no address at all.
 * Google's OAuth verification reviewers check that the published contact works.
 *
 * Anything here that changes is a legal change, not a copy tweak: update the
 * effective date in the same commit so a reader can tell which version they saw.
 */

/**
 * The data controller under UK GDPR — the person legally answerable for the data.
 *
 * This must always be a real full legal name. UK GDPR Art. 13(1)(a) requires the
 * controller to be identified, and Google's OAuth verification compares the name
 * here against the consent screen — so a blank, or a reintroduced placeholder,
 * would both publish an unidentified controller and fail verification. A test in
 * src/lib/legal.test.ts guards against exactly that.
 */
export const CONTROLLER_NAME = "Dominique Top";

/**
 * Monitored address for privacy, data-subject and legal contact.
 *
 * Deliberately an alias on the app's own domain rather than a personal mailbox:
 * it is published on a page indexed by search engines, and it keeps the
 * controller's private inbox out of scrapers' reach without hiding the route.
 */
export const LEGAL_CONTACT_EMAIL = "privacy@dlectroflow.dev";

/**
 * Monitored address for general service contact: account and access questions,
 * and abuse reports. Published by the Terms of Service.
 *
 * Kept separate from LEGAL_CONTACT_EMAIL on purpose. A privacy contact is a
 * STATUTORY route with a one-month clock attached (UK GDPR Art. 12(3)), and
 * routine support traffic sharing that inbox is precisely how a statutory
 * deadline gets lost in a pile of "how do I change my timer sound" mail.
 */
export const ADMIN_CONTACT_EMAIL = "admin@dlectroflow.dev";

/**
 * The public source repository.
 *
 * Referenced in three places that must agree — the site footer, the Terms
 * (the AGPL position) and the Privacy Policy (the commit history IS the
 * change log for both documents) — so it lives here rather than as three
 * literals. It also does real work: AGPL-3.0 §13 requires an instance that
 * users interact with over a network to offer them the corresponding source,
 * and the footer link is how this instance discharges that.
 */
export const SOURCE_REPO_URL =
  "https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow";

/**
 * ISO date the current text took effect. Bump when the substance changes.
 *
 * ONE date covers both documents, so a substantive change to either moves it for
 * both. That is deliberate — a reader comparing the two should not have to hold
 * two version numbers — and it means /privacy's date can move while its text
 * has not. The fingerprint gate is what keeps that honest in the other
 * direction: the text cannot move without someone deciding about this date.
 *
 * Bumped for #164, which lands two changes to the Terms at once:
 *
 *   1. The Terms now say what the backups do and do not do for one person —
 *      whole-instance recovery, no per-person restore, and nothing that brings
 *      back a deletion. Telling a reader that a copy of their work cannot be
 *      fetched back for them changes what they can rely on, which is substance;
 *      the page previously said only "there are nightly backups", which invited
 *      the opposite inference.
 *   2. The same clause now tells the reader they can download a copy of
 *      everything from Settings. #129 shipped between the two halves of this
 *      change, so the advice "keep your own copy" stopped being something the
 *      reader had to arrange for themselves. Naming a route by which somebody
 *      can act on their own data is substance in the reassuring direction, and
 *      it moves the date for the same reason #153's erasure control did.
 *
 * Previously bumped for #129: access and portability are now exercisable from
 * Settings rather than only by emailing the controller, and /privacy says so —
 * the paragraph that used to read "there is no self-service export button yet"
 * would otherwise be a false statement on a published legal page. It also newly
 * discloses two deliberate exclusions (the Google OAuth tokens and any stored
 * LLM API key), and that a guest sandbox can exercise the right in full. HOW a
 * data subject exercises an Art. 15/20 right, and what is withheld from it, are
 * both part of the Art. 12/13 disclosure rather than presentation.
 *
 * Previously bumped for #153: erasure is now exercisable from Settings rather than only by
 * emailing the controller, and the retention section says what deleting your
 * own account actually does. HOW a data subject exercises an Art. 17 right is
 * part of the Art. 12/13 disclosure, not presentation, so it moves this date —
 * and the exception (the owner's own account cannot be deleted from the app) is
 * a limit on the right, which would move it on its own.
 *
 * Previously bumped for #140: /privacy carries the Google Limited Use
 * undertaking and an explicit statement that no Google data reaches the AI
 * provider. A new undertaking to a reader is substance by any reading.
 *
 * It did not move it in #140's own commit — the rule lived only in the prose
 * above and nothing enforced it, so the page shipped new material text under
 * the previous day's date. `src/lib/legal-fingerprint.test.tsx` (#141) is the
 * gate that now makes the next omission a red build instead of a lucky catch.
 *
 * Previously bumped for #126: freezing or deleting an account also revokes the
 * Google grant, which changed what the app does with somebody's Google account.
 */
export const LEGAL_EFFECTIVE_DATE = "2026-08-04";

/** Where the hosted instance and its backups physically sit. */
export const HOSTING_REGION = "London, United Kingdom (GCP europe-west2)";

/** Nightly database backup retention, matching the bucket's lifecycle rule. */
export const BACKUP_RETENTION_DAYS = 30;

/** Human-readable effective date, e.g. "29 July 2026". */
export function formatEffectiveDate(
  iso: string = LEGAL_EFFECTIVE_DATE,
): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
