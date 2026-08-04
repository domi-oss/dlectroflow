// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADMIN_CONTACT_EMAIL,
  CONTROLLER_NAME,
  LEGAL_CONTACT_EMAIL,
  SOURCE_REPO_URL,
  formatEffectiveDate,
} from "@/lib/legal";
import { ExportData } from "@/components/settings/export-data";
import TermsPage, { metadata } from "./page";

afterEach(cleanup);

function pageText(): string {
  const { container } = render(<TermsPage />);
  return container.textContent!.replace(/\s+/g, " ");
}

/**
 * Any assertion in the Terms that a member can get their own data out. Kept as
 * one pattern so the guard and its controls cannot drift apart, which is how the
 * original narrow version came to miss the wording #129 went on to use.
 *
 * It is now a REQUIREMENT rather than a prohibition — #129 shipped, so the Terms
 * must make this claim instead of must not. The pattern did not need to change
 * when the polarity did, which is the point of having recorded the intended
 * wording before there was anything to describe.
 *
 * The object list is deliberate, and the comment is deliberately precise about
 * it — an earlier version of this comment claimed the pattern "does not require
 * an object after the verb", which was false and overstated the reach. It DOES
 * require one of the listed data-referring objects.
 *
 * Why not drop the object requirement entirely: `you can download` alone would
 * match a sentence about the source code, which is a plausible addition to a
 * section that already discusses the AGPL licence, and a guard that fires on
 * that gets relaxed. Known gap, accepted: a phrasing that names the data some
 * other way again ("you can download the lot") would evade it. Add it here when
 * it appears rather than widening to the point of false positives.
 */
const EXPORT_CLAIM =
  /you (?:can|may|could) (?:export|download)\s+(?:your|a copy of|everything|all your|all of your)/i;

describe("Terms of Service page: structure", () => {
  it("has one h1 naming the document", () => {
    render(<TermsPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Terms of Service" }),
    ).toBeInTheDocument();
  });

  it("publishes the effective date in both human and machine form", () => {
    const { container } = render(<TermsPage />);
    const time = container.querySelector("time")!;
    expect(time).toHaveTextContent(formatEffectiveDate());
    expect(time).toHaveAttribute("dateTime", expect.stringMatching(/^\d{4}-/));
  });

  it("exports per-page metadata", () => {
    expect(metadata.title).toContain("Terms of Service");
    expect(String(metadata.description)).toMatch(/as is/i);
  });

  it("keeps the contents list and the section headings in lock-step", () => {
    const { container } = render(<TermsPage />);
    const links = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('nav a[href^="#"]'),
    );
    expect(links.length).toBeGreaterThanOrEqual(14);

    for (const link of links) {
      const id = link.getAttribute("href")!.slice(1);
      const heading = container.querySelector(`h2#${id}`);
      expect(heading, `no <h2 id="${id}"> for contents entry`).not.toBeNull();
      expect(heading!.textContent).toBe(link.textContent);
    }
  });

  it("renders the shared legal footer", () => {
    render(<TermsPage />);
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
  });

  it("cross-links to the Privacy Policy from the body, not just the footer", () => {
    // The Privacy Policy is incorporated into these Terms, so a reader must be
    // able to reach it from the clause that says so.
    const { container } = render(<TermsPage />);
    const inBody = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('main a[href="/privacy"]'),
    );
    expect(inBody.length).toBeGreaterThan(0);
  });
});

describe("Terms of Service page: the canonical constants", () => {
  it("names the same controller as the Privacy Policy", () => {
    expect(pageText()).toContain(CONTROLLER_NAME);
  });

  it("publishes the service address for account, access and abuse contact", () => {
    render(<TermsPage />);
    const links = screen.getAllByRole("link", { name: ADMIN_CONTACT_EMAIL });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).toHaveAttribute("href", `mailto:${ADMIN_CONTACT_EMAIL}`);
  });

  it("routes data questions to the separate privacy address", () => {
    // Deliberately two inboxes: the privacy route carries a statutory one-month
    // clock, and routine support traffic sharing it is how that gets missed.
    render(<TermsPage />);
    const links = screen.getAllByRole("link", { name: LEGAL_CONTACT_EMAIL });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).toHaveAttribute("href", `mailto:${LEGAL_CONTACT_EMAIL}`);
    expect(pageText()).toMatch(/statutory\s+one-month deadline/i);
  });

  it("links the licence and the source from the canonical repo URL", () => {
    const { container } = render(<TermsPage />);
    const hrefs = Array.from(
      container.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ).map((a) => a.getAttribute("href")!);
    expect(hrefs).toContain(SOURCE_REPO_URL);
    expect(hrefs.some((h) => h.startsWith(`${SOURCE_REPO_URL}/`))).toBe(true);
  });
});

describe("Terms of Service page: the substantive terms", () => {
  it("says it is free, as is, with no warranty and no uptime guarantee", () => {
    const text = pageText();
    expect(text).toMatch(/as is/i);
    expect(text).toMatch(/as available/i);
    expect(text).toMatch(/no warranties/i);
    // "Service level AGREEMENT" was the original wording and is a commercial
    // artefact — there is no commercial arrangement here for one to attach to.
    // The substance (no uptime promise) is what has to survive, not the phrase.
    expect(text).toMatch(
      /no uptime guarantee and no service level commitment/i,
    );
  });

  it("frames AI output as a suggestion and not professional advice", () => {
    // Worded supportively on purpose — the audience is people with ADHD, and this
    // is the section most likely to be read on a bad day — but it still has to do
    // the legal job.
    const text = pageText();
    expect(text).toMatch(/not professional advice/i);
    for (const kind of ["medical", "clinical", "therapeutic", "diagnostic"]) {
      expect(text.toLowerCase(), `missing "${kind}"`).toContain(kind);
    }
    expect(text).toMatch(/You are allowed to ignore it/i);
    // The supportive framing is a requirement, not decoration: assert the sign
    // that it was written rather than replaced with a disclaimer wall.
    expect(text).toMatch(/It counts steps\. It does not count worth\./);
  });

  it("sets out acceptable use", () => {
    const text = pageText();
    expect(text).toMatch(/another workspace/i);
    expect(text).toMatch(/denial of service/i);
    expect(text).toMatch(/resell, proxy or automate/i);
    expect(text).toMatch(/Security research is welcome/i);
    // #118 Phase C — the RATIONALE for the no-reselling rule was "it runs on my
    // API credentials and my money", which stopped being universally true once a
    // member could save their own key. The rule survives; the reason is now
    // qualified rather than false.
    expect(text).toMatch(/Unless you have saved your own API key/i);
    expect(text).toMatch(/lifts the allowance, not this rule/i);
  });

  it("puts the user's Google account content on the user", () => {
    const text = pageText();
    expect(text).toMatch(/your responsibility/i);
    expect(text).toMatch(/disconnect at any time/i);
  });

  it("says the Google connection is the user's own, not the instance's (#118)", () => {
    // Phase C: `GoogleAuth` is keyed on `userId`, so a member's tasks land in
    // THEIR Google account. The pre-Phase-C text described a single instance-wide
    // connection owned by the administrator, which would now be simply false.
    const text = pageText();
    expect(text).toMatch(/you connect your own Google account/i);
    expect(text).toMatch(/rather than mine or anybody else/i);
    // Revoking at Google works whatever state the account here is in — the
    // app's Disconnect is unreachable once an account is frozen, and since #126
    // a freeze revokes the grant for you, but neither of those is something the
    // user has to rely on (see the Privacy Policy tests).
    expect(text).toMatch(/revoking at Google.{0,3}s end always works/i);
  });

  it("covers a member's own API key: their key, their bill, their terms", () => {
    const text = pageText();
    expect(text).toMatch(/Your key, your bill/i);
    expect(text).toMatch(/Your agreement with the provider applies to it/i);
    // Removing it must not read as losing access altogether.
    expect(text).toMatch(/back to the shared allowance/i);
  });

  it("does not let BYO key read as BYO provider (#125 is unshipped)", () => {
    // The distinction that is easy to overstate and expensive to get wrong: the
    // caller supplies a KEY. `LLMCredentials` carries no base URL by design,
    // because a per-user endpoint would let a settings field aim the server at an
    // arbitrary host. The Terms must not imply a vendor choice that does not
    // exist.
    const text = pageText();
    expect(text).toMatch(
      /What a key does not do is let you choose the provider/i,
    );
    expect(text).toMatch(
      /no setting for a different vendor, model endpoint or address/i,
    );
    // The honest alternative offered instead of a per-user provider field.
    expect(text).toMatch(/run your own instance configured however you like/i);
    expect(text).not.toMatch(
      /you (?:can|may|could) (?:choose|pick|select|set) (?:your own|a different|another)\s+(?:AI\s+)?(?:provider|vendor|endpoint)/i,
    );
  });

  it("covers suspension and termination of access", () => {
    const text = pageText();
    expect(text).toMatch(/suspend or end your access/i);
    expect(text).toMatch(/You can stop whenever you like/i);
    // And is honest that termination is not deletion today.
    expect(text).toMatch(/does not automatically delete your content/i);
  });

  it("limits liability WITHOUT purporting to exclude what cannot be excluded", () => {
    // The carve-outs are the part that makes the rest of the clause stand up.
    const text = pageText();
    expect(text).toMatch(/death or personal injury caused by my negligence/i);
    expect(text).toMatch(/fraud or fraudulent misrepresentation/i);
    expect(text).toMatch(/cannot lawfully be excluded or limited/i);
    // A nominal cap rather than a pretence of zero liability.
    expect(text).toContain("£100");
    // And data protection rights are explicitly untouched.
    expect(text).toMatch(
      /rights under UK data protection law are also untouched/i,
    );
  });

  it("does not make the carve-outs conditional on being a business or trader", () => {
    // The analysis that actually changed when "sole trader" came out. The rules
    // forbidding exclusion of death/personal-injury and fraud liability are
    // largely aimed at businesses and traders (CRA 2015 binds a "trader"; UCTA
    // 1977 ss.2-7 reach "business liability"), and whether an unpaid hobby
    // project is either is genuinely arguable. The page must NOT reason its way
    // out of the carve-outs on that basis — it says so explicitly instead, so
    // the clause holds however that argument would come out.
    const text = pageText();
    expect(text).toMatch(/one argument I am deliberately not making/i);
    expect(text).toMatch(/not conditional on my status/i);
    expect(text).toMatch(/whether or not those rules reach me/i);
  });

  it("states the AGPL position for the code versus the hosted service", () => {
    const text = pageText();
    expect(text).toMatch(/GNU Affero General Public License v3\.0/);
    expect(text).toMatch(/covers the software, not this service/i);
    expect(text).toMatch(/section 13/i);
  });

  it("sets governing law to England and Wales, without a where-you-live trap", () => {
    const text = pageText();
    expect(text).toMatch(/law of England and Wales/);
    expect(text).toMatch(/courts of England and Wales/i);
    // Someone in Scotland or NI can still sue where they live. Phrased WITHOUT
    // resting on "consumer"/"trader" status, because nothing is charged for here
    // and those labels are arguable — the right should not depend on the label.
    expect(text).toMatch(/Scotland or Northern Ireland/);
    expect(text).toMatch(/mandatory legal protection you have there/i);
  });

  it("explains how changes are notified", () => {
    const text = pageText();
    expect(text).toMatch(/effective date/i);
    expect(text).toMatch(/Continuing to use dlectroflow after a change/i);
  });

  it("keeps the boilerplate short but present", () => {
    const text = pageText();
    expect(text).toMatch(/Severability/);
    expect(text).toMatch(/No waiver/);
    expect(text).toMatch(/Contracts \(Rights of Third Parties\) Act 1999/);
  });

  it("states the minimum age and that accounts are invite-only", () => {
    const text = pageText();
    expect(text).toMatch(/at least 13/i);
    expect(text).toMatch(/invite-only/i);
  });
});

// ── The non-commercial framing ──────────────────────────────────────────────
//
// The controller is an individual running a NON-COMMERCIAL HOBBY PROJECT: no
// company, no trade, no business, nothing charged for. An earlier draft of this
// page described them as "trading as a sole trader", which asserted a commercial
// undertaking that does not exist — actively misleading, and it dragged a
// consumer-sale analysis in behind it.
//
// These tests exist because that wording is exactly the kind of thing a template,
// a fork, or a well-meaning find-and-replace reintroduces silently: it reads
// professional, so nobody questions it.
describe("Terms of Service page: non-commercial framing", () => {
  it("describes the controller as a non-commercial hobby project", () => {
    const text = pageText();
    expect(text).toMatch(/personal, non-commercial hobby project/i);
    expect(text).toMatch(/not a company, not a business, and not a trade/i);
  });

  it("says plainly that this is not a sale and the user is not a customer", () => {
    // Load-bearing for the warranty and liability sections, which are written for
    // a free gift of software rather than for a purchase.
    const text = pageText();
    expect(text).toMatch(/this is not a sale and you are not a customer/i);
    expect(text).toMatch(/given away/i);
  });

  it("never claims to trade, and never calls the controller a sole trader", () => {
    const text = pageText();
    expect(text).not.toMatch(/sole trader/i);
    expect(text).not.toMatch(/trading as/i);
    // The bare word "trader" survives in exactly one place: the clause explaining
    // that the governing-law wording deliberately does NOT rest on that label. So
    // assert on the assertive phrasings rather than banning the word outright.
    expect(text).not.toMatch(/\bI am a trader\b/i);
  });

  it("still points at the Privacy Policy for why data law applies anyway", () => {
    // Non-commercial is a real fact about the project. It is NOT a data
    // protection exemption, and these Terms must not leave that impression.
    expect(pageText()).toMatch(
      /does not exempt me from UK data protection law/i,
    );
  });
});

// ── #164: the backups are not a personal undo ───────────────────────────────
//
// Before this clause the page mentioned backups once, in the as-is section, and
// never said what they do for ONE reader. To somebody who has just deleted the
// wrong task, "there are nightly backups" reads like a copy of their work is
// sitting somewhere and can be fetched. It cannot: a dump is whole-database and
// is restored whole, and a deleted capture, task or step is a hard delete
// (`deleteMany`, no soft-delete column on those models — see
// src/app/actions/braindump.ts and src/app/actions/breakdown.ts).
//
// Both halves are pinned, because they fail in opposite directions:
//
//   • Lose the "no per-person restore" half and the page publishes an implied
//     promise the operator cannot keep.
//   • Lose the "whole-instance recovery is a real obligation" half and a
//     description of how the service works turns into a blanket disclaimer of
//     responsibility for data — exactly what the docblock at the top of page.tsx
//     says the liability drafting is careful NOT to do, because an over-broad
//     exclusion risks the whole section rather than strengthening it.
describe("Terms of Service page: no per-user restore (#164)", () => {
  function sectionText(id: string): string {
    const { container } = render(<TermsPage />);
    const section = container.querySelector(`section[aria-labelledby="${id}"]`);
    expect(section, `no <section aria-labelledby="${id}">`).not.toBeNull();
    return section!.textContent!.replace(/\s+/g, " ");
  }

  it("carries the clause in Your data, not in the liability section", () => {
    // Placement is deliberate: this describes how the service works, so it sits
    // with the data section. Putting it under "Limits on my liability" would
    // frame an operational fact as an exclusion, which is the reading the clause
    // is written to avoid.
    expect(sectionText("data")).toMatch(/no per-person restore/i);
    expect(sectionText("liability")).not.toMatch(/per-person restore/i);
  });

  it("says the backups exist to bring the whole instance back", () => {
    const text = sectionText("data");
    expect(text).toMatch(/nightly backups/i);
    expect(text).toMatch(/they are how it comes back/i);
  });

  it("says plainly there is no per-person restore and no undo for a deletion", () => {
    const text = pageText();
    expect(text).toMatch(/What they are not is a personal undo/i);
    expect(text).toMatch(/There is no per-person restore/i);
    expect(text).toMatch(/not something I can offer you/i);
    expect(text).toMatch(/gone from the app there and then/i);
    // The advice the clause exists to justify.
    expect(text).toMatch(
      /the one piece of advice on this page I would most like you to take/i,
    );
  });

  it("states the whole-instance obligation instead of disclaiming data at all", () => {
    // The narrow honest claim is "no individual restore", never "no
    // responsibility". Asserted in both directions so a future tightening
    // cannot quietly widen it.
    //
    // The obligation is asserted as CONDUCT ("I treat it as one"), not as a
    // claim that nothing in these Terms disclaims it. The liability section does
    // exclude liability for loss of data, and a page whose clauses look like
    // they argue with each other is a worse page — see the source comment.
    const text = pageText();
    expect(text).toMatch(/a real obligation and I treat it as one/i);
    expect(text).not.toMatch(
      /no responsibility for (?:your |the |any )?(?:data|content)/i,
    );
    expect(text).not.toMatch(
      /not responsible for (?:your |the |any )?(?:data|content)/i,
    );
  });

  it("tells the reader they can get their own copy, now that they can (#129)", () => {
    // THIS ASSERTION USED TO BE `.not.toMatch`. Until #129 shipped there was no
    // route to point at, and the clause deliberately left the slot empty — a
    // dead link in a published legal document is worse than no link at all.
    // `GET /api/export` and the Settings control are real as of #129, so the
    // omission stopped being caution and became a page that understates what
    // the reader can do. The guard is now the other way round, and the same
    // pattern does both jobs.
    const text = pageText();
    expect(text).toMatch(EXPORT_CLAIM);
  });

  it("names Settings in prose and links no download endpoint (#129)", () => {
    // The claim has to say WHERE, or it is a reassurance the reader cannot act
    // on, and "keep your own copy" is the one instruction this clause exists to
    // make followable.
    const { container } = render(<TermsPage />);
    const text = container.textContent!.replace(/\s+/g, " ");
    expect(text).toMatch(/download a copy of everything from Settings/i);

    // And it stays PROSE. The absent link is not a leftover from when there was
    // nothing to link — it is the decision, and it is asserted so that a future
    // "helpful" tidy-up has to argue with a test rather than with a comment:
    //
    //   • `/api/export` is a GET that returns a file, not a page. A legal
    //     document is a thing people read; a link in it that starts a download
    //     is not what a reader is agreeing to click.
    //   • /terms is PUBLIC (`PUBLIC_PREFIXES` in src/lib/auth/gate.ts) and
    //     `/api/export` is NOT in `AUTHENTICATED_PREFIXES` — so a signed-out
    //     reader following the link does not get a login prompt, or even a 401.
    //     `src/proxy.ts` mints them a fresh guest workspace and the route
    //     cheerfully exports it: an archive of nothing, which reads as "the
    //     operator holds nothing about me" or "the export is broken". That is a
    //     worse outcome than the dead link this guard was originally written to
    //     prevent, and it is silent.
    //   • The endpoint has a cooldown (`src/lib/export/cooldown.ts`), so a
    //     stray click from a page nobody is signed in on can spend it.
    //
    // Settings is behind the auth gate, so the prose names it rather than
    // linking that either: the reader who can act on this sentence is already
    // signed in and knows where Settings is.
    const hrefs = Array.from(
      container.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ).map((a) => a.getAttribute("href")!);
    expect(hrefs.filter((h) => /export/i.test(h))).toEqual([]);
  });

  it("only makes that claim because the control it describes is real (#129)", () => {
    // The premise, pinned. The whole reason the sentence was withheld for so
    // long was that a published legal document must not describe a feature that
    // does not exist — and "it exists today" is not a property a comment can
    // keep true. So the claim is tied to the actual control: Settings → Account
    // renders `ExportData`, and that is what `/api/export` hangs off.
    //
    // If the export is ever removed or moved, this fails next to the clause
    // that depends on it, rather than the Terms quietly becoming false.
    render(<ExportData />);
    const control = screen.getByRole("link", { name: /download my data/i });
    expect(control).toHaveAttribute("href", "/api/export");
  });

  it("the export guard is specific enough for its own assertion to mean something", () => {
    // A `.toMatch` guard fails in the opposite direction to the `.not.toMatch`
    // it replaced: instead of missing a claim that went live, it can be
    // satisfied by any nearby sentence, and then it asserts nothing. So the
    // discrimination is tested rather than assumed — the negative control below
    // is now the load-bearing half.
    //
    // WAS (while #129 was unshipped): this test proved the guard COULD fire, by
    // matching it against the wording recorded in a comment in page.tsx. That
    // mattered because the original pattern required "your" or "a copy of your"
    // and so would NOT have matched "a copy of everything" — it would have
    // stayed green while the claim went live. Raised by GitLab Duo on !252. The
    // pattern is still the widened one for exactly that reason, so the examples
    // stay: they are what stops a future narrowing from going unnoticed.
    expect("You can download a copy of everything from Settings.").toMatch(
      EXPORT_CLAIM,
    );
    expect("You can export your data at any time.").toMatch(EXPORT_CLAIM);
    expect("You may download a copy of your data.").toMatch(EXPORT_CLAIM);
    // Raised by review on !252: these two evaded the earlier pattern.
    expect("You can export all your data.").toMatch(EXPORT_CLAIM);
    expect("You can download everything from Settings.").toMatch(EXPORT_CLAIM);
    // Not a claim about export, so it must not satisfy the guard — otherwise
    // the assertion above would be met by the AGPL section and the Terms could
    // drop the export sentence entirely without anything going red.
    expect("You can download the source code.").not.toMatch(EXPORT_CLAIM);
  });

  it("links the as-is warning to the fuller clause so the two cannot drift", () => {
    // Two statements of the same fact in one document is how a document
    // contradicts itself. The as-is section keeps the one-line gist and points
    // here for the detail, rather than half-stating it a second time.
    const { container } = render(<TermsPage />);
    const free = container.querySelector('section[aria-labelledby="free"]')!;
    expect(free.querySelector('a[href="#data"]')).not.toBeNull();
  });
});
