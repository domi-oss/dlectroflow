import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scanServerActions } from "@/lib/revalidation-hygiene";

/**
 * #139 — the list-invalidation guard.
 *
 * `requeueFocus` wrote the new estimate to the database correctly and then let
 * `/` keep rendering the old one, because it revalidated `/tasks/{id}` and
 * nothing else. It was the ONE mutation in `src/app/actions/focus.ts` that
 * didn't invalidate the list; the other five all did. A single omission in an
 * otherwise consistent file is precisely the thing a person cannot be relied on
 * to notice in review, and it shipped.
 *
 * So: **every exported action in `focus.ts` that writes a model the home list
 * renders must call `revalidatePath("/")` unconditionally.**
 *
 * "Unconditionally" is load-bearing. `completeFocus` used to satisfy a
 * presence-only check while revalidating `/` from inside
 * `if (openCount === 0)` — finishing the last step of a task refreshed the
 * list, finishing any earlier one did not. That is the same bug wearing a
 * branch, so the scan reports where the call sits, not merely that it exists.
 */

const ACTIONS_FILE = join(process.cwd(), "src/app/actions/focus.ts");

// ── Exempt: actions that write only the session row ─────────────────────────
//
// Keyed by action name, valued by the reason — the same contract
// `REVIEWED_DYNAMIC_HOSTS` carries in `fetch-host-hygiene.test.ts`. Adding an
// entry is a decision to be argued in review, not a way to quiet the test.
//
// The exemption is about the MODEL an action writes, not about its name, and
// the assertions below prove that rather than trusting it: an exempt action
// that grows a `Step` or `Task` write fails, and so does one that becomes
// unnecessary. Delete the entry and add `revalidatePath("/")` when that
// happens.
const SESSION_ONLY_WRITERS: Record<string, string> = {
  beginFocus:
    "Writes only FocusSession (retires stale open rows, creates the new " +
    "one). The list renders a step's estimate and done-state, neither of " +
    "which this touches.",
  pauseFocus: "Writes only FocusSession.pausedAt / plannedMin.",
  resumeFocus: "Writes only FocusSession.pausedAt / accumulatedPausedMs.",
  giveUpFocus:
    "Writes only FocusSession (closes the row as gaveup). Deliberately " +
    "leaves the step untouched — a given-up session is not a step change.",
};

/** Models whose values `/` renders, so a write to one must invalidate it. */
const SESSION_MODEL = "focusSession";

describe("scanServerActions", () => {
  it("reports an exported action's direct Prisma writes", () => {
    const source = [
      "export async function renameStep(id: string) {",
      "  await prisma.step.update({ where: { id }, data: {} });",
      "}",
    ].join("\n");
    expect(scanServerActions(source)[0]).toMatchObject({
      name: "renameStep",
      exported: true,
      writes: ["step"],
    });
  });

  it("does not count a read as a write", () => {
    const source = [
      "export async function peek(id: string) {",
      "  return prisma.step.findFirst({ where: { id } });",
      "}",
    ].join("\n");
    expect(scanServerActions(source)[0].writes).toEqual([]);
  });

  // closeSession() and markTaskCompleted() are private helpers in focus.ts, so
  // an action that writes only through them still writes.
  it("follows a write through a module-local helper", () => {
    const source = [
      "async function closeIt(id: string) {",
      "  return prisma.focusSession.update({ where: { id }, data: {} });",
      "}",
      "export async function giveUp(id: string) {",
      "  await closeIt(id);",
      "}",
    ].join("\n");
    const giveUp = scanServerActions(source).find((a) => a.name === "giveUp")!;
    expect(giveUp.writes).toEqual(["focusSession"]);
  });

  it("survives a helper cycle rather than recursing forever", () => {
    const source = [
      "async function a() { await b(); }",
      "async function b() { await a(); await prisma.task.update({}); }",
      "export async function act() { await a(); }",
    ].join("\n");
    expect(
      scanServerActions(source).find((x) => x.name === "act")!.writes,
    ).toEqual(["task"]);
  });

  it("separates an unconditional revalidation from a branched one", () => {
    const source = [
      "export async function act(id: string) {",
      "  await prisma.step.update({ where: { id }, data: {} });",
      "  if (done) revalidatePath('/dashboard');",
      "  revalidatePath('/');",
      "}",
    ].join("\n");
    expect(scanServerActions(source)[0]).toMatchObject({
      revalidates: ["/"],
      conditionalRevalidates: ["/dashboard"],
    });
  });

  it("does not credit a revalidation nested in a block", () => {
    const source = [
      "export async function act() {",
      "  await prisma.step.update({});",
      "  if (x) { revalidatePath('/'); }",
      "}",
    ].join("\n");
    expect(scanServerActions(source)[0].revalidates).toEqual([]);
  });

  it("reads an arrow-function action and marks a non-exported one", () => {
    const source = [
      "const helper = async () => { await prisma.step.update({}); };",
      "export const act = async () => { await helper(); revalidatePath('/'); };",
    ].join("\n");
    const scanned = scanServerActions(source);
    expect(scanned.find((a) => a.name === "helper")!.exported).toBe(false);
    expect(scanned.find((a) => a.name === "act")).toMatchObject({
      exported: true,
      writes: ["step"],
      revalidates: ["/"],
    });
  });

  it("ignores a revalidatePath call whose argument is not a literal", () => {
    // Nothing in the repo does this today; if something starts, the guard must
    // not silently credit it with revalidating whatever the variable holds.
    const source = [
      "export async function act(p: string) {",
      "  await prisma.step.update({});",
      "  revalidatePath(p);",
      "}",
    ].join("\n");
    expect(scanServerActions(source)[0].revalidates).toEqual([]);
  });
});

describe("focus.ts actions invalidate the list they change (#139)", () => {
  const actions = scanServerActions(readFileSync(ACTIONS_FILE, "utf8")).filter(
    (a) => a.exported && a.writes.length > 0,
  );

  it("finds the mutating actions at all (guards against a silent no-op scan)", () => {
    expect(actions.map((a) => a.name).sort()).toEqual([
      "beginFocus",
      "completeFocus",
      "completeStep",
      "giveUpFocus",
      "pauseFocus",
      "renameStep",
      "requeueFocus",
      "resumeFocus",
      "updateStepEstimate",
    ]);
  });

  it.each(
    // `it.each` needs a non-empty table, and the assertion above already fails
    // loudly if the scan finds nothing.
    actions.map((a) => [a.name, a] as const),
  )(
    "%s revalidates / unconditionally, or is a session-only writer",
    (_n, a) => {
      if (SESSION_ONLY_WRITERS[a.name]) {
        expect(
          a.writes,
          `${a.name} is exempt as a session-only writer, but it now writes ` +
            `${a.writes.join(", ")} — delete its SESSION_ONLY_WRITERS entry and ` +
            `add revalidatePath("/") (#139)`,
        ).toEqual([SESSION_MODEL]);
        return;
      }
      expect(
        a.revalidates,
        `${a.name} (focus.ts:${a.line}) writes ${a.writes.join(", ")} but never ` +
          `revalidates "/" at the top level of its body` +
          (a.conditionalRevalidates.includes("/")
            ? ' — it revalidates "/" inside a branch, which leaves the list ' +
              "stale on every path that skips it (#139)"
            : " — the home list is where those values are rendered (#139)"),
      ).toContain("/");
    },
  );

  it("every SESSION_ONLY_WRITERS entry still names a mutating action", () => {
    const mutating = new Set(actions.map((a) => a.name));
    for (const name of Object.keys(SESSION_ONLY_WRITERS)) {
      expect(
        mutating,
        `SESSION_ONLY_WRITERS lists "${name}", which focus.ts no longer ` +
          `exports as a mutating action — drop the stale entry`,
      ).toContain(name);
    }
  });
});
