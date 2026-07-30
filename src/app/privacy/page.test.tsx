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

  it("renders the shared legal footer", () => {
    render(<PrivacyPage />);
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute(
      "href",
      "/terms",
    );
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
  // GONE and the claims are pinned in the Phase C block below instead. What
  // remains unshipped is asserted here.
  it("says access and erasure are handled by hand, not self-service", () => {
    // `src/app/api/account/` still does not exist. (The `/api/account/` entry in
    // AUTHENTICATED_PREFIXES reserves the prefix; it does not implement a route.)
    const text = pageText();
    expect(text).toMatch(/no self-service export button/i);
    expect(text).toMatch(/by me, by hand/i);
  });

  it("admits revocation does not auto-delete content", () => {
    expect(pageText()).toMatch(/is\s+not\s+deleted automatically today/i);
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
