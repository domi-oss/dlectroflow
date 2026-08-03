import { describe, it, expect } from "vitest";
import { csvField, csvRow, toCsv } from "./csv";

describe("csvField — RFC 4180 §2", () => {
  it("leaves a plain field unquoted", () => {
    expect(csvField("plain")).toBe("plain");
  });

  it("quotes a field containing a comma", () => {
    expect(csvField("a,b")).toBe('"a,b"');
  });

  it("quotes a field containing a double quote, and doubles the quote", () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes a field containing LF, and keeps the newline inside the quotes", () => {
    // The case that breaks naive CSV, and the case this codebase actually
    // produces: brain-dump text and task titles are typed into a textarea.
    expect(csvField("line one\nline two")).toBe('"line one\nline two"');
  });

  it("quotes a field containing CR or CRLF", () => {
    expect(csvField("a\r\nb")).toBe('"a\r\nb"');
    expect(csvField("a\rb")).toBe('"a\rb"');
  });

  it("quotes a field with leading or trailing whitespace", () => {
    // RFC 4180 §2.4 says spaces are part of the field, but enough parsers trim
    // unquoted fields that " x " round-trips more reliably quoted.
    expect(csvField(" x")).toBe('" x"');
    expect(csvField("x ")).toBe('"x "');
    expect(csvField("\tx")).toBe('"\tx"');
  });

  it("renders null and undefined as an empty, unquoted field", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("renders booleans as true/false and finite numbers as themselves", () => {
    expect(csvField(true)).toBe("true");
    expect(csvField(false)).toBe("false");
    expect(csvField(0)).toBe("0");
    expect(csvField(-12.5)).toBe("-12.5");
  });

  it("renders a non-finite number as empty rather than as the word NaN", () => {
    // "NaN" in a numeric column is a value a spreadsheet will happily sort;
    // empty is the honest representation of "no number".
    expect(csvField(Number.NaN)).toBe("");
    expect(csvField(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("keeps a quote-only field quoted and doubled", () => {
    expect(csvField('"')).toBe('""""');
  });
});

describe("csvRow", () => {
  it("joins fields with commas", () => {
    expect(csvRow(["a", "b", "c"])).toBe("a,b,c");
  });

  it("preserves empty fields in the middle of a row", () => {
    expect(csvRow(["a", null, "c"])).toBe("a,,c");
  });
});

describe("toCsv", () => {
  it("emits CRLF line endings, including after the last record", () => {
    const csv = toCsv(["id", "title"], [["1", "one"]]);
    expect(csv).toBe("id,title\r\n1,one\r\n");
  });

  it("emits a header-only file when there are no rows", () => {
    // The empty state: a brand-new account with no tasks still gets a file a
    // spreadsheet can open, with the columns named.
    expect(toCsv(["id", "title"], [])).toBe("id,title\r\n");
  });

  it("does not let an embedded newline be mistaken for a record separator", () => {
    const csv = toCsv(
      ["id", "text"],
      [
        ["1", "one\ntwo"],
        ["2", "three"],
      ],
    );
    // Three physical lines, two records: the embedded LF sits inside quotes and
    // is not preceded by a CR, so a CRLF-splitting parser sees two records.
    expect(csv).toBe('id,text\r\n1,"one\ntwo"\r\n2,three\r\n');
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(3);
  });

  it("refuses a row whose width does not match the header", () => {
    // A ragged row is a silent column shift in every spreadsheet, so it fails
    // loudly at the call site instead.
    expect(() => toCsv(["a", "b"], [["1"]])).toThrow(/2 columns/);
  });
});
