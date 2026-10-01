#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/mat6rdxr293/Matrix-smartboard.git"
APP_DIR="/opt/matrix-smartboard"
DATA_DIR="/var/lib/matrix-smartboard"
SERVICE_USER="matrix-smartboard"
PORT="${MATRIX_PORT:-8443}"
PUBLIC_BASE_URL="${MATRIX_PUBLIC_BASE_URL:-}"
INSTALL_OLLAMA="${MATRIX_INSTALL_OLLAMA:-1}"
SERVER_NAME="${MATRIX_SERVER_NAME:-}"
SERVER_NAME="$(printf '%s' "$SERVER_NAME" | tr '\r\n\t' '   ')"

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: installer must run as root (use sudo)" >&2
  exit 2
fi

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "ERROR: invalid MATRIX_PORT" >&2
  exit 2
fi


install_macos() {
  echo "[1/7] Checking macOS prerequisites"
  export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  local run_user="${SUDO_USER:-$(stat -f '%Su' /dev/console 2>/dev/null || true)}"
  if [[ -z "$run_user" || "$run_user" == "root" ]]; then
    echo "ERROR: cannot determine the macOS login user" >&2
    exit 3
  fi
  local run_group
  run_group="$(id -gn "$run_user")"
  local run_home
  run_home="$(dscl . -read "/Users/$run_user" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
  [[ -n "$run_home" ]] || run_home="/Users/$run_user"

  local python_bin git_bin curl_bin
  python_bin="$(command -v python3 || true)"
  git_bin="$(command -v git || true)"
  curl_bin="$(command -v curl || true)"
  if [[ -z "$python_bin" || -z "$git_bin" || -z "$curl_bin" ]]; then
    echo "ERROR: macOS setup requires python3, git and curl. Install them with Homebrew first." >&2
    exit 3
  fi

  echo "[2/7] Preparing service directories"
  mkdir -p "$DATA_DIR"
  chown -R "$run_user:$run_group" "$DATA_DIR"

  echo "[3/7] Downloading Matrix Smartboard from GitHub"
  if [[ -d "$APP_DIR/.git" ]]; then
    "$git_bin" -C "$APP_DIR" fetch --depth=1 origin main
    "$git_bin" -C "$APP_DIR" reset --hard origin/main
  else
    rm -rf "$APP_DIR"
    "$git_bin" clone --depth=1 --branch main "$REPO_URL" "$APP_DIR"
  fi

  echo "[4/7] Installing Python backend"
  "$python_bin" -m venv "$APP_DIR/.venv"
  "$APP_DIR/.venv/bin/python" -m pip install --upgrade pip wheel
  "$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/backend/requirements.txt"
  git -C "$APP_DIR" rev-parse HEAD > "$APP_DIR/.matrix-version"

  local ai_base_url="" ocr_base_url=""
  local ai_model="qwen2.5:7b" ocr_model="qwen2.5vl:3b"
  if [[ "$INSTALL_OLLAMA" == "1" ]]; then
    echo "[5/7] Configuring local AI (Ollama)"
    local ollama_bin
    ollama_bin="$(command -v ollama || true)"
    if [[ -z "$ollama_bin" ]]; then
      local brew_bin
      brew_bin="$(command -v brew || true)"
      if [[ -z "$brew_bin" ]]; then
        echo "ERROR: Ollama is not installed and Homebrew is unavailable" >&2
        exit 3
      fi
      sudo -u "$run_user" env HOME="$run_home" "$brew_bin" install ollama
      ollama_bin="$(command -v ollama || true)"
    fi

    if ! "$curl_bin" -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      cat > /Library/LaunchDaemons/ru.matrixhost.ollama.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ru.matrixhost.ollama</string>
  <key>ProgramArguments</key><array><string>$ollama_bin</string><string>serve</string></array>
  <key>UserName</key><string>$run_user</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>$run_home</string><key>OLLAMA_HOST</key><string>127.0.0.1:11434</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/var/tmp/matrix-smartboard-ollama.log</string>
  <key>StandardErrorPath</key><string>/var/tmp/matrix-smartboard-ollama.log</string>
</dict></plist>
PLIST
      chmod 644 /Library/LaunchDaemons/ru.matrixhost.ollama.plist
      launchctl bootout system/ru.matrixhost.ollama >/dev/null 2>&1 || true
      launchctl bootstrap system /Library/LaunchDaemons/ru.matrixhost.ollama.plist
      launchctl enable system/ru.matrixhost.ollama
      launchctl kickstart -k system/ru.matrixhost.ollama
    fi
    for _ in $(seq 1 30); do
      if "$curl_bin" -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then break; fi
      sleep 2
    done
    if ! "$curl_bin" -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      echo "ERROR: Ollama did not become ready" >&2
      exit 4
    fi
    sudo -u "$run_user" env HOME="$run_home" "$ollama_bin" pull "$ai_model"
    sudo -u "$run_user" env HOME="$run_home" "$ollama_bin" pull "$ocr_model"
    ai_base_url="http://127.0.0.1:11434/v1"
    ocr_base_url="http://127.0.0.1:11434/v1"
  else
    echo "[5/7] Local AI installation skipped"
  fi

  cat > "$APP_DIR/backend/.env" <<ENV
OPENAI_API_KEY=
AI_BASE_URL=$ai_base_url
AI_MODEL=$ai_model
OCR_BASE_URL=$ocr_base_url
OCR_MODEL=$ocr_model
AI_TIMEOUT_SECONDS=90
AI_REASONING_EFFORT=medium
AI_TOOLS_ENABLED=true
PUBLIC_BASE_URL=$PUBLIC_BASE_URL
PRACTICE_DB_PATH=$DATA_DIR/practice.db
SCHOOL_SESSION_DAYS=30
SERVER_IDENTITY_DIR=$DATA_DIR/identity
ENV
  local server_name_escaped
  server_name_escaped="$(printf '%s' "$SERVER_NAME" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  printf 'SERVER_NAME="%s"\n' "$server_name_escaped" >> "$APP_DIR/backend/.env"
  chmod 600 "$APP_DIR/backend/.env"
  chown "$run_user:$run_group" "$APP_DIR/backend/.env"
  mkdir -p "$APP_DIR/backend/app/data/media"
  chown -R "$run_user:$run_group" "$APP_DIR/backend/app/data" "$DATA_DIR"

  mkdir -p /usr/local/sbin
  install -m 755 "$APP_DIR/deploy/update-server.sh" /usr/local/sbin/matrix-smartboard-update
  install -m 755 "$APP_DIR/deploy/server-control.sh" /usr/local/sbin/matrix-smartboard-service-control
  cat > /etc/matrix-smartboard-server.conf <<CONF
MATRIX_PORT=$PORT
CONF
  chmod 644 /etc/matrix-smartboard-server.conf
  mkdir -p /etc/sudoers.d
  cat > /etc/sudoers.d/matrix-smartboard <<SUDOERS
$run_user ALL=(root) NOPASSWD: /usr/local/sbin/matrix-smartboard-update
$run_user ALL=(root) NOPASSWD: /usr/local/sbin/matrix-smartboard-service-control restart-ollama
SUDOERS
  chmod 440 /etc/sudoers.d/matrix-smartboard
  visudo -cf /etc/sudoers.d/matrix-smartboard >/dev/null

  echo "[6/7] Configuring launchd"
  cat > /Library/LaunchDaemons/ru.matrixhost.smartboard.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ru.matrixhost.smartboard</string>
  <key>ProgramArguments</key><array>
    <string>$APP_DIR/.venv/bin/python</string><string>-m</string><string>app.run_server</string>
    <string>--host</string><string>0.0.0.0</string><string>--port</string><string>$PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR/backend</string>
  <key>UserName</key><string>$run_user</string>
  <key>EnvironmentVariables</key><dict><key>PYTHONUNBUFFERED</key><string>1</string><key>HOME</key><string>$run_home</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/var/tmp/matrix-smartboard.log</string>
  <key>StandardErrorPath</key><string>/var/tmp/matrix-smartboard.log</string>
</dict></plist>
PLIST
  chmod 644 /Library/LaunchDaemons/ru.matrixhost.smartboard.plist
  launchctl bootout system/ru.matrixhost.smartboard >/dev/null 2>&1 || true
  launchctl bootstrap system /Library/LaunchDaemons/ru.matrixhost.smartboard.plist
  launchctl enable system/ru.matrixhost.smartboard
  launchctl kickstart -k system/ru.matrixhost.smartboard

  local firewall="/usr/libexec/ApplicationFirewall/socketfilterfw"
  if [[ -x "$firewall" ]] && "$firewall" --getglobalstate 2>/dev/null | grep -qi enabled; then
    "$firewall" --add "$APP_DIR/.venv/bin/python" >/dev/null 2>&1 || true
    "$firewall" --unblockapp "$APP_DIR/.venv/bin/python" >/dev/null 2>&1 || true
  fi

  echo "[7/7] Checking server"
  for _ in $(seq 1 30); do
    if "$curl_bin" -kfsS "https://127.0.0.1:$PORT/api/status"; then
      echo
      echo "Matrix Smartboard server is ready"
      exit 0
    fi
    sleep 2
  done
  launchctl print system/ru.matrixhost.smartboard || true
  tail -80 /var/tmp/matrix-smartboard.log 2>/dev/null || true
  echo "ERROR: Matrix Smartboard did not become ready" >&2
  exit 4
}

if [[ "$(uname -s)" == "Darwin" ]]; then
  install_macos
fi
export DEBIAN_FRONTEND=noninteractive

echo "[1/7] Installing system packages"
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y git curl ca-certificates python3 python3-venv python3-pip
else
  echo "ERROR: automatic setup supports macOS and Debian/Ubuntu servers" >&2
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
git -C "$APP_DIR" rev-parse HEAD > "$APP_DIR/.matrix-version"

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
SERVER_NAME_ESCAPED="$(printf '%s' "$SERVER_NAME" | sed 's/\\/\\\\/g; s/"/\\"/g')"
printf 'SERVER_NAME="%s"\n' "$SERVER_NAME_ESCAPED" >> "$APP_DIR/backend/.env"
chmod 600 "$APP_DIR/backend/.env"
chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/backend/.env"

mkdir -p "$APP_DIR/backend/app/data/media"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/backend/app/data" "$DATA_DIR"

mkdir -p /usr/local/sbin
install -m 755 "$APP_DIR/deploy/update-server.sh" /usr/local/sbin/matrix-smartboard-update
install -m 755 "$APP_DIR/deploy/server-control.sh" /usr/local/sbin/matrix-smartboard-service-control
cat > /etc/matrix-smartboard-server.conf <<CONF
MATRIX_PORT=$PORT
CONF
chmod 644 /etc/matrix-smartboard-server.conf
mkdir -p /etc/sudoers.d
cat > /etc/sudoers.d/matrix-smartboard <<SUDOERS
$SERVICE_USER ALL=(root) NOPASSWD: /usr/local/sbin/matrix-smartboard-update
$SERVICE_USER ALL=(root) NOPASSWD: /usr/local/sbin/matrix-smartboard-service-control restart-ollama
SUDOERS
chmod 440 /etc/sudoers.d/matrix-smartboard
visudo -cf /etc/sudoers.d/matrix-smartboard >/dev/null

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
