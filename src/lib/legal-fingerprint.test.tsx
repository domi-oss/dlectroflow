// @vitest-environment jsdom
import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { LEGAL_EFFECTIVE_DATE } from "@/lib/legal";
import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";

afterEach(cleanup);

/**
 * ⚠️ IF THIS TEST IS FAILING: you changed the text of a published legal
 * document. Decide whether the change is SUBSTANCE or COPY, then:
 *
 *   • Substance (a new disclosure, a changed promise, a different recipient,
 *     scope or retention) — bump `LEGAL_EFFECTIVE_DATE` in `src/lib/legal.ts`
 *     to today, then paste the hash from the failure message below.
 *   • Copy (a typo, a clearer sentence saying the same thing) — leave the date
 *     alone and just paste the new hash.
 *
 * Either way it is a deliberate line in the diff, which is the whole point. ⚠️
 *
 * Why this exists (#141). `src/lib/legal.ts` has always carried the rule in
 * prose — "anything here that changes is a legal change, not a copy tweak:
 * update the effective date in the same commit". Prose does not enforce
 * anything. On 2026-07-31 a new subsection was added to /privacy (the Google
 * Limited Use undertaking, #140) and the effective date was left on the
 * previous day's value, so the page published new material text while still
 * claiming to be the version a reader saw yesterday. Nothing failed, because
 * the existing `legal.test.ts` only checks the date is well-FORMED, never that
 * it is current. The owner caught it by reading the page.
 *
 * That failure mode is silent, public and legally consequential — the effective
 * date IS the version identifier of the document, and Google's OAuth reviewers
 * are among the people relying on it. Hence a gate rather than a note.
 *
 * WHY THE HASH IS OF RENDERED TEXT, NOT THE SOURCE FILE. Hashing `page.tsx`
 * would trip on a Prettier run, a JSX refactor or a className change — none of
 * which alter a single word a reader sees, and all of which would train
 * everyone to bump the hash without thinking. The rendered `textContent` is the
 * published document, so it moves when and only when the document moves.
 *
 * The effective date itself is stripped before hashing. Otherwise bumping the
 * date would change the hash, which would demand a second bump — the assertion
 * would be about itself instead of about the policy text.
 */

/**
 * The rendered date line. There is exactly ONE per page and it takes exactly
 * this form, because both pages get it from the same place — `LegalPage` in
 * `src/components/legal/legal-page.tsx` renders it once, and neither page body
 * repeats the date anywhere else.
 *
 * That is a claim about rendered output, so it is asserted rather than trusted:
 * see "no rendered date survives stripping" below. If a page ever grows a
 * second date (a "last updated" line, a version history), that test fails
 * first and points here — which is the order you want, because the failure the
 * unstripped date would otherwise cause is far more confusing: the fingerprint
 * would start moving every time the date is bumped, and the assertion would
 * quietly become about itself instead of about the policy text.
 */
const EFFECTIVE_DATE_TEXT = /Effective\s+\d{1,2}\s+\w+\s+\d{4}/g;

/** Any human-rendered date, in the `en-GB` long form these pages use. */
const ANY_LONG_DATE =
  /\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/;

function publishedText(node: React.ReactElement): string {
  const { container } = render(node);
  return container
    .textContent!.replace(EFFECTIVE_DATE_TEXT, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fingerprint(node: React.ReactElement): string {
  return createHash("sha256").update(publishedText(node)).digest("hex");
}

/**
 * Recorded fingerprints of the published text, as of LEGAL_EFFECTIVE_DATE.
 *
 * Deliberately NOT in `src/lib/legal.ts`: that module holds canonical FACTS
 * about the documents (who the controller is, where data sits), all of which
 * are rendered to readers. A hash is a build-time invariant nobody reads, and
 * putting it there would invite it into a page.
 */
const PUBLISHED = {
  // 2026-08-15, the legal-accuracy sweep — /privacy only. Ten measured drifts
  // between the page and the code, corrected as ONE publication event. Four of
  // them move the date on their own: a withdrawn Art. 9(2)(a) consent claim that
  // had no mechanism behind it, two egress paths the page said did not exist
  // (`Task.notes` into the LLM prompt, and into a scheduled Google Task's
  // `notes`), a retention sentence promising a purge that nothing runs, and four
  // newly disclosed categories of stored content. The full reasoning is in
  // `src/lib/legal.ts`'s docblock rather than duplicated here.
  //
  // WHY ONE COMMIT, since the temptation next time will be to split it: this
  // gate re-records BOTH hashes for whatever text state the tree renders, and
  // `legal.ts` allows the date to move once per publication. Two MRs each
  // touching this page would invalidate the other's recorded hash on merge and
  // bump the date twice for one publication — so a sweep lands together or not
  // at all.
  //
  // `terms` is untouched and its hash below is unchanged, which is the evidence
  // the two documents are genuinely disjoint here.
  //
  // RE-DERIVED FROM THE MERGED TREE, and this is the second recorded time that
  // mattered rather than a ritual — see the 2026-08-05 note further down for the
  // first. #85 landed on `main` while this sweep was in flight and it edits the
  // SAME page (the theme sentence, below Cookies), so the hash this branch
  // recorded before merging described a text state that will never be published:
  // this branch's ten corrections without #85's sentence. Neither side's hash is
  // correct for the merge. The rule generalises — if `main` moves under a branch
  // that touches a legal page, re-run this test after merging and paste the
  // result, never carry the pre-merge value across.
  //
  // ── 2026-08-14, #85 — /privacy only, and classified COPY, so
  // LEGAL_EFFECTIVE_DATE was deliberately NOT bumped; it stayed on 2026-08-08. ──
  // The theme setting became three-state (follow my system / light / dark), so
  // the sentence naming the stored value as a "light/dark theme choice" no
  // longer described what can be in `df-theme`. Everything the paragraph
  // DISCLOSES is unchanged: same key, same location (the browser's local
  // storage), same category (a UI preference), same retention, same recipients
  // (none), and the same promise that it never leaves the device. No new
  // processing exists to disclose either — following the OS is a `matchMedia`
  // read, which sends nothing anywhere.
  //
  // A first draft of that change also added a sentence asserting that reading
  // the OS setting stores and transmits nothing. It was dropped rather than
  // pinned: a claimed ABSENCE of processing is the one shape this file's own
  // docblock records having had to retract (#154's "no log of when it was
  // fetched", false on both deploy targets), and it earns nothing a reader does
  // not already get from the sentence above it. That instinct is the same one
  // the sweep above is correcting ten instances of, from the other end.
  //
  // ── the 2026-08-08 state those replaced ──
  // #199 — /privacy only. The stored-data list gains a shopping-list entry: a
  // new CATEGORY of stored content (Art. 13(1)(c)) plus the retention sentence
  // that comes with it, since a reader could otherwise infer that switching the
  // feature off disposes of what it held.
  //
  // ── the 2026-08-05 state this replaced, kept because the reasoning is reusable ──
  // Two changes shared LEGAL_EFFECTIVE_DATE and they touched DIFFERENT documents,
  // so exactly one hash moves per document rather than both moving:
  //
  //   privacy — #154, the calendar subscription feed. A new recipient (whichever
  //     calendar app the reader pastes the URL into), a new stored item (the
  //     capability token) and a new retention rule for it.
  //   terms   — #164, on `main`: what the backups do and do not do for one
  //     person, plus the sentence saying a copy can be downloaded from Settings.
  //
  // Both were re-derived from the MERGED tree, not copied from either branch —
  // the merge produces a text state neither side rendered alone, so a hash
  // carried across from one branch is only correct by luck. `terms` came back
  // byte-identical to `main`'s (this branch does not touch /terms), which is the
  // evidence that the two changes are genuinely disjoint.
  //
  // `privacy` moved a second time within #154, at 2026-08-05, and that one is
  // the reason to read this comment rather than skip it. The page had said
  // there was "no log of when it was fetched" — false on both deploy targets,
  // because the token is in the request path and both front ends log the
  // request line. Retracting a claimed absence of processing, and naming the
  // 30-day window in its place, is exactly the substance this gate exists to
  // stop shipping under yesterday's date. It is also the second time a #154
  // privacy claim has needed correcting before merge, which is the argument for
  // the drift row `docs/legal.md` now carries for it.
  // Moved once more within this same sweep, on review, and the reason is worth
  // keeping. The export-exclusion paragraph listed the account flags as "whether
  // your account is active and when it was last seen" — naming `User.status` and
  // `lastSeenAt` but silently dropping `revokedAt` and `providerSub`, which are
  // also held and also unexported. That is the SAME defect this sweep exists to
  // correct, committed inside the correction: a disclosure that lists some of
  // what it holds and reads as if it listed all of it.
  //
  // Nothing was published under the earlier hash — this branch has not merged —
  // so LEGAL_EFFECTIVE_DATE stays on 2026-08-15 rather than accumulating a
  // correction notice for a version no reader ever saw. Same handling as #154's
  // within-branch move, and the same lesson: a completeness claim has to be
  // checked on the defect's own axis (per omitted COLUMN here), not by counting
  // the categories that were easy to phrase.
  // And once more, on the third review round, for a COPY change: the health
  // clause repeated "records why you use it" one sentence after the bold lead-in
  // had already said it. Redundancy rather than inaccuracy — no disclosure moved,
  // so the date does not move for it either. Recorded because the alternative is
  // a hash whose provenance nobody can reconstruct, and because it is the third
  // re-record inside one branch: two for substance and merge, one for copy.
  // SIXTH re-record, and the reason is the most instructive one in this file:
  // THE ROUND-8 FIX INTRODUCED ITS OWN CONTRADICTION. Correcting "shown only to
  // you" produced "written for you and for nobody else — ... which means the
  // email provider ... handles it", which asserts and then refutes itself inside
  // a single sentence. Round 9 caught it.
  //
  // The lesson is narrower and more useful than "check the page against itself":
  // when a fix ADDS a qualifier to an absolute claim, the absolute has to be
  // RESCOPED, not merely qualified. "Nobody else" plus an exception is a
  // contradiction; "no other person using this app" plus the processor path is a
  // disclosure. Re-run the absolutes check on the FIX, not just on the original
  // prose — a correction is new text and inherits none of the checking done on
  // what it replaced.
  //
  // FIFTH re-record. Round 8 exposed a defect CLASS this sweep had no method
  // for — page-versus-page rather than page-versus-code — so the same check was
  // then run deliberately over every absolute claim the branch added, and it
  // found two more that Duo had not reached:
  //
  //   • "your settings are never sent" sat in the SAME PARAGRAPH as "one
  //     preference", and that preference is `Settings.voice`. A paragraph
  //     contradicting itself across two sentences, inherited from the pre-#123
  //     wording and carried through this rewrite. The voice is now named, which
  //     is a stronger disclosure than the denial it replaces.
  //   • the health paragraph's "keep them, show them back to you, and break them
  //     into steps" omitted the calendar and Google Tasks copy that F4 of this
  //     very MR discloses two sections earlier. "Nothing else is done with it"
  //     was therefore false against this branch's own new text.
  //
  // The method is the lesson: grep the added prose for absolutes — only, never,
  // nothing, nobody — and check each against the OTHER sections, not just the
  // code. Nine of the ten original findings were page-versus-code, which is why
  // this class went unexamined until a reviewer walked into it.
  //
  // Fourth re-record, for the self-contradiction round 8 DID find:
  // the roll-up narrative was described as "shown only to you" while
  // "Who else is involved" discloses that Resend receives the round-up email
  // containing that same narrative. One section's confidentiality claim against
  // another section's recipient disclosure — the exact defect class this branch
  // exists to remove, inside the paragraph the branch added.
  //
  // Worth keeping as the clearest lesson of the whole sweep: the new prose was
  // checked against the CODE, thoroughly, and not against the REST OF THE PAGE.
  // A page this long is its own consistency surface, and a recipient named in one
  // section falsifies an "only you" written in another. Nothing was published
  // under the earlier hashes, so the date stays 2026-08-15 for all four.
  privacy: "29026594108298d800d061d5a61dbc658f8532f911654da7d1af4af27d4dee01",
  // Untouched by both #85 and this sweep, and unchanged — the evidence that
  // neither change reaches both documents.
  terms: "836ef685761ab3db05397e7a4753da743e25836b9d9b4ab7c61a61920bdbfe9b",
} as const;

describe("legal: published text is pinned to the effective date (#141)", () => {
  it.each([
    ["privacy", () => <PrivacyPage />, PUBLISHED.privacy],
    ["terms", () => <TermsPage />, PUBLISHED.terms],
    // `it.each` fills `%s` POSITIONALLY from the tuple, so a second `%s` here
    // would print the page factory — in practice the whole transpiled JSX
    // expression — not the date. The date is interpolated at collection time
    // instead, which is also what makes the reported name state the version
    // the fingerprints belong to.
  ] as const)(
    `/%s text is unchanged as of ${LEGAL_EFFECTIVE_DATE}`,
    (name, page, recorded) => {
      const actual = fingerprint(page());
      expect(
        actual,
        `The rendered text of /${name} has changed.\n\n` +
          `  Current LEGAL_EFFECTIVE_DATE: ${LEGAL_EFFECTIVE_DATE}\n` +
          `  New fingerprint:              ${actual}\n\n` +
          `If the change is SUBSTANTIVE (a new disclosure, a changed promise, a\n` +
          `different recipient, scope or retention period), bump\n` +
          `LEGAL_EFFECTIVE_DATE in src/lib/legal.ts to today IN THE SAME COMMIT.\n` +
          `If it is a typo or a rewording that says the same thing, leave the date.\n` +
          `Then update PUBLISHED.${name} in this file to the fingerprint above.\n` +
          `See the docblock at the top of this file and docs/legal.md.`,
      ).toBe(recorded);
    },
  );

  it.each([
    ["privacy", () => <PrivacyPage />],
    ["terms", () => <TermsPage />],
  ] as const)("no rendered date survives stripping on /%s", (name, page) => {
    // The fingerprint must not move when only the effective date moves —
    // otherwise bumping the date invalidates the hash, the hash has to be
    // re-recorded in the same commit, and the gate ends up asserting against
    // its own last run rather than against the published text.
    //
    // `EFFECTIVE_DATE_TEXT` is what buys that, so this asserts the stripping is
    // COMPLETE rather than assuming the regex matches every form. Raised by
    // review of !222: the question "are you sure there is only one form?" is
    // not one a comment can answer durably, but a test can.
    const stripped = publishedText(page());
    expect(
      stripped,
      `/${name} still renders a date after stripping. Some date text is not ` +
        `matched by EFFECTIVE_DATE_TEXT, so it is inside the fingerprint — ` +
        `which means the hash will change every time LEGAL_EFFECTIVE_DATE is ` +
        `bumped. Widen the regex to cover the new form.`,
    ).not.toMatch(ANY_LONG_DATE);
    expect(
      stripped,
      `/${name} renders the raw ISO date in its text; strip it too.`,
    ).not.toContain(LEGAL_EFFECTIVE_DATE);
  });
});
