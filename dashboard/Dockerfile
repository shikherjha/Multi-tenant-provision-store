# Stage 1: Build the React dashboard
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production=false

COPY . .
RUN npm run build

# Stage 2: Serve with Nginx
FROM nginx:1.25-alpine

# Remove default Nginx config
RUN rm -rf /etc/nginx/conf.d/*

# Copy built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy custom Nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
    CMD wget -q --spider http://localhost:80/healthz || exit 1
