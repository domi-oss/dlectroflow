import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseDockerfile,
  stageInstructions,
  deletesPathInSameCommand,
  lateRecursiveChowns,
} from "./dockerfile-hygiene";

describe("parseDockerfile", () => {
  it("splits an instruction from its arguments", () => {
    expect(parseDockerfile("WORKDIR /app\nEXPOSE 3000\n")).toEqual([
      { instruction: "WORKDIR", args: "/app" },
      { instruction: "EXPOSE", args: "3000" },
    ]);
  });

  it("joins backslash-continued lines into one instruction", () => {
    const text =
      "RUN set -e \\\n  && npm install prisma \\\n  && rm -rf /tmp\n";
    expect(parseDockerfile(text)).toEqual([
      {
        instruction: "RUN",
        args: "set -e && npm install prisma && rm -rf /tmp",
      },
    ]);
  });

  it("ignores comments, blank lines and the syntax directive", () => {
    const text = "# syntax=docker/dockerfile:1\n\n# a note\nUSER node\n";
    expect(parseDockerfile(text)).toEqual([
      { instruction: "USER", args: "node" },
    ]);
  });

  it("upper-cases the instruction keyword", () => {
    expect(parseDockerfile("from node:22-alpine AS build")[0].instruction).toBe(
      "FROM",
    );
  });

  it("keeps flags such as --chown with the arguments", () => {
    expect(parseDockerfile("COPY --chown=node:node public ./public")).toEqual([
      { instruction: "COPY", args: "--chown=node:node public ./public" },
    ]);
  });
});

describe("stageInstructions", () => {
  const MULTI_STAGE = parseDockerfile(
    [
      "FROM node:22-alpine AS build",
      "RUN npm ci",
      "FROM node:22-alpine AS runner",
      "COPY --from=build /app/.next/standalone ./",
      "USER node",
    ].join("\n"),
  );

  it("returns only the named stage's instructions", () => {
    expect(stageInstructions(MULTI_STAGE, "runner")).toEqual([
      { instruction: "COPY", args: "--from=build /app/.next/standalone ./" },
      { instruction: "USER", args: "node" },
    ]);
  });

  it("does not leak the earlier stage's instructions", () => {
    expect(stageInstructions(MULTI_STAGE, "runner")).not.toContainEqual(
      expect.objectContaining({ args: "npm ci" }),
    );
  });

  it("matches the stage name case-insensitively", () => {
    expect(stageInstructions(MULTI_STAGE, "RUNNER")).toHaveLength(2);
  });

  it("returns nothing for a stage that does not exist", () => {
    expect(stageInstructions(MULTI_STAGE, "nope")).toEqual([]);
  });
});

describe("deletesPathInSameCommand", () => {
  const REAL_INSTALL =
    "cd /opt/tools && npm install --cache /tmp/npm-cache prisma@6.19.3 " +
    "&& rm -rf /opt/tools /tmp/npm-cache /root/.npm && chown -R node:node /app";

  it("accepts a path deleted by the rm it belongs to", () => {
    expect(deletesPathInSameCommand(REAL_INSTALL, "/tmp/npm-cache")).toBe(true);
    expect(deletesPathInSameCommand(REAL_INSTALL, "/root/.npm")).toBe(true);
  });

  it("rejects a command that never deletes the path", () => {
    expect(
      deletesPathInSameCommand(
        "npm install --cache /tmp/npm-cache",
        "/tmp/npm-cache",
      ),
    ).toBe(false);
  });

  // Duo review on !159: the original class was [^&|], so a `;` did not stop
  // the scan and this input passed the guard while leaving the cache in place.
  it("does not walk past a semicolon to find the path", () => {
    expect(
      deletesPathInSameCommand(
        "npm install && rm -rf /opt/tools; echo cleaned /tmp/npm-cache",
        "/tmp/npm-cache",
      ),
    ).toBe(false);
  });

  it("does not walk past && or || or a pipe either", () => {
    for (const separator of ["&&", "||", "|"]) {
      expect(
        deletesPathInSameCommand(
          `rm -rf /opt/tools ${separator} echo /root/.npm`,
          "/root/.npm",
        ),
      ).toBe(false);
    }
  });

  it("treats dots in the path as literals, not as any-character", () => {
    // /root/Xnpm must not satisfy a check for /root/.npm.
    expect(deletesPathInSameCommand("rm -rf /root/Xnpm", "/root/.npm")).toBe(
      false,
    );
  });
});

describe("lateRecursiveChowns", () => {
  const withCopies = (chownLine: string) =>
    parseDockerfile(
      [
        "RUN npm install && chown -R node:node /app",
        "COPY --chown=node:node public ./public",
        chownLine,
        "USER node",
      ].join("\n"),
    );

  it("returns no offenders when ownership is set inside the install RUN", () => {
    expect(lateRecursiveChowns(withCopies("EXPOSE 3000"))).toEqual([]);
  });

  it("catches a RUN chown -R /app after the COPYs", () => {
    expect(
      lateRecursiveChowns(withCopies("RUN chown -R node:node /app")),
    ).toEqual([{ instruction: "RUN", args: "chown -R node:node /app" }]);
  });

  it("ignores a recursive chown of some other tree", () => {
    expect(
      lateRecursiveChowns(withCopies("RUN chown -R node:node /var/log")),
    ).toEqual([]);
  });

  // Duo review on !159: findIndex returns -1 with no COPY, and the earlier
  // inline `slice(-1)` then searched only the LAST instruction — so this
  // fragment, which re-owns /app in its own layer, read as clean. Returning
  // null forces the caller to fail closed instead.
  it("returns null rather than [] when the stage has no COPY to anchor on", () => {
    const noCopies = parseDockerfile(
      ["RUN chown -R node:node /app", "USER node"].join("\n"),
    );
    expect(noCopies.slice(-1).filter((i) => i.instruction === "RUN")).toEqual(
      [],
    ); // what the old logic saw: nothing wrong here
    expect(lateRecursiveChowns(noCopies)).toBeNull();
  });
});

/**
 * #71 regression guards. The runtime image was 893 MB and a cold pull on a
 * newly scaled Autopilot node blew past Helm's timeout, so `--atomic` rolled
 * back a healthy release. Both Dockerfiles must keep the fixes that shrank it:
 *
 *  - `npm install` for the migrate/seed/purge tooling runs in an ISOLATED
 *    prefix. Run inside /app, npm treats the standalone output's package.json
 *    as the project manifest and reinstalls the app's entire dependency tree
 *    (392 packages: next, typescript, playwright, @next/swc …) on top of the
 *    minimal traced node_modules that `output: "standalone"` produced.
 *  - the npm cache is deleted in the SAME layer as the install (it was 885 MB
 *    on disk; a later `rm` cannot shrink an earlier layer).
 *  - ownership comes from `COPY --chown`, not a trailing `RUN chown -R /app`,
 *    which rewrites every file and so duplicates the whole app into a second
 *    layer.
 *  - the tooling the cluster actually invokes is still there: the migrate
 *    initContainer runs `npx prisma migrate deploy`, the review seed and the
 *    purge CronJob run `npx tsx <script>`, and prisma.config.ts imports dotenv.
 *    Pruning any of those breaks the deploy, not just the build.
 */
describe.each([["Dockerfile"], ["Dockerfile.ci"]])(
  "%s runtime stage hygiene (#71)",
  (filename) => {
    const runtime = stageInstructions(
      parseDockerfile(readFileSync(join(process.cwd(), filename), "utf8")),
      "runner",
    );
    const runs = runtime
      .filter((i) => i.instruction === "RUN")
      .map((i) => i.args);
    const copies = runtime
      .filter((i) => i.instruction === "COPY")
      .map((i) => i.args);
    const npmInstalls = runs.filter((r) => /\bnpm (install|ci)\b/.test(r));

    it("has a runtime stage to check", () => {
      expect(runtime.length).toBeGreaterThan(0);
    });

    it("installs npm packages only in an isolated prefix, never in /app", () => {
      expect(npmInstalls.length).toBeGreaterThan(0);
      for (const command of npmInstalls) {
        expect(command).toMatch(/(cd|--prefix[= ])\s*\/opt\/\S+/);
      }
    });

    it("deletes the npm cache in the same layer as the install", () => {
      for (const command of npmInstalls) {
        expect(deletesPathInSameCommand(command, "/tmp/npm-cache")).toBe(true);
        expect(deletesPathInSameCommand(command, "/root/.npm")).toBe(true);
      }
    });

    it("never re-owns the whole app tree in a layer of its own", () => {
      // Ownership inside the install layer is free (the layer only captures the
      // final state); a standalone `RUN chown -R /app` after the COPYs is not.
      const offenders = lateRecursiveChowns(runtime);
      // Fail closed: null means there was no COPY to anchor the search, which
      // is a broken runtime stage, not a clean one (Duo review on !159).
      expect(offenders, `${filename} runner stage has no COPY`).not.toBeNull();
      expect(offenders).toEqual([]);
    });

    it("copies application files as node:node via COPY --chown", () => {
      expect(copies.length).toBeGreaterThan(0);
      for (const command of copies) {
        expect(command).toContain("--chown=node:node");
      }
    });

    it("still ships the prisma CLI, dotenv and tsx the cluster invokes", () => {
      const installed = npmInstalls.join(" ");
      expect(installed).toMatch(/\bprisma@/);
      expect(installed).toMatch(/\bdotenv@/);
      expect(installed).toMatch(/\btsx@/);
    });

    it("still ships the schema and migrations `prisma migrate deploy` needs", () => {
      expect(copies.some((c) => /\bprisma \.\/prisma\b/.test(c))).toBe(true);
      expect(copies.some((c) => /prisma\.config\.ts/.test(c))).toBe(true);
    });

    it("runs as the non-root node user", () => {
      expect(
        runtime.some((i) => i.instruction === "USER" && i.args === "node"),
      ).toBe(true);
    });

    // Drift caught while fixing #71: the image pinned tsx@4.19.2 while the app
    // had moved to 4.23.1 — the version #67 realigned on so only one esbuild
    // resolves. The image's CLIs must match what `npm ci` installs, or the
    // container runs migrations/scripts on a different Prisma or tsx than the
    // one the app and its lockfile were tested with.
    //
    // dotenv is included (Duo review on !159) even though package.json never
    // declares it: prisma.config.ts imports `dotenv/config`, and it resolves
    // because the Prisma CLI's own tree hoists it to the top of the lockfile.
    // If it ever vanishes from there this test fails loudly — which is right,
    // because prisma.config.ts would be broken locally and in CI too, not just
    // in the image.
    it("pins prisma, tsx and dotenv to the versions in package-lock.json", () => {
      const lock = JSON.parse(
        readFileSync(join(process.cwd(), "package-lock.json"), "utf8"),
      ) as { packages: Record<string, { version?: string }> };
      const installed = npmInstalls.join(" ");

      for (const pkg of ["prisma", "tsx", "dotenv"]) {
        const locked = lock.packages[`node_modules/${pkg}`]?.version;
        expect(locked, `${pkg} missing from package-lock.json`).toBeDefined();
        expect(installed).toContain(`${pkg}@${locked}`);
      }
    });
  },
);
