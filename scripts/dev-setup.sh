#!/bin/bash
# Setup and run everything for local development
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "============================================"
echo "  Store Platform — Local Dev Setup"
echo "============================================"

# 1. Apply CRD to cluster
echo ""
echo "[1/4] Applying Store CRD..."
kubectl apply -f store-operator/crd.yaml
echo "  ✓ CRD applied"

# 2. Setup venv if not exists
if [ ! -d "venv" ]; then
  echo ""
  echo "[2/4] Setting up Python venv..."
  python3 -m venv venv
  source venv/bin/activate
  pip install --upgrade pip -q
  pip install -r intent-api/requirements.txt -r store-operator/requirements.txt -q
  echo "  ✓ Venv created and dependencies installed"
else
  source venv/bin/activate
  echo "[2/4] Venv already exists ✓"
fi

# 3. Install dashboard deps if needed
if [ ! -d "dashboard/node_modules" ]; then
  echo ""
  echo "[3/4] Installing dashboard dependencies..."
  cd dashboard && npm install && cd ..
  echo "  ✓ Dashboard dependencies installed"
else
  echo "[3/4] Dashboard dependencies already installed ✓"
fi

echo ""
echo "[4/4] Starting services..."
echo ""
echo "============================================"
echo "  Run these in SEPARATE terminals:"
echo "============================================"
echo ""
echo "  Terminal 1 (Operator):"
echo "    source venv/bin/activate"
echo "    cd store-operator && kopf run operator.py --verbose"
echo ""
echo "  Terminal 2 (API):"
echo "    source venv/bin/activate"
echo "    cd intent-api && python main.py"
echo ""
echo "  Terminal 3 (Dashboard):"
echo "    cd dashboard && npm run dev"
echo ""
echo "  Dashboard: http://localhost:3000"
echo "  API Docs:  http://localhost:8080/docs"
echo ""
