import { describe, it, expect } from "vitest";
import { STRINGS, type Voice } from "@/lib/strings";
import {
  MAX_SHOPPING_ITEMS,
  SHOPPING_ITEM_TEXT_MAX_LENGTH,
} from "@/lib/shopping";

/**
 * #199 — the shopping copy that quotes a NUMBER has to quote the real one.
 *
 * Two refusal messages name a limit out loud: "200 characters is the limit" and
 * "full at 500 items". Both numbers are also constants, enforced in TypeScript and
 * (for the character bound) in a database CHECK — so the copy is a third statement
 * of a fact the code already holds twice, and the third one is the only one nothing
 * checks.
 *
 * That is the cheapest class of bug this repo keeps finding: a document that
 * contradicts itself, detectable with no database and no browser, just by reading
 * one file against another. Raising `MAX_SHOPPING_ITEMS` to 1000 and leaving the
 * copy saying 500 would ship a message that is confidently wrong to the one person
 * who has just been refused, and every other test in the suite would stay green.
 *
 * Asserted for BOTH voices, because the playful string is a separate literal and
 * an edit to one is not an edit to the other (#86).
 */

const VOICES: Voice[] = ["plain", "playful"];

describe("shopping copy quotes the real bounds (#199)", () => {
  it.each(VOICES)(
    "the too-long refusal names SHOPPING_ITEM_TEXT_MAX_LENGTH (%s)",
    (voice) => {
      expect(STRINGS["shopping.errorTooLong"][voice]).toContain(
        String(SHOPPING_ITEM_TEXT_MAX_LENGTH),
      );
    },
  );

  it.each(VOICES)(
    "the list-full refusal names MAX_SHOPPING_ITEMS (%s)",
    (voice) => {
      expect(STRINGS["shopping.errorFull"][voice]).toContain(
        String(MAX_SHOPPING_ITEMS),
      );
    },
  );

  // The control that stops the two assertions above passing on a coincidence: a
  // message that happened to contain any digits would satisfy `toContain` if the
  // constants were, say, single-digit. These are the numbers the copy must NOT be
  // caught quoting, i.e. the previous plausible values and the other bound.
  it("does not confuse the two bounds with each other", () => {
    expect(SHOPPING_ITEM_TEXT_MAX_LENGTH).not.toBe(MAX_SHOPPING_ITEMS);
    expect(STRINGS["shopping.errorTooLong"].plain).not.toContain(
      String(MAX_SHOPPING_ITEMS),
    );
    expect(STRINGS["shopping.errorFull"].plain).not.toContain(
      String(SHOPPING_ITEM_TEXT_MAX_LENGTH),
    );
  });

  // #199's copy promise, and the only place a reader learns it: the feature's
  // Settings hint is what distinguishes "hide" from "delete". Asserted here rather
  // than only in the component test, so the SENTENCE survives a component rewrite.
  it.each(VOICES)(
    "the Settings hint says off is not destructive (%s)",
    (voice) => {
      expect(STRINGS["shopping.settingsHint"][voice]).toMatch(
        /hides the list (?:without deleting it|rather than binning it)/i,
      );
    },
  );

  // The page's own promise about what this list is NOT. The absence of the focus,
  // schedule and estimate controls is asserted in shopping-list.test.tsx; this is
  // the half that tells the reader it is deliberate.
  it.each(VOICES)("the intro says ticking off earns nothing (%s)", (voice) => {
    expect(STRINGS["shopping.intro"][voice]).toMatch(/streak/i);
  });
});
