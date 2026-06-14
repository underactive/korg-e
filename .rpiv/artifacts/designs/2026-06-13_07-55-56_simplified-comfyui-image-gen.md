---
date: 2026-06-13T07:55:56-0700
author: Eric Sison
commit: no-commit
branch: no-branch
repository: korg-e
topic: "Simplified ComfyUI-like Image Generation Webapp"
tags: [design, z-image, fastapi, react-flow, diffusers, greenfield]
status: ready
parent: 2026-06-13_07-55-56
last_updated: 2026-06-13T07:55:56-0700
last_updated_by: Eric Sison
---

# Design: Simplified ComfyUI-like Image Generation Webapp

## Summary

Build a standalone web application that provides a simplified node-graph interface (like ComfyUI) for generating images using the Z-Image foundation model via HuggingFace diffusers. The architecture consists of two independent sub-projects: a FastAPI Python backend (Z-Image inference via diffusers with SSE progress streaming, image serving, workflow persistence) and a React/Vite frontend (React Flow canvas, Zustand store, four custom node components). The backend lazily loads the Z-Image 6B model on first request with SSE progress events, and the frontend launches with a pre-placed Text Prompt → Z-Image Generate → Image Output workflow.

## Requirements

- Text-to-image generation using Z-Image 6B model via HuggingFace diffusers
- Image-to-image generation (upload starting image + text prompt)
- Real-time generation progress via SSE (step-level)
- Local disk output storage at `~/.korg-e/outputs/{timestamp}_{seed}.png`
- Drag-and-drop node-graph canvas (React Flow)
- Four custom node types: Text Prompt, Image Upload, Z-Image Generate, Image Output
- Pre-placed starter workflow on first launch
- JSON workflow save/load (React Flow native `toObject()` format)
- Adjustable Z-Image parameters: steps, CFG scale, seed (+ randomize), resolution presets
- Lazy model loading on first generation request
- Local-only, personal tool (no auth, no multi-user)

## Current State Analysis

korg-e is a completely greenfield repository — no source code exists. The sibling `korg` project (Wan2GP video generation with bash orchestration + Gradio) provides philosophical conventions only:
- Single data root pattern (`$KORG_E_HOME`, default `~/.korg-e/`)
- Localhost-only binding
- Idempotent setup/start scripts
- No pre-download of models (lazy loading aligns)

### Key Discoveries

- **ZImagePipeline** (`diffusers`): Supports text-to-image via `ZImagePipeline`, image-to-image via **separate** `ZImageImg2ImgPipeline` (separate class, uses `image` + `strength` params). MPS requires `bfloat16` (macOS 14+), `enable_attention_slicing()`, and explicit `.to("mps")` (no `device_map`). Source: https://huggingface.co/docs/diffusers/api/pipelines/z_image
- **Callback mechanism**: Modern diffusers uses `callback_on_step_end` + `callback_on_step_end_tensor_inputs` (not legacy `callback`/`callback_steps`). Signature: `callback_on_step_end(self, step: int, timestep: int, callback_kwargs: Dict) -> Dict`. Source: https://huggingface.co/docs/diffusers/main/en/using-diffusers/callback
- **React Flow v11+**: Now `@xyflow/react`. Custom nodes are React components receiving `NodeProps`. State management via `onNodesChange`/`onEdgesChange`/`onConnect` callbacks with `applyNodeChanges`/`applyEdgeChanges`/`addEdge` utility functions. Graph traversal via `getIncomers`/`getOutgoers`. Source: https://reactflow.dev/learn
- **FastAPI SSE**: Built-in `fastapi.sse.EventSourceResponse` (v0.135.0+) or `sse-starlette`. Thread→async bridge via `asyncio.Queue` + `run_in_executor` + `run_coroutine_threadsafe`. Source: https://fastapi.tiangolo.com/tutorial/server-sent-events/
- **MPS Memory**: ~24GB+ peak for 6B model. `bfloat16` halves memory vs float32. `enable_attention_slicing()` recommended for <64GB RAM. No `device_map` or `enable_model_cpu_offload()` on MPS. Source: https://huggingface.co/docs/diffusers/en/optimization/mps

### Constraints
- Z-Image 6B model requires ~24GB+ unified memory on MPS
- `bfloat16` requires macOS 14+ Sonoma
- `diffusers` must be installed from source (`pip install git+https://github.com/huggingface/diffusers`) for Z-Image pipeline support
- Personal/solo use — no auth, RBAC, or multi-tenancy needed
- MPS does not support `device_map` or `enable_model_cpu_offload()` — these are CUDA-only

## Scope

### Building
- FastAPI backend with lazy-loaded Z-Image pipeline (text-to-image + img2img)
- SSE real-time progress streaming from backend to frontend
- React/Vite frontend with React Flow canvas
- Four custom node components: TextPrompt, ImageUpload, ZImageGenerate, ImageOutput
- Zustand store as single source of truth for workflow state
- Pre-placed starter workflow (Text Prompt → Z-Image Generate → Image Output) on first launch
- JSON workflow save/load using React Flow's native `toObject()` format
- Local disk output storage at `~/.korg-e/outputs/`
- Project scaffolding: scripts/setup.sh, scripts/start.sh, .env.example
- Vite proxy in dev mode, FastAPI serves built frontend in production

### Not Building
- User authentication / RBAC / multi-tenancy (personal tool)
- Undo/redo for node graph operations (deferred to v2)
- Inpainting support (`ZImageInpaintPipeline`) — only text-to-image and img2img in v1
- Model download manager or model browser (lazy load on first request only)
- Gallery/browsing UI for generated images beyond the current workflow
- Plugins or custom node SDK (future consideration)

## Decisions

### Direction: Follow @xyflow/react typing patterns
**Status**: Confirmed by developer checkpoint
Use `@xyflow/react` generic `Node<TData, TType>` and `NodeProps<T>` types for all React Flow custom components. Types follow the pattern established by the React Flow v11+ TypeScript guide (https://reactflow.dev/learn/advanced-use/typescript).

### Direction: bfloat16 + enable_attention_slicing for MPS memory
**Status**: Confirmed by developer checkpoint
The Z-Image pipeline uses `torch_dtype=torch.bfloat16` across all components, plus `pipe.enable_attention_slicing()` for MPS memory management. No `device_map` (CUDA-only). `.to("mps")` called explicitly after pipeline construction.

### Direction: asyncio.Queue bridge for thread→async SSE
**Status**: Confirmed by developer checkpoint
The diffusers pipeline runs in a `ThreadPoolExecutor`. Progress is pushed to an `asyncio.Queue` via `run_coroutine_threadsafe`. The SSE generator consumes the queue. A cancellation `asyncio.Event` handles client disconnect.

### Serving model: Vite proxy in dev, FastAPI serves built app in production
**Status**: Confirmed by developer checkpoint
In dev: Vite dev server on port 5173, proxy `/api` and `/images` to FastAPI on port 8000. In production: Vite builds to `frontend/dist/`, FastAPI mounts via `StaticFiles`. CORS configured for dev mode.

### Workflow serialization: React Flow native toObject() format
**Status**: Confirmed by developer checkpoint
Workflow JSON uses React Flow's built-in `toObject()` format: `{ nodes: Node[], edges: Edge[], viewport: Viewport }`. No custom serialization layer. Save/load directly persists this JSON to disk.

## Architecture

### backend/__init__.py — NEW
Backend package marker enabling uvicorn import resolution.

```python
"""korg-e backend."""
```

### backend/main.py — NEW
FastAPI application entry point. CORS middleware config, static file mounts, route registrations, startup/shutdown events.

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
app.state.model_pipeline = None  # populated on first generation


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

### backend/config.py — NEW
Configuration management: `$KORG_E_HOME`, port, model settings, paths.

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

### backend/utils/__init__.py — NEW
Backend utils package marker.

```python
"""Utility modules for the korg-e backend."""
```

### backend/pipeline.py — NEW
Z-Image pipeline wrapper with lazy loading, MPS optimizations, progress callback.

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

### backend/utils/storage.py — NEW
Image save, list, delete utilities. Manages `~/.korg-e/outputs/`.

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

### backend/routes/__init__.py — NEW
API routes package marker.

```python
"""API route modules."""
```

### backend/utils/validation.py — NEW
Graph topology validation for submitted workflows.

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

### backend/routes/generate.py — NEW
POST /api/generate — SSE streaming endpoint. Thread pool bridge via asyncio.Queue.

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
                "step": current,
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
    init_bytes = base64.b64decode(init_image_b64)

    def step_cb(current: int, total: int) -> None:
        if cancel_event.is_set():
            return
        asyncio.run_coroutine_threadsafe(
            queue.put({
                "event": "progress",
                "status": "generating",
                "step": current,
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
    yield f"event: error\ndata: {json.dumps({'status': 'error', 'errors': errors})}\n\n"
```

### backend/routes/images.py — NEW
GET /api/images — list generated images metadata.

```python

```

### backend/routes/workflow.py — NEW
POST /api/workflow/save, POST /api/workflow/load — workflow JSON persistence.

```python

```

### frontend/src/types/workflow.ts — NEW
TypeScript interfaces for workflow node types, edge types, store state.

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

### frontend/src/store/useWorkflowStore.ts — NEW
Zustand store with React Flow sync callbacks (onNodesChange, onEdgesChange, onConnect), workflow serialization, node CRUD.

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

### frontend/src/utils/sse.ts — NEW
SSE client helper using fetch streaming reader (supports POST unlike EventSource).

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

### frontend/src/utils/jsonExport.ts — NEW
Workflow JSON export/import helpers using React Flow toObject/fromObject.

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

### frontend/src/utils/integration.ts — NEW
Integration hook wiring CustomEvents to backend SSE (Slice 7).

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

### frontend/src/App.tsx — NEW
Root React component wrapping ReactFlowProvider + Canvas + Toolbar.

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

### frontend/src/main.tsx — NEW
Vite entry point — renders App, global styles import.

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

### frontend/src/components/Canvas.tsx — NEW
React Flow canvas container with node type registration and background.

```typescript
/** React Flow canvas container with node type registration and background. */

import { useCallback, useMemo } from "react";
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

### frontend/src/components/Toolbar.tsx — NEW
Add node menu, Generate button, workflow save/load controls.

```typescript
/** Toolbar — Add node menu, workflow save/load controls. */

import { useCallback, useRef, useState } from "react";
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

### frontend/src/components/nodes/TextPromptNode.tsx — NEW
Custom node: text input area, editable prompt.

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

### frontend/src/components/nodes/ImageUploadNode.tsx — NEW
Custom node: image upload button + preview thumbnail.

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

### frontend/src/components/nodes/ZImageGenerateNode.tsx — NEW
Custom node: parameter controls (steps, CFG, seed, resolution), status display, Generate button, progress bar.

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

### frontend/src/components/nodes/ImageOutputNode.tsx — NEW
Custom node: displays generated image, seed info.

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

### frontend/src/App.tsx — NEW
Root React component wrapping ReactFlowProvider + Canvas + Toolbar.

```typescript

```

### frontend/src/main.tsx — NEW
Vite entry point — renders App, global styles import.

```typescript

```

### frontend/package.json — NEW
Node dependencies: react, react-dom, @xyflow/react, zustand, vite, typescript, @types/react, @vitejs/plugin-react, vitest.

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

### frontend/vite.config.ts — NEW
Vite config with React plugin and proxy to backend.

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

### frontend/tsconfig.json — NEW
TypeScript configuration for React + Vite.

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

### frontend/index.html — NEW
HTML entry point with root div.

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

### .env.example — NEW
Configuration template for KORG_E_HOME, KORG_E_PORT, etc.

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

### scripts/setup.sh — NEW
Environment validation, Python venv creation, pip install (diffusers, torch, fastapi, uvicorn), npm install.

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

### scripts/start.sh — NEW
Start backend (uvicorn) and optionally frontend (Vite dev server).

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

## Slices

### Slice 1: Project scaffolding + Configuration + Backend foundation

**Files**: `backend/__init__.py`, `backend/main.py`, `backend/config.py`, `frontend/package.json`, `frontend/vite.config.ts`, `frontend/tsconfig.json`, `frontend/tsconfig.node.json`, `frontend/index.html`, `.env.example`, `scripts/setup.sh`, `scripts/start.sh`

#### Automated Verification:
- [ ] Type checking passes: `npx tsc --noEmit` (note: fails on missing `src/` until Slice 5)
- [ ] Tests pass: `npm test` (vitest runner configured; no tests yet)
- [ ] Backend imports resolve: `cd /tmp && python -c "import sys; sys.path.insert(0,'/path/to/repo'); from backend.config import settings; print(settings.data_root)"`
- [ ] Backend starts: `uvicorn backend.main:app --port 8000` responds on `/health`
- [ ] Grep for bfloat16 config in config.py: `grep -r "bfloat16" backend/config.py` returns non-empty
- [ ] macOS 14+ check in setup.sh: `grep -c "macOS 14+" scripts/setup.sh` returns >= 1

#### Manual Verification:
- [ ] FastAPI app starts without errors
- [ ] `/health` returns 200 with model-loaded status
- [ ] CORS headers present on OPTIONS preflight request
- [ ] `scripts/setup.sh` runs through without errors
- [ ] `scripts/start.sh` launches backend successfully

### Slice 2: Pipeline wrapper + image storage

**Files**: `backend/pipeline.py`, `backend/utils/__init__.py`, `backend/utils/storage.py`

#### Automated Verification:
- [ ] Python imports resolve: `cd /tmp && python -c "import sys; sys.path.insert(0,'/path/to/repo'); from backend.pipeline import PipelineWrapper; from backend.utils.storage import save_image, list_images"`
- [ ] Grep for `callback_on_step_end` in pipeline.py: `grep -c "callback_on_step_end" backend/pipeline.py` returns >= 2
- [ ] Grep for `ZImageImg2ImgPipeline` in pipeline.py: `grep -c "ZImageImg2ImgPipeline" backend/pipeline.py` returns >= 2
- [ ] Grep for `enable_attention_slicing` in pipeline.py: `grep -c "enable_attention_slicing" backend/pipeline.py` returns >= 1
- [ ] Grep for `sidecar` or `.json` in storage.py: `grep -c "with_suffix" backend/utils/storage.py` returns >= 1

#### Manual Verification:
- [ ] PipelineWrapper loads pipeline lazily (no load on construction)
- [ ] PipelineWrapper.generate() produces PNG bytes
- [ ] PipelineWrapper.generate_img2img() accepts image bytes and produces PNG bytes
- [ ] Storage saves PNG + sidecar JSON to `~/.korg-e/outputs/`
- [ ] Storage.list_images() returns metadata sorted newest-first

### Slice 3: API routes — generate + SSE streaming

**Files**: `backend/routes/__init__.py`, `backend/routes/generate.py`, `backend/utils/validation.py`

#### Automated Verification:
- [ ] Python imports resolve: `cd /tmp && python -c "import sys; sys.path.insert(0,'/path/to/repo'); from backend.routes.generate import router; from backend.utils.validation import validate_workflow, extract_parameters"`
- [ ] Grep for `StreamingResponse` in generate.py: `grep -c "StreamingResponse" backend/routes/generate.py` returns >= 1
- [ ] Grep for `asyncio.Queue` in generate.py: `grep -c "asyncio.Queue" backend/routes/generate.py` returns >= 1
- [ ] Grep for `run_in_executor` in generate.py: `grep -c "run_in_executor" backend/routes/generate.py` returns >= 1
- [ ] Grep for `request.app.state.model_pipeline` in generate.py: `grep -c "model_pipeline" backend/routes/generate.py` returns >= 1
- [ ] Grep for `callback_on_step_end` in validation.py: (none needed — validation is pure dict logic)

#### Manual Verification:
- [ ] POST /api/generate returns SSE stream with progress events
- [ ] SSE events contain step, total, status fields
- [ ] Client disconnect cancels background pipeline task
- [ ] Graph validation rejects invalid workflows (no generate node, missing connections, duplicate edges)

### Slice 4: API routes — images + workflow save/load

**Files**: `backend/routes/images.py`, `backend/routes/workflow.py`

#### Automated Verification:
- [ ] Type checking passes: `mypy backend/routes/images.py`
- [ ] Type checking passes: `mypy backend/routes/workflow.py`
- [ ] Workflow routes tests pass: `pytest tests/test_workflow.py`

#### Manual Verification:
- [ ] GET /api/images returns list of generated images with metadata
- [ ] POST /api/workflow/save persists workflow JSON to disk
- [ ] POST /api/workflow/load returns saved workflow JSON
- [ ] Generated images are accessible via FastAPI StaticFiles

### Slice 5: Frontend types + Zustand store + SSE client

**Files**: `frontend/src/types/workflow.ts`, `frontend/src/store/useWorkflowStore.ts`, `frontend/src/utils/sse.ts`, `frontend/src/utils/jsonExport.ts`, `frontend/src/App.tsx`, `frontend/src/main.tsx`

#### Automated Verification:
- [ ] Type checking passes: `npx tsc --noEmit` (note: fails on missing `Canvas.tsx` in Slice 6)
- [ ] Grep for `@xyflow/react` Node type in workflow.ts: `grep -c "from '@xyflow/react'" frontend/src/types/workflow.ts` returns >= 1
- [ ] Grep for Zustand create in store: `grep -c "create(" frontend/src/store/useWorkflowStore.ts` returns >= 1
- [ ] Grep for `applyNodeChanges` in store: `grep -c "applyNodeChanges" frontend/src/store/useWorkflowStore.ts` returns >= 1
- [ ] Grep for starter workflow in store: `grep -c "starterWorkflow" frontend/src/store/useWorkflowStore.ts` returns >= 1
- [ ] Grep for POST to /api/workflow/save in store: `grep -c "/api/workflow/save" frontend/src/store/useWorkflowStore.ts` returns >= 1

#### Manual Verification:
- [ ] Zustand store correctly initializes with pre-placed starter workflow (TextPrompt → ZImageGenerate → ImageOutput)
- [ ] onNodesChange/onEdgesChange/onConnect update store correctly
- [ ] App component renders ReactFlowProvider wrapper
- [ ] createSSEConnection correctly parses progress/done/error events from fetch stream

### Slice 6: Custom node components

**Files**: `frontend/src/components/Canvas.tsx`, `frontend/src/components/Toolbar.tsx`, `frontend/src/components/nodes/TextPromptNode.tsx`, `frontend/src/components/nodes/ImageUploadNode.tsx`, `frontend/src/components/nodes/ZImageGenerateNode.tsx`, `frontend/src/components/nodes/ImageOutputNode.tsx`

**Modified**: `frontend/src/App.tsx` (added Toolbar)

#### Automated Verification:
- [ ] Type checking passes: `npx tsc --noEmit`
- [ ] Grep for custom node type registration in Canvas.tsx: `grep -c "nodeTypes" frontend/src/components/Canvas.tsx` returns >= 1
- [ ] Grep for Handle imports in node files: `grep -c "Handle" frontend/src/components/nodes/*.tsx` returns >= 4 (one per node type)
- [ ] Grep for all four node types registered: `grep -c "textPrompt" frontend/src/components/Canvas.tsx` returns >= 1
- [ ] Grep for Toolbar in App.tsx: `grep -c "Toolbar" frontend/src/App.tsx` returns >= 1

#### Manual Verification:
- [ ] Canvas renders with React Flow background, Controls, and MiniMap
- [ ] Each node type renders correctly with appropriate handles
- [ ] TextPromptNode shows editable text area, changes persist to store
- [ ] ImageUploadNode accepts file upload and shows preview thumbnail
- [ ] ZImageGenerateNode parameter controls (steps, CFG, seed, resolution) update store on change
- [ ] ImageOutputNode renders generated image and seed info (placeholder before generation)
- [ ] Toolbar allows adding nodes of each type via dropdown
- [ ] Workflow save/load/Reset buttons connected to store

### Slice 7: Starter workflow + frontend-backend integration

**Files**: `frontend/src/utils/integration.ts` (NEW)

**Modified**: `frontend/src/components/Canvas.tsx` (added `useWorkflowIntegration` call)

#### Automated Verification:
- [ ] Type checking passes: `npx tsc --noEmit`
- [ ] Grep for integration hook in Canvas.tsx: `grep -c "useWorkflowIntegration" frontend/src/components/Canvas.tsx` returns >= 1
- [ ] Grep for CustomEvent listeners in integration.ts: `grep -c "korg:generate" frontend/src/utils/integration.ts` returns >= 1
- [ ] Grep for `createSSEConnection` call in integration.ts: `grep -c "createSSEConnection" frontend/src/utils/integration.ts` returns >= 1
- [ ] Grep for ref-based pattern (avoids SSE abort on re-render): `grep -c "nodesRef" frontend/src/utils/integration.ts` returns >= 1

#### Manual Verification:
- [ ] On first launch, canvas shows pre-placed Text Prompt → Z-Image Generate → Image Output workflow
- [ ] Clicking Generate on ZImageGenerateNode triggers POST /api/generate (via CustomEvent chain)
- [ ] SSE progress events update node status (loading/generating/complete/error) without aborting mid-flight
- [ ] Progress bar animates on ZImageGenerateNode during generation
- [ ] On completion, ImageOutputNode displays the generated image with seed info
- [ ] Image upload node sends starting image to backend for img2img
- [ ] Error state displays on node when generation fails
- [ ] Workflow save/load round-trips correctly via store methods

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

## File Map

```
backend/main.py                    # NEW — FastAPI app entry point (Slice 1)
backend/__init__.py                # NEW — Package marker (Slice 1)
backend/config.py                  # NEW — Configuration management (Slice 1)
backend/pipeline.py                # NEW — Z-Image pipeline wrapper (Slice 2)
backend/utils/__init__.py          # NEW — Utils package marker (Slice 2)
backend/utils/storage.py           # NEW — Image save/list/delete (Slice 2)
backend/routes/__init__.py          # NEW — Routes package marker (Slice 3)
backend/routes/generate.py         # NEW — POST /api/generate SSE (Slice 3)
backend/utils/validation.py        # NEW — Graph topology validation (Slice 3)
backend/routes/images.py           # NEW — GET /api/images (Slice 4)
backend/routes/workflow.py         # NEW — Workflow save/load (Slice 4)

frontend/tsconfig.node.json        # NEW — TS config for vite
frontend/package.json              # NEW — Dependencies
frontend/vite.config.ts            # NEW — Vite config + proxy
frontend/tsconfig.json             # NEW — TypeScript config
frontend/index.html                # NEW — HTML entry point
frontend/src/main.tsx              # NEW — Vite entry point
frontend/src/App.tsx               # NEW — Root React component
frontend/src/types/workflow.ts       # NEW — TypeScript interfaces (Slice 5)
frontend/src/store/useWorkflowStore.ts # NEW — Zustand store (Slice 5)
frontend/src/utils/sse.ts             # NEW — SSE client helper (Slice 5)
frontend/src/utils/jsonExport.ts      # NEW — Workflow export/import (Slice 5)
frontend/src/utils/integration.ts     # NEW — Integration orchestration (Slice 7)
frontend/src/App.tsx                  # NEW — Root React component (Slice 5)
frontend/src/main.tsx                 # NEW — Vite entry point (Slice 5)
frontend/src/components/Canvas.tsx                    # NEW — React Flow canvas (Slice 6)
frontend/src/components/Toolbar.tsx                    # NEW — Toolbar controls (Slice 6)
frontend/src/components/nodes/TextPromptNode.tsx       # NEW (Slice 6)
frontend/src/components/nodes/ImageUploadNode.tsx      # NEW (Slice 6)
frontend/src/components/nodes/ZImageGenerateNode.tsx   # NEW (Slice 6)
frontend/src/components/nodes/ImageOutputNode.tsx      # NEW (Slice 6)
frontend/src/components/nodes/TextPromptNode.tsx     # NEW
frontend/src/components/nodes/ImageUploadNode.tsx    # NEW
frontend/src/components/nodes/ZImageGenerateNode.tsx # NEW
frontend/src/components/nodes/ImageOutputNode.tsx    # NEW

scripts/setup.sh                   # NEW — Environment setup
scripts/start.sh                   # NEW — Launch script
.env.example                       # NEW — Configuration template
```

## Ordering Constraints

- Slice 1 must be first (foundation for everything)
- Slices 2-4 must follow Slice 1 (backend depends on scaffolding)
- Slices 5-6 must follow Slice 1 (frontend depends on scaffolding)
- Slice 2 must precede Slice 3 (generate route needs pipeline)
- Slice 5 must precede Slice 6 (nodes need types and store)
- Slice 7 must follow Slices 3 and 6 (needs generate API + custom nodes)
- Slices 2, 4, 5 are independent of each other (parallelizable within the 1→limit)
- Slices 3 depends on 2 only; Slices 6 depends on 5 only

## Verification Notes

- **diffusers from source required**: `pip install git+https://github.com/huggingface/diffusers` — Z-Image pipeline classes not available in stable release yet
- **macOS 14+ required**: bfloat16 on MPS needs Sonoma+; on older macOS, fallback to float32 may be needed
- **VRAM check**: 6B model needs ~24GB+ unified memory on MPS; system may swap heavily on 16GB machines
- **diffusers callback**: Use modern `callback_on_step_end` API, not legacy `callback` parameter — verify signature matches ZImagePipeline
- **ZImageImg2ImgPipeline is separate class**: Must import separately from `ZImagePipeline`; they don't share a unified pipeline
- **`low_cpu_mem_usage=False`**: The model card explicitly sets this — copying that setting is critical
- **No device_map on MPS**: `device_map` and `enable_model_cpu_offload()` are CUDA-only; will silently fail or error on MPS
- **SSE keepalive**: Browser EventSource auto-reconnects; the SSE endpoint should send periodic keepalive comments to prevent timeout disconnects
- **CORS for dev**: Allow both `localhost:5173` and `127.0.0.1:5173` to handle different browser host preferences
- **Frontend build output**: Production build output goes to `frontend/dist/`; FastAPI mounts this at `/` via StaticFiles
- **Thread safety**: Never call `await queue.put()` from a sync thread — use `asyncio.run_coroutine_threadsafe()`
- **Client disconnect handling**: Always check `await request.is_disconnected()` in SSE generator; set cancel_event for thread to stop

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

## Pattern References

- **React Flow custom node pattern**: https://reactflow.dev/learn/customization/custom-nodes — all four custom node types follow this pattern
- **Zustand + React Flow state management**: https://reactflow.dev/learn/advanced-use/state-management — the exact pattern used in the store
- **FastAPI SSE pattern (built-in)**: https://fastapi.tiangolo.com/tutorial/server-sent-events/ — generate route follows this
- **FastAPI CORS setup**: https://fastapi.tiangolo.com/tutorial/cors/ — CORS middleware config in main.py
- **Z-Image diffusers pipeline**: https://huggingface.co/docs/diffusers/api/pipelines/z_image — pipeline API reference
- **diffusers callback guide**: https://huggingface.co/docs/diffusers/main/en/using-diffusers/callback — step progress callback pattern
- **MPS optimization guide**: https://huggingface.co/docs/diffusers/en/optimization/mps — attention slicing and bfloat16 guidance
- **Sibling korg ARCHITECTURE.md**: `~/.korg/ARCHITECTURE.md` — single data root, localhost-only, idempotent script conventions

## Developer Context

### Directional confirms (one batch, all confirmed)
**Q**: About to follow three established patterns across new codebase — confirm direction or moving off?
**Options**: Follow all three / Moving off types / Moving off memory / Moving off SSE bridge
**A**: Follow all three

### Serving model
**Q**: How should the frontend be served? (A) Vite proxy in dev + FastAPI serves built app, (B) Always separate ports with CORS
**A**: (A) Vite proxy + FastAPI serves built app

### Workflow schema
**Q**: Workflow JSON schema structure — (A) React Flow native toObject() format, (B) Custom domain schema
**A**: (A) React Flow native toObject() format

## Design History

- Slice 1: Project scaffolding + Configuration + Backend foundation — approved as generated
- Slice 2: Pipeline wrapper + image storage — approved as generated
- Slice 3: API routes — generate + SSE streaming — approved as generated
- Slice 4: API routes — images + workflow save/load — pending
- Slice 5: Frontend types + Zustand store + SSE client — approved as generated
- Slice 6: Custom node components — approved as generated
- Slice 7: Starter workflow + frontend-backend integration — approved as generated

## References

- `.rpiv/artifacts/research/simplified-comfyui-image-gen.md` — Upstream research artifact
- `.rpiv/artifacts/discover/2026-06-12_23-22-20_simplified-comfyui-image-gen.md` — Feature Requirements Document
- `https://huggingface.co/Tongyi-MAI/Z-Image` — Z-Image model card
- `https://huggingface.co/docs/diffusers/api/pipelines/z_image` — Z-Image diffusers docs
- `https://github.com/Tongyi-MAI/Z-Image` — Z-Image GitHub repo
- `https://reactflow.dev/learn` — React Flow documentation
- `https://fastapi.tiangolo.com/tutorial/server-sent-events/` — FastAPI SSE guide
- `~/.korg/ARCHITECTURE.md` — Sibling project architecture conventions
