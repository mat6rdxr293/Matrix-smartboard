#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/matrix-smartboard"
CONF_FILE="/etc/matrix-smartboard-server.conf"
PORT="8443"
if [[ -f "$CONF_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONF_FILE"
fi
PORT="${MATRIX_PORT:-$PORT}"
SYSTEM="$(uname -s)"
LOG_FILE="/var/lib/matrix-smartboard/update.log"
if [[ "$SYSTEM" == "Darwin" ]]; then
  LOG_FILE="/var/tmp/matrix-smartboard-update.log"
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: updater must run as root" >&2
  exit 2
fi

if [[ "${1:-}" != "--worker" ]]; then
  if [[ "$SYSTEM" == "Linux" ]] && command -v systemd-run >/dev/null 2>&1; then
    systemd-run --quiet --collect --unit=matrix-smartboard-update "$0" --worker
  else
    nohup "$0" --worker >>"$LOG_FILE" 2>&1 </dev/null &
  fi
  exit 0
fi

mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"
chmod 644 "$LOG_FILE"
exec >>"$LOG_FILE" 2>&1

echo "[$(date -Is 2>/dev/null || date)] Matrix Smartboard update started"

if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "ERROR: $APP_DIR is not a git checkout"
  exit 3
fi

OLD_COMMIT="$(git -C "$APP_DIR" rev-parse HEAD)"
git -C "$APP_DIR" fetch origin main --depth=20
NEW_COMMIT="$(git -C "$APP_DIR" rev-parse origin/main)"

if [[ "$OLD_COMMIT" == "$NEW_COMMIT" ]]; then
  echo "Already up to date: $OLD_COMMIT"
  printf '%s\n' "$OLD_COMMIT" > "$APP_DIR/.matrix-version"
  exit 0
fi

restart_backend() {
  if [[ "$SYSTEM" == "Darwin" ]]; then
    launchctl kickstart -k system/ru.matrixhost.smartboard
  else
    systemctl restart matrix-smartboard
  fi
}

wait_health() {
  for _ in $(seq 1 30); do
    if curl -kfsS "https://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

apply_commit() {
  local commit="$1"
  git -C "$APP_DIR" reset --hard "$commit"
  "$APP_DIR/.venv/bin/python" -m pip install -q -r "$APP_DIR/backend/requirements.txt"
  install -m 755 "$APP_DIR/deploy/update-server.sh" /usr/local/sbin/matrix-smartboard-update
  install -m 755 "$APP_DIR/deploy/server-control.sh" /usr/local/sbin/matrix-smartboard-service-control
  printf '%s\n' "$commit" > "$APP_DIR/.matrix-version"
}

echo "Updating $OLD_COMMIT -> $NEW_COMMIT"
apply_commit "$NEW_COMMIT"
restart_backend

if wait_health; then
  echo "Update successful: $NEW_COMMIT"
  exit 0
fi

echo "Health check failed. Rolling back to $OLD_COMMIT"
apply_commit "$OLD_COMMIT"
restart_backend
if wait_health; then
  echo "Rollback successful: $OLD_COMMIT"
  exit 4
fi

echo "ERROR: rollback did not restore server health"
exit 5
