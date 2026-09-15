#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script_path="$project_root/scripts/dev.sh"

if [[ ! -f "$script_path" ]]; then
  echo "Missing scripts/dev.sh" >&2
  exit 1
fi

if [[ ! -x "$script_path" ]]; then
  echo "scripts/dev.sh is not executable" >&2
  exit 1
fi

bash -n "$script_path"

temp_root="$(mktemp -d)"
trap 'rm -rf "$temp_root"' EXIT

mkdir -p "$temp_root/project/scripts" "$temp_root/project/backend" \
  "$temp_root/project/frontend" "$temp_root/bin"
cp "$script_path" "$temp_root/project/scripts/dev.sh"
touch "$temp_root/project/backend/requirements.txt"

cat > "$temp_root/bin/python3" <<'PYTHON'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "-m" && "${2:-}" == "venv" ]]; then
  mkdir -p "$3/bin"
  cat > "$3/bin/python" <<'VENV_PYTHON'
#!/usr/bin/env bash
printf 'python:%s\n' "$*" >> "$DEV_SH_LOG"
VENV_PYTHON
  chmod +x "$3/bin/python"
  exit 0
fi
exit 1
PYTHON
chmod +x "$temp_root/bin/python3"

cat > "$temp_root/bin/npm" <<'NPM'
#!/usr/bin/env bash
printf 'npm:%s\n' "$*" >> "$DEV_SH_LOG"
NPM
chmod +x "$temp_root/bin/npm"

export DEV_SH_LOG="$temp_root/dev.log"
PATH="$temp_root/bin:/usr/bin:/bin" "$temp_root/project/scripts/dev.sh"

grep -Fqx 'python:-m pip install -r backend/requirements.txt' "$DEV_SH_LOG"
grep -Fqx 'python:-m uvicorn app.main:app --reload --port 8000' "$DEV_SH_LOG"
grep -Fqx 'npm:install' "$DEV_SH_LOG"
grep -Fqx 'npm:run dev' "$DEV_SH_LOG"

echo "dev.sh smoke test passed"
