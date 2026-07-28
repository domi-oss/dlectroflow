"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  invitePerson,
  withdrawInvitation,
  updatePersonAiPolicy,
  revokePerson,
  type PeopleActionResult,
} from "@/app/actions/people";
import type { InvitationView, PeopleAdminView, PersonView } from "@/lib/people";
import { AiPolicy, UserRole, UserStatus } from "@/lib/constants";
import { formatAgo } from "@/lib/format";
import { type Voice } from "@/lib/strings";
import { SectionHeading } from "@/components/nav/section-heading";
import { cn } from "@/lib/utils";

/**
 * #35 Phase B — the owner-only People panel.
 *
 * What it deliberately CANNOT do is as much of the design as what it can: there
 * is no way to open anyone's workspace, no "view as user", and the encrypted LLM
 * key shows as a yes/no word because `loadPeopleAdmin` never loads the ciphertext
 * in the first place. Everything on screen is a number or a status.
 *
 * Two presentation rules come straight out of the enforcement code, so the screen
 * can never tell the owner something the breakdown route would contradict:
 *
 *  • A PRESENT KEY WINS. Someone with their own key is billed to that key
 *    whatever their policy says, so their row reads "billed to their own key"
 *    and shows no meter.
 *  • UNCAPPED IS NOT A QUOTA. The instance owner's own account is uncapped by
 *    design, so "0 / 50" would be a number that means nothing. The quota field is
 *    disabled while the policy is uncapped, for the same reason.
 *
 * `now` comes from the server render (the convention library-row-meta.tsx
 * follows) so "2h ago" is computed from one timestamp on both sides of hydration.
 */

/** The policy picker's options, in the order the design describes them. */
const POLICY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: AiPolicy.Uncapped, label: "Uncapped — the instance pays, no limit" },
  {
    value: AiPolicy.Capped,
    label: "Capped — the instance pays, up to a quota",
  },
  {
    value: AiPolicy.OwnKey,
    label: "Own key — they bring and pay for their own",
  },
];

/** Plain-language outcomes. An error the owner cannot read is not a report. */
const ERROR_COPY: Record<
  Extract<PeopleActionResult, { ok: false }>["error"],
  string
> = {
  not_allowed: "Only the instance owner can manage people.",
  invalid_identity: "Enter a username or an email address.",
  already_invited: "That identity is already invited.",
  invalid_policy: "That is not a policy this instance recognises.",
  not_found: "That account no longer exists — reload the page.",
  cannot_revoke_self:
    "You cannot revoke your own account — you are the only person who can manage this instance.",
};

type Message = { tone: "ok" | "error"; text: string } | null;

/** Human sentence for a window length, so a bare count has a unit. */
function windowLabel(hours: number): string {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? "rolling 24 hours" : `rolling ${days} days`;
  }
  return `rolling ${hours} hours`;
}

/**
 * How this account's AI is paid for, as one phrase.
 *
 * Mirrors `consumeUserBreakdown`'s resolution order exactly — key first, then
 * uncapped, then the enforced meter — so the panel and enforcement cannot
 * disagree about who is paying or what is being counted.
 *
 * The `uncapped` phrasing is a deliberate product decision (owner, !175): a
 * REAL COUNT with NO DENOMINATOR. "142 used this window" reads as information;
 * "142 / 50" reads as somebody who has blown through a limit that does not
 * apply to them. Uncapped accounts are metered — they simply cannot be refused.
 *
 * `policy` is passed in rather than read off `p` so the caller can hand it the
 * PENDING selection: the dropdown, the quota field's disabled state and this
 * phrase must all describe the same policy, or the card contradicts itself
 * mid-edit (Duo review on !175 — it did).
 */
function allowanceLabel(p: PersonView, policy: string): string {
  if (p.hasOwnKey) return "Billed to their own key — not metered";
  if (policy === AiPolicy.Uncapped) {
    return `${p.usage.used} used this window — uncapped, never blocked`;
  }
  return `${p.usage.used} / ${p.usage.quota} breakdowns used`;
}

function StatusPill({ status }: { status: string }) {
  const revoked = status === UserStatus.Revoked;
  return (
    <span
      // Status is a WORD, never colour alone (WCAG 1.4.1).
      className={cn(
        "rounded-full px-2.5 py-0.5 text-xs font-medium",
        revoked
          ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"
          : "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200",
      )}
    >
      {revoked ? "Revoked" : "Active"}
    </span>
  );
}

/** One account's card: the facts, then the two controls that may change them. */
function PersonCard({
  person,
  now,
  onResult,
  disabled,
}: {
  person: PersonView;
  now: number;
  onResult: (m: Message) => void;
  disabled: boolean;
}) {
  const [aiPolicy, setAiPolicy] = useState(person.aiPolicy);
  const [aiQuota, setAiQuota] = useState(String(person.usage.quota));
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const busy = disabled || pending;

  const run = (
    action: () => Promise<PeopleActionResult>,
    okText: string,
  ): void => {
    startTransition(async () => {
      try {
        const res = await action();
        onResult(
          res.ok
            ? { tone: "ok", text: okText }
            : { tone: "error", text: ERROR_COPY[res.error] },
        );
        if (res.ok) router.refresh();
      } catch {
        onResult({
          tone: "error",
          text: "That did not save. Check your connection and try again.",
        });
      }
    });
  };

  // Two different questions, and conflating them is what !175's owner decision
  // untangled:
  //   • METERED — is usage counted? True for everyone the instance pays for,
  //     capped or uncapped. Only a present key opts out (their key, their bill).
  //     This drives the window line, because a recorded count needs a window.
  //   • ENFORCED — can this account be refused? Only when a quota applies. This
  //     drives the quota field, because a quota nothing consults is a dead input.
  // Both derive from the LOCAL `aiPolicy` state — the pending selection — and the
  // same value feeds allowanceLabel, so the phrase, the window line and the quota
  // field are three views of ONE state and cannot drift apart.
  const metered = !person.hasOwnKey;
  const enforced = metered && aiPolicy !== AiPolicy.Uncapped;

  return (
    <li
      data-person-label={person.label}
      className="space-y-3 rounded-lg border p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{person.label}</p>
        <span className="text-muted-foreground text-xs">{person.provider}</span>
        {person.role === UserRole.Owner && (
          <span className="border-input rounded-full border px-2 py-0.5 text-xs font-medium">
            Owner
          </span>
        )}
        <StatusPill status={person.status} />
      </div>

      <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt>Last seen</dt>
        <dd>
          <time dateTime={new Date(person.lastSeenAt).toISOString()}>
            {formatAgo(now - new Date(person.lastSeenAt).getTime())}
          </time>
        </dd>
        <dt>AI</dt>
        <dd>{allowanceLabel(person, aiPolicy)}</dd>
        <dt>Own key</dt>
        <dd>{person.hasOwnKey ? "Own key set" : "No own key"}</dd>
        {metered && person.usage.windowStartedAt && (
          <>
            {/* When THIS person's window started, so the owner can see when their
                allowance renews. The length itself is stated once, in the intro. */}
            <dt>Window began</dt>
            <dd>
              <time
                dateTime={new Date(person.usage.windowStartedAt).toISOString()}
              >
                {formatAgo(
                  now - new Date(person.usage.windowStartedAt).getTime(),
                )}
              </time>
            </dd>
          </>
        )}
      </dl>

      <div className="flex flex-wrap items-end gap-3">
        {/* Each control's accessible name names the PERSON, so a screen-reader
            user tabbing a long list always knows whose allowance they are on.
            The visible text is the short form and is contained in the accessible
            name, which is what WCAG 2.5.3 (Label in Name) asks for. */}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground text-xs">AI policy</span>
          <select
            aria-label={`AI policy for ${person.label}`}
            className="min-h-11 rounded-md border px-2"
            value={aiPolicy}
            disabled={busy}
            onChange={(e) => setAiPolicy(e.target.value)}
          >
            {POLICY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground text-xs">Quota</span>
          <input
            type="number"
            min={0}
            max={10000}
            step={1}
            aria-label={`Quota for ${person.label}`}
            className="min-h-11 w-24 rounded-md border px-2"
            value={aiQuota}
            // A quota changes nothing unless it is ENFORCED, so the field is
            // disabled rather than silently accepting a dead number. Note this
            // is `enforced`, not `metered`: an uncapped account IS counted, and
            // its quota still means nothing.
            disabled={busy || !enforced}
            onChange={(e) => setAiQuota(e.target.value)}
          />
        </label>

        <button
          type="button"
          aria-label={`Save ${person.label}`}
          className="bg-primary text-primary-foreground min-h-11 rounded-md px-3 text-sm font-medium disabled:opacity-50"
          disabled={busy}
          onClick={() =>
            run(
              () =>
                updatePersonAiPolicy({
                  userId: person.id,
                  aiPolicy,
                  aiQuota: Number(aiQuota),
                }),
              `Saved ${person.label}'s AI policy.`,
            )
          }
        >
          Save
        </button>
      </div>

      {person.isSelf ? (
        <p className="text-muted-foreground text-sm">
          This is you — the instance owner cannot revoke their own account.
        </p>
      ) : person.status === UserStatus.Revoked ? (
        <p className="text-muted-foreground text-sm">
          Access removed. Their data is deleted 30 days after revocation.
        </p>
      ) : !confirming ? (
        <button
          type="button"
          aria-label={`Revoke ${person.label}`}
          className="text-destructive min-h-11 rounded-md border px-3 text-sm font-medium disabled:opacity-50"
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          Revoke
        </button>
      ) : (
        <div className="space-y-2">
          <p className="text-sm">
            {`Remove ${person.label}'s access? They lose the ability to sign in immediately. Their data is kept for 30 days, then deleted.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-label={`Yes, revoke ${person.label}`}
              className="bg-destructive text-destructive-foreground min-h-11 rounded-md px-3 text-sm font-medium disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                run(
                  () => revokePerson(person.id),
                  `Revoked ${person.label}'s access.`,
                );
              }}
            >
              Yes, revoke
            </button>
            <button
              type="button"
              className="min-h-11 rounded-md border px-3 text-sm"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function InvitationRow({
  invitation,
  now,
  onResult,
  disabled,
}: {
  invitation: InvitationView;
  now: number;
  onResult: (m: Message) => void;
  disabled: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
      <span className="font-medium">{invitation.identity}</span>
      <span className="text-muted-foreground text-xs">
        {invitation.provider}
      </span>
      <span className="text-muted-foreground text-xs">
        invited{" "}
        <time dateTime={new Date(invitation.invitedAt).toISOString()}>
          {formatAgo(now - new Date(invitation.invitedAt).getTime())}
        </time>
      </span>
      {invitation.note && (
        <span className="text-muted-foreground text-xs">
          — {invitation.note}
        </span>
      )}
      <span className="bg-muted text-muted-foreground rounded-full px-2.5 py-0.5 text-xs font-medium">
        {invitation.claimed ? "Claimed" : "Pending"}
      </span>
      {/* A CLAIMED invitation is the record of how an account got in; removing
          somebody who actually joined is Revoke, on their account's card. */}
      {!invitation.claimed && (
        <button
          type="button"
          aria-label={`Withdraw the invitation for ${invitation.identity}`}
          className="text-destructive ml-auto min-h-11 rounded-md border px-3 text-sm font-medium disabled:opacity-50"
          disabled={disabled || pending}
          onClick={() =>
            startTransition(async () => {
              const res = await withdrawInvitation(invitation.id);
              onResult(
                res.ok
                  ? { tone: "ok", text: "Invitation withdrawn." }
                  : { tone: "error", text: ERROR_COPY[res.error] },
              );
              if (res.ok) router.refresh();
            })
          }
        >
          Withdraw
        </button>
      )}
    </li>
  );
}

export function PeoplePanel({
  view,
  now,
  voice,
}: {
  view: PeopleAdminView;
  /** Server-render timestamp, so relative times survive hydration. */
  now: number;
  voice: Voice;
}) {
  const router = useRouter();
  const [identity, setIdentity] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();

  const submitInvite = (e: React.FormEvent) => {
    e.preventDefault();
    // The action validates too; this only saves a round trip that would report
    // an error the person can already see is their own blank field.
    if (!identity.trim()) return;
    startTransition(async () => {
      // Trim once and use that value for BOTH the request and the report. The
      // action trims server-side too, but sending the raw string while reporting
      // the trimmed one meant the two disagreed about what was invited (Duo
      // review on !175).
      const typed = identity.trim();
      const res = await invitePerson({
        identity: typed,
        note: note.trim() || undefined,
      });
      if (res.ok) {
        setMessage({ tone: "ok", text: `Invited ${typed}.` });
        setIdentity("");
        setNote("");
        router.refresh();
      } else {
        setMessage({ tone: "error", text: ERROR_COPY[res.error] });
      }
    });
  };

  return (
    <section className="space-y-3">
      <SectionHeading id="settings-people" voice={voice} />

      {/* The interpolated half of this sentence is ONE JS string, deliberately.
          Written as JSX text around `{windowLabel(…)}` it rendered as
          "rolling 30 dayswindow" in the production build: the space sat at the
          start of a JSX line right after the expression, and this Next version's
          JSX transform trimmed it (AGENTS.md — "This is NOT the Next.js you
          know"). vitest's transform does NOT trim it, so the jsdom suite showed
          the sentence intact while the built page was wrong. Keeping every
          interpolation-adjacent space inside a string removes the disagreement. */}
      <p className="text-muted-foreground text-sm">
        {`Who can use this instance, and what their AI costs. You see usage numbers and account status only — never anyone’s tasks, notes or other content. Allowances are measured over a ${windowLabel(
          view.windowHours,
        )} window that starts at each person’s first breakdown.`}
      </p>

      {/* ONE shared live region for every action on the panel — two
          simultaneous announcements would talk over each other. */}
      {message && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={cn(
            "text-sm",
            message.tone === "error"
              ? "text-red-700 dark:text-red-400"
              : "text-green-700 dark:text-green-400",
          )}
        >
          {message.text}
        </p>
      )}

      <form onSubmit={submitInvite} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground text-xs">
            Invite a username or email
          </span>
          <input
            type="text"
            aria-label="Invite a username or email"
            className="min-h-11 rounded-md border px-2"
            value={identity}
            disabled={pending}
            onChange={(e) => setIdentity(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground text-xs">Note (optional)</span>
          <input
            type="text"
            aria-label="Note (optional)"
            className="min-h-11 rounded-md border px-2"
            value={note}
            disabled={pending}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className="bg-primary text-primary-foreground min-h-11 rounded-md px-3 text-sm font-medium disabled:opacity-50"
          disabled={pending}
        >
          Send invitation
        </button>
      </form>

      <h3 className="text-sm font-semibold" id="people-invitations-heading">
        Invitations
      </h3>
      {view.invitations.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No invitations yet. Invite someone above to let them sign in.
        </p>
      ) : (
        <ul
          aria-labelledby="people-invitations-heading"
          className="list-none space-y-2 pl-0"
        >
          {view.invitations.map((invitation) => (
            <InvitationRow
              key={invitation.id}
              invitation={invitation}
              now={now}
              onResult={setMessage}
              disabled={pending}
            />
          ))}
        </ul>
      )}

      <h3 className="text-sm font-semibold" id="people-accounts-heading">
        Accounts
      </h3>
      <ul
        aria-labelledby="people-accounts-heading"
        className="list-none space-y-2 pl-0"
      >
        {view.people.map((person) => (
          <PersonCard
            key={person.id}
            person={person}
            now={now}
            onResult={setMessage}
            disabled={pending}
          />
        ))}
      </ul>
    </section>
  );
}
