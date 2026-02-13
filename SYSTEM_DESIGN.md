# System Design — Store Provisioning Platform

## Architecture: Intent-Reconciling Operator Fabric

The platform follows a **declarative, intent-based architecture** where the Store CRD
is the single source of truth. Users express *intent* ("create a MedusaJS store"), and
the Kubernetes operator *reconciles* that intent into running infrastructure.

![Architecture](./component%20view.png)

## Component Responsibilities

| Component | Role |
|-----------|------|
| **Dashboard** | React SPA with real-time provisioning pipeline, activity logs, WebSocket/polling |
| **Intent API** | FastAPI — CRUD for Store CRDs, identity layer, rate limiting, Prometheus metrics |
| **Store CRD** | Kubernetes Custom Resource — the plane of record for all store state |
| **Operator** | kopf-based Python operator — watches CRDs, reconciles via Helm, drift detection |
| **Redis** | Optional event bus — Redis Streams for activity log, PubSub for live dashboard updates |
| **Medusa Chart** | Per-store Helm chart — PostgreSQL, Backend, Storefront, Ingress, NetworkPolicy |

## Design Decisions & Rationale

### 1. Why a CRD (not a database)?

The CRD *is* the database. Kubernetes etcd provides:
- **Consistency**: single-writer (operator) with optimistic concurrency via resourceVersion
- **Durability**: etcd snapshots, WAL
- **Watch semantics**: operator subscribes to changes without polling
- **Declarative reconciliation**: the CRD spec describes *what*, not *how*

No external database means fewer dependencies, no schema migrations, and the
platform works identically on Kind, k3s, EKS, or GKE.

### 2. Idempotency

Every reconciliation step is idempotent:
- `ensure_namespace()`: checks for 409 Conflict before creating
- `helm_install()`: checks release status before install vs. upgrade
- `create_store()`: returns existing store if name exists (no duplicates)
- **Stuck release recovery**: detects `pending-install` / `failed` releases  
  and cleans up before re-installing

### 3. Failure Handling

**Transient errors** (network timeout, pod not ready): `kopf.TemporaryError` with
exponential backoff. The operator retries up to 3 times, then marks as `Failed`.

**Permanent errors** (quota exceeded, invalid engine): immediate `Failed` status.

**Operator restart**: `@kopf.on.resume` re-reconciles all non-Ready stores.

**Stuck Helm releases**: operator detects `pending-install` / `pending-upgrade` / 
`failed` states and cleans up before attempting fresh install.

### 4. Multi-Layered Isolation

| Layer | Mechanism |
|-------|-----------|
| **Namespace** | `store-{name}` — blast radius containment |
| **ResourceQuota** | CPU/memory/pod/PVC limits per namespace |
| **LimitRange** | Default container resource requests/limits |
| **NetworkPolicy** | Default-deny + explicit allows (ingress→app, app→db) |
| **PodSecurityContext** | `runAsNonRoot`, `runAsUser: 1000` |
| **RBAC** | Least-privilege ClusterRole for operator ServiceAccount |

### 5. Drift Detection & Self-Healing

The operator runs a **smart drift check** every 120 seconds for Ready stores:

1. Check if critical resources exist (Deployments, StatefulSet, Services)
2. Check replica counts match expected
3. **Only if drift detected** → trigger `helm upgrade` to restore
4. No drift → just verify pod health

This avoids blind `helm upgrade` calls that cause unnecessary pod restarts.

### 6. Status Conditions (Granular)

Instead of a single `phase: Provisioning`, the operator reports granular conditions:

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
    - timestamp: "2024-01-15T10:30:00Z"
      event: PROVISIONING_START
      message: "Store provisioning started"
    - timestamp: "2024-01-15T10:30:05Z"
      event: NAMESPACE_READY
      message: "Namespace store-myshop ready"
```

The dashboard renders these as a **provisioning pipeline** — a visual step-by-step
indicator similar to Railway or Vercel's build logs.

### 7. Activity Log (Ring Buffer)

Each store maintains a **ring buffer** of the last 15 events in CRD status.
This is a deliberate design choice:

- **CRD status** (always available, no external dependency)
- **Redis Streams** (optional, for real-time streaming to dashboard)
- **etcd size limit** respected by capping at 15 entries

Events are pushed to both channels simultaneously. The dashboard reads from
CRD status on initial load, then subscribes to Redis Streams for live updates.

### 8. Identity Layer (X-User-Id)

A lightweight identity mechanism using the `X-User-Id` HTTP header:

- No full auth system (would be over-engineering for this scope)
- Scopes store listings to the requesting user
- Enforces per-user quotas (abuse prevention)
- Logged in audit trail for accountability

The header is set by the reverse proxy or dashboard. In production, this would
be replaced by JWT validation from an IdP.

### 9. Observability

| Signal | Mechanism |
|--------|-----------|
| **Metrics** | Prometheus `/metrics` — `stores_created_total`, `provisioning_failures_total`, `stores_total{phase}` |
| **Logs** | Structured logging in operator and API |
| **Events** | Kubernetes Events (kopf) + Redis Streams |
| **Activity Log** | CRD status ring buffer + Redis Streams |

### 10. Concurrency Control

The operator limits concurrent reconciliations to **3 workers** (`max_workers=3`).
This prevents resource exhaustion when many stores are created simultaneously.

## Security

### No Hardcoded Secrets
All secrets are managed via Helm values and Kubernetes Secrets.
PostgreSQL credentials are generated per-store and stored in namespace-scoped Secrets.

### Rate Limiting
The Intent API uses `slowapi` for IP-based rate limiting.
Default: 10 requests/minute (configurable per environment).

### Network Policies
Default-deny with explicit allows. The ingress controller selector is
**configurable** via Helm values:
- **Kind/local**: `app.kubernetes.io/name: ingress-nginx`
- **k3s/production**: `app.kubernetes.io/name: traefik`

No template changes needed — only values file changes.

## Local → Production Portability

| Setting | Local (Kind) | Production (k3s) |
|---------|-------------|-------------------|
| Storage Class | `standard` | `local-path` |
| Ingress Class | `nginx` | `traefik` |
| Domain | `*.local.urumi` | `*.stores.yourvps.com` |
| TLS | None | cert-manager |
| Images | Docker load | Registry push |
| Redis | Sidecar | Same (or external) |
| NetworkPolicy selector | `ingress-nginx` | `traefik` |

All differences are managed through `values-local.yaml` vs `values-prod.yaml`.
The Helm charts and operator code are **identical** across environments.

## WooCommerce Stubbing

The WooCommerce engine is deliberately stubbed:
- CRD accepts `engine: woocommerce`
- Operator immediately sets `phase: ComingSoon` without provisioning
- Dashboard shows the store with a "Coming Soon" badge
- This demonstrates extensible engine architecture without incomplete implementation

## Horizontal Scaling Plan

| Component | Strategy |
|-----------|----------|
| Operator | Single leader (kopf leader election via Lease) |
| Intent API | Stateless — scale replicas, no session affinity needed |
| Dashboard | Static — CDN/Nginx, infinite horizontal scale |
| Redis | Sentinel/Cluster for HA (beyond current scope) |
| Per-Store | Independent namespaces — natural isolation boundary |
