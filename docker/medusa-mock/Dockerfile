FROM node:20-alpine

WORKDIR /app

# Copy package files and install
COPY package.json ./
RUN npm install --production

# Copy application code and data
COPY server.js ./
COPY data/ ./data/

# Security: create non-root user
RUN addgroup -S medusa && adduser -S medusa -G medusa
RUN chown -R medusa:medusa /app
USER medusa

EXPOSE 9000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://localhost:9000/health || exit 1

CMD ["node", "server.js"]
