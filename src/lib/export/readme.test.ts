import { describe, it, expect } from "vitest";
import { exportReadme } from "./readme";
import { EXPORT_FILES } from "./manifest";
import { makeSnapshot, makeEmptySnapshot } from "./__tests__/fixture";

const readme = exportReadme(makeSnapshot());

describe("README.md — the file that explains the archive", () => {
  it("names every other file in the archive", () => {
    // The precedent this copies: an archive that does not explain itself is two
    // opaque blobs in two years, on a different machine. A file present in the
    // zip and missing from the README is the specific way that happens.
    for (const name of EXPORT_FILES) {
      if (name === "README.md") continue;
      expect(readme, `${name} is not described`).toContain(name);
    }
  });

  it("says what each file is FOR, not just that it exists", () => {
    expect(readme).toContain("tasks.md");
    expect(readme).toContain("spreadsheet");
    expect(readme).toContain("calendar");
    expect(readme).toContain("schemaVersion");
  });

  it("says EXPLICITLY that the Google connection is not included", () => {
    // The one omission a user could actively be harmed by misunderstanding: they
    // must not infer that restoring this archive restores their Google Tasks
    // connection. Silently leaving it out would be the more misleading choice.
    expect(readme).toMatch(/Google/);
    expect(readme).toMatch(/not included|is not in|excluded/i);
    expect(readme.toLowerCase()).toContain("token");
  });

  it("names the account bookkeeping it withholds, and does not claim to be everything", () => {
    // /privacy and this file are one disclosure read in two places, and
    // `docs/legal.md` says so: "those two wordings move together". The page now
    // names four kinds of held-but-unexported bookkeeping — the invitation row
    // and its note (`Allowlist`), the AI usage count (`UserAiUsage`), the
    // calendar feed's timestamps (`CalendarFeed`) and the account flags
    // (`User.status` / `lastSeenAt`) — so an archive still saying it holds
    // "everything dlectroflow holds about your account" is the weaker of two
    // statements of the same fact, and the one a reader gets AFTER they have
    // stopped reading the page.
    // One assertion per omitted model, because the first version of this test
    // named only two of the four and its own comment claimed all four — the
    // same shape of gap the sweep is closing, reproduced in the guard for it.
    // A future edit dropping any single category must red this.
    expect(readme).toContain("What is not in this archive");
    expect(readme.toLowerCase()).toContain("invitation"); // Allowlist
    expect(readme.toLowerCase()).toMatch(/usage count|ai usage/); // UserAiUsage
    expect(readme.toLowerCase()).toContain("calendar subscription feed"); // CalendarFeed
    // User: all four omitted columns, not just the two that were easy to phrase.
    expect(readme.toLowerCase()).toMatch(/active or revoked/); // status
    expect(readme.toLowerCase()).toMatch(/last seen/); // lastSeenAt
    expect(readme.toLowerCase()).toMatch(/access was withdrawn/); // revokedAt
    expect(readme.toLowerCase()).toMatch(/id your sign-in provider issued/); // providerSub
    // `provider` and `handle` ARE exported, so the archive must not imply
    // otherwise while disclosing `providerSub`. This is the distinction Duo's
    // suggested wording collapsed, and collapsing it would trade one
    // inaccuracy for another.
    expect(
      readme.toLowerCase(),
      "the archive must not claim the provider's name is withheld — it is exported",
    ).toContain("provider's *name* and your username are in");
    // The overclaim itself. A reader who opens the zip must not be told the
    // list they just read is exhaustive when the page says it is not.
    expect(
      readme,
      "the README still claims to be everything held about the account",
    ).not.toMatch(/This is everything dlectroflow holds/);
  });

  it("explains why VEVENT and not VTODO", () => {
    expect(readme).toContain("VEVENT");
    expect(readme).toContain("VTODO");
    expect(readme).toContain("Google Calendar");
  });

  it("says which rows became calendar events and which did not", () => {
    // The rule is not guessable from the file, and an unexplained absence is
    // exactly what an export must not have.
    expect(readme).toContain("due");
    expect(readme.toLowerCase()).toContain("scheduled step");
  });

  it("states the timestamp format", () => {
    expect(readme).toContain("ISO-8601");
    expect(readme).toContain("UTC");
  });

  it("tells the reader the CSVs are UTF-8, and how to open them in Excel", () => {
    // No byte-order mark, by RFC 4180 — which means Excel on Windows guesses the
    // wrong encoding unless told. A note in a file beats corrupting the file for
    // every parser that is not Excel.
    expect(readme).toContain("UTF-8");
    expect(readme).toContain("Excel");
  });

  it("says there is no importer yet, rather than implying a round trip works", () => {
    expect(readme.toLowerCase()).toContain("import");
  });

  it("lists what is NOT here in one place", () => {
    expect(readme).toContain("What is not in this archive");
  });

  it("says when it was exported and by which account", () => {
    expect(readme).toContain("2026-08-03T09:30:00.000Z");
    expect(readme).toContain("sam");
    expect(readme).toContain("gitlab");
  });

  it("does not name an account for a guest sandbox, and says the sandbox expires", () => {
    const guest = exportReadme(
      makeSnapshot({
        account: null,
        workspace: {
          id: "ws-guest",
          kind: "guest",
          createdAt: new Date(Date.UTC(2026, 7, 3, 6, 0, 0)),
          expiresAt: new Date(Date.UTC(2026, 7, 4, 6, 0, 0)),
        },
      }),
    );
    expect(guest).toContain("guest sandbox");
    expect(guest).toContain("2026-08-04T06:00:00.000Z");
    expect(guest).not.toContain("Signed in as");
  });

  it("counts what is in the archive, so a reader can tell a full export from an empty one", () => {
    expect(readme).toContain("3 tasks");
    expect(readme).toContain("2 steps");
    expect(readme).toContain("2 inbox items");
  });

  it("is honest about an empty account rather than reporting a broken export", () => {
    const empty = exportReadme(makeEmptySnapshot());
    expect(empty).toContain("0 tasks");
    expect(empty).toContain("no settings");
  });

  it("ends with a single trailing newline", () => {
    expect(readme.endsWith("\n")).toBe(true);
    expect(readme.endsWith("\n\n")).toBe(false);
  });
});
