#!/bin/sh
set -e

echo "============================================"
echo "  MedusaJS v2 — Production Startup"
echo "============================================"

# Parse DATABASE_URL for pg_isready
# Format: postgres://user:pass@host:port/dbname
DB_HOST=$(echo "$DATABASE_URL" | sed -E 's|.*@([^:]+):([0-9]+)/.*|\1|')
DB_PORT=$(echo "$DATABASE_URL" | sed -E 's|.*@([^:]+):([0-9]+)/.*|\2|')
DB_USER=$(echo "$DATABASE_URL" | sed -E 's|.*://([^:]+):.*|\1|')

echo "Waiting for PostgreSQL at ${DB_HOST}:${DB_PORT}..."
MAX_RETRIES=30
RETRY=0
until pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -q 2>/dev/null; do
  RETRY=$((RETRY + 1))
  if [ $RETRY -ge $MAX_RETRIES ]; then
    echo "ERROR: PostgreSQL not ready after ${MAX_RETRIES} retries"
    exit 1
  fi
  echo "  Waiting... (${RETRY}/${MAX_RETRIES})"
  sleep 2
done
echo "PostgreSQL is ready!"

# Run database migrations (must succeed for server to start)
echo "Running database migrations..."
MIGRATE_RETRIES=3
MIGRATE_ATTEMPT=0
MIGRATE_SUCCESS=false
while [ "$MIGRATE_ATTEMPT" -lt "$MIGRATE_RETRIES" ]; do
  MIGRATE_ATTEMPT=$((MIGRATE_ATTEMPT + 1))
  echo "  Migration attempt ${MIGRATE_ATTEMPT}/${MIGRATE_RETRIES}..."
  if npx medusa db:migrate 2>&1; then
    echo "  Migrations completed successfully!"
    MIGRATE_SUCCESS=true
    break
  else
    echo "  Migration attempt ${MIGRATE_ATTEMPT} failed, retrying in 5s..."
    sleep 5
  fi
done

if [ "$MIGRATE_SUCCESS" = "false" ]; then
  echo "ERROR: Database migrations failed after ${MIGRATE_RETRIES} attempts"
  exit 1
fi

# Seed demo data (idempotent — fails gracefully if already seeded)
echo "Seeding demo data..."
npx medusa exec ./src/scripts/seed.ts 2>&1 || echo "INFO: Seed skipped (data may already exist)"

# Set publishable API key token to match storefront's baked-in value
echo "Setting publishable API key token..."
psql "$DATABASE_URL" -c "UPDATE api_key SET token='pk_dummy' WHERE type='publishable' AND token != 'pk_dummy';" 2>/dev/null || echo "INFO: Could not update publishable key token"

# Create admin user (idempotent)
echo "Creating admin user..."
npx medusa user -e admin@medusa-store.com -p supersecret 2>&1 || echo "INFO: Admin user may already exist"

echo "============================================"
echo "  Starting MedusaJS Server on port 9000"
echo "============================================"

# Start in production mode
exec npx medusa start