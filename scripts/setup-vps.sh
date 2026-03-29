#!/bin/bash
# =============================================================================
# VPS Setup Script — GCP VM with k3s + Cloudflare Tunnel
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

# --- Step 5: Install cloudflared ---
echo ""
echo "[5/6] Installing cloudflared..."
if command -v cloudflared &> /dev/null; then
  echo "  cloudflared already installed, skipping..."
else
  wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x cloudflared-linux-amd64
  sudo mv cloudflared-linux-amd64 /usr/local/bin/cloudflared
fi
echo "  cloudflared version: $(cloudflared --version)"

# --- Step 6: Verify Traefik is running ---
echo ""
echo "[6/6] Verifying Traefik ingress controller..."
kubectl get svc -n kube-system traefik 2>/dev/null || echo "  WARN: Traefik not found. k3s should have installed it."

echo ""
echo "============================================"
echo "  ✅ VPS Base Setup Complete"
echo "============================================"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Create Cloudflare Tunnel:"
echo "     cloudflared tunnel login"
echo "     cloudflared tunnel create store-platform"
echo "     cloudflared tunnel list  # note the tunnel ID"
echo ""
echo "  2. Configure tunnel (replace TUNNEL_ID):"
echo "     sudo mkdir -p /etc/cloudflared"
echo "     cat <<EOF | sudo tee /etc/cloudflared/config.yml"
echo "tunnel: store-platform"
echo "credentials-file: /root/.cloudflared/<TUNNEL_ID>.json"
echo ""
echo "ingress:"
echo "  - hostname: \"dashboard.$PUBLIC_IP.nip.io\""
echo "    service: http://localhost:80"
echo "  - hostname: \"api.$PUBLIC_IP.nip.io\""
echo "    service: http://localhost:80"
echo "  - hostname: \"*.$PUBLIC_IP.nip.io\""
echo "    service: http://localhost:80"
echo "  - service: http_status:404"
echo "EOF"
echo ""
echo "  3. Start tunnel as systemd service:"
echo "     sudo cloudflared service install"
echo "     sudo systemctl enable cloudflared"
echo "     sudo systemctl start cloudflared"
echo ""
echo "  4. Deploy the platform:"
echo "     ./scripts/deploy-prod.sh"
echo ""
