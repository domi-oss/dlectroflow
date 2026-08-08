import { headers } from "next/headers";
import { getLLM } from "@/lib/llm";
import type { LLMCredentials, LLMProvider, LLMTool } from "@/lib/llm/types";
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
import {
  isOwnerRequest,
  currentWorkspaceId,
  currentUser,
} from "@/lib/workspace";
import { getSettings } from "@/lib/settings-read";
import {
  resolveBreakdownModel,
  breakdownParamsFor,
  type ModelTier,
} from "@/lib/models";
import {
  clientIpHash,
  consumeGuestBreakdown,
  refundGuestBreakdown,
} from "@/lib/guest-quota";
import { consumeUserBreakdown, refundUserBreakdown } from "@/lib/user-quota";
import { recordLLMFailure } from "@/lib/observability";
import { isGuestWorkspace } from "@/lib/workspace-kind";

export const runtime = "nodejs";

// ── Request size guard ───────────────────────────────────────────────────────
// Reject bodies larger than this before JSON parsing or calling Claude.
// Prevents unbounded AI spend from unauthenticated review-app URLs.
// The ingress also caps at 2 MB; this is the application-layer backstop.
// OWASP ASVS V13.2.6 — API abuse prevention.
const MAX_BODY_CHARS = 10_000;

// #179 — the shape a `Task.id` can have: a cuid, so ASCII word characters and
// nothing else. The body is untrusted JSON *cast* to `BreakdownRequest`, which
// buys no runtime guarantee at all, so `taskId` is validated rather than
// trusted before it reaches a query — see `requestedTaskId` below.
const TASK_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The task the caller says is being refined, or `null`.
 *
 * Two jobs downstream (`gatherBreakdownContext`): excluding this task's own
 * steps from the history summary, and keying the read of its note. Neither is
 * load-bearing for correctness, so anything unusable degrades to `null` — the
 * pre-#179 behaviour — rather than erroring or reaching Prisma as an object it
 * would throw on.
 *
 * This does NOT decide whose task it is: the read is scoped to the session's
 * own workspace, which is what turns a foreign id into a miss (invariant 1 in
 * breakdown-context.ts). The length bound is only so an absurd string never
 * becomes a query parameter.
 */
function requestedTaskId(body: BreakdownRequest): string | null {
  const raw = body.taskId;
  return typeof raw === "string" && TASK_ID_SHAPE.test(raw) ? raw : null;
}

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
  const user = await currentUser();
  // #35 Phase A: "guest" is a property of the workspace, not of its id. Every
  // signed-in account now has an opaque workspace id, so the old
  // `wsId !== OWNER_WORKSPACE_ID` test would have metered every member against
  // the per-IP guest quota.
  const isGuest = await isGuestWorkspace(wsId);

  let blockedReason: "quota" | "global_cap" | null = null;
  let guestIpHash: string | null = null;
  // #35 Phase B — the two allowances are mutually exclusive by construction: a
  // guest has no account to meter, and a signed-in account is never billed to
  // whoever happens to share its IP. `userMetered` — not the policy name — is
  // what the refund path keys off: an own-key or uncapped account spent no
  // allowance, so there is none to give back.
  let userMetered = false;
  let llmCredentials: LLMCredentials | undefined;

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
  } else if (user) {
    // The resolution order lives in consumeUserBreakdown (see its doc comment):
    // a present key wins → uncapped → capped-and-metered. Over quota comes back
    // as the same `"quota"` reason a blocked guest gets, so the fallback branch
    // below needs no new case.
    const access = await consumeUserBreakdown(user.id);
    userMetered = access.metered;
    blockedReason = access.blockedReason;
    if (access.ownKey) {
      llmCredentials = {
        apiKey: access.ownKey.apiKey,
        provider: access.ownKey.provider,
      };
    }
  } else {
    // Neither a guest sandbox nor a signed-in account: a workspace whose row
    // went missing mid-request. Fail CLOSED onto the canned plan rather than
    // spend the instance's key on a caller nobody can bill or meter.
    blockedReason = "quota";
  }

  // Resolve the model tier and gather the coach's live context in ONE round
  // trip. Two distinct workspace reads live here and must not be conflated:
  //   • the model-tier lookup is the OWNER's own Settings row and stays gated
  //     on `owner`. Pre-#35 it read the constant OWNER_WORKSPACE_ID; now the
  //     owner's workspace IS wsId when `owner` is true, so it reads wsId —
  //     same row, no constant.
  //   • gatherBreakdownContext(wsId) is the REQUESTER's own data. Passing
  //     anyone else's workspace here would hand them another person's voice,
  //     streak and board — the single most important line in this file. Since
  //     #179 it also hands over their note, so the second argument is a task id
  //     the BODY supplied while the first stays the one the SESSION resolved:
  //     the body can say which task, never whose.
  // Blocked guests never reach the LLM, so they do no context work either; and
  // a context failure degrades to no context rather than failing the request
  // (the breakdown path was DB-light before #14 and must stay resilient).
  // #96 — a NAMED tier. `owner` is still the owner; a signed-in member is a
  // member, not a not-owner; anyone else is a guest.
  const tier: ModelTier = owner ? "owner" : user ? "member" : "guest";
  const [settings, breakdownContext] = await Promise.all([
    // #96 — a member gets a model preference to read. This was gated on `owner`,
    // so even with the tier fixed a member had no ownerSetting to follow. It is
    // the requester's OWN Settings row either way — wsId is their own workspace —
    // and a guest keeps null, because the guest tier ignores it anyway.
    user ? getSettings(wsId) : Promise.resolve(null),
    blockedReason
      ? Promise.resolve<BreakdownContext>({})
      : gatherBreakdownContext(wsId, requestedTaskId(body)).catch(
          () => ({}) as BreakdownContext,
        ),
  ]);
  const model = resolveBreakdownModel({
    tier,
    ownerSetting: settings?.breakdownModel ?? null,
    // `access.ownKey` is the DECRYPTED credential — this passes only WHETHER one
    // exists. The key itself never leaves llmCredentials.
    hasOwnKey: llmCredentials != null,
  });

  // The LLM call failed to produce a usable breakdown — either it threw, or
  // it streamed to completion with no parsed tool call (tool-less/local
  // models, a malformed response). Either way the caller didn't get a real AI
  // breakdown, so refund the metered unit exactly as a blocked caller would
  // never have spent it. No-op for anyone who was not metered (#35 Phase B:
  // uncapped and own-key accounts, and the owner) or already blocked.
  //
  // Idempotency guard: both call sites below (the soft-failure branch and
  // the catch block) live in the SAME try, so if `send()` throws after the
  // soft-failure branch already refunded (e.g. the client disconnected and
  // controller.enqueue() throws), control falls into the catch, which would
  // otherwise refund a second time. `refunded` makes a second call a no-op.
  let refunded = false;
  async function refundOnLLMFailure(): Promise<void> {
    if (blockedReason || refunded) return;
    if (isGuest && guestIpHash) {
      refunded = true;
      await refundGuestBreakdown(guestIpHash);
    } else if (user && userMetered) {
      refunded = true;
      await refundUserBreakdown(user.id);
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: StreamEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));

      // Blocked caller → non-silent canned fallback, NO LLM call.
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

      // The provider id is captured as soon as it is known so the catch below
      // can log against the RIGHT provider without calling getLLM() a second
      // time — with per-user credentials that would construct a second client,
      // and if the construction itself is what threw, the catch would throw
      // again and abandon the stream mid-flight.
      let llmId: LLMProvider["id"] = "anthropic";
      try {
        // #35 Phase B — `llmCredentials` is set only when this account brought
        // its own key; undefined means the instance key, exactly as before.
        const llm = getLLM(llmCredentials);
        llmId = llm.id;
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
              // and refund a metered unit exactly as the thrown-error path below.
              await refundOnLLMFailure();
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
        recordLLMFailure(llmId, "breakdown", err);
        // The LLM call failed → refund the metered unit so a transient error
        // doesn't burn a guest's or an account's allowance.
        await refundOnLLMFailure();
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
