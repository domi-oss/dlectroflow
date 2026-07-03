import { prisma } from "@/lib/db";
import { getAnthropic, BREAKDOWN_MODEL } from "@/lib/anthropic";
import { SparkSource } from "@/lib/constants";

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
  return FALLBACK_SPARKS[Math.floor(Math.random() * FALLBACK_SPARKS.length)];
}

async function generateQuote(): Promise<{ quote: string; source: string }> {
  try {
    const anthropic = getAnthropic();
    const resp = await anthropic.messages.create({
      model: BREAKDOWN_MODEL,
      max_tokens: 120,
      output_config: { effort: "low" },
      messages: [
        {
          role: "user",
          content:
            "Write ONE short (max ~120 chars), warm, genuine encouraging line for someone with ADHD starting their day. Not cheesy, no emoji, no quotation marks, no attribution — just the line.",
        },
      ],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim()
      .replace(/^["']|["']$/g, "");
    if (text) return { quote: text, source: SparkSource.AI };
  } catch {
    // fall through to fallback
  }
  return { quote: randomFallback(), source: SparkSource.Fallback };
}

export type Spark = { quote: string; source: string };

/** Get today's spark, generating + caching it on first request of the day. */
export async function getTodaySpark(): Promise<Spark> {
  const date = today();
  const existing = await prisma.dailySpark.findUnique({ where: { date } });
  if (existing) return { quote: existing.quote, source: existing.source };

  const { quote, source } = await generateQuote();
  const saved = await prisma.dailySpark.upsert({
    where: { date },
    create: { date, quote, source },
    update: {}, // if two requests race, keep the first
  });
  return { quote: saved.quote, source: saved.source };
}

/** Force a fresh spark for today ("New spark" button). */
export async function refreshTodaySpark(): Promise<Spark> {
  const date = today();
  const { quote, source } = await generateQuote();
  const saved = await prisma.dailySpark.upsert({
    where: { date },
    create: { date, quote, source },
    update: { quote, source },
  });
  return { quote: saved.quote, source: saved.source };
}
