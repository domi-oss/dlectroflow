{{- define "dlectroflow.labels" -}}
app.kubernetes.io/name: dlectroflow
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
dlectroflow/env: {{ .Values.env }}
{{- end -}}

{{- define "dlectroflow.databaseUrl" -}}
postgresql://dlectroflow:{{ .Values.secrets.postgresPassword }}@dlectroflow-postgres:5432/dlectroflow?schema=public
{{- end -}}
