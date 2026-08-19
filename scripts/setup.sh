#!/usr/bin/env bash
# ── korg-e setup — validate environment, install dependencies ──────────
set -euo pipefail

KORG_E_HOME="${KORG_E_HOME:-$HOME/.korg-e}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "◆ korg-e setup — $(date)"
echo "  data root : $KORG_E_HOME"

# ── 1. Validate platform ─────────────────────────────────────────────
# Wheels for the CUDA build come from a dedicated index; on macOS the default
# PyPI wheel already carries MPS support.
TORCH_INDEX=""

case "$(uname)" in
Darwin)
    OS_VERSION=$(sw_vers -productVersion 2>/dev/null || echo "0.0")
    echo "  platform  : macOS $OS_VERSION"

    if [[ "$(uname -m)" != "arm64" ]]; then
        echo "✗ Apple Silicon (arm64) required." >&2
        exit 1
    fi

    # bfloat16 on MPS requires macOS 14+
    if [[ "$(echo "$OS_VERSION" | cut -d. -f1)" -lt 14 ]]; then
        echo "✗ macOS 14+ (Sonoma) required for bfloat16 support on MPS." >&2
        exit 1
    fi
    ;;
Linux)
    if ! command -v nvidia-smi &>/dev/null; then
        echo "✗ nvidia-smi not found — an NVIDIA GPU is required on Linux." >&2
        exit 1
    fi

    DRIVER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)
    echo "  platform  : Linux (NVIDIA driver $DRIVER)"

    # cu130 wheels need a CUDA 13.0-capable driver.
    if [[ "${DRIVER%%.*}" -lt 580 ]]; then
        echo "✗ NVIDIA driver 580+ required for the CUDA 13 build (found $DRIVER)." >&2
        exit 1
    fi

    TORCH_INDEX="https://download.pytorch.org/whl/cu130"
    ;;
*)
    echo "✗ Unsupported platform: $(uname). Expected Darwin or Linux." >&2
    exit 1
    ;;
esac

# ── 2. Check Python ──────────────────────────────────────────────────
PYTHON=""
for candidate in python3.12 python3.11 python3; do
    if command -v "$candidate" &>/dev/null; then
        VER=$("$candidate" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+')
        MAJOR="${VER%.*}"
        MINOR="${VER#*.}"
        if (( MAJOR >= 3 && MINOR >= 10 )); then
            PYTHON="$candidate"
            break
        fi
    fi
done

if [[ -z "$PYTHON" ]]; then
    echo "✗ Python >=3.10 required (not found)." >&2
    exit 1
fi
echo "  python    : $PYTHON $($PYTHON --version)"

# ── 3. Create data root directories ───────────────────────────────────
mkdir -p "$KORG_E_HOME"/{outputs,workflows,cache,venv}

# ── 4. Create / activate Python venv ──────────────────────────────────
VENV_DIR="$KORG_E_HOME/venv"
if [[ ! -f "$VENV_DIR/bin/activate" ]]; then
    echo "◆ Creating Python venv …"
    "$PYTHON" -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"
echo "  venv      : $VENV_DIR"

# ── 5. Install Python dependencies ────────────────────────────────────
echo "◆ Installing Python packages …"
pip install -q --upgrade pip

if [[ -n "$TORCH_INDEX" ]]; then
    echo "  torch     : $TORCH_INDEX"
    pip install -q --index-url "$TORCH_INDEX" "torch>=2.5.0"
else
    pip install -q "torch>=2.5.0"
fi

# CRITICAL: Z-Image support requires diffusers from source
pip install -q \
    "fastapi>=0.135.0" \
    "uvicorn[standard]>=0.34.0" \
    "Pillow>=11.0.0" \
    "git+https://github.com/huggingface/diffusers" \
    "transformers>=4.48.0" \
    "accelerate>=1.0.0"

echo "  Python deps: ✓"

# ── 6. Install Node.js dependencies ───────────────────────────────────
echo "◆ Installing Node dependencies …"
cd "$REPO_ROOT/frontend"
npm install --silent 2>/dev/null || npm install
echo "  Node deps : ✓"

# The backend serves frontend/dist at / when it exists, which is how the app
# is reached in production. --dev runs Vite instead and ignores this build.
echo "◆ Building frontend …"
npm run build
echo "  Frontend  : ✓"

# ── 7. Copy .env if missing ───────────────────────────────────────────
if [[ ! -f "$REPO_ROOT/.env" && -f "$REPO_ROOT/.env.example" ]]; then
    cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
    echo "  .env      : created from .env.example"
fi

# ── 8. Summary ────────────────────────────────────────────────────────
echo ""
echo "✓ korg-e setup complete."
echo "  Run ./scripts/start.sh to launch."
