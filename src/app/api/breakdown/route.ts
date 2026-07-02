import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropic, BREAKDOWN_MODEL } from "@/lib/anthropic";
import {
  buildUserPrompt,
  type BreakdownRequest,
  type Proposal,
  type StreamEvent,
} from "@/lib/breakdown";

export const runtime = "nodejs";

const SYSTEM = `You are a warm, encouraging ADHD coach who helps break an overwhelming task into tiny, concrete, doable steps.

Voice:
- Open with a FRESH, creative, varied one-line greeting tailored to THIS specific task. Never reuse a stock opener; be warm and human, and end it inviting the person to confirm or tweak.
- Then one or two short sentences framing the plan. Keep it light and low-pressure.

Steps:
- Break the task into small, concrete, ordered steps. Each step should feel doable in roughly 5–30 minutes.
- No fixed count — use as many steps as the task honestly needs.
- Pick ONE theme emoji for the whole task (parentEmoji), and a fitting emoji for each individual step (subtaskEmoji).
- If the feedback says chunks are too big, split them smaller. If too small / too many, consolidate. For free-text feedback, adapt sensibly.

Always finish by calling the propose_steps tool with the structured steps. Emit your short conversational text FIRST, then the tool call.`;

const PROPOSE_TOOL: Anthropic.Tool = {
  name: "propose_steps",
  description:
    "Propose the breakdown of the task into small, ordered, actionable steps.",
  input_schema: {
    type: "object",
    properties: {
      parentEmoji: {
        type: "string",
        description: "One theme emoji representing the whole task.",
      },
      steps: {
        type: "array",
        description: "Ordered list of small steps.",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "Concise, concrete step." },
            estMinutes: {
              type: "integer",
              description: "Rough estimate in minutes (5–30 typical).",
            },
            subtaskEmoji: {
              type: "string",
              description: "One emoji matching this step's action.",
            },
          },
          required: ["text", "estMinutes", "subtaskEmoji"],
        },
      },
    },
    required: ["parentEmoji", "steps"],
  },
};

export async function POST(req: Request): Promise<Response> {
  let body: BreakdownRequest;
  try {
    body = (await req.json()) as BreakdownRequest;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: StreamEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        const anthropic = getAnthropic();
        const ms = anthropic.messages.stream({
          model: BREAKDOWN_MODEL,
          max_tokens: 6000,
          thinking: { type: "adaptive" },
          // low effort keeps the interactive chat snappy; the task is simple
          output_config: { effort: "low" },
          system: SYSTEM,
          tools: [PROPOSE_TOOL],
          messages: [{ role: "user", content: buildUserPrompt(body) }],
        });

        ms.on("text", (delta) => send({ type: "text", delta }));

        const final = await ms.finalMessage();
        const tool = final.content.find(
          (b) => b.type === "tool_use" && b.name === "propose_steps",
        );
        if (tool && tool.type === "tool_use") {
          send({ type: "steps", data: tool.input as unknown as Proposal });
        }
        send({ type: "done" });
      } catch (err) {
        send({
          type: "error",
          message:
            err instanceof Error ? err.message : "Breakdown request failed.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
