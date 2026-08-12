import { revalidatePath } from "next/cache";
import {
  currentWorkspaceId,
  MissingWorkspaceError,
  RevokedAccountError,
} from "@/lib/workspace";
import { writeCapture } from "@/lib/capture-write";
import { requestOrigin } from "@/lib/origin";
import {
  CAPTURE_QUEUE_MAX_BYTES,
  type FlushOutcome,
} from "@/lib/capture-queue";

/**
 * #175 — the one write path for a brain-dump capture.
 *
 * Design: `docs/design/specs/2026-08-11-offline-capture-queue-design.md`.
 *
 * ## Why a route handler and not just the server action
 *
 * The offline queue flushes captures the browser has been holding, and a server
 * action is the wrong instrument for that: it is invoked through the framework's
 * own protocol, and a queue draining on reconnect wants a plain request it can
 * send, get a STATUS back from, and record. The spec then puts the FOREGROUND
 * capture bar on this same route rather than leaving the action as a second entry
 * point — one write path, one set of semantics to test. `createBrainDumpItem`
 * keeps its non-queued callers and shares this route's core (`writeCapture`)
 * rather than duplicating it.
 *
 * ## CSRF (CWE-352), and why a route handler needs it when the action did not
 *
 * Next protects server actions against CSRF for us. A plain route handler gets
 * none of that — and the only reason this route exists is that a service worker
 * cannot replay a server action, so the protection was lost in that trade and
 * nothing replaced it. The guard is `src/app/api/auth/logout/route.ts`'s, copied
 * rather than reinvented: reject an `Origin` that is PRESENT and does not match,
 * allow a MISSING one for non-browser clients.
 *
 * ⚠️ **Read this before "simplifying" either control, because each one looks
 * redundant while the other is standing.** They are independent and both load-
 * bearing, and the exposure they cover is not the same:
 *
 *  * The `workspaceId` comparison below already stops a forged POST from creating
 *    a row, because the body has to carry the victim's own workspace id and that
 *    is an unguessable value no cross-origin page can read. So it acts as a CSRF
 *    token — **entirely by accident.** It was written to close the expired-cookie
 *    hole, nothing records it as a CSRF control, and a perfectly reasonable future
 *    change (deriving the workspace instead of declaring it, say) would remove the
 *    protection with no test going red.
 *  * This Origin check stops the part the comparison does not: a forged request
 *    still resolved the session, which for a signed-in account is two queries
 *    including the owner-status re-read (#220). That is unauthenticated work an
 *    attacker can cause from any page, and refusing on a header before the body is
 *    even read removes it.
 *
 * `SameSite=lax` on both session cookies makes a cross-SITE POST unable to carry
 * them at all. What lax does not block is a **same-site** POST, so a page on a
 * subdomain of the deployed host is the residual case — the same reasoning
 * `logout/route.ts` records, applied to a route that creates rows in somebody's
 * inbox rather than one that ends a session.
 *
 * ⚠️ **The status is 400 and that is a decision, not a default.** 403 would be the
 * conventional answer and is unusable here: `capture-queue.ts` maps outcomes by
 * STATUS, where `403` already means `account-revoked` and `409` means
 * `session-expired`, and both carry copy about signing in. A CSRF rejection
 * inheriting either would tell somebody their account had been revoked because a
 * subdomain page forged a request — the same collapse the spec has been reviewed
 * for twice. 400 falls into the client's "anything else → retry" arm, which KEEPS
 * the words, and the body is an `error` rather than a `status` so it is not in the
 * `FlushOutcome` vocabulary at all.
 *
 * ## The security invariant: `workspaceId` in the body is NEVER trusted
 *
 * The workspace is derived from the cookie by `currentWorkspaceId()`, exactly as
 * the rest of the app derives it, and the declared one is only ever **compared**.
 * A mismatch can produce a refusal and nothing else, so client input is incapable
 * of widening access — only of narrowing it. There is no branch below in which
 * the body's value reaches a query.
 *
 * That comparison is what closes an expired-cookie hole without touching
 * middleware. A queued OWNER capture flushed after the cookie lapsed arrives with
 * a freshly minted GUEST sandbox — `src/proxy.ts` mints one for any request with
 * no signed-in session on a path that is neither public nor gated, and this route
 * is deliberately one of those, because a guest sandbox must be able to capture
 * too. So without the check the capture would land in a sandbox the person will
 * never look at again and be deleted with it inside a day. Silently, having been
 * told it was saved.
 *
 * ## 409 and 403 are different answers to different questions
 *
 * They look alike — both keep the capture, neither is retryable — and collapsing
 * them was a real bug caught in review of the spec (`!332`):
 *
 *  - **409** — the session moved on. Signing in again FIXES it.
 *  - **403** — the account was revoked. Signing in again CANNOT fix it: #220 has
 *    already cleared the session and bounced the person to `/login`, so telling
 *    them to sign in sends them into a loop and misstates what happened to them.
 *
 * `RevokedAccountError` is a SUBCLASS of `MissingWorkspaceError` (deliberately —
 * see its doc comment: it makes every handler that only knows about the parent
 * fail closed), so the order of the two `instanceof` branches below is
 * load-bearing rather than stylistic. Narrowing on the parent first would answer
 * 401 for a frozen account and lose the distinction the whole union exists for.
 *
 * ## Node runtime
 *
 * `nodejs` because the write goes through Prisma. No `dynamic` export is needed:
 * a POST handler is never statically evaluated.
 */
export const runtime = "nodejs";

/**
 * The largest request this route will read, in characters.
 *
 * DERIVED from the queue's own bound rather than picked, and that direction
 * matters: `enqueue` refuses any single capture whose serialised entry exceeds
 * `CAPTURE_QUEUE_MAX_BYTES`, so a queued capture is already smaller than that by
 * construction. A cap set independently could drift BELOW it, and the queue would
 * then accept words it can never flush — a capture stuck forever while the strip
 * tells the person it is waiting to save. Twice the queue's whole-queue budget
 * leaves that impossible with room to spare.
 *
 * It is a guard on the REQUEST, not a length limit on capture text: this app has
 * never bounded that (no `maxLength` on the input, an unbounded Postgres `text`),
 * and introducing one here would make the route refuse pastes the server action
 * accepts — the divergence the single write path exists to remove. Whether
 * capture text should be bounded at all is `capture-queue.ts`'s open question and
 * is deliberately not answered here.
 *
 * Characters rather than bytes because that is what is cheap to measure on a
 * string already read, and the ingress caps the body at 2 MB regardless — this is
 * the application-layer backstop (OWASP ASVS V13.2.6), the same role
 * `MAX_BODY_CHARS` plays in `/api/breakdown`.
 */
const MAX_BODY_CHARS = 2 * CAPTURE_QUEUE_MAX_BYTES;

/**
 * The shape a `clientKey` can have: the alphabet all THREE tiers of
 * `newClientKey` produce — a `crypto.randomUUID()` (lowercase hex and dashes, 36
 * chars), its 32-character hex `getRandomValues` form, or the
 * `clk-<ms base36>-<counter base36>` clock-and-counter tier a runtime with no
 * `crypto` at all falls back to (20 chars, lowercase base36 and dashes) — and
 * nothing else.
 *
 * ⚠️ Kept deliberately as one permissive alphabet rather than three alternated
 * patterns. A key this route REFUSES is a capture that can never flush: it stays
 * queued forever while the strip says it is waiting to save, which is a silent
 * permanent stall rather than a refusal anybody sees. So the bound is on length and
 * character set, and `capture-queue.test.ts` asserts the fallback tier lands inside
 * it from the other side.
 *
 * Bounded because this value becomes a key in
 * `BrainDumpItem_workspaceId_clientKey_key`, and an unbounded client-supplied
 * index key is a cost a request should not be able to choose. 64 is comfortably
 * above all three tiers and refuses nothing a browser of this app can send.
 *
 * A file-level literal, as `TASK_ID_SHAPE` is in `/api/breakdown` — nothing here
 * builds a pattern from a variable (`regexp-source-hygiene`).
 */
const CLIENT_KEY_SHAPE = /^[A-Za-z0-9-]{1,64}$/;

/** A validated capture request. */
type CaptureRequest = {
  clientKey: string;
  text: string;
  /** What the CLIENT believes its workspace is. Compared, never trusted. */
  workspaceId: string;
};

/**
 * The body as a capture, or `null` if it could not be one.
 *
 * Untrusted JSON, so every field is checked rather than cast — the point
 * `/api/breakdown` makes about `taskId`, applied to all three. `text` is NOT
 * trimmed or emptiness-checked here: `writeCapture` reads the PARSED text (a
 * capture may be `{just a note}`, which is not empty), and duplicating that rule
 * is how the two write paths would start disagreeing.
 */
function parseCapture(raw: unknown): CaptureRequest | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const { clientKey, text, workspaceId } = raw as Record<string, unknown>;
  if (typeof clientKey !== "string" || !CLIENT_KEY_SHAPE.test(clientKey)) {
    return null;
  }
  if (typeof text !== "string") return null;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return null;
  return { clientKey, text, workspaceId };
}

/** Every response from this route: JSON, and never cached. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // The body describes what happened to somebody's words. Nothing between
      // here and the browser may hold a copy, and a stale one would report a
      // capture as saved that this request never wrote.
      "Cache-Control": "no-store",
    },
  });
}

/**
 * One of the four outcomes `capture-queue.ts` maps a status to.
 *
 * Typed as `FlushOutcome` so the two files cannot drift into different
 * vocabularies: `applyFlushOutcome` decides whether the user's words are dropped
 * from the queue or kept on the strength of these words, and a rename on one side
 * only is a silent data loss rather than a compile error.
 */
function outcome(status: number, flush: FlushOutcome): Response {
  return json(status, { status: flush });
}

export async function POST(req: Request): Promise<Response> {
  // ── CSRF (CWE-352), decided before the body is even read ──────────────────
  //
  // First, because it is the cheapest refusal there is — a header comparison, no
  // body, no session — and because being first is half its value: see the file
  // comment for what a forged request could still cost if it got as far as
  // resolving a session. The house pattern is `logout/route.ts`'s; 400 rather than
  // 403 is deliberate and is explained there too.
  const allowedOrigin = requestOrigin(req);
  const declaredOrigin = req.headers.get("origin");
  if (declaredOrigin && declaredOrigin !== allowedOrigin) {
    // Names the REASON but never the origin we accept. The caller already knows
    // the Origin it sent, so saying it was rejected leaks nothing; the expected
    // value is what a refusal must not hand over, the same way the 409 below does
    // not name the resolved workspace.
    //
    // Distinct from the body-shaped 400s on purpose, and not for the caller's
    // benefit: a misconfigured PUBLIC_ORIGIN would refuse EVERY capture here, and
    // an operator reading "Invalid capture" would go looking at the queue.
    return json(400, { error: "Request origin not allowed" });
  }

  // ── The request, refused as cheaply as it can be ──────────────────────────
  //
  // Everything that can be decided from the body alone is decided before the
  // session is resolved, because this route is reachable with a guest cookie and
  // `currentWorkspaceId()` costs a round trip — two for a signed-in account,
  // which additionally re-reads the owner's status (#220). A queued capture can
  // never be malformed — `readQueue` returns only entries `isQueuedCapture`
  // accepted — so this ordering cannot strand one; it only refuses requests that
  // were never captures.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return json(400, { error: "Could not read the request body" });
  }

  if (rawBody.length > MAX_BODY_CHARS) {
    return json(413, { error: "That capture is too large to save" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const capture = parseCapture(parsed);
  // Deliberately one answer for all three fields. Naming which one was wrong
  // would help nobody: the only client is this app's own queue, whose entries are
  // already validated, so anything reaching here is a hand-made request and the
  // detail is only useful to somebody probing the endpoint.
  if (!capture) return json(400, { error: "Invalid capture" });

  // ── The workspace, from the cookie and from nowhere else ──────────────────
  let workspaceId: string;
  try {
    workspaceId = await currentWorkspaceId();
  } catch (err) {
    // The SUBCLASS first. See the file comment: `RevokedAccountError` is a
    // `MissingWorkspaceError`, and getting these two the wrong way round tells a
    // person whose account was revoked to sign in again — which #220 has made
    // impossible, so they would loop.
    if (err instanceof RevokedAccountError) {
      return outcome(403, "account-revoked");
    }
    if (err instanceof MissingWorkspaceError) {
      return json(401, { error: "Not signed in" });
    }
    // Anything else is an outage, not a caller's problem. Reporting it as a
    // refusal would send somebody with a perfectly good session off to
    // re-authenticate and hide a 500 from whoever is watching the logs — the
    // distinction `/api/export` draws in the same shape.
    throw err;
  }

  // The ONE place the declared workspace is read, and it can only refuse. Not an
  // authorization decision made from client input: the decision was already made
  // by the cookie, and this asks whether the capture still belongs to it.
  if (capture.workspaceId !== workspaceId) {
    // No detail in the body, and specifically not the resolved id — a refusal
    // that named it would let a caller learn whose session it holds by declaring
    // a wrong one on purpose. Same tenancy reasoning as the per-workspace rather
    // than global unique index.
    return outcome(409, "session-expired");
  }

  const written = await writeCapture({
    // The resolved workspace. Never `capture.workspaceId`.
    workspaceId,
    text: capture.text,
    clientKey: capture.clientKey,
  });

  if (written === "empty") {
    // The parser refused everything in the text. Unreachable from the queue —
    // `enqueue` returns `empty` for this before anything is stored — so this is a
    // hand-made request, and 400 says so without inventing a row.
    return json(400, { error: "That capture has no text in it" });
  }

  if (written === "duplicate") {
    // Already saved, by an earlier request that landed after its client stopped
    // waiting. Nothing changed, so nothing is invalidated: the write that did land
    // invalidated the list when it committed.
    return outcome(200, "duplicate");
  }

  // A revalidation is a consequence of the write, so it runs only when there was
  // one — the reading `ensureFocusStep` takes of its own. In a Route Handler this
  // marks `/` for revalidation on its next visit (Next 16,
  // `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/revalidatePath.md`),
  // which is what a capture flushed from the queue needs: the person is not
  // looking at a response, they are about to look at the list.
  revalidatePath("/");
  return outcome(201, "saved");
}
