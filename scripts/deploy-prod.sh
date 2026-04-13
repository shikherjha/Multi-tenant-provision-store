#!/bin/bash
# =============================================================================
# Deploy Platform to Production (k3s + custom domain + R2)
# Run this on your GCP VM after setup-vps.sh
# =============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

DOMAIN_SUFFIX="${DOMAIN_SUFFIX:-stores.storeos.in}"
DASHBOARD_HOST="${DASHBOARD_HOST:-dashboard.storeos.in}"
API_HOST="${API_HOST:-api.storeos.in}"

echo "============================================"
echo "  Deploying Store Platform (Production)"
echo "  Store domains: *.$DOMAIN_SUFFIX"
echo "  Dashboard:     $DASHBOARD_HOST"
echo "  API:           $API_HOST"
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
  R2_SET_ARGS="$R2_SET_ARGS --set r2.publicUrl=${R2_PUBLIC_URL:-https://media.storeos.in}"
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

# 3. Deploy platform via Helm with production domains
echo ""
echo "[3/3] Installing/upgrading platform Helm chart..."
helm upgrade --install store-platform ./charts/store-platform \
  -n store-platform \
  -f ./charts/store-platform/values-prod.yaml \
  --set operator.domainSuffix="$DOMAIN_SUFFIX" \
  --set api.domainSuffix="$DOMAIN_SUFFIX" \
  --set ingress.dashboardHost="$DASHBOARD_HOST" \
  --set ingress.apiHost="$API_HOST" \
  $R2_SET_ARGS \
  --wait --timeout 180s

echo ""
echo "============================================"
echo "  ✅ Platform Deployed!"
echo "============================================"
echo ""
echo "  Dashboard: https://$DASHBOARD_HOST"
echo "  API Docs:  https://$API_HOST/docs"
echo "  Metrics:   https://$API_HOST/metrics"
echo ""
echo "  Create a test store:"
echo "    curl -X POST https://$API_HOST/api/stores \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"name\": \"demo-store\", \"engine\": \"medusa\"}'"
echo ""
echo "  Store URL: https://demo-store.$DOMAIN_SUFFIX"
echo ""
