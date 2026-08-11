/**
 * #246 / #236 — pure helpers for one question asked of every surface that owns a
 * write-failure notice: **does it carry the whole set of things that notice
 * needs, or only the ones somebody remembered?**
 *
 * Four surfaces carry a notice of this shape and it has drifted three times.
 * `#210` gave the capture bar the first one; `#199` gave the shopping list its
 * own; `#218` found the focus timer and the step list had a third; `#225` gave
 * the twenty inbox row writes a fourth. The drifts:
 *
 *  * `!306` found that `inbox`'s copy and its controls disagreed about the pair
 *    `timedOut && rowGone` — "check your inbox before trying again" printed above
 *    a notice that had just withdrawn every control — and added
 *    `inbox.errorSaveTimeoutGone` for it.
 *  * `#246` is the same hole on `shopping`, found by reading the string table
 *    rather than the code. Nothing failed. The key simply was not there, and
 *    `writeFailureKey` fell through to the timeout copy, so the surface **read as
 *    fixed to anyone auditing by grep for the helper** while one failure mode
 *    stayed silent. That sentence is the reason this module is not another
 *    per-file spec.
 *
 * So the invariant is stated across surfaces and enrolment is automatic: owning a
 * `<prefix>.errorSaveTimeout` string IS being a write-notice surface, and a new
 * one inherits every rule below the moment it adds that key. There is no list to
 * remember to add yourself to.
 *
 * ## The five rules
 *
 * **A — the matrix is complete.** `timedOut` and `rowGone` are independent facts,
 * so there are four message cells and not three, plus the stale-bundle case: five
 * keys, and the controls each of them needs (`errorRetry`, `errorReload`,
 * `errorSaving`). {@link missingWriteNoticeKeys}.
 *
 * **B — the copy for each cell agrees with the control offered for it.** This is
 * the half a name-check cannot do. Deliberately NOT written as "the timeout copy
 * must contain the words we shipped": the clauses are *derived from the surface's
 * own siblings*, so a reworded surface stays green and only an incoherent one
 * fails. `errorSaveTimeoutGone` has to carry the absence clause of
 * `errorSaveGone` **and** the unknown-verdict clause of `errorSaveTimeout`,
 * because it reports the two facts arriving together — and it must say neither
 * "nothing changed", which a timeout can never support, nor "try again", which
 * the withdrawn Retry makes a promise about a button that is not on screen.
 * {@link writeNoticeCopyFaults}.
 *
 * **C — the code actually selects every cell.** A string added and never returned
 * is the same silent failure mode wearing the other hat, and TypeScript cannot
 * see it: `StringKey` checks that a returned key exists, never that an existing
 * key is returned. {@link stringLiteralsIn}.
 *
 * **D — no live region is nested inside another.** #218's defect: a polite
 * `role="status"` inside the notice's assertive `role="alert"` inherits the
 * container's politeness across the whole subtree, so "will it announce" has no
 * answer. The fix is a *sibling* region, which is a structural property and
 * therefore checkable. Fails closed on a `{...spread}` it cannot resolve — see
 * the note at the foot of this comment. {@link nestedLiveRegions}.
 *
 * **E — the in-flight wait is announced by a live region, not by a description.**
 * The half of #218 that rule D cannot see, and the one `shopping-list.tsx` still
 * carried on `main` (#236, defect 1): its wait was a plain `<p>` inside the alert,
 * reachable only through `aria-describedby` on a control that already holds focus
 * and keeps it. Nothing was nested, so nothing was wrong structurally — and the
 * words were announced by nothing. {@link politeAnnouncersOf}.
 *
 * ## Why the TypeScript AST for C, D and E
 *
 * Same reason `a11y-class-hygiene` gives, and it is not hypothetical here either:
 * `shopping-list.tsx` and `inbox-view.tsx` both name their own string keys **in
 * comments**, documenting the ordering decisions between them, and
 * `shopping-list.tsx` carried the words `role="status"` in a comment arguing
 * against using it. A regex reports findings that do not exist for C and misses
 * the nesting question entirely for D, which is about ancestry. `typescript` is
 * already a devDependency for the same reason in five other hygiene modules.
 *
 * Kept free of `fs` so the parsing is unit-testable on synthetic sources — the
 * same split `inbox-write-hygiene`, `a11y-class-hygiene`, `fetch-host-hygiene`
 * and `dockerfile-hygiene` use; the caller reads the files.
 * `write-notice-hygiene.test.ts` holds the surface-to-file map and the scan over
 * the real tree.
 *
 * ## What it deliberately does not see
 *
 *  1. **Whether the copy is *true*.** These are coherence rules between a
 *     surface's own strings, not a reading of what the server did.
 *  2. **A key selected through a computed expression.** Rule C stops at string
 *     literals, which is what every surface does today (`return
 *     "shopping.errorSaveGone"`). A `` `${prefix}.errorSaveGone` `` would read as
 *     unreferenced — a false failure, which is the safe direction.
 *  3. **A live region introduced by a child component.** Rules D and E reason
 *     about one file's JSX tree, so a `<Foo />` that renders `role="status"`
 *     inside an alert in this file is invisible to both. All three notice
 *     surfaces are plain markup, which is why that is affordable here — an
 *     extracted `<WriteNotice />` would need this scope widened along with it.
 *  4. **Focus behaviour.** Which control receives the hand-off when the notice
 *     withdraws its button is per-surface and covered by each surface's specs.
 *
 * ## The ambiguity it does NOT let itself off: `{...spread}`
 *
 * A role or `aria-live` can arrive through a spread, and `{...props}` cannot be
 * evaluated statically. The first version of this module read that as "not a live
 * region" and said nothing, which made a guard advertising a closed set quietly
 * have a bypass — the exact failure mode it exists to remove.
 *
 * **It fails closed instead.** An element carrying a spread and no literal live
 * attribute is a *candidate*, reported by rule D whenever it sits inside a live
 * region or has one inside it, and refused by rule E as an announcer because a
 * spread can overwrite `aria-live="polite"` with anything, `"off"` included. "I
 * could not determine this, so I am flagging it" is a correct guard; "I could not
 * determine this, so I am silent" is the bug. The trade is explicit: false
 * positives are acceptable here and false negatives are not, because a missed
 * nesting is #218 and a flagged spread is one comment in review.
 *
 * All three surfaces pass, and not vacuously — `inbox-view.tsx` has six real
 * spread-bearing elements that go through this branch and clear it, which a spec
 * asserts so a future clean scan cannot come from the branch never running.
 */

import ts from "typescript";

/**
 * The five message cells of a write-failure notice, as a closed set.
 *
 * Four of them are the `timedOut` × `rowGone` matrix, which is the part that gets
 * missed: three of the four are obvious and the pair is not. `errorSaveStale` is
 * the fifth because a bundle from another deployment is a fifth verdict, not a
 * corner of that matrix.
 */
export const WRITE_NOTICE_MESSAGE_SUFFIXES = [
  "errorSaveFailed",
  "errorSaveStale",
  "errorSaveTimeout",
  "errorSaveGone",
  "errorSaveTimeoutGone",
] as const;

/**
 * The controls and the in-flight announcement every one of those cells needs.
 *
 * `errorReload` is required even on a surface whose common case is a Retry: the
 * stale-bundle cell offers a reload and nothing else, so a surface with
 * `errorSaveStale` and no `errorReload` has a notice it cannot render.
 */
export const WRITE_NOTICE_CONTROL_SUFFIXES = [
  "errorRetry",
  "errorReload",
  "errorSaving",
] as const;

/**
 * Suffixes a surface MAY own, listed so they are not mistaken for omissions.
 *
 * `errorSaveOff` is the shopping list's feature-flag cell — the mode was switched
 * off in another tab, which no other surface has. Rule B still applies to it when
 * it is present.
 */
export const WRITE_NOTICE_OPTIONAL_SUFFIXES = ["errorSaveOff"] as const;

/** The one key whose presence enrols a surface in every rule here. */
const ENROLLING_SUFFIX = "errorSaveTimeout";

/** Copy that invites the user to press a Retry. */
const INVITES_RETRY = /\btry(?:ing)? again\b/i;
/** Copy that asserts the write did not land. */
const CLAIMS_NO_CHANGE = /nothing changed/i;
/** Copy that points at a reload as the way out. */
const INVITES_RELOAD = /\breload\b/i;
/**
 * The clause naming the row's absence, as the surface itself words it — "not in
 * your inbox any more", "not on the list any more". Stops at the punctuation that
 * ends a clause so the match is the phrase and not the rest of the sentence.
 */
const ABSENCE_CLAUSE = /not (?:in|on) [^,;:—.]*?any more/i;
/**
 * The clause admitting the verdict is unknown — "may already have gone through",
 * "may already have saved". The one thing a timeout knows about itself.
 */
const UNKNOWN_CLAUSE = /may already have [^,;:—.]*/i;

/** One string of one surface, in one voice, breaking one rule. */
export interface CopyFault {
  /** Full string key, e.g. `shopping.errorSaveTimeoutGone`. */
  key: string;
  /** Which voice the fault is in — both are read aloud, so both are checked. */
  voice: string;
  /** What is wrong, phrased so the failure message needs no other context. */
  why: string;
}

/** The shape this module needs from `STRINGS`; anything wider is fine. */
export type VoicedStrings = Readonly<
  Record<string, { readonly plain: string; readonly playful: string }>
>;

/**
 * The prefixes that own a write-failure notice, discovered rather than listed.
 *
 * Sorted, so a caller comparing against a fixed expectation gets a stable answer.
 */
export function writeNoticeSurfaces(keys: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const key of keys) {
    const dot = key.lastIndexOf(".");
    if (dot > 0 && key.slice(dot + 1) === ENROLLING_SUFFIX)
      found.add(key.slice(0, dot));
  }
  return [...found].sort();
}

/** Every suffix this module has an opinion about, required or optional. */
export function writeNoticeSuffixes(): string[] {
  return [
    ...WRITE_NOTICE_MESSAGE_SUFFIXES,
    ...WRITE_NOTICE_CONTROL_SUFFIXES,
    ...WRITE_NOTICE_OPTIONAL_SUFFIXES,
  ];
}

/**
 * Rule A — the required keys `prefix` does not have.
 *
 * Returns the full keys rather than the suffixes, so a failure message can be
 * pasted straight into a search.
 */
export function missingWriteNoticeKeys(
  prefix: string,
  keys: Iterable<string>,
): string[] {
  const owned = new Set(keys);
  return [...WRITE_NOTICE_MESSAGE_SUFFIXES, ...WRITE_NOTICE_CONTROL_SUFFIXES]
    .map((suffix) => `${prefix}.${suffix}`)
    .filter((key) => !owned.has(key));
}

/**
 * Rule B — where `prefix`'s copy contradicts the control its cell offers.
 *
 * Both voices, because a screen reader reads whichever one is on and the playful
 * voice has diverged from the plain one elsewhere in this table.
 *
 * The clauses `errorSaveTimeoutGone` must carry are derived from this surface's
 * OWN `errorSaveGone` and `errorSaveTimeout`, never from a phrase hard-coded
 * here. That is what lets a surface be reworded without touching this module, and
 * it is also why a sibling that stops stating its own fact is reported: the guard
 * has lost the thing it compares against, and silently comparing against nothing
 * is how a green result comes to mean nothing was checked.
 */
export function writeNoticeCopyFaults(
  prefix: string,
  strings: VoicedStrings,
): CopyFault[] {
  const faults: CopyFault[] = [];
  const voices = ["plain", "playful"] as const;

  const read = (suffix: string, voice: (typeof voices)[number]) =>
    strings[`${prefix}.${suffix}`]?.[voice];

  for (const voice of voices) {
    const add = (suffix: string, why: string) =>
      faults.push({ key: `${prefix}.${suffix}`, voice, why });

    // Every message cell is the LEAD of a sentence the notice finishes by
    // quoting the words the write could not save, so it cannot end closed. The
    // string table already says this in a comment; here it is enforced.
    for (const suffix of WRITE_NOTICE_MESSAGE_SUFFIXES) {
      const text = read(suffix, voice);
      if (text === undefined) continue;
      if (!text.trimEnd().endsWith(":"))
        add(
          suffix,
          "does not end on a colon, but the notice renders the quoted words " +
            "immediately after it, so the sentence would run on",
        );
    }

    const stale = read("errorSaveStale", voice);
    const timeout = read("errorSaveTimeout", voice);
    const gone = read("errorSaveGone", voice);
    const timeoutGone = read("errorSaveTimeoutGone", voice);
    const off = read("errorSaveOff", voice);

    // A bundle from another deployment, and a switched-off feature: both offer a
    // reload and no Retry, so both have to point at the reload and neither may
    // invite a press that is not on screen.
    for (const [suffix, text] of [
      ["errorSaveStale", stale],
      ["errorSaveOff", off],
    ] as const) {
      if (text === undefined) continue;
      if (!INVITES_RELOAD.test(text))
        add(
          suffix,
          "offers a reload and nothing else, but never mentions one, so the " +
            "only control on the notice is unexplained",
        );
      if (INVITES_RETRY.test(text))
        add(
          suffix,
          "invites the user to try again, but this cell withdraws the Retry — " +
            "the words promise a button that is not on the screen",
        );
    }

    if (timeout !== undefined) {
      if (CLAIMS_NO_CHANGE.test(timeout))
        add(
          "errorSaveTimeout",
          "claims nothing changed, which is the one thing a timeout can never " +
            "support: the write may well have landed",
        );
      if (!UNKNOWN_CLAUSE.test(timeout))
        add(
          "errorSaveTimeout",
          "no longer admits the verdict is unknown, so rule B has nothing to " +
            "require of errorSaveTimeoutGone — reword it to keep a " +
            `"${"may already have …"}" clause, or change this rule on purpose`,
        );
    }

    if (gone !== undefined) {
      if (INVITES_RETRY.test(gone))
        add(
          "errorSaveGone",
          "invites the user to try again, but the row is gone and every one of " +
            "these writes matches nothing again, every time",
        );
      if (!ABSENCE_CLAUSE.test(gone))
        add(
          "errorSaveGone",
          "no longer names the row's absence in a form rule B can share with " +
            `errorSaveTimeoutGone — keep a "${"not in/on … any more"}" clause, ` +
            "or change this rule on purpose",
        );
    }

    if (timeoutGone === undefined) continue;

    // The cell this whole module exists for. Two facts at once, and each of the
    // two messages that reports one of them is dishonest about the pair.
    if (CLAIMS_NO_CHANGE.test(timeoutGone))
      add(
        "errorSaveTimeoutGone",
        "claims nothing changed. The row may be absent BECAUSE the write it is " +
          "unsure about landed, so this is the one claim it can never make",
      );
    if (INVITES_RETRY.test(timeoutGone))
      add(
        "errorSaveTimeoutGone",
        "invites the user to try again, which is the defect this cell exists " +
          "to remove: the Retry is withdrawn for a row that is gone",
      );

    const absence = gone?.match(ABSENCE_CLAUSE)?.[0];
    if (absence !== undefined && !timeoutGone.includes(absence))
      add(
        "errorSaveTimeoutGone",
        `does not say the row is gone. errorSaveGone words it "${absence}"; ` +
          "reporting the check is what replaces asking the user to make it",
      );

    const unknown = timeout?.match(UNKNOWN_CLAUSE)?.[0]?.trimEnd();
    if (unknown !== undefined && !timeoutGone.includes(unknown))
      add(
        "errorSaveTimeoutGone",
        `does not keep the timeout's honesty about an unknown verdict. ` +
          `errorSaveTimeout words it "${unknown}"`,
      );

    if (timeout !== undefined && timeoutGone === timeout)
      add(
        "errorSaveTimeoutGone",
        "is word for word errorSaveTimeout, so adding the key changed nothing " +
          "the user hears",
      );
  }

  return faults;
}

/**
 * Every string literal in `source`, for rule C.
 *
 * String literals ONLY: a comment naming a key is not a use of it, and both
 * notice surfaces name their siblings' keys in comments explaining the ordering
 * between them. Template expressions are excluded for the same reason a computed
 * key is out of scope — see the module note.
 */
export function stringLiteralsIn(
  source: string,
  fileName: string,
): Set<string> {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      found.add(node.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

/** A live region rendered inside another one — rule D's finding. */
export interface NestedLiveRegion {
  /** 1-based line of the inner region, so the finding is navigable. */
  line: number;
  /** How the inner region declares itself, e.g. `role="status"`. */
  inner: string;
  /** How the nearest live-region ancestor declares itself. */
  outer: string;
}

/** One live region — or one element that might be one — nested or not. */
export interface LiveRegion {
  /** 1-based line, so the finding is navigable. */
  line: number;
  /**
   * How it declares itself, e.g. `aria-live="polite"` — or `"{...spread}"` when
   * the only thing known is that attributes arrive from somewhere unresolvable.
   */
  declared: string;
  /** How each candidate ancestor declares itself, outermost first. */
  ancestors: string[];
  /**
   * Whether this element carries a JSX spread.
   *
   * Rule E's pessimism lives here: JSX resolves later attributes last, so a spread
   * can overwrite `aria-live="polite"` with anything at all — including `"off"` —
   * and an announcer that cannot be *proved* to announce does not count as one.
   */
  spread: boolean;
  /**
   * String literals anywhere in this element's subtree.
   *
   * Rule E's evidence: an announcer is only an announcer for the sentence it
   * actually renders, and the sentence is selected by its string key.
   */
  selects: string[];
}

/**
 * Rule D — live regions in `source` that have a live-region ancestor.
 *
 * `role="alert"` is an assertive, atomic live region and its politeness applies
 * to its whole subtree, so a `role="status"` one level in is not a polite region
 * at all — it is the assertive one re-reading itself. Moving the same nesting
 * deeper does not fix it, which is exactly what #218's first attempt did; the
 * answer is a sibling.
 *
 * `aria-live="off"` is not a live region and is not reported.
 */
export function nestedLiveRegions(
  source: string,
  fileName: string,
): NestedLiveRegion[] {
  return liveRegionsIn(source, fileName)
    .filter((region) => region.ancestors.length > 0)
    .map((region) => ({
      line: region.line,
      inner: region.declared,
      outer: region.ancestors[region.ancestors.length - 1],
    }));
}

/**
 * Every live region in `source` — **and every element that might be one** — each
 * with its candidate ancestors.
 *
 * A `{...spread}` cannot be resolved statically, so an element carrying one is a
 * candidate rather than a decided answer. It is included **because** the answer is
 * unknown: an unresolvable element treated as "not a live region" is a hole in a
 * guard that claims to be a closed set, which is the defect this module exists to
 * remove. Deciding the ambiguity the pessimistic way costs a false positive at
 * worst; deciding it the optimistic way costs a missed nesting, and #218 is what
 * that costs in practice.
 *
 * Exported for the control {@link nestedLiveRegions} needs: it answers with an
 * empty list both for a file that nests nothing and for a file the parser could
 * not read, and those two are not the same result. A caller asserting "clean"
 * should first assert this is non-empty.
 */
export function liveRegionsIn(source: string, fileName: string): LiveRegion[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );

  const LIVE_ROLES = new Set(["alert", "status", "log"]);

  /** The literal value of `name` on this opening element, if it has one. */
  const attr = (
    open: ts.JsxOpeningLikeElement,
    name: string,
  ): string | undefined => {
    for (const property of open.attributes.properties) {
      if (!ts.isJsxAttribute(property) || property.name.getText(file) !== name)
        continue;
      const init = property.initializer;
      if (init === undefined) continue;
      if (ts.isStringLiteral(init)) return init.text;
      if (
        ts.isJsxExpression(init) &&
        init.expression &&
        ts.isStringLiteral(init.expression)
      )
        return init.expression.text;
    }
    return undefined;
  };

  /** Whether attributes arrive from somewhere this parser cannot evaluate. */
  const hasSpread = (open: ts.JsxOpeningLikeElement): boolean =>
    open.attributes.properties.some(ts.isJsxSpreadAttribute);

  /**
   * How this element declares itself a live region, or `undefined`.
   *
   * BOTH attributes when both are present, never the first one found. `role` and
   * `aria-live` are not interchangeable here: a `role="status"` is a live region
   * for rule D, and only an explicit `aria-live` satisfies rule E. Returning just
   * the role read every correctly-built announcer as unqualified, which is the
   * bug this comment replaces.
   *
   * A spread with no literal live attribute reports as `"{...spread}"` — not a
   * decided answer, an undecidable one, which fails closed rather than silent
   * (`!325`). A spread ALONGSIDE a literal attribute keeps the literal reading:
   * the element already counts as a region for nesting, and a spread can only
   * weaken that, which is rule E's problem rather than rule D's.
   */
  const liveness = (open: ts.JsxOpeningLikeElement): string | undefined => {
    const role = attr(open, "role");
    const live = attr(open, "aria-live");
    const parts = [
      role !== undefined && LIVE_ROLES.has(role) ? `role="${role}"` : undefined,
      live !== undefined && live !== "off" ? `aria-live="${live}"` : undefined,
    ].filter((part): part is string => part !== undefined);
    if (parts.length > 0) return parts.join(" ");
    return hasSpread(open) ? "{...spread}" : undefined;
  };

  const found: LiveRegion[] = [];
  /** The live-region ancestors currently open, outermost first. */
  const openRegions: string[] = [];

  const visit = (node: ts.Node): void => {
    const open = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;
    const declared = open ? liveness(open) : undefined;

    if (declared !== undefined && open !== undefined) {
      found.push({
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        declared,
        ancestors: [...openRegions],
        spread: hasSpread(open),
        selects: [...collectLiterals(node)],
      });
      openRegions.push(declared);
    }

    ts.forEachChild(node, visit);
    if (declared !== undefined) openRegions.pop();
  };
  ts.forEachChild(file, visit);

  return found;
}

/** String literals anywhere under `node`, including `node` itself. */
function collectLiterals(node: ts.Node): Set<string> {
  const found = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
      found.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * Rule E — the live regions that could actually announce `key`.
 *
 * A surface with none of these has the defect #218, `!303` and `!306` each fixed
 * in turn, and the one `shopping-list.tsx` still carried on `main` (#236, defect
 * 1): the in-flight wait reachable only through `aria-describedby` on a control
 * that **already holds focus and keeps it**, because it is `aria-disabled` rather
 * than `disabled`. A description is computed when focus LANDS on an element, so
 * the referenced text changing while focus stays put is read by most screen
 * readers not at all. The words are on screen and announced by nothing.
 *
 * Three conditions, and each one is load-bearing:
 *
 *  * **`aria-live="polite"` explicitly.** `role="status"` implies it, but only
 *    spelling it out survives the region being moved, and the surfaces that got
 *    this right all spell it out. **`"assertive"` does not count**, which is the
 *    correction `!325`'s Duo review earned: the first draft accepted any value but
 *    `"off"`, so a second assertive region satisfied a rule whose own name
 *    promises politeness. Two assertive regions describing one write interrupt
 *    each other, and the notice's `role="alert"` is already saying the louder
 *    half — which is the whole reason the wait is a separate, quieter channel.
 *  * **Not nested.** A polite region inside the notice's assertive `role="alert"`
 *    inherits the container's politeness across its whole subtree, so it does not
 *    announce politely; it makes the alert re-read itself. Rule D reports the
 *    nesting; this rule refuses to count it as an announcer.
 *  * **It renders `key`.** An announcer for some other sentence is not an
 *    announcer for this one. Four surfaces carry several live regions each, so
 *    "there is an `aria-live` somewhere in the file" would pass every one of them
 *    including the broken one.
 */
export function politeAnnouncersOf(
  source: string,
  fileName: string,
  key: string,
): LiveRegion[] {
  return liveRegionsIn(source, fileName).filter(
    (region) =>
      region.declared.includes('aria-live="polite"') &&
      !region.spread &&
      region.ancestors.length === 0 &&
      region.selects.includes(key),
  );
}
