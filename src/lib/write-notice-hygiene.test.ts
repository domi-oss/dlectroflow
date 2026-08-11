/**
 * #246 / #236 — the surface-to-file map, and the scan over the real tree.
 *
 * The parsers are exercised on synthetic sources first, so a failure here says
 * whether the repo drifted or the parser did — the same split
 * `inbox-write-hygiene` and `a11y-class-hygiene` use.
 *
 * See `write-notice-hygiene.ts` for why this guard exists. The short version:
 * `shopping.errorSaveTimeoutGone` did not exist, `writeFailureKey` fell through
 * to the timeout copy, and the surface read as fixed to anyone auditing by grep
 * for the helper rather than for the strings. Nothing failed. Four surfaces carry
 * a notice of this shape and it has drifted three times (#218, #236, and a round
 * inside `!306`), so the assertion is written across surfaces, once.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { STRINGS } from "@/lib/strings";
import {
  WRITE_NOTICE_MESSAGE_SUFFIXES,
  liveRegionsIn,
  missingWriteNoticeKeys,
  nestedLiveRegions,
  politeAnnouncersOf,
  stringLiteralsIn,
  writeNoticeCopyFaults,
  writeNoticeSuffixes,
  writeNoticeSurfaces,
  type VoicedStrings,
} from "@/lib/write-notice-hygiene";

/** A minimal, coherent surface, used as the base every synthetic fault edits. */
const coherent = (over: Record<string, string> = {}): VoicedStrings => {
  const text: Record<string, string> = {
    "x.errorSaveFailed": "Couldn't save that just now:",
    "x.errorSaveStale":
      "The app updated while this was open, so that didn't save. Reload to carry on:",
    "x.errorSaveTimeout":
      "No answer from the server, so this may already have saved. Check the list before trying again:",
    "x.errorSaveGone":
      "That item is not on the list any more, so nothing changed:",
    "x.errorSaveTimeoutGone":
      "No answer from the server, and that item is not on the list any more — so it may already have saved:",
    "x.errorRetry": "Try again",
    "x.errorReload": "Reload the page",
    "x.errorSaving": "Saving…",
    ...over,
  };
  return Object.fromEntries(
    Object.entries(text).map(([key, value]) => [
      key,
      { plain: value, playful: value },
    ]),
  );
};

const whys = (faults: { why: string }[]) =>
  faults.map((f) => f.why).join(" | ");

describe("writeNoticeSurfaces — enrolment is automatic, not a list", () => {
  it("names the prefix that owns an errorSaveTimeout", () => {
    expect(
      writeNoticeSurfaces(["a.errorSaveTimeout", "a.errorSaveGone"]),
    ).toEqual(["a"]);
  });

  it("finds every surface, sorted, and does not double-count one", () => {
    expect(
      writeNoticeSurfaces([
        "shopping.errorSaveTimeout",
        "inbox.errorSaveTimeout",
        "inbox.errorSaveGone",
      ]),
    ).toEqual(["inbox", "shopping"]);
  });

  it("does not enrol a surface on a merely similar key", () => {
    expect(
      writeNoticeSurfaces([
        "capture.error.timeout",
        "breakdown.eject.timeout",
        "x.errorSaveTimeoutGone",
      ]),
    ).toEqual([]);
  });
});

describe("missingWriteNoticeKeys (rule A)", () => {
  it("says nothing about a surface that carries the whole set", () => {
    expect(missingWriteNoticeKeys("x", Object.keys(coherent()))).toEqual([]);
  });

  /**
   * The non-zero control for rule A, and the exact shape of #246: four of the
   * five cells present, the `timedOut && rowGone` pair absent.
   */
  it("reports the timeout-and-gone cell when it is the only one absent", () => {
    const keys = Object.keys(coherent()).filter(
      (k) => k !== "x.errorSaveTimeoutGone",
    );
    expect(missingWriteNoticeKeys("x", keys)).toEqual([
      "x.errorSaveTimeoutGone",
    ]);
  });

  it("reports an absent control, not only an absent message", () => {
    const keys = Object.keys(coherent()).filter((k) => k !== "x.errorReload");
    expect(missingWriteNoticeKeys("x", keys)).toEqual(["x.errorReload"]);
  });

  it("does not require the optional feature-flag cell", () => {
    expect(writeNoticeSuffixes()).toContain("errorSaveOff");
    expect(missingWriteNoticeKeys("x", Object.keys(coherent()))).not.toContain(
      "x.errorSaveOff",
    );
  });
});

describe("writeNoticeCopyFaults (rule B)", () => {
  it("passes a surface whose copy agrees with its controls", () => {
    expect(writeNoticeCopyFaults("x", coherent())).toEqual([]);
  });

  /**
   * The fault #246 and `!306` both found, stated in the form the guard sees it:
   * the timeout copy standing in for the pair, promising a Retry the notice has
   * withdrawn.
   */
  it("catches the timeout copy being reused for the row-is-gone pair", () => {
    const faults = writeNoticeCopyFaults(
      "x",
      coherent({
        "x.errorSaveTimeoutGone":
          "No answer from the server, so this may already have saved. Check the list before trying again:",
      }),
    );
    expect(whys(faults)).toMatch(/invites the user to try again/);
    expect(whys(faults)).toMatch(/word for word errorSaveTimeout/);
    // Both voices are read aloud, so both are reported.
    expect(faults.map((f) => f.voice).sort()).toContain("playful");
  });

  it("catches the pair hardening into “nothing changed”", () => {
    const faults = writeNoticeCopyFaults(
      "x",
      coherent({
        "x.errorSaveTimeoutGone":
          "That item is not on the list any more, so nothing changed:",
      }),
    );
    expect(whys(faults)).toMatch(/never make/);
  });

  it("catches the pair dropping the row's absence", () => {
    const faults = writeNoticeCopyFaults(
      "x",
      coherent({
        "x.errorSaveTimeoutGone":
          "No answer from the server, so this may already have saved:",
      }),
    );
    expect(whys(faults)).toMatch(/does not say the row is gone/);
  });

  it("catches the pair dropping the unknown verdict", () => {
    const faults = writeNoticeCopyFaults(
      "x",
      coherent({
        "x.errorSaveTimeoutGone":
          "That item is not on the list any more, and there was no answer from the server:",
      }),
    );
    expect(whys(faults)).toMatch(/unknown verdict/);
  });

  /**
   * The clauses are DERIVED from the surface's own siblings, so this is the spec
   * that proves a reworded surface stays green rather than being re-fitted to the
   * words that happened to ship.
   */
  it("passes a surface reworded end to end, sharing no sentence with ours", () => {
    expect(
      writeNoticeCopyFaults(
        "x",
        coherent({
          "x.errorSaveTimeout":
            "The server went quiet, so this may already have landed. Have a look before trying again:",
          "x.errorSaveGone":
            "That's not in your basket any more, so nothing changed:",
          "x.errorSaveTimeoutGone":
            "The server went quiet, and that's not in your basket any more — so this may already have landed:",
        }),
      ),
    ).toEqual([]);
  });

  /**
   * A guard that quietly stops comparing is worse than no guard, because it
   * reports zero. If a sibling loses the clause the pair is checked against, the
   * guard says so instead of passing.
   */
  it("reports a sibling that stops stating the fact the pair is compared against", () => {
    const faults = writeNoticeCopyFaults(
      "x",
      coherent({
        "x.errorSaveGone": "That one didn't apply, so nothing changed:",
      }),
    );
    expect(whys(faults)).toMatch(/no longer names the row's absence/);
  });

  it("catches a reload-only cell that offers a retry in words", () => {
    const faults = writeNoticeCopyFaults(
      "x",
      coherent({
        "x.errorSaveStale":
          "The app updated while this was open. Reload, then try again:",
      }),
    );
    expect(whys(faults)).toMatch(/promise a button that is not on the screen/);
  });

  it("catches a message cell that closes its sentence before the quoted words", () => {
    const faults = writeNoticeCopyFaults(
      "x",
      coherent({ "x.errorSaveFailed": "Couldn't save that just now." }),
    );
    expect(whys(faults)).toMatch(/does not end on a colon/);
  });

  it("checks the optional feature-flag cell when a surface has one", () => {
    const faults = writeNoticeCopyFaults(
      "x",
      coherent({
        "x.errorSaveOff":
          "Shopping list mode is switched off, so try again later:",
      }),
    );
    expect(whys(faults)).toMatch(/never mentions one/);
  });
});

describe("stringLiteralsIn (rule C's parser)", () => {
  it("finds a key returned from a helper", () => {
    expect(
      stringLiteralsIn(
        `const k = () => { return "shopping.errorSaveGone"; };`,
        "a.tsx",
      ),
    ).toContain("shopping.errorSaveGone");
  });

  it("does not count a key named only in a comment", () => {
    expect(
      stringLiteralsIn(
        `// Kept ABOVE "shopping.errorSaveGone" on purpose.\nconst n = 1;`,
        "a.tsx",
      ),
    ).not.toContain("shopping.errorSaveGone");
  });

  it("finds a key passed to t() from inside JSX", () => {
    expect(
      stringLiteralsIn(
        `const v = <p>{t("shopping.errorSaving", voice)}</p>;`,
        "a.tsx",
      ),
    ).toContain("shopping.errorSaving");
  });
});

describe("nestedLiveRegions (rule D's parser)", () => {
  /** #218's defect, in the smallest form that still has it. */
  it("reports a polite region nested inside an assertive one", () => {
    const found = nestedLiveRegions(
      `const v = (
         <div role="alert">
           <p role="status">Saving…</p>
         </div>
       );`,
      "a.tsx",
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      inner: 'role="status"',
      outer: 'role="alert"',
      line: 3,
    });
  });

  it("reports it however deep it is buried", () => {
    expect(
      nestedLiveRegions(
        `const v = (
           <div role="alert">
             <div><div><p aria-live="polite">Saving…</p></div></div>
           </div>
         );`,
        "a.tsx",
      ),
    ).toHaveLength(1);
  });

  /** The shape `!303` and `!306` settled on, and the one this MR copies. */
  it("passes a region that is a SIBLING of the alert", () => {
    expect(
      nestedLiveRegions(
        `const v = (
           <>
             <div role="alert"><p aria-hidden="true">Saving…</p></div>
             <p role="status" aria-live="polite" className="sr-only">Saving…</p>
           </>
         );`,
        "a.tsx",
      ),
    ).toEqual([]);
  });

  it("does not treat aria-live=off as a live region", () => {
    expect(
      nestedLiveRegions(
        `const v = <div aria-live="off"><p role="status">Hi</p></div>;`,
        "a.tsx",
      ),
    ).toEqual([]);
  });

  it("does not report two live regions that merely follow one another", () => {
    expect(
      nestedLiveRegions(
        `const v = (<><div role="alert">a</div><div role="alert">b</div></>);`,
        "a.tsx",
      ),
    ).toEqual([]);
  });

  it("sees a self-closing element", () => {
    expect(
      nestedLiveRegions(
        `const v = <div role="status"><Foo role="alert" /></div>;`,
        "a.tsx",
      ),
    ).toHaveLength(1);
  });

  /**
   * The documented blind spot, pinned rather than left to be discovered — a guard
   * that advertises a closed set and quietly has a bypass is the failure mode this
   * module exists to remove. `{...live}` cannot be evaluated statically, so the
   * nesting below is real and invisible. Nothing in the tree does this today; the
   * day one of the three surfaces starts to, this spec fails and says why.
   */
  it("cannot see a role that arrives through a JSX spread — stated, not silent", () => {
    expect(
      nestedLiveRegions(
        `const v = <div role="alert"><p {...live}>Saving…</p></div>;`,
        "a.tsx",
      ),
    ).toEqual([]);
  });
});

describe("politeAnnouncersOf (rule E)", () => {
  /** The shape `!303` and `!306` settled on: a sibling, `sr-only`, spelled out. */
  const sibling = `const v = (
     <>
       <div role="alert">
         <button aria-describedby={savingId}>{t("x.errorRetry", voice)}</button>
         <p aria-hidden="true">{t("x.errorSaving", voice)}</p>
       </div>
       <p id={savingId} role="status" aria-live="polite" aria-atomic="true" className="sr-only">
         {retrying && t("x.errorSaving", voice)}
       </p>
     </>
   );`;

  it("finds the sibling region that renders the wait", () => {
    const found = politeAnnouncersOf(sibling, "a.tsx", "x.errorSaving");
    expect(found).toHaveLength(1);
    // Both attributes, not whichever was read first: the role makes it a live
    // region for rule D, the explicit `aria-live` is what rule E requires.
    expect(found[0]!.declared).toBe('role="status" aria-live="polite"');
  });

  /**
   * #236's defect 1, and the reason rule D is not enough on its own: nothing is
   * nested, nothing is wrong structurally, and the words are announced by nothing.
   */
  it("finds none when the wait is only a described paragraph inside the alert", () => {
    expect(
      politeAnnouncersOf(
        `const v = (
           <div role="alert">
             <button aria-describedby={savingId}>{t("x.errorRetry", voice)}</button>
             {retrying && <p id={savingId}>{t("x.errorSaving", voice)}</p>}
           </div>
         );`,
        "a.tsx",
        "x.errorSaving",
      ),
    ).toEqual([]);
    // …and rule D agrees there is nothing structurally wrong, which is the point.
    expect(
      nestedLiveRegions(
        `const v = (
           <div role="alert">
             {retrying && <p id={savingId}>{t("x.errorSaving", voice)}</p>}
           </div>
         );`,
        "a.tsx",
      ),
    ).toEqual([]);
  });

  it("refuses to count a region nested inside the alert as an announcer", () => {
    expect(
      politeAnnouncersOf(
        `const v = (
           <div role="alert">
             <p aria-live="polite">{t("x.errorSaving", voice)}</p>
           </div>
         );`,
        "a.tsx",
        "x.errorSaving",
      ),
    ).toEqual([]);
  });

  /**
   * `!325`, Duo review — rule E accepted any `aria-live` that was not `"off"`,
   * which included `"assertive"`. That is not a polite announcer, it is a second
   * assertive one: two assertive regions describing the same write interrupt each
   * other, and the notice's own `role="alert"` is already saying the louder half.
   * The rule's own name promised the thing it was not checking.
   */
  it("does not accept a second assertive region as the polite announcer", () => {
    expect(
      politeAnnouncersOf(
        `const v = (
           <>
             <div role="alert">{t("x.errorSaveFailed", voice)}</div>
             <p aria-live="assertive" className="sr-only">{t("x.errorSaving", voice)}</p>
           </>
         );`,
        "a.tsx",
        "x.errorSaving",
      ),
    ).toEqual([]);
  });

  it("does not accept an announcer for a different sentence", () => {
    expect(
      politeAnnouncersOf(sibling, "a.tsx", "x.errorSomethingElse"),
    ).toEqual([]);
  });

  it("does not accept aria-live=off", () => {
    expect(
      politeAnnouncersOf(
        `const v = <p aria-live="off">{t("x.errorSaving", voice)}</p>;`,
        "a.tsx",
        "x.errorSaving",
      ),
    ).toEqual([]);
  });
});

/**
 * The closed set. A surface is enrolled by owning `<prefix>.errorSaveTimeout`, so
 * the only thing recorded here is WHICH FILE selects that surface's keys — which
 * rule C needs and the string table cannot know.
 *
 * A new surface therefore cannot skip the guard by not being added; it fails the
 * closed-set spec below until its file is named, which is where a reviewer is
 * asked "and what tells the user when THAT one times out on a row that is gone?".
 */
const OWNERS: Record<string, string> = {
  inbox: "src/components/inbox/inbox-view.tsx",
  shopping: "src/components/shopping/shopping-list.tsx",
};

/**
 * Rule D runs over the notice surfaces, plus `focus-timer.tsx`.
 *
 * The timer's notice has no row and so no `errorSave*` family — it is not
 * enrolled by rules A–C — but it is where #218 was actually found, and the
 * comments in all three files say the shape must stay identical. Dropping it from
 * the one guard that can see the shape would leave the original site unwatched.
 */
const LIVE_REGION_FILES = [
  ...Object.values(OWNERS),
  "src/components/focus/focus-timer.tsx",
];

const read = (relative: string) =>
  readFileSync(path.join(process.cwd(), relative), "utf8");

describe("every write-notice surface carries the whole notice (#246)", () => {
  const surfaces = writeNoticeSurfaces(Object.keys(STRINGS));

  /**
   * The non-zero control. Every assertion below compares against an empty list,
   * and a discovery rule that answered `[]` would satisfy all of them — so this
   * is the spec that shows the scan can see a surface at all.
   */
  it("discovers more than one surface, so an empty result below is a real one", () => {
    expect(surfaces.length).toBeGreaterThan(1);
  });

  it("has an owner recorded for every surface, and none that has gone stale", () => {
    expect(surfaces).toEqual(Object.keys(OWNERS).sort());
  });

  it.each(Object.keys(OWNERS))("%s has every required string", (prefix) => {
    const missing = missingWriteNoticeKeys(prefix, Object.keys(STRINGS));
    expect(
      missing,
      missing.length === 0
        ? ""
        : `\n${missing.join(", ")} — this surface has a write-failure notice but ` +
            "not the whole set of things it needs. The cell that gets missed is " +
            "`timedOut && rowGone`: both facts are independent, so there are FOUR " +
            "message cells and not three, and the pair is the one where the copy " +
            "and the withdrawn Retry contradict each other (#236, #246).\n",
    ).toEqual([]);
  });

  it.each(Object.keys(OWNERS))(
    "%s's copy agrees with its controls",
    (prefix) => {
      const faults = writeNoticeCopyFaults(prefix, STRINGS);
      expect(
        faults,
        faults.length === 0
          ? ""
          : `\n${faults
              .map((f) => `${f.key} (${f.voice}) ${f.why}`)
              .join("\n")}\n`,
      ).toEqual([]);
    },
  );

  it.each(Object.entries(OWNERS))(
    "%s's owner selects every one of its strings",
    (prefix, file) => {
      const literals = stringLiteralsIn(read(file), path.basename(file));
      // The non-zero control for this file: a parser returning nothing would pass
      // no key, so prove it found the surface's own keys at all before trusting
      // the absence of a finding.
      expect(
        [...literals].filter((l) => l.startsWith(`${prefix}.`)).length,
      ).toBeGreaterThan(WRITE_NOTICE_MESSAGE_SUFFIXES.length);

      const unreferenced = writeNoticeSuffixes()
        .map((suffix) => `${prefix}.${suffix}`)
        .filter((key) => key in STRINGS && !literals.has(key));
      expect(
        unreferenced,
        unreferenced.length === 0
          ? ""
          : `\n${unreferenced.join(", ")} exist in the string table but ${file} ` +
              "never selects them. A cell the code cannot reach is the same " +
              "silent failure as a cell that does not exist, and `StringKey` " +
              "cannot see it: it checks that a returned key exists, never that " +
              "an existing key is returned.\n",
      ).toEqual([]);
    },
  );
});

describe("no notice nests one live region inside another (#218, #236)", () => {
  it.each(LIVE_REGION_FILES)("%s", (file) => {
    const found = nestedLiveRegions(read(file), path.basename(file));
    expect(
      found,
      found.length === 0
        ? ""
        : `\n${found
            .map((f) => `${file}:${f.line} — ${f.inner} inside ${f.outer}`)
            .join("\n")}\n` +
            "A live region's politeness applies to its whole subtree, so a " +
            "polite region inside an assertive one is not polite — it is the " +
            "assertive one re-reading itself, and “will it announce” has no " +
            "answer. Moving the nesting one level deeper is what #218's first " +
            "attempt did. Make it a SIBLING of the alert instead, `sr-only`, " +
            "rendered with the notice and empty until there is something to say " +
            "(see focus-timer.tsx and inbox-view.tsx).\n",
    ).toEqual([]);
  });

  /**
   * The non-zero control for rule D. `nestedLiveRegions` answers `[]` both for a
   * file that nests nothing and for a file the parser could not read, and those
   * are not the same result — so prove the regions were seen before trusting the
   * clean scan above.
   */
  it.each(LIVE_REGION_FILES)(
    "%s has live regions rule D actually saw",
    (file) => {
      expect(
        liveRegionsIn(read(file), path.basename(file)).length,
      ).toBeGreaterThan(1);
    },
  );
});

describe("every write notice announces its own wait (#218, #236)", () => {
  it.each(Object.entries(OWNERS))(
    "%s's retry wait reaches a screen reader",
    (prefix, file) => {
      const key = `${prefix}.errorSaving`;
      const announcers = politeAnnouncersOf(
        read(file),
        path.basename(file),
        key,
      );
      expect(
        announcers.map((a) => `${file}:${a.line}`),
        announcers.length > 0
          ? ""
          : `\n${file} renders ${key} but no un-nested aria-live region does. ` +
              "`aria-describedby` cannot carry this alone: a description is read " +
              "when focus LANDS on a control, and Retry is pressed on a control " +
              "that already holds focus and keeps it by design (`aria-disabled`, " +
              "not `disabled`), so the value gaining the id mid-flight is a " +
              "change nothing goes back to re-read. Add an `sr-only` " +
              '`role="status" aria-live="polite" aria-atomic="true"` SIBLING of ' +
              "the alert, rendered with the notice and empty until there is " +
              "something to say — see focus-timer.tsx and inbox-view.tsx.\n",
      ).not.toEqual([]);
    },
  );
});
