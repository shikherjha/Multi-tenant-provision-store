#!/bin/bash
# Setup Python virtual environment for local development
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "============================================"
echo "  Setting up Python Virtual Environment"
echo "============================================"

cd "$PROJECT_DIR"

# Create venv
python3 -m venv venv
echo "✓ Virtual environment created"

# Activate and install
source venv/bin/activate
pip install --upgrade pip
pip install -r intent-api/requirements.txt
pip install -r store-operator/requirements.txt
echo ""
echo "✅ Virtual environment ready!"
echo ""
echo "To activate:"
echo "  source venv/bin/activate"
echo ""
echo "To run Intent API:"
echo "  cd intent-api && python main.py"
echo ""
echo "To run Operator:"
echo "  cd store-operator && kopf run operator.py --verbose"
