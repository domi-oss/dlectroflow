import { isoStamp, type ExportSnapshot } from "./types";
import { EXPORT_SCHEMA_VERSION } from "./json";
import { WorkspaceKind } from "@/lib/constants";

/**
 * #129 — `README.md`, the file that makes the other six mean something.
 *
 * The precedent is deliberate: the memory-estate backup ships a `RESTORE.md`
 * alongside its archives because *"in two years, on a different machine, this
 * directory is two opaque blobs unless it explains itself"*. Same job here. An
 * export whose format nobody can work out has not discharged the responsibility
 * it exists to discharge, and the governing requirement for this feature is not
 * "readable" but **usable** — a file you can open and cannot act on is not an
 * answer.
 *
 * So this file has three duties, and the third is the one that is easy to skip:
 *
 *  1. say what each file is;
 *  2. say what is deliberately NOT here;
 *  3. say the things that are true but not guessable — that `VTODO` was rejected
 *     for a reason, that `Task.scheduledAt` did not become a calendar event, that
 *     the CSVs have no byte-order mark so Excel needs telling.
 *
 * `readme.test.ts` asserts (1) against `EXPORT_FILES`, so a file added to the
 * archive and not to this document fails a test rather than shipping as an
 * unexplained blob.
 */
export function exportReadme(snapshot: ExportSnapshot): string {
  const stepCount = snapshot.tasks.reduce((n, t) => n + t.steps.length, 0);
  const turnCount = snapshot.tasks.reduce((n, t) => n + t.turns.length, 0);
  const isGuest = snapshot.workspace.kind === WorkspaceKind.Guest;
  const account = snapshot.account;

  const who = isGuest
    ? [
        "This is a **guest sandbox** export. A sandbox has no account attached to it — that is the point of it — so there is no name on this file.",
        "",
        snapshot.workspace.expiresAt
          ? `**The sandbox itself expires ${isoStamp(snapshot.workspace.expiresAt)}** and is deleted after that. This archive is the only copy that will outlive it, so keep it somewhere you will find again.`
          : "The sandbox is deleted automatically after about a day.",
      ]
    : [
        account
          ? `Signed in as **${account.handle ?? "(no username)"}** via **${account.provider}**${account.email ? ` (${account.email})` : ""}.`
          : "No account information was available at export time.",
      ];

  return [
    "# Your dlectroflow data",

    "",
    `Exported ${isoStamp(snapshot.exportedAt)}.`,
    "",
    ...who,
    "",
    `**What is in here:** ${snapshot.tasks.length} ${snapshot.tasks.length === 1 ? "task" : "tasks"}, ${stepCount} ${stepCount === 1 ? "step" : "steps"}, ${snapshot.inbox.length} ${snapshot.inbox.length === 1 ? "inbox item" : "inbox items"}, ${turnCount} ${turnCount === 1 ? "coaching message" : "coaching messages"}${snapshot.settings ? "" : ", and no settings (nothing had been changed from the defaults)"}.`,
    "",
    "It is one archive with the same data written four ways, because no single format does all four jobs. Nothing here needs dlectroflow to read it.",
    "",

    "## The files",
    "",
    "| File | What it is | Use it when |",
    "| --- | --- | --- |",
    "| `README.md` | This file. | You are reading it. |",
    "| `tasks.md` | Every task with its steps nested underneath, and the coaching conversation that produced them. Plain Markdown. | You want to READ your work — in a text editor, Obsidian, Notes, or anything that will exist in ten years. |",
    "| `tasks.csv` | One row per task: `id`, `title`, `status`, `source`, `scheduled_at`, `schedule_due_at`, `priority`, `hours`, `created_at`. | You want to sort, filter or chart it in a spreadsheet. |",
    "| `steps.csv` | One row per step: `id`, `task_id`, `order`, `total`, `text`, `est_minutes`, `done`, `scheduled_at`. Join to `tasks.csv` on `task_id`. | Same, for the steps. |",
    "| `inbox.csv` | One row per brain-dump item: `id`, `text`, `status`, `est_minutes`, `task_id`, `created_at`, `triaged_at`, `completed_at`. | Same, for your inbox. |",
    "| `scheduled.ics` | The scheduled work as calendar events. | You want it in Google Calendar, Apple Calendar or Outlook. |",
    "| `export.json` | Everything, losslessly, with `schemaVersion` " +
      `${EXPORT_SCHEMA_VERSION}. | You want to move it into another copy of dlectroflow, or write your own script over it. |`,
    "",
    '**Why three CSV files and not one sheet?** CSV cannot express "a task has steps". Flattening them into one sheet would either repeat every task on every step row or drop the steps — and the steps are most of what this app produces. Two files joined on `task_id` is the shape spreadsheets, databases and pandas already understand.',
    "",

    "## Things worth knowing",
    "",
    "- **Every timestamp is ISO-8601 in UTC**, with the `Z` on the end: `2026-08-03T09:30:00.000Z`. Your local time may differ; UTC means the same instant in every tool that will ever open these files.",
    "- **The CSVs are RFC 4180 and UTF-8, with no byte-order mark.** Task and inbox text contains line breaks and quotes, and they are quoted properly, so any real CSV reader will handle them. **Microsoft Excel** guesses the encoding and will mangle accents and emoji if you double-click the file — open it with Data → From Text/CSV and choose UTF-8 instead. Numbers, LibreOffice, Google Sheets and pandas need no help.",
    "- **`scheduled.ics` uses `VEVENT`, not `VTODO`.** `VTODO` is the *correct* iCalendar component for a task — it has a due date and a completion state. **Google Calendar ignores `VTODO` entirely**, so a file that used it would import successfully and show you nothing. `VEVENT` is the wrong word for the right outcome.",
    "- **Which rows became calendar events:** every **scheduled step** (at its time, for as long as it was estimated to take), and every task with a **due date** (as a short marker at the deadline). Nothing else. In particular, a task's `scheduled_at` records *when you scheduled it*, not *when to do it*, so it is not an event — you will find it in `tasks.csv` and `export.json` instead.",
    "- **The calendar events are not marked busy**, so importing them will not block out your calendar.",
    "- **The ids are stable.** They are the same ids dlectroflow uses internally, so a future import can recognise what it has already seen instead of duplicating it.",
    "",

    "## What is not in this archive",
    "",
    "- **Your Google connection.** dlectroflow holds OAuth tokens for Google Tasks encrypted in its database, and **they are not in this export** — not even encrypted. `export.json` records only whether a connection existed. **Restoring this archive somewhere else will not reconnect your Google account**; you would connect it again from Settings. Nothing in your Google account is affected by exporting.",
    "- **Your API key.** If you had added your own LLM API key, it is stored encrypted and is not exported. Keep your copy of it.",
    '- **An importer.** There is no "restore from export" button yet. `export.json` is the file designed for it — it is lossless and versioned — but today getting the data back in means a script.',
    "- **Streaks, badges, points, daily rollups and sparks are in `export.json` only**, not in `tasks.md` or the CSVs. They are calculated from your activity rather than typed by you, and they do not port anywhere.",
    "- **`estimateHistory` and the Google task identifiers are in `export.json` only.** The first is a list inside one field, which does not belong in a spreadsheet cell; the second identifies rows inside a Google account and means nothing outside it.",
    "",

    "## Getting a copy of anything else",
    "",
    "This is everything dlectroflow holds about your account that is yours. If you think something is missing, or you want it in another format, the Privacy Policy at `/privacy` says how to ask and how long the answer takes.",
  ]
    .join("\n")
    .trimEnd()
    .concat("\n");
}
