#!/usr/bin/env bash
# Локальный сервер модели с OpenAI-совместимым API (как на доске: CPU, 4 потока, без mmap).
#
#   scripts/serve.sh                                  # 4B Q4_K_M на 127.0.0.1:8080
#   MODEL=models/Qwen3.5-2B-Q4_K_M.gguf scripts/serve.sh
#   HOST=0.0.0.0 API_KEY=secret scripts/serve.sh      # доступ из локальной сети, с ключом
#
# Документация для бэкенда: docs/API_FOR_BACKEND.md
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${MODEL:-$ROOT/models/Qwen3.5-4B-Q4_K_M.gguf}"
ALIAS="${ALIAS:-$(basename "$MODEL" .gguf | tr 'A-Z_' 'a-z-')}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8080}"
THREADS="${THREADS:-4}"
CTX="${CTX:-8192}"          # у Qwen3.5 KV-кэш маленький: 8192 стоит ~+130 МБ к 4096

args=(
  -m "$MODEL" --alias "$ALIAS"
  --host "$HOST" --port "$PORT"
  -t "$THREADS" -tb "$THREADS"
  -c "$CTX" -np 1                    # один пользователь (учитель) — один слот, меньше памяти
  -lm none                           # без mmap: иначе RSS почти вдвое больше (см. benchmark/board_speed.md)
  --jinja                            # chat template из GGUF
  --chat-template-kwargs '{"enable_thinking": false}'   # по умолчанию без режима рассуждений
)
[[ -n "${API_KEY:-}" ]] && args+=(--api-key "$API_KEY")

echo "llama-server: $MODEL → http://$HOST:$PORT/v1 (model=\"$ALIAS\", $THREADS потока, ctx $CTX)" >&2
exec "$ROOT/llama.cpp/build/bin/llama-server" "${args[@]}" "$@"
