/**
 * RFC 4180 CSV serialisation (#129 — a member can export their own data).
 *
 * Hand-written rather than added as a dependency, and that is not
 * not-invented-here: the whole standard is three rules (comma between fields,
 * CRLF between records, quote-and-double when a field contains any of them),
 * and the alternative was a package in a lockfile that this repo can only
 * regenerate inside the CI image. Writing CSV is not the hard half of CSV —
 * *parsing* it is, and nothing here parses.
 *
 * The rules, from §2:
 *
 *  - **CRLF between records** (§2.1), including after the last one. §2.2 makes
 *    the final break optional; emitting it means a file can be concatenated or
 *    appended to without silently joining two records.
 *  - **Fields containing a comma, a double quote, CR or LF are enclosed in
 *    double quotes** (§2.6), and an embedded double quote is doubled (§2.7).
 *    This is the rule that makes the export survive real data: brain-dump text
 *    and task titles are typed into a textarea, so they contain newlines, and a
 *    naive `values.join(",")` turns one item into two half-rows.
 *  - **UTF-8, and no byte-order mark.** RFC 4180 does not have a BOM, and a
 *    stray U+FEFF becomes part of the first header name for every strict
 *    parser. Excel on Windows guesses the wrong encoding without one, which is
 *    why the export's README tells the reader to pick UTF-8 on import — a note
 *    in a file beats corrupting the file for everyone who is not Excel.
 *
 * ## Formula injection is deliberately NOT mitigated here
 *
 * A field beginning `=`, `+`, `-` or `@` is evaluated as a formula by Excel and
 * Sheets (CWE-1236), and the usual mitigation is to prefix it with an
 * apostrophe. This module does not, because of *who writes these rows*: every
 * one of them is content the exporting account typed or generated in its own
 * workspace, and there is no path by which another person's text reaches it —
 * workspaces are single-tenant, there is no sharing feature, and the export is
 * scoped to the caller's own workspace (see `src/lib/export/collect.ts`). So the
 * only person a formula could be smuggled to is the person who wrote it.
 *
 * Against that, mangling the data is a real cost: the governing requirement for
 * this export is that it stay usable, and a task called "-  buy milk" coming
 * back as "'-  buy milk" is a silent corruption of the thing being handed over.
 * If a future feature ever lets one account write content another account can
 * export, this decision changes and the mitigation belongs here.
 */

/** What a cell may hold. `Date` is deliberately absent: this module has no
 *  opinion on timestamp format, and the export's is load-bearing (ISO-8601 with
 *  an explicit offset — see `src/lib/export/types.ts`). Callers format first. */
export type CsvValue = string | number | boolean | null | undefined;

/**
 * Characters that force quoting. The comma, the quote and both line-break
 * characters come straight from §2.6; CR is listed separately from LF because a
 * lone CR (classic Mac line ending, and what some clipboards paste) would
 * otherwise pass through unquoted and be read as a record separator.
 */
const MUST_QUOTE = /[",\r\n]/;

/** Leading/trailing whitespace is part of the field per §2.4, but enough
 *  parsers trim unquoted fields that quoting is the only way to round-trip it. */
const EDGE_WHITESPACE = /^\s|\s$/;

export function csvField(value: CsvValue): string {
  if (value == null) return "";
  if (typeof value === "number") {
    // NaN/Infinity have no CSV representation. "NaN" in a numeric column is a
    // value a spreadsheet will sort and sum; empty is the honest answer.
    if (!Number.isFinite(value)) return "";
    return String(value);
  }
  const text = typeof value === "string" ? value : String(value);
  if (MUST_QUOTE.test(text) || EDGE_WHITESPACE.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** One record's fields, comma-separated. No line terminator — `toCsv` adds it. */
export function csvRow(values: readonly CsvValue[]): string {
  return values.map(csvField).join(",");
}

/** Pluralised count, so a one-field row does not report "1 columns". The message
 *  is what a developer sees at the moment they are already confused about a
 *  column shift; it should not add a second thing to squint at. */
function columns(n: number): string {
  return `${n} ${n === 1 ? "column" : "columns"}`;
}

/**
 * A complete CSV document: header record, then one record per row, CRLF
 * throughout and a final CRLF.
 *
 * Ragged rows THROW rather than being padded. A row with the wrong width is a
 * column shift — every value after the gap lands under the wrong heading, which
 * a spreadsheet renders without complaint and a reader has no way to notice.
 * Failing at the call site is the only outcome that cannot be mistaken for
 * correct data.
 */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly CsvValue[])[],
): string {
  const lines = [csvRow(header)];
  for (const [index, row] of rows.entries()) {
    if (row.length !== header.length) {
      throw new Error(
        `CSV row ${index} has ${columns(row.length)}, expected ${columns(header.length)}`,
      );
    }
    lines.push(csvRow(row));
  }
  // Trailing CRLF: `join` plus a final one, so the last record is terminated.
  return lines.join("\r\n") + "\r\n";
}
