import { isoStamp, type ExportSnapshot, type ExportTask } from "./types";
import { TurnRole } from "@/lib/constants";

/**
 * #129 — `tasks.md`, the human tier.
 *
 * It answers one question the other three files cannot: *"can I still read this
 * in ten years?"* Markdown — not CSV — is the human format here, because it is
 * the only readable one that keeps steps NESTED UNDER their task, and it drops
 * straight into Obsidian, Notes, or any text editor that will ever exist.
 *
 * Which means the formatting decisions are not cosmetic. Two in particular:
 *
 *  - **A task title is flattened onto its heading line.** Titles can contain
 *    newlines (they come from a textarea), and a raw newline inside a `##` line
 *    ends the heading — everything after it renders as body text, so the task
 *    silently loses its title. The unflattened original is in `export.json`.
 *  - **A step's continuation lines are indented, and a coaching message is
 *    blockquoted.** Markdown ends a list item at an unindented line and ends a
 *    paragraph at a blank one, so multi-line content that is not indented or
 *    quoted detaches from the thing it belongs to. The failure is silent and only
 *    visible once rendered, which is the worst kind for an archive.
 *
 * Empty values are OMITTED rather than printed as "Due: —". A file of empty
 * labels reads as a broken export; an absent line reads as "there is nothing to
 * say", which is true.
 */

/** Collapse any run of whitespace, so a value can live on one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Continue a multi-line value inside a Markdown list item.
 *
 * Six spaces because the item's own prefix is `- [x] ` — a continuation has to
 * clear the marker and the checkbox to stay part of the same item.
 */
function indentContinuation(text: string): string {
  return text.replace(/\n/g, "\n      ");
}

/** A blockquote, blank lines included (`>` on its own for the blank ones — a
 *  truly blank line would end the quote and orphan the rest of the message). */
function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

function stepLine(step: ExportTask["steps"][number]): string {
  const box = step.done ? "[x]" : "[ ]";
  const emoji = step.subtaskEmoji ? `${step.subtaskEmoji} ` : "";
  const meta = [
    `${step.estMinutes} min`,
    step.scheduledAt ? `scheduled ${isoStamp(step.scheduledAt)}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return `- ${box} ${emoji}${indentContinuation(step.text)} (${meta})`;
}

function taskSection(task: ExportTask): string {
  const emoji = task.parentEmoji ? `${task.parentEmoji} ` : "";
  const lines: string[] = [`## ${emoji}${oneLine(task.title)}`, ""];

  const facts: string[] = [`- Status: ${task.status}`];
  facts.push(`- Created: ${isoStamp(task.createdAt)}`);
  if (task.scheduleDueAt) facts.push(`- Due: ${isoStamp(task.scheduleDueAt)}`);
  if (task.scheduledAt) {
    // Named "First scheduled" rather than "Scheduled", because that is what the
    // column means: the marker is stamped once, by whichever method got there
    // first, and it is not a slot in anybody's day.
    const via = task.scheduledVia ? ` (via ${task.scheduledVia})` : "";
    facts.push(`- First scheduled: ${isoStamp(task.scheduledAt)}${via}`);
  }
  if (task.schedulePriority) facts.push(`- Priority: ${task.schedulePriority}`);
  if (task.scheduleHours) facts.push(`- Hours: ${task.scheduleHours}`);
  facts.push(`- Source: ${task.source}`);
  facts.push(`- id: \`${task.id}\``);
  lines.push(...facts, "");

  // #44 — the user's own note, above the steps because it is context for doing
  // them. Its own quoted section rather than another `- Note:` fact line: the
  // note is multi-line prose, and a fact list that grows a paragraph stops being
  // scannable — the same call `taskSection` already makes for the coaching
  // turns. `blockquote` prefixes every line, so a blank line inside the note
  // cannot terminate the quote and leave the remainder rendering as body text.
  if (task.notes) {
    lines.push("### Note", "", blockquote(task.notes), "");
  }

  if (task.steps.length > 0) {
    lines.push("### Steps", "");
    lines.push(...task.steps.map(stepLine));
    lines.push("");
  }

  if (task.turns.length > 0) {
    lines.push("### Coaching conversation", "");
    for (const turn of task.turns) {
      // "dlectroflow" rather than "Assistant": the export should name the thing
      // the person was talking to, not the role string the database stores.
      const who = turn.role === TurnRole.User ? "You" : "dlectroflow";
      lines.push(`**${who}** — ${isoStamp(turn.createdAt)}`, "");
      lines.push(blockquote(turn.message), "");
    }
  }

  return lines.join("\n");
}

export function tasksMarkdown(snapshot: ExportSnapshot): string {
  const header = [
    "# dlectroflow — tasks",
    "",
    `Exported ${isoStamp(snapshot.exportedAt)}.`,
    "",
    `${snapshot.tasks.length} ${snapshot.tasks.length === 1 ? "task" : "tasks"}, with their steps nested underneath and the coaching conversation that produced them.`,
    "",
    "Your brain-dump inbox is in `inbox.csv` and `export.json`; everything, losslessly, is in `export.json`. See `README.md`.",
    "",
  ];

  if (snapshot.tasks.length === 0) {
    // An empty file would be indistinguishable from a failed export, which is the
    // one thing an archive must never be ambiguous about.
    return [
      ...header,
      "No tasks yet — there was nothing in this account's task list when it was exported.",
      "",
    ].join("\n");
  }

  return (
    [...header, ...snapshot.tasks.map(taskSection)].join("\n").trimEnd() + "\n"
  );
}
