import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  envNumberDefault,
  tsNumberConstant,
  CLIENT_WINDOW_CONSTANT,
  SERVER_TTL_ENV_VAR,
} from "@/lib/capture-orphan-window";

/**
 * #175 — the orphan window and the server's guest TTL are two surfaces stating
 * the same fact, and this is the gate that keeps them stating it.
 *
 * Same family and same shape as `log-retention` (#157), which is the member of
 * the enum/constraint-sync family that can actually do this: a pure module with
 * no `fs`, unit-tested on synthetic input, plus this colocated test reading the
 * real files. `enum-constraint-sync` cannot — it queries
 * `pg_constraint WHERE contype = 'c'`, and a TypeScript constant is not a
 * database constraint. Neither can `env-drift`: `computeConfigSurfaceDrift`
 * diffs **key sets** in both directions and never compares a value, so a 24
 * drifting to 72 passes it.
 *
 * ⚠️ **What it cannot see, stated rather than implied.** An operator who sets
 * `GUEST_SANDBOX_TTL_HOURS=72` on their own cluster moves the server side of
 * this comparison out of CI's reach. CI can compare the two **defaults**; it
 * cannot see a real environment. That is the same boundary `log-retention`
 * handles by reporting undetermined rather than clean, and it is why the client
 * constant's own comment carries the operator-facing consequence and
 * `docs/legal.md`'s Guest TTL row names the orphan window.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

describe("orphan window — the server default parser (#175)", () => {
  it("reads the default out of a `process.env.X ?? n` binding", () => {
    const source = `export function ttl(): number {
  return Number(process.env.GUEST_SANDBOX_TTL_HOURS ?? 24);
}`;
    expect(envNumberDefault(source, "GUEST_SANDBOX_TTL_HOURS")).toBe(24);
  });

  it("returns null when the variable is renamed — the whole point of the gate", () => {
    // Lifted from `shellDefault`'s own discipline: an absent default fails the
    // assertion loudly instead of comparing two things that are both missing. A
    // rename is exactly how this class of guard starts passing vacuously.
    const source = `return Number(process.env.GUEST_TTL_HOURS ?? 24);`;
    expect(envNumberDefault(source, "GUEST_SANDBOX_TTL_HOURS")).toBeNull();
  });

  it("returns null when the fallback is not a plain number", () => {
    const source = `return Number(process.env.GUEST_SANDBOX_TTL_HOURS ?? someOther);`;
    expect(envNumberDefault(source, "GUEST_SANDBOX_TTL_HOURS")).toBeNull();
  });

  it("returns null when the variable is read with no fallback at all", () => {
    const source = `return Number(process.env.GUEST_SANDBOX_TTL_HOURS);`;
    expect(envNumberDefault(source, "GUEST_SANDBOX_TTL_HOURS")).toBeNull();
  });

  it("ignores a mention inside a comment", () => {
    // `purge.ts` names the number in its own docblock ("default 24"), so a
    // parser that read prose would find a number without reading any code — and
    // would keep finding one after the code stopped agreeing with it.
    const source = `// GUEST_SANDBOX_TTL_HOURS ?? 99 is the old default.
return Number(process.env.GUEST_SANDBOX_TTL_HOURS ?? 24);`;
    expect(envNumberDefault(source, "GUEST_SANDBOX_TTL_HOURS")).toBe(24);
  });

  it("does not match a longer name that merely starts with the one asked for", () => {
    const source = `return Number(process.env.GUEST_SANDBOX_TTL_HOURS_LEGACY ?? 72);`;
    expect(envNumberDefault(source, "GUEST_SANDBOX_TTL_HOURS")).toBeNull();
  });
});

describe("orphan window — the client constant parser (#175)", () => {
  it("reads an exported numeric constant", () => {
    const source = `export const CAPTURE_ORPHAN_WINDOW_HOURS = 24;`;
    expect(tsNumberConstant(source, "CAPTURE_ORPHAN_WINDOW_HOURS")).toBe(24);
  });

  it("accepts a numeric separator, because this repo writes 10_000", () => {
    const source = `export const SOME_HOURS = 1_000;`;
    expect(tsNumberConstant(source, "SOME_HOURS")).toBe(1000);
  });

  it("returns null when the constant is renamed", () => {
    const source = `export const ORPHAN_WINDOW_HOURS = 24;`;
    expect(tsNumberConstant(source, "CAPTURE_ORPHAN_WINDOW_HOURS")).toBeNull();
  });

  it("returns null when the value is an expression rather than a literal", () => {
    // A derived value is not necessarily wrong, but this parser must not guess
    // at one — reporting null makes the gate fail loudly and someone decide.
    const source = `export const CAPTURE_ORPHAN_WINDOW_HOURS = BASE * 2;`;
    expect(tsNumberConstant(source, "CAPTURE_ORPHAN_WINDOW_HOURS")).toBeNull();
  });

  it("ignores a docblock that names the constant", () => {
    const source = `/** CAPTURE_ORPHAN_WINDOW_HOURS = 999 in an earlier draft. */
export const CAPTURE_ORPHAN_WINDOW_HOURS = 24;`;
    expect(tsNumberConstant(source, "CAPTURE_ORPHAN_WINDOW_HOURS")).toBe(24);
  });

  it("does not match a longer name with the same prefix", () => {
    const source = `export const CAPTURE_ORPHAN_WINDOW_HOURS_MAX = 72;`;
    expect(tsNumberConstant(source, "CAPTURE_ORPHAN_WINDOW_HOURS")).toBeNull();
  });
});

describe("orphan window — the two real surfaces still agree (#175)", () => {
  const serverDefault = envNumberDefault(
    read("src/lib/purge.ts"),
    SERVER_TTL_ENV_VAR,
  );
  const clientWindow = tsNumberConstant(
    read("src/lib/capture-queue.ts"),
    CLIENT_WINDOW_CONSTANT,
  );

  it("finds the server's guest-sandbox TTL default", () => {
    expect(serverDefault).not.toBeNull();
  });

  it("finds the client's orphan window", () => {
    expect(clientWindow).not.toBeNull();
  });

  it("keeps the client window at least as long as the server TTL", () => {
    // `client >= server`, deliberately not equality. Erring long only delays
    // reclaiming bytes; erring short deletes a queued capture whose workspace
    // still resolves — the one outcome the design forbids everywhere. A gate
    // that reds on a SAFE change is a gate someone relaxes.
    expect(clientWindow).not.toBeNull();
    expect(serverDefault).not.toBeNull();
    expect(clientWindow as number).toBeGreaterThanOrEqual(
      serverDefault as number,
    );
  });

  it("names the orphan window in docs/legal.md's Guest TTL row", () => {
    // The registry tying this TTL to the places user-facing prose states it. The
    // third retention trigger on /privacy IS this constant, so a reader auditing
    // the retention promise has to be able to find the number from that table.
    expect(read("docs/legal.md")).toContain(CLIENT_WINDOW_CONSTANT);
  });
});
