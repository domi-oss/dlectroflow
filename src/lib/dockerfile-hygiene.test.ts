import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDockerfile, stageInstructions } from "./dockerfile-hygiene";

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
        expect(command).toMatch(/rm -rf[^&|]*\/tmp\/npm-cache/);
        expect(command).toMatch(/rm -rf[^&|]*\/root\/\.npm/);
      }
    });

    it("never re-owns the whole app tree in a layer of its own", () => {
      // Ownership inside the install layer is free (the layer only captures the
      // final state); a standalone `RUN chown -R /app` after the COPYs is not.
      const copyIndex = runtime.findIndex((i) => i.instruction === "COPY");
      const offenders = runtime
        .slice(copyIndex)
        .filter(
          (i) =>
            i.instruction === "RUN" && /chown\s+-R[^&|]*\/app\b/.test(i.args),
        );
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
