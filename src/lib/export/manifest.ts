/**
 * #129 — the archive's file list, named once.
 *
 * A separate module from `bundle.ts` on purpose: `README.md` has to describe
 * every other file, and `readme.test.ts` asserts that it does. If the list lived
 * in `bundle.ts` — which imports every serialiser, which imports Prisma types —
 * that test would be reaching through the whole feature to read seven strings,
 * and the tripwire would be easy to break by adding a file to the bundle and not
 * to the list.
 *
 * The order is the order the archive lists them in, and it is deliberate:
 * `README.md` first, because it is the one that tells you what the others are.
 */
export const EXPORT_FILES = [
  "README.md",
  "tasks.md",
  "tasks.csv",
  "steps.csv",
  "inbox.csv",
  "scheduled.ics",
  "export.json",
] as const;

export type ExportFileName = (typeof EXPORT_FILES)[number];
