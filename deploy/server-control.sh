#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: service control must run as root" >&2
  exit 2
fi

case "${1:-}" in
  restart-ollama)
    if [[ "$(uname -s)" == "Darwin" ]]; then
      launchctl kickstart -k system/ru.matrixhost.ollama
    else
      systemctl restart ollama
    fi
    ;;
  *)
    echo "ERROR: unsupported action" >&2
    exit 2
    ;;
esac
