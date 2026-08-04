import { buildZip, type ZipEntry } from "@/lib/zip";

import { isoDate, type ExportSnapshot } from "./types";
import { EXPORT_FILES } from "./manifest";
import { exportReadme } from "./readme";
import { tasksMarkdown } from "./markdown";
import { tasksCsv, stepsCsv, inboxCsv } from "./csv-files";
import { scheduledIcs } from "./calendar";
import { exportJson } from "./json";

/**
 * #129 — turn one snapshot into one archive.
 *
 * Pure, and deliberately so: it takes the snapshot `collect.ts` produced and
 * returns bytes. Nothing here reads a cookie, a session or a request, which is
 * what lets `bundle.test.ts` assert on the real archive — reading entries back
 * out of the zip — with no database and no mocking.
 *
 * The route is the only caller, and it resolves the workspace itself before
 * calling `collectExport`. That keeps authorization in exactly one place and
 * leaves this module with nothing to get wrong about whose data it is holding.
 */

/**
 * Make a handle safe for a filename AND for a `Content-Disposition` header.
 *
 * Both matter, and the header is the sharper edge: a quote or a CR in a filename
 * would let a handle break out of the header value. So this is an ALLOWLIST down
 * to `[a-z0-9-]` rather than a list of characters to strip — the failure mode of
 * an allowlist is a boring filename, and the failure mode of a denylist is the
 * one character nobody thought of.
 *
 * A handle with no Latin characters at all (a Cyrillic or Han username is
 * perfectly valid at the provider) slugifies to nothing, so it falls back to
 * `account`: the name of the file is not the place to fight that battle, and the
 * archive says who it belongs to inside `README.md` and `export.json`.
 */
function slugifyHandle(handle: string | null | undefined): string {
  const slug = (handle ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    // Re-trim: a 24-character cut can land on a hyphen.
    .replace(/-+$/g, "");
  return slug || "account";
}

/**
 * `dlectroflow-export-<user>-<YYYY-MM-DD>.zip`, per the agreed format.
 *
 * No account means "guest", and the test is `account == null` rather than
 * `workspace.kind === "guest"`: what the filename needs is an identity, and a
 * sandbox has none — that is the point of it (see `/privacy`). Naming the file
 * after the workspace id instead would put an opaque uuid in somebody's Downloads
 * folder. A signed-in account whose provider withheld a username still gets
 * `account`, which keeps the two cases distinguishable.
 */
export function exportFilename(snapshot: ExportSnapshot): string {
  const who = snapshot.account
    ? slugifyHandle(snapshot.account.handle)
    : "guest";
  return `dlectroflow-export-${who}-${isoDate(snapshot.exportedAt)}.zip`;
}

/**
 * The archive's contents, in `EXPORT_FILES` order.
 *
 * Every file is produced for every export, including an empty account's: a file
 * that appears only when there is data to put in it makes a thin export
 * indistinguishable from a broken one, and `README.md` is the file most needed
 * exactly when there is least else in the archive.
 */
export function exportFileEntries(snapshot: ExportSnapshot): ZipEntry[] {
  const byName: Record<(typeof EXPORT_FILES)[number], string> = {
    "README.md": exportReadme(snapshot),
    "tasks.md": tasksMarkdown(snapshot),
    "tasks.csv": tasksCsv(snapshot),
    "steps.csv": stepsCsv(snapshot),
    "inbox.csv": inboxCsv(snapshot),
    "scheduled.ics": scheduledIcs(snapshot),
    "export.json": exportJson(snapshot),
  };
  // Driven off EXPORT_FILES rather than off `Object.entries`, so the order is the
  // documented one and a file added to the record without being added to the
  // manifest cannot silently appear in the archive undescribed.
  return EXPORT_FILES.map((name) => ({ name, data: byName[name] }));
}

export type ExportArchive = {
  filename: string;
  /** See `buildZip`'s return type for why the buffer type is pinned. */
  bytes: Uint8Array<ArrayBuffer>;
};

export function buildExportArchive(snapshot: ExportSnapshot): ExportArchive {
  return {
    filename: exportFilename(snapshot),
    bytes: buildZip(exportFileEntries(snapshot), {
      // Every entry carries the export's own instant, so the archive's listing
      // agrees with the timestamp inside README.md and export.json.
      modifiedAt: snapshot.exportedAt,
    }),
  };
}
