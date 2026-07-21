{{- /* Selector labels: shared by the Deployment selector, the app Service,
the PDB, and the topology spread constraint so they can never drift apart
(a PDB whose selector matches zero pods is silently useless). Keep this
minimal and stable — Deployment selectors are immutable. */ -}}
{{- define "dlectroflow.selectorLabels" -}}
app.kubernetes.io/name: dlectroflow
{{- end -}}

{{- define "dlectroflow.labels" -}}
app.kubernetes.io/name: dlectroflow
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
dlectroflow/env: {{ .Values.env }}
{{- end -}}

{{- /*
FIXED-NAME / ONE-RELEASE-PER-NAMESPACE assumption (#15). This chart deliberately
uses fixed object names (`dlectroflow`, `dlectroflow-postgres`, ...) rather than
a `<release>-<chart>` fullname helper, so only ONE release can live in a given
namespace. That is intentional and matches the deploy model — production has its
own namespace and every review app gets its own ephemeral namespace, so names
never collide. The coupling to be aware of: `dlectroflow.databaseUrl` below
hardcodes the postgres Service host `dlectroflow-postgres` (which must equal the
StatefulSet/Service name in postgres.yaml), and backup.yaml / networkpolicy.yaml
reference the same fixed names. If you ever need two releases per namespace,
introduce a fullname helper and thread it through ALL of these together.
*/ -}}
{{- define "dlectroflow.databaseUrl" -}}
{{- /* sslmode=require: Prisma's engine fails closed (P1011) if the server
can't do TLS, and accepts the self-signed cert (encryption, not verity —
verified empirically against postgres:16 + prisma 6.19). */ -}}
postgresql://dlectroflow:{{ .Values.secrets.postgresPassword | urlquery }}@dlectroflow-postgres:5432/dlectroflow?schema=public&sslmode=require
{{- end -}}

{{- /*
Container resources. CPU is a COMPRESSIBLE resource: setting limits.cpu ==
requests.cpu throttles the container even when the node has spare CPU, which
needlessly slows Next.js startup and the Prisma `migrate` initContainer (and so
`helm --wait` / deploy_review — see #15). So we OMIT the CPU limit in production
(the container keeps its request as a guaranteed floor and may burst into idle
node CPU where the QoS class / platform allows it — where it can't, an unset
CPU limit is a no-op, never a regression) and KEEP a CPU limit ONLY in review,
where the namespace ResourceQuota (resourcequota.yaml sets limits.cpu) makes a
CPU limit mandatory on every container. The MEMORY limit is ALWAYS set: memory
is incompressible and an unbounded container can OOM the node. Call with a dict:
cpu, memory, env.
*/ -}}
{{- define "dlectroflow.resources" -}}
requests:
  cpu: {{ .cpu }}
  memory: {{ .memory }}
limits:
{{- if eq .env "review" }}
  cpu: {{ .cpu }}
{{- end }}
  memory: {{ .memory }}
{{- end -}}
