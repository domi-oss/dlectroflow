import { prisma } from "@/lib/db";
import { getLLM } from "@/lib/llm";
import { resolveUtilityModel } from "@/lib/models";
import { SparkSource } from "@/lib/constants";
import { isGuestWorkspace } from "@/lib/workspace-kind";
import { pickOne } from "@/lib/pick-one";

const FALLBACK_SPARKS = [
  "You don't have to do it all — just the next tiny thing.",
  "Starting is the hard part. You're already here. That counts.",
  "Progress over perfection. A messy step forward still moves you forward.",
  "Your brain isn't broken — it just runs a different way. Work with it today.",
  "One small win first. Momentum is a real thing and it's on your side.",
  "Done is kinder to future-you than perfect.",
  "Pick the smallest possible start. Then let it be enough.",
  "You've gotten through every hard day so far. Today's no exception.",
];

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function randomFallback(): string {
  return pickOne(FALLBACK_SPARKS);
}

async function generateQuote(): Promise<{ quote: string; source: string }> {
  try {
    const { text } = await getLLM().generate({
      model: resolveUtilityModel(),
      maxTokens: 120,
      hints: { effort: "low" },
      messages: [
        {
          role: "user",
          content:
            "Write ONE short (max ~120 chars), warm, genuine encouraging line for someone with ADHD starting their day. Not cheesy, no emoji, no quotation marks, no attribution — just the line.",
        },
      ],
    });
    const clean = text.trim().replace(/^["']|["']$/g, "");
    if (clean) return { quote: clean, source: SparkSource.AI };
  } catch {
    // fall through to fallback
  }
  return { quote: randomFallback(), source: SparkSource.Fallback };
}

async function quoteFor(
  workspaceId: string,
): Promise<{ quote: string; source: string }> {
  if (await isGuestWorkspace(workspaceId)) {
    return { quote: randomFallback(), source: SparkSource.Fallback };
  }
  return generateQuote();
}

export type Spark = { quote: string; source: string };

/**
 * Get today's spark, generating + caching it on first request of the day.
 *
 * ## Keeping the first, without racing to P2002 (#223)
 *
 * The read is a TOCTOU: two requests on the first hit of the day both see no
 * row and both write. That used to be answered by `upsert(… update: {})`, with
 * a comment saying "if two requests race, keep the first" — and it did not.
 * Prisma 6.19 compiles an upsert to a native `INSERT … ON CONFLICT` **only when
 * the update payload is non-empty**; with an empty one it degrades to
 * `BEGIN; SELECT; INSERT; COMMIT`, the same read-then-insert as the lines above
 * it. Measured at 15 of 20 racing callers raising P2002 — out of the dashboard
 * render, so the quote card fails for one of two concurrent requests.
 *
 * `createManyAndReturn` + `skipDuplicates` is the only Prisma API that compiles
 * to `INSERT … ON CONFLICT DO NOTHING` (#156, #158, and the note on `log` in
 * src/lib/db.ts). The loser inserts nothing, gets an empty array and raises
 * nothing — which matters beyond the throw, because catching the P2002 would
 * not have been enough: Prisma's client logger prints a failed query strictly
 * before any `catch` sees it, so the caught version still reports an incident.
 *
 * The read-back is what actually delivers "keep the first". `createManyAndReturn`
 * returns only the rows THIS statement inserted, so a loser has to go and read
 * the row that won; returning the quote this call generated instead would mean
 * two requests on the same day showing two different sparks, one of which is in
 * no table and gone on the next render.
 *
 * The generated quote is thrown away in that case, and the wasted LLM call is
 * the honest cost. It is bounded by the same one-per-workspace-per-day window
 * the cache already enforces, and the alternative — holding a lock across a
 * network call to a model provider — would put an LLM's latency inside a
 * database transaction on the dashboard's render path.
 */
export async function getTodaySpark(workspaceId: string): Promise<Spark> {
  const date = today();
  const existing = await prisma.dailySpark.findUnique({
    where: { workspaceId_date: { workspaceId, date } },
  });
  if (existing) return { quote: existing.quote, source: existing.source };

  const { quote, source } = await quoteFor(workspaceId);
  const [created] = await prisma.dailySpark.createManyAndReturn({
    data: { date, workspaceId, quote, source },
    skipDuplicates: true,
  });
  if (created) return { quote: created.quote, source: created.source };

  // DO NOTHING means another request got there first and its row is already
  // committed: Postgres blocks the conflicting insert on the unique index until
  // the winning transaction resolves, and only then decides to skip. So this
  // read cannot miss for timing reasons.
  const winner = await prisma.dailySpark.findUnique({
    where: { workspaceId_date: { workspaceId, date } },
  });
  if (winner) return { quote: winner.quote, source: winner.source };

  // Which leaves one way to get here: the row was written and then deleted
  // inside that window — the workspace was purged (guest TTL, account deletion)
  // mid-request. Serve the line we already have rather than throwing a rendered
  // dashboard away over a cache miss; this is a quote, and #223 is about a
  // failure the person can see.
  return { quote, source };
}

/** Force a fresh spark for today ("New spark" button). */
export async function refreshTodaySpark(workspaceId: string): Promise<Spark> {
  const date = today();
  const { quote, source } = await quoteFor(workspaceId);
  const saved = await prisma.dailySpark.upsert({
    where: { workspaceId_date: { workspaceId, date } },
    create: { date, workspaceId, quote, source },
    update: { quote, source },
  });
  return { quote: saved.quote, source: saved.source };
}
