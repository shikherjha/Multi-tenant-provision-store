FROM nginx:1.25-alpine

# Security: remove default configs
RUN rm -rf /etc/nginx/conf.d/*

# Copy storefront files
COPY index.html /usr/share/nginx/html/

# Copy nginx template config (uses envsubst for backend URL)
COPY nginx.conf /etc/nginx/templates/default.conf.template

# Non-root user (nginx alpine already runs worker as nginx user)
# Expose storefront port
EXPOSE 8000

# nginx uses envsubst to replace ${MEDUSA_BACKEND_URL} at startup
ENV MEDUSA_BACKEND_URL=medusa-backend:9000

HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
    CMD wget -q --spider http://localhost:8000/healthz || exit 1
