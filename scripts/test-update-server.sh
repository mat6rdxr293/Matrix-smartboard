#!/usr/bin/env bash
# Exercises deploy/update-server.sh against a throwaway git checkout: lesson data written by the
# server must survive both an update and a rollback. Paths, the root check, pip and the service
# restart are substituted in a private copy; the update and rollback logic runs unchanged.
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'status=$?; if [[ $status -ne 0 && -f "$work/update.log" ]]; then cat "$work/update.log" >&2; fi; rm -rf "${work:?}"' EXIT

git_quiet() { git -c init.defaultBranch=main -c user.name=test -c user.email=test@example.invalid "$@" >/dev/null 2>&1 || { echo "git $* failed" >&2; return 1; }; }

make_updater() {
  # "ok": the updated server is healthy. "rollback": it is not, but the old version is again.
  local mode="$1"
  rm -f "$work/health-calls"
  sed \
    -e "s#^APP_DIR=.*#APP_DIR=\"$work/app\"#" \
    -e "s#^CONF_FILE=.*#CONF_FILE=\"$work/none.conf\"#" \
    -e "s#LOG_FILE=\"/var/[^\"]*\"#LOG_FILE=\"$work/update.log\"#" \
    -e 's#if \[\[ "\${EUID}" -ne 0 \]\]; then#if false; then#' \
    -e 's#^  "\$APP_DIR/.venv/bin/python" -m pip.*#  :#' \
    -e 's#^  install -m 755 .*#  :#' \
    -e 's#^    launchctl kickstart .*#    :#' \
    -e 's#^    systemctl restart .*#    :#' \
    "$project_root/deploy/update-server.sh" > "$work/update.sh"
  # Redefine the health check before the update runs, so no real server is ever contacted.
  local stub="wait_health() { local n; n=\$(cat '$work/health-calls' 2>/dev/null || echo 0); echo \$((n + 1)) > '$work/health-calls'; [[ '$mode' == ok || \$n -ge 1 ]]; }"
  awk -v stub="$stub" '/^echo "Updating / { print stub } { print }' "$work/update.sh" > "$work/update.tmp"
  mv "$work/update.tmp" "$work/update.sh"
  grep -q "^wait_health() { local n" "$work/update.sh" || { echo "health stub not installed" >&2; exit 1; }
  chmod +x "$work/update.sh"
}

setup_repo() {
  rm -rf "${work:?}/origin" "${work:?}/app"
  git_quiet init --bare "$work/origin"
  git_quiet clone "$work/origin" "$work/seed"
  mkdir -p "$work/seed/backend/app/data"
  echo '{"slides":"default"}' > "$work/seed/backend/app/data/slides.json"
  echo 'v1' > "$work/seed/backend/app/code.txt"
  git_quiet -C "$work/seed" add -A
  git_quiet -C "$work/seed" commit -m v1
  git_quiet -C "$work/seed" push origin main
  git_quiet clone "$work/origin" "$work/app"
  # What a school's server holds after teaching with it.
  echo '{"slides":"teacher"}' > "$work/app/backend/app/data/slides.json"
  echo 'v2' > "$work/seed/backend/app/code.txt"
  echo '{"slides":"new default"}' > "$work/seed/backend/app/data/slides.json"
  git_quiet -C "$work/seed" commit -am v2
  git_quiet -C "$work/seed" push origin main
  rm -rf "${work:?}/seed"
}

expect() {
  if [[ "$(cat "$work/app/$1")" != "$2" ]]; then
    echo "FAIL: $1 is '$(cat "$work/app/$1")', expected '$2'" >&2
    cat "$work/update.log" >&2
    exit 1
  fi
}

setup_repo
make_updater ok
"$work/update.sh" --worker
expect backend/app/code.txt v2
expect backend/app/data/slides.json '{"slides":"teacher"}'

setup_repo
make_updater rollback
status=0
"$work/update.sh" --worker || status=$?
[[ $status -eq 4 ]] || { echo "FAIL: rollback exited $status, expected 4" >&2; exit 1; }
expect backend/app/code.txt v1
expect backend/app/data/slides.json '{"slides":"teacher"}'

echo "update-server.sh keeps lesson data across update and rollback"
