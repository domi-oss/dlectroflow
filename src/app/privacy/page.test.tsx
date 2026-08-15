// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKUP_RETENTION_DAYS,
  CONTROLLER_NAME,
  HOSTING_REGION,
  LEGAL_CONTACT_EMAIL,
  formatEffectiveDate,
} from "@/lib/legal";
import { sectionById, sectionLabel } from "@/lib/section-nav";
import PrivacyPage, { metadata } from "./page";

afterEach(cleanup);

/** The whole page as one normalised string, for "does it say X at all" checks. */
function pageText(): string {
  const { container } = render(<PrivacyPage />);
  // Collapse whitespace: JSX splits sentences across lines and interpolations,
  // so raw textContent is full of incidental newlines and double spaces.
  return container.textContent!.replace(/\s+/g, " ");
}

describe("Privacy Policy page: structure", () => {
  it("has one h1 naming the document", () => {
    render(<PrivacyPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Privacy Policy" }),
    ).toBeInTheDocument();
  });

  it("publishes the effective date in both human and machine form", () => {
    // The date IS the version identifier of a legal document, so it has to be
    // unambiguous to a reader and parseable by anything archiving the page.
    const { container } = render(<PrivacyPage />);
    const time = container.querySelector("time")!;
    expect(time).toHaveTextContent(formatEffectiveDate());
    expect(time).toHaveAttribute("dateTime", expect.stringMatching(/^\d{4}-/));
  });

  it("exports per-page metadata", () => {
    // Without this the page inherits the root layout's title ("dlectroflow"),
    // which is what a search result and a browser tab would show for a legal
    // document. Google's reviewer arrives via a bare URL, so the title is the
    // only context they get before reading.
    expect(metadata.title).toContain("Privacy Policy");
    expect(String(metadata.description)).toMatch(/UK GDPR/);
  });

  it("keeps the contents list and the section headings in lock-step", () => {
    // The anti-drift guard. Every entry in "On this page" must point at a heading
    // that exists and reads the same — otherwise an edit that renames a section
    // leaves a contents link jumping nowhere, in a document people navigate by
    // section reference.
    const { container } = render(<PrivacyPage />);
    const links = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('nav a[href^="#"]'),
    );
    expect(links.length).toBeGreaterThanOrEqual(15);

    for (const link of links) {
      const id = link.getAttribute("href")!.slice(1);
      const heading = container.querySelector(`h2#${id}`);
      expect(heading, `no <h2 id="${id}"> for contents entry`).not.toBeNull();
      expect(heading!.textContent).toBe(link.textContent);
    }
  });

  it("makes every section heading a focusable jump target", () => {
    // Matches the convention in src/components/nav/section-heading.tsx: a
    // fragment jump should move real focus to the heading, not leave a keyboard
    // or screen-reader user at the top of a very long document.
    const { container } = render(<PrivacyPage />);
    const sectionHeadings = container.querySelectorAll("section > h2[id]");
    expect(sectionHeadings.length).toBeGreaterThanOrEqual(15);
    for (const heading of sectionHeadings) {
      expect(heading).toHaveAttribute("tabindex", "-1");
    }
  });

  // The name is asserted in full rather than as "Terms" (#200). It carries the
  // WCAG 3.2.5 announcement now that the link opens a new tab, and the whole
  // point of putting it in the accessible name is that a screen-reader user
  // hears it — so a spec matching only the visible half would pass with the
  // announcement missing, which is the thing that must not regress.
  it("renders the shared legal footer, announcing the new tab", () => {
    render(<PrivacyPage />);
    const terms = screen.getByRole("link", {
      name: "Terms (opens in a new tab)",
    });
    expect(terms).toHaveAttribute("href", "/terms");
    expect(terms).toHaveAttribute("target", "_blank");
    expect(terms).toHaveAttribute("rel", "noopener noreferrer");
  });
});

describe("Privacy Policy page: the canonical constants, not copies of them", () => {
  // These four are the values src/lib/legal.ts exists to own. Asserting the page
  // renders the CONSTANT's value (rather than a matching literal) is what stops a
  // future edit hardcoding a second copy that then goes stale — the exact failure
  // the module's own docblock warns about.
  it("names the controller from CONTROLLER_NAME", () => {
    expect(pageText()).toContain(CONTROLLER_NAME);
  });

  it("publishes LEGAL_CONTACT_EMAIL as a working mailto link", () => {
    render(<PrivacyPage />);
    const contacts = screen.getAllByRole("link", {
      name: LEGAL_CONTACT_EMAIL,
    });
    expect(contacts.length).toBeGreaterThan(0);
    expect(contacts[0]).toHaveAttribute(
      "href",
      `mailto:${LEGAL_CONTACT_EMAIL}`,
    );
  });

  it("states the hosting region from HOSTING_REGION", () => {
    expect(pageText()).toContain(HOSTING_REGION);
  });

  it("states the backup window from BACKUP_RETENTION_DAYS", () => {
    expect(pageText()).toContain(`${BACKUP_RETENTION_DAYS} days`);
  });
});

describe("Privacy Policy page: the disclosures UK GDPR requires", () => {
  it("identifies the controller, the jurisdiction and the regime", () => {
    const text = pageText();
    expect(text).toMatch(/data controller/i);
    expect(text).toMatch(/United Kingdom/);
    expect(text).toMatch(/UK GDPR/);
    expect(text).toMatch(/Data Protection Act 2018/);
  });

  it("explains why no DPO is required, rather than just asserting it", () => {
    // Art. 37(1) is a closed list; "at this scale" alone invited the reader to
    // take it on trust.
    expect(pageText()).toMatch(/Article 37 requires one only for/i);
  });

  it("gives a specific lawful basis per purpose, with articles cited", () => {
    const text = pageText();
    for (const article of [
      "Article 6(1)(a)", // consent — the optional Google connection
      "Article 6(1)(b)", // contract — operating an invited account
      "Article 6(1)(c)", // legal obligation — rights requests
      "Article 6(1)(f)", // legitimate interests — guest sandbox, allowlist, caps
    ]) {
      expect(text, `missing lawful basis citation ${article}`).toContain(
        article,
      );
    }
    expect(text).toMatch(/legitimate interests/i);
  });

  it("names every third-party recipient, including the AI provider", () => {
    const text = pageText();
    for (const recipient of [
      "Anthropic",
      "Google Cloud Platform",
      "Google Tasks",
      "Resend",
      "GitLab",
    ]) {
      expect(text, `missing recipient ${recipient}`).toContain(recipient);
    }
  });

  it("discloses the transfer to the United States as an international transfer", () => {
    // The point of the section: it must be stated as a transfer, not left to be
    // inferred from a company being American.
    const text = pageText();
    expect(text).toMatch(/international transfer/i);
    expect(text).toMatch(/Anthropic PBC, United States/);
    expect(text).toMatch(/Article 46/);
    expect(text).toMatch(/standard contractual clauses/i);
    expect(text).toMatch(/International Data Transfer Addendum/);
  });

  it("names the single Google OAuth scope, verbatim and alone", () => {
    // Google's verification reviewers check that the published policy matches the
    // scope actually requested. The literal has to be exact.
    const text = pageText();
    expect(text).toContain("https://www.googleapis.com/auth/tasks");
    // And says what it is for, plus what it explicitly is not.
    expect(text).toMatch(/No Gmail, no Calendar, no Drive, no Contacts/);
  });

  it("hosts the Google Limited Use affirmative statement, verbatim", () => {
    // Google's Third-Party Data Safety team requires an affirmative Limited Use
    // statement hosted on the app or its website whenever an app pairs a
    // Workspace API with any AI/ML model. Their reviewers grep for this wording,
    // so it is reproduced exactly as published rather than paraphrased — the
    // whole point of the sentence is that it is the standard one.
    const text = pageText();
    expect(text).toContain(
      "The use of raw or derived user data received from Workspace APIs will " +
        "adhere to the Google User Data Policy, including the Limited Use " +
        "requirements.",
    );
  });

  it("states that no Google data reaches the AI provider", () => {
    // The substantive half of the Limited Use answer. The claim is true because
    // the Tasks integration is write-only — `src/lib/google.ts` reads only the
    // user's task-LIST names (to find the list to write into) and never a task
    // back — so no Workspace data exists in the app to send onward. If that
    // direction ever reverses, this test is the tripwire and the policy is a lie.
    const text = pageText();
    expect(text).toMatch(
      /Nothing from your Google account is ever sent to the AI provider/i,
    );
    // And the Limited Use clause Google actually cares about: no training.
    expect(text).toMatch(
      /nothing from your Google account is used to train, improve or evaluate any AI model/i,
    );
  });

  it("describes what is sent to the AI provider, and what is not", () => {
    const text = pageText();
    expect(text).toMatch(/task.{0,20}title/i);
    // The non-obvious one: a brain-dump item's text BECOMES the task title when
    // you break it down, so claiming captures are never sent would be false.
    expect(text).toMatch(/becomes the task title/i);
    expect(text).toMatch(/numbers and flags only/i);
  });

  it("states the security measures the policy relies on", () => {
    const text = pageText();
    expect(text).toContain("AES-256-GCM");
    expect(text).toMatch(/HTTPS/);
    expect(text).toMatch(/invite-only/i);
    expect(text).toMatch(/workspace/i);
  });

  it("lists all six data-subject rights and how to use them", () => {
    const text = pageText();
    for (const right of [
      "Access",
      "Rectification",
      "Erasure",
      "Restriction",
      "Portability",
      "Objection",
    ]) {
      expect(text, `missing right: ${right}`).toContain(right);
    }
    expect(text).toMatch(/within one month/i);
  });

  it("gives the ICO complaint route", () => {
    // One render only: pageText() renders too, and a second render would leave
    // two copies of every link in the document for getByRole to trip over.
    const { container } = render(<PrivacyPage />);
    const text = container.textContent!.replace(/\s+/g, " ");
    expect(text).toMatch(/Information Commissioner/);
    expect(text).toContain("0303 123 1113");
    expect(
      screen.getByRole("link", { name: /ico\.org\.uk\/make-a-complaint/ }),
    ).toHaveAttribute("href", "https://ico.org.uk/make-a-complaint/");
  });

  it("rules out automated decision-making with legal or similar effect", () => {
    const text = pageText();
    expect(text).toMatch(/Article 22/);
    expect(text).toMatch(/legal or\s+similarly significant effects/i);
  });

  it("covers children, and the under-13 position", () => {
    expect(pageText()).toMatch(/not intended for children under 13/i);
  });

  it("explains how changes are communicated", () => {
    const text = pageText();
    expect(text).toMatch(/effective date/i);
    expect(text).toMatch(/source repository/i);
  });

  it("accounts for every cookie the app sets", () => {
    // Six cookies, and the policy is only accurate while it lists all six.
    const text = pageText();
    for (const cookie of [
      "df_guest",
      "df_owner",
      "gitlab_oauth_state",
      "gitlab_pkce_verifier",
      "google_oauth_state",
      "google_pkce_verifier",
    ]) {
      expect(text, `undisclosed cookie: ${cookie}`).toContain(cookie);
    }
    expect(text).toMatch(/strictly necessary/i);
    expect(text).toMatch(/no cookie banner/i);
  });

  it("scopes itself to the hosted instance and puts self-hosters on notice", () => {
    const text = pageText();
    expect(text).toContain("dlectroflow.dev");
    expect(text).toMatch(/AGPL-3\.0/);
    expect(text).toMatch(/you.{0,5} are its controller/i);
  });
});

// ── The non-commercial framing, and the exemption that does NOT apply ───────
//
// The controller is an individual running a NON-COMMERCIAL HOBBY PROJECT: no
// company, no trade, no business, nothing charged for. An earlier draft said
// "trading as a sole trader", asserting a commercial undertaking that does not
// exist.
//
// The dangerous half is the follow-on reasoning. UK GDPR Art. 2(2)(c) exempts
// processing by an individual "in the course of a purely personal or household
// activity", so a reader — or a future maintainer — who learns this is a hobby
// may conclude the Regulation does not apply. It does. The page has to close
// that door explicitly, and these tests keep it closed.
describe("Privacy Policy page: non-commercial framing", () => {
  it("describes the controller as a non-commercial hobby project", () => {
    const text = pageText();
    expect(text).toMatch(/personal, non-commercial hobby project/i);
    expect(text).toMatch(/no company, no business and no trade behind it/i);
  });

  it("never claims to trade, and never calls the controller a sole trader", () => {
    // The regression guard. This wording reads professional, which is precisely
    // why a template or a find-and-replace can reintroduce it unchallenged.
    const text = pageText();
    expect(text).not.toMatch(/sole trader/i);
    expect(text).not.toMatch(/trading as/i);
  });

  it("confronts the purely-personal-or-household exemption head-on", () => {
    // Citing the Article matters: a reader who already knows Art. 2(2)(c) exists
    // is the one most likely to assume it applies here. Naming it and rejecting
    // it is stronger than silence, which reads like an oversight — or a claim.
    const text = pageText();
    expect(text).toMatch(/purely personal or household activity/i);
    expect(text).toMatch(/Article 2\(2\)\(c\)/);
    expect(text).toMatch(/does not cover this, and I am not claiming it/i);
  });

  it("gives both independent reasons the exemption is unavailable", () => {
    const text = pageText();
    // 1. Offered over the public internet, processing OTHER people's data.
    expect(text).toMatch(/offered over the public internet to other people/i);
    // 2. Recital 18: the Regulation applies to whoever provides the MEANS, even
    //    where the end user's own purpose is purely personal.
    expect(text).toMatch(/Recital 18/);
    expect(text).toMatch(/provides the means/i);
  });

  it("says being unpaid does not reduce anyone's rights", () => {
    expect(pageText()).toMatch(
      /Being unpaid changes what this project can afford; it does not change what you are entitled to/i,
    );
  });
});

describe("Privacy Policy page: promises nothing unshipped", () => {
  // The failure mode this guards is specific and nasty: a notice describing a
  // feature the software lacks is an unkeepable promise in writing to every
  // reader. The honest wording for each is asserted here so a future edit cannot
  // quietly "improve" it into a claim.
  //
  // #118 Phase C shipped two of the original three (per-member Google
  // connections, and a per-account BYO LLM key), so their "not yet" wording is
  // GONE and the claims are pinned in the Phase C block below instead. #129
  // shipped a third — the self-service export — so the first test here is now the
  // same guard pointed the other way. What remains unshipped is asserted below.
  // The table of not-shipped claims lives in docs/legal.md and moves with this.
  it("names the self-service export, now that there is one (#129)", () => {
    // This test used to assert the OPPOSITE — "no self-service export button" —
    // which was the honest thing to publish until #129 shipped one. The
    // replacement is the same guard pointed the other way: the page must name the
    // control, and must keep naming the two credentials the export withholds, so
    // a reader cannot infer that their Google connection travelled with the file.
    const text = pageText();
    expect(text).toMatch(/Settings\s*→\s*Account\s*→\s*Export your data/i);
    expect(text).toMatch(/OAuth tokens for your Google connection/i);
    expect(text).toMatch(/LLM API key/i);
    // And it must not still be claiming the old state of the world.
    expect(text).not.toMatch(/no self-service export button/i);
  });

  it("says a guest sandbox can export too", () => {
    // The one right a sandbox can exercise in full, because the export needs no
    // identity — only the sandbox's own signed session.
    const text = pageText();
    expect(text).toMatch(/The export is the exception/i);
  });

  it("admits nothing auto-deletes an account, in both directions", () => {
    // This asserted the literal phrase "is not deleted automatically today",
    // which covered only the REVOKED path — and the same bullet simultaneously
    // said a freeze "marks its content to be removed 30 days later", so the
    // page described an automatic purge and its absence in consecutive
    // sentences and this test was satisfied by the half that was true.
    //
    // Pinned as substance now, and two-sided, because the two failures are
    // opposite: understating leaves a reader who wanted erasure believing it
    // happened, and overstating leaves a reader waiting 30 days for a job that
    // does not exist. `freezeAccount` writes `User.purgeAfter` and nothing
    // reads it — `prisma/scheduled-purge.ts` sweeps guest workspaces and guest
    // counters only, and `deleteAccount` has no caller outside its own tests.
    // When #159 ships, this test changes with the page.
    const text = pageText();
    expect(text).toMatch(/not deleted automatically/i);
    expect(text, "the page must say who does the deletion").toMatch(/by hand/i);
    expect(
      text,
      "the page must cover the self-deleted path too, not only revocation",
    ).toMatch(/whether you deleted the account yourself or I revoked it/i);
    // The old overclaim, in either of its shapes. A recovery window is fine to
    // state; a scheduled removal at the end of it is not, because none runs.
    expect(
      text,
      "the page is claiming a scheduled purge that does not exist",
    ).not.toMatch(/marks? its content to be removed/i);
    // Deliberately NOT a blanket ban on "deleted after 30 days": that sentence
    // is true and load-bearing three times elsewhere on this page — the access
    // logs, the guest IP hash and the backups all genuinely age out on a job.
    // Only ACCOUNT CONTENT lacks one, so the assertion is scoped to it.
    expect(
      text,
      "account content is claiming an automatic 30-day removal",
    ).not.toMatch(/content[^.]{0,60}(deleted|removed)[^.]{0,20}30 days/i);
  });

  it("discloses the task note as free text sent to the LLM (#179)", () => {
    // The finding that motivated this whole revision. From #123 the page said
    // the breakdown context "contains no free text"; #179 made that false on
    // 2026-08-08 by selecting `Task.notes` in `breakdown-context.ts`, and
    // `buildNoteBlock` quotes it verbatim into the prompt at up to
    // MAX_NOTE_CONTEXT_CHARS. The claim survived for a week because it is a
    // NEGATIVE one — nothing fails when a "what is sent" list grows a gap.
    //
    // So both halves are pinned: the disclosure must be present, AND the
    // unqualified absence-claim must not come back. Widening that `select`
    // again should red this test, not ship quietly.
    const text = pageText();
    expect(text).toMatch(/your note on the task/i);
    expect(text, "the 600-character clamp is the bound stated").toMatch(
      /600 characters/i,
    );
    expect(
      text,
      "notes on other tasks are NOT selected, and the page should say so",
    ).toMatch(/notes on other tasks/i);
    expect(
      text,
      'the page is claiming "no free text" again while Task.notes is selected',
    ).not.toMatch(/contains no free text|no free text,/i);
  });

  it("does not claim Article 9 explicit consent for health data in a note", () => {
    // #123 shipped "explicit consent — Article 9(2)(a) UK GDPR" with nothing
    // behind it: no field asks for health data, so no permission was ever
    // sought, so there was no consent to be explicit about. Grepping `src/`
    // for a gate, an acknowledgement or a warning returned only the page's own
    // prose.
    //
    // The owner's decision was to state the true position rather than build a
    // consent mechanism. This test is the guard on that decision — if the
    // Art. 9(2)(a) claim is ever reintroduced, it must arrive WITH a mechanism,
    // and reintroducing it should therefore cost a deliberate red build.
    const text = pageText();
    // The whole Article 9 family, not just the (2)(a) literal — any Art. 9
    // condition asserted here would need a mechanism behind it, and none of
    // them has one.
    expect(text).not.toMatch(/article\s*9/i);
    // The old sentence's own shape. A blanket ban on "explicit consent" would
    // be wrong: the replacement prose USES the phrase to refuse it, which is
    // the point, so what is forbidden is the affirmative claim.
    expect(text).not.toMatch(/sharing them knowingly and explicitly/i);
    expect(text).not.toMatch(/explicit consent[^.]{0,40}(permits|allows) me/i);
    // And the honest replacement must actually be there, so the paragraph
    // cannot be deleted into silence instead.
    expect(text).toMatch(/not going to call that consent/i);
    expect(text).toMatch(/no field for it/i);
  });

  it("says the four account records are IN the download, with credentials as the only exclusion", () => {
    // `docs/legal.md`: /privacy and `src/lib/export/readme.ts` are one
    // disclosure read in two places, and "those two wordings move together", so
    // this test and `readme.test.ts`'s equivalent move together too.
    //
    // POLARITY FLIPPED. This test previously asserted that the page NAMED four
    // withheld bookkeeping categories, counted per omitted COLUMN because the
    // paragraph had shipped a partial list twice — once as the original F6
    // defect, and once inside its own correction, when it named `status` and
    // `lastSeenAt` while dropping `revokedAt` and `providerSub`. The owner's
    // decision was to INCLUDE all four rather than keep disclosing the gap, so
    // the accurate page now says they are in the download and the assertions
    // invert. The per-column counting is kept, because a partial list is just as
    // wrong in this direction: a page claiming three of four columns are included
    // reads as if all of them are.
    const text = pageText();

    // The exclusion is credentials, and there are THREE — the calendar feed's
    // token joins the two already named, because exporting the row's timestamps
    // is what made its token an explicit decision rather than an absence.
    expect(text).toMatch(/OAuth tokens/i); // GoogleAuth
    expect(text).toMatch(/API key/i); // User.llmKeyEnc
    // CalendarFeed.token. The row IS exported, so its one withheld column has to
    // be accounted for on the page rather than left as an unexplained absence —
    // and it is the only one of the three stored in plain text.
    expect(text).toMatch(/secret address of your calendar feed/i);
    // Where to get it, since the page tells the reader they lose nothing by its
    // absence. That claim is only true because the live URL is one click away —
    // `calendar-feed.tsx` renders it in a readOnly input with a copy button, so
    // it is re-copyable rather than shown once.
    //
    // The section name is DERIVED from `SETTINGS_SECTIONS`, not repeated as a
    // literal, and that is the whole point of this assertion. The first draft of
    // this MR wrote "Settings → Calendar" into all three surfaces — a section
    // that does not exist — and three literal assertions agreeing with three
    // wrong strings is exactly how a page and a tree drift apart while the suite
    // stays green. Renaming the section now reds the copy.
    const integrations = sectionLabel(
      sectionById("settings-integrations"),
      "plain",
    );
    expect(text).toContain(
      `Settings → ${integrations} → Calendar subscription`,
    );
    // The label is voice-independent (`{ text: "Integrations" }`, not a `{ key }`),
    // which is what makes it safe to hardcode a path in copy that every voice
    // reads. `settings-account` IS keyed, so this check is not redundant.
    expect(sectionLabel(sectionById("settings-integrations"), "playful")).toBe(
      integrations,
    );
    expect(
      text,
      "the page must say the three keys are the WHOLE exclusion, not some of it",
    ).toMatch(/Nothing else is held back/i);

    // Each of the four, positively described as included. Same axis as before.
    expect(text).toMatch(/invitation record/i); // Allowlist
    expect(text).toMatch(/AI usage count/i); // UserAiUsage
    expect(text).toMatch(/calendar feed/i); // CalendarFeed
    expect(text).toMatch(/active or revoked/i); // User.status
    expect(text).toMatch(/last seen/i); // User.lastSeenAt
    expect(text).toMatch(/access was withdrawn/i); // User.revokedAt
    expect(text).toMatch(/account id GitLab issued/i); // User.providerSub

    // The note specifically, because it is the one field that is data ABOUT the
    // reader written by somebody else, and the reason the set was worth including
    // rather than continuing to offer by hand.
    expect(
      text,
      "the page must say the invitation note itself is in the download",
    ).toMatch(/note/i);

    // The stale claims. Each was true when written and is false the moment the
    // code ships, so their absence is asserted rather than left to review.
    expect(
      text,
      "the page still says some things are deliberately left out of the export",
    ).not.toMatch(/Some things are deliberately left out/i);
    expect(
      text,
      "the page still calls the four records account bookkeeping withheld from the export",
    ).not.toMatch(/The rest is account bookkeeping/i);
    expect(
      text,
      "the page still offers to send the records by hand, which is now redundant",
    ).not.toMatch(/I will send any of it by hand/i);
  });

  it("discloses the three stored-content categories added by this sweep (#252, F7/F8)", () => {
    // `User.displayName`, `FocusPlaylist.name` and `BreakdownTurn.message` were
    // all stored and none was disclosed. The last is the instructive one: it was
    // already NAMED in the Portability bullet as "the coaching conversations"
    // while never appearing in "What I collect" — the page describing a thing it
    // had not admitted to holding, which is why a Portability mention is not a
    // substitute for a collection disclosure and this test asserts the latter.
    const text = pageText();
    expect(text).toMatch(/A display name/i);
    expect(text).toMatch(/Focus playlists/i);
    expect(text).toMatch(/Coaching conversations/i);
    // Each needs its substance, not just its heading, or the bullet could be
    // reduced to a label and still pass.
    expect(text).toMatch(/instead of your GitLab username/i);
    expect(text).toMatch(/which tracks you put in it/i);
    expect(text).toMatch(/step lists it proposed back/i);
  });

  it("says a note is copied into Google Tasks when a step is scheduled (#44)", () => {
    // `encodeReclaim` writes `buildScheduleNote`'s output — task note, step
    // note, a prompt line and a focus URL — into the Google Task's `notes`
    // field, and `patchGoogleTask` sends it. The page described only a title
    // and a due date, so a reader could not have known a note leaves the app
    // this way. The subscription FEED is deliberately different and carries
    // titles and times only (`buildFeedIcs`); the assertion below is about the
    // written Google Task, and the feed's own promise is pinned elsewhere.
    const text = pageText();
    expect(text).toMatch(/notes field/i);
    expect(text).toMatch(/copied into your Google Tasks list/i);
  });

  it("admits the feed token reaches the access log, and does not claim otherwise (#154)", () => {
    // The page shipped "no record of which calendar app you pasted it into, and
    // no log of when it was fetched". The first half is true. The second was
    // false on BOTH deploy targets: the token is in the request PATH, and
    // `docker/Caddyfile` enables an access log while
    // `charts/dlectroflow/templates/ingress.yaml` sets no `log-format`
    // override, so ingress-nginx's default — which contains `$request` —
    // applies. A privacy notice claiming an absence that the infrastructure
    // contradicts is the worst shape this page can take, so both directions are
    // pinned: the retraction must be present AND the old claim must be gone.
    const text = pageText();
    expect(text).not.toMatch(/no log of when it was fetched/i);
    expect(text).toMatch(/the app itself writes nothing when your calendar/i);
    expect(text).toMatch(/the token is part of the web address/i);
    expect(text).toMatch(/there is a record of when the feed was fetched/i);
    // And the bounded window, which is what makes the disclosure actionable
    // rather than just alarming. Stated wherever the logs are described.
    expect(text).toMatch(/deleted after 30 days/i);
    expect(text).toMatch(/the web address of each request/i);
  });

  it("does not claim a member can choose their own AI provider (#125)", () => {
    // The replacement guard, and the one most at risk of a well-meaning
    // "improvement": BYO KEY shipped, BYO PROVIDER did not. `LLMCredentials` has
    // no base URL by design (a per-user endpoint is an SSRF primitive), nothing
    // in the app writes `User.llmProvider`, and `getLLM` falls back to the
    // deployment's `LLM_PROVIDER`. So the page must keep saying the vendor is not
    // the member's to pick.
    const text = pageText();
    expect(text).toMatch(/it is a key, not a destination/i);
    expect(text).toMatch(
      /Choosing your own provider is not something dlectroflow can do today/i,
    );
    // And it must not have drifted into the opposite claim. Matched on the
    // affirmative CONSTRUCTIONS rather than on the bare words, so the sentence
    // that denies the capability does not trip its own guard.
    expect(text).not.toMatch(
      /you (?:can|may|could) (?:choose|pick|select|set) (?:your own|a different|another)\s+(?:AI\s+)?(?:provider|vendor|endpoint|model host)/i,
    );
  });
});

// ── #118 Phase C: what the per-user integrations text must keep saying ───────
//
// Phase C changed the central factual claim of two sections. Before it, a
// member's scheduled tasks went into the ADMINISTRATOR's Google account and
// `User.llmKeyEnc` was read but never written. Both are now per-user, and the
// text says so — these tests pin the parts that are easy to lose or overstate.
describe("Privacy Policy page: per-user integrations (#118 Phase C)", () => {
  it("says a member's Google tasks go into their OWN Google account", () => {
    // The material improvement, and the one the old text got backwards. Asserted
    // on the affirmative claim rather than the absence of the old one, so a
    // rewrite that drops the point entirely also fails.
    const text = pageText();
    expect(text).toMatch(/you can connect your own Google account/i);
    expect(text).toMatch(/one connection per person/i);
    // And the negative half: NOT the administrator's.
    expect(text).toMatch(/Not the administrator.{0,3}s, and not a shared one/i);
  });

  it("states that a member's Google connection is unreachable by the owner", () => {
    // `getAuth` is a findUnique keyed on `userId` with no id parameter anywhere in
    // google.ts's public surface, and `src/lib/people.ts` never selects a
    // credential — the owner's People panel cannot even tell whether a member has
    // connected. This is the claim a member is most entitled to have pinned.
    const text = pageText();
    expect(text).toMatch(/not visible or usable to anyone else/i);
    expect(text).toMatch(/including me, as the person who administers/i);
    expect(text).toMatch(/does not even disclose whether you have one/i);
    // And that it is structural rather than a promise — the scoping harness was
    // extended to userId-keyed models precisely so this is enforced in CI.
    expect(text).toMatch(/fails the build/i);
  });

  it("says guests cannot connect Google", () => {
    // `/api/google/oauth/` moved to AUTHENTICATED_PREFIXES, not to public: any
    // signed-in member, never a guest.
    expect(pageText()).toMatch(/Guests cannot connect Google/i);
  });

  it("says losing access here withdraws the Google grant too (#126)", () => {
    // Until #126 this section said the opposite, accurately: `disconnectGoogle`
    // was the only revoke path, `revokePerson` froze an account without touching
    // its tokens, and a deleted User cascaded the credential away in silence.
    // Both lifecycle paths now revoke first (`src/app/actions/people.ts`,
    // `src/lib/account-lifecycle.ts`), so the honest text is the other way round
    // — and a page that still described the gap would understate what the app
    // does to somebody's Google account.
    const text = pageText();
    expect(text).toMatch(/if your access here is withdrawn/i);
    expect(text).toMatch(/asks Google to revoke the grant first/i);
    // The reason the grant goes with the access, in the reader's terms.
    expect(text).toMatch(
      /grant only ever existed so this app could write your tasks/i,
    );
    // And the limit that survives the fix: a revoke CALL can fail, and the
    // tokens are deleted either way, so the grant can outlive the app's ability
    // to withdraw it. That is what the Google-side fallback is for.
    expect(text).toMatch(/that call can fail/i);
    expect(text).toMatch(/Google account.{0,3}s security settings/i);
    // It must not drift back to the pre-#126 disclosure, which is now wrong in
    // the alarming direction.
    expect(text).not.toMatch(
      /only thing in the app that asks Google to revoke the grant/i,
    );
  });

  it("discloses the stored own API key as data it collects", () => {
    // A new column holding a user-supplied secret is a new category of personal
    // data. An incomplete "what I collect" list is the failure mode docs/legal.md
    // warns about for exactly this case.
    expect(pageText()).toMatch(/Your own AI provider API key/i);
  });

  it("describes BYO key as lifting the cap and paying its own way", () => {
    const text = pageText();
    expect(text).toMatch(/Your breakdowns are paid for by you/i);
    expect(text).toMatch(/fair-use cap on AI requests stops applying/i);
    // Encrypted with the same cipher as the Google tokens, and never readable back.
    expect(text).toMatch(/never displayed back to you/i);
  });

  it("says an own-key request falls under the member's own provider agreement", () => {
    // The consequence that actually matters to a data subject: my Article 46
    // safeguards and processor terms are for requests on MY key. A request
    // authenticated as them is not covered by them.
    const text = pageText();
    expect(text).toMatch(/your own agreement with the provider governs it/i);
    expect(text).toMatch(/they cannot cover requests made on yours/i);
  });

  it("still names Anthropic as the recipient for every request", () => {
    // Load-bearing for the international-transfer section: because the member
    // supplies only a key, the DESTINATION is unchanged, so the transfer
    // disclosure still holds for everyone. If BYO provider ever ships (#125),
    // this is the assertion that should force that section to be revisited.
    const text = pageText();
    expect(text).toMatch(/this instance uses Anthropic for every request/i);
    expect(text).toMatch(/whether or not they brought their own key/i);
  });

  it("keeps the owner's view of a stored key to a boolean", () => {
    // `src/lib/people.ts` answers "has a key?" with a query that selects ids
    // only, so the ciphertext never enters the object graph.
    expect(pageText()).toMatch(/whether.{0,40}saved a key/i);
  });
});
