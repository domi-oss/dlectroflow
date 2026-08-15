/**
 * #199 — behavioural proof that `ShoppingItem_text_check` actually BITES.
 *
 * `LENGTH_REGISTRY` in `enum-constraint-sync.integration.test.ts` pins that the
 * constraint EXISTS, names the right column, measures with `char_length` and
 * carries the same number as `SHOPPING_ITEM_TEXT_MAX_LENGTH`. It does not prove
 * the constraint refuses anything, which is a different claim — and the one
 * `!282` showed can be false while the registry is green: `FocusPlaylist_name_check`
 * shipped with a lower bound that let three TABS through, and then with a "fix"
 * that rejected the honest name `"v"`. Both were found by a file like this one,
 * not by reading the SQL back.
 *
 * So this file re-runs that lesson against the new constraint rather than
 * assuming the copied spelling is safe: `[[:space:]]` instead of `btrim`, checked
 * against every ASCII whitespace character individually.
 *
 * `shopping.test.ts` pins the TypeScript half and would pass regardless of what
 * the database does. That asymmetry is exactly what made the `!282` gap
 * invisible, so the two halves are asserted to AGREE here rather than assumed to.
 *
 * The writes are **raw SQL, deliberately**: every application writer normalises
 * before Prisma sees the value, so a raw INSERT is the closest thing to "a future
 * writer that forgot" — the only case a CHECK constraint exists for. Same
 * argument as `focus-playlist-name-check.integration.test.ts` and #78's
 * `Step_estMinutes_check`.
 *
 * **Every rejection is asserted alongside an acceptance.** A suite where nothing
 * inserts successfully would pass identically if the table were missing, the
 * workspace were absent, or the INSERT were malformed — "the write failed" is not
 * evidence that the CONSTRAINT failed it.
 *
 * Needs the real Postgres (CI wires up a service DB and runs `prisma migrate
 * deploy` first; locally `config/vitest.config.ts` forwards DATABASE_URL from
 * `.env` — only that one variable, by design: #84).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { WorkspaceKind } from "@/lib/constants";
import {
  normaliseShoppingItemText,
  SHOPPING_ITEM_TEXT_MAX_LENGTH,
} from "@/lib/shopping";

const prisma = new PrismaClient();
const WS = "test-199-shopping-text-ws";

async function wipe() {
  await prisma.shoppingItem.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

// A counter, not `Math.random()`: SAST flags `Math.random()` as a weak PRNG
// wherever it appears (the finding `!282` produced), and a test that needs unique
// ids does not need unpredictable ones. It is also deterministic, so a failure
// reproduces with the same ids it failed with.
let seq = 0;

/**
 * Insert item text straight through SQL, bypassing every normaliser. Returns the
 * Postgres SQLSTATE on rejection, or `null` when the row landed.
 */
async function insertText(text: string): Promise<string | null> {
  try {
    await prisma.$executeRaw`
      INSERT INTO "ShoppingItem" ("id", "workspaceId", "text", "order")
      VALUES (${`s-${++seq}`}, ${WS}, ${text}, ${++seq})
    `;
    return null;
  } catch (e) {
    // Prisma surfaces the SQLSTATE on the error for raw queries; fall back to the
    // message so a shape change here fails loudly rather than silently turning
    // every rejection into "some error happened".
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

describe("ShoppingItem_text_check refuses every whitespace-only entry (#199)", () => {
  // `23514` is check_violation. Named rather than inlined at each call so a
  // different failure — a missing table, an absent workspace, a bad INSERT —
  // cannot be mistaken for the constraint doing its job.
  const CHECK_VIOLATION = "23514";

  it.each([
    ["three spaces", "   "],
    ["three tabs", "\t\t\t"],
    ["two newlines", "\n\n"],
    ["a carriage return", "\r"],
    ["a form feed", "\f"],
    // The character `btrim(text, E' \t\n\r\f\v')` silently fails to strip,
    // because Postgres's E'' syntax has no `\v` escape (`!282`, round two).
    ["a vertical tab", "\v"],
    ["mixed whitespace", " \t\n\r\f\v "],
    ["the empty string", ""],
  ])(
    "rejects %s at the database, not merely in TypeScript",
    async (_label, text) => {
      // The TS half agrees this is empty — asserted so the two halves are shown
      // to be aligned rather than assumed to be.
      expect(normaliseShoppingItemText(text)).toBeNull();
      expect(await insertText(text)).toBe(CHECK_VIOLATION);
    },
  );

  it.each([
    ["a plain entry", "Milk"],
    ["an entry with internal whitespace", "oat milk, the blue one"],
    ["an entry padded with tabs", "\tMilk\t"],
    ["a single character", "A"],
    // The regression `!282`'s first fix attempt introduced, pinned here so the
    // spelling copied from it cannot bring the bug along: `E' \t\n\r\f\v'`
    // degraded `\v` to a literal `v`, rejecting these honest entries as empty.
    ["an entry that is just the letter v", "v"],
    ["an entry of several v's", "vvv"],
    ["exactly the bound", "x".repeat(SHOPPING_ITEM_TEXT_MAX_LENGTH)],
  ])(
    "still accepts %s — the control that makes the rejections above mean something",
    async (_label, text) => {
      expect(await insertText(text)).toBeNull();
    },
  );

  it("enforces the upper bound", async () => {
    expect(
      await insertText("x".repeat(SHOPPING_ITEM_TEXT_MAX_LENGTH + 1)),
    ).toBe(CHECK_VIOLATION);
  });

  it("measures in characters, not bytes, so an emoji entry is not penalised", async () => {
    // The same argument Task_notes_check pins (#44): `octet_length` would reject
    // an all-emoji entry roughly a quarter the length of a Latin one it accepts.
    expect(
      await insertText("🥑".repeat(SHOPPING_ITEM_TEXT_MAX_LENGTH)),
    ).toBeNull();
    expect(
      await insertText("🥑".repeat(SHOPPING_ITEM_TEXT_MAX_LENGTH + 1)),
    ).toBe(CHECK_VIOLATION);
  });
});
