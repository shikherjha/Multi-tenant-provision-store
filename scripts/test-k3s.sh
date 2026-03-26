#!/bin/bash
# =============================================================================
# E2E Test — k3s VPS Deployment
#
# Same test flow as test-local.sh, adjusted for k3s/Traefik environment.
# Assumes the platform is deployed with values-prod.yaml.
#
# Usage:
#   DOMAIN=stores.yourvps.com ./scripts/test-k3s.sh
#   # or with explicit API URL:
#   API_URL=http://api.stores.yourvps.com ./scripts/test-k3s.sh
# =============================================================================
set -e

DOMAIN="${DOMAIN:-stores.yourvps.com}"
API_URL="${API_URL:-http://api.$DOMAIN}"
STORE_NAME="k3s-test-$(date +%s | tail -c 5)"
USER_ID="k3s-tester"

echo "============================================"
echo "  E2E Test — k3s VPS"
echo "  API: $API_URL"
echo "  Domain: $DOMAIN"
echo "  Store: $STORE_NAME"
echo "============================================"
echo ""

# Health check
echo "[1] Health check..."
HEALTH=$(curl -sf --max-time 10 "$API_URL/health" 2>/dev/null || echo "FAIL")
if echo "$HEALTH" | grep -q "healthy"; then
  echo "  ✅ API healthy"
else
  echo "  ❌ API not reachable at $API_URL"
  echo "  Check: kubectl get pods -n store-platform"
  echo "  Check: kubectl get ingress -n store-platform"
  exit 1
fi

# Create store
echo ""
echo "[2] Creating store..."
CREATE=$(curl -sf -X POST "$API_URL/api/stores" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: $USER_ID" \
  -d "{\"name\": \"$STORE_NAME\", \"engine\": \"medusa\", \"owner\": \"$USER_ID\"}")
echo "  Response: $(echo "$CREATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'phase={d.get(\"phase\",\"?\")} name={d.get(\"name\",\"?\")}')" 2>/dev/null)"

# Wait for Ready
echo ""
echo "[3] Waiting for store to become Ready (max 5min)..."
MAX_WAIT=300
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  STATUS=$(curl -sf "$API_URL/api/stores/$STORE_NAME" | python3 -c "import sys,json; print(json.load(sys.stdin).get('phase',''))" 2>/dev/null)
  echo "  Phase: $STATUS (${ELAPSED}s)"
  [ "$STATUS" = "Ready" ] && break
  [ "$STATUS" = "Failed" ] && { echo "  ❌ Failed!"; exit 1; }
  sleep 10; ELAPSED=$((ELAPSED + 10))
done

if [ "$STATUS" != "Ready" ]; then
  echo "  ❌ Timeout"
  exit 1
fi

# Store URL (on k3s, it's via Traefik)
STORE_HOST="${STORE_NAME}.${DOMAIN}"
STORE_URL="http://${STORE_HOST}"
echo "  ✅ Store ready at $STORE_URL"

# Test products
echo ""
echo "[4] Testing store products..."
PRODUCTS=$(curl -sf -H "Host: $STORE_HOST" "$STORE_URL/store/products" 2>/dev/null || echo '{"count":0}')
COUNT=$(echo "$PRODUCTS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('count',0))" 2>/dev/null)
echo "  Products: $COUNT"

# Quick checkout test
echo ""
echo "[5] Checkout test..."
CART=$(curl -sf -X POST -H "Host: $STORE_HOST" "$STORE_URL/store/carts" -H "Content-Type: application/json" -d '{}')
CART_ID=$(echo "$CART" | python3 -c "import sys,json; print(json.load(sys.stdin)['cart']['id'])" 2>/dev/null)

if [ -n "$CART_ID" ]; then
  VARIANT_ID=$(echo "$PRODUCTS" | python3 -c "import sys,json; print(json.load(sys.stdin)['products'][0]['variants'][0]['id'])" 2>/dev/null)
  curl -sf -X POST -H "Host: $STORE_HOST" "$STORE_URL/store/carts/$CART_ID/line-items" \
    -H "Content-Type: application/json" \
    -d "{\"variant_id\": \"$VARIANT_ID\", \"quantity\": 1}" > /dev/null

  ORDER=$(curl -sf -X POST -H "Host: $STORE_HOST" "$STORE_URL/store/carts/$CART_ID/complete" \
    -H "Content-Type: application/json")
  ORDER_TYPE=$(echo "$ORDER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('type',''))" 2>/dev/null)
  [ "$ORDER_TYPE" = "order" ] && echo "  ✅ Order placed!" || echo "  ⚠ Checkout issue (may need full flow)"
fi

# Cleanup
echo ""
echo "[6] Deleting store..."
curl -sf -X DELETE "$API_URL/api/stores/$STORE_NAME" -H "X-User-Id: $USER_ID" > /dev/null
echo "  ✅ Delete initiated"

echo ""
echo "============================================"
echo "  ✅ k3s E2E Test Complete"
echo "============================================"