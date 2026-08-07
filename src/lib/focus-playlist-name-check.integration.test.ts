/**
 * #185 — behavioural proof that `FocusPlaylist_name_check` actually BITES, and
 * specifically that it bites on the whitespace it claims to.
 *
 * This file exists because of a review finding on `!282`, and then because of a
 * bug in the FIX for that finding — which is the more useful half.
 *
 * **Round one.** The constraint shipped as `char_length(btrim("name")) >= 1`, its
 * own comment calling `btrim` "the backstop for a writer that does not [trim]".
 * It was not one: Postgres's single-argument `btrim(string)` defaults its
 * `characters` argument to a plain SPACE and nothing else, so a name of three
 * TABS satisfied the bound and reached the table — while `.trim()` on the TS side
 * strips it and `normaliseFocusPlaylistName` calls the same value empty. The
 * backstop was **weaker than the thing it backed up**, which is the one way a
 * compensating control is worse than none: it makes the invariant look guarded.
 *
 * **Round two, caught by this file rather than by reading the SQL back.** The
 * obvious repair — `btrim("name", E' \t\n\r\f\v')` — is worse, and silently.
 * **Postgres's E'' syntax has no `\v` escape.** It does not error; it degrades to
 * a literal lowercase `v`. The applied character set read codepoints
 * 32,9,10,13,12,**118**: vertical tab still not stripped, and a playlist honestly
 * named "v" or "vvv" now rejected as empty. A fix that traded a narrow gap for a
 * false rejection of real user input, and it would have shipped, because reading
 * the constraint back shows `' ???v'` — the control characters are invisible and
 * the `v` looks intentional.
 *
 * So the constraint now says the invariant instead of encoding a way to compute
 * it: `"name" ~ '[^[:space:]]'` — contains at least one non-whitespace character.
 * A POSIX class has no escape sequence to get wrong, and a negated class also
 * rejects the empty string with no separate clause.
 *
 * `focus-playlists.test.ts` already pinned the TS half and passed throughout both
 * rounds. That is precisely what made the gap invisible, and the reason the DB
 * half needs its own behavioural proof rather than an assumption of symmetry.
 *
 * The writes are **raw SQL, deliberately**: every application writer normalises
 * before Prisma sees the value, so a raw INSERT is the closest thing to "a
 * future writer that forgot" — which is the only case a CHECK constraint exists
 * for. Same argument as `notes-length-check.integration.test.ts` and #78's
 * `Step_estMinutes_check`.
 *
 * **Every rejection is asserted alongside an acceptance.** A suite where nothing
 * inserts successfully would pass identically if the table were missing, the
 * workspace were absent, or the INSERT were malformed — "the write failed" is
 * not evidence that the CONSTRAINT failed it, so the accepted cases are the
 * control that makes the rejected ones mean something.
 *
 * Needs the real Postgres (CI wires up a service DB and runs
 * `prisma migrate deploy` first; locally it uses your DATABASE_URL schema —
 * vitest does NOT read .env):
 *   set -a; . ./.env; set +a; npm run test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { WorkspaceKind } from "@/lib/constants";
import { normaliseFocusPlaylistName } from "@/lib/focus-playlists";

const prisma = new PrismaClient();
const WS = "test-185-playlist-name-ws";

async function wipe() {
  await prisma.focusPlaylist.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

/**
 * Insert a playlist name straight through SQL, bypassing every normaliser.
 * Returns the Postgres SQLSTATE on rejection, or `null` when the row landed.
 */
async function insertName(name: string): Promise<string | null> {
  try {
    await prisma.$executeRaw`
      INSERT INTO "FocusPlaylist" ("id", "workspaceId", "name")
      VALUES (${`p-${Math.random().toString(36).slice(2)}`}, ${WS}, ${name})
    `;
    return null;
  } catch (e) {
    // Prisma surfaces the SQLSTATE on the error for raw queries; fall back to
    // the message so a shape change here fails loudly rather than silently
    // turning every rejection into "some error happened".
    const code = (e as { meta?: { code?: string } }).meta?.code;
    return code ?? `unknown: ${String((e as Error).message).slice(0, 120)}`;
  }
}

beforeAll(async () => {
  await wipe();
  await prisma.workspace.create({
    data: { id: WS, kind: WorkspaceKind.Guest },
  });
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("FocusPlaylist_name_check refuses every whitespace-only name (#185)", () => {
  // `23514` is check_violation. Named rather than inlined at each call so a
  // different failure — a missing table, an absent workspace, a bad INSERT —
  // cannot be mistaken for the constraint doing its job.
  const CHECK_VIOLATION = "23514";

  const whitespaceOnly: [string, string][] = [
    ["three spaces", "   "],
    ["three tabs", "\t\t\t"],
    ["two newlines", "\n\n"],
    ["a carriage return", "\r"],
    ["a form feed", "\f"],
    ["a vertical tab", "\v"],
    ["mixed whitespace", " \t\n\r\f\v "],
    ["a non-breaking-space-free mix", "\t \n"],
    ["the empty string", ""],
  ];

  it.each(whitespaceOnly)(
    "rejects %s at the database, not merely in TypeScript",
    async (_label, name) => {
      // The TS half agrees this is empty — asserted here so the two halves are
      // shown to be aligned rather than assumed to be. Before this fix they were
      // not: every case below except "three spaces" and "" passed the CHECK.
      expect(normaliseFocusPlaylistName(name)).toBeNull();
      expect(await insertName(name)).toBe(CHECK_VIOLATION);
    },
  );

  it.each([
    ["a plain name", "Lofi"],
    ["a name with internal whitespace", "Deep Focus"],
    ["a name padded with tabs", "\tLofi\t"],
    ["a single character", "A"],
    ["exactly 60 characters", "x".repeat(60)],
    // The regression the first attempt at this fix introduced, pinned so it
    // cannot come back: `E' \t\n\r\f\v'` has no `\v` escape in Postgres and
    // degraded to a literal `v`, so these two honest names were rejected as
    // whitespace-only.
    ["a name that is just the letter v", "v"],
    ["a name of several v's", "vvv"],
  ])(
    "still accepts %s — the control that makes the rejections above mean something",
    async (_label, name) => {
      expect(await insertName(name)).toBeNull();
    },
  );

  it("still enforces the upper bound, which this change did not touch", async () => {
    expect(await insertName("x".repeat(61))).toBe(CHECK_VIOLATION);
  });

  it("measures in characters, not bytes, so an emoji name is not penalised", async () => {
    // The same argument Task_notes_check pins (#44): `octet_length` would reject
    // an all-emoji name roughly a quarter the length of a Latin one it accepts.
    expect(await insertName("🎧".repeat(60))).toBeNull();
    expect(await insertName("🎧".repeat(61))).toBe(CHECK_VIOLATION);
  });
});
