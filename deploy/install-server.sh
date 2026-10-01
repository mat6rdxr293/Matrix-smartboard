#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/mat6rdxr293/Matrix-smartboard.git"
APP_DIR="/opt/matrix-smartboard"
DATA_DIR="/var/lib/matrix-smartboard"
SERVICE_USER="matrix-smartboard"
PORT="${MATRIX_PORT:-8443}"
PUBLIC_BASE_URL="${MATRIX_PUBLIC_BASE_URL:-}"
INSTALL_OLLAMA="${MATRIX_INSTALL_OLLAMA:-1}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: installer must run as root (use sudo)" >&2
  exit 2
fi

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "ERROR: invalid MATRIX_PORT" >&2
  exit 2
fi

export DEBIAN_FRONTEND=noninteractive

echo "[1/7] Installing system packages"
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y git curl ca-certificates python3 python3-venv python3-pip
else
  echo "ERROR: automatic setup currently supports Debian/Ubuntu servers" >&2
  exit 3
fi

echo "[2/7] Creating service account"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
mkdir -p "$DATA_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

echo "[3/7] Downloading Matrix Smartboard from GitHub"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --depth=1 origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  rm -rf "$APP_DIR"
  git clone --depth=1 --branch main "$REPO_URL" "$APP_DIR"
fi

echo "[4/7] Installing Python backend"
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/python" -m pip install --upgrade pip wheel
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/backend/requirements.txt"

AI_BASE_URL=""
OCR_BASE_URL=""
AI_MODEL="qwen2.5:7b"
OCR_MODEL="qwen2.5vl:3b"

if [[ "$INSTALL_OLLAMA" == "1" ]]; then
  echo "[5/7] Installing local AI (Ollama)"
  if ! command -v ollama >/dev/null 2>&1; then
    curl -fsSL https://ollama.com/install.sh | sh
  fi
  systemctl enable --now ollama || true
  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then break; fi
    sleep 2
  done
  ollama pull "$AI_MODEL"
  ollama pull "$OCR_MODEL"
  AI_BASE_URL="http://127.0.0.1:11434/v1"
  OCR_BASE_URL="http://127.0.0.1:11434/v1"
else
  echo "[5/7] Local AI installation skipped"
fi

cat > "$APP_DIR/backend/.env" <<ENV
OPENAI_API_KEY=
AI_BASE_URL=$AI_BASE_URL
AI_MODEL=$AI_MODEL
OCR_BASE_URL=$OCR_BASE_URL
OCR_MODEL=$OCR_MODEL
AI_TIMEOUT_SECONDS=90
AI_REASONING_EFFORT=medium
AI_TOOLS_ENABLED=true
PUBLIC_BASE_URL=$PUBLIC_BASE_URL
PRACTICE_DB_PATH=$DATA_DIR/practice.db
SCHOOL_SESSION_DAYS=30
SERVER_IDENTITY_DIR=$DATA_DIR/identity
ENV
chmod 640 "$APP_DIR/backend/.env"
chown root:"$SERVICE_USER" "$APP_DIR/backend/.env"

mkdir -p "$APP_DIR/backend/app/data/media"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/backend/app/data" "$DATA_DIR"

echo "[6/7] Configuring systemd"
cat > /etc/systemd/system/matrix-smartboard.service <<UNIT
[Unit]
Description=Matrix Smartboard backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR/backend
Environment=PYTHONUNBUFFERED=1
ExecStart=$APP_DIR/.venv/bin/python -m app.run_server --host 0.0.0.0 --port $PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now matrix-smartboard

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow from any to any port "$PORT" proto tcp >/dev/null || true
  ufw allow from 224.0.0.0/4 to any port 5353 proto udp >/dev/null || true
fi

echo "[7/7] Checking server"
for _ in $(seq 1 30); do
  if curl -kfsS "https://127.0.0.1:$PORT/api/status"; then
    echo
    echo "Matrix Smartboard server is ready"
    exit 0
  fi
  sleep 2
done

systemctl --no-pager --full status matrix-smartboard || true
echo "ERROR: Matrix Smartboard did not become ready" >&2
exit 4
