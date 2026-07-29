"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/workspace";
import { encryptToken } from "@/lib/crypto/token-cipher";

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

export async function saveOwnLlmKey(
  apiKey: string,
): Promise<AccountActionResult> {
  const me = await currentUser();
  if (!me) return NOT_SIGNED_IN;

  // Trimmed because a pasted key carries whitespace, and validated because an
  // encrypted "" decrypts to "" — falsy — so the account would fall silently
  // back onto the instance key while the UI reported a saved key.
  const key = apiKey.trim();
  if (!key || key.length > MAX_KEY_LENGTH || CONTROL_CHARS.test(key)) {
    return INVALID_KEY;
  }

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
