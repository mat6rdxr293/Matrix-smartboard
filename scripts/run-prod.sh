#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
venv_dir="${MATRIX_VENV_DIR:-$project_root/.venv-mac}"
python_bin="$venv_dir/bin/python"

cd "$project_root"

if [[ ! -x "$python_bin" ]]; then
  python3 -m venv "$venv_dir"
fi

"$python_bin" -m pip install -q -r backend/requirements.txt

cd backend
exec "$python_bin" -m app.run_server --host 0.0.0.0 --port "${MATRIX_PORT:-8443}"
