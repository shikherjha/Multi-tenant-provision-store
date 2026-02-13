#!/bin/bash
# Build all Docker images and load them into Kind cluster
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CLUSTER_NAME="${KIND_CLUSTER:-urumi-cluster}"

echo "============================================"
echo "  Building Docker Images"
echo "============================================"

cd "$PROJECT_DIR"

# 1. Build Medusa Store image
echo ""
echo "[1/4] Building medusa-store image..."
docker build -t medusa-store:latest ./docker/medusa/

# 2. Build Storefront image
echo ""
echo "[2/4] Building store-storefront image..."
docker build -t store-storefront:latest ./docker/storefront/

# 3. Build Operator image
echo ""
echo "[3/4] Building store-operator image..."
# Copy charts into operator build context
mkdir -p store-operator/charts
cp -r charts/store-medusa store-operator/charts/
docker build -t store-operator:latest ./store-operator/
rm -rf store-operator/charts

# 4. Build Intent API image
echo ""
echo "[4/4] Building intent-api image..."
docker build -t intent-api:latest ./intent-api/

echo ""
echo "============================================"
echo "  Loading Images into Kind Cluster"
echo "============================================"

for img in medusa-store:latest store-storefront:latest store-operator:latest intent-api:latest; do
  echo "Loading $img..."
  kind load docker-image "$img" --name "$CLUSTER_NAME"
done

echo ""
echo "✅ All images built and loaded into Kind cluster '$CLUSTER_NAME'"
