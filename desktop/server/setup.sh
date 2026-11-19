#!/usr/bin/env bash
# Jester's brain on a server: Ubuntu 24.04 on an Oracle Cloud Always Free Ampere A1 (arm64), or any Ubuntu 24.04.
# Run as the normal user (ubuntu), not root: it asks for sudo when it needs it. Safe to run again.
#
#   curl -fsSL https://raw.githubusercontent.com/KrishSChavan/jester/main/desktop/server/setup.sh | bash
#
# What it does: installs Node, what Electron needs to run with no screen (xvfb), Ollama with the two small models
# the server uses, Tailscale and Syncthing; clones Jester; downloads his speech and voice models; and runs him as a
# service that starts with the server. It opens no port to the internet: Tailscale is the only way in.
set -euo pipefail

BRANCH="${JESTER_BRANCH:-main}"
HOME_DIR="$HOME"
REPO="$HOME_DIR/jester"
VAULT="${JESTER_VAULT:-$HOME_DIR/vault}"
ENV_FILE="$HOME_DIR/jester.env"

say() { printf '\n\033[1;35m== %s\033[0m\n' "$*"; }

if [ "$(id -u)" = 0 ]; then
  echo "Run this as your normal user (ubuntu), not root." >&2
  exit 1
fi

# A new server updates itself for its first minutes after boot, holding apt's lock: wait for that, not fail.
apt_wait() {
  command -v cloud-init >/dev/null && sudo cloud-init status --wait >/dev/null 2>&1 || true
  while sudo fuser /var/lib/apt/lists/lock /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do
    echo "Waiting for the system's own updates to finish…"
    sleep 10
  done
}
apt() { apt_wait; sudo apt-get -o DPkg::Lock::Timeout=600 "$@"; }

say "System packages"
apt update -y
apt install -y git curl ca-certificates bzip2 xvfb xauth python3-venv \
  libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libgtk-3-0t64 libgbm1 libasound2t64 \
  libxss1 libxshmfence1 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 libcairo2

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  say "Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  apt install -y nodejs
fi

say "Jester"
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" fetch origin "$BRANCH"
  git -C "$REPO" checkout "$BRANCH"
  git -C "$REPO" pull --ff-only origin "$BRANCH"
else
  git clone --branch "$BRANCH" https://github.com/KrishSChavan/jester.git "$REPO"
fi
cd "$REPO/desktop"
npm ci
# Electron's own download is a postinstall step, which npm can leave undone: done here if it was.
[ -x node_modules/electron/dist/electron ] || node node_modules/electron/install.js
# Electron's sandbox helper must be root's and setuid on Ubuntu 24.04, which otherwise refuses its sandbox.
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
# His ears (VAD, Parakeet), knowing your voice, and his own voice (Kokoro): about 700 MB.
npm run models

say "Ollama (memory search, and a small fallback model)"
if ! command -v ollama >/dev/null; then
  curl -fsSL https://ollama.com/install.sh | sh
fi
sudo systemctl enable --now ollama
# Wait for it to answer before pulling.
for _ in $(seq 1 30); do curl -fs http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 1; done
ollama pull nomic-embed-text
ollama pull qwen3.5:2b

say "Syncthing (your Obsidian vault, kept the same as your Mac's)"
apt install -y syncthing
sudo systemctl enable --now "syncthing@$USER"
mkdir -p "$VAULT"

say "Tailscale (only your own devices can reach him)"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if ! tailscale status >/dev/null 2>&1; then
  echo "Sign this server in to your tailnet: open the link Tailscale prints."
  sudo tailscale up
fi

say "Settings ($ENV_FILE)"
if [ ! -f "$ENV_FILE" ]; then
  cat >"$ENV_FILE" <<EOF
# Jester's server settings (desktop/server/README.md). Restart after a change: sudo systemctl restart jester
JESTER_SERVER=1
JESTER_LOG=1
JESTER_WEB_PORT=8770
JESTER_VAULT=$VAULT
# Google's client file for Gmail, copied here from your Mac (README: Email):
# JESTER_GOOGLE_CLIENT=$HOME_DIR/google-client.json
EOF
  chmod 600 "$ENV_FILE"
fi

say "Jester as a service"
sudo tee /etc/systemd/system/jester.service >/dev/null <<EOF
[Unit]
Description=Jester (his brain, and his website)
After=network-online.target ollama.service
Wants=network-online.target ollama.service

[Service]
User=$USER
WorkingDirectory=$REPO/desktop
EnvironmentFile=$ENV_FILE
# A screen nobody sees: Electron wants one even with no window.
ExecStart=/usr/bin/xvfb-run -a -s "-screen 0 1280x800x24" $REPO/desktop/node_modules/electron/dist/electron $REPO/desktop
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable jester
sudo systemctl restart jester

# His website, over HTTPS, on your tailnet only.
sudo tailscale serve --bg 8770

say "Waiting for him to start"
KEY_FILE="$HOME_DIR/.config/Jester/web-key"
for _ in $(seq 1 60); do [ -s "$KEY_FILE" ] && break; sleep 1; done
HOST="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
if [ -s "$KEY_FILE" ]; then
  echo
  echo "Jester is running. His link, for your Mac's Settings › Jester in the cloud and each browser (once):"
  echo
  echo "    https://$HOST/?key=$(cat "$KEY_FILE")"
  echo
  echo "Keep it private: it's the key to him. Next: README.md, from 'Your vault'."
else
  echo "He hasn't started yet. See what's wrong with: journalctl -u jester -n 50"
fi
