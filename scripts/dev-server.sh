#!/usr/bin/env bash
# Start (or restart) the local Pages dev server cleanly.
# wrangler and workerd outlive each other easily; kill both by port, not by name.
set -euo pipefail
PORT="${PORT:-8788}"
cd "$(dirname "$0")/.."
for pid in $(ss -ltnp 2>/dev/null | grep -E ":${PORT}\b" | grep -oP 'pid=\K[0-9]+' | sort -u); do
  ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
  kill -9 "$pid" 2>/dev/null || true
  [ -n "${ppid:-}" ] && ps -o cmd= -p "$ppid" 2>/dev/null | grep -q wrangler && kill -9 "$ppid" 2>/dev/null || true
done
pkill -9 -x workerd 2>/dev/null || true
sleep 1
if [ "${FRESH:-0}" = "1" ]; then rm -rf .wrangler/state; fi
npm run build >/dev/null
setsid nohup npx wrangler pages dev dist --port "$PORT" --inspector-port 9339 > /tmp/wrangler.log 2>&1 < /dev/null &
for _ in $(seq 1 40); do
  sleep 1
  if curl -s -m 2 -o /dev/null "http://localhost:${PORT}/console/events"; then echo "ready on :${PORT}"; exit 0; fi
done
echo "did not start; see /tmp/wrangler.log" >&2; exit 1
