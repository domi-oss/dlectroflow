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

{{- define "dlectroflow.databaseUrl" -}}
{{- /* sslmode=require: Prisma's engine fails closed (P1011) if the server
can't do TLS, and accepts the self-signed cert (encryption, not verity —
verified empirically against postgres:16 + prisma 6.19). */ -}}
postgresql://dlectroflow:{{ .Values.secrets.postgresPassword | urlquery }}@dlectroflow-postgres:5432/dlectroflow?schema=public&sslmode=require
{{- end -}}
