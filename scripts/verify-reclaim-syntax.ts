/**
 * One-shot manual check of the assumption the title format rests on: that
 * Reclaim treats `[6/7]` as text, not as a date (#104).
 *
 * NOT part of CI — it writes to the owner's real Google Tasks list. Run it once,
 * read the result, delete the task it created.
 *
 *   npx tsx scripts/verify-reclaim-syntax.ts
 */
import {
  getValidAccessToken,
  findReclaimList,
  upsertGoogleTask,
} from "../src/lib/google";

async function main() {
  const token = await getValidAccessToken();
  if (!token) throw new Error("no Google token — connect in Settings first");
  const list = await findReclaimList(token);
  if (!list) throw new Error("no 🗓 Reclaim list found");

  const title =
    "[6/7] ✏️ dlectroflow syntax probe — delete me ~15m " +
    "(duration:30m) (nosplit) (due Aug 7 2026 5:00pm) (priority:P4) (type work)";

  const { id } = await upsertGoogleTask(token, list.id, null, {
    title,
    notes: "probe",
  });
  console.log(`created ${id} in "${list.title}"`);
  console.log("Now check, in Reclaim or the calendar:");
  console.log("  1. does the event title still start with [6/7] ?");
  console.log("  2. is it due 7 August 2026 17:00 — not 6 July ?");
  console.log("  3. is it one 30-minute block, not two 15s ?");
  console.log("Then delete the task.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
