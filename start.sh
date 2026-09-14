#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"

if ! command -v lsof >/dev/null 2>&1; then
  echo "Error: lsof is required to check whether port $PORT is available." >&2
  exit 1
fi

listener="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN | head -n 1 || true)"
if [[ -n "$listener" ]]; then
  if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    echo "Exam Prep Tracker is already running at http://localhost:$PORT (PID $listener)"
    exit 0
  fi

  echo "Port $PORT is already in use by PID $listener." >&2
  echo "Stop that process with: kill $listener" >&2
  exit 1
fi

echo "Starting Exam Prep Tracker at http://localhost:$PORT"
PORT="$PORT" npm run dev
