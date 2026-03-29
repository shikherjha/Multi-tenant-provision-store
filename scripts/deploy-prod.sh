#!/bin/bash
# =============================================================================
# Deploy Platform to Production (k3s + NIP.IO + R2)
# Run this on your GCP VM after setup-vps.sh
# =============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Auto-detect public IP
PUBLIC_IP=$(curl -s ifconfig.me)

echo "============================================"
echo "  Deploying Store Platform (Production)"
echo "  IP: $PUBLIC_IP"
echo "============================================"

cd "$PROJECT_DIR"

# Load R2 credentials from .env if it exists
if [ -f .env ]; then
  echo ""
  echo "Loading R2 credentials from .env..."
  export $(grep -v '^#' .env | xargs)
fi

# Validate R2 credentials
R2_SET_ARGS=""
if [ -n "$R2_ACCESS_KEY_ID" ]; then
  echo "  R2 credentials found"
  R2_SET_ARGS="--set r2.enabled=true"
  R2_SET_ARGS="$R2_SET_ARGS --set r2.accessKeyId=$R2_ACCESS_KEY_ID"
  R2_SET_ARGS="$R2_SET_ARGS --set r2.secretAccessKey=$R2_SECRET_ACCESS_KEY"
  R2_SET_ARGS="$R2_SET_ARGS --set r2.accountId=$R2_ACCOUNT_ID"
  R2_SET_ARGS="$R2_SET_ARGS --set r2.bucket=${R2_BUCKET:-store-platform-media}"
else
  echo "  WARN: No R2 credentials found. Image storage will use local disk."
fi

# 1. Apply CRD
echo ""
echo "[1/3] Applying Store CRD..."
kubectl apply -f store-operator/crd.yaml
echo "  ✓ CRD applied"

# 2. Create platform namespace
echo ""
echo "[2/3] Creating platform namespace..."
kubectl create namespace store-platform 2>/dev/null || echo "  Namespace already exists"

# 3. Deploy platform via Helm with NIP.IO domains
echo ""
echo "[3/3] Installing/upgrading platform Helm chart..."
helm upgrade --install store-platform ./charts/store-platform \
  -n store-platform \
  -f ./charts/store-platform/values-prod.yaml \
  --set operator.domainSuffix="$PUBLIC_IP.nip.io" \
  --set api.domainSuffix="$PUBLIC_IP.nip.io" \
  --set ingress.dashboardHost="dashboard.$PUBLIC_IP.nip.io" \
  --set ingress.apiHost="api.$PUBLIC_IP.nip.io" \
  $R2_SET_ARGS \
  --wait --timeout 180s

echo ""
echo "============================================"
echo "  ✅ Platform Deployed!"
echo "============================================"
echo ""
echo "  Dashboard: https://dashboard.$PUBLIC_IP.nip.io"
echo "  API Docs:  https://api.$PUBLIC_IP.nip.io/docs"
echo "  Metrics:   https://api.$PUBLIC_IP.nip.io/metrics"
echo ""
echo "  Create a test store:"
echo "    curl -X POST https://api.$PUBLIC_IP.nip.io/api/stores \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"name\": \"demo-store\", \"engine\": \"medusa\"}'"
echo ""
echo "  Store URL: https://demo-store.$PUBLIC_IP.nip.io"
echo ""
