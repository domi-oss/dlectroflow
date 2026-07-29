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
import TermsPage, { metadata } from "./page";

afterEach(cleanup);

function pageText(): string {
  const { container } = render(<TermsPage />);
  return container.textContent!.replace(/\s+/g, " ");
}

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
    expect(text).toMatch(/no service level agreement and no uptime guarantee/i);
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
  });

  it("puts the user's Google account content on the user", () => {
    const text = pageText();
    expect(text).toMatch(/your responsibility/i);
    expect(text).toMatch(/disconnect at any time/i);
  });

  it("covers suspension and termination of access", () => {
    const text = pageText();
    expect(text).toMatch(/suspend or end your access/i);
    expect(text).toMatch(/You can stop whenever you like/i);
    // And is honest that termination is not deletion today.
    expect(text).toMatch(/does not automatically delete your content/i);
  });

  it("limits liability WITHOUT purporting to exclude what cannot be excluded", () => {
    // The clause that would be struck out if written greedily. The carve-outs are
    // the part that makes the rest of it stand up.
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

  it("states the AGPL position for the code versus the hosted service", () => {
    const text = pageText();
    expect(text).toMatch(/GNU Affero General Public License v3\.0/);
    expect(text).toMatch(/covers the software, not this service/i);
    expect(text).toMatch(/section 13/i);
  });

  it("sets governing law to England and Wales, with the consumer carve-out", () => {
    const text = pageText();
    expect(text).toMatch(/law of England and Wales/);
    expect(text).toMatch(/courts of England and Wales/i);
    // A consumer in Scotland or NI cannot be forced into English courts.
    expect(text).toMatch(/Scotland or Northern Ireland/);
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
