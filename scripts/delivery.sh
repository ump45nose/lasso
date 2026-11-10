#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
exec "${LASSO_NODE:-node}" "$ROOT/scripts/delivery.mjs" "$@"
