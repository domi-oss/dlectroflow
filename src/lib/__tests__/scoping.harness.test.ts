import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * #35 Phase A — the workspace-scoping harness.
 *
 * The spec's "the owner sees usage numbers, never content" rule is only true if
 * no cross-workspace read path exists. This codebase has shipped an IDOR bug
 * before (#21), so that has to be structural rather than aspirational.
 *
 * The OBVIOUS version of this test is a trap and was rejected: filtering the
 * models that carry `workspaceId` and then asserting they are absent from a set
 * of models that don't is tautological — it can only fail if someone adds
 * `workspaceId` to an exempt model, and would otherwise pass forever while
 * proving nothing.
 *
 * What actually has to be true is that every Prisma call against a
 * workspace-scoped model is constrained to one workspace. That is a
 * source-level property, so this scans for it, with two rules:
 *
 *  1. STRICT — the call's own arguments must mention `workspaceId`. Applied to
 *     every read and every set-wide write, because those are the operations
 *     that can return or modify another workspace's rows on their own.
 *
 *  2. ENCLOSING-FUNCTION — `workspaceId` must appear earlier in the same
 *     function. Applied to single-row writes by primary key, which this
 *     codebase performs as a scoped `findFirst({ where: { id, workspaceId } })`
 *     guard followed by `update({ where: { id } })`. The guard is the
 *     authorization check; deleting it fails this rule, which is the point.
 */

// Reviewed and deliberately unscoped, each with a stated reason. Adding to this
// map is a security decision and should be argued for in review.
const REVIEWED_UNSCOPED: Record<string, string> = {};

// Operations whose own arguments must carry workspaceId.
const STRICT_OPS = [
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "aggregate",
  "groupBy",
  "create",
  "createMany",
  "updateMany",
  "deleteMany",
] as const;

// Operations addressed by primary key, where the authorization check is a
// scoped statement earlier in the same function.
const GUARDED_OPS = ["count", "update", "delete", "upsert"] as const;

/** Prisma model names that carry a workspaceId column, camelCased as the
 *  client exposes them. */
function scopedModels(): string[] {
  return Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === "workspaceId"))
    .map((m) => m.name[0].toLowerCase() + m.name.slice(1));
}

function sourceFiles(): string[] {
  return readdirSync("src", { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes(".test."))
    .map((f) => path.join("src", f));
}

/** The full argument text of a call, matched by balancing parentheses — a
 *  non-greedy regex stops at the first `)` inside a nested object. */
function callArgs(src: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(openParenIndex, i + 1);
    }
  }
  return src.slice(openParenIndex);
}

/**
 * Source text from the start of the enclosing named function to `index`.
 *
 * The boundary is the nearest `function ` keyword, NOT the nearest arrow: these
 * writes are routinely performed inside a `prisma.$transaction(async (tx) => …)`
 * callback whose authorization check sits just outside it, in the same exported
 * server action. Cutting at the arrow would report those as unscoped.
 */
function enclosingFunctionPrefix(src: string, index: number): string {
  const before = src.slice(0, index);
  const boundary = before.lastIndexOf("function ");
  return boundary === -1 ? before : before.slice(boundary);
}

/**
 * Did the enclosing function already constrain a scoped model to a workspace?
 *
 * This is the authorization check for by-id writes: the codebase reads
 * `findFirst({ where: { id, workspaceId } })` first and then writes by primary
 * key, sometimes writing a related row reached THROUGH that scoped read (an
 * item's task). Requiring merely that the word `workspaceId` appears would not
 * bite, because `const workspaceId = await currentWorkspaceId()` is on the
 * first line of every one of these functions. Requiring a scoped *query* means
 * deleting the guard fails the harness.
 */
function establishesScope(prefix: string, models: string[]): boolean {
  const re = new RegExp(
    `(?:prisma|tx|db)\\.(?:${models.join("|")})\\.\\w+\\(`,
    "g",
  );
  for (const m of prefix.matchAll(re)) {
    const args = callArgs(prefix, m.index + m[0].length - 1);
    if (args.includes("workspaceId")) return true;
  }
  return false;
}

type Offender = { file: string; call: string; rule: string };

function scan(): Offender[] {
  const models = scopedModels();
  const offenders: Offender[] = [];
  // `tx` and `db` are the transaction/injected-client aliases this codebase uses.
  const receivers = "(?:prisma|tx|db)";

  for (const file of sourceFiles()) {
    if (REVIEWED_UNSCOPED[file]) continue;
    const src = readFileSync(file, "utf8");
    for (const model of models) {
      const re = new RegExp(
        `${receivers}\\.${model}\\.(${[...STRICT_OPS, ...GUARDED_OPS].join("|")})\\(`,
        "g",
      );
      for (const m of src.matchAll(re)) {
        const op = m[1] as (typeof STRICT_OPS | typeof GUARDED_OPS)[number];
        const openParen = m.index + m[0].length - 1;
        const args = callArgs(src, openParen);
        if (args.includes("workspaceId")) continue;

        if ((STRICT_OPS as readonly string[]).includes(op)) {
          offenders.push({
            file,
            call: `${model}.${op}`,
            rule: "call must filter by workspaceId",
          });
          continue;
        }
        // GUARDED_OPS: accept only if the enclosing function already
        // constrained a scoped model to a workspace.
        const prefix = enclosingFunctionPrefix(src, m.index);
        if (!establishesScope(prefix, models)) {
          offenders.push({
            file,
            call: `${model}.${op}`,
            rule: "enclosing function runs no workspace-scoped query first",
          });
        }
      }
    }
  }
  return offenders;
}

describe("workspace-scoping harness", () => {
  it("finds the scoped models at all (guards against silently matching nothing)", () => {
    // If a refactor renamed the column, every rule below would vacuously pass.
    expect(scopedModels().length).toBeGreaterThanOrEqual(8);
  });

  it("scans a real number of source files", () => {
    expect(sourceFiles().length).toBeGreaterThan(50);
  });

  it("every prisma call against a workspace-scoped model is workspace-constrained", () => {
    const offenders = scan().map((o) => `${o.file}: ${o.call} — ${o.rule}`);
    expect(offenders).toEqual([]);
  });

  // ── #35 Phase B ──────────────────────────────────────────────────────────
  //
  // The People admin is where "the owner sees usage numbers, never content"
  // either holds or quietly stops holding. The rules above prove that every
  // query against a content model is workspace-constrained; these two prove the
  // stronger property the design actually promises about this feature: the People
  // code touches no content model AT ALL, and the encrypted per-user LLM key is
  // read in exactly two named places.

  /** Every module behind the owner-only People panel. */
  const PEOPLE_FILES = [
    "src/lib/people.ts",
    "src/app/actions/people.ts",
    "src/components/settings/people-panel.tsx",
  ];

  it("the People admin exists where this test thinks it does", () => {
    // Without this, renaming a People module turns the rule below into a test
    // that reads no files and passes forever.
    for (const file of PEOPLE_FILES) {
      expect(
        () => readFileSync(file, "utf8"),
        `${file} is missing`,
      ).not.toThrow();
    }
  });

  it("no People module queries a workspace-scoped model at all", () => {
    // Plain substring search per (receiver, model) pair rather than one regex
    // assembled from the model names. Same result, and it keeps a
    // regex-built-from-a-variable out of the codebase (semgrep
    // `non-literal-regexp`, flagged on !175) — the model list comes from Prisma's
    // DMMF, but a literal search needs no escaping argument at all.
    const models = scopedModels();
    const offenders: string[] = [];
    for (const file of PEOPLE_FILES) {
      const src = readFileSync(file, "utf8");
      for (const receiver of ["prisma", "tx", "db"]) {
        for (const model of models) {
          const needle = `${receiver}.${model}.`;
          if (src.includes(needle)) offenders.push(`${file}: ${needle}`);
        }
      }
    }
    // A People query against a content model would be a cross-workspace read
    // path by construction, whatever it filtered by — the panel has no business
    // reading content even from ONE workspace.
    expect(offenders).toEqual([]);
  });

  // The files allowed to name the ciphertext column, each with its reason.
  // Adding one is a security decision, and that is exactly the review
  // conversation this list forces — #118 Phase C's key writer is the third entry
  // this comment predicted.
  const KEY_CIPHERTEXT_FILES: Record<string, string> = {
    "src/lib/user-quota.ts":
      "decrypts it to bill the request to the user's own key",
    "src/lib/people.ts":
      "presence only — `{ llmKeyEnc: { not: null } }`, selecting ids",
    // #118 Phase C — the writer. Encrypts and stores the CALLER's own key
    // (`where: { id: me.id }`, no id parameter exists) and answers presence with
    // the same where-clause trick people.ts uses. It never reads the ciphertext
    // back: the panel is told a boolean, so no decrypted secret can reach an RSC
    // payload.
    "src/app/actions/account.ts":
      "writes the caller's own key, encrypted; presence-only read, never selected",
  };

  it("the key-ciphertext modules exist where this test thinks they do", () => {
    // Without this, renaming one turns the rule below into a test that reads no
    // files and passes forever — the same guard the People block uses.
    for (const file of Object.keys(KEY_CIPHERTEXT_FILES)) {
      expect(
        () => readFileSync(file, "utf8"),
        `${file} is missing`,
      ).not.toThrow();
    }
  });

  it("only the named modules touch the encrypted per-user LLM key", () => {
    const offenders = sourceFiles().filter((file) => {
      if (KEY_CIPHERTEXT_FILES[file]) return false;
      return readFileSync(file, "utf8")
        .split("\n")
        .some(
          (line) =>
            !line.trimStart().startsWith("//") &&
            !line.trimStart().startsWith("*") &&
            line.includes("llmKeyEnc"),
        );
    });
    expect(offenders).toEqual([]);
  });

  it("the key writer never SELECTS the ciphertext either", () => {
    // Same rule as the People read below, applied to the one file that WRITES
    // the column: writing it is necessary, reading it back into an object graph
    // is not — the panel is handed a boolean.
    //
    // Comments are stripped first (the idiom the OWNER_WORKSPACE_ID rule below
    // uses): account.ts's doc comment quotes the forbidden
    // `select: { llmKeyEnc: true }` in order to explain why it is not there, and
    // a rule that cannot tell code from prose punishes the explanation.
    const code = readFileSync("src/app/actions/account.ts", "utf8")
      .split("\n")
      .filter(
        (line) =>
          !line.trimStart().startsWith("//") &&
          !line.trimStart().startsWith("*"),
      )
      .join("\n");
    expect(code).not.toMatch(/llmKeyEnc:\s*true/);
    expect(code).toMatch(/llmKeyEnc:\s*\{\s*not:\s*null\s*\}/);
  });

  it("the People read never SELECTS the ciphertext, only tests it for presence", () => {
    // `select: { llmKeyEnc: true }` would pull an encrypted secret into the
    // object graph the panel's props are built from — one careless spread away
    // from the client. Presence is answered by a where-clause instead.
    const src = readFileSync("src/lib/people.ts", "utf8");
    expect(src).not.toMatch(/llmKeyEnc:\s*true/);
    expect(src).toMatch(/llmKeyEnc:\s*\{\s*not:\s*null\s*\}/);
  });

  it("no source file references the removed owner-workspace constant", () => {
    // Comments discussing the removal are fine; a live reference is not, so
    // strip line comments before matching.
    const hits = sourceFiles().filter((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .some(
          (line) =>
            !line.trimStart().startsWith("//") &&
            !line.trimStart().startsWith("*") &&
            line.includes("OWNER_WORKSPACE_ID"),
        ),
    );
    expect(hits).toEqual([]);
  });

  // ── #35 Phase C (#118) — user-keyed models ────────────────────────────────
  //
  // Everything above polices models that carry `workspaceId`. `GoogleAuth` does
  // not: it is keyed on `userId`, which means every `prisma.googleAuth.*` call in
  // the repo was invisible to this harness — including the ones Phase C makes
  // per-user. A credential row is the highest-value thing in the schema, so it
  // gets the same structural treatment content does, not a weaker one.
  //
  // ONE rule here, not two. The workspace side needs a GUARDED_OPS escape hatch
  // because this codebase writes by primary key after a scoped `findFirst`
  // guard. There is no such idiom for a user-keyed credential: the row IS
  // addressed by `userId` (it is a unique column), so every operation without
  // exception must name it in its own arguments. Stricter, and simpler to argue
  // about in review.

  /**
   * Models whose `userId` is an OWNERSHIP link rather than the key access is
   * granted by, each with a stated reason. Same idea as REVIEWED_UNSCOPED above:
   * adding an entry is a security decision to argue for in review.
   */
  const NOT_USER_SCOPED: Record<string, string> = {
    workspace:
      "the scoping SUBJECT — every content model's workspaceId points at it, and the rules above are what police reaching it. touchWorkspace legitimately upserts by its own id, taken from a verified signed token, so requiring a userId here would be a different and weaker rule than the one already enforced.",
  };

  /** Prisma models keyed on a user rather than a workspace, camelCased as the
   *  client exposes them. Excludes anything carrying `workspaceId` — those are
   *  already covered by the rules above and must not be policed twice under a
   *  weaker key — and anything in NOT_USER_SCOPED. */
  function userKeyedModels(): string[] {
    return Prisma.dmmf.datamodel.models
      .filter(
        (m) =>
          m.fields.some((f) => f.name === "userId") &&
          !m.fields.some((f) => f.name === "workspaceId"),
      )
      .map((m) => m.name[0].toLowerCase() + m.name.slice(1))
      .filter((m) => !NOT_USER_SCOPED[m]);
  }

  const USER_KEYED_OPS = [
    "findMany",
    "findFirst",
    "findFirstOrThrow",
    "findUnique",
    "findUniqueOrThrow",
    "aggregate",
    "groupBy",
    "count",
    "create",
    "createMany",
    "update",
    "updateMany",
    "upsert",
    "delete",
    "deleteMany",
  ] as const;

  /** Ops that select rows by a filter; everything else here writes new ones. */
  const CREATE_OPS = new Set(["create", "createMany"]);

  /**
   * The clause that decides WHOSE rows a call touches — `where` for anything
   * that selects existing rows, `data` for a create.
   *
   * #154: reading the whole argument text instead was a false pass waiting to
   * happen. `findUnique({ where: { id }, select: { userId: true } })` names no
   * owner and constrains nothing, yet a substring search for `userId` finds one,
   * because `select` decides which COLUMNS come back rather than which ROWS. A
   * rule that cannot tell those apart reports coverage it does not have — the
   * exact failure this whole file exists to avoid. Returns "" when the clause is
   * absent, which fails closed.
   *
   * The key is matched only at the TOP LEVEL of the argument object, never
   * nested. `indexOf("where:")` would find the first one anywhere, and a
   * relation filter inside a `select` — `select: { steps: { where: … } }` — sits
   * earlier in the source than the call's own `where` often enough that the rule
   * would silently start reading the wrong clause. Nothing in the tree does that
   * today; a guard that only holds for today's call sites is not a guard.
   */
  function ownerClause(args: string, op: string): string {
    const key = CREATE_OPS.has(op) ? "data:" : "where:";
    // `args` opens with the call's `(`, so the argument object's own properties
    // sit at brace depth 1.
    let depth = 0;
    for (let i = 0; i < args.length; i++) {
      const ch = args[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (
        depth === 1 &&
        ch === key[0] &&
        args.startsWith(key, i) &&
        // A property name, not the tail of a longer identifier.
        !/[A-Za-z0-9_$]/.test(args[i - 1] ?? "")
      ) {
        const open = args.indexOf("{", i + key.length);
        if (open === -1) return "";
        let inner = 0;
        for (let j = open; j < args.length; j++) {
          if (args[j] === "{") inner++;
          else if (args[j] === "}") {
            inner--;
            if (inner === 0) return args.slice(open, j + 1);
          }
        }
        return args.slice(open);
      }
    }
    return "";
  }

  /**
   * The lookups allowed to key on a CAPABILITY instead of an owner, each with
   * its reason. Adding an entry is a security decision, and the narrowness is
   * the point: the key is `model.op`, so the allowance covers one operation on
   * one model and nothing adjacent to it.
   *
   * `USER_KEYED_OWNERS` below independently confines every one of these to a
   * single module, so an exception here cannot be reached from a route handler,
   * a component or a serialiser.
   */
  const BY_CAPABILITY_LOOKUPS: Record<string, string> = {
    // #154. A calendar client cannot present a session cookie — Google, Apple
    // and Outlook all fetch a subscription anonymously — so possession of the
    // 256-bit token IS the authorization, and requiring a userId alongside it
    // would mean requiring something the caller has no way to supply. The token
    // column is `@unique`, so this is one row by an unguessable key; the owner's
    // `status` is then checked separately in the same function.
    "calendarFeed.findUnique":
      "the capability URL's token is the credential — a subscribing calendar client has no session to present, and the token column is unique so this reads exactly one row",
  };

  /** Does this call name its owner where it counts? */
  function namesOwner(model: string, op: string, args: string): boolean {
    const clause = ownerClause(args, op);
    if (clause.includes("userId")) return true;
    return (
      BY_CAPABILITY_LOOKUPS[`${model}.${op}`] != null &&
      clause.includes("token")
    );
  }

  /**
   * Scan one file's source for user-keyed calls that do not name `userId`.
   *
   * Takes the source as a string rather than a path so the tests below can prove
   * it BITES against a fixture. A scanner that is only ever pointed at a clean
   * repo cannot be distinguished from a scanner that matches nothing, which is
   * the exact failure mode the module comment above warns about.
   */
  function scanUserScope(src: string, models: string[]): string[] {
    const offenders: string[] = [];
    for (const model of models) {
      const re = new RegExp(
        `(?:prisma|tx|db)\\.${model}\\.(${USER_KEYED_OPS.join("|")})\\(`,
        "g",
      );
      for (const m of src.matchAll(re)) {
        const args = callArgs(src, m.index + m[0].length - 1);
        if (!namesOwner(model, m[1], args)) offenders.push(`${model}.${m[1]}`);
      }
    }
    return offenders;
  }

  it("finds exactly the user-keyed models, and finds them at all", () => {
    // Pinned as an exact set rather than a `toContain`: a NEW user-keyed model
    // must fail this test and force a decision (policed, or NOT_USER_SCOPED with
    // a reason) instead of arriving unpoliced. And without the "at all" half,
    // every rule below would vacuously pass if `userId` were renamed.
    //
    // #154's `calendarFeed` is the third, and this test is what made it a
    // decision: it failed the moment the model was added, which is the whole
    // reason the feed token lives on its own row rather than as a nullable
    // column on `User` — `User` carries neither `workspaceId` nor `userId`, so
    // nothing in this file can see a `prisma.user.*` call at all.
    expect(userKeyedModels().sort()).toEqual([
      "calendarFeed",
      "googleAuth",
      "userAiUsage",
    ]);
  });

  it("does not police a workspace-keyed model under the weaker user rule", () => {
    // Anything carrying workspaceId belongs to the strict rules above; being
    // caught by both would let the weaker rule look like coverage.
    for (const model of userKeyedModels()) {
      expect(scopedModels()).not.toContain(model);
    }
  });

  it("every NOT_USER_SCOPED entry names a real model and states a reason", () => {
    // An entry for a model that no longer exists is a stale exemption that reads
    // like considered coverage.
    const all = Prisma.dmmf.datamodel.models.map(
      (m) => m.name[0].toLowerCase() + m.name.slice(1),
    );
    for (const [model, reason] of Object.entries(NOT_USER_SCOPED)) {
      expect(all, `${model} is not a model`).toContain(model);
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it("flags a user-keyed call that does not name userId", () => {
    // The fixture is the proof this rule can fail. Both shapes below are exactly
    // what a Phase C regression looks like: the old singleton key, and a lookup
    // by primary key with no user constraint at all.
    const bad = `
      await prisma.googleAuth.upsert({ where: { id: SINGLETON_ID }, create: {}, update: {} });
      await prisma.googleAuth.findUnique({ where: { id } });
      await prisma.googleAuth.deleteMany({ where: { id: SINGLETON_ID } });
    `;
    // Source order — one regex per model, alternated over the ops, so matchAll
    // walks the file top to bottom.
    expect(scanUserScope(bad, ["googleAuth"])).toEqual([
      "googleAuth.upsert",
      "googleAuth.findUnique",
      "googleAuth.deleteMany",
    ]);
  });

  it("accepts a user-keyed call that does name userId", () => {
    const good = `
      await prisma.googleAuth.findUnique({ where: { userId } });
      await prisma.googleAuth.upsert({ where: { userId }, create: { userId }, update: {} });
      await tx.googleAuth.deleteMany({ where: { userId } });
    `;
    expect(scanUserScope(good, ["googleAuth"])).toEqual([]);
  });

  /**
   * #154 — the false pass this rule shipped with, and the reason the check now
   * reads the WHERE clause rather than the whole argument text.
   *
   * `args.includes("userId")` cannot tell the clause that decides WHICH ROWS are
   * touched from the clause that decides which COLUMNS come back. A lookup by
   * primary key that merely *selects* `userId` therefore satisfied the old rule
   * while naming no owner at all — and that is not hypothetical: it is the exact
   * shape `resolveFeed` would have had if it were written carelessly.
   */
  it("is not satisfied by a userId that appears only in the SELECT", () => {
    const bad = `
      await prisma.googleAuth.findUnique({ where: { id }, select: { userId: true } });
    `;
    expect(scanUserScope(bad, ["googleAuth"])).toEqual([
      "googleAuth.findUnique",
    ]);
  });

  it("reads the call's OWN where, not a relation filter nested inside a select", () => {
    // `indexOf("where:")` would find the inner one first and read `{ done: false }`
    // as the owner clause — which, being an object that happens to be there,
    // could just as easily have contained the word `userId` and passed. Nothing
    // in the tree writes this shape today; a guard that only holds for today's
    // call sites is not a guard.
    const bad = `
      await prisma.googleAuth.findFirst({
        select: { user: { where: { userId } } },
        where: { id },
      });
    `;
    expect(scanUserScope(bad, ["googleAuth"])).toEqual([
      "googleAuth.findFirst",
    ]);
  });

  it("still finds the call's own where when a nested one precedes it", () => {
    const good = `
      await prisma.googleAuth.findFirst({
        select: { user: { where: { id } } },
        where: { userId },
      });
    `;
    expect(scanUserScope(good, ["googleAuth"])).toEqual([]);
  });

  it("reads `data` rather than `where` for a create, which has no where", () => {
    const good = `
      await prisma.userAiUsage.create({ data: { userId, count: 1 } });
    `;
    expect(scanUserScope(good, ["userAiUsage"])).toEqual([]);
  });

  it("flags a create whose data names no owner", () => {
    const bad = `
      await prisma.userAiUsage.create({ data: { count: 1 }, select: { userId: true } });
    `;
    expect(scanUserScope(bad, ["userAiUsage"])).toEqual(["userAiUsage.create"]);
  });

  // ── #154 — the ONE lookup keyed on a capability instead of an owner ────────

  it("allows the named capability lookup to key on its token", () => {
    // `calendarFeed.findUnique` by token IS the authorization: a calendar client
    // cannot present a session cookie, so possession of the token is all there
    // is. BY_CAPABILITY_LOOKUPS is where that is argued for.
    const good = `
      await prisma.calendarFeed.findUnique({ where: { token }, select: { userId: true } });
    `;
    expect(scanUserScope(good, ["calendarFeed"])).toEqual([]);
  });

  it("does not widen the exception to other operations on the same model", () => {
    // A set-wide read or a write keyed on a token would be a different and much
    // worse thing than one row fetched by an unguessable unique key.
    const bad = `
      await prisma.calendarFeed.findMany({ where: { token } });
      await prisma.calendarFeed.updateMany({ where: { token }, data: {} });
      await prisma.calendarFeed.delete({ where: { token } });
    `;
    expect(scanUserScope(bad, ["calendarFeed"])).toEqual([
      "calendarFeed.findMany",
      "calendarFeed.updateMany",
      "calendarFeed.delete",
    ]);
  });

  it("does not let the exception excuse a lookup keyed on anything else", () => {
    // The allowance is for `token`, not for "findUnique on this model".
    const bad = `
      await prisma.calendarFeed.findUnique({ where: { id } });
    `;
    expect(scanUserScope(bad, ["calendarFeed"])).toEqual([
      "calendarFeed.findUnique",
    ]);
  });

  it("every BY_CAPABILITY_LOOKUPS entry names a real model and states a reason", () => {
    const all = Prisma.dmmf.datamodel.models.map(
      (m) => m.name[0].toLowerCase() + m.name.slice(1),
    );
    for (const [key, reason] of Object.entries(BY_CAPABILITY_LOOKUPS)) {
      const [model, op] = key.split(".");
      expect(all, `${model} is not a model`).toContain(model);
      expect(USER_KEYED_OPS as readonly string[]).toContain(op);
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it("is not fooled by a nested object closing early", () => {
    // callArgs balances parentheses; a non-greedy regex would stop at the first
    // `)` and miss the userId that follows it.
    const good = `
      await prisma.googleAuth.upsert({
        where: { userId },
        create: { userId, expiresAt: new Date(Date.now() + 3600) },
        update: {},
      });
    `;
    expect(scanUserScope(good, ["googleAuth"])).toEqual([]);
  });

  it("every prisma call against a user-keyed model names userId", () => {
    const models = userKeyedModels();
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const call of scanUserScope(readFileSync(file, "utf8"), models)) {
        offenders.push(`${file}: ${call}`);
      }
    }
    // A credential row that a call can reach without naming its owner is an
    // IDOR waiting for a second account (#21, #119).
    expect(offenders).toEqual([]);
  });

  // The only modules allowed to touch a user-keyed model, each with its reason.
  // #118's recon found both of these were already the sole touchers; pinning it
  // is what keeps the blast radius one file per model FOREVER, instead of one
  // file today. Adding an entry is a security decision to argue for in review.
  const USER_KEYED_OWNERS: Record<string, string> = {
    "src/lib/google.ts":
      "the entire prisma.googleAuth surface — six functions, each keyed on the acting user",
    "src/lib/user-quota.ts":
      "the entire prisma.userAiUsage surface — the per-user AI meter, every statement bound to one userId",
    // #154 — the calendar subscription feed's capability token. Every exported
    // function takes the acting user's id and NONE of them accepts a row id, so
    // there is nothing a caller could point at another account's feed. The one
    // by-token lookup is argued for in BY_CAPABILITY_LOOKUPS above, and this
    // entry is what keeps it unreachable from anywhere else.
    "src/lib/calendar-feed.ts":
      "the entire prisma.calendarFeed surface — mint, rotate, disable and the single capability lookup, all in one module",
  };

  it("the credential modules exist where this test thinks they do", () => {
    // Without this, renaming one of them turns the rule below into a test that
    // reads no files and passes forever — the same guard the People block uses.
    for (const file of Object.keys(USER_KEYED_OWNERS)) {
      expect(
        () => readFileSync(file, "utf8"),
        `${file} is missing`,
      ).not.toThrow();
    }
  });

  it("only the named module touches a user-keyed model", () => {
    // Plain substring search per (receiver, model) pair rather than a regex
    // assembled from a variable (semgrep `non-literal-regexp`, flagged on !175).
    const models = userKeyedModels();
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (USER_KEYED_OWNERS[file]) continue;
      const src = readFileSync(file, "utf8");
      for (const receiver of ["prisma", "tx", "db"]) {
        for (const model of models) {
          const needle = `${receiver}.${model}.`;
          if (src.includes(needle)) offenders.push(`${file}: ${needle}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // ── #154 — the one route that authorises from something other than a session ─
  //
  // Everything above polices WHICH ROWS a query may reach. The calendar feed
  // needs one thing more, because it is the only endpoint in the app that a
  // caller reaches with no cookie at all: authorization must happen in the
  // pinned module and nowhere else. `resolveFeed` checks the token AND the
  // owner's status; a handler that grew its own query would be a second place
  // where "whose data is this" gets decided, and the second place is the one
  // that gets it wrong.

  const FEED_ROUTE = "src/app/api/ics/feed/[token]/route.ts";

  it("the feed endpoint exists where this test thinks it does", () => {
    // Without this, renaming the route turns the rule below into a test that
    // reads no file and passes forever — the same guard the People block uses.
    expect(
      () => readFileSync(FEED_ROUTE, "utf8"),
      `${FEED_ROUTE} is missing`,
    ).not.toThrow();
  });

  it("the feed endpoint reaches the database only through the pinned module", () => {
    // Comments stripped first: the route's doc comment states this property in
    // order to explain it, and a rule that cannot tell code from prose punishes
    // the explanation (the idiom the OWNER_WORKSPACE_ID rule above uses).
    const code = readFileSync(FEED_ROUTE, "utf8")
      .split("\n")
      .filter(
        (line) =>
          !line.trimStart().startsWith("//") &&
          !line.trimStart().startsWith("*"),
      )
      .join("\n");
    expect(code).not.toMatch(/\bprisma\./);
    // The control: the file really does authorise, so an absent `prisma.` is
    // "it delegates" rather than "it never checks anything".
    expect(code).toMatch(/resolveFeed\(/);
  });
});
