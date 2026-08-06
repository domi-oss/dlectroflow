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

/** Get today's spark, generating + caching it on first request of the day. */
export async function getTodaySpark(workspaceId: string): Promise<Spark> {
  const date = today();
  const existing = await prisma.dailySpark.findUnique({
    where: { workspaceId_date: { workspaceId, date } },
  });
  if (existing) return { quote: existing.quote, source: existing.source };

  const { quote, source } = await quoteFor(workspaceId);
  const saved = await prisma.dailySpark.upsert({
    where: { workspaceId_date: { workspaceId, date } },
    create: { date, workspaceId, quote, source },
    update: {}, // if two requests race, keep the first
  });
  return { quote: saved.quote, source: saved.source };
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
