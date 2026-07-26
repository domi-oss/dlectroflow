import { headers } from "next/headers";
import { getLLM } from "@/lib/llm";
import type { LLMTool } from "@/lib/llm/types";
import {
  buildUserPrompt,
  localBreakdown,
  type BreakdownRequest,
  type Proposal,
  type StreamEvent,
} from "@/lib/breakdown";
import { isOwnerRequest, currentWorkspaceId } from "@/lib/workspace";
import { getSettings } from "@/lib/settings-read";
import { resolveBreakdownModel, breakdownParamsFor } from "@/lib/models";
import {
  clientIpHash,
  consumeGuestBreakdown,
  refundGuestBreakdown,
} from "@/lib/guest-quota";
import { recordAnthropicFailure } from "@/lib/observability";
import { OWNER_WORKSPACE_ID } from "@/lib/constants";

export const runtime = "nodejs";

// ── Request size guard ───────────────────────────────────────────────────────
// Reject bodies larger than this before JSON parsing or calling Claude.
// Prevents unbounded AI spend from unauthenticated review-app URLs.
// The ingress also caps at 2 MB; this is the application-layer backstop.
// OWASP ASVS V13.2.6 — API abuse prevention.
const MAX_BODY_CHARS = 10_000;

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

const PROPOSE_TOOL: LLMTool = {
  name: "propose_steps",
  description:
    "Propose the breakdown of the task into small, ordered, actionable steps.",
  inputSchema: {
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
  // ── Input size validation ────────────────────────────────────────────────
  // Read the raw body first so we can enforce a size limit before parsing.
  // This prevents maliciously large payloads from reaching the JSON parser or
  // the Claude API. OWASP ASVS V13.2.6.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return new Response(
      JSON.stringify({ error: "Failed to read request body" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  if (rawBody.length > MAX_BODY_CHARS) {
    return new Response(
      JSON.stringify({
        error: `Request body too large (max ${MAX_BODY_CHARS} characters)`,
      }),
      {
        status: 413,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // ── JSON parsing ─────────────────────────────────────────────────────────
  let body: BreakdownRequest;
  try {
    body = JSON.parse(rawBody) as BreakdownRequest;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── Role + allowance resolution ────────────────────────────────────────────
  const owner = await isOwnerRequest();
  const wsId = await currentWorkspaceId();
  const isGuest = wsId !== OWNER_WORKSPACE_ID;

  let blockedReason: "quota" | "global_cap" | null = null;
  let guestIpHash: string | null = null;
  if (isGuest) {
    const hdrs = await headers();
    guestIpHash = clientIpHash(hdrs);
    // No resolvable IP ⇒ treat as global-cap-style block (can't meter safely).
    if (!guestIpHash) {
      blockedReason = "global_cap";
    } else {
      const res = await consumeGuestBreakdown(guestIpHash);
      if (!res.allowed) blockedReason = res.reason ?? "quota";
    }
  }

  // Resolve model (owner setting → env → default; guest → haiku).
  const settings = owner ? await getSettings(OWNER_WORKSPACE_ID) : null;
  const model = resolveBreakdownModel({
    isOwner: owner,
    ownerSetting: settings?.breakdownModel ?? null,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: StreamEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));

      // Blocked guest → non-silent canned fallback, NO Claude call.
      if (blockedReason) {
        send({
          type: "fallback",
          reason: blockedReason,
          data: localBreakdown(body.title),
        });
        send({ type: "done" });
        controller.close();
        return;
      }

      try {
        const llm = getLLM();
        for await (const ev of llm.stream({
          system: SYSTEM,
          messages: [{ role: "user", content: buildUserPrompt(body) }],
          tools: [PROPOSE_TOOL],
          toolChoice: "propose_steps",
          maxTokens: 6000,
          ...breakdownParamsFor(model),
        })) {
          if (ev.type === "text") {
            send({ type: "text", delta: ev.delta });
          } else if (ev.type === "final") {
            if (ev.result.toolCall?.name === "propose_steps") {
              send({
                type: "steps",
                data: ev.result.toolCall.input as unknown as Proposal,
              });
            } else {
              // Tool-less/local models or a malformed response can complete
              // the stream with no parsed tool call (see #59 Task 7's
              // structured-output fallback). Never leave the user with a
              // dead stream — degrade to the same canned plan as an error.
              send({
                type: "fallback",
                reason: "error",
                data: localBreakdown(body.title),
              });
            }
          }
        }
        send({ type: "done" });
      } catch (err) {
        // #21 P4: fallback mode must be visible — one structured log line +
        // the per-pod counter on /api/livez (was a silent bare catch).
        recordAnthropicFailure("breakdown", err);
        // Claude failed → refund the guest's quota so a transient error doesn't burn an allowance.
        if (isGuest && guestIpHash && !blockedReason) {
          await refundGuestBreakdown(guestIpHash);
        }
        // Canned fallback rather than a dead end.
        send({
          type: "fallback",
          reason: "error",
          data: localBreakdown(body.title),
        });
        send({ type: "done" });
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
