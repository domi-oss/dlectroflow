import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractUsedEnvKeys,
  extractDocumentedEnvKeys,
  computeEnvDrift,
  extractManifestEnvKeys,
  computeConfigSurfaceDrift,
  CONFIG_SURFACE_ALLOWLIST,
  PLATFORM_DIVERGENCES,
  CHART_CONFIG_SURFACE_FILES,
  assertManifestKeysLookLikeEnv,
  ENV_PROD_EXAMPLE_FILE,
} from "./env-drift";

describe("extractUsedEnvKeys", () => {
  it("finds dot-notation process.env.KEY reads", () => {
    const src = `
      const a = process.env.FOO_BAR;
      if (process.env.BAZ === "x") doThing();
    `;
    expect(extractUsedEnvKeys(src).sort()).toEqual(["BAZ", "FOO_BAR"]);
  });

  it("finds bracket-notation process.env[\"KEY\"] and process.env['KEY'] reads", () => {
    const src = `
      const a = process.env["FOO_BAR"];
      const b = process.env['BAZ'];
    `;
    expect(extractUsedEnvKeys(src).sort()).toEqual(["BAZ", "FOO_BAR"]);
  });

  it("finds destructured reads and uses the source name, not the alias/default", () => {
    const src = `
      const { FOO, BAR: alias, QUX = "d" } = process.env;
    `;
    expect(extractUsedEnvKeys(src).sort()).toEqual(["BAR", "FOO", "QUX"]);
  });

  it("finds destructured reads spread across multiple lines", () => {
    const src = `
      const {
        NODE_ENV,
        PUBLIC_ORIGIN,
      } = process.env;
    `;
    expect(extractUsedEnvKeys(src).sort()).toEqual([
      "NODE_ENV",
      "PUBLIC_ORIGIN",
    ]);
  });

  it("dedupes repeated reads of the same key", () => {
    const src = `process.env.FOO; process.env.FOO; process.env.FOO;`;
    expect(extractUsedEnvKeys(src)).toEqual(["FOO"]);
  });

  it("returns an empty array when there is no process.env usage", () => {
    expect(extractUsedEnvKeys("const x = 1;")).toEqual([]);
  });
});

describe("extractDocumentedEnvKeys", () => {
  it("finds active KEY=value assignments", () => {
    const example = `
ANTHROPIC_API_KEY=
DATABASE_URL="postgresql://x"
`;
    expect(extractDocumentedEnvKeys(example).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "DATABASE_URL",
    ]);
  });

  it("finds commented-out optional KEY=value lines (the .env.example convention for optional vars)", () => {
    const example = `
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
`;
    expect(extractDocumentedEnvKeys(example).sort()).toEqual([
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ]);
  });

  it("ignores prose comments that are not KEY=value lines", () => {
    const example = `
# This is a comment explaining the section below.
#   cp .env.example .env
# Get a key at https://console.anthropic.com -> API keys.
REAL_KEY=value
`;
    expect(extractDocumentedEnvKeys(example)).toEqual(["REAL_KEY"]);
  });
});

describe("computeEnvDrift", () => {
  it("reports a key used in src/ but missing from .env.example", () => {
    const result = computeEnvDrift(["USED_BUT_UNDOCUMENTED"], [], []);
    expect(result.missingFromExample).toEqual(["USED_BUT_UNDOCUMENTED"]);
    expect(result.unusedInExample).toEqual([]);
  });

  it("reports a key documented in .env.example but never read in src/", () => {
    const result = computeEnvDrift([], ["DOCUMENTED_BUT_UNUSED"], []);
    expect(result.unusedInExample).toEqual(["DOCUMENTED_BUT_UNUSED"]);
    expect(result.missingFromExample).toEqual([]);
  });

  it("reports no drift when used and documented keys match exactly", () => {
    const result = computeEnvDrift(["FOO", "BAR"], ["BAR", "FOO"], []);
    expect(result.missingFromExample).toEqual([]);
    expect(result.unusedInExample).toEqual([]);
  });

  it("excludes allowlisted keys from both directions", () => {
    const result = computeEnvDrift(
      ["NODE_ENV", "REAL_MISSING"],
      ["ALLOWED_UNUSED"],
      ["NODE_ENV", "ALLOWED_UNUSED"],
    );
    expect(result.missingFromExample).toEqual(["REAL_MISSING"]);
    expect(result.unusedInExample).toEqual([]);
  });

  it("sorts output alphabetically for stable, readable diffs", () => {
    const result = computeEnvDrift(["ZED", "ALPHA", "MID"], [], []);
    expect(result.missingFromExample).toEqual(["ALPHA", "MID", "ZED"]);
  });
});

describe("extractManifestEnvKeys", () => {
  it("finds Secret stringData keys, templated value and all", () => {
    const secret = `
apiVersion: v1
kind: Secret
metadata:
  name: dlectroflow-secrets
type: Opaque
stringData:
  DATABASE_URL: {{ include "dlectroflow.databaseUrl" . | quote }}
  ANTHROPIC_API_KEY: {{ .Values.secrets.anthropicApiKey | quote }}
`;
    expect(extractManifestEnvKeys(secret)).toEqual([
      "ANTHROPIC_API_KEY",
      "DATABASE_URL",
    ]);
  });

  it("finds container `- name: KEY` env entries", () => {
    const deployment = `
          env:
            - name: PUBLIC_ORIGIN
              value: "https://{{ .Values.host }}"
            - name: REVIEW_DEMO_WS
              value: {{ .Values.reviewDemoWorkspaceId | quote }}
`;
    expect(extractManifestEnvKeys(deployment)).toEqual([
      "PUBLIC_ORIGIN",
      "REVIEW_DEMO_WS",
    ]);
  });

  // Duo review (!230): the `- name:` pattern used to anchor straight to `$`, so
  // an inline comment made the key uncountable — and an uncounted key is reported
  // as DRIFT. A passing comment on a manifest line would therefore have
  // manufactured a gap that does not exist, and the obvious "fix" for the phantom
  // gap would have been to edit the config surface to match it.
  it("counts a `- name: KEY` entry that carries an inline comment", () => {
    const deployment = `
          env:
            - name: PUBLIC_ORIGIN # injected by the review deploy
              value: "https://{{ .Values.host }}"
            - name: GOOGLE_CLIENT_ID   #  optional, self-host only
              value: {{ .Values.google.clientId | quote }}
`;
    expect(extractManifestEnvKeys(deployment)).toEqual([
      "GOOGLE_CLIENT_ID",
      "PUBLIC_ORIGIN",
    ]);
  });

  it("finds a key inside a conditional block", () => {
    const secret = `
stringData:
  {{- if eq .Values.env "production" }}
  RESEND_API_KEY: {{ .Values.secrets.resendApiKey | quote }}
  {{- end }}
`;
    expect(extractManifestEnvKeys(secret)).toEqual(["RESEND_API_KEY"]);
  });

  it("ignores lower-case YAML structure, container names and secretKeyRef lookups", () => {
    // `key: DATABASE_URL` under a secretKeyRef is a *reference* to a key
    // declared elsewhere in the same chart, not a second declaration — and
    // `- name: app` / `- name: tmp` are container and volume names. Reading
    // either as an env key would silently inflate the chart's surface.
    const deployment = `
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: app
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: dlectroflow-secrets
                  key: DATABASE_URL
      volumes:
        - name: tmp
          emptyDir: {}
`;
    expect(extractManifestEnvKeys(deployment)).toEqual(["DATABASE_URL"]);
  });

  it("dedupes a key declared in more than one container and sorts the result", () => {
    const deployment = `
            - name: ZED_KEY
            - name: ALPHA_KEY
            - name: ZED_KEY
`;
    expect(extractManifestEnvKeys(deployment)).toEqual([
      "ALPHA_KEY",
      "ZED_KEY",
    ]);
  });

  it("returns an empty array for a manifest that declares no env", () => {
    expect(
      extractManifestEnvKeys("kind: Service\nspec:\n  ports: []\n"),
    ).toEqual([]);
  });
});

describe("computeConfigSurfaceDrift", () => {
  it("reports a key the Compose surface offers and the chart cannot", () => {
    const result = computeConfigSurfaceDrift(["GUEST_AI_WINDOW_HOURS"], [], []);
    expect(result.missingFromChart).toEqual(["GUEST_AI_WINDOW_HOURS"]);
    expect(result.missingFromEnvProdExample).toEqual([]);
  });

  it("reports a key the chart offers and the documented self-host path does not", () => {
    // Gap 1 in #135: GOOGLE_CLIENT_ID in the chart's Secret but nowhere in
    // .env.prod.example meant the headline Google Tasks flow simply could not
    // succeed on the self-host path, with no signal why.
    const result = computeConfigSurfaceDrift([], ["GOOGLE_CLIENT_ID"], []);
    expect(result.missingFromEnvProdExample).toEqual(["GOOGLE_CLIENT_ID"]);
    expect(result.missingFromChart).toEqual([]);
  });

  it("reports no drift when the two surfaces match exactly", () => {
    const result = computeConfigSurfaceDrift(
      ["FOO", "BAR"],
      ["BAR", "FOO"],
      [],
    );
    expect(result.missingFromChart).toEqual([]);
    expect(result.missingFromEnvProdExample).toEqual([]);
    expect(result.staleAllowlistEntries).toEqual([]);
  });

  it("sorts both directions alphabetically for a stable diff", () => {
    const result = computeConfigSurfaceDrift(
      ["ZED", "ALPHA"],
      ["MID", "AAA"],
      [],
    );
    expect(result.missingFromChart).toEqual(["ALPHA", "ZED"]);
    expect(result.missingFromEnvProdExample).toEqual(["AAA", "MID"]);
  });

  it("exempts a key allowlisted as Compose-only from the chart direction", () => {
    const result = computeConfigSurfaceDrift(
      ["DLECTROFLOW_DOMAIN", "REAL_GAP"],
      [],
      [
        {
          key: "DLECTROFLOW_DOMAIN",
          declaredOn: "compose",
          reason:
            "Caddy obtains the certificate for it; the chart uses .Values.host.",
        },
      ],
    );
    expect(result.missingFromChart).toEqual(["REAL_GAP"]);
  });

  it("exempts a key allowlisted as chart-only from the Compose direction", () => {
    const result = computeConfigSurfaceDrift(
      [],
      ["REVIEW_DEMO_WS", "REAL_GAP"],
      [
        {
          key: "REVIEW_DEMO_WS",
          declaredOn: "chart",
          reason: "Review apps only; Compose has no review-app concept.",
        },
      ],
    );
    expect(result.missingFromEnvProdExample).toEqual(["REAL_GAP"]);
  });

  it("does not let a chart-only exemption silence the opposite direction", () => {
    // An exemption is directional on purpose. `declaredOn: "chart"` says "the
    // chart may declare this alone"; it must NOT also excuse the chart from
    // declaring something .env.prod.example offers, or one allowlist entry
    // would blind both halves of the check.
    const result = computeConfigSurfaceDrift(
      ["SOME_KEY"],
      [],
      [{ key: "SOME_KEY", declaredOn: "chart", reason: "test" }],
    );
    expect(result.missingFromChart).toEqual(["SOME_KEY"]);
  });

  it("flags an allowlist entry whose key has since appeared on both surfaces", () => {
    // Once the gap is closed the written exemption is a lie. Reporting it is
    // what keeps the allowlist from turning back into a list of omissions.
    const result = computeConfigSurfaceDrift(
      ["NOW_ON_BOTH"],
      ["NOW_ON_BOTH"],
      [{ key: "NOW_ON_BOTH", declaredOn: "chart", reason: "test" }],
    );
    expect(result.staleAllowlistEntries).toEqual(["NOW_ON_BOTH"]);
  });

  it("flags a dead allowlist entry whose key is on neither surface", () => {
    const result = computeConfigSurfaceDrift(
      [],
      [],
      [{ key: "DELETED_KEY", declaredOn: "compose", reason: "test" }],
    );
    expect(result.staleAllowlistEntries).toEqual(["DELETED_KEY"]);
  });
});

describe("CONFIG_SURFACE_ALLOWLIST", () => {
  it("states a reason for every exemption", () => {
    for (const entry of CONFIG_SURFACE_ALLOWLIST) {
      expect(
        entry.reason.trim().length,
        `${entry.key} is exempt without a stated reason`,
      ).toBeGreaterThan(20);
    }
  });

  it("names each key exactly once", () => {
    const keys = CONFIG_SURFACE_ALLOWLIST.map((entry) => entry.key);
    expect(keys).toEqual([...new Set(keys)]);
  });
});

describe("PLATFORM_DIVERGENCES", () => {
  it("records the capability differences the two platforms cannot share", () => {
    // #135 asked for these to be written down rather than merely absent. They
    // are not env keys, so the key-level allowlist above cannot hold them.
    expect(PLATFORM_DIVERGENCES.length).toBeGreaterThan(0);
    for (const entry of PLATFORM_DIVERGENCES) {
      expect(entry.area.trim()).not.toBe("");
      expect(
        entry.chart.trim().length,
        `${entry.area} does not say what the chart does`,
      ).toBeGreaterThan(0);
      expect(
        entry.compose.trim().length,
        `${entry.area} does not say what Compose does`,
      ).toBeGreaterThan(0);
      expect(
        entry.reason.trim().length,
        `${entry.area} is recorded without a reason`,
      ).toBeGreaterThan(20);
    }
  });
});

/**
 * #135 — the gate itself. Instance A (Helm on Kubernetes) and Instance B
 * (Docker Compose, the documented self-host path) express two configuration
 * surfaces, and until this test nothing checked they matched. Gap 1 was
 * GOOGLE_CLIENT_ID/SECRET living only in the chart, so the product's headline
 * capability silently did not exist for a self-hoster.
 *
 * A divergence is either fixed or written into CONFIG_SURFACE_ALLOWLIST with a
 * reason. There is no third option, which is the whole point.
 */
describe("Instance A / Instance B config surface parity (#135)", () => {
  const envProdExampleKeys = extractDocumentedEnvKeys(
    readFileSync(join(process.cwd(), ENV_PROD_EXAMPLE_FILE), "utf8"),
  );
  const chartKeys = [
    ...new Set(
      CHART_CONFIG_SURFACE_FILES.flatMap((file) =>
        extractManifestEnvKeys(readFileSync(join(process.cwd(), file), "utf8")),
      ),
    ),
  ];

  // Duo review (!230): the extractor separates env keys from YAML structure by
  // CASE, which is a convention these manifests hold to rather than a rule YAML
  // enforces. Adding a file with an all-caps structural key would invent drift.
  // Checked per file, so the failure names the offender.
  it.each([...CHART_CONFIG_SURFACE_FILES])(
    "%s declares only things that read as env variables",
    (file) => {
      expect(() =>
        assertManifestKeysLookLikeEnv(
          file,
          extractManifestEnvKeys(
            readFileSync(join(process.cwd(), file), "utf8"),
          ),
        ),
      ).not.toThrow();
    },
  );

  it("reads a non-trivial surface from each side", () => {
    // Fail closed: a renamed file or a broken regex reads as zero keys, and
    // zero-vs-zero is perfect parity. A floor well under either real count
    // catches that without turning every added key into a test edit.
    expect(envProdExampleKeys.length).toBeGreaterThan(10);
    expect(chartKeys.length).toBeGreaterThan(10);
  });

  it("offers every .env.prod.example key on the chart too, or says why not", () => {
    const { missingFromChart } = computeConfigSurfaceDrift(
      envProdExampleKeys,
      chartKeys,
    );
    expect(
      missingFromChart,
      "These are configurable on the Compose self-host path but have no chart " +
        "equivalent, so the Kubernetes instance cannot tune them without a " +
        "chart edit. Add them to charts/dlectroflow/templates/secret.yaml (+ " +
        "values.yaml), or add a CONFIG_SURFACE_ALLOWLIST entry in " +
        "src/lib/env-drift.ts saying why the divergence is deliberate.",
    ).toEqual([]);
  });

  it("offers every chart key on the self-host path too, or says why not", () => {
    const { missingFromEnvProdExample } = computeConfigSurfaceDrift(
      envProdExampleKeys,
      chartKeys,
    );
    expect(
      missingFromEnvProdExample,
      "These are configured on the Kubernetes instance but absent from " +
        ".env.prod.example, so a self-hoster following docs/self-host-vps.md " +
        "gets an app where the corresponding feature cannot work and no signal " +
        "why — that was gap 1 of #135. Document them in .env.prod.example, or " +
        "add a CONFIG_SURFACE_ALLOWLIST entry in src/lib/env-drift.ts saying " +
        "why the divergence is deliberate.",
    ).toEqual([]);
  });

  it("carries no stale allowlist entry", () => {
    const { staleAllowlistEntries } = computeConfigSurfaceDrift(
      envProdExampleKeys,
      chartKeys,
    );
    expect(
      staleAllowlistEntries,
      "These CONFIG_SURFACE_ALLOWLIST entries no longer describe reality — the " +
        "key is now on both surfaces, or on neither. Delete the entry.",
    ).toEqual([]);
  });
});
