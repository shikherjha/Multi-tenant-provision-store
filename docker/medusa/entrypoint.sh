#!/bin/sh
set -e

echo "============================================"
echo "  Medusa Store — Entrypoint"
echo "============================================"

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL at ${DATABASE_URL}..."
MAX_RETRIES=30
RETRY=0
until node -e "
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  c.connect().then(() => { c.end(); process.exit(0); }).catch(() => process.exit(1));
" 2>/dev/null; do
  RETRY=$((RETRY + 1))
  if [ $RETRY -ge $MAX_RETRIES ]; then
    echo "ERROR: PostgreSQL not ready after ${MAX_RETRIES} retries"
    exit 1
  fi
  echo "  Waiting for PostgreSQL... (${RETRY}/${MAX_RETRIES})"
  sleep 2
done
echo "PostgreSQL is ready!"

# Run migrations
echo "Running database migrations..."
npx medusa migrations run || {
  echo "WARNING: Migrations failed (may already be applied)"
}

# Seed data (idempotent: will fail silently if already seeded)
echo "Seeding sample data..."
npx medusa seed -f ./data/seed.json 2>/dev/null || {
  echo "INFO: Seed skipped (data may already exist)"
}

# Create admin user (idempotent)
echo "Ensuring admin user exists..."
npx medusa user -e admin@medusa-store.com -p supersecret 2>/dev/null || {
  echo "INFO: Admin user may already exist"
}

echo "============================================"
echo "  Starting Medusa Server on port 9000"
echo "============================================"
exec npx medusa start
