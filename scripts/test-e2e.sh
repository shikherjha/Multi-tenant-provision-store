#!/bin/bash
# End-to-end test: Create store → Verify → Delete → Verify cleanup
set -e

API_URL="${API_URL:-http://localhost:8080}"
STORE_NAME="test-store-$(date +%s | tail -c 5)"

echo "============================================"
echo "  E2E Test — Store Lifecycle"
echo "============================================"
echo "  API: $API_URL"
echo "  Store: $STORE_NAME"
echo ""

# 1. Create Store
echo "[1/5] Creating store '$STORE_NAME'..."
CREATE_RESPONSE=$(curl -s -X POST "$API_URL/api/stores" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"$STORE_NAME\", \"engine\": \"medusa\", \"owner\": \"e2e-test\"}")
echo "  Response: $CREATE_RESPONSE"
echo ""

# 2. Watch status
echo "[2/5] Watching store status..."
MAX_WAIT=300
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  STATUS=$(curl -s "$API_URL/api/stores/$STORE_NAME" | python3 -c "import sys,json; print(json.load(sys.stdin).get('phase',''))" 2>/dev/null)
  echo "  Phase: $STATUS (${ELAPSED}s)"
  if [ "$STATUS" = "Ready" ]; then
    echo "  ✅ Store is Ready!"
    break
  elif [ "$STATUS" = "Failed" ]; then
    echo "  ❌ Store provisioning failed!"
    # Show details
    curl -s "$API_URL/api/stores/$STORE_NAME" | python3 -m json.tool
    exit 1
  fi
  sleep 10
  ELAPSED=$((ELAPSED + 10))
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
  echo "  ❌ Timeout waiting for store to be Ready"
  exit 1
fi

# 3. Get store details
echo ""
echo "[3/5] Store details:"
curl -s "$API_URL/api/stores/$STORE_NAME" | python3 -m json.tool
echo ""

# 4. Verify namespace and pods
echo "[4/5] Verifying Kubernetes resources..."
echo "  Namespace: store-$STORE_NAME"
kubectl get pods -n "store-$STORE_NAME" 2>/dev/null || echo "  (Namespace not accessible from test runner)"
echo ""

# 5. Delete Store
echo "[5/5] Deleting store '$STORE_NAME'..."
DELETE_RESPONSE=$(curl -s -X DELETE "$API_URL/api/stores/$STORE_NAME")
echo "  Response: $DELETE_RESPONSE"

# Wait for cleanup
echo "  Waiting for cleanup..."
sleep 15
VERIFY=$(curl -s "$API_URL/api/stores/$STORE_NAME" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('detail','exists'))" 2>/dev/null)
if [ "$VERIFY" = "exists" ] || [ -z "$VERIFY" ]; then
  echo "  ⚠ Store may still be cleaning up"
else
  echo "  ✅ Store deleted: $VERIFY"
fi

echo ""
echo "============================================"
echo "  ✅ E2E Test Complete"
echo "============================================"
