# Store Provisioning Platform
**[WATCH THE DEMO VIDEO](https://drive.google.com/file/d/1UfHGKHhVLVN56UNvD9bNlBog8O6DZEyv/view?usp=sharing)**

**Kubernetes-native multi-tenant e-commerce store provisioning platform** using a CRD-based Operator pattern with production-grade control plane enhancements.

## Architecture

![Component Architecture](./component%20view.png)

![Control Plane Architecture](./Control%20plane%20architecture.png)

Each store gets an **isolated namespace** with: PostgreSQL + MedusaJS Backend + Storefront + Ingress + NetworkPolicy + ResourceQuota + LimitRange.

## Control Plane Features

| Feature | Implementation |
|---------|----------------|
| **Finalizers** | Guaranteed cleanup on delete (Helm uninstall → PVC cleanup → Namespace delete) |
| **Drift Detection** | Smart check: only heals when resources actually missing (no blind upgrades) |
| **Status Conditions** | Granular: NamespaceReady, HelmInstalled, DatabaseReady, BackendReady, StorefrontReady |
| **Activity Log** | Ring buffer in CRD status (15 events) + Redis Streams for real-time dashboard |
| **Concurrency Control** | Max 3 parallel provisions (configurable via Helm) |
| **Identity Layer** | X-User-Id header for multi-user awareness + per-user quota enforcement |
| **Prometheus Metrics** | `/metrics` endpoint: stores_created_total, provisioning_failures_total, stores_total{phase} |
| **NetworkPolicy** | Configurable ingress controller selector (Nginx ↔ Traefik) via values |
| **WooCommerce Stub** | Accepted by CRD, immediately marked ComingSoon — demonstrates extensible engine architecture |

## Prerequisites

- Docker Desktop (with WSL integration)
- Kind v0.20+
- Helm v3+
- kubectl v1.27+
- Python 3.12+ (for local dev)
- Node.js 20+ (for dashboard dev)

## Quick Start (Local)

### 1. Create Kind Cluster

```bash
kind create cluster --name urumi-cluster --config kind-config.yaml
# Install Ingress Controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl wait --namespace ingress-nginx --for=condition=ready pod --selector=app.kubernetes.io/component=controller --timeout=90s
```

### 2. Build & Load Docker Images

```bash
chmod +x scripts/*.sh
./scripts/build-images.sh
```

### 3. Deploy Platform

```bash
./scripts/deploy-local.sh
```

### 4. Add DNS Entries

Add to `/etc/hosts` (Linux/WSL) or `C:\Windows\System32\drivers\etc\hosts`:
```
127.0.0.1  dashboard.local.urumi api.local.urumi
```

### 5. Access Dashboard

- **Dashboard**: http://dashboard.local.urumi
- **API Docs**: http://api.local.urumi/docs
- **Metrics**: http://api.local.urumi/metrics
- **Health**: http://api.local.urumi/health

### Local Development (without Docker)

```bash
# Terminal 1: API
cd intent-api
python -m venv venv
source venv/bin/activate  # or venv\Scripts\activate on Windows
pip install -r requirements.txt
python main.py

# Terminal 2: Dashboard
cd dashboard
npm install
npm run dev

# Terminal 3: Operator (needs cluster access)
cd store-operator
pip install -r requirements.txt
kopf run operator.py --verbose
```

## How to Create a Store & Place an Order

1. Open the Dashboard
2. Click **"+ New Store"**
3. Enter a name (e.g., `my-shop`), select **MedusaJS** engine
4. Watch the **provisioning pipeline** progress in real-time:
   - ✓ Namespace → ✓ Helm → ✓ Database → ✓ Backend → ✓ Storefront
5. When status becomes **Ready** (1-3 minutes), click the store URL
6. Browse products → Add to cart → Checkout
7. View orders in Medusa Admin via **Admin** link

## Provisioning Pipeline (Dashboard)

The dashboard shows a visual pipeline for each store:

```
[✓ Namespace] ─── [✓ Helm] ─── [✓ Database] ─── [◉ Backend] ─── [○ Storefront]
                                                     ↑ active step
```

Each step maps to a CRD status condition. Failed steps show the error message.
The activity log panel shows all events with timestamps.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/stores` | Create a store (idempotent) |
| GET | `/stores` | List stores (filtered by X-User-Id) |
| GET | `/stores/{name}` | Get store details + conditions + activity log |
| DELETE | `/stores/{name}` | Delete store (202 async) |
| GET | `/stores/{name}/logs` | Activity log (CRD + Redis) |
| WS | `/stores/ws` | Real-time events (Redis PubSub or polling fallback) |
| GET | `/health` | Health check with Redis status |
| GET | `/metrics` | Prometheus metrics |
| GET | `/docs` | OpenAPI (Swagger) docs |

## VPS / Production Setup (k3s)

```bash
# On VPS: Install k3s
curl -sfL https://get.k3s.io | sh -

# Deploy with production values
helm upgrade --install store-platform ./charts/store-platform \
  -f ./charts/store-platform/values-prod.yaml \
  --namespace store-platform --create-namespace

# What changes (via Helm values):
# - Domain: *.yourvps.com (real DNS A records)
# - Storage: local-path (k3s default)
# - Ingress: traefik (k3s built-in)
# - NetworkPolicy: traefik selector (auto-configured)
# - Images: from container registry
# - TLS: add cert-manager for HTTPS
```

## Project Structure

```
├── store-operator/          # Kubernetes Operator (Python/kopf)
│   ├── operator.py          # Reconciliation + drift detection + activity log
│   ├── crd.yaml             # Store CRD with activityLog schema
│   ├── requirements.txt     # kopf, kubernetes, redis
│   └── Dockerfile
├── intent-api/              # FastAPI backend
│   ├── main.py              # App entry + /metrics + /health
│   ├── config.py            # Environment-based configuration
│   ├── models.py            # Pydantic models (StoreResponse, ActivityLogEntry)
│   ├── routers/stores.py    # CRUD + identity + WebSocket + Redis Streams
│   ├── services/            # K8s client abstraction
│   ├── requirements.txt     # fastapi, redis, prometheus_client
│   └── Dockerfile
├── dashboard/               # React frontend (Vite)
│   ├── src/App.jsx          # Pipeline visualization + activity log + real-time
│   └── src/index.css        # Premium dark-mode design system
├── docker/
│   ├── medusa/              # Lightweight e-commerce backend (MedusaJS API surface)
│   └── storefront/          # Minimal HTML storefront
├── charts/
│   ├── store-platform/      # Platform Helm chart
│   │   ├── templates/
│   │   │   ├── operator-deployment.yaml   # + REDIS_URL env
│   │   │   ├── api-deployment.yaml        # + REDIS_URL env
│   │   │   ├── redis-deployment.yaml      # NEW: shared Redis
│   │   │   ├── dashboard-deployment.yaml
│   │   │   ├── operator-rbac.yaml         # Least-privilege RBAC
│   │   │   └── platform-ingress.yaml
│   │   ├── values.yaml
│   │   ├── values-local.yaml
│   │   └── values-prod.yaml
│   └── store-medusa/        # Per-store Helm chart
│       ├── templates/
│       │   ├── networkpolicy.yaml  # Configurable ingress selector
│       │   └── ...
│       └── values.yaml
├── scripts/                 # Build, deploy, test scripts
├── SYSTEM_DESIGN.md         # Architecture, tradeoffs, decisions
└── README.md
```

## Key Design Decisions

See [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) for full details on:
- Intent-Reconciling Operator Fabric architecture
- Idempotency & failure handling (stuck release recovery)
- Smart drift detection (check-before-heal vs blind upgrade)
- Defense-in-depth isolation model (6 layers)
- Activity log design (CRD ring buffer + Redis Streams)
- Identity layer & abuse prevention
- Observability strategy (metrics + events + logs)
- Local-to-production story via Helm values
- Horizontal scaling plan

## Verification Checklist

```bash
# 1. Drift Detection: Delete a deployment, watch operator self-heal
kubectl delete deployment medusa-backend -n store-myshop
# → Wait 120s → Operator detects drift → Helm upgrade → Deployment restored

# 2. Concurrency: Create 5 stores simultaneously
for i in {1..5}; do
  curl -X POST http://api.local.urumi/stores \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"load-$i\", \"engine\": \"medusa\"}"
done
# → Only 3 provision at a time (max_workers=3)

# 3. Finalizer: Delete store, verify complete cleanup
kubectl delete store myshop
# → Watch: Helm uninstall → PVC cleanup → Namespace delete → Store CRD gone

# 4. Metrics: Check Prometheus endpoint
curl http://api.local.urumi/metrics | grep store_platform

# 5. Identity: Scope by user
curl -H "X-User-Id: alice" http://api.local.urumi/stores
```
