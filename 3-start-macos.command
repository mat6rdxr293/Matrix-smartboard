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
  echo "Install Python and Node.js first:" >&2
  echo "  brew install python node" >&2
  echo
  read -r -p "Press Enter to close..."
  exit 2
fi

set +e
"$python_bin" scripts/start_project.py "$@"
code=$?
set -e
if [[ $code -ne 0 ]]; then
  echo
  read -r -p "Launcher failed. Press Enter to close..."
fi
exit "$code"
