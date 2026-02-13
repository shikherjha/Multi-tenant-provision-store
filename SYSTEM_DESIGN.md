# System Design & Tradeoffs

## Architecture: Intent-Reconciling Operator Fabric

### Overview
This platform uses a **CRD-based Kubernetes Operator** pattern (inspired by Crossplane/ArgoCD) rather than the typical FastAPI → Celery → Helm approach. The Store CRD is the single source of truth; the Operator reconciles it.

```
User → Dashboard → Intent API → Store CRD → Operator → K8s Resources
                                     ↑                        ↓
                                     └── Status ←── Reconcile Loop
```

### Components & Responsibilities

| Component | Tech | Responsibility |
|-----------|------|---------------|
| **Dashboard** | React/Vite | User interface for store lifecycle management |
| **Intent API** | FastAPI | Validates requests, enforces quotas, creates/deletes Store CRDs |
| **Store CRD** | K8s API | Declarative spec of desired store state |
| **Operator** | Python/kopf | Watches CRDs, reconciles to actual K8s resources |
| **Medusa Chart** | Helm | Per-store template: PostgreSQL + Medusa + Storefront + Ingress |

### Why This Architecture?

1. **Declarative over Imperative**: Store CRD defines *what*, Operator decides *how*. This is the Kubernetes native pattern.
2. **Idempotent by Design**: Operator reconcile loop checks state before acting. Safe to retry, restart, or re-run.
3. **Observable**: CRD status + conditions give precise insight into provisioning state.
4. **Extensible**: Adding WooCommerce = adding a new Helm chart + engine handler in operator. No API changes.

## Idempotency & Failure Handling

### Reconcile Loop Safety
- Every step (namespace creation, Helm install) checks if work is already done before acting.
- `kubernetes.client.ApiException` with status 409 = resource exists = skip.
- Helm `install` checks for existing release and upgrades instead.

### Failure Recovery
- **Transient failures** (network, timeout): `kopf.TemporaryError` with delay → auto-retry up to 3 times.
- **Fatal failures** (quota exceeded, invalid spec): Status set to `Failed` with condition explaining why.
- **Operator restart**: `@kopf.on.resume` handler re-reconciles all non-Ready stores.
- **Cleanup guarantee**: Finalizer prevents CRD deletion until namespace + Helm release are cleaned up.

## Isolation Model (Defense-in-Depth)

| Layer | Implementation | Purpose |
|-------|---------------|---------|
| L1: Namespace | Per-store namespace `store-{name}` | Blast-radius boundary |
| L2: ResourceQuota | CPU/memory/PVC limits per namespace | Prevent resource abuse |
| L3: LimitRange | Default + max container limits | Prevent unbounded containers |
| L4: NetworkPolicy | Deny-all + explicit allows | Zero-trust networking |
| L5: PodSecurityContext | `runAsNonRoot`, `runAsUser: 1000` | Container hardening |

## Security Posture

- **No hardcoded secrets**: All credentials via Helm values → K8s Secrets.
- **RBAC**: Operator ServiceAccount with least-privilege ClusterRole.
- **Rate limiting**: FastAPI middleware (slowapi) at API layer.
- **Quota enforcement**: Per-owner and global store limits.
- **Audit trail**: In-memory audit log for CREATE/DELETE actions.

## What Changes for Production (Local vs VPS)

| Concern | Local (Kind) | Production (k3s VPS) |
|---------|-------------|---------------------|
| Storage Class | `standard` | `local-path` or `longhorn` |
| Ingress Class | `nginx` | `traefik` (k3s default) |
| Domain | `*.local.urumi` (hosts file) | `*.yourvps.com` (real DNS) |
| TLS | None | cert-manager + Let's Encrypt |
| Images | Loaded via `kind load` | Registry (Docker Hub/private) |
| Quotas | Lower (dev-friendly) | Higher (production capacity) |
| Rate limits | Relaxed | Stricter |

All differences are **Helm values only** — same charts, same code.

## Horizontal Scaling Plan

- **Dashboard**: Stateless → HPA on CPU, scale N replicas behind Ingress.
- **Intent API**: Stateless → HPA on CPU, scale N replicas.
- **Operator**: Single leader with kopf's built-in leader election. Can scale by partitioning CRD watches.
- **Store Provisioning**: Helm installs are sequential per-store but concurrent across stores. Redis-based queue for high throughput.

## Upgrade & Rollback

- `helm upgrade` with `--atomic` flag: auto-rollback on failure.
- `helm rollback store-platform <revision>` for platform rollback.
- Per-store upgrades: update CRD spec → Operator detects diff → Helm upgrade in store namespace.
