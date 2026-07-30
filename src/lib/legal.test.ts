import { describe, it, expect } from "vitest";
import {
  ADMIN_CONTACT_EMAIL,
  CONTROLLER_NAME,
  LEGAL_CONTACT_EMAIL,
  LEGAL_EFFECTIVE_DATE,
  HOSTING_REGION,
  BACKUP_RETENTION_DAYS,
  formatEffectiveDate,
} from "./legal";

/**
 * ⚠️ IF THIS TEST IS FAILING: the published legal pages have lost the name of
 * the person legally answerable for the data. Nothing else is broken — put a
 * real full legal name back in `CONTROLLER_NAME` in `src/lib/legal.ts`, and bump
 * `LEGAL_EFFECTIVE_DATE` in the same commit. ⚠️
 *
 * Why this is a CI-blocking gate and not a TODO comment (#123):
 *
 *  1. UK GDPR Article 13(1)(a) requires the controller to be IDENTIFIED in the
 *     privacy notice. A notice that names nobody is not a valid notice — the
 *     data subject has no one to address a rights request to, which makes every
 *     other promise on the page unenforceable.
 *  2. `CONTROLLER_NAME` is rendered verbatim on /privacy and /terms. A blank or
 *     a placeholder does not fail loudly at runtime; it publishes a legal
 *     document with a hole in it, at a real, indexed URL.
 *  3. Google's OAuth verification reviewers compare the name on the published
 *     policy against the name on the consent screen. A mismatch — let alone a
 *     placeholder — is a verification rejection, and the app cannot request the
 *     Google Tasks scope until it clears.
 *
 * The name was originally a `FULL_LEGAL_NAME_TODO` sentinel and this gate was
 * red on purpose until the owner supplied it. It is now set, so the assertion
 * has been retargeted at the two ways it could regress: being blanked, or a
 * placeholder sentinel being reintroduced (in a template, a fork, or a
 * find-and-replace). The failure mode it guards is silent, public, and legally
 * consequential — by the time a human notices, the document has been served.
 */
describe("legal: the controller must always be named (#123)", () => {
  it("CONTROLLER_NAME is a real, non-empty name", () => {
    expect(
      CONTROLLER_NAME.trim(),
      "CONTROLLER_NAME in src/lib/legal.ts must be the controller's real full " +
        "legal name. UK GDPR Art. 13(1)(a) requires the controller to be " +
        "identified, and this string is rendered verbatim on /privacy and " +
        "/terms. See the docblock above this test and docs/legal.md.",
    ).not.toBe("");
    // A single character is not a legal name; this catches a truncating edit.
    expect(CONTROLLER_NAME.trim().length).toBeGreaterThan(1);
  });

  it("CONTROLLER_NAME is not a placeholder sentinel", () => {
    // Catches the original FULL_LEGAL_NAME_TODO and every sibling convention a
    // fork or a template might reintroduce.
    expect(CONTROLLER_NAME).not.toMatch(
      /TODO|TBD|TBC|FIXME|XXX|placeholder|your[_\s-]?name|FULL_LEGAL_NAME/i,
    );
  });
});

describe("legal: the published constants are usable as published", () => {
  it("publishes both contact addresses on the app's own domain", () => {
    // Each is printed on a page search engines index, and the privacy address is
    // the ONLY route for a data-subject request, so a typo here has no fallback.
    expect(LEGAL_CONTACT_EMAIL).toMatch(/^[^\s@]+@dlectroflow\.dev$/);
    expect(ADMIN_CONTACT_EMAIL).toMatch(/^[^\s@]+@dlectroflow\.dev$/);
  });

  it("keeps the privacy and service inboxes separate", () => {
    // Collapsing the two would put routine support mail into the inbox carrying
    // the statutory one-month clock (Art. 12(3)) — the exact way a deadline gets
    // missed. If they are ever deliberately merged, this test is the place to
    // record that decision.
    expect(ADMIN_CONTACT_EMAIL).not.toBe(LEGAL_CONTACT_EMAIL);
  });

  it("carries an ISO effective date that is a real calendar date", () => {
    expect(LEGAL_EFFECTIVE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const parsed = new Date(`${LEGAL_EFFECTIVE_DATE}T00:00:00Z`);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    // Guards a fat-fingered month/day ("2026-07-32" parses in some engines).
    expect(parsed.toISOString().slice(0, 10)).toBe(LEGAL_EFFECTIVE_DATE);
  });

  it("names the hosting region and the backup window the policy asserts", () => {
    // Both are load-bearing factual claims in the privacy notice: the region is
    // the international-transfer answer for stored data, and the retention
    // window is what bounds an erasure request. See docs/legal.md.
    expect(HOSTING_REGION).toContain("United Kingdom");
    expect(BACKUP_RETENTION_DAYS).toBe(30);
  });

  it("formats the effective date in UK style, independent of the host timezone", () => {
    // Rendered inside a statically prerendered page: if this drifted by a day on
    // a machine west of UTC, the published date would not match the constant.
    expect(formatEffectiveDate("2026-07-29")).toBe("29 July 2026");
    expect(formatEffectiveDate("2026-01-01")).toBe("1 January 2026");
    expect(formatEffectiveDate()).toBe(
      formatEffectiveDate(LEGAL_EFFECTIVE_DATE),
    );
  });
});
