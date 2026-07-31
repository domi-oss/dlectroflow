import { afterEach, describe, it, expect, vi } from "vitest";
import {
  ambientGitEnvPointingAt,
  GIT_ENV_PASSTHROUGH,
  GIT_ISOLATION_PINS,
  GIT_LOCATION_VARIABLES,
  isolatedGitEnv,
} from "@/lib/git-env";

/** Everything the helper is allowed to put in an environment by itself. */
const ALLOWED_NAMES = new Set<string>([
  ...GIT_ENV_PASSTHROUGH,
  ...Object.keys(GIT_ISOLATION_PINS),
]);

/**
 * #146 — the allow-list itself.
 *
 * `git-env-hygiene.test.ts` asserts that every git-reaching call site routes
 * through `isolatedGitEnv()`. That is only worth anything if the helper actually
 * withholds what it claims to, so these tests set the offending variables in the
 * live environment and check they do not come out the other side. Otherwise both
 * guards could agree with each other about nothing.
 */
describe("isolatedGitEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("copies the allow-listed variables and nothing else", () => {
    vi.stubEnv("SOME_UNRELATED_SECRET", "s3cret");
    const env = isolatedGitEnv();
    expect(env).not.toHaveProperty("SOME_UNRELATED_SECRET");
    expect(Object.keys(env).filter((name) => !ALLOWED_NAMES.has(name))).toEqual(
      [],
    );
  });

  it("pins NODE_ENV to a literal rather than inheriting it", () => {
    // The type of `child_process`'s `env` option requires NODE_ENV once Next.js
    // has augmented `ProcessEnv`. Satisfying that by adding it to the
    // PASSTHROUGH list would have widened the very allow-list this module exists
    // to narrow, so it is a pinned literal instead — set here to something the
    // parent is not, to prove nothing is being copied.
    vi.stubEnv("NODE_ENV", "production");
    expect(isolatedGitEnv().NODE_ENV).toBe("test");
    expect(GIT_ENV_PASSTHROUGH).not.toContain("NODE_ENV");
  });

  it("withholds every variable that could name a repository", () => {
    // The point of the allow-list: it never copies these, so it does not matter
    // that they are set. A blocklist has to know each name; this does not.
    for (const [name, value] of Object.entries(
      ambientGitEnvPointingAt("/tmp/decoy"),
    )) {
      vi.stubEnv(name, value);
    }
    const env = isolatedGitEnv();
    for (const name of GIT_LOCATION_VARIABLES) {
      expect(env, name).not.toHaveProperty(name);
    }
  });

  it("withholds a git variable it has never heard of", () => {
    // This is the property a blocklist cannot have, and the reason #146 rejects
    // "delete the five names that broke us". git ships around forty of these and
    // adds more.
    vi.stubEnv("GIT_SOME_FUTURE_VARIABLE", "1");
    expect(isolatedGitEnv()).not.toHaveProperty("GIT_SOME_FUTURE_VARIABLE");
  });

  it("passes PATH and HOME through, because git genuinely needs them", () => {
    vi.stubEnv("PATH", "/stub/bin");
    vi.stubEnv("HOME", "/tmp/home");
    expect(isolatedGitEnv()).toMatchObject({
      PATH: "/stub/bin",
      HOME: "/tmp/home",
    });
  });

  it("leaves an absent passthrough absent rather than the string 'undefined'", () => {
    vi.stubEnv("HOME", undefined);
    const env = isolatedGitEnv();
    expect("HOME" in env).toBe(false);
  });

  it("pins global and system config, so a developer's config cannot leak in", () => {
    expect(isolatedGitEnv()).toMatchObject({
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      // A credential prompt has to fail, not block until the job times out.
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  it("applies the caller's own variables", () => {
    expect(
      isolatedGitEnv({
        GIT_AUTHOR_NAME: "Prune Test",
        CI_PROJECT_ID: "4242",
      }),
    ).toMatchObject({ GIT_AUTHOR_NAME: "Prune Test", CI_PROJECT_ID: "4242" });
  });

  it("refuses to set a variable that names a repository", () => {
    // An override there defeats the `-C` on the command line, which is #146
    // reintroduced from the inside — so it throws rather than being honoured.
    for (const name of GIT_LOCATION_VARIABLES) {
      expect(() => isolatedGitEnv({ [name]: "/tmp/elsewhere" }), name).toThrow(
        name,
      );
    }
    expect(() => isolatedGitEnv({ GIT_DIR: "/tmp/x" })).toThrow(/-C/);
  });

  it("names every offending variable at once, not just the first", () => {
    expect(() =>
      isolatedGitEnv({ GIT_DIR: "/a", GIT_WORK_TREE: "/b" }),
    ).toThrow(/GIT_DIR, GIT_WORK_TREE/);
  });
});

describe("ambientGitEnvPointingAt", () => {
  it("covers every repository-locating variable", () => {
    // If the allow-list learns about a new variable, the decoy has to exercise
    // it — otherwise the list grows a name that no test proves is being ignored,
    // which is the state the suite was in when #146 was filed.
    expect(Object.keys(ambientGitEnvPointingAt("/tmp/decoy")).sort()).toEqual(
      [...GIT_LOCATION_VARIABLES].sort(),
    );
  });

  it("gives each variable a value of the right shape", () => {
    const env = ambientGitEnvPointingAt("/tmp/decoy");
    expect(env.GIT_DIR).toBe("/tmp/decoy/.git");
    expect(env.GIT_WORK_TREE).toBe("/tmp/decoy");
    expect(env.GIT_INDEX_FILE).toBe("/tmp/decoy/.git/index");
  });
});
