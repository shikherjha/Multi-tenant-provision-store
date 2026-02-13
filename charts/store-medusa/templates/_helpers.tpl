{{/*
Common labels for all resources in a store namespace.
*/}}
{{- define "store-medusa.labels" -}}
app.kubernetes.io/part-of: medusa-store
app.kubernetes.io/managed-by: store-operator
store.platform.urumi.ai/name: {{ .Values.storeName }}
{{- end }}

{{/*
Selector labels for medusa backend
*/}}
{{- define "store-medusa.medusa.labels" -}}
app.kubernetes.io/name: medusa-backend
app.kubernetes.io/instance: {{ .Values.storeName }}
{{ include "store-medusa.labels" . }}
{{- end }}

{{/*
Selector labels for postgres
*/}}
{{- define "store-medusa.postgres.labels" -}}
app.kubernetes.io/name: postgres
app.kubernetes.io/instance: {{ .Values.storeName }}-pg
{{ include "store-medusa.labels" . }}
{{- end }}

{{/*
Selector labels for storefront
*/}}
{{- define "store-medusa.storefront.labels" -}}
app.kubernetes.io/name: storefront
app.kubernetes.io/instance: {{ .Values.storeName }}-sf
{{ include "store-medusa.labels" . }}
{{- end }}
