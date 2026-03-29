#!/bin/bash
# Build all Docker images and load them into Kind cluster
# Supports BACKEND_MODE=lite|full (default: lite for fast iteration)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CLUSTER_NAME="${KIND_CLUSTER:-urumi-cluster}"
BACKEND_MODE="${BACKEND_MODE:-lite}"

echo "============================================"
echo "  Building Docker Images"
echo "  Backend Mode: $BACKEND_MODE"
echo "============================================"

cd "$PROJECT_DIR"

# 1. Build Medusa Store image (lite = custom express, full = real MedusaJS v2)
echo ""
if [ "$BACKEND_MODE" = "full" ]; then
  echo "[1/5] Building medusa-store:full (Real MedusaJS v2 — this takes 5-10 minutes)..."
  docker build -t medusa-store:full ./docker/medusa-full/
  # Also tag as latest for Helm chart compatibility
  docker tag medusa-store:full medusa-store:latest
  echo "  NOTE: Full MedusaJS v2 image built. Requires more memory per store."
else
  echo "[1/5] Building medusa-store:lite (Lightweight MedusaJS-compatible backend)..."
  docker build -t medusa-store:lite "./docker/medusa-mock/"
  docker tag medusa-store:lite medusa-store:latest
fi

# 2. Build Storefront image (lite = static HTML, full = Next.js)
echo ""
echo "[2/5] Building store-storefront image..."
if [ "$BACKEND_MODE" = "full" ]; then
  # Check if Dockerfile exists in storefront, if not use mock or create one
  if [ -f "./docker/storefront/Dockerfile" ]; then
    docker build -t store-storefront:latest ./docker/storefront/
  else
    echo "WARN: No Dockerfile in ./docker/storefront/, falling back to mock"
    docker build -t store-storefront:latest ./docker/storefront-mock/
  fi
else
  docker build -t store-storefront:latest ./docker/storefront-mock/
fi

# 3. Build Operator image
echo ""
echo "[3/5] Building store-operator image..."
mkdir -p store-operator/charts
cp -r charts/store-medusa store-operator/charts/
docker build -t store-operator:latest ./store-operator/
rm -rf store-operator/charts

# 4. Build Intent API image
echo ""
echo "[4/5] Building intent-api image..."
docker build -t intent-api:latest ./intent-api/

# 5. Build Dashboard image
echo ""
echo "[5/5] Building dashboard image..."
docker build -t store-dashboard:latest ./dashboard/

# 5. Load Images into cluster (Optional — only if Kind is present)
if command -v kind >/dev/null 2>&1; then
  echo ""
  echo "============================================"
  echo "  Loading Images into Kind Cluster"
  echo "============================================"
  
  IMAGES="store-storefront:latest store-operator:latest intent-api:latest store-dashboard:latest"
  if [ "$BACKEND_MODE" = "full" ]; then
    IMAGES="medusa-store:full medusa-store:latest $IMAGES"
  else
    IMAGES="medusa-store:lite medusa-store:latest $IMAGES"
  fi

  for img in $IMAGES; do
    echo "Loading $img..."
    kind load docker-image "$img" --name "$CLUSTER_NAME"
  done
else
  echo ""
  echo "WARN: 'kind' command not found. Skipping image load."
  echo "If using K3s, the images built with Docker are already local."
  echo "NOTE: K3s might need 'docker save | k3s ctr images import -' if not using Docker as the runtime."
fi

echo ""
echo "============================================"
echo "  ✅ All images built and loaded"
echo "  Backend: $BACKEND_MODE"
echo "============================================"
echo ""
if [ "$BACKEND_MODE" = "full" ]; then
  echo "  To deploy with full MedusaJS:"
  echo "    helm upgrade --install store-platform ./charts/store-platform \\"
  echo "      -n store-platform -f ./charts/store-platform/values-local.yaml \\"
  echo "      --set operator.medusaImage=medusa-store:full"
  echo ""
  echo "  NOTE: Full MedusaJS stores need ~1GB RAM each and ~2min startup."
  echo "  The lite backend starts in seconds with ~128MB RAM."
fi