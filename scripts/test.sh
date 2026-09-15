#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
venv_dir="$project_root/.venv-mac"
venv_python="$venv_dir/bin/python"

cd "$project_root"

if [[ ! -x "$venv_python" ]]; then
  python3 -m venv "$venv_dir"
fi

"$venv_python" -m pip install -r backend/requirements-dev.txt
"$venv_python" -m pytest backend/tests -q

cd frontend
npm install
npm test -- --run
npm run build
