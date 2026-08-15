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
 *     per-account choice of AI provider (#125) — and are absent because they do
 *     not exist. A notice describing behaviour the software lacks is a worse
 *     problem than a plain one: it is an unkeepable promise made in writing to
 *     every reader.
 *
 * #118 Phase C moved two of those from "not shipped" to shipped, and this text
 * was rewritten to match: Google is now a PER-USER connection (each member's
 * tasks go into their OWN Google account, unreachable by any other account
 * including the owner), and a member may store their OWN LLM API key.
 *
 * The distinction the LLM text has to keep making, because it is the easy one to
 * overstate: a member supplies a KEY, never a PROVIDER. `LLMCredentials` has no
 * base URL by design — a per-user endpoint would be an SSRF primitive — so the
 * key is spent against whatever `LLM_PROVIDER` the DEPLOYMENT configures. Nothing
 * in the app writes `User.llmProvider`; per-account provider selection is #125
 * and unshipped. Do not "simplify" that into "choose your own AI provider".
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
            estimates and the history of those estimates, what is done, the
            scheduling intent you picked, and{" "}
            <strong>any note you write on a task or on a single step</strong>{" "}
            (up to 2,000 characters each). A note you write on a capture before
            you triage it is kept the same way.
          </li>
          <li>
            <strong>Coaching conversations</strong> — the messages you send the
            breakdown coach and the step lists it proposed back, kept against
            the task so you can see how it got there.
          </li>
          <li>
            <strong>Shopping list</strong> — the items you type on it, whether
            each one is ticked off, and whether you have moved it down to
            &ldquo;saved for later&rdquo;. Only if you switch shopping-list mode
            on in Settings: it is off by default, and nothing is stored until
            you add something. Switching it off again hides the list without
            deleting it, so the items stay until you delete them or delete your
            account.
          </li>
          <li>
            <strong>Focus sessions</strong> — start and end times, pauses,
            planned and added minutes, and how the session ended.
          </li>
          <li>
            <strong>Focus playlists</strong> — any playlist you create and the
            name you give it, plus which tracks you put in it.
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
            requested is <code>read_user</code> — no repositories, no code, no
            groups, no ability to act as you.
          </li>
          <li>
            <strong>A display name</strong>, if you set one — the name you would
            like to be greeted by, instead of your GitLab username. Optional,
            and blank until you type one.
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
            <strong>Your own AI provider API key</strong>, if you save one: the
            key itself, encrypted, and nothing else — no account name and no
            billing details, because the key is all the provider needs and all
            the app asks for. Signed-in accounts only. Details in{" "}
            <Link href={`#${s("ai").id}`} className="underline">
              Sending your text to an AI provider
            </Link>
            .
          </li>
          <li>
            <strong>A calendar subscription URL</strong>, if you create one: a
            single random token, so the URL is unguessable. Nothing else — no
            record of which calendar app you pasted it into, and the app itself
            writes nothing when your calendar fetches the feed.{" "}
            <strong>One caveat that matters here.</strong> The token is part of
            the web address, not a hidden header, and the web server in front of
            the app records the address of every request it handles — the
            ordinary access log described at the end of this section. So there
            <em> is</em> a record of when the feed was fetched, and it has the
            token in it. Those logs are deleted after 30 days, and you can
            replace the token from Settings at any time, which makes every
            logged copy of the old one useless. Signed-in accounts only. Details
            in{" "}
            <Link href={`#${s("recipients").id}`} className="underline">
              Who else is involved
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
          are platform logs: kept for 30 days, never joined to your account or
          your content, and never used for analytics.
        </p>
        <p>
          Those logs record <strong>the web address of each request</strong> as
          well, which is the same everywhere and normally says nothing much. It
          is worth spelling out for one feature: a calendar subscription URL
          carries its token in the address, so the token appears in the log for
          as long as the log is kept. That is why the setting lets you replace
          it, and why the 30-day window is stated here rather than left as
          &ldquo;however long logs last&rdquo;.
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
            deletes the stored tokens. If your access to this instance ends
            before you get round to it, the grant is withdrawn for you. Nothing
            else in the app stops working if you never connect it.
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
            <strong>Your note on the task</strong>, if you have written one. The
            first 600 characters of it are quoted into the request, so the steps
            take account of what you already knew. Notes on other tasks, and on
            anything you have not asked to break down, are never sent.
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
        {/* This paragraph said the breakdown context "contains no free text"
            from #123 until this revision, and #179 had made that false on
            2026-08-08 by adding `Task.notes` to `breakdown-context.ts`'s
            select. The claim survived because it is a NEGATIVE one: the "what
            is sent" list above grew a gap nobody could see, while the sentence
            that read as a guarantee went unread. Keep the shape below — name
            everything that IS sent, then say what the remainder is — because
            an unqualified "no free text" is the exact sentence that broke. */}
        <p>
          Apart from the task title, the proposed steps, your note on that task
          and anything you typed into the &ldquo;tell Claude how to
          adjust&rdquo; box, the context sent alongside a breakdown is{" "}
          <strong>numbers and flags only</strong> — small integers, booleans and
          one preference. No identifiers, no email addresses and no dates. That
          one preference is the <strong>voice</strong> you picked, so the steps
          come back in the same tone as the rest of the app; your email address,
          your GitLab identity, your Google tokens and every <em>other</em>{" "}
          setting are never sent. Neither is the text of your other captures,
          your other tasks&rsquo; steps, or any other task&rsquo;s note. The
          daily quote is generated from a fixed prompt containing nothing about
          you.
        </p>

        <LegalSubheading>
          Training, and what happens to it there
        </LegalSubheading>
        <p>
          I do not use your content to train anything, and Anthropic&rsquo;s
          commercial terms state that they do not train their models on inputs
          or outputs sent through their API. Where the request is made on my API
          key — which is the default, and the case for everyone who has not
          saved their own — Anthropic processes this text on my instructions, as
          a processor, to answer the request and for nothing else. If you have
          saved your own key, the request is made on yours instead; see{" "}
          <em>If you bring your own API key</em> below.
        </p>

        <LegalSubheading>Which provider, and why it matters</LegalSubheading>
        <p>
          The code can talk to other providers — there is an OpenAI-compatible
          adapter for people self-hosting against a local model or another
          vendor — but which one is used is a{" "}
          <strong>
            deployment setting, chosen by whoever runs the instance
          </strong>
          , not something you choose in the app. On this instance that setting
          is Anthropic, and{" "}
          <strong>this instance uses Anthropic for every request</strong> —
          whoever is asking, and whether or not they brought their own key. If
          that ever changes here, this page changes with it and the effective
          date at the top moves.
        </p>

        <LegalSubheading>If you bring your own API key</LegalSubheading>
        <p>
          If you have an account, Settings lets you save your own API key for
          the AI provider. It is entirely optional — everything works without
          one — and guests cannot save a key, because there is no account to
          hold it against.
        </p>
        <p>What saving a key changes:</p>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <strong>Your breakdowns are paid for by you</strong>, not by me. The
            instance&rsquo;s fair-use cap on AI requests stops applying to your
            account, because it exists to protect my bill rather than to ration
            yours.
          </li>
          <li>
            <strong>The key is encrypted at rest</strong> with AES-256-GCM, the
            same way the Google tokens are, with the encryption key held in the
            deployment&rsquo;s secrets rather than in the database. It is never
            displayed back to you, never sent to your browser, and never shown
            to anyone else — there is deliberately no &ldquo;reveal my
            key&rdquo; button. You can remove it in Settings whenever you like.
          </li>
          <li>
            <strong>
              The request is then made as you, so your own agreement with the
              provider governs it.
            </strong>{" "}
            Your text still travels from this server to the provider exactly as
            described above, but authenticated with your credentials — so it
            lands in <em>your</em> account with them and is subject to whatever
            terms you have accepted. The processing terms and transfer
            safeguards I rely on cover requests made on <em>my</em> key; they
            cannot cover requests made on yours.
          </li>
        </ul>
        <p>
          <strong>
            And the significant thing it does not change: it is a key, not a
            destination.
          </strong>{" "}
          A key you save is used against <em>this instance&rsquo;s</em>{" "}
          configured provider — Anthropic — and nothing else. It does not let
          you choose a different company, a different endpoint, or a different
          address for the server to send your text to, and there is no field in
          the app for any of those. That is a deliberate security decision
          rather than an oversight: a per-account setting that chose which host
          this server connects to would let anybody with an account aim it at a
          machine of their own choosing.{" "}
          <strong>
            Choosing your own provider is not something dlectroflow can do today
          </strong>
          , and if it is ever built, this page changes before it ships.
        </p>
        <p className="text-muted-foreground">
          What the administrator can see about this is <em>whether</em> you have
          saved a key — a yes or no in the admin panel — and never the key
          itself.
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
          <code className="break-all">
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
          Creating and updating tasks in a Google Tasks list inside your own
          connected Google account, so that a scheduling tool which syncs from
          that list can find them and book time for them. What is written is a
          task title (built from your task and step text, with a duration), a
          due date, and a <strong>notes field</strong> containing any note you
          wrote on that task or step, a short prompt line, and a link back into
          the focus timer. So if you write a note and schedule the step to
          Google, that note is copied into your Google Tasks list.
        </p>
        <p>
          The only thing <em>read</em> from your Google account is the list of
          your Google Tasks list names, so the right list can be found to write
          into. Nothing from your Google account is copied into dlectroflow
          beyond the list and task identifiers needed to update the right task
          later.
        </p>

        <LegalSubheading>
          Google data and the AI provider — they never meet
        </LegalSubheading>
        <p>
          dlectroflow uses an AI model to break tasks into steps, and it uses
          Google Tasks to schedule them. Those two things never touch, and that
          is a property of how the connection is built rather than a rule
          somebody has to remember to follow.
        </p>
        <p>
          <strong>
            Nothing from your Google account is ever sent to the AI provider.
          </strong>{" "}
          The Google connection only ever <em>writes</em>: it creates and
          updates tasks in your list. The one thing it reads is the names of
          your task lists, so it knows which list to write into — and a list
          name is not something the breakdown coach is given, because the coach
          is only ever given the text you typed here plus counts and dates. Put
          plainly, there is no path by which Google data could reach the model,
          because no Google data is held here to send.
        </p>
        <p>
          It follows that nothing from your Google account is used to train,
          improve or evaluate any AI model, by me or by anyone else. Anthropic,
          the provider this instance uses, does not train on what is sent
          through its API either — see{" "}
          <Link href={`#${s("ai").id}`} className="underline">
            Sending your text to an AI provider
          </Link>{" "}
          for what does get sent, and what happens to it.
        </p>
        <p>
          Google requires an explicit statement of this, so here it is in
          Google&rsquo;s own words:
        </p>
        {/* Deliberately NOT `text-muted-foreground italic`, the house style for
            an aside. This is the one sentence a Google reviewer is looking for,
            and it is a formal undertaking rather than a footnote — full-contrast
            body text at normal weight-plus keeps it prominent and keeps the
            contrast ratio at the AA figure the rest of the page holds. */}
        <blockquote className="border-border border-l-2 pl-4 font-medium">
          The use of raw or derived user data received from Workspace APIs will
          adhere to the Google User Data Policy, including the Limited Use
          requirements.
        </blockquote>

        <LegalSubheading>
          Whose Google account it goes into — yours
        </LegalSubheading>
        <p>
          If you have an account here, you can connect <strong>your own</strong>{" "}
          Google account, and the tasks dlectroflow creates are written into{" "}
          <strong>your</strong> Google Tasks. Not the administrator&rsquo;s, and
          not a shared one. Everyone who connects Google connects their own:
          there is one connection per person, each independent of the others,
          and each connected and disconnected by the person it belongs to.
        </p>
        <p>
          <strong>
            Your connection is not visible or usable to anyone else — including
            me, as the person who administers this instance.
          </strong>{" "}
          The stored credential is held against your account and can only ever
          be looked up by the account it belongs to. There is no administrative
          route to somebody else&rsquo;s Google connection: the admin panel
          cannot use it, cannot show it, and does not even disclose whether you
          have one. That is not a promise I am asking you to take on trust — an
          automated check reads the source on every change and fails the build
          if any query for a stored credential is not tied to the account making
          the request.
        </p>
        <p>
          <strong>Guests cannot connect Google.</strong> It needs an account,
          because the connection has to belong to somebody.
        </p>

        <LegalSubheading>Tokens, and how to disconnect</LegalSubheading>
        <p>
          The access and refresh tokens are{" "}
          <strong>encrypted at rest using AES-256-GCM</strong>. The encryption
          key is held in the deployment&rsquo;s secrets, not in the database, so
          a copy of the database on its own yields no usable tokens.
        </p>
        <p>
          <strong>Disconnecting in Settings</strong> asks Google to revoke the
          grant and then deletes your stored tokens — the deletion happens
          whether or not Google&rsquo;s revoke call succeeds, so dead tokens are
          never left lying around.
        </p>
        <p>
          <strong>The same happens if your access here is withdrawn.</strong> If
          your account is <em>frozen</em> by the administrator, or it is{" "}
          <em>deleted</em>, dlectroflow asks Google to revoke the grant first
          and then deletes the stored tokens — the same two steps, without you
          having to ask for them. That is a deliberate choice: the grant only
          ever existed so this app could write your tasks, and a frozen account
          can no longer reach the Disconnect button, so leaving the grant live
          would hand you a permission you could not withdraw here any more.
          Nothing in your Google account is deleted by this. What ends is
          dlectroflow&rsquo;s access to it.
        </p>
        <p>
          <strong>Being straight about the limits of that.</strong> Revoking is
          a call to Google, and that call can fail — a network problem, or a
          grant Google has already expired. When it does, your tokens are still
          deleted at this end, so the app is left with no way to try again and
          the grant can stay listed in your Google account until you clear it.
          The same is true of any connection that was frozen or deleted before
          this behaviour existed.
        </p>
        <p>
          So the route that always works, and the one that does not depend on me
          at all, is your own{" "}
          <strong>Google account&rsquo;s security settings</strong>: you can
          withdraw dlectroflow&rsquo;s access there at any time, and it takes
          effect immediately whatever is or is not stored at this end.
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
            <strong>Whichever calendar app you subscribe from</strong> — only if
            you create a calendar subscription URL and paste it somewhere. That
            app then fetches your scheduled step titles and times on its own
            schedule, and stores them wherever it stores calendars, which for
            Google Calendar, iCloud or Outlook means that company&rsquo;s
            servers and quite possibly outside the UK. It is not my processor
            and I have no contract with it: you chose it and it is yours. What
            the feed carries is titles and times and nothing else — no notes, no
            coaching conversations, nothing about your account. Anyone holding
            the URL can read it without signing in, which is why the page you
            copy it from says so and why you can regenerate it at any time,
            invalidating the old one immediately.
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
            {/* #153 — deleting your own account reaches exactly the same state
                the owner's Revoke reaches (both go through `freezeAccount`), so
                the sentence below covers both and is not weakened for the new
                control.

                Rewritten because the previous version said the freeze "marks
                its content to be removed 30 days later", which read as a
                countdown and is not one. `freezeAccount` writes
                `User.purgeAfter` and NOTHING reads it: `prisma/scheduled-purge
                .ts` sweeps guest workspaces and guest counters only, and
                `deleteAccount` has no caller outside its own tests. The old
                text then contradicted itself two sentences later by conceding
                a revoked account is not deleted automatically — so the bullet
                described both an automatic purge and the absence of one. It now
                describes only what runs. #159 is the code half and this text
                changes when that ships, not before. */}
            <strong>Account data</strong> is kept for as long as you have an
            account, and until you ask for it to go. Deleting your own account,
            or having your access revoked, freezes it straight away: you are
            signed out, your Google connection here ends, and nothing can be
            written under it again.{" "}
            <strong>
              Being honest about what happens next: the content is not deleted
              automatically.
            </strong>{" "}
            There is a 30-day recovery window recorded against the account, but
            no job acts on it — the deletion is done by hand, by me, when you
            ask. Email me and it will be done. That is true whether you deleted
            the account yourself or I revoked it.
          </li>
          <li>
            <strong>Google tokens</strong> are kept until you disconnect, until
            your access here is revoked or your account is deleted, or until the
            grant is revoked at Google&rsquo;s end — at which point they are
            cleared.
          </li>
          <li>
            <strong>A calendar subscription URL</strong> is kept until you turn
            the feed off or your account is deleted. Regenerating replaces the
            token, and the old URL stops working on the next request rather than
            at some later expiry. Turning the feed off removes the row
            altogether. The copies of the address in the web server&rsquo;s
            access logs age out with those logs, after 30 days. Note what I
            cannot delete: anything your calendar app has already copied into
            its own storage is that app&rsquo;s to remove, not mine.
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
            <code>df_guest</code> — identifies your guest sandbox so the app can
            show you your own work. Without it an anonymous visitor has no
            workspace and the app cannot function. <em>About a day.</em>
          </li>
          <li>
            <code>df_owner</code> — your signed-in session.{" "}
            <em>30 days, or until you sign out.</em>
          </li>
          <li>
            <code>gitlab_oauth_state</code> and{" "}
            <code>gitlab_pkce_verifier</code> — protect the GitLab sign-in round
            trip against request forgery and code interception. Deleted the
            moment sign-in finishes. <em>10 minutes.</em>
          </li>
          <li>
            <code>google_oauth_state</code> and{" "}
            <code>google_pkce_verifier</code> — the same protection for
            connecting Google Tasks. <em>10 minutes.</em>
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
          Separately, your theme choice &mdash; follow my system, light or dark
          &mdash; is stored in your browser&rsquo;s own local storage under{" "}
          <code>df-theme</code>. It never leaves your device and is never sent
          to the server.
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
          There is no health field, no diagnosis field and no questionnaire, and
          nothing here asks you how you are.{" "}
          <strong>
            One thing comes close and is worth naming rather than glossing:
          </strong>{" "}
          at the end of your working day a short narrative about that day is
          written from your own counts — how many steps you finished, how long
          you focused, your streak — and stored with that day&rsquo;s roll-up.
          It is a friendly summary of what you did, written for you and for
          nobody else — it appears on your own dashboard, and, only if you
          switch the round-up email on, in that email, which means the email
          provider named in{" "}
          <Link href={`#${s("recipients").id}`} className="underline">
            Who else is involved
          </Link>{" "}
          handles it on the way to your inbox. It is not an assessment of your
          health or your state of mind, and nothing acts on it. Beyond that, it
          is a to-do app with a kind tone. Plenty of people use it who have
          never been near an assessment.
        </p>
        <p>
          What I cannot control is what you type into a free-text box. If you
          write &ldquo;phone the psychiatrist about the dose change&rdquo;, that
          is health information, and it is treated exactly like every other
          task: stored, and sent to the AI provider if you ask for a breakdown
          of it.
        </p>
        {/* This paragraph claimed "explicit consent — Article 9(2)(a) UK GDPR"
            until this revision, and there was nothing behind it. Grepping the
            source for a consent gate, an acknowledgement or a warning on any
            free-text surface returns only this page's own prose: no field asks
            for health data, so nothing ever asked for permission to hold it,
            so there was no consent to be explicit about. Art. 9(2)(a) requires
            consent that was actually sought.

            The owner's decision (2026-08-15) was to state the true position
            rather than build a consent mechanism — a modal on the note box
            would be a dark pattern in the shape of compliance, and would make
            the app worse at the one thing it exists to do. So this text claims
            no Art. 9 condition. Do not reintroduce one, and do not add a
            consent gate to make the old sentence true; the two would then have
            to be kept in step forever.

            The voice is borrowed deliberately from the breakdown's lawful-basis
            bullet in "My lawful basis for each purpose", which already refuses
            to relabel a necessity as consent. Same refusal, same reason. */}
        <p>
          <strong>And I am not going to call that consent.</strong> Nothing here
          asks you for health information: there is no field for it, no question
          that invites it, and nothing that goes looking for it in what you
          write. What arrives is whatever you decided to put in a box you were
          using for something else. Calling that explicit consent would be the
          same dressing-up this page refuses a few sections earlier — I never
          asked you, and consent nobody sought is not consent. So what I hold is
          held for one reason only: it is an unavoidable part of doing the thing
          you directed me to do with the words you typed — keep them, show them
          back to you, break them into steps if you press the button, and put
          them on your calendar or into your Google Tasks list if you ask for
          that. Nothing else is done with it, and you can delete the item
          yourself at any time, or ask me to.
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
            {/* #129 — Art. 12(2) again: the control is named because a control
                you can reach yourself is a stronger facilitation than an email
                to a human. Worded as what it DOES, so it cannot come to
                disagree with the archive's own README. */}
            <strong>Access</strong> — a copy of the personal data I hold about
            you, and confirmation of how it is used.{" "}
            <strong>Settings → Account → Export your data</strong> downloads it,
            straight away, without asking me.
          </li>
          <li>
            <strong>Rectification</strong> — correction of anything inaccurate
            or incomplete. Most of it you can edit yourself in the app.
          </li>
          <li>
            {/* #153 — Art. 12(2) asks me to facilitate the exercise of these
                rights, and "email a human" is a weaker facilitation than a
                control you can reach yourself. So the control is named here.
                It is described as what it DOES — sign you out, end the Google
                connection, start the window — rather than as an instant
                erasure, because the retention list above is what governs what
                happens next and the two must not disagree. */}
            <strong>Erasure</strong> — deletion of your data. If you have an
            account, <strong>Settings → Account → Delete my account</strong>{" "}
            starts it: you are signed out, your Google connection here ends, and
            the 30-day recovery window described above begins. Removing the
            content itself is a hand operation, so ask and it goes. The instance
            owner&rsquo;s own account is the exception — it is the only one that
            can administer the instance, so it cannot be deleted from the app.
          </li>
          <li>
            <strong>Restriction</strong> — you can ask me to stop using your
            data while a dispute about its accuracy or my basis for holding it
            is sorted out.
          </li>
          <li>
            <strong>Portability</strong> — your data in a structured,
            machine-readable form. The same export gives you one .zip holding
            your tasks and their steps, your brain-dump inbox, the coaching
            conversations, your settings, your scheduled work as a calendar
            file, and a lossless JSON copy of all of it. A README inside
            explains each file and says what is deliberately not there. Ask
            instead if you would rather, or if you want another format.
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
        {/* #129 — this paragraph said the opposite until the export shipped
            ("there is no self-service export button yet"), which was the honest
            thing to publish at the time and would be a false statement now. The
            omission is named here as well as in the archive's own README: a
            reader who never opens the zip must not assume their Google
            connection travelled with it. */}
        <p>
          <strong>Access and portability you can do yourself.</strong>{" "}
          <strong>Settings → Account → Export your data</strong> downloads
          everything this app holds about your account, in formats that open
          with no special software. Some things are deliberately left out.{" "}
          <strong>Two are credentials</strong>: the OAuth tokens for your Google
          connection, and any LLM API key you have stored — putting a copy of
          either in a file you might forward to somebody would be the opposite
          of protecting your data.{" "}
          <strong>The rest is account bookkeeping</strong> rather than content:
          your invitation record and any note whoever invited you wrote on it,
          your AI usage count, the timestamps on your calendar feed, the
          internal flags saying whether your account is active or revoked, when
          it was last seen and when access was withdrawn if it ever was, and the
          account id GitLab issued for you — as distinct from your username and
          the provider&rsquo;s name, both of which the export does include. Ask
          at <ContactLink /> and I will send any of it by hand — the invitation
          note included, since it is about you.
        </p>
        {/* #153 — erasure came off that list, so this paragraph had to stop
            saying it was on it. The caveat is not a hedge: the control freezes
            the account, and removing the content is a hand operation.

            Reworded here because the previous version said the content is
            removed "before that window is up", which implies something happens
            WHEN it is up. Nothing does — see the account-data bullet in "How
            long I keep it": `purgeAfter` is written and read by nothing. A
            reader who waited 30 days expecting the content to go would have
            been misled by a page that never actually promised it, which is the
            worst version of this: technically silent, practically a promise. */}
        <p>
          <strong>Erasure you can start yourself.</strong>{" "}
          <strong>Settings → Account → Delete my account</strong> ends your
          access straight away and starts a 30-day recovery window, so an
          accident can be undone. It does not delete the content — that step is
          done by hand today, not by a scheduled job, and it does not happen on
          its own when the window is up. So if you want the content gone, email
          me and say so. I will do it and confirm.
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
          expire and be deleted on its own within about a day.{" "}
          {/* #129 — the export needs no identity, only the sandbox's own signed
              session, so it is the one right a guest can exercise in full. Worth
              saying here rather than only in Settings: this paragraph is where
              somebody goes to find out what a sandbox cannot do. */}
          <strong>The export is the exception</strong> — it works in a sandbox
          exactly as it does for an account, and it is the only way anything you
          did in one outlives it. To be rid of it sooner, clear the{" "}
          <code>df_guest</code> cookie or use a private window. If you want it
          deleted now and can read the sandbox identifier out of that cookie in
          your browser&rsquo;s developer tools, send it to me and I will delete
          it.
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
