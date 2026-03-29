# =============================================================================
# MedusaJS v2 Production Image
# 
# Strategy: Scaffold MedusaJS v2 at build time, build, slim runtime.
# Build takes ~5-10 min due to MedusaJS admin compilation.
#
# Provides:
#   - Full MedusaJS v2 Store API (/store/*)
#   - Admin Dashboard (/app)
#   - PostgreSQL integration
#   - System default payment + manual fulfillment providers
#   - Seed data for demo (products, regions, shipping)
# =============================================================================

# Stage 1: Scaffold and build
FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++ git curl bash

WORKDIR /build

# Create a fresh MedusaJS v2 project via the starter template
# create-medusa-app can be flaky in Docker/Alpine, so we clone the starter directly
RUN git clone https://github.com/medusajs/medusa-starter-default /build/tmp-store && \
    mv /build/tmp-store/* /build/ && \
    mv /build/tmp-store/.* /build/ 2>/dev/null || true && \
    rm -rf /build/tmp-store

# Override medusa-config for K8s (env-driven DATABASE_URL, no hardcoded Redis)
COPY medusa-config.ts /build/medusa-config.ts

# Copy seed script
COPY src/ /build/src/

# Install deps (include S3 provider)
RUN if [ -f "yarn.lock" ]; then yarn add @medusajs/file-s3 && yarn install; \
    elif [ -f "pnpm-lock.yaml" ]; then pnpm add @medusajs/file-s3 && pnpm install; \
    else npm install @medusajs/file-s3 --legacy-peer-deps && npm install --legacy-peer-deps; fi

# Build production artifacts (.medusa/server)
ENV NODE_OPTIONS=--max_old_space_size=4096
RUN npx medusa build

# Stage 2: Slim runtime
FROM node:20-alpine

RUN apk add --no-cache tini curl postgresql-client

WORKDIR /server

# Copy the full project (medusa start needs src + config + .medusa/server)
COPY --from=builder /build /server

# Symlink admin build so medusa start can find it from project root
RUN ln -sf /server/.medusa/server/public /server/public

# Copy startup script
COPY start.sh /server/start.sh
RUN chmod +x /server/start.sh

# Ensure node_modules is writable for migrations
# MedusaJS creates migration tracking dirs inside packages at runtime
RUN chmod -R a+rw /server/node_modules/@medusajs/

# Run as root for demo (node:20-alpine defaults to user 'node')
USER root

EXPOSE 9000

HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=8 \
    CMD curl -sf http://localhost:9000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/server/start.sh"]