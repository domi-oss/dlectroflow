"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/workspace";
import { encryptToken } from "@/lib/crypto/token-cipher";
import { freezeAccount } from "@/lib/account-lifecycle";
import { OWNER_COOKIE } from "@/lib/auth/session";
import { UserRole } from "@/lib/constants";
import { configuredProvider } from "@/lib/llm/configured-provider";
import { detectForeignProviderKey } from "@/lib/llm/key-shape";

/**
 * #35 Phase C (#118) — the caller's OWN account settings.
 *
 * Phase B built the entire read side of the per-user LLM key: getLLM(creds)
 * takes a per-request credential, user-quota.ts decrypts `llmKeyEnc`, and a
 * present key short-circuits policy and metering. Nothing wrote the column.
 * This is the writer, and it is deliberately the narrowest one possible.
 *
 * Three rules hold it up:
 *
 *  1. NO ID PARAMETER. Every write is `where: { id: me.id }`, resolved from the
 *     session by currentUser(). There is nothing for a caller to point at
 *     somebody else's row — a server action is a public POST endpoint, so this
 *     is the only shape that is safe by construction rather than by review.
 *  2. THE CIPHERTEXT IS NEVER READ BACK. The panel is told a boolean. A "reveal
 *     my key" affordance would put a decrypted secret in an RSC payload for the
 *     convenience of confirming something the user already knows.
 *  3. IT WRITES ONE COLUMN. Not aiPolicy, not aiQuota, not llmProvider, not
 *     role or status. A present key already lifts the cap (see
 *     consumeUserBreakdown's resolution order — "capped until you bring your
 *     key" needs no policy change), and every other field on that list is one
 *     the OWNER administers from the People panel.
 *
 * src/lib/__tests__/scoping.harness.test.ts names this file in
 * KEY_CIPHERTEXT_FILES, which is the review conversation that list exists to
 * force.
 */

export type AccountActionResult =
  | { ok: true }
  | { ok: false; error: "not_signed_in" | "invalid_key" | "not_found" };

/**
 * #177 step 1 — `saveOwnLlmKey`'s outcomes, which are `AccountActionResult`
 * plus one the other actions cannot produce.
 *
 * `wrong_provider_key` is a code of its OWN rather than another `invalid_key`,
 * and it carries the three labels the panel needs to say something specific.
 * The generic code is what made the original bug survive contact with the UI:
 * "that key was not accepted" is exactly as actionable as the canned fallback
 * breakdown the member was already staring at.
 *
 * EVERY FIELD IS A FIXED LABEL from `key-shape.ts`'s table. Nothing derived
 * from the key travels back — the key decides which label, never what is in it.
 * That is the same rule as rule 2 above: this value crosses into a client
 * component, so a prefix echoed "to be helpful" would be a secret in an RSC
 * payload.
 *
 * A separate union for the same reason `DeleteAccountResult` is one: a panel
 * that has to handle impossible cases stops describing what can actually
 * happen.
 */
export type SaveKeyResult =
  | AccountActionResult
  | {
      ok: false;
      error: "wrong_provider_key";
      /** Provider whose format the pasted key unmistakably matches. */
      looksLike: string;
      /** Provider this instance is configured for. */
      expectedProvider: string;
      /** That provider's issued prefix, or null when it has no fixed one. */
      expectedPrefix: string | null;
    };

/**
 * #153 — the self-serve deletion's outcomes. A separate union from
 * `AccountActionResult` on purpose: `invalid_key` and `not_found` are not
 * reachable here, and a panel that has to handle impossible cases stops
 * describing what can actually happen.
 */
export type DeleteAccountResult =
  { ok: true } | { ok: false; error: "not_signed_in" | "owner_cannot_delete" };

/**
 * Longest key we will store. Anthropic and OpenAI-compatible keys are ~100–200
 * characters; 600 is generous headroom. The bound exists so a paste accident
 * cannot put an arbitrary blob through the cipher and into the column.
 */
const MAX_KEY_LENGTH = 600;

/**
 * Control characters, including newlines and tabs. This value ends up in an HTTP
 * Authorization header; a newline in it is a request-splitting shape.
 *
 * Written with explicit `\u` escapes rather than literal control characters: a
 * literal one is invisible in a diff, which is the last property you want in a
 * validation regex. Covers C0 (NUL-US) and DEL. The escapes are also why this
 * needs no `no-control-regex` disable — that rule fires on literal control
 * characters in the source, not on escaped ones.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

const NOT_SIGNED_IN = { ok: false, error: "not_signed_in" } as const;
const INVALID_KEY = { ok: false, error: "invalid_key" } as const;

export async function saveOwnLlmKey(apiKey: string): Promise<SaveKeyResult> {
  const me = await currentUser();
  if (!me) return NOT_SIGNED_IN;

  // Trimmed because a pasted key carries whitespace, and validated because an
  // encrypted "" decrypts to "" — falsy — so the account would fall silently
  // back onto the instance key while the UI reported a saved key.
  const key = apiKey.trim();
  if (!key || key.length > MAX_KEY_LENGTH || CONTROL_CHARS.test(key)) {
    return INVALID_KEY;
  }

  // #177 — the fourth guard, and the only one that is about the key's CONTENT
  // rather than its safety. Asymmetric by design: it refuses a key that
  // unmistakably belongs to another provider, and stays out of the way of one
  // it merely does not recognise. See key-shape.ts for why the reverse — a
  // conformance check — would be worse than the bug it fixes.
  //
  // The provider comes from the instance's `LLM_PROVIDER`, not the caller's
  // `User.llmProvider`: nothing in the app writes that column yet (#125 is the
  // feature), so null is the only value it holds and reading it would be
  // describing a choice nobody can make. When #125 lands, the expected provider
  // becomes `me.llmProvider ?? configuredProvider()` and this is the call site.
  const foreign = detectForeignProviderKey(key, configuredProvider());
  if (foreign) return { ok: false, error: "wrong_provider_key", ...foreign };

  try {
    await prisma.user.update({
      where: { id: me.id },
      data: { llmKeyEnc: encryptToken(key) },
    });
  } catch (err) {
    // P2025 = the row is gone (account deleted mid-request). Reported, not
    // thrown: the caller holds a verified session, so this is a real state.
    // Anything else rethrows — swallowing a database outage would report
    // "saved" for a key that was never stored.
    if ((err as { code?: string }).code === "P2025") {
      return { ok: false, error: "not_found" };
    }
    throw err;
  }

  revalidatePath("/settings");
  return { ok: true };
}

export async function removeOwnLlmKey(): Promise<AccountActionResult> {
  const me = await currentUser();
  if (!me) return NOT_SIGNED_IN;
  // updateMany, not update: removing a key that is not there is a no-op the
  // user should experience as success, not as a thrown RecordNotFound.
  await prisma.user.updateMany({
    where: { id: me.id },
    data: { llmKeyEnc: null },
  });
  revalidatePath("/settings");
  return { ok: true };
}

/**
 * Does the caller have their own key? Presence only.
 *
 * `select: { id: true }` with the presence test in the WHERE clause, exactly as
 * src/lib/people.ts does it — `select: { llmKeyEnc: true }` would pull an
 * encrypted secret into the object graph a component's props are built from,
 * one careless spread away from the client.
 *
 * `findUnique` with a non-unique `llmKeyEnc` filter alongside the unique id:
 * Prisma's extended unique-where accepts that (verified against the generated
 * types, not assumed), and it says what this is — one row, by primary key, or
 * nothing. `findFirst` would read identically but describe a search.
 */
export async function ownLlmKeyPresent(): Promise<boolean> {
  const me = await currentUser();
  if (!me) return false;
  const row = await prisma.user.findUnique({
    where: { id: me.id, llmKeyEnc: { not: null } },
    select: { id: true },
  });
  return row != null;
}

/**
 * #153 — delete your own account. UK GDPR Art. 17, served by a control instead
 * of by asking the owner to run it on your behalf.
 *
 * Rule 1 at the top of this file is doing the heaviest lifting it has done yet.
 * **This action takes no arguments**, so the account it ends is the session's
 * and there is nothing for a hand-rolled POST to point at somebody else's row.
 * A `userId` parameter with an `=== me.id` check would be the same feature and a
 * far worse one: the guard would be a line of code that a later refactor can
 * drop, rather than an argument that does not exist.
 * `account.test.ts` asserts the arity, and asserts that an id passed anyway is
 * ignored.
 *
 * IT FREEZES, IT DOES NOT DESTROY. `freezeAccount` writes the same
 * `revokedAt`/`purgeAfter` window an owner-initiated revoke writes, so a
 * mis-tap here is exactly as recoverable as a mis-click there — and the Google
 * grant is withdrawn AT GOOGLE on the way through (#126), which is the one part
 * of the sequence a new entry point could most easily have skipped. The window
 * is honest copy rather than an automatic countdown: nothing reads `purgeAfter`
 * yet, so the confirmation says the final deletion is done by hand today (see
 * `src/components/settings/delete-account.tsx`, and /privacy's retention list,
 * which has said so since #123).
 *
 * THE OWNER IS REFUSED. `revokePerson` refuses owner self-revocation because the
 * owner is the only account that can manage people; an instance whose owner
 * froze themselves has no route back through the UI. That reasoning does not
 * change when the request arrives from the account's own settings page, so the
 * refusal is repeated here rather than assumed to be somebody else's job.
 */
export async function deleteOwnAccount(): Promise<DeleteAccountResult> {
  const me = await currentUser();
  if (!me) return NOT_SIGNED_IN;
  if (me.role === UserRole.Owner) {
    return { ok: false, error: "owner_cannot_delete" };
  }

  // The return value is deliberately not turned into an error. `currentUser()`
  // has already proved this row exists AND is active, so `false` is only
  // reachable when the owner revoked the same account between the two queries —
  // in which case the caller's outcome holds, and reporting a failure would
  // only invite them to press it again.
  await freezeAccount(me.id);

  // End the session HERE, not in the panel. The account is frozen, so
  // `currentUser()` already resolves it to null — but `resolveWorkspace()`
  // reads the workspace id straight out of the signed cookie without consulting
  // `status`, so a surviving cookie would keep serving that workspace's content
  // to a browser whose account no longer exists. Deleting the cookie is also
  // simply what the person asked for: "delete my account" means signed out.
  (await cookies()).delete(OWNER_COOKIE);

  // Kept despite the cookie above already being gone, and the reason is not the
  // server cache: `/settings` reads cookies, so it renders dynamically and was
  // never in the Full Route Cache to invalidate. What this does reach is the
  // CLIENT Router Cache of the browser that invoked the action — a server action
  // that calls it returns a revalidation signal with its response, so the stale
  // `/settings` payload cannot be replayed from a Back navigation before
  // `router.refresh()` lands. Belt and braces with the panel's `refresh()`, and
  // consistent with the two mutating actions above. Raised in review on !237.
  revalidatePath("/settings");
  return { ok: true };
}
