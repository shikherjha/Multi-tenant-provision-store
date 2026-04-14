# storeOS

storeOS is a Kubernetes-native multi-tenant ecommerce provisioning platform. It creates isolated Medusa stores from a simple intent API, then reconciles the desired state with a Python operator and Helm.

The current production target is a GCP VM running k3s with Traefik, cert-manager, wildcard DNS, and S3-compatible object storage for media.

For the longer-term AI storefront and commerce direction, see [ROADMAP.md](./ROADMAP.md).

## Architecture

![Control Plane Architecture](./Control%20plane%20architecture.png)

![Component View](./component%20view.png)



The Store CRD is the source of truth. Users express intent by creating a Store resource. The operator reconciles that into Kubernetes resources and updates status conditions for the dashboard.

## Current Production Setup

| Area | Current choice |
| --- | --- |
| Cluster | k3s on a GCP VM |
| Ingress | Traefik, bundled with k3s |
| Platform domains | Configured through Helm values |
| Store domains | Wildcard store subdomain |
| TLS | cert-manager with Let's Encrypt HTTP-01 |
| Media storage | S3-compatible object storage with a public media domain |
| Store engine | Medusa v2 |
| Future engine | WooCommerce, currently stubbed |

Each store gets an isolated namespace with PostgreSQL, MedusaJS backend, storefront, Ingress, NetworkPolicy, ResourceQuota, and LimitRange.

Example store URL:

```text
https://store-1.stores.example.com
```

## Control Plane Features

| Feature | Implementation |
| --- | --- |
| Finalizers | Guaranteed cleanup on delete: Helm uninstall, PVC cleanup, namespace delete |
| Drift Detection | Smart check that only heals when resources are actually missing or degraded |
| Status Conditions | Granular conditions: NamespaceReady, HelmInstalled, DatabaseReady, BackendReady, StorefrontReady |
| Activity Log | Ring buffer in CRD status with 15 events plus Redis Streams for real-time dashboard updates |
| Concurrency Control | Max 3 parallel provisions, configurable through Helm |
| Identity Layer | `X-User-Id` header for multi-user awareness and per-user quota enforcement |
| Prometheus Metrics | `/metrics` endpoint with `stores_created_total`, `provisioning_failures_total`, `stores_total{phase}` |
| NetworkPolicy | Configurable ingress controller selector for ingress-nginx locally and Traefik in k3s |
| WooCommerce Stub | Accepted by CRD, immediately marked ComingSoon, showing extensible engine architecture |
| TLS Automation | cert-manager creates per-store Let's Encrypt certificates from store Ingress resources |
| Media Storage | S3-compatible object storage with public image URLs |

## Important Domain Notes

Store names are currently used as globally unique slugs:

```text
{store-slug}.stores.<your-domain>
```

That means Alice and Bob cannot both create a store with the slug `store-1`. For demos, use unique slugs:

```text
you-store-1
alice-store-1
bob-store-1
```

Long term, store display names should be separated from unique slugs.

## DNS

Production needs DNS records that point your platform and store hostnames to the ingress IP.

The important public store record is the wildcard store hostname:

```text
*.stores.<your-domain>  ->  <INGRESS_PUBLIC_IP>
```

Keep HTTP-01 validation in mind when using a CDN or DNS proxy. cert-manager must be able to receive Let's Encrypt validation traffic through the ingress controller.

Media should use a separate public object-storage domain:

```text
https://<media-domain>/...
```

For Cloudflare R2, connect the media hostname through the R2 custom domain flow rather than manually creating a normal A record.

## R2 Configuration

Production values keep secrets empty:

```yaml
r2:
  enabled: true
  accessKeyId: ""
  secretAccessKey: ""
  accountId: ""
  bucket: "store-platform-media"
  publicUrl: "https://<media-domain>"
```

Set secrets on the VM in `.env`:

```bash
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_ACCOUNT_ID=...
R2_BUCKET=store-platform-media
R2_PUBLIC_URL=https://<media-domain>
```

## Production Deploy

Run on the VM after pulling the latest code and setting `.env`.

Build the images:

```bash
docker build -t medusa-store:full ./docker/medusa-full
docker build -t store-storefront:latest ./docker/storefront

rm -rf /tmp/operator-build
mkdir -p /tmp/operator-build
cp -r store-operator/* /tmp/operator-build/
cp -r charts /tmp/operator-build/charts
docker build -t store-operator:latest /tmp/operator-build
```

Import images into k3s containerd:

```bash
docker save medusa-store:full | sudo k3s ctr images import -
docker save store-storefront:latest | sudo k3s ctr images import -
docker save store-operator:latest | sudo k3s ctr images import -
```

Deploy:

```bash
chmod +x scripts/deploy-prod.sh
./scripts/deploy-prod.sh
```

Restart platform pods when reusing image tags:

```bash
kubectl rollout restart deployment/store-operator -n store-platform
kubectl rollout restart deployment/intent-api -n store-platform
kubectl rollout restart deployment/dashboard -n store-platform
```

## How To Create A Store And Place An Order

1. Open the dashboard.
2. Click `+ New Store`.
3. Enter a globally unique slug, for example `you-store-1`, and select the MedusaJS engine.
4. Watch the provisioning pipeline progress in real time: Namespace, Helm, Database, Backend, Storefront.
5. When status becomes Ready, usually after 1 to 3 minutes, click the store URL.
6. Browse products, add to cart, and checkout.
7. View orders in Medusa Admin through the Admin link.

Create a store through the API:

```bash
curl -X POST https://<platform-api-host>/api/stores \
  -H "Content-Type: application/json" \
  -H "X-User-Id: you" \
  -d '{"name":"you-store-1","engine":"medusa"}'
```

Watch status:

```bash
kubectl get stores
kubectl get pods -n store-you-store-1
kubectl get ingress -n store-you-store-1
kubectl get certificate -n store-you-store-1
```

## API Endpoints

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/stores` | Create a store, idempotent by store name |
| GET | `/api/stores` | List stores filtered by `X-User-Id` |
| GET | `/api/stores/{name}` | Get store details, conditions, and activity log |
| DELETE | `/api/stores/{name}` | Delete a store asynchronously |
| GET | `/api/stores/{name}/logs` | Activity log from CRD status and Redis |
| WS | `/api/stores/ws` | Real-time events through Redis PubSub or polling fallback |
| GET | `/health` | Health check with Redis status |
| GET | `/metrics` | Prometheus metrics |
| GET | `/docs` | OpenAPI documentation |

## Local Development

Local development still supports Kind and `127.0.0.1.nip.io`.

```bash
kind create cluster --name storeos-cluster --config kind-config.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl wait --namespace ingress-nginx --for=condition=ready pod --selector=app.kubernetes.io/component=controller --timeout=90s

BACKEND_MODE=full ./scripts/build-images.sh
./scripts/deploy-local.sh
```

Local URLs:

```text
http://dashboard.127.0.0.1.nip.io
http://api.127.0.0.1.nip.io/docs
```

## Legacy DNS Path

Earlier versions used `nip.io` for production store domains:

```text
store-name.<ip>.nip.io
```

That was useful before buying a domain, but it is now a legacy path. Production should use a managed domain with wildcard DNS. `nip.io` remains useful for local testing or quick throwaway environments.

## Project Structure

```text
store-operator/          # Kubernetes Operator, Python and kopf
  operator.py            # Reconciliation, drift detection, activity log
  crd.yaml               # Store CRD with activityLog schema
  requirements.txt       # kopf, kubernetes, redis
  Dockerfile

intent-api/              # FastAPI backend
  main.py                # App entry, /metrics, /health
  config.py              # Environment-based configuration
  models.py              # Pydantic models
  routers/stores.py      # CRUD, identity, WebSocket, Redis Streams
  services/              # Kubernetes client abstraction
  requirements.txt
  Dockerfile

dashboard/               # React frontend, Vite
  src/App.jsx            # Pipeline visualization, activity log, real-time events
  src/index.css          # Dashboard styling

docker/
  medusa/                # Lightweight ecommerce backend for mock mode
  medusa-full/           # MedusaJS v2 production backend
  storefront/            # Next.js storefront
  storefront-mock/       # Minimal mock storefront

charts/
  store-platform/        # Platform Helm chart
    templates/
      operator-deployment.yaml
      api-deployment.yaml
      redis-deployment.yaml
      dashboard-deployment.yaml
      operator-rbac.yaml
      platform-ingress.yaml
    values.yaml
    values-local.yaml
    values-prod.yaml
  store-medusa/          # Per-store Helm chart
    templates/
      networkpolicy.yaml
      medusa-deployment.yaml
      storefront-deployment.yaml
      postgres-statefulset.yaml
      ingress.yaml
    values.yaml

scripts/                 # Build, setup, deploy, and test scripts
SYSTEM_DESIGN.md         # Architecture, tradeoffs, and decisions
README.md
```

## Key Design Decisions

See [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) for full details on:

- Intent-reconciling operator fabric architecture
- Idempotency and failure handling, including stuck Helm release recovery
- Smart drift detection with check-before-heal behavior
- Defense-in-depth isolation model
- Activity log design with CRD ring buffer and Redis Streams
- Identity layer and abuse prevention
- Observability strategy with metrics, events, and logs
- Local-to-production portability through Helm values
- WooCommerce adapter path
- Horizontal scaling plan

## Security Notes

This repo should not contain production secrets. `.env` is ignored by Git and should stay on the VM only.

Known MVP tradeoffs:

```text
Medusa admin demo user is hardcoded in the image startup script.
Publishable API key is forced to pk_dummy for current storefront wiring.
JWT and cookie secrets fall back to demo defaults if env values are missing.
R2 credentials are passed through Helm values and become deployment environment variables.
```

Before production, move sensitive values to Kubernetes Secrets or an external secret manager, generate per-store publishable keys, and remove the hardcoded Medusa admin password.
