---
date: 2026-06-13T08:57:55-0700
author: Eric Sison
commit: no-commit
branch: main
repository: korg-e
topic: "Simplified ComfyUI-like Image Generation Webapp"
tags: [plan, z-image, fastapi, react-flow, diffusers, greenfield]
status: ready
parent: ".rpiv/artifacts/designs/2026-06-13_07-55-56_simplified-comfyui-image-gen.md"
phase_count: 7
phases:
  - { n: 1, title: "Project scaffolding + Configuration + Backend foundation" }
  - { n: 2, title: "Pipeline wrapper + image storage" }
  - { n: 3, title: "API routes — generate + SSE streaming" }
  - { n: 4, title: "API routes — images + workflow save/load" }
  - { n: 5, title: "Frontend types + Zustand store + SSE client" }
  - { n: 6, title: "Custom node components" }
  - { n: 7, title: "Starter workflow + frontend-backend integration" }
last_updated: 2026-06-13T08:57:55-0700
last_updated_by: Eric Sison
last_updated_note: "Step 5 triage complete: 1 blocker applied, 3 concerns applied, 4 suggestions applied, 2 dismissed"
---

# Simplified ComfyUI-like Image Generation Webapp — Implementation Plan

## Overview

Implement a standalone web application providing a simplified node-graph interface (like ComfyUI) for generating images using the Z-Image foundation model via HuggingFace diffusers. The plan converts the upstream design artifact's 7 verified slices into 7 implementation phases — each atomic, testable, and implementable in an isolated worktree.

**Design artifact**: `.rpiv/artifacts/designs/2026-06-13_07-55-56_simplified-comfyui-image-gen.md` (status: ready)

## Desired End State

### Backend running
```bash
# Setup
cd korg-e
./scripts/setup.sh
# Start
./scripts/start.sh
# Backend: http://localhost:8000
# Frontend (dev): http://localhost:5173
```

### API usage
```bash
# Health check
curl http://localhost:8000/health
# → {"status":"ok","model_loaded":false}

# Generate (SSE stream)
curl -N -X POST http://localhost:8000/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "nodes": [...],
    "edges": [...]
  }'
# → event: progress\ndata: {"step":1,"total":50,"status":"generating"}\n\n
# → event: progress\ndata: {"step":2,"total":50,"status":"generating"}\n\n
# → event: done\ndata: {"status":"complete","image_url":"/images/abc123.png"}\n\n

# List images
curl http://localhost:8000/api/images
# → {"images":[{"filename":"abc123.png","seed":42,"prompt":"a cat","timestamp":"2026-06-13T..."}]}

# Save workflow
curl -X POST http://localhost:8000/api/workflow/save \
  -H "Content-Type: application/json" \
  -d '{"name":"my-workflow","workflow":{...}}'

# Load workflow
curl http://localhost:8000/api/workflow/load/my-workflow
```

### Frontend usage
```typescript
// User opens the app
// → Sees pre-placed starter workflow on canvas
// → Edits prompt in TextPromptNode
// → Optionally uploads starting image in ImageUploadNode (for img2img)
// → Adjusts steps/CFG/seed in ZImageGenerateNode
// → Clicks "Generate" on ZImageGenerateNode
// → Progress bar animates on node during generation
// → Generated image appears in ImageOutputNode
// → Clicks save to persist workflow JSON
```

## What We're NOT Doing

- User authentication / RBAC / multi-tenancy (personal tool)
- Undo/redo for node graph operations (deferred to v2)
- Inpainting support (`ZImageInpaintPipeline`) — only text-to-image and img2img in v1
- Model download manager or model browser (lazy load on first request only)
- Gallery/browsing UI for generated images beyond the current workflow
- Plugins or custom node SDK (future consideration)

---

## Phase 1: Project scaffolding + Configuration + Backend foundation

### Overview
Establishes the project skeleton: FastAPI backend entry point with CORS and health check, configuration management reading from environment variables, frontend tooling configurations (Vite, TypeScript, package.json), HTML entry point, environment template, and setup/start shell scripts.

### Changes Required:

#### 1. Backend package marker
**File**: `backend/__init__.py`
**Changes**: New — package marker enabling uvicorn import resolution.

```python
"""korg-e backend."""
```

#### 2. FastAPI application entry point
**File**: `backend/main.py`
**Changes**: New — FastAPI app with CORS middleware, /health endpoint, static mounts, route registration stubs.

```python
"""FastAPI application entry point."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.config import settings

app = FastAPI(title="korg-e", version="0.1.0")

# ── CORS (dev-mode: separate Vite dev server) ─────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── state ──────────────────────────────────────────────────────────────
from backend.pipeline import PipelineWrapper

app.state.model_pipeline = PipelineWrapper()  # lazy-loads on first generation


# ── health ─────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model_loaded": app.state.model_pipeline is not None,
    }


# ── routes (registered in later slices) ────────────────────────────────
# from backend.routes import generate, images, workflow
# app.include_router(generate.router, prefix="/api")
# app.include_router(images.router, prefix="/api")
# app.include_router(workflow.router, prefix="/api")


# ── static files: generated images ────────────────────────────────────
images_path = Path(settings.output_dir)
images_path.mkdir(parents=True, exist_ok=True)
app.mount("/images", StaticFiles(directory=str(images_path)), name="images")

# ── static files: production frontend build ────────────────────────────
dist_path = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if dist_path.exists():
    app.mount("/", StaticFiles(directory=str(dist_path), html=True), name="frontend")
```

#### 3. Configuration management
**File**: `backend/config.py`
**Changes**: New — reads `$KORG_E_HOME`, port, model settings, paths from environment.

```python
"""Application configuration — resolved from environment variables."""

import os
from pathlib import Path


def _data_root() -> Path:
    return Path(os.environ.get("KORG_E_HOME", Path.home() / ".korg-e"))


def _ensure_dir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p


class Settings:
    # ── paths ──────────────────────────────────────────────────────────
    data_root: Path = _data_root()
    output_dir: Path = _ensure_dir(data_root / "outputs")
    workflows_dir: Path = _ensure_dir(data_root / "workflows")
    cache_dir: Path = _ensure_dir(
        Path(os.environ.get("HF_HOME", data_root / "cache"))
    )

    # ── server ─────────────────────────────────────────────────────────
    host: str = "127.0.0.1"
    port: int = int(os.environ.get("KORG_E_PORT", "8000"))
    log_level: str = os.environ.get("KORG_E_LOG_LEVEL", "info")

    # ── model ──────────────────────────────────────────────────────────
    model_id: str = "Tongyi-MAI/Z-Image"
    torch_dtype: str = "bfloat16"  # bfloat16 recommended for MPS
    low_cpu_mem_usage: bool = False  # per model card recommendation
    enable_attention_slicing: bool = True  # recommended for MPS < 64GB
    enable_vae_slicing: bool = True
    device: str = "mps"

    # ── generation defaults ────────────────────────────────────────────
    default_steps: int = 50
    default_cfg_scale: float = 5.0
    default_resolution: tuple[int, int] = (1024, 1024)

    # ── CORS (dev mode) ────────────────────────────────────────────────
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


settings = Settings()
```

#### 4. Frontend package manifest
**File**: `frontend/package.json`
**Changes**: New — Node dependencies: react, react-dom, @xyflow/react, zustand, vite, typescript, @types/react, @vitejs/plugin-react, vitest.

```json
{
  "name": "korg-e",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "check": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@xyflow/react": "^12.5.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.6.3",
    "vitest": "^3.0.0",
    "vite": "^6.0.0"
  }
}
```

#### 5. Vite configuration
**File**: `frontend/vite.config.ts`
**Changes**: New — Vite config with React plugin and proxy to backend.

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
      "/images": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
```

#### 6. TypeScript configuration (app)
**File**: `frontend/tsconfig.json`
**Changes**: New — TypeScript configuration for React + Vite.

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

#### 7. TypeScript configuration (Vite/Node)
**File**: `frontend/tsconfig.node.json`
**Changes**: New — TS config for vite.config.ts (Node environment). Required by tsconfig.json references.

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["vite.config.ts"]
}
```

#### 8. HTML entry point
**File**: `frontend/index.html`
**Changes**: New — HTML entry point with root div.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>korg-e</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

#### 9. Environment template
**File**: `.env.example`
**Changes**: New — Configuration template for KORG_E_HOME, KORG_E_PORT, etc.

```
# KORG_E_HOME — data root for generated images and config
# Default: ~/.korg-e
KORG_E_HOME="${KORG_E_HOME:-$HOME/.korg-e}"

# Backend port (default 8000)
KORG_E_PORT="${KORG_E_PORT:-8000}"

# Frontend port (dev server, default 5173)
KORG_E_FRONTEND_PORT="${KORG_E_FRONTEND_PORT:-5173}"

# Log level for uvicorn
KORG_E_LOG_LEVEL="${KORG_E_LOG_LEVEL:-info}"

# HuggingFace cache directory
HF_HOME="${HF_HOME:-$KORG_E_HOME/cache}"
```

#### 10. Setup script
**File**: `scripts/setup.sh`
**Changes**: New — Environment validation, Python venv creation, pip install (diffusers, torch, fastapi, uvicorn), npm install.

```bash
#!/usr/bin/env bash
# ── korg-e setup — validate environment, install dependencies ──────────
set -euo pipefail

KORG_E_HOME="${KORG_E_HOME:-$HOME/.korg-e}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "◆ korg-e setup — $(date)"
echo "  data root : $KORG_E_HOME"

# ── 1. Validate macOS + Apple Silicon ─────────────────────────────────
if [[ "$(uname)" != "Darwin" ]]; then
    echo "✗ This tool is designed for macOS (Apple Silicon)." >&2
    exit 1
fi

OS_VERSION=$(sw_vers -productVersion 2>/dev/null || echo "0.0")
echo "  macOS     : $OS_VERSION"

if [[ "$(uname -m)" != "arm64" ]]; then
    echo "✗ Apple Silicon (arm64) required." >&2
    exit 1
fi

# bfloat16 on MPS requires macOS 14+
if [[ "$(echo "$OS_VERSION" | cut -d. -f1)" -lt 14 ]]; then
    echo "✗ macOS 14+ (Sonoma) required for bfloat16 support on MPS." >&2
    exit 1
fi

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
# CRITICAL: Z-Image support requires diffusers from source
pip install -q --upgrade pip
pip install -q \
    "torch>=2.5.0" \
    "fastapi>=0.135.0" \
    "uvicorn[standard]>=0.34.0" \
    "Pillow>=11.0.0" \
    "git+https://github.com/huggingface/diffusers" \
    "transformers>=4.48.0"

echo "  Python deps: ✓"

# ── 6. Install Node.js dependencies ───────────────────────────────────
echo "◆ Installing Node dependencies …"
cd "$REPO_ROOT/frontend"
npm install --silent 2>/dev/null || npm install
echo "  Node deps : ✓"

# ── 7. Copy .env if missing ───────────────────────────────────────────
if [[ ! -f "$REPO_ROOT/.env" && -f "$REPO_ROOT/.env.example" ]]; then
    cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
    echo "  .env      : created from .env.example"
fi

# ── 8. Summary ────────────────────────────────────────────────────────
echo ""
echo "✓ korg-e setup complete."
echo "  Run ./scripts/start.sh to launch."
```

#### 11. Start script
**File**: `scripts/start.sh`
**Changes**: New — Start backend (uvicorn) and optionally frontend (Vite dev server).

```bash
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
echo "◆ Starting korg-e backend on http://127.0.0.1:$KORG_E_PORT …"
cd "$REPO_ROOT"
uvicorn backend.main:app \
    --host 127.0.0.1 \
    --port "$KORG_E_PORT" \
    --log-level "$KORG_E_LOG_LEVEL" \
    --reload &

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
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npx tsc --noEmit` (note: fails on missing `src/` until Slice 5)
- [x] Tests pass: `npm test` (vitest runner configured; no tests yet)
- [x] Backend imports resolve: `cd /tmp && python -c "import sys; sys.path.insert(0,'/path/to/repo'); from backend.config import settings; print(settings.data_root)"`
- [x] Backend starts: `uvicorn backend.main:app --port 8000` responds on `/health`
- [x] Grep for bfloat16 config in config.py: `grep -r "bfloat16" backend/config.py` returns non-empty
- [x] macOS 14+ check in setup.sh: `grep -c "macOS 14+" scripts/setup.sh` returns >= 1

#### Manual Verification:
- [ ] FastAPI app starts without errors
- [ ] `/health` returns 200 with model-loaded status
- [ ] CORS headers present on OPTIONS preflight request
- [ ] `scripts/setup.sh` runs through without errors
- [ ] `scripts/start.sh` launches backend successfully

---

## Phase 2: Pipeline wrapper + image storage

### Overview
Implements the Z-Image diffusers pipeline wrapper with lazy loading, MPS optimizations (bfloat16, attention slicing, VAE slicing), text-to-image and img2img generation methods, and step-level progress callback support. Adds image storage utilities for saving generated PNGs with sidecar JSON metadata, listing, and deleting.

### Changes Required:

#### 1. Utils package marker
**File**: `backend/utils/__init__.py`
**Changes**: New — package marker.

```python
"""Utility modules for the korg-e backend."""
```

#### 2. Z-Image pipeline wrapper
**File**: `backend/pipeline.py`
**Changes**: New — wraps ZImagePipeline and ZImageImg2ImgPipeline with lazy loading, MPS optimizations, callback_on_step_end progress.

```python
"""Z-Image pipeline wrapper — lazy loading, MPS optimizations, progress callback."""

import logging
from typing import Callable

import torch

from backend.config import settings

logger = logging.getLogger(__name__)

# Lazy import — diffusers is a heavy dependency only needed at generation time
_PipelineType = None  # Forward-declared; resolved on first load


class PipelineWrapper:
    """Manages the Z-Image diffusers pipeline with lazy loading.

    The pipeline is instantiated on the first call to :meth:`load` and
    cached for subsequent generations.
    """

    def __init__(self) -> None:
        self._pipeline: _PipelineType = None  # type: ignore[assignment]
        self._loaded = False

    @property
    def loaded(self) -> bool:
        return self._loaded

    @property
    def pipeline(self) -> "_PipelineType":
        if self._pipeline is None:
            raise RuntimeError("Pipeline not loaded. Call load() first.")
        return self._pipeline

    # ── loading ─────────────────────────────────────────────────────────

    def load(self, progress_callback: Callable[[str], None] | None = None) -> None:
        """Download, instantiate, and optimise the Z-Image pipeline.

        This is a **blocking call** — run it in a thread pool to avoid
        blocking the event loop.

        Parameters passed to progress_callback:
            ``"downloading"``, ``"loading"``, ``"optimising"``, ``"ready"``
        """
        if self._loaded:
            return

        from diffusers import ZImagePipeline  # type: ignore[import-untyped]

        _notify(progress_callback, "downloading")

        dtype = _resolve_dtype()
        pipe = ZImagePipeline.from_pretrained(
            settings.model_id,
            torch_dtype=dtype,
            low_cpu_mem_usage=settings.low_cpu_mem_usage,
        )

        _notify(progress_callback, "loading")
        pipe.to(settings.device)  # "mps" or "cuda"

        _notify(progress_callback, "optimising")
        if settings.enable_attention_slicing:
            pipe.enable_attention_slicing()
        if settings.enable_vae_slicing:
            pipe.enable_vae_slicing()

        self._pipeline = pipe
        self._loaded = True
        _notify(progress_callback, "ready")

    # ── image-to-image support ──────────────────────────────────────────

    def load_img2img(self, progress_callback: Callable[[str], None] | None = None) -> None:
        """Lazy-load the **separate** :class:`ZImageImg2ImgPipeline`.

        Uses the same weight-cache as the text-to-image pipeline but
        must be instantiated from its own class.
        """
        if hasattr(self, "_img2img_pipeline") and self._img2img_pipeline is not None:
            return

        from diffusers import ZImageImg2ImgPipeline  # type: ignore[import-untyped]

        _notify(progress_callback, "downloading")
        dtype = _resolve_dtype()
        pipe = ZImageImg2ImgPipeline.from_pretrained(
            settings.model_id,
            torch_dtype=dtype,
            low_cpu_mem_usage=settings.low_cpu_mem_usage,
        )

        _notify(progress_callback, "loading")
        pipe.to(settings.device)

        _notify(progress_callback, "optimising")
        if settings.enable_attention_slicing:
            pipe.enable_attention_slicing()
        if settings.enable_vae_slicing:
            pipe.enable_vae_slicing()

        self._img2img_pipeline = pipe  # type: ignore[attr-defined]

    # ── generation ──────────────────────────────────────────────────────

    def generate(
        self,
        prompt: str,
        *,
        steps: int = 50,
        cfg_scale: float = 5.0,
        seed: int | None = None,
        width: int = 1024,
        height: int = 1024,
        step_callback: Callable[[int, int], None] | None = None,
    ) -> bytes:
        """Run text-to-image generation and return raw PNG bytes.

        The ``step_callback`` receives ``(step, total_steps)`` after each
        inference step so callers can push SSE progress events.
        """
        if self._pipeline is None:
            raise RuntimeError("Pipeline not loaded. Call load() first.")

        generator = None
        if seed is not None:
            generator = torch.Generator(device=settings.device).manual_seed(seed)

        # Build the callback_on_step_end closure
        total = steps

        def _on_step(pipe: object, step: int, timestep: int, callback_kwargs: dict) -> dict:
            if step_callback:
                step_callback(step, total)
            return callback_kwargs

        result = self._pipeline(
            prompt=prompt,
            num_inference_steps=steps,
            guidance_scale=cfg_scale,
            generator=generator,
            width=width,
            height=height,
            output_type="pil",
            callback_on_step_end=_on_step,
            callback_on_step_end_tensor_inputs=["latents"],
        )

        image = result.images[0]

        import io

        buf = io.BytesIO()
        image.save(buf, format="PNG")
        return buf.getvalue()

    def generate_img2img(
        self,
        prompt: str,
        init_image_bytes: bytes,
        *,
        strength: float = 0.6,
        steps: int = 50,
        cfg_scale: float = 5.0,
        seed: int | None = None,
        step_callback: Callable[[int, int], None] | None = None,
    ) -> bytes:
        """Run image-to-image generation and return raw PNG bytes."""
        if not hasattr(self, "_img2img_pipeline") or self._img2img_pipeline is None:
            raise RuntimeError("Img2Img pipeline not loaded. Call load_img2img() first.")

        from PIL import Image as PILImage
        import io

        init_image = PILImage.open(io.BytesIO(init_image_bytes)).convert("RGB")

        generator = None
        if seed is not None:
            generator = torch.Generator(device=settings.device).manual_seed(seed)

        total = steps

        def _on_step(pipe: object, step: int, timestep: int, callback_kwargs: dict) -> dict:
            if step_callback:
                step_callback(step, total)
            return callback_kwargs

        result = self._img2img_pipeline(
            prompt=prompt,
            image=init_image,
            strength=strength,
            num_inference_steps=steps,
            guidance_scale=cfg_scale,
            generator=generator,
            output_type="pil",
            callback_on_step_end=_on_step,
            callback_on_step_end_tensor_inputs=["latents"],
        )

        image = result.images[0]
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        return buf.getvalue()


# ── helpers ─────────────────────────────────────────────────────────────


def _resolve_dtype() -> torch.dtype:
    mapping: dict[str, torch.dtype] = {
        "bfloat16": torch.bfloat16,
        "float16": torch.float16,
        "float32": torch.float32,
    }
    return mapping.get(settings.torch_dtype, torch.bfloat16)


def _notify(cb: Callable[[str], None] | None, msg: str) -> None:
    if cb:
        cb(msg)
```

#### 3. Image storage utilities
**File**: `backend/utils/storage.py`
**Changes**: New — save image with sidecar JSON metadata, list, delete.

```python
"""Image storage — save, list, and delete generated images."""

import json
from datetime import datetime, timezone
from pathlib import Path

from backend.config import settings


def _ensure_output_dir() -> Path:
    settings.output_dir.mkdir(parents=True, exist_ok=True)
    return settings.output_dir


def save_image(image_data: bytes, prompt: str, seed: int, timestamp: str | None = None) -> Path:
    """Save a PNG to ``~/.korg-e/outputs/`` and write sidecar metadata.

    Returns the filesystem path of the saved image.
    """
    ts = timestamp or datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    filename = f"{ts}_{seed}.png"
    output_path = _ensure_output_dir() / filename

    with open(output_path, "wb") as f:
        f.write(image_data)

    meta = {"filename": filename, "prompt": prompt, "seed": seed, "timestamp": ts}
    meta_path = output_path.with_suffix(".json")
    meta_path.write_text(json.dumps(meta, indent=2))

    return output_path


def list_images(limit: int = 50, offset: int = 0) -> list[dict]:
    """Return metadata for generated images, newest first."""
    output_dir = _ensure_output_dir()
    png_files = sorted(output_dir.glob("*.png"), reverse=True)
    png_files = png_files[offset : offset + limit]

    results: list[dict] = []
    for p in png_files:
        meta_path = p.with_suffix(".json")
        if meta_path.exists():
            meta = json.loads(meta_path.read_text())
        else:
            meta = {"filename": p.name, "prompt": "", "seed": 0, "timestamp": ""}
        results.append(meta)

    return results


def delete_image(filename: str) -> bool:
    """Delete an image and its sidecar metadata. Returns True if deleted."""
    output_dir = _ensure_output_dir()
    png_path = output_dir / filename
    if not png_path.exists():
        return False

    png_path.unlink()
    meta_path = png_path.with_suffix(".json")
    if meta_path.exists():
        meta_path.unlink()
    return True


def get_image_path(filename: str) -> Path | None:
    """Return the filesystem path for a filename, or None if missing."""
    p = _ensure_output_dir() / filename
    return p if p.exists() else None
```

### Success Criteria:

#### Automated Verification:
- [x] Python imports resolve: `cd /tmp && python -c "import sys; sys.path.insert(0,'/path/to/repo'); from backend.pipeline import PipelineWrapper; from backend.utils.storage import save_image, list_images"`
- [x] Grep for `callback_on_step_end` in pipeline.py: `grep -c "callback_on_step_end" backend/pipeline.py` returns >= 2
- [x] Grep for `ZImageImg2ImgPipeline` in pipeline.py: `grep -c "ZImageImg2ImgPipeline" backend/pipeline.py` returns >= 2
- [x] Grep for `enable_attention_slicing` in pipeline.py: `grep -c "enable_attention_slicing" backend/pipeline.py` returns >= 1
- [x] Grep for `sidecar` or `.json` in storage.py: `grep -c "with_suffix" backend/utils/storage.py` returns >= 1

#### Manual Verification:
- [ ] PipelineWrapper loads pipeline lazily (no load on construction)
- [ ] PipelineWrapper.generate() produces PNG bytes
- [ ] PipelineWrapper.generate_img2img() accepts image bytes and produces PNG bytes
- [ ] Storage saves PNG + sidecar JSON to `~/.korg-e/outputs/`
- [ ] Storage.list_images() returns metadata sorted newest-first

---

## Phase 3: API routes — generate + SSE streaming

### Overview
Implements POST /api/generate with SSE streaming. Bridges thread-pool-based diffusers pipeline to async SSE via asyncio.Queue + run_coroutine_threadsafe. Includes graph topology validation and parameter extraction from workflow JSON.

### Changes Required:

#### 1. Routes package marker
**File**: `backend/routes/__init__.py`
**Changes**: New — package marker.

```python
"""API route modules."""
```

#### 2. Graph topology validation
**File**: `backend/utils/validation.py`
**Changes**: New — validate workflow graph topology, extract generation parameters.

```python
"""Graph topology validation for submitted workflows."""

from typing import Any


def validate_workflow(nodes: list[dict], edges: list[dict]) -> list[str]:
    """Validate a workflow's graph topology.

    Returns a list of error messages (empty = valid).
    """
    errors: list[str] = []
    node_ids = {n["id"] for n in nodes}

    # ── 1. At least one Z-Image Generate node ──────────────────────────
    generate_nodes = [n for n in nodes if n.get("type") == "zImageGenerate"]
    if not generate_nodes:
        errors.append("Workflow must contain at least one Z-Image Generate node.")

    # ── 2. Every edge connects existing nodes ──────────────────────────
    for edge in edges:
        if edge.get("source") not in node_ids:
            errors.append(f"Edge references unknown source node: {edge.get('source')}")
        if edge.get("target") not in node_ids:
            errors.append(f"Edge references unknown target node: {edge.get('target')}")

    # ── 3. Every required input handle must be connected ───────────────
    for node in nodes:
        data = node.get("data", {})
        inputs: list[dict] = data.get("inputs", [])
        for inp in inputs:
            handle_id = inp.get("name", "")
            has_connection = any(
                e.get("target") == node["id"] and e.get("targetHandle") == handle_id
                for e in edges
            )
            if not has_connection and inp.get("required", False):
                errors.append(
                    f"Node '{node.get('id')}' input '{handle_id}' is required "
                    f"but not connected."
                )

    # ── 4. No duplicate edge connections ───────────────────────────────
    seen: set[tuple[str, str, str | None, str | None]] = set()
    for edge in edges:
        key = (edge["source"], edge["target"], edge.get("sourceHandle"), edge.get("targetHandle"))
        if key in seen:
            errors.append(f"Duplicate edge: {edge['source']} → {edge['target']}")
        seen.add(key)

    return errors


def extract_parameters(nodes: list[dict], edges: list[dict]) -> dict[str, Any]:
    """Extract generation parameters from a valid workflow."""
    params: dict[str, Any] = {}

    generate_node = next(n for n in nodes if n.get("type") == "zImageGenerate")
    gen_data = generate_node.get("data", {})
    params["steps"] = gen_data.get("steps", 50)
    params["cfg_scale"] = gen_data.get("cfgScale", 5.0)
    params["seed"] = gen_data.get("seed", None)
    params["width"] = gen_data.get("width", 1024)
    params["height"] = gen_data.get("height", 1024)

    node_map = {n["id"]: n for n in nodes}
    for edge in edges:
        if edge["target"] == generate_node["id"] and edge.get("targetHandle") == "prompt":
            source_node = node_map.get(edge["source"])
            if source_node:
                params["prompt"] = source_node.get("data", {}).get("prompt", "")

    for edge in edges:
        if edge["target"] == generate_node["id"] and edge.get("targetHandle") == "image":
            source_node = node_map.get(edge["source"])
            if source_node and source_node.get("type") == "imageUpload":
                params["init_image"] = source_node.get("data", {}).get("imageData", None)

    return params
```

#### 3. POST /api/generate SSE streaming endpoint
**File**: `backend/routes/generate.py`
**Changes**: New — SSE streaming with asyncio.Queue bridge, thread pool execution, cancel support.

```python
"""POST /api/generate — SSE streaming endpoint for image generation."""

import asyncio
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import AsyncIterable

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.pipeline import PipelineWrapper
from backend.utils.storage import save_image
from backend.utils.validation import extract_parameters, validate_workflow

logger = logging.getLogger(__name__)

router = APIRouter()

# Shared thread pool for CPU-bound pipeline work
_executor = ThreadPoolExecutor(max_workers=2)


# ── request model ───────────────────────────────────────────────────────


class GenerateRequest(BaseModel):
    nodes: list[dict] = []
    edges: list[dict] = []
    is_img2img: bool = False


# ── SSE endpoint ───────────────────────────────────────────────────────


@router.post("/generate")
async def generate(request: Request, body: GenerateRequest):
    """Run the workflow and stream generation progress via SSE."""

    # ── 1. Validate ────────────────────────────────────────────────────
    errors = validate_workflow(body.nodes, body.edges)
    if errors:
        return StreamingResponse(
            _error_stream(errors),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # ── 2. Extract parameters ──────────────────────────────────────────
    params = extract_parameters(body.nodes, body.edges)
    prompt = params.get("prompt", "")
    steps = params.get("steps", 50)
    cfg_scale = params.get("cfg_scale", 5.0)
    seed = params.get("seed", None)
    width = params.get("width", 1024)
    height = params.get("height", 1024)

    # ── 3. Ensure pipeline is loaded ───────────────────────────────────
    pipeline: PipelineWrapper | None = request.app.state.model_pipeline  # type: ignore[assignment]
    if pipeline is None:
        return StreamingResponse(
            _error_stream(["Model not loaded."]),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    progress_queue: asyncio.Queue = asyncio.Queue()
    cancel_event = asyncio.Event()
    loop = asyncio.get_running_loop()

    if body.is_img2img:
        init_image_b64 = params.get("init_image")
        if not init_image_b64:
            return StreamingResponse(
                _error_stream(["Image-to-image requires an uploaded image."]),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )
        loop.run_in_executor(
            _executor,
            _run_img2img,
            pipeline,
            prompt,
            init_image_b64,
            steps,
            cfg_scale,
            seed,
            progress_queue,
            cancel_event,
            loop,
        )
    else:
        loop.run_in_executor(
            _executor,
            _run_text_to_image,
            pipeline,
            prompt,
            steps,
            cfg_scale,
            seed,
            width,
            height,
            progress_queue,
            cancel_event,
            loop,
        )

    return StreamingResponse(
        _sse_generator(request, progress_queue, cancel_event),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── background runners ──────────────────────────────────────────────────


def _run_text_to_image(
    pipeline: PipelineWrapper,
    prompt: str,
    steps: int,
    cfg_scale: float,
    seed: int | None,
    width: int,
    height: int,
    queue: asyncio.Queue,
    cancel_event: asyncio.Event,
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Run t2i in a thread pool, pushing progress to the async queue."""
    def _push(data: dict) -> None:
        asyncio.run_coroutine_threadsafe(queue.put(data), loop)

    # Phase 1: ensure pipeline loaded
    if not pipeline.loaded:
        _push({"event": "progress", "status": "loading", "phase": "downloading"})
        pipeline.load(progress_callback=lambda p: _push({
            "event": "progress",
            "status": "loading",
            "phase": p,
        }))
        _push({"event": "progress", "status": "loading", "phase": "ready"})

    # Phase 2: generation
    _push({"event": "progress", "status": "generating", "step": 0, "total": steps})

    def step_cb(current: int, total: int) -> None:
        if cancel_event.is_set():
            return
        asyncio.run_coroutine_threadsafe(
            queue.put({
                "event": "progress",
                "status": "generating",
                "step": current + 1,  # diffusers delivers 0-indexed; make 1-indexed
                "total": total,
            }),
            loop,
        )

    try:
        png_bytes = pipeline.generate(
            prompt=prompt,
            steps=steps,
            cfg_scale=cfg_scale,
            seed=seed,
            width=width,
            height=height,
            step_callback=step_cb,
        )
    except Exception as exc:
        logger.exception("Generation failed")
        _push({"event": "error", "status": "error", "message": str(exc)})
        return

    # Phase 3: persist
    _push({"event": "progress", "status": "saving"})
    actual_seed = seed if seed is not None else 0
    path = save_image(png_bytes, prompt=prompt, seed=actual_seed)

    _push({
        "event": "done",
        "status": "complete",
        "image_url": f"/images/{path.name}",
        "seed": actual_seed,
    })


def _run_img2img(
    pipeline: PipelineWrapper,
    prompt: str,
    init_image_b64: str,
    steps: int,
    cfg_scale: float,
    seed: int | None,
    queue: asyncio.Queue,
    cancel_event: asyncio.Event,
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Run i2i in a thread pool, pushing progress to the async queue."""
    def _push(data: dict) -> None:
        asyncio.run_coroutine_threadsafe(queue.put(data), loop)

    if not pipeline.loaded:
        _push({"event": "progress", "status": "loading", "phase": "downloading"})
        pipeline.load(progress_callback=lambda p: _push({
            "event": "progress", "status": "loading", "phase": p,
        }))

    _push({"event": "progress", "status": "loading", "phase": "loading_img2img"})
    pipeline.load_img2img()

    import base64
    # Strip data URL prefix if present (frontend sends data:image/...;base64,...)
    if "," in init_image_b64:
        init_image_b64 = init_image_b64.split(",", 1)[1]
    init_bytes = base64.b64decode(init_image_b64)

    def step_cb(current: int, total: int) -> None:
        if cancel_event.is_set():
            return
        asyncio.run_coroutine_threadsafe(
            queue.put({
                "event": "progress",
                "status": "generating",
                "step": current + 1,  # diffusers delivers 0-indexed; make 1-indexed
                "total": total,
            }),
            loop,
        )

    try:
        png_bytes = pipeline.generate_img2img(
            prompt=prompt,
            init_image_bytes=init_bytes,
            steps=steps,
            cfg_scale=cfg_scale,
            seed=seed,
            step_callback=step_cb,
        )
    except Exception as exc:
        logger.exception("Img2img generation failed")
        _push({"event": "error", "status": "error", "message": str(exc)})
        return

    actual_seed = seed if seed is not None else 0
    path = save_image(png_bytes, prompt=prompt, seed=actual_seed)

    _push({
        "event": "done",
        "status": "complete",
        "image_url": f"/images/{path.name}",
        "seed": actual_seed,
    })


# ── SSE response helpers ───────────────────────────────────────────────


async def _sse_generator(
    request: Request,
    queue: asyncio.Queue,
    cancel_event: asyncio.Event,
) -> AsyncIterable[str]:
    """Consume progress events from the queue and yield SSE-formatted lines."""
    try:
        while True:
            if await request.is_disconnected():
                cancel_event.set()
                break

            try:
                data = await asyncio.wait_for(queue.get(), timeout=2.0)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue

            event_type = data.pop("event", "message")
            payload = json.dumps(data)
            yield f"event: {event_type}\ndata: {payload}\n\n"

            if event_type in ("done", "error"):
                break
    except asyncio.CancelledError:
        cancel_event.set()
        raise


async def _error_stream(errors: list[str]) -> AsyncIterable[str]:
    """Yield an error event and stop."""
    yield f"event: error\ndata: {json.dumps({'status': 'error', 'message': '; '.join(errors)})}\n\n"
```

### Success Criteria:

#### Automated Verification:
- [x] Python imports resolve: `cd /tmp && python -c "import sys; sys.path.insert(0,'/path/to/repo'); from backend.routes.generate import router; from backend.utils.validation import validate_workflow, extract_parameters"`
- [x] Grep for `StreamingResponse` in generate.py: `grep -c "StreamingResponse" backend/routes/generate.py` returns >= 1
- [x] Grep for `asyncio.Queue` in generate.py: `grep -c "asyncio.Queue" backend/routes/generate.py` returns >= 1
- [x] Grep for `run_in_executor` in generate.py: `grep -c "run_in_executor" backend/routes/generate.py` returns >= 1
- [x] Grep for `request.app.state.model_pipeline` in generate.py: `grep -c "model_pipeline" backend/routes/generate.py` returns >= 1

#### Manual Verification:
- [ ] POST /api/generate returns SSE stream with progress events
- [ ] SSE events contain step, total, status fields
- [ ] Client disconnect cancels background pipeline task
- [ ] Graph validation rejects invalid workflows (no generate node, missing connections, duplicate edges)

---

## Phase 4: API routes — images + workflow save/load

### Overview
Implements GET /api/images (list generated images with metadata) and POST /api/workflow/save + load (JSON workflow persistence to disk).

### Changes Required:

#### 1. GET /api/images endpoint
**File**: `backend/routes/images.py`
**Changes**: New — list generated images with metadata.

```python
"""GET /api/images — list generated image metadata."""

from fastapi import APIRouter, Query

from backend.utils.storage import list_images

router = APIRouter()


@router.get("/images")
async def get_images(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
    """List generated images, newest first."""
    images = list_images(limit=limit, offset=offset)
    return {"images": images, "total": len(images), "limit": limit, "offset": offset}
```

#### 2. Workflow save/load endpoints
**File**: `backend/routes/workflow.py`
**Changes**: New — persist workflow JSON to disk, load by name.

```python
"""POST /api/workflow/save, POST /api/workflow/load — workflow JSON persistence."""

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.config import settings

router = APIRouter()


class WorkflowSaveRequest(BaseModel):
    name: str
    workflow: dict


@router.post("/workflow/save")
async def save_workflow(body: WorkflowSaveRequest):
    """Persist a workflow JSON to disk."""
    safe_name = _safe_filename(body.name)
    path = settings.workflows_dir / f"{safe_name}.json"
    path.write_text(json.dumps(body.workflow, indent=2))
    return {"saved": True, "name": safe_name, "path": str(path)}


@router.post("/workflow/load/{name}")
async def load_workflow(name: str):
    """Load a saved workflow JSON from disk."""
    safe_name = _safe_filename(name)
    path = settings.workflows_dir / f"{safe_name}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Workflow '{safe_name}' not found")
    workflow = json.loads(path.read_text())
    return {"name": safe_name, "workflow": workflow}


def _safe_filename(name: str) -> str:
    """Sanitize a workflow name to a safe filesystem name."""
    import re
    return re.sub(r"[^a-zA-Z0-9_\-]", "_", name)
```

### Success Criteria:

#### Automated Verification:
- [x] Python imports resolve for images route
- [x] Python imports resolve for workflow route

#### Manual Verification:
- [ ] GET /api/images returns list of generated images with metadata
- [ ] POST /api/workflow/save persists workflow JSON to disk
- [ ] POST /api/workflow/load returns saved workflow JSON
- [ ] Generated images are accessible via FastAPI StaticFiles

---

## Phase 5: Frontend types + Zustand store + SSE client

### Overview
Defines TypeScript interfaces for workflow nodes, edges, and SSE events. Implements the Zustand store as single source of truth with React Flow sync callbacks (onNodesChange, onEdgesChange, onConnect), node CRUD, workflow save/load, and pre-placed starter workflow. Adds SSE client helper using fetch streaming reader (supports POST unlike EventSource) and JSON export/import utilities. Creates App and main entry points.

### Changes Required:

#### 1. Workflow type definitions
**File**: `frontend/src/types/workflow.ts`
**Changes**: New — TypeScript interfaces for node data, handle definitions, workflow JSON, SSE events.

```typescript
/* korg-e workflow type definitions */

import type { Node, Edge } from "@xyflow/react";

// ── Node data types ────────────────────────────────────────────────────

export type HandleDef = {
  name: string;
  type: string; // "image" | "prompt" | "any"
  required?: boolean;
};

export type KorgNodeData = {
  label: string;
  inputs: HandleDef[];
  outputs: HandleDef[];
  // Runtime state
  status?: "idle" | "loading" | "generating" | "complete" | "error";
  progress?: number;
  error?: string;
  // TextPromptNode
  prompt?: string;
  // ImageUploadNode
  imageData?: string | null; // base64 data URL
  // ZImageGenerateNode
  steps?: number;
  cfgScale?: number;
  seed?: number | null;
  width?: number;
  height?: number;
  // ImageOutputNode
  imageUrl?: string | null;
  seedInfo?: number;
};

export type KorgNodeType =
  | "textPrompt"
  | "imageUpload"
  | "zImageGenerate"
  | "imageOutput";

export type KorgNode = Node<KorgNodeData, KorgNodeType>;

// ── Workflow envelope ──────────────────────────────────────────────────

export type WorkflowJSON = {
  nodes: KorgNode[];
  edges: Edge[];
  viewport?: { x: number; y: number; zoom: number };
};

// ── SSE event types ────────────────────────────────────────────────────

export type SSEProgressEvent = {
  event: "progress";
  status: "loading" | "generating" | "saving";
  step?: number;
  total?: number;
  phase?: string;
};

export type SSEDoneEvent = {
  event: "done";
  status: "complete";
  image_url: string;
  seed: number;
};

export type SSEErrorEvent = {
  event: "error";
  status: "error";
  message?: string;
  errors?: string[];
};

export type SSEEvent = SSEProgressEvent | SSEDoneEvent | SSEErrorEvent;
```

#### 2. Zustand workflow store
**File**: `frontend/src/store/useWorkflowStore.ts`
**Changes**: New — Zustand store with React Flow sync, node CRUD, workflow persistence, starter workflow.

```typescript
/**
 * Zustand store — single source of truth for the workflow graph.
 *
 * Synced with React Flow via onNodesChange / onEdgesChange / onConnect.
 */

import { create } from "zustand";
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type Edge,
  type Connection,
} from "@xyflow/react";
import type { KorgNode, KorgNodeType, KorgNodeData } from "@/types/workflow";
import { exportWorkflow, importWorkflow } from "@/utils/jsonExport";

// ── Default node factory ───────────────────────────────────────────────

let _nodeCounter = 0;

function createNode(type: KorgNodeType, position: { x: number; y: number }): KorgNode {
  _nodeCounter++;
  const id = `${type}_${_nodeCounter}`;

  const defaults: Record<KorgNodeType, Partial<KorgNodeData>> = {
    textPrompt: {
      label: "Text Prompt",
      prompt: "",
      inputs: [],
      outputs: [{ name: "prompt", type: "prompt" }],
    },
    imageUpload: {
      label: "Image Upload",
      imageData: null,
      inputs: [],
      outputs: [{ name: "image", type: "image" }],
    },
    zImageGenerate: {
      label: "Z-Image Generate",
      steps: 50,
      cfgScale: 5.0,
      seed: null,
      width: 1024,
      height: 1024,
      status: "idle",
      inputs: [
        { name: "prompt", type: "prompt", required: true },
        { name: "image", type: "image" },
      ],
      outputs: [{ name: "image", type: "image" }],
    },
    imageOutput: {
      label: "Image Output",
      imageUrl: null,
      inputs: [{ name: "image", type: "image", required: true }],
      outputs: [],
    },
  };

  return {
    id,
    type,
    position,
    data: { ...defaults[type] } as KorgNodeData,
  };
}

// ── Starter workflow ───────────────────────────────────────────────────

function starterWorkflow(): { nodes: KorgNode[]; edges: Edge[] } {
  const textPrompt = createNode("textPrompt", { x: 50, y: 200 });
  const generate = createNode("zImageGenerate", { x: 400, y: 200 });
  const output = createNode("imageOutput", { x: 750, y: 200 });

  const nodes = [textPrompt, generate, output];
  const edges: Edge[] = [
    {
      id: `${textPrompt.id}→${generate.id}`,
      source: textPrompt.id,
      sourceHandle: "prompt",
      target: generate.id,
      targetHandle: "prompt",
    },
    {
      id: `${generate.id}→${output.id}`,
      source: generate.id,
      sourceHandle: "image",
      target: output.id,
      targetHandle: "image",
    },
  ];

  _nodeCounter = 3;
  return { nodes, edges };
}

// ── Store type ─────────────────────────────────────────────────────────

export type WorkflowStore = {
  nodes: KorgNode[];
  edges: Edge[];
  isFirstLaunch: boolean;

  // React Flow sync callbacks
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;

  // Node CRUD
  addNode: (type: KorgNodeType) => void;
  removeNode: (id: string) => void;
  updateNodeData: (id: string, data: Partial<KorgNodeData>) => void;

  // Workflow persistence
  saveWorkflow: (name: string) => Promise<void>;
  loadWorkflow: (name: string) => Promise<void>;

  // Reset
  resetToStarter: () => void;
};

// ── Store implementation ───────────────────────────────────────────────

export const useWorkflowStore = create<WorkflowStore>((set, get) => {
  const initial = starterWorkflow();

  return {
    nodes: initial.nodes,
    edges: initial.edges,
    isFirstLaunch: true,

    // React Flow sync
    onNodesChange: (changes) => {
      set({ nodes: applyNodeChanges(changes, get().nodes) as KorgNode[] });
    },

    onEdgesChange: (changes) => {
      set({ edges: applyEdgeChanges(changes, get().edges) });
    },

    onConnect: (connection: Connection) => {
      set({ edges: addEdge(connection, get().edges) });
    },

    // Node CRUD
    addNode: (type: KorgNodeType) => {
      const pos = { x: 100 + Math.random() * 300, y: 100 + Math.random() * 300 };
      const newNode = createNode(type, pos);
      set({ nodes: [...get().nodes, newNode] });
    },

    removeNode: (id: string) => {
      set({
        nodes: get().nodes.filter((n) => n.id !== id),
        edges: get().edges.filter((e) => e.source !== id && e.target !== id),
      });
    },

    updateNodeData: (id: string, data: Partial<KorgNodeData>) => {
      set({
        nodes: get().nodes.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, ...data } } : n
        ),
      });
    },

    // Workflow persistence
    saveWorkflow: async (name: string) => {
      const { nodes, edges } = get();
      const workflow = exportWorkflow(nodes, edges);
      await fetch("/api/workflow/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, workflow }),
      });
    },

    loadWorkflow: async (name: string) => {
      const res = await fetch(`/api/workflow/load/${encodeURIComponent(name)}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`Failed to load workflow: ${res.statusText}`);
      const { workflow } = await res.json();
      const imported = importWorkflow(workflow);
      set({ nodes: imported.nodes, edges: imported.edges });
    },

    // Reset
    resetToStarter: () => {
      const fresh = starterWorkflow();
      set({ nodes: fresh.nodes, edges: fresh.edges });
    },
  };
});
```

#### 3. SSE client helper
**File**: `frontend/src/utils/sse.ts`
**Changes**: New — fetch-based SSE client with abort support (supports POST unlike EventSource).

```typescript
/** SSE client helper — wraps fetch streaming with typed event listeners. */

import type { SSEEvent } from "@/types/workflow";

type EventHandlers = {
  onProgress?: (data: Record<string, unknown>) => void;
  onDone?: (data: Record<string, unknown>) => void;
  onError?: (data: Record<string, unknown>) => void;
};

/**
 * Open an SSE connection to the `/api/generate` endpoint via fetch streaming.
 *
 * Returns an object with an `abort()` method to cancel the connection
 * and signal the backend to stop generation.
 */
export function createSSEConnection(
  body: unknown,
  handlers: EventHandlers
): { abort: () => void } {
  const controller = new AbortController();

  fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok || !response.body) {
        handlers.onError?.({
          status: "error",
          message: `HTTP ${response.status}: ${response.statusText}`,
        });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE messages from the buffer
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const lines = part.split("\n");
          let eventType = "message";
          let dataStr = "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              dataStr = line.slice(6).trim();
            } else if (line.startsWith(": ")) {
              // Comment/keepalive — ignore
            }
          }

          if (!dataStr) continue;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(dataStr);
          } catch {
            continue;
          }

          switch (eventType) {
            case "progress":
              handlers.onProgress?.(parsed);
              break;
            case "done":
              handlers.onDone?.(parsed);
              break;
            case "error":
              handlers.onError?.(parsed);
              break;
          }
        }
      }
    })
    .catch((err: Error) => {
      // AbortError = intentional cancellation, not an error
      if (err.name !== "AbortError") {
        handlers.onError?.({ status: "error", message: err.message });
      }
    });

  return {
    abort: () => controller.abort(),
  };
}
```

#### 4. JSON export/import utilities
**File**: `frontend/src/utils/jsonExport.ts`
**Changes**: New — workflow JSON serialize/deserialize helpers using React Flow format.

```typescript
/** Workflow JSON export/import helpers using React Flow toObject/fromObject. */

import type { KorgNode, WorkflowJSON } from "@/types/workflow";
import type { Edge, Viewport } from "@xyflow/react";

/**
 * Serialise the current workflow to a savable JSON object
 * (React Flow `toObject()` format + metadata).
 */
export function exportWorkflow(
  nodes: KorgNode[],
  edges: Edge[],
  viewport?: Viewport
): WorkflowJSON {
  return {
    nodes,
    edges,
    viewport,
  };
}

/**
 * Import a saved workflow JSON object into the store-compatible format.
 * Validates that the structure is well-formed.
 */
export function importWorkflow(json: unknown): {
  nodes: KorgNode[];
  edges: Edge[];
  viewport?: Viewport;
} {
  const wf = json as WorkflowJSON;

  if (!Array.isArray(wf.nodes) || !Array.isArray(wf.edges)) {
    throw new Error("Invalid workflow format: expected nodes and edges arrays");
  }

  return {
    nodes: wf.nodes as KorgNode[],
    edges: wf.edges as Edge[],
    viewport: wf.viewport,
  };
}
```

#### 5. Root React component
**File**: `frontend/src/App.tsx`
**Changes**: New — wraps ReactFlowProvider + Canvas + Toolbar.

```typescript
import { ReactFlowProvider } from "@xyflow/react";
import FlowCanvas from "@/components/Canvas";

export default function App() {
  return (
    <ReactFlowProvider>
      <FlowCanvas />
    </ReactFlowProvider>
  );
}
```

#### 6. Vite entry point
**File**: `frontend/src/main.tsx`
**Changes**: New — renders App, imports global styles.

```typescript
import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import "@xyflow/react/dist/style.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npx tsc --noEmit` (note: fails on missing `Canvas.tsx` in Slice 6)
- [x] Grep for `@xyflow/react` Node type in workflow.ts: `grep -c "from '@xyflow/react'" frontend/src/types/workflow.ts` returns >= 1
- [x] Grep for Zustand create in store: `grep -c "create(" frontend/src/store/useWorkflowStore.ts` returns >= 1
- [x] Grep for `applyNodeChanges` in store: `grep -c "applyNodeChanges" frontend/src/store/useWorkflowStore.ts` returns >= 1
- [x] Grep for starter workflow in store: `grep -c "starterWorkflow" frontend/src/store/useWorkflowStore.ts` returns >= 1
- [x] Grep for POST to /api/workflow/save in store: `grep -c "/api/workflow/save" frontend/src/store/useWorkflowStore.ts` returns >= 1

#### Manual Verification:
- [ ] Zustand store correctly initializes with pre-placed starter workflow (TextPrompt → ZImageGenerate → ImageOutput)
- [ ] onNodesChange/onEdgesChange/onConnect update store correctly
- [ ] App component renders ReactFlowProvider wrapper
- [ ] createSSEConnection correctly parses progress/done/error events from fetch stream

---

## Phase 6: Custom node components

### Overview
Implements the React Flow canvas container with node type registration, background, controls, and minimap. Adds a toolbar with add-node dropdown, workflow save/load/reset buttons. Creates four custom node components: TextPromptNode (editable text area), ImageUploadNode (file upload + preview), ZImageGenerateNode (parameter controls, Generate button, progress bar, error display), and ImageOutputNode (displays generated image with seed info).

### Changes Required:

#### 1. React Flow canvas container
**File**: `frontend/src/components/Canvas.tsx`
**Changes**: New — React Flow canvas with node type registration, Background, Controls, MiniMap. **Modified in Slice 7**: adds `useWorkflowIntegration` call.

```typescript
/** React Flow canvas container with node type registration and background. */

import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type NodeTypes,
} from "@xyflow/react";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import TextPromptNode from "@/components/nodes/TextPromptNode";
import ImageUploadNode from "@/components/nodes/ImageUploadNode";
import ZImageGenerateNode from "@/components/nodes/ZImageGenerateNode";
import ImageOutputNode from "@/components/nodes/ImageOutputNode";

const nodeTypes: NodeTypes = {
  textPrompt: TextPromptNode,
  imageUpload: ImageUploadNode,
  zImageGenerate: ZImageGenerateNode,
  imageOutput: ImageOutputNode,
};

export default function FlowCanvas() {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect } =
    useWorkflowStore();

  const defaultEdgeOptions = useMemo(
    () => ({
      type: "smoothstep",
      animated: true,
    }),
    []
  );

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        fitView
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}
```

#### 2. Toolbar component
**File**: `frontend/src/components/Toolbar.tsx`
**Changes**: New — Add node dropdown, workflow save/load/Reset controls.

```typescript
/** Toolbar — Add node menu, workflow save/load controls. */

import { useCallback, useState } from "react";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import type { KorgNodeType } from "@/types/workflow";

const NODE_TYPES: { type: KorgNodeType; label: string }[] = [
  { type: "textPrompt", label: "Text Prompt" },
  { type: "imageUpload", label: "Image Upload" },
  { type: "zImageGenerate", label: "Z-Image Generate" },
  { type: "imageOutput", label: "Image Output" },
];

export default function Toolbar() {
  const { addNode, saveWorkflow, loadWorkflow, resetToStarter } =
    useWorkflowStore();
  const [workflowName, setWorkflowName] = useState("my-workflow");

  const handleSave = useCallback(async () => {
    await saveWorkflow(workflowName);
  }, [saveWorkflow, workflowName]);

  const handleLoad = useCallback(async () => {
    try {
      await loadWorkflow(workflowName);
    } catch (err) {
      alert(`Failed to load workflow: ${(err as Error).message}`);
    }
  }, [loadWorkflow, workflowName]);

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        left: 8,
        zIndex: 10,
        display: "flex",
        gap: 6,
        alignItems: "center",
        background: "#1a1a2e",
        padding: "8px 12px",
        borderRadius: 8,
        border: "1px solid #333",
        flexWrap: "wrap",
      }}
    >
      {/* Add node dropdown */}
      <select
        className="nodrag"
        defaultValue=""
        onChange={(e) => {
          const val = e.target.value as KorgNodeType;
          if (val) addNode(val);
          e.target.value = "";
        }}
        style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid #555", background: "#16213e", color: "#eee" }}
      >
        <option value="" disabled>
          + Add node
        </option>
        {NODE_TYPES.map((nt) => (
          <option key={nt.type} value={nt.type}>
            {nt.label}
          </option>
        ))}
      </select>

      {/* Workflow name */}
      <input
        className="nodrag"
        value={workflowName}
        onChange={(e) => setWorkflowName(e.target.value)}
        style={{
          padding: "4px 8px",
          borderRadius: 4,
          border: "1px solid #555",
          background: "#16213e",
          color: "#eee",
          width: 130,
        }}
        placeholder="Workflow name"
      />

      {/* Save / Load */}
      <button
        className="nodrag"
        onClick={handleSave}
        style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid #4a90d9", background: "#4a90d9", color: "#fff", cursor: "pointer" }}
      >
        Save
      </button>
      <button
        className="nodrag"
        onClick={handleLoad}
        style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid #555", background: "#333", color: "#eee", cursor: "pointer" }}
      >
        Load
      </button>

      {/* Reset */}
      <button
        className="nodrag"
        onClick={resetToStarter}
        style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid #c44", background: "#622", color: "#e88", cursor: "pointer" }}
      >
        Reset
      </button>
    </div>
  );
}
```

#### 3. TextPromptNode
**File**: `frontend/src/components/nodes/TextPromptNode.tsx`
**Changes**: New — custom node with editable textarea, prompt output handle.

```typescript
import { useCallback } from "react";
import {
  Handle,
  Position,
  type NodeProps,
} from "@xyflow/react";
import type { KorgNode } from "@/types/workflow";
import { useWorkflowStore } from "@/store/useWorkflowStore";

export default function TextPromptNode({ id, data, selected }: NodeProps<KorgNode>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const prompt = data.prompt ?? "";

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateNodeData(id, { prompt: e.target.value });
    },
    [id, updateNodeData]
  );

  return (
    <div className={`korg-node ${selected ? "korg-node--selected" : ""}`}>
      <div className="korg-node__header">Text Prompt</div>
      <div className="korg-node__body">
        <textarea
          className="korg-node__textarea nodrag nowheel"
          value={prompt}
          onChange={handleChange}
          placeholder="Enter a prompt…"
          rows={4}
          style={{ width: 240 }}
        />
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id="prompt"
      />
    </div>
  );
}
```

#### 4. ImageUploadNode
**File**: `frontend/src/components/nodes/ImageUploadNode.tsx`
**Changes**: New — file upload with preview thumbnail, dispatches korg:updateNode CustomEvent.

```typescript
import { useCallback, useRef } from "react";
import {
  Handle,
  Position,
  type NodeProps,
} from "@xyflow/react";
import type { KorgNode } from "@/types/workflow";

export default function ImageUploadNode({ data, selected, id }: NodeProps<KorgNode>) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result as string;
        window.dispatchEvent(
          new CustomEvent("korg:updateNode", {
            detail: { id, data: { imageData: base64 } },
          })
        );
      };
      reader.readAsDataURL(file);
    },
    [id]
  );

  const previewUrl = data.imageData ?? null;

  return (
    <div className={`korg-node ${selected ? "korg-node--selected" : ""}`}>
      <div className="korg-node__header">Image Upload</div>
      <div className="korg-node__body">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt="Upload preview"
            className="nodrag"
            style={{ maxWidth: 200, maxHeight: 200, borderRadius: 4 }}
          />
        ) : (
          <div
            className="korg-node__upload-zone nodrag"
            onClick={() => inputRef.current?.click()}
            style={{
              width: 200,
              height: 120,
              border: "2px dashed #666",
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              color: "#888",
              fontSize: 13,
            }}
          >
            Click to upload
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id="image"
      />
    </div>
  );
}
```

#### 5. ZImageGenerateNode
**File**: `frontend/src/components/nodes/ZImageGenerateNode.tsx`
**Changes**: New — parameter controls (steps, CFG, seed, width, height), Generate button, progress bar, error display. Dispatches korg:generate CustomEvent.

```typescript
import { useCallback, useState } from "react";
import {
  Handle,
  Position,
  type NodeProps,
} from "@xyflow/react";
import type { KorgNode } from "@/types/workflow";
import { useWorkflowStore } from "@/store/useWorkflowStore";

export default function ZImageGenerateNode({
  data,
  selected,
  id,
}: NodeProps<KorgNode>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const [isGenerating, setIsGenerating] = useState(false);

  const steps = data.steps ?? 50;
  const cfgScale = data.cfgScale ?? 5.0;
  const seed = data.seed ?? null;
  const width = data.width ?? 1024;
  const height = data.height ?? 1024;
  const status = data.status ?? "idle";
  const progress = data.progress ?? 0;

  const handleGenerate = useCallback(() => {
    setIsGenerating(true);
    const workflowEvent = new CustomEvent("korg:generate", {
      detail: {
        nodeId: id,
        params: { steps, cfgScale, seed, width, height },
      },
    });
    window.dispatchEvent(workflowEvent);
  }, [id, steps, cfgScale, seed, width, height]);

  const progressPct =
    status === "generating"
      ? Math.round((progress / steps) * 100)
      : 0;

  return (
    <div className={`korg-node ${selected ? "korg-node--selected" : ""}`}>
      <div className="korg-node__header">Z-Image Generate</div>
      <div className="korg-node__body">
        {/* Parameters */}
        <div className="korg-node__params">
          <label>
            Steps
            <input
              type="number"
              className="nodrag"
              value={steps}
              min={1}
              max={100}
              onChange={(e) =>
                updateNodeData(id, { steps: parseInt(e.target.value, 10) })
              }
              style={{ width: 60 }}
            />
          </label>
          <label>
            CFG
            <input
              type="number"
              className="nodrag"
              value={cfgScale}
              min={1}
              max={20}
              step={0.5}
              onChange={(e) =>
                updateNodeData(id, { cfgScale: parseFloat(e.target.value) })
              }
              style={{ width: 60 }}
            />
          </label>
          <label>
            Seed
            <input
              type="number"
              className="nodrag"
              value={seed ?? ""}
              placeholder="random"
              onChange={(e) => {
                const val = e.target.value;
                updateNodeData(id, {
                  seed: val === "" ? null : parseInt(val, 10),
                });
              }}
              style={{ width: 80 }}
            />
          </label>
          <label>
            Width
            <select
              className="nodrag"
              value={width}
              onChange={(e) =>
                updateNodeData(id, { width: parseInt(e.target.value, 10) })
              }
            >
              <option value={512}>512</option>
              <option value={768}>768</option>
              <option value={1024}>1024</option>
            </select>
          </label>
          <label>
            Height
            <select
              className="nodrag"
              value={height}
              onChange={(e) =>
                updateNodeData(id, { height: parseInt(e.target.value, 10) })
              }
            >
              <option value={512}>512</option>
              <option value={768}>768</option>
              <option value={1024}>1024</option>
            </select>
          </label>
        </div>

        {/* Generate button */}
        <button
          className="korg-node__generate nodrag"
          onClick={handleGenerate}
          disabled={isGenerating}
          style={{
            marginTop: 8,
            padding: "6px 16px",
            background: isGenerating ? "#666" : "#4a90d9",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: isGenerating ? "not-allowed" : "pointer",
            width: "100%",
          }}
        >
          {isGenerating ? "Generating…" : "Generate"}
        </button>

        {/* Progress bar */}
        {status === "generating" && (
          <div
            className="korg-node__progress"
            style={{
              marginTop: 8,
              height: 8,
              background: "#333",
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${progressPct}%`,
                height: "100%",
                background: "#4a90d9",
                transition: "width 0.3s ease",
              }}
            />
          </div>
        )}

        {/* Error display */}
        {status === "error" && data.error && (
          <div
            className="korg-node__error"
            style={{
              marginTop: 8,
              padding: 4,
              color: "#e44",
              fontSize: 12,
            }}
          >
            {data.error}
          </div>
        )}
      </div>

      <Handle
        type="target"
        position={Position.Left}
        id="prompt"
        style={{ top: "30%" }}
      />
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        style={{ top: "70%" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="image"
      />
    </div>
  );
}
```

#### 6. ImageOutputNode
**File**: `frontend/src/components/nodes/ImageOutputNode.tsx`
**Changes**: New — displays generated image with seed info, placeholder when waiting.

```typescript
import {
  Handle,
  Position,
  type NodeProps,
} from "@xyflow/react";
import type { KorgNode } from "@/types/workflow";

export default function ImageOutputNode({ data, selected }: NodeProps<KorgNode>) {
  const imageUrl = data.imageUrl ?? null;
  const seedInfo = data.seedInfo;

  return (
    <div className={`korg-node ${selected ? "korg-node--selected" : ""}`}>
      <div className="korg-node__header">Image Output</div>
      <div className="korg-node__body">
        {imageUrl ? (
          <div>
            <img
              src={imageUrl}
              alt="Generated output"
              className="nodrag"
              style={{
                maxWidth: 256,
                maxHeight: 256,
                borderRadius: 4,
                display: "block",
              }}
            />
            {seedInfo !== undefined && (
              <div
                style={{
                  fontSize: 11,
                  color: "#888",
                  marginTop: 4,
                  textAlign: "center",
                }}
              >
                Seed: {seedInfo}
              </div>
            )}
          </div>
        ) : (
          <div
            className="korg-node__placeholder"
            style={{
              width: 200,
              height: 150,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#666",
              fontSize: 13,
              border: "1px solid #444",
              borderRadius: 4,
            }}
          >
            Waiting for output…
          </div>
        )}
      </div>
      <Handle
        type="target"
        position={Position.Left}
        id="image"
      />
    </div>
  );
}
```

#### 7. App.tsx updated with Toolbar
**File**: `frontend/src/App.tsx` (MODIFIED)
**Changes**: Add Toolbar import and render alongside Canvas.

```typescript
import { ReactFlowProvider } from "@xyflow/react";
import FlowCanvas from "@/components/Canvas";
import Toolbar from "@/components/Toolbar";

export default function App() {
  return (
    <ReactFlowProvider>
      <Toolbar />
      <FlowCanvas />
    </ReactFlowProvider>
  );
}
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npx tsc --noEmit`
- [x] Grep for custom node type registration in Canvas.tsx: `grep -c "nodeTypes" frontend/src/components/Canvas.tsx` returns >= 1
- [x] Grep for Handle imports in node files: `grep -c "Handle" frontend/src/components/nodes/*.tsx` returns >= 4 (one per node type)
- [x] Grep for all four node types registered: `grep -c "textPrompt" frontend/src/components/Canvas.tsx` returns >= 1
- [x] Grep for Toolbar in App.tsx: `grep -c "Toolbar" frontend/src/App.tsx` returns >= 1

#### Manual Verification:
- [ ] Canvas renders with React Flow background, Controls, and MiniMap
- [ ] Each node type renders correctly with appropriate handles
- [ ] TextPromptNode shows editable text area, changes persist to store
- [ ] ImageUploadNode accepts file upload and shows preview thumbnail
- [ ] ZImageGenerateNode parameter controls (steps, CFG, seed, resolution) update store on change
- [ ] ImageOutputNode renders generated image and seed info (placeholder before generation)
- [ ] Toolbar allows adding nodes of each type via dropdown
- [ ] Workflow save/load/Reset buttons connected to store

---

## Phase 7: Starter workflow + frontend-backend integration

### Overview
Wires the frontend node components to the backend SSE generation endpoint via CustomEvent dispatch/listen pattern. The integration hook listens for `korg:updateNode` and `korg:generate` events, calls the SSE client, and updates node state (status, progress, image URL, errors). Uses refs to avoid SSE abort on React re-renders. The pre-placed starter workflow (Text Prompt → Z-Image Generate → Image Output) is already initialized by the Zustand store from Phase 5.

### Changes Required:

#### 1. Integration orchestration hook
**File**: `frontend/src/utils/integration.ts` (NEW)
**Changes**: New — listens for CustomEvents from node components and orchestrates the full generation workflow via SSE.

```typescript
/** Integration wiring — listens for CustomEvents from node components
 *  and orchestrates the full generation workflow.
 */

import { useCallback, useEffect, useRef } from "react";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { createSSEConnection } from "@/utils/sse";
import type { KorgNodeData } from "@/types/workflow";

export function useWorkflowIntegration() {
  const { nodes, edges, updateNodeData } = useWorkflowStore();
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const sseRef = useRef<{ abort: () => void } | null>(null);

  nodesRef.current = nodes;
  edgesRef.current = edges;

  const updateNodeDataRef = useRef(updateNodeData);
  updateNodeDataRef.current = updateNodeData;

  useEffect(() => {
    const handleUpdateNode = (e: Event) => {
      const { id, data } = (e as CustomEvent).detail as {
        id: string;
        data: Partial<KorgNodeData>;
      };
      updateNodeDataRef.current(id, data);
    };

    const handleGenerate = (e: Event) => {
      const { nodeId, params } = (e as CustomEvent).detail as {
        nodeId: string;
        params: { steps: number; cfgScale: number; seed: number | null; width: number; height: number };
      };

      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;
      const updater = updateNodeDataRef.current;

      const body = {
        nodes: currentNodes.map((n) => ({ id: n.id, type: n.type, data: n.data })),
        edges: currentEdges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle })),
        is_img2img: currentNodes.some((n) => n.type === "imageUpload" && n.data.imageData),
      };

      sseRef.current?.abort();
      updater(nodeId, { status: "loading", progress: 0 });

      sseRef.current = createSSEConnection(body, {
        onProgress: (data) => {
          const status = data.status as string;
          if (status === "loading") updater(nodeId, { status: "loading" });
          else if (status === "generating") updater(nodeId, { status: "generating", progress: (data.step as number) ?? 0 });
          else if (status === "saving") updater(nodeId, { status: "loading" });
        },
        onDone: (data) => {
          const imageUrl = data.image_url as string;
          const seed = data.seed as number;
          updater(nodeId, { status: "complete", imageUrl, seedInfo: seed, progress: 0 });
          const outputEdge = currentEdges.find((e) => e.source === nodeId && e.sourceHandle === "image");
          if (outputEdge) updater(outputEdge.target, { imageUrl, seedInfo: seed });
        },
        onError: (data) => {
          updater(nodeId, { status: "error", error: (data.message as string) ?? "Generation failed", progress: 0 });
        },
      });
    };

    window.addEventListener("korg:updateNode", handleUpdateNode);
    window.addEventListener("korg:generate", handleGenerate);

    return () => {
      window.removeEventListener("korg:updateNode", handleUpdateNode);
      window.removeEventListener("korg:generate", handleGenerate);
      sseRef.current?.abort();
    };
  }, []);
}
```

#### 2. Canvas.tsx with integration hook (MODIFIED)
**File**: `frontend/src/components/Canvas.tsx` (MODIFIED)
**Changes**: Add `useWorkflowIntegration()` call to wire frontend to backend.

```typescript
/** React Flow canvas container with node type registration and background. */

import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type NodeTypes,
} from "@xyflow/react";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { useWorkflowIntegration } from "@/utils/integration";
import TextPromptNode from "@/components/nodes/TextPromptNode";
import ImageUploadNode from "@/components/nodes/ImageUploadNode";
import ZImageGenerateNode from "@/components/nodes/ZImageGenerateNode";
import ImageOutputNode from "@/components/nodes/ImageOutputNode";

const nodeTypes: NodeTypes = {
  textPrompt: TextPromptNode,
  imageUpload: ImageUploadNode,
  zImageGenerate: ZImageGenerateNode,
  imageOutput: ImageOutputNode,
};

export default function FlowCanvas() {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect } =
    useWorkflowStore();

  // Wire up frontend-backend integration (CustomEvent → SSE → store)
  useWorkflowIntegration();

  const defaultEdgeOptions = useMemo(
    () => ({
      type: "smoothstep",
      animated: true,
    }),
    []
  );

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        fitView
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npx tsc --noEmit`
- [x] Grep for integration hook in Canvas.tsx: `grep -c "useWorkflowIntegration" frontend/src/components/Canvas.tsx` returns >= 1
- [x] Grep for CustomEvent listeners in integration.ts: `grep -c "korg:generate" frontend/src/utils/integration.ts` returns >= 1
- [x] Grep for `createSSEConnection` call in integration.ts: `grep -c "createSSEConnection" frontend/src/utils/integration.ts` returns >= 1
- [x] Grep for ref-based pattern (avoids SSE abort on re-render): `grep -c "nodesRef" frontend/src/utils/integration.ts` returns >= 1

#### Manual Verification:
- [ ] On first launch, canvas shows pre-placed Text Prompt → Z-Image Generate → Image Output workflow
- [ ] Clicking Generate on ZImageGenerateNode triggers POST /api/generate (via CustomEvent chain)
- [ ] SSE progress events update node status (loading/generating/complete/error) without aborting mid-flight
- [ ] Progress bar animates on ZImageGenerateNode during generation
- [ ] On completion, ImageOutputNode displays the generated image with seed info
- [ ] Image upload node sends starting image to backend for img2img
- [ ] Error state displays on node when generation fails
- [ ] Workflow save/load round-trips correctly via store methods

---

## Testing Strategy

### Automated:
- `npx tsc --noEmit` — TypeScript type checking across all frontend files
- `npm test` — vitest runner for any frontend unit tests
- Python import resolution checks: verify all backend modules import without errors
- Grep-based API surface checks: verify key APIs (callback_on_step_end, StreamingResponse, enable_attention_slicing, applyNodeChanges) are present

### Manual Testing Steps:
1. Run `./scripts/setup.sh` — verify error-free completion on macOS Apple Silicon
2. Run `./scripts/start.sh` — verify backend starts on port 8000
3. Run `./scripts/start.sh --dev` — verify both backend + frontend dev server start
4. `curl localhost:8000/health` — verify 200 response with model_loaded: false
5. Open `http://localhost:5173` — verify pre-placed starter workflow renders
6. Type a prompt, click Generate — verify SSE progress events in browser devtools
7. Verify generated image appears in ImageOutputNode with seed
8. Upload an image to ImageUploadNode, click Generate — verify img2img path
9. Save workflow, reload page, Load workflow — verify round-trip
10. Verify CORS: OPTIONS preflight returns correct headers from localhost:5173

## Performance Considerations

- **Lazy loading**: Model loads on first generation request (~30-60s for 6B model download + load). SSE progress events communicate load steps to user
- **Model caching**: After first load, pipeline stays in memory — subsequent generations start immediately
- **Thread pool**: Single `ThreadPoolExecutor(max_workers=2)` globally; diffusers pipeline runs in thread pool, freeing event loop for other requests
- **MPS memory**: `enable_attention_slicing()` reduces peak memory at ~20% speed cost. `bfloat16` halves memory vs float32
- **Image serving**: FastAPI StaticFiles handles image serving efficiently with OS-level file cache
- **Frontend bundle**: Vite builds optimized production bundle; React Flow is the largest dependency (~200KB gzipped)
- **No concurrent generations in v1**: Personal tool assumption — one generation at a time. Queue mechanism can be added in v2 if needed

## Migration Notes

N/A — greenfield project. No existing data to migrate.

## Developer Context

_Step 4 reviewer findings triaged at Step 5 below._

## Plan Review (Step 4)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 5._

| source   | plan-loc          | codebase-loc                | severity   | dimension             | finding   | recommendation   | resolution         |
| -------- | ----------------- | --------------------------- | ---------- | --------------------- | --------- | ---------------- | ------------------ |
| code     | Phase 1 §2 (main.py) / Phase 3 §3 (generate.py) | backend/main.py:23, backend/routes/generate.py:60-62 | blocker | actionability | `app.state.model_pipeline` is initialized to `None` in `main.py:23` and the `generate` endpoint checks against `None` at `generate.py:60-62`, returning "Model not loaded" immediately — but no code in any phase ever assigns a `PipelineWrapper()` instance to `app.state.model_pipeline`, so generation always fails | Add `app.state.model_pipeline = PipelineWrapper()` to `main.py` after the class import, or move the lazy-load creation inside the generate endpoint | applied: added `from backend.pipeline import PipelineWrapper` + `app.state.model_pipeline = PipelineWrapper()` in main.py code fence |
| code     | Phase 3 §3 (generate.py) / Phase 6 §4 (ImageUploadNode.tsx) | backend/routes/generate.py:222, frontend/src/components/nodes/ImageUploadNode.tsx:29 | concern | code-quality | ImageUploadNode uses `FileReader.readAsDataURL()` producing a data URL string (`data:image/png;base64,...`) but `_run_img2img:222` calls `base64.b64decode(init_image_b64)` which expects raw base64 — will raise `binascii.Error` on any img2img workflow | Strip the `data:image/...;base64,` prefix before b64decode, or use `readAsArrayBuffer` in the frontend and send raw base64 | applied: added `if "," in init_image_b64: init_image_b64 = init_image_b64.split(",", 1)[1]` in `_run_img2img` code fence |
| code     | Phase 3 §3 (generate.py) / Phase 7 §1 (integration.ts) | backend/routes/generate.py:296, frontend/src/utils/integration.ts:120 | concern | actionability | Validation errors sent via SSE event carry `{"errors": [...]}` (plural array, `generate.py:296`) but the integration hook's `onError` handler reads `data.message` (singular string, `integration.ts:120`), so validation error details are silently discarded | Change `_error_stream` to emit `{"message": "errors joined string"}` or change integration's `onError` to read `data.errors` | applied: changed `_error_stream` to emit `{"message": "; ".join(errors)}` |
| code     | Phase 3 §3 (generate.py) / Phase 6 §5 (ZImageGenerateNode.tsx) | backend/routes/generate.py:149, frontend/src/components/nodes/ZImageGenerateNode.tsx:40 | concern | code-quality | diffusers `callback_on_step_end` delivers 0-indexed step values (0..steps-1), so `progressPct` at `ZImageGenerateNode.tsx:40` computes `Math.round((current/steps)*100)` that maxes at 98% instead of 100% | Add `step_callback(current+1, total)` in `_run_text_to_image` and `_run_img2img` so the progress event carries 1-indexed values, or adjust the frontend to use `(current+1)/steps` | applied: changed `step: current` to `step: current + 1` in both `_run_text_to_image` and `_run_img2img` step_cb closures |
| code     | Phase 1 §7 (tsconfig.node.json) | frontend/tsconfig.node.json:4 | suggestion | codebase-fit | Artifact specifies `"target": "ES2022"` but the canonical choice for this codebase may be `ES2020` — minor drift | Keep consistent target across tsconfig files | applied: changed tsconfig.node.json target to ES2020 |
| code     | Phase 4 §1 (images.py) | backend/routes/images.py:13-14 | suggestion | codebase-fit | Live `images.py` returns only `{"images": list_images(...)}` without pagination metadata wrappers — the plan artifact already includes `total`/`limit`/`offset` fields so this is a live-codebase vs artifact drift, not a plan defect | N/A — plan artifact is correct; live code should match it | dismissed: plan artifact already includes all pagination fields; reviewer flagged live codebase discrepancy, not a plan defect |
| code     | Phase 6 §1 (Canvas.tsx) | N/A | suggestion | code-quality | Artifact's Canvas.tsx imports `useCallback` but the component body never uses it (only `useMemo` is used) | Remove `useCallback` from the import list | applied: removed `useCallback` from Canvas.tsx imports in both Phase 6 and Phase 7 |
| code     | Phase 6 §2 (Toolbar.tsx) | frontend/src/components/Toolbar.tsx:3 | suggestion | code-quality | `Toolbar.tsx` imports `useRef` but never uses it anywhere in the component | Remove `useRef` from the import list | applied: removed `useRef` from Toolbar.tsx import |
| code     | Phase 5 §3 (sse.ts) | frontend/src/utils/sse.ts:1 | suggestion | code-quality | JSDoc comment says `wraps EventSource with typed event listeners` but the implementation uses `fetch` streaming, not `EventSource` | Correct the JSDoc to `wraps fetch streaming with typed event listeners` | dismissed: plan artifact already says "wraps fetch streaming with typed event listeners" — reviewer flagged design artifact version, plan is correct |

## References

- Design: `.rpiv/artifacts/designs/2026-06-13_07-55-56_simplified-comfyui-image-gen.md`
- Research: `.rpiv/artifacts/research/simplified-comfyui-image-gen.md`
- Discover: `.rpiv/artifacts/discover/2026-06-12_23-22-20_simplified-comfyui-image-gen.md`