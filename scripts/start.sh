#!/usr/bin/env bash
# ── korg-e start — launch backend (and optionally frontend dev server) ─
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load .env if present
if [[ -f "$REPO_ROOT/.env" ]]; then
    set -a
    source "$REPO_ROOT/.env"
    set +a
fi

KORG_E_HOME="${KORG_E_HOME:-$HOME/.korg-e}"
KORG_E_HOST="${KORG_E_HOST:-127.0.0.1}"
KORG_E_PORT="${KORG_E_PORT:-8000}"
KORG_E_LOG_LEVEL="${KORG_E_LOG_LEVEL:-info}"

# ── 1. Activate Python venv ────────────────────────────────────────────
VENV_DIR="$KORG_E_HOME/venv"
if [[ ! -f "$VENV_DIR/bin/activate" ]]; then
    echo "✗ Virtual environment not found at $VENV_DIR" >&2
    echo "  Run ./scripts/setup.sh first." >&2
    exit 1
fi
source "$VENV_DIR/bin/activate"

# ── 2. Start backend ───────────────────────────────────────────────────
echo "◆ Starting korg-e backend on http://$KORG_E_HOST:$KORG_E_PORT …"
cd "$REPO_ROOT"

UVICORN_ARGS=(
    backend.main:app
    --host "$KORG_E_HOST"
    --port "$KORG_E_PORT"
    --log-level "$KORG_E_LOG_LEVEL"
)

# --reload watches the source tree, so a stray file touch would evict and
# reload ~20GB of weights. Restrict it to dev runs.
if [[ "${1:-}" == "--dev" || "${1:-}" == "-d" ]]; then
    UVICORN_ARGS+=(--reload)
fi

uvicorn "${UVICORN_ARGS[@]}" &

BACKEND_PID=$!
echo "  backend PID: $BACKEND_PID"

# ── 3. Optionally start frontend dev server ────────────────────────────
if [[ "${1:-}" == "--dev" || "${1:-}" == "-d" ]]; then
    echo "◆ Starting frontend dev server on http://127.0.0.1:5173 …"
    cd "$REPO_ROOT/frontend"
    npm run dev &
    FRONTEND_PID=$!
    echo "  frontend PID: $FRONTEND_PID"
fi

# ── 4. Trap cleanup ───────────────────────────────────────────────────
cleanup() {
    echo ""
    echo "◆ Shutting down …"
    [[ -n "${BACKEND_PID:-}" ]] && kill "$BACKEND_PID" 2>/dev/null || true
    [[ -n "${FRONTEND_PID:-}" ]] && kill "$FRONTEND_PID" 2>/dev/null || true
    exit 0
}
trap cleanup SIGINT SIGTERM

# ── 5. Wait ────────────────────────────────────────────────────────────
echo "◆ Press Ctrl+C to stop."
wait
