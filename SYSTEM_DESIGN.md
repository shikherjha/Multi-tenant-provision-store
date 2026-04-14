# storeOS System Design

## Goal

storeOS provisions isolated ecommerce stores from a single intent API. The current implementation uses Medusa v2 as the commerce engine, Kubernetes as the orchestration layer, and Cloudflare for DNS and media delivery.

The long-term product direction is an LLM-operated ecommerce platform. The LLM should call structured tools to manage products, discounts, banners, layout configuration, orders, and store operations.

## Component Architecture

![Component View](./component%20view.png)



Each Medusa store namespace contains PostgreSQL, Medusa backend, Next.js storefront, Ingress, NetworkPolicy, ResourceQuota, and LimitRange.

## Production Edge

| Concern | Current implementation |
| --- | --- |
| DNS | Cloudflare DNS for `storeos.in` |
| Platform hosts | `dashboard.storeos.in`, `api.storeos.in` |
| Store hosts | `*.stores.storeos.in` |
| Ingress | Traefik from k3s |
| TLS | cert-manager with Let's Encrypt HTTP-01 |
| Media | Cloudflare R2 bucket with `media.storeos.in` |
| Public product images | URLs generated from `R2_PUBLIC_URL` |

The old `nip.io` deployment flow was useful before a real domain existed. It is now a legacy fallback for local or temporary environments. Production should use Cloudflare DNS and the `storeos.in` domain.

## Store CRD

The Store CRD is the control-plane source of truth.

```yaml
apiVersion: platform.storeos.in/v1
kind: Store
metadata:
  name: you-store-1
spec:
  engine: medusa
  owner: you
  domainSuffix: stores.storeos.in
```

The CRD is cluster-scoped. Store names are currently global slugs and must be unique across all users.

## Operator Responsibilities

The operator is responsible for:

```text
Creating the store namespace
Installing or upgrading the per-store Helm release
Injecting production values such as Traefik, TLS, and R2
Checking PostgreSQL, Medusa, and storefront readiness
Updating Store status and activity log
Deleting Helm releases and namespaces on store deletion
Detecting resource drift and self-healing with Helm
```

The operator image bundles `charts/store-medusa`, so chart changes require rebuilding and importing `store-operator:latest`.

## Design Decisions And Rationale

### 1. Why A CRD Instead Of A Database

The CRD is the platform database. Kubernetes etcd provides:

- Consistency through resourceVersion and Kubernetes API concurrency control
- Durability through etcd snapshots and write-ahead logs
- Watch semantics so the operator reacts to changes without polling
- Declarative reconciliation where the CRD spec describes what should exist

No external platform database is required for the control plane. That reduces moving parts and keeps the platform portable across Kind, k3s, EKS, GKE, and similar Kubernetes environments.

### 2. Idempotency

Every reconciliation step is designed to be safe to repeat:

- `ensure_namespace()` checks for existing namespaces before creating.
- Helm install logic checks release status before deciding install, upgrade, or cleanup.
- Store creation returns the existing Store if the name already exists.
- Stuck Helm release recovery detects `pending-install`, `pending-upgrade`, and `failed` releases before retrying.

This is important because Kubernetes operators are expected to retry after restarts, API failures, and partial reconciliation.

### 3. Failure Handling

Transient failures, such as network timeout or pods not being ready yet, are treated with `kopf.TemporaryError` and retry backoff.

Permanent failures, such as unsupported engine values or quota exhaustion, are reflected in Store status as Failed.

Operator restart is handled through resume reconciliation. Non-ready stores are reconciled again when the operator comes back.

Stuck Helm releases are cleaned up before a fresh install or upgrade attempt. This prevents a store from staying permanently blocked in a Helm pending state.

### 4. Multi-Layered Isolation

| Layer | Mechanism |
| --- | --- |
| Namespace | `store-{name}` blast radius containment |
| ResourceQuota | CPU, memory, pod, and PVC limits per namespace |
| LimitRange | Default container requests and limits |
| NetworkPolicy | Default-deny plus explicit allows for ingress, app, database, and ACME solver traffic |
| PodSecurityContext | Non-root runtime settings where supported |
| RBAC | Least-privilege ClusterRole for the operator ServiceAccount |

The isolation boundary is a Kubernetes namespace. This is simple enough for MVP while still giving a clean future path to stronger tenant isolation.

### 5. Drift Detection And Self-Healing

The operator runs a smart drift check for Ready stores.

It checks:

- Critical deployments, statefulsets, and services exist.
- Replica counts match expected values.
- Pods are healthy enough to keep status current.

Only if drift is detected does the operator trigger Helm upgrade to restore missing or damaged resources. If there is no drift, it avoids unnecessary Helm calls and does not restart healthy pods.

### 6. Status Conditions

Instead of reporting only `phase: Provisioning`, the operator reports granular conditions:

```yaml
status:
  phase: Provisioning
  conditions:
    - type: NamespaceReady
      status: "True"
      reason: Created
    - type: HelmInstalled
      status: "True"
      reason: Installed
    - type: DatabaseReady
      status: "True"
      reason: Running
    - type: BackendReady
      status: "False"
      reason: NotReady
      message: "Pod medusa-backend-xxx: CrashLoopBackOff"
    - type: StorefrontReady
      status: "False"
      reason: NotReady
  activityLog:
    - timestamp: "2026-04-14T10:30:00Z"
      event: PROVISIONING_START
      message: "Store provisioning started"
    - timestamp: "2026-04-14T10:30:05Z"
      event: NAMESPACE_READY
      message: "Namespace store-myshop ready"
```

The dashboard renders these conditions as a provisioning pipeline. This gives the user an understandable step-by-step view instead of a single opaque status.

### 7. Activity Log

Each store maintains a ring buffer of the last 15 events in CRD status.

The design has two event paths:

- CRD status for always-available store history.
- Redis Streams and PubSub for real-time dashboard updates.

The CRD ring buffer avoids unbounded etcd growth. Redis gives a smoother live UI without becoming a hard dependency for core reconciliation.

### 8. Identity Layer

The current identity layer uses the `X-User-Id` HTTP header.

It provides:

- Multi-user store listing for demo users.
- Per-user quota enforcement.
- Simple audit context in CRD spec and labels.
- A clean path to future JWT or identity provider integration.

In production, this header should be set or validated by an auth layer, not trusted directly from arbitrary clients.

### 9. Observability

| Signal | Mechanism |
| --- | --- |
| Metrics | Prometheus `/metrics` endpoint |
| Logs | Structured logs in API and operator |
| Events | Kubernetes Events from kopf plus Redis Streams |
| Activity Log | CRD status ring buffer plus Redis Streams |

Key metrics include:

```text
stores_created_total
provisioning_failures_total
stores_total{phase}
```

### 10. Concurrency Control

The operator limits concurrent reconciliations to 3 workers by default. This prevents resource exhaustion when many stores are created at the same time.

The limit is configurable through Helm values.

## Store Networking

Each store namespace has a default-deny ingress policy. Explicit policies allow:

```text
Traefik to storefront and Medusa backend
Storefront to Medusa backend
Medusa backend to PostgreSQL
Traefik to cert-manager HTTP-01 solver pods
```

The cert-manager solver exception is required because HTTP-01 validation creates temporary solver pods in the store namespace. Without this policy, Let's Encrypt challenges can remain pending.

The ingress controller selector is configurable through Helm values:

| Environment | Selector |
| --- | --- |
| Kind local | `app.kubernetes.io/name: ingress-nginx` |
| k3s production | `app.kubernetes.io/name: traefik` |

## TLS Flow

1. Store Helm chart creates an Ingress with `cert-manager.io/cluster-issuer`.
2. The Ingress includes a TLS block and `secretName`.
3. cert-manager ingress-shim creates a Certificate.
4. Let's Encrypt validates the HTTP-01 challenge through Traefik.
5. cert-manager writes the certificate to the store namespace.
6. Traefik serves the store with the issued certificate.

## R2 Media Flow

The Medusa backend uses the S3-compatible R2 endpoint for uploads:

```text
https://<account_id>.r2.cloudflarestorage.com
```

Public URLs use the custom R2 domain:

```text
https://media.storeos.in
```

These two URLs must not be confused. The public URL should come from `R2_PUBLIC_URL`, not from the R2 account ID.

## Storefront Customization Direction

The current storefront is based on the Medusa Next.js starter. It is a normal Next.js React app and can be replaced or customized.

For an LLM-operated platform, the recommended model is a config-driven storefront renderer:

```text
One shared storefront codebase
Per-store theme and page configuration
LLM updates structured config through safe backend tools
Frontend renders sections from config
```

The LLM should not write arbitrary React code for each store in the MVP. It should call tools such as:

```text
update_theme
update_homepage_sections
create_banner
feature_collection
create_discount
update_navigation
```

This gives different stores different UI without duplicating the codebase.

## WooCommerce Stubbing

WooCommerce is deliberately stubbed:

- The CRD accepts `engine: woocommerce`.
- The operator sets the store to ComingSoon without provisioning.
- The dashboard can show the store as a future engine.
- The API and CRD shape demonstrate how another commerce engine can plug in later.

The intended long-term shape is an adapter layer:

```text
CommerceAdapter
  create_product
  update_product
  create_discount
  list_orders
  update_inventory
  upload_media

MedusaAdapter
WooCommerceAdapter
```

The storefront renderer should remain engine-agnostic where possible.

## Security

This repo should not contain production secrets. `.env` is ignored and should remain VM-local.

Known MVP risks:

| Risk | Current state | Recommended fix |
| --- | --- | --- |
| Hardcoded Medusa admin user | `admin@medusa-store.com` and `supersecret` in startup scripts | Generate per-store admin credentials and store in Kubernetes Secrets |
| Demo JWT and cookie fallback secrets | Defaults exist in Medusa config | Require explicit secrets in Helm values |
| Shared publishable key token | `pk_dummy` for storefront simplicity | Generate and inject a per-store publishable key |
| R2 credentials in env vars | Passed through Helm values into deployments | Move to Kubernetes Secrets or External Secrets |
| CORS is open | `STORE_CORS`, `ADMIN_CORS`, and `AUTH_CORS` default to `*` | Restrict to store and platform hosts |
| Public media | Product media is public through R2 | Expected for ecommerce product images |

## Local To Production Portability

| Setting | Local | Production |
| --- | --- | --- |
| Cluster | Kind | k3s on GCP VM |
| StorageClass | `standard` | `local-path` |
| Ingress | ingress-nginx | Traefik |
| Domain | `127.0.0.1.nip.io` | `storeos.in` |
| TLS | optional | cert-manager |
| Images | Docker load into Kind | Docker import into k3s containerd today, registry later |
| Redis | In-cluster Redis | In-cluster Redis or external Redis later |
| Media | local or R2 | Cloudflare R2 |

All environment-specific choices should live in Helm values or VM-local `.env`, not hardcoded code.

## Horizontal Scaling Plan

| Component | Strategy |
| --- | --- |
| Operator | Single active reconciler with future leader election through Lease |
| Intent API | Stateless replicas behind the platform Ingress |
| Dashboard | Static frontend, can move to CDN or Vercel later |
| Redis | Redis Sentinel, Redis Cluster, or managed Redis later |
| Per-store workloads | Independent namespaces give natural scale and isolation boundaries |
