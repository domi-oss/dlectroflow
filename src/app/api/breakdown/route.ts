import { headers } from "next/headers";
import { getLLM } from "@/lib/llm";
import type { LLMTool } from "@/lib/llm/types";
import {
  buildUserPrompt,
  localBreakdown,
  BREAKDOWN_APP_CONTEXT,
  type BreakdownContext,
  type BreakdownRequest,
  type Proposal,
  type StreamEvent,
} from "@/lib/breakdown";
import { gatherBreakdownContext } from "@/lib/breakdown-context";
import { isOwnerRequest, currentWorkspaceId } from "@/lib/workspace";
import { getSettings } from "@/lib/settings-read";
import { resolveBreakdownModel, breakdownParamsFor } from "@/lib/models";
import {
  clientIpHash,
  consumeGuestBreakdown,
  refundGuestBreakdown,
} from "@/lib/guest-quota";
import { recordLLMFailure } from "@/lib/observability";
import { OWNER_WORKSPACE_ID } from "@/lib/constants";

export const runtime = "nodejs";

// ── Request size guard ───────────────────────────────────────────────────────
// Reject bodies larger than this before JSON parsing or calling Claude.
// Prevents unbounded AI spend from unauthenticated review-app URLs.
// The ingress also caps at 2 MB; this is the application-layer backstop.
// OWASP ASVS V13.2.6 — API abuse prevention.
const MAX_BODY_CHARS = 10_000;

// #14 — the coach's SYSTEM prompt. Two rules govern edits here:
//   1. It must stay FREE of per-request values. BREAKDOWN_APP_CONTEXT is a
//      hoisted constant precisely so this string is byte-identical for every
//      request and every workspace (live state goes in the user turn instead).
//      Nothing is prompt-cached today — see #14's spec §5 — but a stable
//      prefix is the precondition for ever enabling it.
//   2. The `propose_steps` sentence must remain the LAST line. On a tool-less
//      provider the openai-compatible adapter appends the whole JSON Schema
//      after this string (`buildStructuredInstruction`, #59 Task 7); burying
//      the tool instruction in the middle is how small local models start
//      forgetting to emit the `<result>` block.
const SYSTEM = `You are a warm, encouraging ADHD coach who helps break an overwhelming task into tiny, concrete, doable steps.

${BREAKDOWN_APP_CONTEXT}

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

  // Resolve the model tier and gather the coach's live context in ONE round
  // trip. Two distinct workspace reads live here and must not be conflated:
  //   • getSettings(OWNER_WORKSPACE_ID) is the OWNER's model-tier lookup, and
  //     stays gated on `owner`.
  //   • gatherBreakdownContext(wsId) is the REQUESTER's own data. Passing
  //     OWNER_WORKSPACE_ID here would hand a guest the owner's voice, streak
  //     and board — the single most important line in this file.
  // Blocked guests never reach the LLM, so they do no context work either; and
  // a context failure degrades to no context rather than failing the request
  // (the breakdown path was DB-light before #14 and must stay resilient).
  const [settings, breakdownContext] = await Promise.all([
    owner ? getSettings(OWNER_WORKSPACE_ID) : Promise.resolve(null),
    blockedReason
      ? Promise.resolve<BreakdownContext>({})
      : gatherBreakdownContext(wsId).catch(() => ({}) as BreakdownContext),
  ]);
  const model = resolveBreakdownModel({
    isOwner: owner,
    ownerSetting: settings?.breakdownModel ?? null,
  });

  // The LLM call failed to produce a usable breakdown — either it threw, or
  // it streamed to completion with no parsed tool call (tool-less/local
  // models, a malformed response). Either way the guest didn't get a real AI
  // breakdown, so refund the quota unit exactly as a blocked guest would
  // never have spent it. No-op for the owner / already-blocked guests.
  //
  // Idempotency guard: both call sites below (the soft-failure branch and
  // the catch block) live in the SAME try, so if `send()` throws after the
  // soft-failure branch already refunded (e.g. the client disconnected and
  // controller.enqueue() throws), control falls into the catch, which would
  // otherwise refund a second time. `refunded` makes a second call a no-op.
  let refunded = false;
  async function refundGuestOnLLMFailure(): Promise<void> {
    if (isGuest && guestIpHash && !blockedReason && !refunded) {
      refunded = true;
      await refundGuestBreakdown(guestIpHash);
    }
  }

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
          messages: [
            { role: "user", content: buildUserPrompt(body, breakdownContext) },
          ],
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
              // dead stream — degrade to the same canned plan as an error,
              // and refund a guest exactly as the thrown-error path below.
              await refundGuestOnLLMFailure();
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
        recordLLMFailure(getLLM().id, "breakdown", err);
        // The LLM call failed → refund the guest's quota so a transient error doesn't burn an allowance.
        await refundGuestOnLLMFailure();
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
