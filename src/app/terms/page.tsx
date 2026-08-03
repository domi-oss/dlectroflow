import type { Metadata } from "next";
import Link from "next/link";
import {
  ADMIN_CONTACT_EMAIL,
  CONTROLLER_NAME,
  LEGAL_CONTACT_EMAIL,
  SOURCE_REPO_URL,
} from "@/lib/legal";
import {
  LegalPage,
  LegalSection,
  LegalSubheading,
  sectionPicker,
} from "@/components/legal/legal-page";

/**
 * The public Terms of Service for the hosted instance (#123).
 *
 * A top-level route, deliberately OUTSIDE the `(app)` route group: no session,
 * no app chrome, no database, statically prerendered.
 *
 * Tone note, because it is a real requirement and not decoration: the audience
 * is people with ADHD, and the section on AI suggestions is the one most likely
 * to be read by someone having a bad day. It is written supportively — "you are
 * allowed to ignore it" — rather than as a wall of disclaimers, while still
 * doing the legal job of saying the app is not professional advice. A liability
 * section that reads as contempt for the reader is worse lawyering, not better.
 *
 * The exclusions below are deliberately bounded: UK law does not permit
 * excluding liability for death or personal injury caused by negligence, or for
 * fraud, so those are carved out explicitly rather than swept up in a blanket
 * "we are liable for nothing", which would risk the whole clause being struck
 * down as unfair.
 */
export const metadata: Metadata = {
  title: "Terms of Service · dlectroflow",
  description:
    "The terms for using dlectroflow.dev: a free, non-commercial hobby project provided as is, with no warranty or uptime guarantee. What you can expect, what is expected of you, and the limits of liability under the law of England and Wales.",
};

const SECTIONS = [
  { id: "what", title: "What dlectroflow is" },
  { id: "agreement", title: "This agreement, and who it is with" },
  { id: "free", title: "It is free, and it is provided as is" },
  { id: "who", title: "Who can use it" },
  { id: "your-content", title: "Your content stays yours" },
  { id: "ai", title: "About the AI suggestions" },
  { id: "fair-use", title: "Using it fairly" },
  { id: "google", title: "Your Google account is yours to look after" },
  { id: "availability", title: "Availability, changes, and shutting down" },
  { id: "ending", title: "Suspending or ending access" },
  { id: "liability", title: "Limits on my liability" },
  { id: "licence", title: "The code, the licence, and this instance" },
  { id: "data", title: "Your data" },
  { id: "law", title: "Governing law, and where disputes go" },
  { id: "changes", title: "Changes to these Terms" },
  { id: "odds", title: "Odds and ends" },
  { id: "contact", title: "Getting in touch" },
] as const;

const s = sectionPicker(SECTIONS);

function Mail({ address }: { address: string }) {
  return (
    <a
      href={`mailto:${address}`}
      className="focus-visible:ring-ring hover:text-primary focus-visible:text-primary rounded underline outline-none focus-visible:ring-2"
    >
      {address}
    </a>
  );
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="focus-visible:ring-ring hover:text-primary focus-visible:text-primary rounded underline outline-none focus-visible:ring-2"
    >
      {children}
    </a>
  );
}

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      sections={SECTIONS}
      summary={
        <>
          <p>
            <strong>The short version.</strong> dlectroflow is a non-commercial
            hobby project, given away for nothing. It comes with no warranty, no
            uptime promise and no support desk, so please do not make it the
            only place something important lives. What you write stays yours.
            The AI suggests steps — it is not advice, and you are always allowed
            to ignore it. Use it decently, do not attack it, and we will get
            along fine.
          </p>
          <p className="text-muted-foreground">
            That summary is here so this page gets read. The sections below are
            the actual terms, and they are what govern.
          </p>
        </>
      }
    >
      <LegalSection {...s("what")}>
        <p>
          dlectroflow is a web app for people whose brains do not do &ldquo;just
          start it&rdquo;. You capture whatever is rattling around, an AI helps
          break the daunting things into small concrete steps, you focus on one
          step at a time with a timer, and you get some credit for finishing. It
          can optionally push those steps into Google Tasks so a scheduling tool
          can book time for them.
        </p>
        <p>
          These Terms cover the hosted instance at{" "}
          <Ext href="https://dlectroflow.dev">dlectroflow.dev</Ext>. If you run
          your own copy of the software, these Terms do not govern it — see{" "}
          <Link href={`#${s("licence").id}`} className="underline">
            The code, the licence, and this instance
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection {...s("agreement")}>
        <p>
          The agreement is between you and <strong>{CONTROLLER_NAME}</strong>,
          an individual in the United Kingdom running dlectroflow as a{" "}
          <strong>personal, non-commercial hobby project</strong> — not a
          company, not a business, and not a trade. In these Terms,
          &ldquo;I&rdquo; and &ldquo;me&rdquo; mean that person, and
          &ldquo;you&rdquo; means you.
        </p>
        <p>
          Because nothing is charged for,{" "}
          <strong>this is not a sale and you are not a customer</strong>. It is
          closer to being handed something someone made in their spare time —
          which is also why the sections on warranty and liability below read
          the way they do. It is not a disclaimer strategy; it is what an unpaid
          side project can honestly promise.
        </p>
        <p>
          None of that reduces what I owe you about your data. See{" "}
          <Link href="/privacy" className="underline">
            the Privacy Policy
          </Link>
          , which explains why being a hobby project does not exempt me from UK
          data protection law.
        </p>
        <p>
          By using dlectroflow you accept these Terms. That applies whether you
          have an account or are using it as a guest — there is no separate
          tick-box, and using it is the acceptance. If you do not accept them,
          please do not use it.
        </p>
      </LegalSection>

      <LegalSection {...s("free")}>
        <p>
          dlectroflow is given away. There is no charge, no paid tier, no trial
          that turns into a subscription, and nothing to cancel — it is a hobby
          project, not a product.
        </p>
        <p>
          What follows from that, stated plainly rather than hidden in a
          capitalised paragraph at the bottom:
        </p>
        <ul className="ml-5 list-disc space-y-1">
          <li>
            It is provided{" "}
            <strong>&ldquo;as is&rdquo; and &ldquo;as available&rdquo;</strong>,
            with no warranties of any kind beyond those UK law does not allow me
            to exclude.
          </li>
          <li>
            There is{" "}
            <strong>no uptime guarantee and no service level commitment</strong>
            . None. It is one small deployment looked after by one person, and
            there is no commercial arrangement here for a service level to hang
            off.
          </li>
          <li>
            There is no committed support. I will usually answer an email, but
            &ldquo;usually&rdquo; is the honest word.
          </li>
          <li>
            I do not promise it is free of errors, that it will meet your
            particular needs, or that any AI suggestion it produces is correct.
          </li>
        </ul>
        {/* #164 — this sentence used to end "not as a promise to you", which
            half-stated the point and left the reader to guess at the other
            half. The full clause now lives in ONE place, under Your data, and
            this is the pointer to it: two statements of the same fact in one
            document is how a document ends up contradicting itself. */}
        <p>
          <strong>
            So please keep your own copy of anything that matters.
          </strong>{" "}
          There are nightly backups, but they are for disaster recovery and not
          a personal undo — see{" "}
          <Link href={`#${s("data").id}`} className="underline">
            Your data
          </Link>{" "}
          for what they can and cannot do.
        </p>
      </LegalSection>

      <LegalSection {...s("who")}>
        <ul className="ml-5 list-disc space-y-1">
          <li>
            <strong>As a guest</strong>, anyone can use it with no account.
            Guest workspaces are sandboxes: they expire after about a day and
            are then deleted, by design. Do not keep anything you care about in
            one.
          </li>
          <li>
            <strong>Accounts are invite-only.</strong> There is no sign-up form.
            Sign-in is through GitLab, and only identities on the allowlist can
            get in. I am under no obligation to grant anyone an account.
          </li>
          <li>
            <strong>You must be at least 13.</strong> dlectroflow is not
            intended for children under 13.
          </li>
          <li>
            Do not share your account, and do not use anyone else&rsquo;s.
          </li>
        </ul>
      </LegalSection>

      <LegalSection {...s("your-content")}>
        <p>
          Everything you write into dlectroflow — your captures, tasks, steps
          and notes — <strong>remains yours</strong>. I claim no ownership of
          any of it.
        </p>
        <p>
          You give me only the permission needed to actually run the service for
          you: to store your content, show it back to you, include it in
          backups, and send the parts described in the{" "}
          <Link href="/privacy" className="underline">
            Privacy Policy
          </Link>{" "}
          to the AI provider when you ask for a breakdown. That is the whole
          licence. It does not extend to publishing your content, showing it to
          anyone else, or training any model on it.
        </p>
        <p>
          That permission ends when you delete the content, or when your data is
          deleted at your request.
        </p>
        <p>
          You are responsible for having the right to put content into the app
          in the first place, and for what you choose to put in it.
        </p>
      </LegalSection>

      <LegalSection {...s("ai")}>
        <p>
          This section matters more than most, so it is written properly rather
          than as boilerplate.
        </p>

        <LegalSubheading>A suggestion, not an instruction</LegalSubheading>
        <p>
          When the app breaks a task into steps, that list is a{" "}
          <em>first draft</em>. It has never met you. It does not know that
          Tuesdays are bad, that step three is the one you have been circling
          for a month, or that the whole task is really about one phone call you
          are dreading.
        </p>
        <p>
          Argue with it. Reorder it. Delete half of it. Throw the whole thing
          away and write your own. That is not misuse of the feature — that is
          the feature. <strong>You are allowed to ignore it.</strong>
        </p>

        <LegalSubheading>It is not professional advice</LegalSubheading>
        <p>
          Nothing dlectroflow produces is medical, clinical, therapeutic,
          diagnostic, psychological, legal, financial or safety advice, and none
          of it is a substitute for talking to someone qualified. It is a to-do
          app with a kind tone. It does not assess you, diagnose you, or treat
          anything.
        </p>
        <p>
          If something in your life needs a professional — a doctor, a
          therapist, an ADHD assessment, a solicitor, an accountant — please
          talk to one. Please do not let a tidy-looking list of steps be the
          reason you decide you have it handled.
        </p>

        <LegalSubheading>Where being wrong would cost you</LegalSubheading>
        <p>
          Do not rely on an AI suggestion for anything with real consequences:
          medication or dosing, legal or tax deadlines, medical appointments,
          money, or anything with a safety implication. Check those against the
          real source. The app will cheerfully suggest something wrong, and it
          has no way of knowing that it has.
        </p>

        <LegalSubheading>If you bring your own API key</LegalSubheading>
        <p>
          If you have an account, you can save your own API key for the AI
          provider in Settings. It is optional, and the app works without one.
          Two things follow, and both are yours rather than mine:
        </p>
        <ul className="ml-5 list-disc space-y-1">
          <li>
            <strong>Your key, your bill.</strong> Requests you make are charged
            to your account with the provider, and keeping the key valid and
            funded is up to you. If it stops working, breakdowns stop working —
            that is between you and them, and I cannot fix it from here. Remove
            the key in Settings and your account goes back to the shared
            allowance.
          </li>
          <li>
            <strong>Your agreement with the provider applies to it.</strong>{" "}
            Requests made on your key sit under whatever terms you accepted with
            them, not under mine, and you are responsible for complying with
            those.
          </li>
        </ul>
        <p>
          <strong>
            What a key does not do is let you choose the provider.
          </strong>{" "}
          The key is used against the provider{" "}
          <em>this instance is configured to use</em>, and there is no setting
          for a different vendor, model endpoint or address — deliberately,
          since letting an account decide where the server sends requests would
          be a security hole rather than a feature. If you want a different
          provider, the software is open source and you can run your own
          instance configured however you like.
        </p>

        <LegalSubheading>And a note on the hard days</LegalSubheading>
        <p>
          The app is enthusiastic about streaks because that helps some people
          start. A broken streak is not a verdict on you, and a day where
          nothing got done is not a failure of anything the app can measure. It
          counts steps. It does not count worth.
        </p>
      </LegalSection>

      <LegalSection {...s("fair-use")}>
        <p>Please do not:</p>
        <ul className="ml-5 list-disc space-y-1">
          <li>
            break the law with it, or use it to store or share unlawful content;
          </li>
          <li>
            try to reach another workspace&rsquo;s data, get around the invite
            allowlist, or use someone else&rsquo;s account;
          </li>
          <li>
            attack or overload it — no denial of service, no attempts to break
            into the hosting, no automated hammering, and no routing around the
            rate limits and fair-use caps;
          </li>
          <li>
            resell, proxy or automate the AI feature for your own purposes.
            Unless you have saved your own API key, it runs on my API
            credentials and my money, and abuse of it is what would force a cap
            on everyone else. Bringing your own key lifts the allowance, not
            this rule — dlectroflow is not a gateway to resell;
          </li>
          <li>upload malware, or scrape the site;</li>
          <li>
            use it as a store for other people&rsquo;s personal data at any
            scale. It is a personal task app, not a customer database, and I am
            not in a position to act as anyone&rsquo;s data processor.
          </li>
        </ul>
        <p>
          <strong>Security research is welcome.</strong> If you are looking for
          vulnerabilities in good faith and want to report one, the repository
          has a security policy explaining how. Please test against your own
          workspace, never anyone else&rsquo;s data.
        </p>
      </LegalSection>

      <LegalSection {...s("google")}>
        <p>
          Connecting Google Tasks is optional, and the connection is{" "}
          <strong>yours</strong>: if you have an account you connect your own
          Google account, and dlectroflow writes tasks into{" "}
          <strong>your</strong> Google Tasks rather than mine or anybody
          else&rsquo;s. That account, and everything in it, remains{" "}
          <strong>your responsibility</strong> and is governed by your agreement
          with Google, not by these Terms.
        </p>
        <p>
          Practically: check what it writes. The app creates and updates task
          titles and due dates in one list, and while it is careful to update
          rather than duplicate, you should satisfy yourself that it is behaving
          before you let a scheduler act on it. You can disconnect at any time
          in Settings, or revoke access from your Google account directly — and
          revoking at Google&rsquo;s end always works, whatever state your
          account here is in.
        </p>
        <p>
          I am not responsible for what any third-party scheduler does with
          those tasks once they are in your Google account, nor for changes
          Google makes to its own service.
        </p>
      </LegalSection>

      <LegalSection {...s("availability")}>
        <p>
          It will sometimes be down. Sometimes that is a deployment; sometimes
          something broke at two in the morning and I was asleep. There is no
          promised availability, and no compensation for downtime.
        </p>
        <p>
          I may add, change or remove features, including ones you like. I may
          change the AI provider or model. Where a change materially affects how
          your data is handled, the{" "}
          <Link href="/privacy" className="underline">
            Privacy Policy
          </Link>{" "}
          is updated and its effective date moves.
        </p>
        <p>
          <strong>I may also shut the hosted instance down.</strong> If I decide
          to, I will give as much notice as I reasonably can, in the app and in
          the repository. Because the software is open source, you would not be
          left with nothing: you can run your own instance.
        </p>
      </LegalSection>

      <LegalSection {...s("ending")}>
        <p>
          <strong>You can stop whenever you like.</strong> Sign out, or ask me
          to delete your account and data.
        </p>
        <p>
          I may suspend or end your access if you break these Terms, if your use
          threatens the service or other people using it, if I am legally
          required to, or if running the instance stops being sustainable. Where
          it is reasonable to do so I will tell you first and give you a chance
          to put it right; where the circumstances do not allow that, I may act
          immediately.
        </p>
        <p>
          <strong>Being honest about what termination does not do:</strong>{" "}
          ending your access does not automatically delete your content today.
          Email <Mail address={LEGAL_CONTACT_EMAIL} /> and it will be deleted —
          see the retention section of the Privacy Policy.
        </p>
      </LegalSection>

      <LegalSection {...s("liability")}>
        <p>
          <strong>First, what I do not and cannot limit.</strong> Nothing in
          these Terms excludes or limits my liability for:
        </p>
        <ul className="ml-5 list-disc space-y-1">
          <li>death or personal injury caused by my negligence;</li>
          <li>fraud or fraudulent misrepresentation;</li>
          <li>
            anything else that cannot lawfully be excluded or limited under the
            law of England and Wales.
          </li>
        </ul>
        <p>
          Your rights under UK data protection law are also untouched by
          anything here.
        </p>
        <p>
          <strong>Subject to that</strong>, and because this is software given
          away as is rather than sold to you, to the fullest extent the law
          allows I am not liable for:
        </p>
        <ul className="ml-5 list-disc space-y-1">
          <li>
            indirect or consequential loss, or loss of profit, revenue,
            business, contracts or goodwill;
          </li>
          <li>
            loss of or damage to data, or the cost of reconstructing it — which
            is why the honest advice above is to keep your own copy of anything
            that matters;
          </li>
          <li>
            anything you missed, forgot, or got wrong while relying on the app
            or on an AI suggestion — a deadline, an appointment, a commitment;
          </li>
          <li>downtime, interruption, or the service being discontinued;</li>
          <li>
            the acts or failures of third-party services the app depends on or
            connects to.
          </li>
        </ul>
        <p>
          Where liability cannot be excluded but can lawfully be limited, my
          total liability to you for all claims combined is limited to{" "}
          <strong>£100</strong>. A nominal cap rather than a pretence of none:
          this is software written by one person in their spare time and given
          away, and open-ended exposure would simply end the project. A clause
          claiming total immunity would be worth nothing to either of us, so I
          would rather write one that means what it says.
        </p>
        <p>
          <strong>And one argument I am deliberately not making.</strong>{" "}
          Several of the rules that forbid excluding liability for death,
          personal injury or fraud are written to catch businesses and traders,
          and whether an unpaid hobby project counts as either is genuinely
          arguable. I am not going to run that argument. The carve-outs at the
          top of this section are stated flatly, they are not conditional on my
          status, and they stand whether or not those rules reach me.
        </p>
      </LegalSection>

      <LegalSection {...s("licence")}>
        <p>
          The dlectroflow source code is published under the{" "}
          <Ext href={`${SOURCE_REPO_URL}/-/blob/main/LICENSE`}>
            GNU Affero General Public License v3.0
          </Ext>{" "}
          (AGPL-3.0). You may read, run, modify and share it on those terms; the
          licence text in the repository is what governs, not this summary.
        </p>
        <p>
          <strong>The licence covers the software, not this service.</strong>{" "}
          Having a licence to the code gives you no rights over this instance,
          its infrastructure, its API credentials, or anybody&rsquo;s data on
          it, and it does not entitle you to an account here.
        </p>
        <p>
          If you run a modified version and let other people use it over a
          network, AGPL-3.0 section 13 requires you to offer them the source of{" "}
          <em>your</em> version. The <strong>Source</strong> link in the footer
          of every page is how this instance meets that obligation for itself.
        </p>
        <p>
          The name &ldquo;dlectroflow&rdquo; and the brand mark are not licensed
          for uses that suggest I endorse or maintain your version. Rename your
          fork and there is no issue.
        </p>
      </LegalSection>

      <LegalSection {...s("data")}>
        <p>
          How your data is handled is set out in the{" "}
          <Link href="/privacy" className="underline">
            Privacy Policy
          </Link>
          , which forms part of these Terms. It covers what is stored, the
          lawful basis for each purpose, what is sent to the AI provider, how
          long things are kept, and how to exercise your rights.
        </p>
        <p>
          For anything about your data, write to{" "}
          <Mail address={LEGAL_CONTACT_EMAIL} /> rather than the general address
          — that inbox is the statutory route and it is monitored as one.
        </p>

        {/* #164 — the honest scope of the backups, and deliberately NOT in the
            liability section. This describes how the service works; filing it as
            an exclusion would frame an operational fact as a limitation, and the
            docblock at the top of this file records why this page keeps its
            exclusions narrow. The first paragraph is load-bearing for that: the
            claim being made is "no individual restore", never "no
            responsibility for your data". */}
        <LegalSubheading>What the backups can and cannot do</LegalSubheading>
        <p>
          There are nightly backups, and they do one job: if this instance were
          lost — a failed disk, a bad deployment, a mistake of mine — they are
          how it comes back, with everybody&rsquo;s work in it. That job is a
          real obligation and nothing here disclaims it.
        </p>
        <p>
          <strong>What they are not is a personal undo.</strong> There is no
          per-person restore. A backup is a snapshot of the whole database and
          it is restored whole, so lifting one person&rsquo;s tasks out of one
          and putting them back into a running instance is not something I can
          offer you. Nor is there anything that brings back what you deleted:
          delete a capture, a task or a step and it is gone from the app there
          and then.
        </p>
        {/* #129 — when a member can export their own data, the addition goes at
            the end of the paragraph below and is one sentence: "You can
            download a copy of everything from Settings." It is not written yet
            because it is not true yet: there is no `src/app/api/account/`
            route, and a dead link in a published legal document is worse than
            no link at all. */}
        <p>
          So the one piece of advice on this page I would most like you to take:{" "}
          <strong>keep your own copy of anything that matters.</strong>
        </p>
      </LegalSection>

      <LegalSection {...s("law")}>
        <p>
          These Terms, and any dispute arising out of them or out of your use of
          dlectroflow, are governed by the{" "}
          <strong>law of England and Wales</strong>.
        </p>
        <p>
          The courts of England and Wales have jurisdiction. If you live in
          Scotland or Northern Ireland you may also bring proceedings in the
          courts of the part of the UK where you live, and nothing in these
          Terms takes away any mandatory legal protection you have there.
        </p>
        <p className="text-muted-foreground">
          Deliberately written without leaning on whether you count as a
          &ldquo;consumer&rdquo; and I count as a &ldquo;trader&rdquo;. Nothing
          is charged for here, so those labels sit awkwardly — and your right to
          sue where you live should not depend on how that argument comes out.
        </p>
      </LegalSection>

      <LegalSection {...s("changes")}>
        <p>
          The <strong>effective date</strong> at the top of this page is its
          version. If these Terms change substantively, that date changes with
          them.
        </p>
        <p>
          The full, timestamped history of every word here is public in the{" "}
          <Ext href={SOURCE_REPO_URL}>source repository</Ext>, so you can see
          exactly what changed and when. There is no in-app notification system
          yet, so the effective date and that history are the reliable ways to
          check.
        </p>
        <p>
          Continuing to use dlectroflow after a change means you accept the
          revised Terms. If you do not, you can stop using it — and ask me to
          delete your data.
        </p>
      </LegalSection>

      <LegalSection {...s("odds")}>
        <ul className="ml-5 list-disc space-y-1">
          <li>
            <strong>Severability.</strong> If any part of these Terms turns out
            to be unenforceable, the rest still applies.
          </li>
          <li>
            <strong>No waiver.</strong> If I do not enforce something
            straightaway, I have not given up the right to enforce it later.
          </li>
          <li>
            <strong>No third-party rights.</strong> Only you and I can enforce
            these Terms; nobody else acquires rights under them by virtue of the
            Contracts (Rights of Third Parties) Act 1999.
          </li>
          <li>
            <strong>Transfer.</strong> You may not transfer your rights under
            these Terms. I may transfer mine if the instance ever changes hands
            — and if that happened I would tell you, and it would not reduce
            your rights.
          </li>
          <li>
            <strong>The whole agreement.</strong> These Terms and the Privacy
            Policy are the entire agreement between us about dlectroflow.
          </li>
        </ul>
      </LegalSection>

      <LegalSection {...s("contact")}>
        <p>Two addresses, deliberately kept apart:</p>
        <ul className="ml-5 list-disc space-y-1">
          <li>
            <Mail address={ADMIN_CONTACT_EMAIL} /> — anything about the service:
            your account, access, a bug, or reporting abuse.
          </li>
          <li>
            <Mail address={LEGAL_CONTACT_EMAIL} /> — anything about your data or
            your rights under data protection law.
          </li>
        </ul>
        <p className="text-muted-foreground">
          They are separate because a data request comes with a statutory
          one-month deadline, and mixing it into general support mail is how
          such a deadline gets missed.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
