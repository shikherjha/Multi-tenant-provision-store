# Store Provisioning Platform

**Kubernetes-native multi-tenant e-commerce store provisioning platform** using a CRD-based Operator pattern.

## Architecture

```
Dashboard (React) → Intent API (FastAPI) → Store CRD → Operator (kopf) → K8s Resources
```

Each store gets an isolated namespace with: PostgreSQL + MedusaJS Backend + Storefront + Ingress + NetworkPolicy + ResourceQuota.

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
2. Click **"Create Store"**
3. Enter a name (e.g., `my-shop`), select **MedusaJS** engine
4. Wait for status to become **Ready** (1-3 minutes)
5. Click **"Open Store"** → browse products
6. Add a product to cart → Checkout with provided form
7. Order confirmed! View in Medusa Admin via **"Admin"** button

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
# - Images: from container registry
# - TLS: add cert-manager for HTTPS
```

## Project Structure

```
├── store-operator/          # Kubernetes Operator (Python/kopf)
│   ├── operator.py          # Reconciliation logic
│   ├── crd.yaml             # Store CRD definition
│   └── Dockerfile
├── intent-api/              # FastAPI backend
│   ├── main.py              # App entry
│   ├── routers/stores.py    # CRUD + WebSocket endpoints
│   ├── services/            # K8s client abstraction
│   └── Dockerfile
├── dashboard/               # React frontend
│   ├── src/App.jsx          # Main dashboard component
│   └── src/index.css        # Design system
├── docker/
│   ├── medusa/              # MedusaJS Docker image
│   └── storefront/          # Minimal HTML storefront
├── charts/
│   ├── store-platform/      # Platform Helm chart (operator + api + dashboard)
│   │   ├── values-local.yaml
│   │   └── values-prod.yaml
│   └── store-medusa/        # Per-store Helm chart
├── scripts/                 # Build, deploy, test scripts
└── SYSTEM_DESIGN.md         # Architecture & tradeoffs
```

## Key Design Decisions

See [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) for full details on:
- Architecture choices (Operator vs polling)
- Idempotency & failure handling
- Defense-in-depth isolation model
- Security posture & RBAC
- Local-to-production story via Helm values
- Horizontal scaling plan
