import { UserRole } from "@/lib/constants";
import { t, type Voice } from "@/lib/strings";

/**
 * #100 — how an account is DESCRIBED to the person signed in as it.
 *
 * Everything here is pure and display-only, deliberately: the values come from
 * the server-resolved session (`currentUser()`, which verifies the signed cookie
 * and re-reads the row) and then cross into a client component, so this module is
 * the boundary that decides what is allowed to make that crossing.
 *
 * Three fields, and the list is asserted in identity.test.ts so it cannot widen
 * by accident:
 *
 *  • `label` — the provider handle, else a short account id. NEVER the email.
 *    Same rule the People panel has always used (it is the same function now),
 *    so the two surfaces cannot disagree about what an account is called.
 *  • `provider` — display-named, because #74 requires the provider to be stated
 *    wherever identity is shown. That decision (one login = one account = one
 *    workspace, account linking permanently out of scope) means signing in with
 *    the wrong provider produces an empty workspace that looks exactly like data
 *    loss, so "which provider is this?" must be answerable without guessing.
 *  • `role` — because owner and member are two of the three states the header
 *    has to read sensibly in, and it is the honest reason a member's Settings
 *    page is shorter than the owner's.
 *
 * NOT here, on purpose: the account id (the caller already knows who they are,
 * and the fallback label is the only reason 8 characters of it are shown at all)
 * and the email. `people.ts` states the email rule for the owner-facing panel;
 * the same reasoning applies to a header, which is read over shoulders and on
 * shared screens, and an email adds no disambiguation that the handle and the
 * provider have not already provided.
 */
export type AccountIdentity = {
  label: string;
  provider: string;
  role: UserRole;
};

/**
 * What to call an account on screen: its provider handle, else a short id.
 *
 * The fallback exists because `AuthProfile.username` is optional — a provider may
 * withhold it — and a blank name in the header is precisely the "did I lose
 * everything?" ambiguity #100 removes. It is a prefix of the account id because
 * that is the only stable identifier left when there is no handle.
 */
export function accountLabel(user: {
  id: string;
  handle: string | null;
}): string {
  return user.handle ?? `#${user.id.slice(0, 8)}`;
}

/**
 * Provider display names. Keyed on the `User.provider` column's values, which
 * are whatever `AUTH_PROVIDER` was set to at provisioning time (#74 turns that
 * into a list; nothing here has to change when it does).
 */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  gitlab: "GitLab",
  github: "GitHub",
  google: "Google",
};

/**
 * "gitlab" → "GitLab". An unrecognised provider is returned VERBATIM rather than
 * blanked or title-cased: a self-hoster's own provider name is still the honest
 * answer to "which provider am I signed in with?", and a guess would be worse
 * than the raw value.
 */
export function providerDisplayName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

/** The role, as a word. `UserRole` is a closed union, so this is exhaustive. */
export function roleWord(role: UserRole): string {
  return role === UserRole.Owner ? "Owner" : "Member";
}

/**
 * Build the display identity from the server-resolved account.
 *
 * Structurally typed rather than taking `CurrentUser`, so this module stays free
 * of the session/database layer and can be imported by a client component for
 * its types.
 */
export function identityFor(user: {
  id: string;
  handle: string | null;
  provider: string;
  role: UserRole;
}): AccountIdentity {
  return {
    label: accountLabel(user),
    provider: providerDisplayName(user.provider),
    role: user.role,
  };
}

/**
 * The one line that answers "which account is this?" — role and provider.
 *
 * Composed here, as a single JS string, rather than as JSX text around two
 * expressions. This Next version's JSX transform trims a space that sits at the
 * start of a line immediately after an interpolation, and vitest's transform does
 * not: people-panel.tsx shipped "rolling 30 dayswindow" to the production build
 * with a green unit suite. A tested pure function has no such disagreement.
 */
export function identityLine(identity: AccountIdentity): string {
  return `${roleWord(identity.role)} · signed in with ${identity.provider}`;
}

/**
 * #111 — the empty inbox of an account that has NEVER held anything.
 *
 * The header half of #100 put "which account is this?" one click away on every
 * page. This is the other half of the same obligation: the moment the question
 * gets asked is when the screen is blank, and a blank screen that says "Inbox
 * zero" is telling a brand-new account that something it never had is gone.
 *
 * WHY THE PROVIDER IS HERE, and not just the handle (the open question on #111).
 * The failure this copy exists for is signing in with the SECOND of two provider
 * accounts: one login = one account = one workspace, account linking is out of
 * scope, so the wrong provider yields an empty workspace that is indistinguishable
 * from data loss. The provider is the fact that resolves it. The header popover
 * does carry it — but behind a click you only make once you already suspect what
 * happened, and this sentence is what has to produce the suspicion. Redundancy
 * that costs six words is the right trade against a user concluding their data is
 * gone. The ROLE is deliberately left out: it answers "what may I do here?", not
 * "whose workspace is this?", and the popover is the right home for it.
 *
 * One JS string, for the reason identityLine() states: a voiced lead plus two
 * interpolations is exactly the shape whose spaces this Next version's JSX
 * transform trims and vitest's does not.
 */
export function newAccountLine(
  identity: AccountIdentity,
  voice: Voice,
): string {
  return `${t("inbox.newAccount", voice)} (${identity.label}, signed in with ${identity.provider})`;
}
