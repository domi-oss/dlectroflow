import type { Metadata } from "next";
import Link from "next/link";
import {
  BACKUP_RETENTION_DAYS,
  CONTROLLER_NAME,
  HOSTING_REGION,
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
 * The public Privacy Policy for the hosted instance (#123).
 *
 * A top-level route, deliberately OUTSIDE the `(app)` route group: no session,
 * no app chrome, no database. It is statically prerendered, so it answers even
 * if Postgres is down — which matters, because the one time a privacy notice is
 * most urgently wanted is when something has gone wrong.
 *
 * Two rules govern edits here:
 *
 *  1. Every factual claim below was checked against the running system AND the
 *     source. If infrastructure changes — region, backup retention, LLM
 *     provider, OAuth scopes, cookies, processors — this text is wrong until it
 *     is updated, and the effective date in src/lib/legal.ts moves with it. The
 *     re-check list lives in docs/legal.md.
 *  2. It describes ONLY what is shipped. Several things were tempting to
 *     promise — a self-service export, an automatic purge after revocation,
 *     per-member Google connections — and are absent because they do not exist.
 *     A notice describing behaviour the software lacks is a worse problem than a
 *     plain one: it is an unkeepable promise made in writing to every reader.
 */
export const metadata: Metadata = {
  title: "Privacy Policy · dlectroflow",
  description:
    "How dlectroflow.dev handles your data: what is stored, the lawful basis for each purpose, who it is shared with, how long it is kept, and your rights under UK GDPR.",
};

const SECTIONS = [
  { id: "controller", title: "Who is responsible for your data" },
  { id: "scope", title: "What this policy covers" },
  { id: "collected", title: "What I collect, and why" },
  { id: "bases", title: "My lawful basis for each purpose" },
  { id: "ai", title: "Sending your text to an AI provider" },
  { id: "google", title: "Connecting Google Tasks" },
  { id: "recipients", title: "Who else is involved" },
  { id: "transfers", title: "Data that leaves the UK" },
  { id: "where", title: "Where your data is stored" },
  { id: "retention", title: "How long I keep it" },
  { id: "security", title: "How it is protected" },
  { id: "cookies", title: "Cookies" },
  { id: "sensitive", title: "Sensitive information, and a word about ADHD" },
  { id: "decisions", title: "No automated decisions about you" },
  { id: "rights", title: "Your rights, and how to use them" },
  { id: "complaints", title: "Complaining to the ICO" },
  { id: "children", title: "Children" },
  { id: "changes", title: "Changes to this policy" },
] as const;

const s = sectionPicker(SECTIONS);

/** The contact address, as a mailto link. Used in several sections. */
function ContactLink() {
  return (
    <a
      href={`mailto:${LEGAL_CONTACT_EMAIL}`}
      className="focus-visible:ring-ring hover:text-primary focus-visible:text-primary rounded underline outline-none focus-visible:ring-2"
    >
      {LEGAL_CONTACT_EMAIL}
    </a>
  );
}

/** An external reference. */
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

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      sections={SECTIONS}
      summary={
        <>
          <p>
            <strong>The short version.</strong> dlectroflow stores what you type
            into it and nothing you did not type. There is no analytics, no
            tracking and no advertising anywhere in it. Your data lives on
            servers in the UK. The one significant thing that leaves: the text
            of a task you ask to be broken down is sent to Anthropic in the
            United States, because that is what produces the breakdown.
            Connecting Google Tasks is optional and off unless you choose it.
            Nothing is sold, because this is a hobby project with nothing to
            sell — but every obligation below is still a real one.
          </p>
          <p className="text-muted-foreground">
            That summary is here so this page gets read. The sections below are
            the actual notice, and they are what govern.
          </p>
        </>
      }
    >
      <LegalSection {...s("controller")}>
        <p>
          {CONTROLLER_NAME} is the <strong>data controller</strong> for the
          hosted dlectroflow instance at{" "}
          <Ext href="https://dlectroflow.dev">dlectroflow.dev</Ext> — an
          individual in the United Kingdom, running it as a{" "}
          <strong>personal, non-commercial hobby project</strong>. There is no
          company, no business and no trade behind it: nothing is charged for,
          nothing is sold, and there is nothing to buy.
        </p>
        <p>
          Being the controller means I am the person legally answerable for how
          your data is handled here, under the <strong>UK GDPR</strong> and the{" "}
          <strong>Data Protection Act 2018</strong>.
        </p>

        <LegalSubheading>
          Being a hobby project does not make it exempt
        </LegalSubheading>
        <p>
          This is worth saying out loud, because it is the obvious thing to
          wonder and the obvious thing for me to try to hide behind. The UK GDPR
          does not apply to processing by an individual &ldquo;in the course of
          a purely personal or household activity&rdquo; (Article 2(2)(c)).{" "}
          <strong>
            That exemption does not cover this, and I am not claiming it.
          </strong>
        </p>
        <p>Two reasons, and either on its own is enough:</p>
        <ul className="ml-5 list-disc space-y-1">
          <li>
            dlectroflow is offered over the public internet to other people, and
            it processes <em>their</em> data on infrastructure I control. That
            is not my personal or household activity, whatever my motive for
            building it.
          </li>
          <li>
            Even where someone uses it for purely personal purposes of their
            own, Recital 18 says the Regulation still applies to whoever{" "}
            <em>provides the means</em> for that processing. That is me.
          </li>
        </ul>
        <p>
          So every obligation in this notice is a real one, and every right
          below is a real right. Being unpaid changes what this project can
          afford; it does not change what you are entitled to.
        </p>

        <LegalSubheading>Getting hold of me</LegalSubheading>
        <p>
          For anything to do with privacy, your data, or your rights, write to{" "}
          <ContactLink />. That address is monitored and it is the right route
          for every request in this policy — you do not need to find another
          one.
        </p>
        <p className="text-muted-foreground">
          There is no data protection officer: Article 37 requires one only for
          public authorities, for large-scale regular monitoring of people, or
          for large-scale processing of special category data, and this is none
          of those. The person reading that inbox is the same person who wrote
          the code.
        </p>
      </LegalSection>

      <LegalSection {...s("scope")}>
        <p>
          This policy covers <strong>only</strong> the instance running at
          dlectroflow.dev.
        </p>
        <p>
          dlectroflow is open source under the{" "}
          <Ext href={`${SOURCE_REPO_URL}/-/blob/main/LICENSE`}>
            AGPL-3.0 licence
          </Ext>
          , and it is built to be self-hosted. If you run your own copy, that
          instance is yours: <strong>you</strong> are its controller, your
          users&rsquo; data never touches anything of mine, and this policy does
          not apply to it. If you are using someone else&rsquo;s instance, ask
          them for their policy — not this one.
        </p>
      </LegalSection>

      <LegalSection {...s("collected")}>
        <p>
          Everything here falls into one of four groups. Nothing is bought from
          a third party, inferred about you, or collected in the background.
        </p>

        <LegalSubheading>1. What you write</LegalSubheading>
        <p>
          This is the bulk of it, and it is all typed by you or produced by
          using the app:
        </p>
        <ul className="ml-5 list-disc space-y-1">
          <li>
            <strong>Brain-dump items</strong> — the free text you capture, plus
            when you captured, triaged, snoozed, saved or completed each one.
          </li>
          <li>
            <strong>Tasks and steps</strong> — titles, step text, emoji, time
            estimates and the history of those estimates, what is done, and the
            scheduling intent you picked.
          </li>
          <li>
            <strong>Focus sessions</strong> — start and end times, pauses,
            planned and added minutes, and how the session ended.
          </li>
          <li>
            <strong>Daily roll-ups</strong> — the day&rsquo;s counts, and a
            short AI-written narrative about your day (see{" "}
            <Link href={`#${s("ai").id}`} className="underline">
              Sending your text to an AI provider
            </Link>
            ).
          </li>
          <li>
            <strong>Rewards</strong> — points events, your current streak, past
            streak records, badges earned, and the daily quote you were shown.
          </li>
          <li>
            <strong>Settings</strong> — voice, typeface, appearance, timer
            style, focus sounds, working days and hours, reminder times,
            freshness thresholds.
          </li>
          <li>
            <strong>AI usage counters</strong> — how many breakdowns have been
            requested, so a fair-use cap can be applied.
          </li>
        </ul>

        <LegalSubheading>2. If you use it as a guest</LegalSubheading>
        <p>
          You can use dlectroflow with <strong>no account at all</strong>. When
          you first arrive, a sandbox workspace is created for you and its
          identifier is put in a signed cookie. There is no name, no email
          address, and no sign-in — the sandbox is not linked to you as a
          person, only to that cookie.
        </p>
        <p>
          One extra thing is stored for guests: a{" "}
          <strong>salted SHA-256 hash of your IP address</strong>, used purely
          to count AI breakdowns against the daily guest cap and the
          instance&rsquo;s overall cap. The address itself is never written to
          the database — only the hash, and only with a secret salt, so it
          cannot be turned back into an address or matched against a list of
          addresses.
        </p>

        <LegalSubheading>3. If you have an account</LegalSubheading>
        <p>
          Accounts are <strong>invite-only</strong>. There is no sign-up form:
          your identity has to be on an allowlist before sign-in will work at
          all. Sign-in is through <strong>GitLab</strong>, and it is the only
          sign-in method.
        </p>
        <ul className="ml-5 list-disc space-y-1">
          <li>
            <strong>From GitLab</strong>: your GitLab user id, your username,
            and your email address if GitLab returns one. The only permission
            requested is <code className="text-xs">read_user</code> — no
            repositories, no code, no groups, no ability to act as you.
          </li>
          <li>
            <strong>The invitation record</strong>: the username or email
            address that was entered to invite you, an optional private note
            written by whoever invited you, and when the invitation was created
            and claimed. This exists before you first sign in — it is what makes
            the allowlist work.
          </li>
          <li>
            <strong>Your account state</strong>: your role, whether the account
            is active or revoked, your AI allowance and how much of it you have
            used, and when you were last seen.
          </li>
        </ul>

        <LegalSubheading>4. Optional connections</LegalSubheading>
        <ul className="ml-5 list-disc space-y-1">
          <li>
            <strong>Google Tasks</strong>, if connected: an encrypted access
            token and refresh token, the granted scope and its expiry, plus the
            Google list and task identifiers for anything pushed there — so a
            change updates the existing task instead of creating a duplicate.
            Details in{" "}
            <Link href={`#${s("google").id}`} className="underline">
              Connecting Google Tasks
            </Link>
            .
          </li>
          <li>
            <strong>The end-of-day round-up email</strong>, if switched on: the
            email address you type in. It is off by default and guests cannot
            set one.
          </li>
        </ul>

        <LegalSubheading>What is not collected</LegalSubheading>
        <p>
          No analytics. No tracking pixels. No advertising. No profiling. No
          session recording. No device fingerprinting. No third-party scripts of
          any kind. This is not a policy position that could quietly lapse —
          there is{" "}
          <strong>no analytics or tracking package in the codebase</strong> at
          all, and because the source is public you can check that for yourself
          rather than take my word for it.
        </p>
        <p>
          No payment details either: the hosted instance is free and there is
          nothing to pay.
        </p>
        <p>
          <strong>One honest caveat about IP addresses.</strong> The application
          never stores your IP address, only the salted hash described above.
          But the web server sitting in front of it writes ordinary access logs,
          and those include IP addresses, as web server logs everywhere do. They
          are platform logs: kept only as long as they are useful for
          investigating errors and abuse, never joined to your account or your
          content, and never used for analytics.
        </p>
      </LegalSection>

      <LegalSection {...s("bases")}>
        <p>
          The UK GDPR requires a lawful basis for each purpose, not one blanket
          basis for everything. Here is the honest breakdown, purpose by
          purpose.
        </p>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <strong>Running the app for someone with an account</strong> —
            storing and showing your tasks, steps, sessions, settings and
            rewards.
            <br />
            <em>Contract</em> (Article 6(1)(b)). You accepted the Terms and
            asked me to provide the service; it cannot be provided without
            storing what you type into it.
          </li>
          <li>
            <strong>
              Running a guest sandbox for someone with no account.
            </strong>
            <br />
            <em>Legitimate interests</em> (Article 6(1)(f)). My interest is
            letting you try the app without handing over an identity first —
            which is the more privacy-protective option, not the less. The data
            is only what you type, it is tied to a random identifier rather than
            to you, and it deletes itself within about a day. Weighing that
            against your interests, a trial that asks for nothing seems to be
            what most people would prefer; if you disagree, you can object.
          </li>
          <li>
            <strong>Signing you in and keeping your workspace yours.</strong>
            <br />
            <em>Contract</em> (Article 6(1)(b)) for authenticating you and
            giving you access to your own workspace, and{" "}
            <em>legitimate interests</em> (Article 6(1)(f)) for the security
            machinery around it — signed sessions, and making sure one workspace
            can never read another&rsquo;s data.
          </li>
          <li>
            <strong>Keeping the invitation allowlist.</strong>
            <br />
            <em>Legitimate interests</em> (Article 6(1)(f)). Being invite-only
            is the main control that keeps a personal project&rsquo;s data
            closed. It costs one username or email address per invitation and
            nothing else. If you were invited and would rather not be on the
            list, ask and it comes off.
          </li>
          <li>
            <strong>Generating AI task breakdowns</strong> — which means sending
            your task text to a third-party provider.
            <br />
            <em>Contract</em> (Article 6(1)(b)). The breakdown is the feature
            you asked for, and it cannot happen without sending the text. This
            is deliberately <strong>not</strong> called consent: consent has to
            be freely given and freely withdrawable, and &ldquo;withdraw it and
            the feature ceases to exist&rdquo; is not a real choice, so
            labelling it consent would dress up a necessity as an option. If you
            would rather your text were not sent, do not use the breakdown —
            capture, tasks, steps, the focus timer and the rewards all work
            without it.
          </li>
          <li>
            <strong>Connecting Google Tasks.</strong>
            <br />
            <em>Consent</em> (Article 6(1)(a)). Genuinely optional, separately
            asked for through Google&rsquo;s own consent screen, and
            withdrawable at any time in Settings — which revokes the grant and
            deletes the stored tokens. Nothing else in the app stops working if
            you never connect it.
          </li>
          <li>
            <strong>The end-of-day round-up email.</strong>
            <br />
            <em>Consent</em> (Article 6(1)(a)). Off by default. You type the
            address and switch it on; switching it off withdraws it.
          </li>
          <li>
            <strong>The guest fair-use cap</strong> — the salted IP hash.
            <br />
            <em>Legitimate interests</em> (Article 6(1)(f)). The AI endpoint
            costs real money and is open to anyone with a browser; without a
            cap, one visitor can spend a whole day&rsquo;s budget in a minute.
            The processing is minimised to a salted hash that is never the
            address itself, and it is deleted after 30 days.
          </li>
          <li>
            <strong>Backups, security, and keeping the service running.</strong>
            <br />
            <em>Legitimate interests</em> (Article 6(1)(f)). Article 32 requires
            appropriate security in any case, and a service with no backups
            would be a worse deal for you than one with them.
          </li>
          <li>
            <strong>
              Answering a rights request, or a lawful legal demand.
            </strong>
            <br />
            <em>Legal obligation</em> (Article 6(1)(c)).
          </li>
        </ul>
        <p>
          Where I rely on legitimate interests, you can ask me for the balancing
          reasoning in more detail, and you can object — see{" "}
          <Link href={`#${s("rights").id}`} className="underline">
            Your rights
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection {...s("ai")}>
        <p>
          This is the most significant thing that happens to your data, so it
          gets its own section rather than a line in a list.
        </p>
        <p>
          To turn &ldquo;sort out the tax return&rdquo; into a list of small
          steps, the text has to go to a large language model, and that model is
          not mine. <strong>Anthropic</strong> (Anthropic PBC, United States) is
          the provider this instance uses.
        </p>

        <LegalSubheading>What is sent</LegalSubheading>
        <ul className="ml-5 list-disc space-y-1">
          <li>
            <strong>When you ask for a breakdown</strong>: the task&rsquo;s
            title, the steps currently proposed (their text, emoji and time
            estimates), and anything you typed into the &ldquo;tell Claude how
            to adjust&rdquo; box.
          </li>
          <li>
            <strong>Note where the title comes from.</strong> If you break down
            a brain-dump item, that item&rsquo;s text <em>becomes</em> the task
            title — so the words you captured are sent. Brain-dump items you
            have not broken down are not sent anywhere.
          </li>
          <li>
            <strong>When the end-of-day roll-up is written</strong> (signed-in
            accounts only): the text of up to five steps you finished and up to
            three carrying over, so the narrative can mention them.
          </li>
          <li>
            <strong>When you overrun a focus step</strong> and ask for a kinder
            estimate (signed-in accounts only): that step&rsquo;s text and its
            current estimate.
          </li>
        </ul>

        <LegalSubheading>What is not sent</LegalSubheading>
        <p>
          The context sent alongside a breakdown, so the model knows roughly
          where you are in your day, is <strong>numbers and flags only</strong>{" "}
          — small integers, booleans and one preference. It contains no free
          text, no identifiers, no email addresses and no dates. Your email
          address, your GitLab identity, your Google tokens and your settings
          are never sent. The daily quote is generated from a fixed prompt
          containing nothing about you.
        </p>

        <LegalSubheading>
          Training, and what happens to it there
        </LegalSubheading>
        <p>
          I do not use your content to train anything, and Anthropic&rsquo;s
          commercial terms state that they do not train their models on inputs
          or outputs sent through their API. Anthropic processes this text on my
          instructions, as a processor, to answer the request and for nothing
          else.
        </p>

        <LegalSubheading>Which provider, and why it matters</LegalSubheading>
        <p>
          The code can talk to other providers — there is an OpenAI-compatible
          adapter for people self-hosting against a local model or another
          vendor — but that is a deployment setting, not something you choose in
          the app, and{" "}
          <strong>this instance uses Anthropic for every request</strong>. If
          that ever changes here, this page changes with it and the effective
          date at the top moves.
        </p>
        <p>
          Because Anthropic is in the United States, this is an{" "}
          <strong>international transfer</strong> of your data. It is not buried
          in a list — see{" "}
          <Link href={`#${s("transfers").id}`} className="underline">
            Data that leaves the UK
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection {...s("google")}>
        <p>
          Connecting Google is <strong>optional</strong>. Everything else works
          without it, and steps can be exported as a calendar file instead.
        </p>

        <LegalSubheading>One permission, and only one</LegalSubheading>
        <p>The connection requests exactly one OAuth scope:</p>
        <p>
          <code className="text-xs break-all">
            https://www.googleapis.com/auth/tasks
          </code>
        </p>
        <p>
          Nothing else. No Gmail, no Calendar, no Drive, no Contacts, no access
          to your profile or photos, no ability to read anything outside Google
          Tasks.
        </p>

        <LegalSubheading>What it is used for</LegalSubheading>
        <p>
          Creating and updating tasks in a Google Tasks list inside the
          connected Google account, so that a scheduling tool which syncs from
          that list can find them and book time for them. What is written is a
          task title (built from your task and step text, with a duration) and a
          due date.
        </p>
        <p>
          The only thing <em>read</em> from the Google account is the list of
          your Google Tasks list names, so the right list can be found to write
          into. Nothing from your Google account is copied into dlectroflow
          beyond the list and task identifiers needed to update the right task
          later.
        </p>

        <LegalSubheading>Who can connect it</LegalSubheading>
        <p>
          As things stand, only the account that administers this instance can
          connect Google, and there is a single connection for the instance. If
          you are an invited member, you cannot yet connect your own Google
          account — and nothing of yours is pushed into anybody else&rsquo;s
          Google account. Per-member connections are planned; when they arrive,
          this section changes.
        </p>

        <LegalSubheading>Tokens, and disconnecting</LegalSubheading>
        <p>
          The access and refresh tokens are{" "}
          <strong>encrypted at rest using AES-256-GCM</strong>. The encryption
          key is held in the deployment&rsquo;s secrets, not in the database, so
          a copy of the database on its own yields no usable tokens.
        </p>
        <p>
          Disconnecting in Settings asks Google to revoke the grant and then
          deletes the stored tokens — the deletion happens whether or not
          Google&rsquo;s revoke call succeeds, so dead tokens are never left
          lying around. You can also revoke access yourself at any time from
          your Google account&rsquo;s security settings.
        </p>
      </LegalSection>

      <LegalSection {...s("recipients")}>
        <p>
          A short list, and it is the whole list. Your data is not sold, rented,
          traded or shared for anyone&rsquo;s marketing — mine included.
        </p>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <strong>Google Cloud Platform</strong> — hosting. The servers, the
            database and the backup storage all run here, in the UK. A
            processor: it holds the data but may only act on my instructions.
          </li>
          <li>
            <strong>Anthropic</strong> (United States) — the AI provider that
            generates breakdowns, roll-up narratives and re-estimates. A
            processor, and an international transfer.
          </li>
          <li>
            <strong>Google Tasks</strong> — only if you connect it, and only to
            write into the connected Google account.
          </li>
          <li>
            <strong>Resend</strong> (United States) — only if you switch on the
            end-of-day round-up email. It receives the address you gave and the
            email itself, which contains the day&rsquo;s counts and the
            AI-written narrative. A processor, and an international transfer.
            Leave the feature off and Resend is never contacted.
          </li>
          <li>
            <strong>GitLab</strong> — the identity provider for sign-in. GitLab
            is not my processor: it is a service you already have an account
            with, and when you choose to sign in, your browser goes to GitLab
            and GitLab tells me your id, username and email address.
            GitLab&rsquo;s own privacy notice governs what GitLab does.
          </li>
        </ul>
        <p>
          Beyond that: nobody. No advertising networks, no data brokers, no
          analytics vendors, no &ldquo;partners&rdquo;. I would also disclose
          data if I were legally required to — a court order or a valid demand
          from a public authority — and I would tell you unless I were
          prohibited from doing so.
        </p>
      </LegalSection>

      <LegalSection {...s("transfers")}>
        <p>
          Your stored data sits in the UK. Two flows leave it, and both are
          named plainly rather than folded into a list of &ldquo;service
          providers&rdquo;.
        </p>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <strong>Anthropic, United States</strong> — the task text described
            above. The transfer relies on the standard data protection clauses
            permitted by Article 46 UK GDPR: the EU standard contractual clauses
            together with the UK International Data Transfer Addendum, as
            incorporated in Anthropic&rsquo;s data processing terms.
          </li>
          <li>
            <strong>Resend, United States</strong> — the round-up email, only if
            you turn it on. Same safeguard: standard contractual clauses with
            the UK Addendum.
          </li>
        </ul>
        <p>
          Two more worth being straight about. If you connect{" "}
          <strong>Google Tasks</strong>, tasks are written into your own Google
          account; Google LLC is certified under the UK Extension to the EU–US
          Data Privacy Framework, and its cloud terms also carry the standard
          clauses and UK Addendum. And although the <strong>hosting</strong> is
          in the UK, Google may access it from outside the UK for support
          purposes under those same terms.
        </p>
        <p>
          You are entitled to a copy of the safeguards relied on. Ask at{" "}
          <ContactLink /> and I will point you at them.
        </p>
      </LegalSection>

      <LegalSection {...s("where")}>
        <p>
          The application and its Postgres database run on Google Kubernetes
          Engine in <strong>{HOSTING_REGION}</strong>. The database is backed up
          nightly at <strong>02:00 UTC</strong> to Google Cloud Storage in the
          same region.
        </p>
        <p>
          So your data at rest — live and backed up — is in the United Kingdom.
        </p>
      </LegalSection>

      <LegalSection {...s("retention")}>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <strong>Guest sandboxes</strong> expire on a fixed time-to-live —
            about a day from the moment the sandbox is created — and a job at{" "}
            <strong>03:30 UTC</strong> each night deletes the expired ones and
            everything inside them. Worth knowing: continuing to use it does{" "}
            <em>not</em> push the expiry back, so a guest sandbox is one day,
            not a rolling one. If you want to keep what you captured, you need
            an account.
          </li>
          <li>
            <strong>Guest AI counters</strong> — including the salted IP hash —
            are deleted after <strong>30 days</strong> by the same nightly job.
          </li>
          <li>
            <strong>Account data</strong> is kept for as long as you have an
            account, and until you ask for it to go.{" "}
            <strong>Being honest about a gap:</strong> if an account&rsquo;s
            access is revoked, its content is <em>not</em> deleted automatically
            today. It stays until it is deleted by hand. Email me and it will
            be.
          </li>
          <li>
            <strong>Google tokens</strong> are kept until you disconnect, or
            until the grant is revoked at Google&rsquo;s end — at which point
            they are cleared.
          </li>
          <li>
            <strong>The round-up email address</strong> is kept until you clear
            it or turn the feature off.
          </li>
          <li>
            <strong>Backups</strong> are deleted after{" "}
            <strong>{BACKUP_RETENTION_DAYS} days</strong>. This is the one that
            matters for erasure: when something is deleted it is gone from the
            app immediately, and gone from the backups within{" "}
            {BACKUP_RETENTION_DAYS} days. I am not going to pretend backups do
            not exist.
          </li>
          <li>
            <strong>Cookies</strong> — see the table in{" "}
            <Link href={`#${s("cookies").id}`} className="underline">
              Cookies
            </Link>
            .
          </li>
        </ul>
      </LegalSection>

      <LegalSection {...s("security")}>
        <ul className="ml-5 list-disc space-y-1">
          <li>
            <strong>Encrypted in transit.</strong> HTTPS everywhere, with HTTP
            redirected and HSTS set for two years including subdomains, plus a
            strict Content-Security-Policy.
          </li>
          <li>
            <strong>Encrypted at rest where it counts.</strong> OAuth tokens and
            any stored provider API key are encrypted with{" "}
            <strong>AES-256-GCM</strong>, with the key held in the
            deployment&rsquo;s secrets rather than the database.
          </li>
          <li>
            <strong>IP addresses are hashed, never stored.</strong> SHA-256 with
            a secret salt, as described above.
          </li>
          <li>
            <strong>No open sign-up.</strong> Sign-in is invite-only against an
            allowlist, so an attacker cannot simply create an account and start
            looking around.
          </li>
          <li>
            <strong>Sessions</strong> are signed tokens in cookies marked
            HttpOnly, SameSite=Lax and Secure.
          </li>
          <li>
            <strong>
              Workspace isolation is enforced structurally, not promised.
            </strong>{" "}
            A check in the build pipeline reads the source and fails the build
            if any database query against workspace-scoped data is not
            constrained to a single workspace. It is not a policy anyone has to
            remember: a change that broke the isolation would not merge.
          </li>
          <li>
            <strong>
              What an administrator can see: counts, never content.
            </strong>{" "}
            The admin panel shows a handle, a role, a status, an AI policy and
            how many breakdowns an account has used. It cannot show your tasks,
            your steps, your notes, your email address or your stored key — and
            the same automated check is what keeps that true rather than my word
            for it.
          </li>
          <li>
            <strong>Automated scanning</strong> for known vulnerabilities and
            risky code patterns runs on every change before it can ship.
          </li>
        </ul>
        <p>
          <strong>And the honest limits.</strong> This is a personal project run
          by one person. There has been no third-party security audit.
          Encryption protects tokens and keys, not the task text itself, which
          has to be readable by the application to work. The source is public,
          so you can form your own view rather than trust an assurance — and if
          you find something wrong, the repository has a security policy telling
          you how to report it.
        </p>
      </LegalSection>

      <LegalSection {...s("cookies")}>
        <p>
          There are six, they are all strictly necessary, and that is the entire
          list.
        </p>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <code className="text-xs">df_guest</code> — identifies your guest
            sandbox so the app can show you your own work. Without it an
            anonymous visitor has no workspace and the app cannot function.{" "}
            <em>About a day.</em>
          </li>
          <li>
            <code className="text-xs">df_owner</code> — your signed-in session.{" "}
            <em>30 days, or until you sign out.</em>
          </li>
          <li>
            <code className="text-xs">gitlab_oauth_state</code> and{" "}
            <code className="text-xs">gitlab_pkce_verifier</code> — protect the
            GitLab sign-in round trip against request forgery and code
            interception. Deleted the moment sign-in finishes.{" "}
            <em>10 minutes.</em>
          </li>
          <li>
            <code className="text-xs">google_oauth_state</code> and{" "}
            <code className="text-xs">google_pkce_verifier</code> — the same
            protection for connecting Google Tasks. <em>10 minutes.</em>
          </li>
        </ul>
        <p>
          All six exist solely to deliver the service you asked for, so under
          the Privacy and Electronic Communications Regulations no consent is
          required for them — which is why{" "}
          <strong>there is no cookie banner</strong>. There is nothing to
          consent to: no analytics cookie, no tracking cookie, no advertising
          cookie, no profiling cookie, and no third-party cookie of any kind.
        </p>
        <p>
          Separately, your light/dark theme choice is stored in your
          browser&rsquo;s own local storage under{" "}
          <code className="text-xs">df-theme</code>. It never leaves your device
          and is never sent to the server.
        </p>
      </LegalSection>

      <LegalSection {...s("sensitive")}>
        <p>
          dlectroflow is built for people with ADHD, so let me be direct about
          what that does and does not mean.
        </p>
        <p>
          <strong>
            Using this app is not a diagnosis, and I do not record why you use
            it.
          </strong>{" "}
          There is no health field, no diagnosis field, no questionnaire, and
          nothing infers anything about your health, your mind, or how you are
          doing. It is a to-do app with a kind tone. Plenty of people use it who
          have never been near an assessment.
        </p>
        <p>
          What I cannot control is what you type into a free-text box. If you
          write &ldquo;phone the psychiatrist about the dose change&rdquo;, that
          is health information, and it is treated exactly like every other
          task: stored, and sent to the AI provider if you ask for a breakdown
          of it. Where you choose to include details like that, you are sharing
          them knowingly and explicitly, and it is that explicit consent —
          Article 9(2)(a) UK GDPR — that permits me to hold them. You can delete
          the item yourself at any time, or ask me to.
        </p>
        <p>
          <strong>A practical suggestion, not a rule:</strong> the app works
          just as well if you write &ldquo;phone the clinic&rdquo; and keep the
          clinical detail out of it. Nothing is lost by being vague, and it is
          the simplest way to keep sensitive detail out of a system you did not
          build.
        </p>
      </LegalSection>

      <LegalSection {...s("decisions")}>
        <p>
          <strong>Nothing here makes a decision about you.</strong> The AI
          suggests a list of steps; you accept them, edit them, reorder them, or
          throw them away. There is no scoring of people, no eligibility
          decision, no ranking, and no automated decision producing legal or
          similarly significant effects — so the Article 22 rules on automated
          decision-making do not come into play.
        </p>
        <p>
          Streaks, points and badges are counters of what you did, calculated
          automatically. They produce a number on your own dashboard and nothing
          else: no consequence, no judgement, nothing shared with anyone.
        </p>
      </LegalSection>

      <LegalSection {...s("rights")}>
        <p>
          Under the UK GDPR you have all of the following. To use any of them,
          email <ContactLink /> — one address, no forms.
        </p>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <strong>Access</strong> — a copy of the personal data I hold about
            you, and confirmation of how it is used.
          </li>
          <li>
            <strong>Rectification</strong> — correction of anything inaccurate
            or incomplete. Most of it you can edit yourself in the app.
          </li>
          <li>
            <strong>Erasure</strong> — deletion of your data. Ask, and it goes.
          </li>
          <li>
            <strong>Restriction</strong> — you can ask me to stop using your
            data while a dispute about its accuracy or my basis for holding it
            is sorted out.
          </li>
          <li>
            <strong>Portability</strong> — your data in a structured,
            machine-readable form. I will send it as JSON.
          </li>
          <li>
            <strong>Objection</strong> — you can object to anything I do on the
            basis of legitimate interests (the guest sandbox, the allowlist, the
            fair-use cap, security and backups). Tell me and I will either stop
            or explain the compelling grounds for continuing.
          </li>
          <li>
            <strong>Withdrawing consent</strong> — disconnect Google in
            Settings, or switch the round-up email off. Either takes effect
            immediately. You can also just ask me.
          </li>
        </ul>

        <LegalSubheading>How that actually works here</LegalSubheading>
        <p>
          <strong>There is no self-service export button yet.</strong> I am
          telling you rather than implying otherwise: access, portability and
          erasure requests are handled <em>by me, by hand</em>, from that email
          address. It is less slick than a download link and it is exactly as
          binding.
        </p>
        <p>
          I will respond <strong>within one month</strong> of your request,
          which is the statutory deadline. If a request is genuinely complex I
          may extend that by up to two further months, and if I do, I will tell
          you why inside the first month. There is no charge, unless a request
          is manifestly unfounded or excessive.
        </p>
        <p>
          I may need to check you control the GitLab identity your account is
          linked to, so that I do not hand your data to somebody else claiming
          to be you.
        </p>
        <p>
          <strong>One real limitation, for guests.</strong> A guest sandbox has
          no identity attached to it — that is the point of it — so I have no
          way to find &ldquo;your&rdquo; sandbox from an email address. It will
          expire and be deleted on its own within about a day. To be rid of it
          sooner, clear the <code className="text-xs">df_guest</code> cookie or
          use a private window. If you want it deleted now and can read the
          sandbox identifier out of that cookie in your browser&rsquo;s
          developer tools, send it to me and I will delete it.
        </p>
        <p>
          Nothing in this policy or in the Terms limits your rights under UK
          data protection law.
        </p>
      </LegalSection>

      <LegalSection {...s("complaints")}>
        <p>
          If you think I have handled your data badly, please tell me first — I
          would genuinely rather fix it than have you discover I cannot be
          bothered. But you do not have to, and you lose nothing by going
          straight to the regulator.
        </p>
        <p>
          The UK supervisory authority is the{" "}
          <strong>Information Commissioner&rsquo;s Office</strong>:
        </p>
        <ul className="ml-5 list-disc space-y-1">
          <li>
            <Ext href="https://ico.org.uk/make-a-complaint/">
              ico.org.uk/make-a-complaint
            </Ext>
          </li>
          <li>Helpline: 0303 123 1113</li>
          <li>
            Information Commissioner&rsquo;s Office, Wycliffe House, Water Lane,
            Wilmslow, Cheshire, SK9 5AF
          </li>
        </ul>
      </LegalSection>

      <LegalSection {...s("children")}>
        <p>
          dlectroflow is not intended for children under 13. In the UK, 13 is
          the age at which a child can consent to an online service like this
          one on their own behalf.
        </p>
        <p>
          Accounts are invite-only, so I know who has one. Guest use needs no
          account, which means I have no way to verify anyone&rsquo;s age — so
          if you are a parent or carer and believe a child&rsquo;s data is in
          here, email <ContactLink /> and I will delete it.
        </p>
      </LegalSection>

      <LegalSection {...s("changes")}>
        <p>
          The <strong>effective date</strong> at the top of this page is its
          version. If the substance changes, that date changes with it in the
          same breath.
        </p>
        <p>
          Because this is an open-source project, the complete, timestamped
          history of every word on this page is public in the{" "}
          <Ext href={SOURCE_REPO_URL}>source repository</Ext>. You can see
          exactly what changed and when — which is a considerably better change
          log than an email saying a policy has been updated.
        </p>
        <p>
          There is no in-app notification system yet, so the effective date and
          that history are the reliable ways to check. If a change would
          materially reduce your protections and the law requires your consent,
          I will ask before it takes effect, not after.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
