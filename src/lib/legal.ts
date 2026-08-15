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
 *
 * Bumped for the legal-accuracy sweep: ten measured drifts between /privacy and
 * what the code does, corrected in one commit. It moves the date on any one of
 * them; the reason to record them together is that they are one publication
 * event and the fingerprint gate re-records for a text state no single fix
 * rendered alone. /terms is untouched and its hash below is unchanged, which is
 * the evidence the two documents are disjoint here.
 *
 * The four that would each have moved it on their own:
 *
 *   1. A CHANGED LEGAL BASIS. The page claimed "explicit consent — Article
 *      9(2)(a) UK GDPR" permitted holding health details typed into a note.
 *      Nothing in src/ asks for that consent — no gate, no acknowledgement, no
 *      warning — so there was no consent to be explicit about. The claim is
 *      withdrawn rather than mechanised: the page now says it is not calling it
 *      consent and why. Retracting a claimed lawful basis is substance in the
 *      un-reassuring direction, which is the direction that must never ship
 *      quietly.
 *   2. A NEW DISCLOSURE OF WHAT LEAVES. `Task.notes` is selected by
 *      `breakdown-context.ts` and quoted verbatim into the LLM prompt by
 *      `buildNoteBlock` (#179, 2026-08-08) — while the page said the context
 *      "contains no free text". The same note is written into a scheduled
 *      Google Task's `notes` field by `encodeReclaim`, so it reaches a
 *      recipient the page described as receiving only a title and a due date.
 *      Two egress paths a reader was told did not exist.
 *   3. A CHANGED RETENTION STATEMENT. The page said a freeze "marks its content
 *      to be removed 30 days later". `freezeAccount` writes `User.purgeAfter`
 *      and nothing reads it, so no removal is scheduled. A reader waiting for a
 *      job that does not run is the failure this correction exists to stop, and
 *      the page had it both ways in consecutive sentences.
 *   4. NEW CATEGORIES OF STORED CONTENT: notes on tasks, steps and captures (up
 *      to 2,000 characters each), `User.displayName`, `FocusPlaylist.name` and
 *      `BreakdownTurn.message`. Art. 13(1)(c) disclosures, and the last was
 *      already named in the portability bullet as "the coaching conversations"
 *      while never being disclosed as stored — the page describing a thing it
 *      had not admitted to holding.
 *
 * Also narrowed, and worth its own line because the temptation is to delete it:
 * "nothing infers anything about ... how you are doing" was overstated, because
 * `DayRollup.narrative` is an LLM-written, STORED, second-person text about the
 * reader's day. The sentence stayed and gained the exception, rather than going,
 * because the first half of it is true and verified — no health, mood, energy,
 * sleep, medication or symptom column exists in any model. Note the narrative is
 * NOT opt-in: `roundup-card.tsx` triggers it at the reader's workday end and
 * `roundupEmailEnabled` gates only the email, so wording it as a setting the
 * reader switches on would understate it.
 *
 *
 * Bumped for #199: /privacy names a NEW CATEGORY OF STORED CONTENT — a shopping
 * list, its items, their ticked state and whether each has been moved to "saved
 * for later". A new kind of personal data being stored is an Art. 13(1)(c)
 * disclosure and would move this date on its own; the retention sentence that
 * comes with it ("switching the feature off hides the list without deleting it")
 * is a second one, because a reader could otherwise reasonably infer that turning
 * a feature off disposes of what it held.
 *
 * The feature is off by default and stores nothing until it is turned on, which is
 * stated on the page rather than left to be inferred — "we might store this" and
 * "we store this only if you ask us to" are different disclosures.
 *
 *
 * Two changes share this date, to two different documents — #164 to the Terms
 * and #154 to the Privacy Policy. Both are recorded, because a reader asking
 * why the date moved is owed both answers, and because the fingerprint gate
 * re-recorded BOTH hashes for a merged text state neither branch rendered
 * alone.
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
 *
 * Bumped for #154: a member can create a calendar subscription URL, which adds
 * a NEW RECIPIENT — whichever calendar app they paste it into then fetches their
 * scheduled step titles and times, on its own schedule, into that company's
 * storage and quite possibly outside the UK. That is a disclosure under Art.
 * 13(1)(e) and it would move this date on its own; a new stored item (the
 * capability token) and a new retention rule for it come with it. The recipient
 * is deliberately described as NOT a processor: the data subject chooses the app
 * and there is no contract with it, which is a different relationship from
 * Anthropic's or Resend's and has to read differently.
 *
 * Moved a day within #154, on review, and the reason is worth keeping. The first
 * draft told readers there was "no log of when it was fetched". That was false
 * on both deploy targets: the token travels in the request PATH, `docker/
 * Caddyfile` enables an access log, and `charts/dlectroflow/templates/
 * ingress.yaml` sets no `log-format` override, so ingress-nginx's default —
 * which contains `$request` — applies. Replacing a claimed ABSENCE of processing
 * with the disclosure that it happens, and for how long, is substance twice
 * over: a processing operation the reader was told did not exist, and a
 * retention period (30 days) that had never been stated on the page at all.
 * Nothing published under 2026-08-04 — this branch has not merged — so the date
 * tracks the latest substantive edit rather than accumulating a correction
 * notice for a version no reader ever saw.
 *
 *
 * Previously bumped for #129: access and portability are now exercisable from
 * Settings rather than only by emailing the controller, and /privacy says so —
 * the paragraph that used to read "there is no self-service export button yet"
 * would otherwise be a false statement on a published legal page. It also newly * discloses two deliberate exclusions (the Google OAuth tokens and any stored
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
export const LEGAL_EFFECTIVE_DATE = "2026-08-15";

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
