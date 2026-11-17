#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
port="${1:-8080}"
printf 'Mirage Atlas: http://localhost:%s\n' "$port"
exec python3 -m http.server "$port"
