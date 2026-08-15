/**
 * #225 — the allow-list, and the scan over the real `inbox-view.tsx`.
 *
 * The parser is exercised on synthetic sources first, so a failure here says
 * whether the repo drifted or the parser did. See `inbox-write-hygiene.ts` for
 * why this guard exists: `breakdown` and `focusOnItem` kept their own untried
 * `startTransition` for ten commits of the MR that hardened `run()`, and no test
 * could see it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { transitionStarters } from "@/lib/inbox-write-hygiene";

describe("transitionStarters (the parser itself)", () => {
  /**
   * The non-zero control. Every assertion in the scan below is a comparison
   * against a fixed list, and a parser that always answered `[]` would satisfy
   * every one of them — so this is the spec that shows it can see a call at all.
   */
  it("names the function a transition is started from", () => {
    expect(
      transitionStarters(`
        const run = (fn) => startTransition(async () => { await fn(); });
      `),
    ).toEqual(["run"]);
  });

  it("finds a call nested deep inside JSX", () => {
    expect(
      transitionStarters(`
        const rows = (items) => (
          <ul>
            {items.map((i) => (
              <li key={i.id}>
                <button onClick={() => startTransition(async () => save(i))} />
              </li>
            ))}
          </ul>
        );
      `),
    ).toEqual(["rows"]);
  });

  it("reports a call with no named ancestor rather than dropping it", () => {
    expect(transitionStarters(`startTransition(() => {});`)).toEqual([
      "<anonymous>",
    ]);
  });

  it("does not mistake the useTransition hook for a call to its setter", () => {
    expect(
      transitionStarters(`
        const Comp = () => {
          const [pending, startTransition] = useTransition();
          return pending;
        };
      `),
    ).toEqual([]);
  });

  it("does not report a mention in a comment or a string", () => {
    expect(
      transitionStarters(`
        // startTransition(async () => {}) is what this used to be.
        const doc = "startTransition(x)";
      `),
    ).toEqual([]);
  });

  it("deduplicates two calls in one function", () => {
    expect(
      transitionStarters(`
        const both = (a) => {
          if (a) startTransition(() => {});
          else startTransition(() => {});
        };
      `),
    ).toEqual(["both"]);
  });
});

/**
 * The closed set, with the reason each member is allowed to be outside
 * `attemptWrite`. A new entry here is the review question "what tells the user
 * when this one fails?" — which is the question `breakdown` and `focusOnItem`
 * were never asked.
 */
const ALLOWED: Record<string, string> = {
  // The write machinery. This IS the notice, so it cannot go through itself.
  attemptWrite: "#225 — the one place a row write is reported from",
  // Its own per-row error text and Reconnect swap (#169), because a Google
  // failure is a workspace-wide condition rather than one row's write.
  runSchedule: "#169 — per-row schedule errors and the reconnect state",
  runScheduleIcs: "#169 — the ICS twin of runSchedule, same reporting",
};

/**
 * ⚠️ **`capture` was here and is deliberately gone (#175).**
 *
 * Its entry read *"#210 — the capture notice, which restores the words it lost"*,
 * and the notice it excused no longer exists: the capture path is now
 * `POST /api/braindump` through the offline queue, so a failed capture is a queue
 * entry on the strip rather than a one-slot notice.
 *
 * The removal is not incidental to that. `capture()` starts **no transition at
 * all** now, and it must not: React 19 holds an async transition's state updates
 * until the action settles, so the `flushing` flag the polite region announces
 * from would first paint at the moment it stopped being true — the trap
 * `runSchedule` records, and here it would silence `write-notice-hygiene` rule E's
 * channel on the submit path. The "no ALLOWED entry that has gone stale" spec
 * below is what forced this note to be written rather than the entry being left
 * behind as a lie, which is precisely its job.
 */

describe("inbox-view.tsx starts no unreported transitions (#225)", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/components/inbox/inbox-view.tsx"),
    "utf8",
  );

  it("starts at least one transition, so a zero below would be a real zero", () => {
    expect(transitionStarters(source).length).toBeGreaterThan(0);
  });

  it("starts one only from a function that reports its own failures", () => {
    const unexplained = transitionStarters(source).filter(
      (name) => !(name in ALLOWED),
    );
    expect(
      unexplained,
      unexplained.length === 0
        ? ""
        : `\n${unexplained.join(", ")} start a transition without going through ` +
            "`run()`/`attemptWrite`, so a rejected server action inside one is an " +
            "unhandled rejection and the user is told nothing — #225's whole " +
            "defect. Either route the write through `run()` (which is almost " +
            "always right), or add it to ALLOWED in this file with the surface " +
            "that reports its failures instead.\n",
    ).toEqual([]);
  });

  it("has no ALLOWED entry that has gone stale", () => {
    // A guard whose allow-list outlives the code it excused stops being read.
    const starters = transitionStarters(source);
    expect(Object.keys(ALLOWED).filter((n) => !starters.includes(n))).toEqual(
      [],
    );
  });
});
