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
  privacy: "784c6e5b04ef5a82c34951ad5001a74d592232fc05473168b8d13317cba61ab3",
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
