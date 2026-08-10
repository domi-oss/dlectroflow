import { describe, it, expect } from "vitest";
import {
  SESSION_PRIMITIVES,
  TOKEN_LEVEL_RESOLVERS,
  WORKSPACE_MODULE,
  findExportedFunctionNames,
  findSessionPrimitiveBindings,
  findSessionResolvers,
  findTokenResolverEscapes,
} from "@/lib/workspace-resolver-hygiene";

/**
 * #220 — the parsers behind rules 1 and 2 of the scoping harness, on synthetic
 * input. Rule 2 is first; rule 1's block is further down, with its own argument.
 *
 * `resolveWorkspace()` and `resolveWorkspaceId()` answer "what is signed here",
 * not "may this account still act". Keeping them status-blind is deliberate
 * (`hasSession()` is built on the fact they touch no database), and the whole
 * reason that is safe is that nothing outside `src/lib/workspace.ts` may reach
 * them: the status check lives one level up in `currentWorkspaceId()`.
 *
 * The first version of rule 2 tested that property by looking for the literal
 * text of a call. Review on `!305` pointed out it is defeated by a rename on
 * import — `import { resolveWorkspaceId as getWsId }` — which then calls
 * straight past the status check under a name no substring can predict, and
 * that was verified against the real harness before this module existed.
 *
 * So the question this module asks is not "does this file call something spelled
 * a certain way" but **"does this file get hold of a token-level resolver at
 * all"**, which is decided at the import, where the exported name is written
 * down whatever the local alias becomes.
 *
 * ## Why a reference, not a call
 *
 * A call site is one way to use a reference and not the only one:
 * `withWorkspace(resolveWorkspaceId)` never writes the call, and neither does
 * storing it in an object. Outside `workspace.ts` there is no legitimate use for
 * the reference at all, so holding one is the finding and the analysis stops
 * being a search for syntax.
 *
 * ## Pure, like every other file-parsing guard here
 *
 * No `fs`: it takes source text so it can be exercised on synthetic input,
 * including the deliberately-bad kind below. The scan of the real tree lives in
 * `src/lib/__tests__/scoping.harness.test.ts`, next to the rest of the #220
 * argument.
 */

/** A source file position that is not the workspace module itself. */
const CALLER = "src/app/actions/thing.ts";

describe("findTokenResolverEscapes — imports that escape the module", () => {
  it("flags the rename-on-import that defeated the text rule", () => {
    // The finding from `!305`, as a fixture. `getWsId(` matches neither resolver
    // name, so the substring rule this replaces reported a clean zero for it.
    const findings = findTokenResolverEscapes(
      `import { resolveWorkspaceId as getWsId } from "@/lib/workspace";

       export async function ownerWorkspace(owner: string) {
         return getWsId({ owner });
       }`,
      CALLER,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].resolver).toBe("resolveWorkspaceId");
    expect(findings[0].local).toBe("getWsId");
    expect(findings[0].line).toBe(1);
    expect(findings[0].reason).toContain("currentWorkspaceId");
  });

  it("flags the plain named import too", () => {
    const findings = findTokenResolverEscapes(
      `import { resolveWorkspaceId } from "@/lib/workspace";`,
      CALLER,
    );
    expect(findings.map((f) => f.resolver)).toEqual(["resolveWorkspaceId"]);
  });

  it("flags an import that never calls what it took", () => {
    // `withWorkspace(resolveWorkspace)` reaches past the status check exactly as
    // a call does, and writes no call for a call-site rule to find.
    const findings = findTokenResolverEscapes(
      `import { resolveWorkspace } from "@/lib/workspace";

       export const resolver = { workspace: resolveWorkspace };`,
      CALLER,
    );
    expect(findings.map((f) => f.resolver)).toEqual(["resolveWorkspace"]);
  });

  it("flags both resolvers in one import, in source order", () => {
    const findings = findTokenResolverEscapes(
      `import {
         currentWorkspaceId,
         resolveWorkspace,
         resolveWorkspaceId as unwrap,
       } from "@/lib/workspace";`,
      CALLER,
    );
    expect(findings.map((f) => [f.resolver, f.line])).toEqual([
      ["resolveWorkspace", 3],
      ["resolveWorkspaceId", 4],
    ]);
  });

  it("resolves a relative specifier, not just the `@/` alias", () => {
    // A sibling in `src/lib` writes `./workspace`, and the module path has to be
    // resolved against the importing file or the rule only ever sees one spelling.
    expect(
      findTokenResolverEscapes(
        `import { resolveWorkspaceId } from "./workspace";`,
        "src/lib/people.ts",
      ),
    ).toHaveLength(1);
    expect(
      findTokenResolverEscapes(
        `import { resolveWorkspaceId } from "../../lib/workspace";`,
        "src/app/actions/thing.ts",
      ),
    ).toHaveLength(1);
  });

  it("sees through an explicit file extension on the specifier", () => {
    expect(
      findTokenResolverEscapes(
        `import { resolveWorkspaceId } from "@/lib/workspace.js";`,
        CALLER,
      ),
    ).toHaveLength(1);
  });

  it("flags a resolver reached through a namespace import", () => {
    // Importing the namespace is fine — the module's public entry points live
    // there too. Reaching into it for a token-level resolver is not.
    const findings = findTokenResolverEscapes(
      `import * as ws from "@/lib/workspace";

       export async function ownerWorkspace(owner: string) {
         return ws.resolveWorkspaceId({ owner });
       }`,
      CALLER,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].local).toBe("ws.resolveWorkspaceId");
    expect(findings[0].line).toBe(4);
  });

  it("flags a namespace reached by element access", () => {
    // `ws["resolveWorkspaceId"]` is the same reference with a different syntax,
    // and is the first thing a rule keyed on property access misses.
    const findings = findTokenResolverEscapes(
      `import * as ws from "@/lib/workspace";
       export const f = ws["resolveWorkspaceId"];`,
      CALLER,
    );
    expect(findings.map((f) => f.resolver)).toEqual(["resolveWorkspaceId"]);
  });

  it("flags a dynamic import destructured to an alias", () => {
    const findings = findTokenResolverEscapes(
      `export async function ownerWorkspace(owner: string) {
         const { resolveWorkspaceId: unwrap } = await import("@/lib/workspace");
         return unwrap({ owner });
       }`,
      CALLER,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].local).toBe("unwrap");
  });

  it("flags a dynamic import held as a namespace", () => {
    const findings = findTokenResolverEscapes(
      `export async function ownerWorkspace(owner: string) {
         const ws = await import("@/lib/workspace");
         return ws.resolveWorkspaceId({ owner });
       }`,
      CALLER,
    );
    expect(findings.map((f) => f.local)).toEqual(["ws.resolveWorkspaceId"]);
  });

  it("flags a dynamic import destructured in a `.then` callback", () => {
    // The spelling that survives when someone avoids `await`. Left out of the
    // first draft, which would have been a hole in a guard about holes.
    const findings = findTokenResolverEscapes(
      `export const ownerWorkspace = (owner: string) =>
         import("@/lib/workspace").then(({ resolveWorkspaceId: id }) =>
           id({ owner }),
         );`,
      CALLER,
    );
    expect(findings.map((f) => f.local)).toEqual(["id"]);
  });

  it("flags a dynamic import destructured by a quoted key", () => {
    // Legal, odd, and exactly the shape a rule that reads the key's SOURCE TEXT
    // misses, because the text carries the quotes. One spelling further out than
    // the rename that started this.
    const findings = findTokenResolverEscapes(
      `export async function ownerWorkspace(owner: string) {
         const { "resolveWorkspaceId": id } = await import("@/lib/workspace");
         return id({ owner });
       }`,
      CALLER,
    );
    expect(findings.map((f) => f.local)).toEqual(["id"]);
  });

  it("flags a rest capture of a dynamic import", () => {
    const findings = findTokenResolverEscapes(
      `export async function ownerWorkspace(owner: string) {
         const { currentUser, ...rest } = await import("@/lib/workspace");
         return rest.resolveWorkspace({ owner });
       }`,
      CALLER,
    );
    expect(findings.map((f) => f.local)).toEqual(["rest.resolveWorkspace"]);
  });
});

describe("findTokenResolverEscapes — re-exports, which launder the name", () => {
  it("flags a named re-export", () => {
    // A re-export is how a substring rule keyed on the workspace module's own
    // path gets walked around: the next file imports the resolver from HERE, and
    // its specifier no longer names `workspace` at all.
    const findings = findTokenResolverEscapes(
      `export { resolveWorkspaceId } from "@/lib/workspace";`,
      "src/lib/session-helpers.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toContain("re-export");
  });

  it("flags a renamed re-export", () => {
    const findings = findTokenResolverEscapes(
      `export { resolveWorkspace as workspaceOf } from "@/lib/workspace";`,
      "src/lib/session-helpers.ts",
    );
    expect(findings.map((f) => [f.resolver, f.local])).toEqual([
      ["resolveWorkspace", "workspaceOf"],
    ]);
  });

  it("flags a star re-export once per resolver it carries", () => {
    const findings = findTokenResolverEscapes(
      `export * from "@/lib/workspace";`,
      "src/lib/session-helpers.ts",
    );
    expect(findings.map((f) => f.resolver)).toEqual([...TOKEN_LEVEL_RESOLVERS]);
  });

  it("flags a namespace re-export", () => {
    const findings = findTokenResolverEscapes(
      `export * as ws from "@/lib/workspace";`,
      "src/lib/session-helpers.ts",
    );
    expect(findings.map((f) => f.local)).toEqual(
      TOKEN_LEVEL_RESOLVERS.map((r) => `ws.${r}`),
    );
  });
});

describe("findTokenResolverEscapes — the controls, which must stay silent", () => {
  // A guard that also fires on the correct code is a guard that gets relaxed
  // rather than fixed, so each of these is a shape that MUST NOT be a finding.

  it("says nothing about the public entry points", () => {
    expect(
      findTokenResolverEscapes(
        `import { currentWorkspaceId, currentUser, hasSession } from "@/lib/workspace";

         export async function act() {
           return currentWorkspaceId();
         }`,
        CALLER,
      ),
    ).toEqual([]);
  });

  it("says nothing about a same-named LOCAL function", () => {
    // The reference is not the module's, so it cannot skip a check the module
    // makes. Flagging it would be inventing a finding out of a name collision.
    expect(
      findTokenResolverEscapes(
        `async function resolveWorkspaceId(input: { owner: string }) {
           return input.owner;
         }

         export const id = resolveWorkspaceId({ owner: "a" });`,
        CALLER,
      ),
    ).toEqual([]);
  });

  it("says nothing about a same-named PARAMETER", () => {
    // A sibling guard in this repo resolves identifiers without ever looking at
    // parameters, so a parameter binds to an unrelated top-level `const` and the
    // guard fabricates a finding. Nothing here resolves an identifier at all —
    // this pins that the shape is silent rather than merely unlikely.
    expect(
      findTokenResolverEscapes(
        `export function withResolver(resolveWorkspaceId: () => string) {
           return resolveWorkspaceId();
         }`,
        CALLER,
      ),
    ).toEqual([]);
  });

  it("says nothing about a same-named import from a DIFFERENT module", () => {
    // If that module got it from `workspace.ts`, the re-export there is the
    // finding; if it declared its own, this is a name collision.
    expect(
      findTokenResolverEscapes(
        `import { resolveWorkspaceId } from "@/lib/legacy-session";

         export const id = resolveWorkspaceId({ owner: "a" });`,
        CALLER,
      ),
    ).toEqual([]);
  });

  it("says nothing about a type-only import", () => {
    // No runtime binding exists, so nothing can be called through it.
    expect(
      findTokenResolverEscapes(
        `import type { resolveWorkspaceId } from "@/lib/workspace";`,
        CALLER,
      ),
    ).toEqual([]);
    expect(
      findTokenResolverEscapes(
        `import { type resolveWorkspaceId, currentUser } from "@/lib/workspace";`,
        CALLER,
      ),
    ).toEqual([]);
  });

  it("says nothing about a type-only re-export", () => {
    expect(
      findTokenResolverEscapes(
        `export type { ResolvedWorkspace } from "@/lib/workspace";
         export { type resolveWorkspaceId } from "@/lib/workspace";`,
        "src/lib/session-helpers.ts",
      ),
    ).toEqual([]);
  });

  it("says nothing about a re-export of a public entry point", () => {
    expect(
      findTokenResolverEscapes(
        `export { currentWorkspaceId } from "@/lib/workspace";`,
        "src/lib/session-helpers.ts",
      ),
    ).toEqual([]);
  });

  it("says nothing about a namespace used for its public entry points", () => {
    expect(
      findTokenResolverEscapes(
        `import * as ws from "@/lib/workspace";

         export async function act() {
           return ws.currentWorkspaceId();
         }`,
        CALLER,
      ),
    ).toEqual([]);
  });

  it("does not read a comment as code", () => {
    // Not hypothetical: `src/app/actions/account.ts` names `resolveWorkspace()`
    // in prose in order to explain why it does NOT call it, and this repo has
    // twice shipped a tool that read a comment as code. The rule this module
    // replaces needed a line-stripping pass to survive that file; parsing means
    // a comment is not a node.
    expect(
      findTokenResolverEscapes(
        `// currentUser() already resolves it to null — but resolveWorkspace()
         // would still hand back a workspace id, so we do not call it here.
         /** See resolveWorkspaceId() in @/lib/workspace for the token-level read. */
         export const note = 1;`,
        CALLER,
      ),
    ).toEqual([]);
  });

  it("does not read a string literal as an import", () => {
    expect(
      findTokenResolverEscapes(
        `export const BANNED = ["resolveWorkspace", "resolveWorkspaceId"];
         export const FROM = "@/lib/workspace";`,
        CALLER,
      ),
    ).toEqual([]);
  });

  it("says nothing about the workspace module itself", () => {
    // It is the inside of the boundary: `resolveWorkspaceId` unwrapping
    // `resolveWorkspace` is the module doing its job.
    expect(
      findTokenResolverEscapes(
        `export async function resolveWorkspaceId(input: { owner?: string }) {
           return (await resolveWorkspace(input)).id;
         }`,
        WORKSPACE_MODULE,
      ),
    ).toEqual([]);
  });

  it("parses TSX without tripping over JSX", () => {
    // `.tsx` needs the TSX script kind or a generic-looking `<T>` derails the
    // parse and the whole file silently reports zero findings.
    expect(
      findTokenResolverEscapes(
        `import { currentWorkspaceId } from "@/lib/workspace";

         export function Page() {
           return <main aria-label="Home">{currentWorkspaceId.name}</main>;
         }`,
        "src/app/(app)/page.tsx",
      ),
    ).toEqual([]);
    // …and still finds the escape in a TSX file, so the silence above is the
    // parser working rather than the parser giving up.
    expect(
      findTokenResolverEscapes(
        `import { resolveWorkspaceId as getWsId } from "@/lib/workspace";

         export function Page() {
           return <main>{getWsId.name}</main>;
         }`,
        "src/app/(app)/page.tsx",
      ),
    ).toHaveLength(1);
  });
});

/**
 * #220, `!305` round 2 — rule 1's own blind spot.
 *
 * Rule 2 above stopped asking about a CALL and started asking about a
 * REFERENCE, because a rename on import defeated the call-shaped question.
 * Rule 1 shipped with the identical shape of hole one level in: it decided
 * "is this a session resolver" by looking for the literal text
 * `resolveWorkspace(` or `resolveWorkspaceId(` inside an exported function, so
 * a resolver that reads the signed token ITSELF — `verifySession()` straight to
 * `p.wsId` — was not a session resolver as far as the rule was concerned, and
 * could hand out a workspace id with no status check while rule 1 reported a
 * clean zero.
 *
 * `currentUser()` was already exactly that shape in `workspace.ts`. It checks
 * the status correctly, so nothing was broken — but it was invisible, which
 * means nothing would have failed if the check were deleted from it.
 *
 * So the question is asked of the PROPERTY instead of the name, in two halves
 * unioned so the rule fails closed:
 *
 *  - **reaches a session primitive** — a call, by AST, to any of
 *    {@link SESSION_PRIMITIVES}, through an import alias or a namespace.
 *  - **surfaces a workspace id** — the function has a workspace id in hand that
 *    did not arrive as one of its own parameters, or returns one.
 *
 * The second half is what closes the regress the first half opens: a resolver
 * built on a session primitive nobody has added to the list yet still returns
 * `p.wsId`, and that is enough to be caught.
 */
describe("findSessionResolvers — resolvers that reach the session", () => {
  /** Analysed as the workspace module, which is the only file rule 1 scans. */
  const resolvers = (src: string) =>
    findSessionResolvers(src, WORKSPACE_MODULE).map((r) => r.name);

  it("flags a resolver that parses the token itself, calling neither primitive", () => {
    // THE `!305` round-2 finding, as a fixture. `verifySession()` → `p.wsId` is
    // a complete session→workspace resolver that mentions neither watched name,
    // so the substring rule this replaces reported a clean zero for it.
    const probe = `
      export async function currentWorkspaceIdFast(): Promise<string> {
        const jar = await cookies();
        const p = await verifySession(jar.get(OWNER_COOKIE)?.value ?? "", secret);
        if (p?.kind !== "user") throw new MissingWorkspaceError();
        return p.wsId;
      }
    `;
    const [found] = findSessionResolvers(probe, WORKSPACE_MODULE);
    expect(found?.name).toBe("currentWorkspaceIdFast");
    expect(found?.reachesSessionPrimitive).toBe(true);
    expect(found?.surfacesWorkspaceId).toBe(true);
    expect(found?.checksUserStatus).toBe(false);
  });

  it("still flags the shape the substring rule already caught", () => {
    // The rule is a superset of the one it replaces, not a swap.
    expect(
      resolvers(`
        export async function currentWorkspaceIdFast(): Promise<string> {
          const ws = await resolveWorkspace({ owner: token });
          return ws.id;
        }
      `),
    ).toEqual(["currentWorkspaceIdFast"]);
    expect(
      resolvers(`
        export async function unwrap(input: { owner?: string }): Promise<string> {
          return (await resolveWorkspaceId(input));
        }
      `),
    ).toEqual(["unwrap"]);
  });

  it("reports the status check when the resolver makes one", () => {
    const good = `
      export async function currentWorkspaceId(): Promise<string> {
        const ws = await resolveWorkspace({ owner: token });
        const owner = await prisma.user.findUnique({ where: { id: ws.userId } });
        if (owner?.status !== UserStatus.Active) throw new RevokedAccountError();
        return ws.id;
      }
    `;
    expect(findSessionResolvers(good, WORKSPACE_MODULE)).toHaveLength(1);
    expect(
      findSessionResolvers(good, WORKSPACE_MODULE)[0].checksUserStatus,
    ).toBe(true);
  });

  it("flags an exported ARROW function, which the regex could not see at all", () => {
    // `export async function (\w+)` is the whole of the old boundary detection,
    // so rewriting a resolver as a `const` erased it from the rule silently —
    // the old doc comment listed "arrow functions" as a known way to break it.
    expect(
      resolvers(`
        export const currentWorkspaceIdFast = async (): Promise<string> => {
          const p = await verifySession(token, secret);
          return p.wsId;
        };
      `),
    ).toEqual(["currentWorkspaceIdFast"]);
  });

  it("flags a SYNCHRONOUS exported function", () => {
    expect(
      resolvers(`
        export function workspaceOf(token: string): string {
          return verifySessionSync(token).wsId;
        }
      `),
    ).toEqual(["workspaceOf"]);
  });

  it("flags a function exported by a later export clause, not at its declaration", () => {
    expect(
      resolvers(`
        async function currentWorkspaceIdFast(): Promise<string> {
          return (await resolveWorkspace({ owner: token })).id;
        }
        export { currentWorkspaceIdFast };
      `),
    ).toEqual(["currentWorkspaceIdFast"]);
  });

  it("sees a session primitive through a rename on import", () => {
    // The same defeat rule 2 was fixed for, applied to rule 1's own question.
    expect(
      resolvers(`
        import { verifySession as decode } from "@/lib/auth/session";

        export async function currentWorkspaceIdFast(): Promise<string> {
          const p = await decode(token, secret);
          return p.wsId;
        }
      `),
    ).toEqual(["currentWorkspaceIdFast"]);
  });

  it("sees a session primitive reached through a namespace", () => {
    expect(
      resolvers(`
        import * as session from "@/lib/auth/session";

        export async function currentWorkspaceIdFast(): Promise<string> {
          return (await session.verifySession(token, secret)).wsId;
        }
      `),
    ).toEqual(["currentWorkspaceIdFast"]);
  });

  it("flags a resolver built on a primitive this module has never heard of", () => {
    // The half that closes the regress. Naming primitives can always be walked
    // around by adding a new one, so surfacing a workspace id is enough on its
    // own — the rule fails closed rather than waiting to be taught the name.
    const [found] = findSessionResolvers(
      `
        export async function currentWorkspaceIdFast(): Promise<string> {
          const p = await decodeSignedCookie(token);
          return p.wsId;
        }
      `,
      WORKSPACE_MODULE,
    );
    expect(found?.name).toBe("currentWorkspaceIdFast");
    expect(found?.reachesSessionPrimitive).toBe(false);
    expect(found?.surfacesWorkspaceId).toBe(true);
  });

  it("flags a session reader even when it hands back no workspace id", () => {
    // NOT an over-reach, and the reason is `hasSession()`: it reads the session,
    // returns a boolean, and what a frozen account gets by passing it is a real
    // (small, argued) exposure — see STATUS_BLIND_RESOLVERS in the harness.
    // "Returns no id" is therefore not a proof of harmlessness, so it does not
    // buy silence; it buys a written exemption.
    const [found] = findSessionResolvers(
      `
        export async function hasSession(): Promise<boolean> {
          try {
            await resolveWorkspace({ owner: token });
            return true;
          } catch {
            return false;
          }
        }
      `,
      WORKSPACE_MODULE,
    );
    expect(found?.name).toBe("hasSession");
    expect(found?.reachesSessionPrimitive).toBe(true);
    expect(found?.surfacesWorkspaceId).toBe(false);
  });

  it("finds resolvers in source order, one entry each", () => {
    const src = `
      export async function a(): Promise<string> {
        return (await resolveWorkspace({})).id;
      }
      export async function b(): Promise<string> {
        return (await verifySession(t, s)).wsId;
      }
    `;
    expect(
      findSessionResolvers(src, WORKSPACE_MODULE).map((r) => r.name),
    ).toEqual(["a", "b"]);
  });
});

describe("findSessionResolvers — the controls, which must stay silent", () => {
  // A guard that also fires on correct code is a guard that gets relaxed rather
  // than fixed. Each of these is a shape that MUST NOT be a finding, and the
  // first four are the ones a rule about "hands out a workspace id" gets wrong.
  const resolvers = (src: string) =>
    findSessionResolvers(src, WORKSPACE_MODULE).map((r) => r.name);

  it("says nothing about a function that merely TAKES a workspaceId", () => {
    // Most of `src/lib` is this shape. A rule that cannot tell an id handed IN
    // from an id handed OUT flags the whole codebase and gets deleted.
    expect(
      resolvers(`
        export async function listTasks(workspaceId: string) {
          return prisma.task.findMany({ where: { workspaceId } });
        }
        export async function moveTask(id: string, workspaceId: string) {
          return prisma.task.update({ where: { id }, data: { workspaceId } });
        }
      `),
    ).toEqual([]);
  });

  it("says nothing about a DESTRUCTURED workspaceId parameter", () => {
    expect(
      resolvers(`
        export async function purge({ workspaceId }: { workspaceId: string }) {
          return prisma.task.deleteMany({ where: { workspaceId } });
        }
      `),
    ).toEqual([]);
  });

  it("says nothing about a workspaceId a nested callback receives", () => {
    // The parameter scope has to follow the walk down into inner functions, or
    // a `map((workspaceId) => …)` reads as an id conjured out of the session.
    expect(
      resolvers(`
        export async function purgeAll(ids: string[]) {
          return Promise.all(
            ids.map((workspaceId) => prisma.task.deleteMany({ where: { workspaceId } })),
          );
        }
      `),
    ).toEqual([]);
  });

  it("says nothing about a workspaceId that exists only in a TYPE", () => {
    // A type annotation binds nothing at runtime and hands nothing out.
    expect(
      resolvers(`
        export function describeScope(scope: { workspaceId: string }): string {
          return scope.kind;
        }
        export type SessionLike = { wsId: string };
        export function label(): string {
          return "scope";
        }
      `),
    ).toEqual([]);
  });

  it("says nothing about returning an id that belongs to a parameter", () => {
    // `return row.id` is not a session→workspace resolution; the id came in
    // through the front door.
    expect(
      resolvers(`
        export function idOf(row: { id: string }): string {
          return row.id;
        }
      `),
    ).toEqual([]);
  });

  it("says nothing about a NON-exported helper", () => {
    // A module-private helper cannot be a resolver anybody outside reaches, and
    // this is the shape a test helper or a fixture builder takes.
    expect(
      resolvers(`
        async function makeSession(token: string) {
          const p = await verifySession(token, secret);
          return p.wsId;
        }
      `),
    ).toEqual([]);
  });

  it("does not read a comment or a JSDoc link as a call site", () => {
    // This repo has twice shipped a tool that read a comment as code, and #220
    // itself was a doc comment promising a check the code did not make. Parsing
    // means a comment is not a node.
    expect(
      resolvers(`
        /**
         * Calls {@link resolveWorkspace} — no it does not. See verifySession()
         * and the wsId it carries, and the workspaceId that comes out.
         */
        // UserStatus is checked by currentUser(), so this does not.
        export function label(): string {
          return "scope";
        }
      `),
    ).toEqual([]);
  });

  it("does not read a string literal as a call site", () => {
    expect(
      resolvers(`
        export const WATCHED = ["verifySession(", "resolveWorkspace(", "wsId"];
        export function names(): string[] {
          return WATCHED;
        }
      `),
    ).toEqual([]);
  });

  it("does not accept a UserStatus mentioned only in prose as the check", () => {
    // The rule that made `statusBlindResolvers` worth anything, kept.
    const bad = `
      // UserStatus is checked by currentUser(), so this does not need to.
      /** Compare against UserStatus.Active before returning. */
      export async function currentWorkspaceIdFast(): Promise<string> {
        return (await resolveWorkspaceId({ owner: token }));
      }
    `;
    expect(
      findSessionResolvers(bad, WORKSPACE_MODULE)[0]?.checksUserStatus,
    ).toBe(false);
  });

  it("does not accept a UserStatus that appears only as a TYPE", () => {
    // Declaring that a value has the type is not reading the value.
    const bad = `
      export async function currentWorkspaceIdFast(): Promise<string> {
        const ws = await resolveWorkspace({ owner: token });
        const status: UserStatus = await lookup(ws.id);
        return ws.id;
      }
    `;
    expect(
      findSessionResolvers(bad, WORKSPACE_MODULE)[0]?.checksUserStatus,
    ).toBe(false);
  });

  it("says nothing about a module that resolves no session at all", () => {
    expect(
      resolvers(`
        export async function touchWorkspace(id: string, kind: string) {
          await prisma.workspace.upsert({
            where: { id },
            create: { id, kind, lastSeenAt: new Date() },
            update: { kind, lastSeenAt: new Date() },
          });
        }
        export async function isOwnerRequest(): Promise<boolean> {
          return (await currentUser())?.role === UserRole.Owner;
        }
      `),
    ).toEqual([]);
  });

  it("parses TSX without tripping over JSX", () => {
    // Same trap as rule 2's parser: without the TSX script kind a generic-looking
    // `<T>` derails the parse and the file silently reports zero resolvers.
    expect(
      findSessionResolvers(
        `export function Page() {
           return <main aria-label="Home">{"scope"}</main>;
         }`,
        "src/app/(app)/page.tsx",
      ),
    ).toEqual([]);
    // …and still finds one in a TSX file, so the silence above is the parser
    // working rather than the parser giving up.
    expect(
      findSessionResolvers(
        `export function Page({ token }: { token: string }) {
           const p = verifySessionSync(token);
           return <main>{p.wsId}</main>;
         }`,
        "src/app/(app)/page.tsx",
      ).map((r) => r.name),
    ).toEqual(["Page"]);
  });
});

describe("findExportedFunctionNames / findSessionPrimitiveBindings", () => {
  it("names every exported function, whatever syntax declares it", () => {
    expect(
      findExportedFunctionNames(
        `export function a() {}
         export async function b() {}
         export const c = () => 1;
         export const d = async function () {};
         function e() {}
         export { e };
         function f() {}
         export const g = 1;`,
        WORKSPACE_MODULE,
      ),
    ).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("reports which session primitives a module binds", () => {
    // The anti-vacuous surface. If a primitive is renamed, the harness's own
    // check of this fails and says so, instead of every rule below it quietly
    // reporting a clean zero.
    expect(
      findSessionPrimitiveBindings(
        `import { verifySession } from "@/lib/auth/session";
         export async function resolveWorkspace() {}
         export async function resolveWorkspaceId() {}`,
        WORKSPACE_MODULE,
      ).sort(),
    ).toEqual([...SESSION_PRIMITIVES].sort());
  });

  it("reports a primitive bound under an alias, under its exported name", () => {
    expect(
      findSessionPrimitiveBindings(
        `import { verifySession as decode } from "@/lib/auth/session";`,
        WORKSPACE_MODULE,
      ),
    ).toEqual(["verifySession"]);
  });

  it("reports nothing for a module that binds none of them", () => {
    expect(
      findSessionPrimitiveBindings(
        `// verifySession and resolveWorkspace are discussed here only.
         export const note = "resolveWorkspaceId";`,
        WORKSPACE_MODULE,
      ),
    ).toEqual([]);
  });
});
