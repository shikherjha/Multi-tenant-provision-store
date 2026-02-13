#!/bin/bash
# Deploy the platform to Kind cluster
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "============================================"
echo "  Deploying Store Platform (Local)"
echo "============================================"

cd "$PROJECT_DIR"

# 1. Apply CRD
echo ""
echo "[1/3] Applying Store CRD..."
kubectl apply -f store-operator/crd.yaml
echo "  ✓ CRD applied"

# 2. Create platform namespace
echo ""
echo "[2/3] Creating platform namespace..."
kubectl create namespace store-platform 2>/dev/null || echo "  Namespace already exists"

# 3. Deploy platform via Helm
echo ""
echo "[3/3] Installing/upgrading platform Helm chart..."
helm upgrade --install store-platform ./charts/store-platform \
  -n store-platform \
  -f ./charts/store-platform/values-local.yaml \
  --wait --timeout 120s

echo ""
echo "============================================"
echo "  ✅ Platform Deployed!"
echo "============================================"
echo ""
echo "  Add to /etc/hosts (or C:\\Windows\\System32\\drivers\\etc\\hosts):"
echo "    127.0.0.1  dashboard.local.urumi api.local.urumi"
echo ""
echo "  Dashboard: http://dashboard.local.urumi"
echo "  API Docs:  http://api.local.urumi/docs"
echo ""
echo "  Or use port-forward for local development:"
echo "    kubectl port-forward -n store-platform svc/intent-api 8080:8080"
echo "    kubectl port-forward -n store-platform svc/dashboard 3000:80"
echo ""
