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

  it("says the account records ARE in the archive, and names credentials as the exclusion", () => {
    // /privacy and this file are one disclosure read in two places, and
    // `docs/legal.md` says so: "those two wordings move together".
    //
    // POLARITY FLIPPED. The previous version of this test asserted that the
    // archive NAMED four kinds of held-but-unexported bookkeeping — the invitation
    // row and its note (`Allowlist`), the AI usage count (`UserAiUsage`), the
    // calendar feed's timestamps (`CalendarFeed`) and the account flags on `User`.
    // All four are now IN the download, so an archive still listing them as
    // withheld would be false, and the accurate wording is the one this asserts.
    // The pattern kept, the polarity reversed — the same move `docs/legal.md`
    // records for the Terms' export sentence when #129 shipped.
    expect(readme).toContain("What is not in this archive");

    // What remains excluded is credentials, and all THREE of them: the two the
    // page already named plus the calendar feed's token, which had never been
    // called one because the whole row was absent.
    expect(readme.toLowerCase()).toMatch(/oauth token/); // GoogleAuth
    expect(readme.toLowerCase()).toMatch(/api key/); // User.llmKeyEnc
    expect(readme.toLowerCase()).toMatch(
      /feed'?s? (own )?(secret )?(address|url|token)|token in your calendar/,
    ); // CalendarFeed.token

    // And the four records must be positively described as present, or "not in
    // this archive" could simply have gone quiet about them — which is the
    // failure this whole change exists to remove, one layer up.
    expect(readme.toLowerCase()).toContain("invitation"); // Allowlist
    expect(readme.toLowerCase()).toMatch(/usage count|ai usage/); // UserAiUsage
    expect(readme.toLowerCase()).toContain("calendar subscription"); // CalendarFeed
    expect(readme.toLowerCase()).toMatch(/active or revoked/); // User.status
    expect(readme.toLowerCase()).toMatch(/last seen/); // User.lastSeenAt
    expect(readme.toLowerCase()).toMatch(/id your sign-in provider issued/); // providerSub

    // The stale claims, asserted absent so the flip cannot be half-done. Each is
    // a phrase that was TRUE when written and is false now.
    expect(
      readme,
      "the README still says the account records are not in these files",
    ).not.toMatch(/they are not in these files/i);
    expect(
      readme,
      "the README still tells the reader to ask for the invitation note by hand",
    ).not.toMatch(/the Privacy Policy at `\/privacy` says how to ask, and the invitation note is included in that/i);
    // The overclaim in the other direction. Fixing the omission must not bring
    // back "everything", because credentials are still withheld.
    expect(
      readme,
      "the README claims to hold everything, which is still not true",
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
        // A guest sandbox has no account, so none of the three account records
        // exists to hang off one.
        accountRecords: {
          invitation: null,
          aiUsage: null,
          calendarFeed: null,
        },
        workspace: {
          id: "ws-guest",
          kind: "guest",
          createdAt: new Date(Date.UTC(2026, 7, 3, 6, 0, 0)),
          lastSeenAt: new Date(Date.UTC(2026, 7, 3, 8, 0, 0)),
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
