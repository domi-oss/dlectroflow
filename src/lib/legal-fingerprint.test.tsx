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
  privacy: "1a7cd006060f6751679ea2bb32902aa5a731946337f314634b9125ed7f9888a5",
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
