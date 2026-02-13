#!/bin/bash
set -e

echo "Checking prerequisites..."

# Check Go
if ! command -v go &> /dev/null; then
    echo "Go could not be found. Please install Go."
    exit 1
fi
echo "Go version: $(go version)"

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "Docker could not be found. Please install Docker."
    exit 1
fi
echo "Docker version: $(docker --version)"

# Check Helm
if ! command -v helm &> /dev/null; then
    echo "Helm could not be found. Installing Helm..."
    curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
else
    echo "Helm version: $(helm version --short)"
fi

# Check Kubebuilder
if ! command -v kubebuilder &> /dev/null; then
    echo "Kubebuilder could not be found. Installing Kubebuilder..."
    # OS/Arch
    os=$(go env GOOS)
    arch=$(go env GOARCH)
    curl -L -o kubebuilder "https://go.kubebuilder.io/dl/latest/${os}/${arch}"
    chmod +x kubebuilder && sudo mv kubebuilder /usr/local/bin/
else
    echo "Kubebuilder version: $(kubebuilder version)"
fi

# Check Kind
if ! command -v kind &> /dev/null; then
    echo "Kind could not be found. Installing Kind..."
    [ $(uname -m) = x86_64 ] && curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.20.0/kind-linux-amd64
    chmod +x ./kind
    sudo mv ./kind /usr/local/bin/kind
else
    echo "Kind version: $(kind version)"
fi

echo "Creating Kind cluster..."
if ! kind get clusters | grep -q "urumi-cluster"; then
    kind create cluster --name urumi-cluster --config kind-config.yaml
else
    echo "Cluster 'urumi-cluster' already exists."
fi

echo "Installing NGINX Ingress Controller..."
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml

echo "Waiting for Ingress Controller to be ready..."
kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=90s

echo "Setup complete! Cluster 'urumi-cluster' is ready with Ingress support."
