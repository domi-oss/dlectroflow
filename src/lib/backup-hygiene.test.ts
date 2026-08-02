import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBackupTemplate, stripHelmActions } from "@/lib/backup-hygiene";

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

  it("fails a template that dropped one destination", () => {
    const gcsOnly = TEMPLATE.replace(/rclone[\s\S]*?\n/g, "\n");
    expect(parseBackupTemplate(gcsOnly).destinations.b2).toBe(false);
  });
});
