import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseBackupTemplate,
  parseComposeBackup,
  stripHelmActions,
} from "@/lib/backup-hygiene";

/**
 * The database backup is the one job in this repo whose failure is **silent by
 * construction**. Nothing renders it, no user hits it, and a CronJob that
 * uploads nothing looks identical to one that uploaded successfully until the
 * day you need a restore. Three separate incidents in this project came from a
 * green-looking signal that meant nothing was checked; this guard exists so
 * that class cannot reach the backup path.
 *
 * It pins four properties of `charts/dlectroflow/templates/backup.yaml` that a
 * plausible, well-meant edit would remove:
 *
 *  1. **Both destinations stay.** GCS upload is keyless via Workload Identity;
 *     B2 needs a long-lived key. Dual-write is what makes that key acceptable —
 *     revoking it, or B2 being unreachable, still leaves a good backup, and the
 *     GCS copy is unaffected either way. Collapsing back to one destination is
 *     the single most likely "tidy-up" here, so it fails the build.
 *  2. **Every shell stage sets `-euo pipefail`.** Without `pipefail` a failing
 *     `pg_dump` at the head of `pg_dump | gzip` still exits 0, and the job
 *     cheerfully uploads a valid gzip of nothing.
 *  3. **The dump keeps its minimum-size guard.** An empty-but-well-formed dump
 *     is the exact artefact that makes a restore fail months later.
 *  4. **No stage echoes a credential.** Job logs are readable by anyone with
 *     cluster access, and the B2 key is a personal credential.
 */

const TEMPLATE = readFileSync(
  join(process.cwd(), "charts/dlectroflow/templates/backup.yaml"),
  "utf8",
);

const COMPOSE = readFileSync(
  join(process.cwd(), "docker/docker-compose.prod.yml"),
  "utf8",
);

describe("stripHelmActions", () => {
  it("removes control actions so the remainder is parseable YAML", () => {
    const out = stripHelmActions(
      "{{- if .X }}\na: {{ .Values.b | quote }}\n{{- end }}",
    );
    expect(out).not.toContain("{{");
    expect(out).toContain("a:");
  });

  it("leaves a placeholder for value interpolations rather than an empty scalar", () => {
    // `image: {{ .Values.x }}` collapsing to `image:` would parse as null and
    // silently satisfy a presence check.
    const out = stripHelmActions("image: {{ .Values.x }}");
    expect(out.trim()).not.toBe("image:");
  });
});

describe("backup CronJob hygiene", () => {
  const facts = parseBackupTemplate(TEMPLATE);

  it("finds the dump stage and both upload stages", () => {
    // Pinned exactly rather than as a subset: a fourth stage appearing here
    // silently would mean another destination nobody agreed to, and a missing
    // one is the dual-write regression this whole file exists to catch.
    expect(facts.stages.map((s) => s.name).sort()).toEqual([
      "dump",
      "upload",
      "upload-b2",
    ]);
  });

  it("writes to BOTH GCS and B2 — dual-write is the whole safety argument", () => {
    expect(facts.destinations.gcs).toBe(true);
    expect(facts.destinations.b2).toBe(true);
  });

  it("sets -euo pipefail in every shell stage", () => {
    for (const stage of facts.stages) {
      expect(stage.script, `stage "${stage.name}"`).toMatch(
        /set -euo pipefail/,
      );
    }
  });

  it("keeps a minimum-size guard on the dump", () => {
    const dump = facts.stages.find((s) => s.name === "dump");
    expect(dump?.script).toMatch(/-gt\s+\d+/);
  });

  it("never echoes a credential to the job log", () => {
    for (const stage of facts.stages) {
      expect(stage.script, `stage "${stage.name}"`).not.toMatch(
        /echo[^\n]*\$\{?(B2_[A-Z_]*KEY|PGPASSWORD|[A-Z_]*SECRET)/,
      );
    }
  });

  // The guard is only worth having if it actually fails when the thing it
  // guards is removed, so both halves are exercised by deleting a whole upload
  // stage — the shape a real "tidy-up" would take. An earlier version stripped
  // `rclone` lines instead, which stopped simulating anything once the B2 check
  // matched the `b2:` destination rather than the tool name.
  const withoutStage = (source: string, name: string) => {
    const lines = source.split("\n");
    const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
    expect(
      start,
      `stage "${name}" should exist in the template`,
    ).toBeGreaterThan(-1);
    const indent = lines[start]!.length - lines[start]!.trimStart().length;
    let end = start + 1;
    while (
      end < lines.length &&
      (lines[end]!.trim() === "" ||
        lines[end]!.length - lines[end]!.trimStart().length > indent)
    ) {
      end++;
    }
    return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
  };

  it("fails when the B2 upload stage is removed", () => {
    const facts = parseBackupTemplate(withoutStage(TEMPLATE, "upload-b2"));
    expect(facts.destinations.b2).toBe(false);
    expect(facts.destinations.gcs).toBe(true);
  });

  it("fails when the GCS upload stage is removed", () => {
    const facts = parseBackupTemplate(withoutStage(TEMPLATE, "upload"));
    expect(facts.destinations.gcs).toBe(false);
    expect(facts.destinations.b2).toBe(true);
  });

  it("does not count a destination mentioned only in the dump stage", () => {
    // Put both destination markers in the DUMP stage as a comment, then remove
    // the real B2 upload stage. If the scan were not scoped to `upload*`
    // stages, the comment alone would keep `b2` true and the removal would go
    // unnoticed — which is the regression this exists to catch.
    const withComment = TEMPLATE.replace(
      "                  set -euo pipefail\n                  # Connection literals",
      "                  set -euo pipefail\n                  # see gs:// and b2: for where this ends up\n                  # Connection literals",
    );
    // Sanity-check the fixture itself: the comment must have landed, otherwise
    // this test would pass by testing nothing at all.
    expect(withComment).not.toBe(TEMPLATE);
    expect(parseBackupTemplate(withComment).stages).toHaveLength(3);

    const facts = parseBackupTemplate(withoutStage(withComment, "upload-b2"));
    expect(facts.destinations.b2).toBe(false);
    expect(facts.destinations.gcs).toBe(true);
  });
});

/**
 * The same class of guard for the Compose self-host path (#162).
 *
 * Until #162 that path dumped to a directory **on the disk it was protecting**,
 * which is the one failure a backup has to survive: a backup should not share a
 * failure domain with the thing it backs up, and the database is the only asset
 * here that cannot be rebuilt from source. The properties below are the ones the
 * chart path already proves, ported rather than reinvented — see the header of
 * `charts/dlectroflow/templates/backup.yaml` for why each exists.
 *
 * Synthetic fixtures first, real file second, matching the split every other
 * hygiene module uses: a guard that can only be run against the repo cannot be
 * shown capable of failing.
 */

/**
 * A minimal two-service stack in the real file's shape. `uploadScript` is
 * injected already indented to the literal block's level.
 */
const composeFixture = (uploadScript: string) => `name: dlectroflow-prod

services:
  db:
    image: postgres:16
  backup:
    image: postgres:16
    volumes:
      - ../backups:/backups
      - backup_stage:/stage
    entrypoint: ["/bin/bash", "-c"]
    command:
      - |
        set -euo pipefail
        pg_dump | gzip -9 > /stage/dump.sql.gz
        date -u +%Y%m%dT%H%M%SZ > /stage/stamp
  backup-upload:
    image: rclone/rclone:1.75
    volumes:
      - backup_stage:/stage:ro
    entrypoint: ["/bin/sh", "-c"]
    command:
      - |
${uploadScript}
  purge:
    image: dlectroflow:local
    command: ["npx", "tsx", "prisma/scheduled-purge.ts"]

volumes:
  backup_stage:
`;

const REAL_UPLOAD = [
  "        set -euo pipefail",
  '        STAMP="$$(cat /stage/stamp)"',
  '        rclone copyto --no-check-dest /stage/dump.sql.gz "b2:bucket/pg/x-$${STAMP}.sql.gz"',
].join("\n");

describe("parseComposeBackup", () => {
  it("collects only the backup services, with their scripts and mounts", () => {
    const facts = parseComposeBackup(composeFixture(REAL_UPLOAD));
    // `db` and `purge` are services too. Narrowing to the backup family is what
    // stops an unrelated service's script satisfying a destination check.
    expect(facts.services.map((s) => s.name)).toEqual([
      "backup",
      "backup-upload",
    ]);
    expect(facts.services[0]!.volumes).toEqual([
      "../backups:/backups",
      "backup_stage:/stage",
    ]);
    expect(facts.services[1]!.volumes).toEqual(["backup_stage:/stage:ro"]);
    expect(facts.destinations.b2).toBe(true);
  });

  it("reads a folded `- >` command block as well as a literal `- |` one", () => {
    // The service shipped before #162 used `>`; both are legal Compose, and a
    // parser that only understood one would report the script as absent —
    // which this module treats as "nothing to assert on" and would pass.
    const folded = composeFixture(REAL_UPLOAD).replace(
      "    command:\n      - |\n        set -euo pipefail\n        pg_dump",
      "    command:\n      - >\n        set -euo pipefail;\n        pg_dump",
    );
    expect(folded).not.toBe(composeFixture(REAL_UPLOAD));
    const facts = parseComposeBackup(folded);
    expect(facts.services.map((s) => s.name)).toEqual([
      "backup",
      "backup-upload",
    ]);
    expect(facts.services[0]!.script).toMatch(/set -euo pipefail/);
  });

  it("does not count a destination that only appears in a comment", () => {
    // Two tools in this repo have already read a comment as code (#146, #150),
    // and a literal block scalar is the one place a shell comment sits inside
    // the very text being scanned. Whole-line comments come out first, so a
    // stage that only *mentions* b2: does not register as uploading to it.
    const commentOnly = [
      "        set -euo pipefail",
      "        # was: rclone copyto /stage/dump.sql.gz b2:bucket/pg/x.sql.gz",
      "        echo skipped",
    ].join("\n");
    const facts = parseComposeBackup(composeFixture(commentOnly));
    expect(facts.services.map((s) => s.name)).toEqual([
      "backup",
      "backup-upload",
    ]);
    expect(facts.destinations.b2).toBe(false);
  });

  it("reports no off-host destination when the upload service is gone", () => {
    const source = composeFixture(REAL_UPLOAD);
    const start = source.indexOf("  backup-upload:");
    const end = source.indexOf("  purge:");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const facts = parseComposeBackup(
      source.slice(0, start) + source.slice(end),
    );
    expect(facts.services.map((s) => s.name)).toEqual(["backup"]);
    expect(facts.destinations.b2).toBe(false);
  });

  it("ignores a service whose command is an exec array rather than a script", () => {
    // `purge` is shaped that way in the real file. Treating its absent script
    // as an empty one would make every script-level assertion below vacuous.
    const facts = parseComposeBackup(
      composeFixture(REAL_UPLOAD).replace("  purge:", "  backup-purge:"),
    );
    expect(facts.services.map((s) => s.name)).toEqual([
      "backup",
      "backup-upload",
    ]);
  });

  it("returns nothing for a file with no services block", () => {
    expect(parseComposeBackup("volumes:\n  pgdata:\n").services).toEqual([]);
  });
});

describe("Compose backup stack hygiene (#162)", () => {
  const facts = parseComposeBackup(COMPOSE);
  const service = (name: string) => {
    const found = facts.services.find((s) => s.name === name);
    expect(found, `Compose service "${name}" should exist`).toBeDefined();
    return found!;
  };
  const uploaders = () => facts.services.filter((s) => s.name !== "backup");

  it("finds the dump service and an off-host upload service", () => {
    // Pinned exactly, like the chart's stage list: a service silently leaving
    // is the regression, and one silently arriving is a destination nobody
    // agreed to.
    expect(facts.services.map((s) => s.name).sort()).toEqual([
      "backup",
      "backup-upload",
    ]);
  });

  it("copies the dump off the host", () => {
    expect(facts.destinations.b2).toBe(true);
  });

  it("sets -euo pipefail in every shell stage", () => {
    // Measured, not theoretical: `pg_dump -h nosuchhost | gzip` under a bare
    // `set -eu` exits 0 and leaves a 20-byte .sql.gz that looks like a backup,
    // because a pipeline's status is the LAST command's and gzip succeeds at
    // compressing nothing.
    for (const stage of facts.services) {
      expect(stage.script, `service "${stage.name}"`).toMatch(
        /set -euo pipefail/,
      );
    }
  });

  it("dumps with --no-owner --no-privileges so any role name can restore it", () => {
    expect(service("backup").script).toMatch(/--no-owner/);
    expect(service("backup").script).toMatch(/--no-privileges/);
  });

  it("keeps a minimum-size guard before the dump is promoted", () => {
    // An empty-database dump is 394 bytes, measured during the #162 drill, so
    // the guard fires on the case that actually happens.
    expect(service("backup").script).toMatch(/-gt\s+\d+/);
  });

  it("never lets the pipeline write straight to the name the uploaders read", () => {
    // Measured during the #162 drill: a pg_dump that fails at the head of
    // `pg_dump | gzip` still leaves gzip's 20-byte output behind. Written
    // straight to dump.sql.gz, that sits in the handover looking like a dump.
    // Only the mv AFTER the size guard promotes it to the name anything reads.
    const dump = service("backup").script;
    expect(dump).toMatch(/> \/stage\/dump\.sql\.gz\.partial/);
    expect(dump).toMatch(
      /mv \/stage\/dump\.sql\.gz\.partial \/stage\/dump\.sql\.gz/,
    );
    // No redirect ENDS at the promoted name, which is what the check above
    // cannot see on its own — `.partial` is a prefix match of it.
    expect(dump).not.toMatch(/> \/stage\/dump\.sql\.gz$/m);
  });

  it("would notice if the dump were promoted before the size guard", () => {
    // The control for the assertion above: collapse the two-step write back to
    // the shape it replaced and confirm all three halves report it.
    const collapsed = COMPOSE.replaceAll(
      "/stage/dump.sql.gz.partial",
      "/stage/dump.sql.gz",
    );
    expect(collapsed).not.toBe(COMPOSE);
    const dump = parseComposeBackup(collapsed).services.find(
      (s) => s.name === "backup",
    )!.script;
    expect(dump).not.toMatch(/> \/stage\/dump\.sql\.gz\.partial/);
    expect(dump).toMatch(/> \/stage\/dump\.sql\.gz$/m);
  });

  it("mints the timestamp exactly once, in the dump stage", () => {
    const stampWrites = service("backup").script.match(/> \/stage\/stamp/g);
    expect(stampWrites).toHaveLength(1);
  });

  it("makes every uploader read that stamp instead of calling date itself", () => {
    // One dump, one stamp, N uploaders. Two uploaders each calling date(1)
    // produce object names a second or two apart, and then nothing can prove
    // the two copies are the same dump — the only question a restore asks.
    expect(uploaders().length).toBeGreaterThan(0);
    for (const stage of uploaders()) {
      expect(stage.script, `service "${stage.name}"`).toMatch(/\/stage\/stamp/);
      expect(stage.script, `service "${stage.name}"`).not.toMatch(/\bdate\b/);
    }
  });

  it("hands the dump over on a shared volume no uploader can write to", () => {
    expect(service("backup").volumes).toContain("backup_stage:/stage");
    for (const stage of uploaders()) {
      expect(stage.volumes, `service "${stage.name}"`).toContain(
        "backup_stage:/stage:ro",
      );
    }
  });

  it("never echoes a credential to the cron log", () => {
    for (const stage of facts.services) {
      expect(stage.script, `service "${stage.name}"`).not.toMatch(
        /echo[^\n]*\$\$?\{?(B2_[A-Z_]*KEY|PGPASSWORD|[A-Z_]*SECRET)/,
      );
    }
  });
});
