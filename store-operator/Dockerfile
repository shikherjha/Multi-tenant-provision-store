FROM python:3.12-slim

LABEL maintainer="store-operator"
LABEL description="Kubernetes Operator for multi-tenant store provisioning"

WORKDIR /app

# Install system dependencies (helm CLI + curl for health)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash && \
    apt-get purge -y curl && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy operator code
COPY operator.py .

# Copy Helm charts (bundled into operator image)
COPY charts/ /charts/

# Non-root user for security hardening
RUN groupadd -r operator 2>/dev/null || true && useradd -r -g operator operator 2>/dev/null || true
USER operator

ENTRYPOINT ["kopf", "run", "operator.py", "--verbose", "--all-namespaces"]
