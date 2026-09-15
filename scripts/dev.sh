#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
venv_dir="$project_root/.venv-mac"
venv_python="$venv_dir/bin/python"

cd "$project_root"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required. Install it with: brew install python" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required. Install them with: brew install node" >&2
  exit 1
fi

if [[ ! -x "$venv_python" ]] || ! "$venv_python" -c "import sys" >/dev/null 2>&1; then
  if [[ -e "$venv_dir" ]]; then
    echo "Recreating broken Python environment: $venv_dir"
    rm -rf "$venv_dir"
  fi

  echo "Creating Python environment..."
  python3 -m venv "$venv_dir"
fi

echo "Installing Python dependencies..."
"$venv_python" -m pip install -r backend/requirements.txt

echo "Installing frontend dependencies..."
(
  cd frontend
  npm install
)

backend_pid=""
frontend_pid=""

cleanup() {
  trap - EXIT INT TERM

  if [[ -n "$backend_pid" ]]; then
    kill "$backend_pid" 2>/dev/null || true
  fi
  if [[ -n "$frontend_pid" ]]; then
    kill "$frontend_pid" 2>/dev/null || true
  fi

  wait "$backend_pid" 2>/dev/null || true
  wait "$frontend_pid" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

echo "Starting backend at http://localhost:8000"
(
  cd backend
  exec "$venv_python" -m uvicorn app.main:app --reload --port 8000
) &
backend_pid=$!

echo "Starting frontend at http://localhost:5174"
(
  cd frontend
  exec npm run dev
) &
frontend_pid=$!

while kill -0 "$backend_pid" 2>/dev/null && kill -0 "$frontend_pid" 2>/dev/null; do
  sleep 1
done
