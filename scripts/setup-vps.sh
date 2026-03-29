#!/bin/bash
# =============================================================================
# VPS Setup Script — GCP VM with k3s + Let's Encrypt TLS
# Run this ON your GCP VM after SSH-ing in
# =============================================================================
set -e

echo "============================================"
echo "  Store Platform — VPS Setup"
echo "============================================"

# --- Step 1: Get public IP ---
PUBLIC_IP=$(curl -s ifconfig.me)
echo ""
echo "[1/6] Detected public IP: $PUBLIC_IP"
echo "  NIP.IO domains:"
echo "    dashboard.$PUBLIC_IP.nip.io"
echo "    api.$PUBLIC_IP.nip.io"
echo "    *.${PUBLIC_IP}.nip.io (per-store)"

# --- Step 2: Install Docker (if not present) ---
echo ""
echo "[2/6] Checking for Docker..."
if command -v docker &> /dev/null; then
  echo "  Docker already installed, skipping..."
else
  echo "  Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER
  echo "  ✓ Docker installed (you may need to RE-LOGIN for group changes to take effect)"
fi

# --- Step 3: Install k3s ---
echo ""
echo "[3/6] Installing k3s..."
if command -v k3s &> /dev/null; then
  echo "  k3s already installed, skipping..."
else
  curl -sfL https://get.k3s.io | sh -
  echo "  Waiting for k3s to be ready..."
  sudo k3s kubectl wait --for=condition=ready node --all --timeout=120s
fi

# Make kubectl usable without sudo
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown $(id -u):$(id -g) ~/.kube/config
export KUBECONFIG=~/.kube/config
echo "export KUBECONFIG=~/.kube/config" >> ~/.bashrc

echo "  k3s ready:"
kubectl get nodes

# --- Step 4: Install Helm ---
echo ""
echo "[4/6] Installing Helm..."
if command -v helm &> /dev/null; then
  echo "  Helm already installed, skipping..."
else
  curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
fi
echo "  Helm version: $(helm version --short)"

# --- Step 5: Install cert-manager (Let's Encrypt TLS) ---
echo ""
echo "[5/6] Installing cert-manager for automatic HTTPS..."
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.17.1/cert-manager.crds.yaml
helm repo add jetstack https://charts.jetstack.io --force-update
helm repo update
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --version v1.17.1 \
  --wait --timeout 120s

echo "  Waiting for cert-manager pods to be ready..."
kubectl wait --for=condition=ready pod -l app.kubernetes.io/instance=cert-manager -n cert-manager --timeout=120s

# Create ClusterIssuer for Let's Encrypt
echo "  Creating Let's Encrypt ClusterIssuer..."
kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@storeos.io
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: traefik
EOF
echo "  ✓ cert-manager installed with Let's Encrypt issuer"

# --- Step 6: Verify Traefik is running ---
echo ""
echo "[6/6] Verifying Traefik ingress controller..."
kubectl get svc -n kube-system traefik 2>/dev/null || echo "  WARN: Traefik not found. k3s should have installed it."

echo ""
echo "============================================"
echo "  ✅ VPS Base Setup Complete"
echo "============================================"
echo ""
echo "  Ports 80 and 443 must be open in GCP firewall."
echo ""
echo "  Next steps:"
echo "    1. Build images:  BACKEND_MODE=full bash scripts/build-images.sh"
echo "    2. Import images: see deploy guide"
echo "    3. Deploy:        bash scripts/deploy-prod.sh"
echo ""
echo "  Dashboard: https://dashboard.$PUBLIC_IP.nip.io"
echo "  API:       https://api.$PUBLIC_IP.nip.io/docs"
echo ""
