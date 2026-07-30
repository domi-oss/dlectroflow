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

/** ISO date the current text took effect. Bump when the substance changes. */
export const LEGAL_EFFECTIVE_DATE = "2026-07-29";

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
