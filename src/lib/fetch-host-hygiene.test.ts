import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  establishesConstantHost,
  scanFetchTargets,
  type FetchTarget,
} from "@/lib/fetch-host-hygiene";

/**
 * #83 — the constant-host guard.
 *
 * This is the compensating control for demoting
 * `javascript-node-ssrf-generic-taint` to Info in `.gitlab/sast-ruleset.toml`.
 * That rule follows user input into a request's BODY, which is what an OAuth
 * authorization-code exchange is, and so produced five findings and zero true
 * positives. SSRF is control of the request TARGET, so that is what this
 * asserts:
 *
 *   **Every outbound request in the scanned scope targets a host that is
 *   constant at build time.**
 *
 * Unlike the SAST rule it replaces, this fails the unit-test job — a hard gate,
 * not an approval prompt — and it does not re-fingerprint when a line moves.
 *
 * ── Scope: `src/`, `prisma/`, `scripts/`. Deliberately NOT `e2e/`. ──────────
 * The first three ship or run against real data (`prisma/` and `scripts/`
 * execute in the migrate/seed initContainers). `e2e/` fetches dynamic local
 * URLs on purpose, so including it would reintroduce exactly the noise this
 * replaces. Test files are excluded for the same reason the scoping harness
 * excludes them: they never run in production, and they mock the network.
 *
 * ── A path parameter is NOT an SSRF question ────────────────────────────────
 * `tasksUrl("lists", listId, "tasks")` interpolates a caller-supplied id into a
 * later PATH SEGMENT. That is path traversal (#79), and !165 already fixed it
 * with per-segment encoding and `.`/`..` rejection in `pathSegment`. Conflating
 * the two is how this repo got the noise in the first place, so this guard
 * measures the host prefix and nothing else — and those call sites are NOT in
 * `REVIEWED_DYNAMIC_HOSTS`, because their host is fully constant.
 *
 * ── What this does NOT cover, stated rather than left to be discovered ──────
 * It sees `fetch()` and `new Request()` in repo source. It does not see an HTTP
 * client that builds its own requests internally — `src/lib/llm/` hands a
 * `baseURL` to the `openai` and `@anthropic-ai/sdk` clients, and
 * `openai-compatible.ts` reads that base URL from `LLM_BASE_URL`. That host is
 * genuinely env-derived and genuinely intentional: BYO-LLM (#59) exists to let
 * a self-hoster point the app at their own endpoint, and it is operator
 * configuration rather than request input, which is the line that matters for
 * CWE-918. But it is outside this guard's reach, not inside it and approved, so
 * do not read a green run as "no outbound request in this repo has a variable
 * host". Extending the same rule to SDK constructor options is a separate
 * change with a separate argument to make.
 */

// ── Reviewed dynamic hosts ────────────────────────────────────────────────
//
// Call sites whose host is NOT constant, each with a stated reason. Adding an
// entry is a security decision and must be argued for in review — the same
// contract `REVIEWED_UNSCOPED` carries in the scoping harness.
//
// An ENV-DERIVED host is defensible: BYO-LLM (#59) makes `LLM_BASE_URL` an
// intentionally configurable endpoint, and #35 Phase C adds per-user
// credentials. A REQUEST-DERIVED host is not, and that is the line every reason
// below has to defend.
//
// Keyed by `<file>:<target expression>` rather than by line number, so the map
// does not rot every time a function moves — which is the failure mode that
// made the SAST rule unusable.
const REVIEWED_DYNAMIC_HOSTS: Record<string, string> = {
  "src/lib/focus-catalog-source.ts:url":
    "ENV-DERIVED, and enforced rather than promised. #61 streams the full " +
    "lo-fi catalog from an object store the operator names in " +
    "FOCUS_CATALOG_ORIGIN — the same class of knob as LLM_BASE_URL, set by " +
    "whoever runs the instance and never by a request. The host cannot be " +
    "constant at build time for that reason. What makes the divergence " +
    "reviewable is that this is the module's ONLY fetch, and the function " +
    "holding it (`fetchFromStore`) refuses any url that does not " +
    "`startsWith` the normalised base before the call is made, so no caller — " +
    "present or future — can point it at another host. `resolveCatalogBase` " +
    "additionally rejects a non-http(s) scheme, userinfo, a query and a " +
    'fragment; `redirect: "error"` stops the store relocating the request ' +
    "after the fact. The one REQUEST-derived value is a track filename, which " +
    "`isSafeCatalogFilename` allow-lists by shape (no slash, backslash, " +
    "percent, colon or whitespace) and `encodeURIComponent` reduces to a " +
    "single path segment appended to an already-closed authority — a path " +
    "question, which is #79's concern and not this guard's. Both refusals are " +
    "tested over a real socket in focus-catalog-source.test.ts, including the " +
    "negative: the store receives no request at all.",
};

// ── Directories that ship or run against real data ─────────────────────────
const SCANNED_ROOTS = ["src", "prisma", "scripts"] as const;

function scannedFiles(): string[] {
  const files: string[] = [];
  for (const root of SCANNED_ROOTS) {
    let entries: string[];
    try {
      entries = readdirSync(root, { recursive: true, encoding: "utf8" });
    } catch {
      // A scanned root that does not exist is a repo-layout change, not a
      // silent pass — the "roots exist" test below is what reports it.
      continue;
    }
    for (const entry of entries) {
      if (!/\.(ts|tsx|mts)$/.test(entry)) continue;
      if (/\.test\.(ts|tsx)$/.test(entry)) continue;
      files.push(path.join(root, entry));
    }
  }
  return files;
}

/** Every non-constant-host call site in the real tree, as `file:target`. */
function repoOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of scannedFiles()) {
    for (const site of scanFetchTargets(readFileSync(file, "utf8"), file)) {
      if (site.constantHost) continue;
      const key = `${file}:${site.target}`;
      if (REVIEWED_DYNAMIC_HOSTS[key]) continue;
      offenders.push(`${key} (line ${site.line}) — ${site.reason}`);
    }
  }
  return offenders;
}

/** Convenience: the single call site in a one-liner fixture. */
function only(source: string): FetchTarget {
  const sites = scanFetchTargets(source, "fixture.ts");
  expect(sites, `expected exactly one call site in:\n${source}`).toHaveLength(
    1,
  );
  return sites[0];
}

describe("establishesConstantHost", () => {
  it("accepts an absolute URL whose authority is closed by the constant part", () => {
    expect(establishesConstantHost("https://tasks.googleapis.com/")).toBe(true);
    expect(establishesConstantHost("https://gitlab.com/oauth/")).toBe(true);
    expect(establishesConstantHost("https://example.com?q=")).toBe(true);
  });

  it("rejects a constant part that stops inside the authority", () => {
    // `https://${host}/x` — the interpolation IS the host. This is the exact
    // shape the SSRF rule exists to catch, so the replacement must catch it.
    expect(establishesConstantHost("https://")).toBe(false);
    // `${GITLAB}${tail}` — a constant that reaches the end of the authority but
    // does not terminate it. The tail can append `@evil.com`, or userinfo, and
    // change the host entirely.
    expect(establishesConstantHost("https://gitlab.com")).toBe(false);
  });

  it("accepts a same-origin relative path", () => {
    expect(establishesConstantHost("/api/")).toBe(true);
    expect(establishesConstantHost("/a")).toBe(true);
  });

  it("rejects a bare slash, which an interpolation turns protocol-relative", () => {
    // `/${x}` with x = "/evil.com/" yields "//evil.com/" — a cross-origin
    // request that looks same-origin at a glance.
    expect(establishesConstantHost("/")).toBe(false);
    expect(establishesConstantHost("//")).toBe(false);
    expect(establishesConstantHost("")).toBe(false);
  });

  it("rejects a scheme-less relative reference", () => {
    // Resolved against whatever base happens to be current; in Node there is
    // none and `fetch` throws. Never used here, never silently accepted.
    expect(establishesConstantHost("tasks/")).toBe(false);
  });
});

describe("scanFetchTargets — constant hosts it must accept", () => {
  it("a bare string-literal URL", () => {
    expect(
      only(`await fetch("https://oauth2.googleapis.com/token");`),
    ).toMatchObject({ constantHost: true });
  });

  it("a same-origin relative literal", () => {
    expect(
      only(`await fetch("/api/breakdown", { method: "POST" });`),
    ).toMatchObject({ constantHost: true });
  });

  it("an identifier bound to a module-level const string literal", () => {
    const src = `
      const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
      export async function exchange() {
        return fetch(TOKEN_ENDPOINT, { method: "POST" });
      }
    `;
    expect(only(src)).toMatchObject({ constantHost: true });
  });

  it("a template whose constant head pins scheme, host and path", () => {
    const src = `
      export async function get(id: string) {
        return fetch(\`https://tasks.googleapis.com/v1/lists/\${id}\`);
      }
    `;
    expect(only(src)).toMatchObject({ constantHost: true });
  });

  it("a template opening with a const host, with dynamic later segments", () => {
    // The google.ts shape. The interpolation is a PATH segment, which is #79's
    // problem and not this guard's.
    const src = `
      const TASKS_API = "https://tasks.googleapis.com/tasks/v1";
      export async function get(listId: string) {
        return fetch(\`\${TASKS_API}/lists/\${listId}/tasks\`);
      }
    `;
    expect(only(src)).toMatchObject({ constantHost: true });
  });

  it("a const host with no path, followed by a constant path", () => {
    // providers.ts: `${GITLAB}/oauth/token` — GITLAB is "https://gitlab.com",
    // and the constant `/oauth/token` is what closes the authority.
    const src = `
      const GITLAB = "https://gitlab.com";
      export async function exchange() {
        return fetch(\`\${GITLAB}/oauth/token\`, { method: "POST" });
      }
    `;
    expect(only(src)).toMatchObject({ constantHost: true });
  });

  it("a call to a module-local URL builder that pins the host", () => {
    // The real `tasksUrl` shape after !165. Resolving one hop is STRICTER than
    // allowlisting the call site: the builder's own return expression has to
    // satisfy the same rule.
    const src = `
      const TASKS_API = "https://tasks.googleapis.com/tasks/v1";
      function tasksUrl(...segments: string[]): string {
        return \`\${TASKS_API}/\${segments.map(encodeURIComponent).join("/")}\`;
      }
      export async function get(listId: string) {
        return fetch(tasksUrl("lists", listId, "tasks"));
      }
    `;
    expect(only(src)).toMatchObject({ constantHost: true });
  });

  it("a local const bound to a constant URL", () => {
    const src = `
      export async function ping() {
        const url = "https://dlectroflow.dev/api/health";
        return fetch(url);
      }
    `;
    expect(only(src)).toMatchObject({ constantHost: true });
  });

  it("a constant string concatenation", () => {
    const src = `
      const BASE = "https://example.com";
      export async function go(id: string) {
        return fetch(BASE + "/things/" + id);
      }
    `;
    expect(only(src)).toMatchObject({ constantHost: true });
  });

  it("a fetch whose target is a Request built from a constant URL", () => {
    // Duo caught this on !218. `new Request(...)` is a NewExpression, so the
    // OUTER fetch fell through to "unresolvable" and was reported as dynamic
    // even though the Request's own URL is a literal — which would have forced
    // a REVIEWED_DYNAMIC_HOSTS entry for a call that is provably safe, exactly
    // the kind of dilution this guard replaced.
    const sites = scanFetchTargets(
      `await fetch(new Request("https://constant.example/x"));`,
      "fixture.ts",
    );
    expect(sites).toHaveLength(2);
    expect(sites.every((s) => s.constantHost)).toBe(true);
  });

  it("a fetch whose Request wraps a const-bound URL", () => {
    const src = `
      const ENDPOINT = "https://oauth2.googleapis.com/token";
      export async function go() {
        return fetch(new Request(ENDPOINT), { method: "POST" });
      }
    `;
    expect(
      scanFetchTargets(src, "fixture.ts").every((s) => s.constantHost),
    ).toBe(true);
  });

  it("a Request built from a literal URL", () => {
    expect(
      only(`const r = new Request("https://example.com/x");`),
    ).toMatchObject({ constantHost: true });
  });
});

describe("scanFetchTargets — dynamic hosts it must reject", () => {
  const rejects = (src: string) => {
    const site = only(src);
    expect(
      site.constantHost,
      `expected a dynamic-host verdict for:\n${src}`,
    ).toBe(false);
    // A verdict with no stated reason is unreviewable.
    expect(site.reason.length).toBeGreaterThan(10);
    return site;
  };

  it("a parameter used as the whole target", () => {
    rejects(`export async function proxy(url: string) { return fetch(url); }`);
  });

  it("an interpolated authority", () => {
    // The genuine SSRF shape.
    rejects(
      `export async function go(host: string) { return fetch(\`https://\${host}/x\`); }`,
    );
  });

  it("a const scheme followed by a dynamic host", () => {
    // Duo caught this on #83: "all interpolations are module-level consts" would
    // ACCEPT this, because SCHEME is one. Host-prefix constancy rejects it.
    const src = `
      const SCHEME = "https://";
      export async function go(host: string) {
        return fetch(\`\${SCHEME}\${host}/path\`);
      }
    `;
    rejects(src);
  });

  it("a const host whose authority the interpolation can extend", () => {
    // `${GITLAB}${tail}` with tail = "@evil.com/x" resolves to evil.com.
    const src = `
      const GITLAB = "https://gitlab.com";
      export async function go(tail: string) {
        return fetch(\`\${GITLAB}\${tail}\`);
      }
    `;
    rejects(src);
  });

  it("a parameter shadowing a module const of the same name", () => {
    // The scope walk goes inner-to-outer, so it has to STOP at the first
    // binding of the name. Skipping the parameter and carrying on outwards
    // finds `API` and calls this constant — while the value actually reaching
    // fetch is the caller's. Found reviewing !218, after Duo's round on this
    // file returned only fabricated findings.
    const src = `
      const API = "https://good.example/";
      export async function go(API: string) {
        return fetch(API);
      }
    `;
    rejects(src);
  });

  it("a let shadowing a module const of the same name", () => {
    // Same failure, rebindable flavour: `let` is unresolvable by design, so
    // meeting one must end the walk rather than fall through to the const.
    const src = `
      const API = "https://good.example/";
      export async function go(userInput: string) {
        let API = userInput;
        return fetch(API);
      }
    `;
    rejects(src);
  });

  it("a property access", () => {
    rejects(
      `export async function go(req: Request) { return fetch(req.url); }`,
    );
  });

  it("an env-derived host", () => {
    // Legitimate for BYO-LLM (#59) — but it has to be a REVIEWED_DYNAMIC_HOSTS
    // entry with a reason, not an invisible pass.
    rejects(`await fetch(\`\${process.env.LLM_BASE_URL}/v1/chat\`);`);
  });

  it("a rebindable binding", () => {
    const src = `
      let base = "https://example.com";
      export async function go() { return fetch(base + "/x"); }
    `;
    rejects(src);
  });

  it("a call to an imported function", () => {
    // Cross-file resolution is out of scope by design; an unresolvable builder
    // is dynamic until someone says otherwise in review.
    const src = `
      import { buildUrl } from "./elsewhere";
      export async function go(id: string) { return fetch(buildUrl(id)); }
    `;
    rejects(src);
  });

  it("a call to a local builder that does NOT pin the host", () => {
    // Proves the one-hop resolution actually CHECKS the builder rather than
    // trusting it because it is local.
    const src = `
      function badUrl(host: string): string { return \`https://\${host}/x\`; }
      export async function go(h: string) { return fetch(badUrl(h)); }
    `;
    rejects(src);
  });

  it("a bare-slash template an interpolation can make protocol-relative", () => {
    rejects(
      `export async function go(p: string) { return fetch(\`/\${p}\`); }`,
    );
  });

  it("a Request built from a dynamic URL", () => {
    // `fetch(new Request(url))` is the obvious way around a guard that only
    // looks at fetch's own first argument. BOTH sites are reported — the fetch
    // (whose target is a constructor call) and the Request itself — so neither
    // route out is left open.
    const sites = scanFetchTargets(
      `export async function go(u: string) { return fetch(new Request(u)); }`,
      "fixture.ts",
    );
    expect(sites).toHaveLength(2);
    expect(sites.every((s) => !s.constantHost)).toBe(true);
  });

  it("a ternary that can pick a dynamic host", () => {
    const src = `
      export async function go(u: string, flag: boolean) {
        return fetch(flag ? "https://a.example/x" : u);
      }
    `;
    rejects(src);
  });
});

describe("scanFetchTargets — what it must NOT match", () => {
  it("ignores an unrelated method whose name merely contains fetch", () => {
    expect(scanFetchTargets(`router.prefetch(href);`, "f.ts")).toEqual([]);
    expect(scanFetchTargets(`const x = refetch(url);`, "f.ts")).toEqual([]);
  });

  it("ignores fetch mentioned in a comment or a string", () => {
    const src = `
      // fetch(someUrl) used to live here
      const doc = "call fetch(url) to make a request";
    `;
    expect(scanFetchTargets(src, "f.ts")).toEqual([]);
  });

  it("matches globalThis.fetch, which is the same sink", () => {
    expect(
      only(`export async function go(u: string) {
      return globalThis.fetch(u);
    }`).constantHost,
    ).toBe(false);
  });

  it("terminates on a recursive builder instead of hanging", () => {
    const src = `
      function a(x: string): string { return b(x); }
      function b(x: string): string { return a(x); }
      export async function go(x: string) { return fetch(a(x)); }
    `;
    expect(only(src).constantHost).toBe(false);
  });

  it("reports the line of the call", () => {
    const src = `const A = "https://x.example/y";\n\nawait fetch(A);\n`;
    expect(only(src).line).toBe(3);
  });
});

describe("the repo itself", () => {
  it("every scanned root exists where this test thinks it does", () => {
    // Duo caught the gap on !218: `scannedFiles()` swallows a missing root, and
    // the "> 50 files" guard below is satisfied by `src/` alone — so renaming
    // `prisma/` or `scripts/` would silently drop them from the scan while
    // everything stayed green. Same guard the scoping harness puts on its
    // PEOPLE_FILES list, for the same reason.
    for (const root of SCANNED_ROOTS) {
      expect(
        () => readdirSync(root, { encoding: "utf8" }),
        `${root}/ is missing — fix the layout or update SCANNED_ROOTS`,
      ).not.toThrow();
    }
  });

  it("scans a real number of files (guards against matching nothing)", () => {
    // Without this, a broken glob would turn every rule below into a test that
    // reads no files and passes forever.
    expect(scannedFiles().length).toBeGreaterThan(50);
  });

  it("finds the outbound call sites that are known to exist", () => {
    // google.ts alone has seven, providers.ts two, breakdown-chat one. A
    // scanner that suddenly finds none is broken, not clean.
    const total = scannedFiles().reduce(
      (n, file) =>
        n + scanFetchTargets(readFileSync(file, "utf8"), file).length,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(9);
  });

  it("every REVIEWED_DYNAMIC_HOSTS entry is live and carries a real reason", () => {
    // A stale exemption reads like considered coverage. Every key must still
    // name a call site the scanner actually flags.
    const flagged = new Set<string>();
    for (const file of scannedFiles()) {
      for (const site of scanFetchTargets(readFileSync(file, "utf8"), file)) {
        if (!site.constantHost) flagged.add(`${file}:${site.target}`);
      }
    }
    for (const [key, reason] of Object.entries(REVIEWED_DYNAMIC_HOSTS)) {
      expect(flagged, `${key} is no longer a dynamic-host call site`).toContain(
        key,
      );
      expect(reason.length, `${key} needs a real reason`).toBeGreaterThan(40);
    }
  });

  it("every fetch call site targets a host that is constant at build time", () => {
    // A request whose target a caller can influence is an SSRF (CWE-918)
    // whatever the payload looks like. #83 replaced the generic SAST rule with
    // this because the rule measured the payload.
    expect(repoOffenders()).toEqual([]);
  });
});
