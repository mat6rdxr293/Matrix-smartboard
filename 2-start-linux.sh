#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"

find_python() {
  for candidate in python3.13 python3.12 python3.11 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

python_bin="$(find_python || true)"
if [[ -z "$python_bin" ]]; then
  echo "[ERROR] Python 3.11+ was not found." >&2
  echo "Install Python 3.11+, python3-venv and Node.js LTS, then run this script again." >&2
  echo "Debian/Ubuntu: sudo apt install python3 python3-venv python3-pip nodejs npm" >&2
  exit 2
fi

exec "$python_bin" scripts/start_project.py "$@"
