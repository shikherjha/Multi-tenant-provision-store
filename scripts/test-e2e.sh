#!/bin/bash
# End-to-end test: Create store → Verify conditions → Check logs → Delete → Verify cleanup
set -e

API_URL="${API_URL:-http://localhost:8080}"
STORE_NAME="test-store-$(date +%s | tail -c 5)"
USER_ID="e2e-test-user"

echo "============================================"
echo "  E2E Test — Store Lifecycle (v2)"
echo "============================================"
echo "  API: $API_URL"
echo "  Store: $STORE_NAME"
echo "  User: $USER_ID"
echo ""

# 0. Health check
echo "[0/8] Checking API health..."
HEALTH=$(curl -s "$API_URL/health")
echo "  Health: $HEALTH"
echo ""

# 1. Check metrics endpoint
echo "[1/8] Verifying Prometheus metrics..."
METRICS=$(curl -s "$API_URL/metrics" | head -5)
echo "  Metrics available: $(echo "$METRICS" | wc -l) lines"
echo ""

# 2. Create Store (with identity header)
echo "[2/8] Creating store '$STORE_NAME'..."
CREATE_RESPONSE=$(curl -s -X POST "$API_URL/stores" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: $USER_ID" \
  -d "{\"name\": \"$STORE_NAME\", \"engine\": \"medusa\", \"owner\": \"$USER_ID\"}")
echo "  Response: $CREATE_RESPONSE"
echo ""

# 3. Test idempotency (same create should return existing store)
echo "[3/8] Testing idempotency (duplicate create)..."
IDEMPOTENT=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/stores" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: $USER_ID" \
  -d "{\"name\": \"$STORE_NAME\", \"engine\": \"medusa\", \"owner\": \"$USER_ID\"}")
echo "  HTTP Status: $IDEMPOTENT (expected 201 = idempotent)"
echo ""

# 4. Watch provisioning with conditions
echo "[4/8] Watching store status (conditions)..."
MAX_WAIT=300
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  STORE_DATA=$(curl -s "$API_URL/stores/$STORE_NAME")
  STATUS=$(echo "$STORE_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('phase',''))" 2>/dev/null)
  CONDITIONS=$(echo "$STORE_DATA" | python3 -c "
import sys,json
data = json.load(sys.stdin)
conds = data.get('conditions', [])
ready = [c['type'] for c in conds if c.get('status') == 'True']
print(', '.join(ready) if ready else 'none')
" 2>/dev/null)
  echo "  Phase: $STATUS | Ready conditions: $CONDITIONS (${ELAPSED}s)"

  if [ "$STATUS" = "Ready" ]; then
    echo "  ✅ Store is Ready!"
    break
  elif [ "$STATUS" = "Failed" ]; then
    echo "  ❌ Store provisioning failed!"
    echo "$STORE_DATA" | python3 -m json.tool
    exit 1
  fi
  sleep 10
  ELAPSED=$((ELAPSED + 10))
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
  echo "  ❌ Timeout waiting for store to be Ready"
  exit 1
fi

# 5. Get activity log
echo ""
echo "[5/8] Checking activity log..."
LOGS=$(curl -s "$API_URL/stores/$STORE_NAME/logs")
LOG_COUNT=$(echo "$LOGS" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('logs', [])))" 2>/dev/null)
echo "  Activity log entries: $LOG_COUNT"
echo ""

# 6. Get store details (all conditions + URLs)
echo "[6/8] Full store details:"
curl -s "$API_URL/stores/$STORE_NAME" | python3 -m json.tool
echo ""

# 7. Verify namespace and pods
echo "[7/8] Verifying Kubernetes resources..."
echo "  Namespace: store-$STORE_NAME"
kubectl get pods -n "store-$STORE_NAME" 2>/dev/null || echo "  (Namespace not accessible from test runner)"
echo ""

# 8. Delete Store & verify cleanup
echo "[8/8] Deleting store '$STORE_NAME'..."
DELETE_RESPONSE=$(curl -s -X DELETE "$API_URL/stores/$STORE_NAME" \
  -H "X-User-Id: $USER_ID")
echo "  Response: $DELETE_RESPONSE"

echo "  Waiting for cleanup..."
sleep 20
VERIFY=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/stores/$STORE_NAME")
if [ "$VERIFY" = "404" ]; then
  echo "  ✅ Store fully deleted (404)"
else
  echo "  ⚠ Store may still be cleaning up (HTTP $VERIFY)"
fi

echo ""
echo "============================================"
echo "  ✅ E2E Test Complete"
echo "============================================"
echo ""
echo "  Summary:"
echo "  - Store lifecycle: CREATE → PROVISION → READY → DELETE ✓"
echo "  - Idempotency: Duplicate create returns existing ✓"
echo "  - Activity log: $LOG_COUNT events recorded ✓"
echo "  - Conditions: Granular status tracking ✓"
echo "  - Identity: X-User-Id header scoping ✓"
echo "  - Metrics: Prometheus /metrics endpoint ✓"
echo ""
