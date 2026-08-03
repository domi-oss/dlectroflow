import { currentWorkspaceId, currentUser } from "@/lib/workspace";
import { collectExport } from "@/lib/export/collect";
import { buildExportArchive } from "@/lib/export/bundle";
import { exportCooldown } from "@/lib/export/cooldown";

/**
 * #129 — download everything this account holds, as one archive.
 *
 * ## It takes no input, which is the whole security design
 *
 * No route parameter, no query string, no body. Both ids handed to
 * `collectExport` come from the verified session — `currentWorkspaceId()` for the
 * workspace, `currentUser()` for the account — so there is nothing in the request
 * for a caller to point at somebody else's data. `src/app/actions/account.ts`
 * Rule 1 applied to a read: an argument that does not exist cannot be forged, and
 * cannot be dropped by a later refactor the way an `=== me.id` check can. The
 * cross-workspace guarantee is proved against a real database in
 * `src/lib/export/collect.integration.test.ts`.
 *
 * ## Guests can export, deliberately
 *
 * #129 asked for this to be decided rather than defaulted. A guest sandbox is
 * exportable, and its expiry is the reason: a sandbox is deleted after about a
 * day, so an export is the ONLY way anything done in one survives — and the
 * person who typed it is the person downloading it. It also needs no new gate:
 * `/api/export` is not in `AUTHENTICATED_PREFIXES`, so `src/proxy.ts` mints a
 * signed guest workspace token exactly as it does for the rest of the app, and
 * `currentWorkspaceId()` resolves it the same way the per-task ICS route already
 * does. `README.md` inside the archive tells a guest that the sandbox itself is
 * going away and when.
 *
 * ## Node runtime, and no cache
 *
 * `nodejs` because the archive is built with `node:zlib`. `no-store` because the
 * response contains the whole of somebody's account: a shared or intermediary
 * cache must never hold it, and a stale copy would silently hand back yesterday's
 * data with today's filename.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let workspaceId: string;
  try {
    workspaceId = await currentWorkspaceId();
  } catch {
    // `MissingWorkspaceError` — no session of any kind. `src/proxy.ts` redirects
    // browsers before they reach here, so this is a direct call with no cookie;
    // 401 with a plain body is the honest answer to it.
    return new Response("Not signed in", {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // Metered BEFORE the work, not after: the point is to not do the work. Keyed on
  // the workspace, so one busy account can never refuse another person their own
  // data (see `cooldown.ts` for what this does and does not claim to stop).
  const verdict = exportCooldown.check(workspaceId);
  if (!verdict.allowed) {
    return new Response(
      `An export was already prepared for this account moments ago. Try again in ${verdict.retryAfterSec} seconds.`,
      {
        status: 429,
        headers: {
          "Retry-After": String(verdict.retryAfterSec),
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const me = await currentUser();
  const snapshot = await collectExport({
    workspaceId,
    // A guest has no account, and `collectExport` answers the account block with
    // null rather than querying for one.
    userId: me?.id ?? null,
  });
  const { filename, bytes } = buildExportArchive(snapshot);

  return new Response(bytes, {
    headers: {
      "Content-Type": "application/zip",
      // The filename is built from an allowlisted slug (`bundle.ts`), so it
      // cannot carry a quote, a newline or a non-ASCII byte into this header.
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
      // Belt and braces on the download path: the body is an archive, and nothing
      // should ever be tempted to sniff it into something renderable.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
