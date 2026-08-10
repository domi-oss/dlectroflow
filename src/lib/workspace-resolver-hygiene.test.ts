import { describe, it, expect } from "vitest";
import {
  TOKEN_LEVEL_RESOLVERS,
  WORKSPACE_MODULE,
  findTokenResolverEscapes,
} from "@/lib/workspace-resolver-hygiene";

/**
 * #220 — the parser behind rule 2 of the scoping harness, on synthetic input.
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
