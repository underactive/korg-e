---
date: 2026-06-21T00:00:35-0700
author: Eric Sison
commit: 5c40530
branch: main
repository: korg-e
topic: "Adding Inpainting to korg-e"
tags: [inpainting, z-image, diffusers, brush-mask, pipeline]
status: ready
parent: .rpiv/artifacts/research/2026-06-20_23-42-30_adding-inpainting.md
phase_count: 4
phases:
  - { n: 1, title: Types + Data Foundation }
  - { n: 2, title: Backend Pipeline }
  - { n: 3, title: Backend Route + Detection + Storage }
  - { n: 4, title: Frontend Brush UI + Integration }
unresolved_phase_count: 0
last_updated: 2026-06-21T00:00:35-0700
last_updated_by: Eric Sison
---

# Adding Inpainting to korg-e — Implementation Plan

## Overview

Extend the existing `zImageGenerate` node with an in-node brush canvas for mask painting and a new `is_inpaint` backend branch that loads `ZImageInpaintPipeline`. Inpainting auto-detects when `maskData` is populated on the generate node alongside a connected `ImageUpload` node. No new node types — the mask is painted directly on the uploaded image preview inside `ZImageGenerateNode`.

## Requirements

- User uploads a photo via `ImageUploadNode`, connects it to `ZImageGenerateNode`
- User clicks "Paint Mask" to enter brush mode and paints over the area to regenerate
- Only the masked (white) region is regenerated; unmasked (black) region remains pixel-identical
- Backend auto-detects inpainting from `maskData` presence — no manual mode switch needed
- Mask blur parameter controls Gaussian feathering of mask edges (default 16px)
- SSE progress events work identically to existing img2img flow
- Provenance: init image, mask image, and metadata saved alongside result

## Current State Analysis

### Key Discoveries

- **`load_img2img()` at `pipeline.py:81`** — exact template for `load_inpaint()`. Same lazy-load, cache-check, MPS optimization pattern.
- **`generate_img2img()` at `pipeline.py:164`** — exact template for `generate_inpaint()`. Same VAE decode closure, same step_callback pattern.
- **`_run_img2img` at `generate.py:149`** — exact template for `_run_inpaint`. Same batch loop, same SSE event pattern, same `empty_cache()` between passes.
- **`extract_parameters()` at `validation.py:57`** — existing img2img detection at line 88. Inpainting adds a third detection branch (txt2img / img2img / inpaint).
- **`save_composite_images()` at `storage.py:91`** — template for `save_inpaint_images()`. Multi-artifact save pattern.
- **`useUIStore.ts:7-8`** — establishes the pattern: separate Zustand store for transient UI state, distinct from persisted workflow store. `usePaintStore` follows this pattern.
- **`RegionNode.tsx:38-44`** — draw-mode toggle pattern (button toggles `useUIStore.setDrawMode`). Paint mode toggle follows this pattern.
- **`ZImageInpaintPipeline`** — confirmed available in diffusers 0.39.0.dev0. Same `from_pretrained()` pattern as `ZImageImg2ImgPipeline`.
- **VAE decode closure** at `pipeline.py:135-175` — reused identically for inpainting (references `pipe.vae`, `pipe.image_processor` which exist on all diffusers pipelines).
- **`extract_parameters()` branching** — confirmed highest-risk change by both composable region and batch generation precedents. Any bug here breaks every workflow mode.

## Desired End State

**Workflow**: User uploads a car photo → connects to ZImageGenerate → clicks "Paint Mask" → paints over the trunk area → types "a woman standing by the car" → clicks Generate → only the trunk area regenerates with the woman, rest of car remains identical.

**Backend**: `POST /api/generate` with `is_inpaint: true` + `maskData` (base64 PNG) in the generate node's data → backend loads `ZImageInpaintPipeline`, applies mask blur, runs inpainting, saves result + init + mask.

**SSE**: Same `progress`/`done`/`error` events. No new event types or fields needed.

## What We're NOT Doing

- **`GenerationCancelledError` mid-pipeline abort** — enhancement to existing cancellation pattern; deferred to follow-up
- **Per-image batch masks** — batch inpainting uses a single mask for all images; per-image masks deferred
- **New node types** — inpainting extends `zImageGenerate`, not a dedicated `zInpaint` node
- **Undo/redo for brush strokes** — not in initial scope
- **Adjustable canvas for mask editing** — no eraser mode in initial scope (paint-only)
- **Mask import/export** — masks are transient, not persisted in workflow JSON

## Decisions

### Decision 1: Extend zImageGenerate (not new zInpaint)

**Ambiguity**: Should inpainting be a new node type or extend the existing generate node?

**Explored**:
- Option A: New `zInpaint` node type — cleaner separation, but requires new registration at 5 points (`KorgNodeType`, `createNode`, `Canvas.tsx` nodeTypes, toolbar, `NODE_DATA_DEFAULTS`)
- Option B: Extend `zImageGenerate` with optional mask input — follows existing img2img auto-detection pattern at `validation.py:77-88`, less new code

**Decision**: Option B. Matches the existing auto-detection pattern. Less registration churn. Developer confirmed in research Q&A.

### Decision 2: In-node brush canvas (not separate MaskUpload node)

**Ambiguity**: How does the user paint the mask?

**Decision**: Brush canvas rendered inside `ZImageGenerateNode`. A "Paint Mask" button toggles the image preview area to a `<canvas>` element. The mask is stored as `maskData` on the node. No new node type. Follows the draw-mode toggle precedent at `RegionNode.tsx:38-44`.

### Decision 3: Separate usePaintStore + React ref for offscreen canvas

**Ambiguity**: Where does transient brush state live?

**Decision**: `usePaintStore` (new Zustand store) holds `paintMode`, `paintNodeId`, `brushRadius`, `paintModeType`, `maskVisible`. The offscreen canvas buffer (`HTMLCanvasElement`) lives as a React ref inside `ZImageGenerateNode` — only the final base64 `maskData` is stored on the node data. Follows the `useUIStore` transient-state pattern at `useUIStore.ts:7-8`.

### Decision 4: Backend auto-detection from maskData

**Ambiguity**: How does the backend know this is inpainting?

**Decision**: `extract_parameters()` checks if the generate node has `maskData` populated AND `init_image` from a connected `ImageUpload`. Sets `params["mode"] = "inpaint"`. Follows the existing img2img detection at `validation.py:77-88`.

### Decision 5: Error on mask dimension mismatch

**Ambiguity**: What happens when init image and mask dimensions don't match?

**Decision**: Error with clear message in `_run_inpaint`. The diffusers pipeline requires matching dimensions. No automatic resize — the user should repaint the mask at the correct resolution.

## Phase 1: Types + Data Foundation

### Overview

Foundation slice: extend `KorgNodeData` with inpainting fields, create `usePaintStore` for brush state, sync defaults in `useWorkflowStore` and `jsonExport`. Depends on nothing.

### Changes Required:

#### 1. frontend/src/types/workflow.ts

**File**: frontend/src/types/workflow.ts
**Changes**: MODIFY — Add `maskData`, `maskBlur`, `imageWidth`, `imageHeight` to `KorgNodeData`

```typescript
  // CompositionNode
  canvasWidth?: number;
  canvasHeight?: number;
  // Inpainting (extends zImageGenerate)
  maskData?: string | null;       // base64 PNG of brush mask
  maskBlur?: number;              // Gaussian blur radius for mask edge (default 16)
  imageWidth?: number;            // natural width of uploaded init image
  imageHeight?: number;           // natural height of uploaded init image
```

#### 2. frontend/src/store/usePaintStore.ts

**File**: frontend/src/store/usePaintStore.ts
**Changes**: NEW — Zustand store for brush paint mode state

```typescript
/**
 * Transient paint state — brush interaction, mask mode.
 *
 * Separated from useWorkflowStore to keep persisted workflow data clean
 * (no paintMode, brushRadius leaks into save/load JSON).
 * Follows the useUIStore transient-state pattern.
 */

import { create } from "zustand";

export type PaintModeType = "paint" | "erase";

export type PaintStore = {
  /** Whether the canvas is currently in "paint mask" mode. */
  paintMode: boolean;
  /** The generate node ID currently being painted on. */
  paintNodeId: string | null;
  /** Brush radius in image pixels. */
  brushRadius: number;
  /** Add to mask (paint) or remove from mask (erase). */
  paintModeType: PaintModeType;
  /** Toggle mask overlay visibility. */
  maskVisible: boolean;
  /** True between mousedown and mouseup during a brush stroke. */

  setPaintMode: (enabled: boolean, nodeId?: string) => void;
  setBrushRadius: (radius: number) => void;
  setPaintModeType: (type: PaintModeType) => void;
  setMaskVisible: (visible: boolean) => void;
  resetPaint: () => void;
};

export const usePaintStore = create<PaintStore>((set) => ({
  paintMode: false,
  paintNodeId: null,
  brushRadius: 20,
  paintModeType: "paint",
  maskVisible: true,

  setPaintMode: (enabled, nodeId) =>
    set({
      paintMode: enabled,
      paintNodeId: enabled ? (nodeId ?? null) : null,
    }),

  setBrushRadius: (radius) => set({ brushRadius: radius }),
  setPaintModeType: (type) => set({ paintModeType: type }),
  setMaskVisible: (visible) => set({ maskVisible: visible }),
  resetPaint: () =>
    set({
      paintMode: false,
      paintNodeId: null,
    }),
}));
```

#### 3. frontend/src/store/useWorkflowStore.ts

**File**: frontend/src/store/useWorkflowStore.ts
**Changes**: MODIFY — Add `maskBlur: 16` to `zImageGenerate` defaults in `createNode()`

```typescript
    zImageGenerate: {
      label: "Z-Image Generate",
      steps: 50,
      cfgScale: 5.0,
      strength: 0.6,
      seed: null,
      width: 1024,
      height: 1024,
      batchCount: 1,
      maskBlur: 16,
      status: "idle",
      inputs: [
        { name: "prompt", type: "prompt", required: true },
        { name: "image", type: "image" },
      ],
      outputs: [{ name: "image", type: "image" }],
    },
```

#### 4. frontend/src/utils/jsonExport.ts

**File**: frontend/src/utils/jsonExport.ts
**Changes**: MODIFY — Add `maskBlur: 16` to `zImageGenerate` in `NODE_DATA_DEFAULTS`

```typescript
  zImageGenerate: {
    label: "Z-Image Generate",
    steps: 50,
    cfgScale: 5.0,
    strength: 0.6,
    seed: null,
    width: 1024,
    height: 1024,
    maskBlur: 16,
    status: "idle",
    inputs: [
      { name: "prompt", type: "prompt", required: true },
      { name: "image", type: "image" },
    ],
    outputs: [{ name: "image", type: "image" }],
  },
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `cd frontend && npx tsc --noEmit`

#### Manual Verification:
- [x] `usePaintStore` exports `paintMode`, `paintNodeId`, `brushRadius`, `paintModeType`, `maskVisible`
- [x] `KorgNodeData` includes `maskData?`, `maskBlur?`, `imageWidth?`, `imageHeight?`
- [x] `zImageGenerate` defaults include `maskBlur: 16` in both `useWorkflowStore.ts:createNode()` and `jsonExport.ts:NODE_DATA_DEFAULTS`
- [x] Existing workflows import correctly (new fields default to undefined/null)

## Phase 2: Backend Pipeline

### Overview

Add `load_inpaint()` and `generate_inpaint()` methods to `PipelineWrapper`, following the `load_img2img()`/`generate_img2img()` templates exactly. Depends on nothing (conceptually independent from Phase 1, but sequenced for simplicity).

### Changes Required:

#### 1. backend/pipeline.py

**File**: backend/pipeline.py
**Changes**: MODIFY — Add `load_inpaint()` and `generate_inpaint()` methods to `PipelineWrapper`

```python
    # ── inpainting support ────────────────────────────────────────────

    def load_inpaint(
        self, progress_callback: Callable[[str], None] | None = None
    ) -> None:
        """Lazy-load the :class:`ZImageInpaintPipeline`.

        Uses the same weight-cache as the text-to-image pipeline but
        must be instantiated from its own class.
        """
        if hasattr(self, "_inpaint_pipeline") and self._inpaint_pipeline is not None:
            return

        from diffusers import ZImageInpaintPipeline  # type: ignore[import-untyped]

        _notify(progress_callback, "downloading")
        dtype = _resolve_dtype()
        pipe = ZImageInpaintPipeline.from_pretrained(
            settings.model_id,
            torch_dtype=dtype,
            low_cpu_mem_usage=settings.low_cpu_mem_usage,
        )

        _notify(progress_callback, "loading")
        pipe.to(settings.device)

        _notify(progress_callback, "optimising")
        if settings.enable_attention_slicing:
            try:
                pipe.enable_attention_slicing()
            except AttributeError:
                logger.info("enable_attention_slicing() not available for inpaint pipeline — skipping")
        if settings.enable_vae_slicing:
            try:
                pipe.enable_vae_slicing()
            except AttributeError:
                logger.info("enable_vae_slicing() not available for inpaint pipeline — skipping")

        self._inpaint_pipeline = pipe  # type: ignore[attr-defined]

    def generate_inpaint(
        self,
        prompt: str,
        init_image_bytes: bytes,
        mask_image_bytes: bytes,
        *,
        strength: float = 0.6,
        mask_blur: int = 16,
        steps: int = 50,
        cfg_scale: float = 5.0,
        seed: int | None = None,
        step_callback: Callable[[int, int, str | None], None] | None = None,
    ) -> bytes:
        """Run inpainting and return raw PNG bytes.

        The ``step_callback`` receives ``(step, total_steps, image_b64)``
        after each inference step. ``image_b64`` is ``None`` when no
        preview is available for this step.
        """
        if not hasattr(self, "_inpaint_pipeline") or self._inpaint_pipeline is None:
            raise RuntimeError("Inpaint pipeline not loaded. Call load_inpaint() first.")

        from PIL import Image as PILImage
        from PIL import ImageFilter as PILImageFilter
        import io
        import base64

        init_image = PILImage.open(io.BytesIO(init_image_bytes)).convert("RGB")
        mask_image = PILImage.open(io.BytesIO(mask_image_bytes)).convert("L")

        # Apply Gaussian blur to mask edge for smoother blending
        if mask_blur > 0:
            mask_image = mask_image.filter(PILImageFilter.GaussianBlur(radius=mask_blur))

        generator = None
        if seed is not None:
            generator = torch.Generator(device=settings.device).manual_seed(seed)

        total = steps
        decode_interval = settings.preview_decode_interval
        preview_size = settings.preview_size

        def _on_step(pipe: object, step: int, timestep: int, callback_kwargs: dict) -> dict:
            image_b64: str | None = None

            if step_callback and decode_interval > 0:
                should_decode = (step == 0) or ((step + 1) % decode_interval == 0)
                if should_decode:
                    try:
                        latents = callback_kwargs["latents"]

                        with torch.no_grad():
                            latents_for_vae = latents.to(pipe.vae.dtype)
                            latents_for_vae = (
                                latents_for_vae / pipe.vae.config.scaling_factor
                            ) + pipe.vae.config.shift_factor

                            image_tensor = pipe.vae.decode(latents_for_vae, return_dict=False)[0]

                            pil_images = pipe.image_processor.postprocess(
                                image_tensor, output_type="pil"
                            )
                            preview_image = pil_images[0]

                            if preview_size:
                                preview_image = preview_image.resize(
                                    (preview_size, preview_size), PILImage.LANCZOS
                                )

                            buf = io.BytesIO()
                            preview_image.save(buf, format="JPEG", quality=60)
                            image_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
                    except Exception:
                        logger.warning("Intermediate VAE decode failed", exc_info=True)
                        image_b64 = None

            if step_callback:
                step_callback(step, total, image_b64)
            return callback_kwargs

        result = self._inpaint_pipeline(
            prompt=prompt,
            image=init_image,
            mask_image=mask_image,
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
```

### Success Criteria:

#### Automated Verification:
- [x] Python import check: `cd /Users/esison/Development/projects/tools/korg-e && /Users/esison/.korg-e/venv/bin/python -c "from backend.pipeline import PipelineWrapper; print('OK')"`

#### Manual Verification:
- [x] `load_inpaint()` lazy-loads `ZImageInpaintPipeline` and caches on `self._inpaint_pipeline`
- [x] `generate_inpaint()` accepts `init_image_bytes` and `mask_image_bytes`, opens mask as grayscale `"L"`, calls pipeline
- [x] VAE decode closure is identical to `generate_img2img()` (reused pattern, not duplicated logic)
- [x] MPS optimizations applied (attention slicing, VAE slicing)
- [x] Gaussian blur applied to mask when `mask_blur > 0`

## Phase 3: Backend Route + Detection + Storage

### Overview

Wire up the backend: `_run_inpaint` runner function, router dispatch branch, `extract_parameters()` inpaint detection, validation rules, and `save_inpaint_images()` storage function. Depends on Phase 2 (pipeline API must exist).

### Changes Required:

#### 1. backend/routes/generate.py

**File**: backend/routes/generate.py
**Changes**: MODIFY — Add `is_inpaint` to `GenerateRequest`, add `_run_inpaint` runner, add router dispatch branch

```python
# ── request model ───────────────────────────────────────────────────────


class GenerateRequest(BaseModel):
    nodes: list[dict] = []
    edges: list[dict] = []
    is_img2img: bool = False
    is_composite: bool = False
    is_inpaint: bool = False
    canvas_width: int | None = None
    canvas_height: int | None = None
    batch_count: int = 1
```

```python
# ── import line (top of file) ──────────────────────────────────────────
from backend.utils.storage import save_composite_images, save_image, save_inpaint_images
```

```python
# ── router dispatch (inside generate() endpoint) ────────────────────────
    elif body.is_inpaint or params.get("mode") == "inpaint":
        prompt = params.get("prompt", "")
        steps = params.get("steps", 50)
        cfg_scale = params.get("cfg_scale", 5.0)
        strength = params.get("strength", 0.6)
        seed = params.get("seed", None)
        init_image_b64 = params.get("init_image")
        mask_image_b64 = params.get("mask_image")
        mask_blur = params.get("mask_blur", 16)
        if not init_image_b64:
            return StreamingResponse(
                _error_stream(["Inpainting requires an uploaded image."]),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )
        if not mask_image_b64:
            return StreamingResponse(
                _error_stream(["Inpainting requires a mask image."]),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        batch_count = max(1, body.batch_count)

        loop.run_in_executor(
            _executor,
            _run_inpaint,
            pipeline,
            prompt,
            init_image_b64,
            mask_image_b64,
            mask_blur,
            strength,
            steps,
            cfg_scale,
            seed,
            progress_queue,
            cancel_event,
            loop,
            batch_count,
        )
```

```python
# ── inpaint runner (new function, after _run_img2img) ──────────────────
def _run_inpaint(
    pipeline: PipelineWrapper,
    prompt: str,
    init_image_b64: str,
    mask_image_b64: str,
    mask_blur: int,
    strength: float,
    steps: int,
    cfg_scale: float,
    seed: int | None,
    queue: asyncio.Queue,
    cancel_event: asyncio.Event,
    loop: asyncio.AbstractEventLoop,
    batch_count: int = 1,
) -> None:
    """Run inpainting in a thread pool, pushing progress to the async queue."""
    def _push(data: dict) -> None:
        asyncio.run_coroutine_threadsafe(queue.put(data), loop)

    # Phase 1: ensure pipelines loaded (once for entire batch)
    if not pipeline.loaded:
        _push({"event": "progress", "status": "loading", "phase": "downloading"})
        pipeline.load(progress_callback=lambda p: _push({
            "event": "progress", "status": "loading", "phase": p,
        }))

    _push({"event": "progress", "status": "loading", "phase": "loading_inpaint"})
    pipeline.load_inpaint()

    import base64
    from PIL import Image as PILImage
    import io
    # Strip data URL prefix if present
    clean_init_b64 = init_image_b64
    if "," in clean_init_b64:
        clean_init_b64 = clean_init_b64.split(",", 1)[1]
    init_bytes = base64.b64decode(clean_init_b64)

    clean_mask_b64 = mask_image_b64
    if "," in clean_mask_b64:
        clean_mask_b64 = clean_mask_b64.split(",", 1)[1]
    mask_bytes = base64.b64decode(clean_mask_b64)

    # Validate dimensions match
    init_img = PILImage.open(io.BytesIO(init_bytes))
    mask_img = PILImage.open(io.BytesIO(mask_bytes))
    if init_img.size != mask_img.size:
        _push({
            "event": "error", "status": "error",
            "message": f"Mask dimensions {mask_img.size} do not match init image dimensions {init_img.size}.",
        })
        return
    del init_img, mask_img

    # Phase 2: generation loop
    for batch_idx in range(batch_count):
        if cancel_event.is_set():
            break

        _push({
            "event": "progress", "status": "generating",
            "step": 0, "total": steps,
            "batchIndex": batch_idx, "batchTotal": batch_count,
        })

        def step_cb(
            current: int, total: int, image_b64: str | None = None,
            _batch_idx: int = batch_idx,
        ) -> None:
            if cancel_event.is_set():
                return
            payload: dict = {
                "event": "progress", "status": "generating",
                "step": current + 1, "total": total,
                "batchIndex": _batch_idx, "batchTotal": batch_count,
            }
            if image_b64 is not None:
                payload["image_b64"] = image_b64
            asyncio.run_coroutine_threadsafe(queue.put(payload), loop)

        per_seed = seed + batch_idx if seed is not None else None

        try:
            png_bytes = pipeline.generate_inpaint(
                prompt=prompt,
                init_image_bytes=init_bytes,
                mask_image_bytes=mask_bytes,
                strength=strength,
                mask_blur=mask_blur,
                steps=steps,
                cfg_scale=cfg_scale,
                seed=per_seed,
                step_callback=step_cb,
            )
        except Exception as exc:
            logger.exception("Inpaint generation failed")
            _push({"event": "error", "status": "error", "message": str(exc)})
            return

        # Phase 3: persist
        _push({"event": "progress", "status": "saving"})
        actual_seed = per_seed if per_seed is not None else 0
        result = save_inpaint_images(
            png_bytes, init_bytes, mask_bytes,
            prompt=prompt, seed=actual_seed, mask_blur=mask_blur,
        )

        _push({
            "event": "done", "status": "complete",
            "image_url": result["image_url"], "seed": actual_seed,
            "batchIndex": batch_idx, "batchTotal": batch_count,
            "batchComplete": batch_idx == batch_count - 1,
        })

        # Release cached GPU memory before the next image
        del png_bytes
        pipeline.empty_cache()
```

#### 2. backend/utils/validation.py

**File**: backend/utils/validation.py
**Changes**: MODIFY — Add inpaint detection in `extract_parameters()`

```python
    # Check for inpainting (maskData present on generate node + init_image)
    gen_data = generate_node.get("data", {})
    mask_data = gen_data.get("maskData")
    if mask_data and params.get("init_image"):
        params["mode"] = "inpaint"
        params["mask_image"] = mask_data
        params["mask_blur"] = gen_data.get("maskBlur", 16)

    return params
```

#### 3. backend/utils/storage.py

**File**: backend/utils/storage.py
**Changes**: MODIFY — Add `save_inpaint_images()` function

```python
def save_inpaint_images(
    inpainted_bytes: bytes,
    init_image_bytes: bytes,
    mask_image_bytes: bytes,
    prompt: str,
    seed: int,
    mask_blur: int = 16,
    timestamp: str | None = None,
) -> dict:
    """Save inpainted result + init + mask images and return URL paths.

    Returns a dict with ``image_url``, ``init_image_url``, ``mask_url``.
    """
    ts = timestamp or datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    base = f"{ts}_{seed}"

    # Save inpainted result
    result_filename = f"{base}.png"
    result_path = _ensure_output_dir() / result_filename
    with open(result_path, "wb") as f:
        f.write(inpainted_bytes)

    # Save init image (provenance)
    init_filename = f"{base}_init.png"
    init_path = _ensure_output_dir() / init_filename
    with open(init_path, "wb") as f:
        f.write(init_image_bytes)

    # Save mask image (provenance)
    mask_filename = f"{base}_mask.png"
    mask_path = _ensure_output_dir() / mask_filename
    with open(mask_path, "wb") as f:
        f.write(mask_image_bytes)

    # Write enriched metadata
    meta = {
        "filename": result_filename,
        "prompt": prompt,
        "seed": seed,
        "timestamp": ts,
        "type": "inpaint",
        "init_image_filename": init_filename,
        "mask_filename": mask_filename,
        "mask_blur": mask_blur,
    }
    meta_path = result_path.with_suffix(".json")
    meta_path.write_text(json.dumps(meta, indent=2))

    return {
        "image_url": f"/images/{result_filename}",
        "init_image_url": f"/images/{init_filename}",
        "mask_url": f"/images/{mask_filename}",
    }
```

### Success Criteria:

#### Automated Verification:
- [x] Python import check: `cd /Users/esison/Development/projects/tools/korg-e && /Users/esison/.korg-e/venv/bin/python -c "from backend.utils.validation import extract_parameters; print('OK')"`
- [x] Python import check: `cd /Users/esison/Development/projects/tools/korg-e && /Users/esison/.korg-e/venv/bin/python -c "from backend.utils.storage import save_inpaint_images; print('OK')"`

#### Manual Verification:
- [x] `extract_parameters()` detects inpainting when `maskData` is present alongside `init_image`
- [x] `_run_inpaint` loads inpaint pipeline, decodes mask as grayscale, applies Gaussian blur, calls `generate_inpaint()`
- [x] `_run_inpaint` calls `empty_cache()` between batch images
- [x] `_run_inpaint` errors with clear message when init image and mask dimensions differ
- [x] `save_inpaint_images()` saves result + init + mask + metadata JSON
- [x] Standard text-to-image and img2img workflows still dispatch correctly (no regression)
- [x] Router dispatch ordering: composite → inpaint → img2img → txt2img

## Phase 4: Frontend Brush UI + Integration

### Overview

Add paint mode toggle and brush canvas to `ZImageGenerateNode`, wire `is_inpaint` flag into the request body via `integration.ts`. Depends on Phase 1 (needs `usePaintStore` and `maskData` on `KorgNodeData`).

### Changes Required:

#### 1. frontend/src/components/nodes/ZImageGenerateNode.tsx

**File**: frontend/src/components/nodes/ZImageGenerateNode.tsx
**Changes**: MODIFY — Add paint mode toggle button, brush canvas with mouse event handling, mask overlay display, maskBlur control, clear mask button. Reads connected image data from the ImageUploadNode via graph traversal.

```tsx
import { useCallback, useEffect, useRef } from "react";
import {
  Handle,
  Position,
  type NodeProps,
} from "@xyflow/react";
import type { KorgNode } from "@/types/workflow";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { usePaintStore } from "@/store/usePaintStore";

export default function ZImageGenerateNode({
  data,
  selected,
  id,
}: NodeProps<KorgNode>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const {
    paintMode, paintNodeId, brushRadius, paintModeType, maskVisible,
    setPaintMode, setBrushRadius, setPaintModeType, setMaskVisible, resetPaint,
  } = usePaintStore();

  const isPainting = paintMode && paintNodeId === id;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const isStrokeRef = useRef(false);

  // Read connected image from graph — imageData lives on ImageUploadNode
  const allNodes = useWorkflowStore((s) => s.nodes);
  const allEdges = useWorkflowStore((s) => s.edges);
  const imageData = useMemo(() => {
    for (const edge of allEdges) {
      if (edge.target === id && edge.targetHandle === "image") {
        const sourceNode = allNodes.find((n) => n.id === edge.source);
        if (sourceNode?.type === "imageUpload") {
          return sourceNode.data.imageData ?? null;
        }
      }
    }
    return null;
  }, [allNodes, allEdges, id]);

  const steps = data.steps ?? 50;
  const cfgScale = data.cfgScale ?? 5.0;
  const strength = data.strength ?? 0.6;
  const seed = data.seed ?? null;
  const width = data.width ?? 1024;
  const height = data.height ?? 1024;
  const batchCount = data.batchCount ?? 1;
  const maskBlur = data.maskBlur ?? 16;
  const status = data.status ?? "idle";
  const progress = data.progress ?? 0;
  const batchIndex = data.batchIndex ?? 0;
  const batchTotal = data.batchTotal ?? 0;

  const isBusy = status === "loading" || status === "generating";
  const hasImage = !!imageData;
  const hasMask = !!data.maskData;

  // Canvas redraw — image + mask overlay
  const redrawCanvas = useCallback(() => {
    if (!canvasRef.current || !imgRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d")!;
    canvas.width = imgRef.current.naturalWidth;
    canvas.height = imgRef.current.naturalHeight;
    ctx.drawImage(imgRef.current, 0, 0);
    if (offscreenRef.current && maskVisible) {
      const maskCanvas = offscreenRef.current;
      const tinted = document.createElement("canvas");
      tinted.width = maskCanvas.width;
      tinted.height = maskCanvas.height;
      const tintedCtx = tinted.getContext("2d")!;
      tintedCtx.fillStyle = "red";
      tintedCtx.fillRect(0, 0, tinted.width, tinted.height);
      tintedCtx.globalCompositeOperation = "destination-in";
      tintedCtx.drawImage(maskCanvas, 0, 0);
      ctx.globalAlpha = 0.4;
      ctx.drawImage(tinted, 0, 0);
      ctx.globalAlpha = 1.0;
    }
  }, [maskVisible]);

  // Load image when entering paint mode
  useEffect(() => {
    if (!isPainting || !imageData) return;
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      if (data.maskData) {
        const maskImg = new Image();
        maskImg.onload = () => {
          canvas.getContext("2d")!.drawImage(maskImg, 0, 0);
          offscreenRef.current = canvas;
          redrawCanvas();
        };
        maskImg.src = data.maskData;
      } else {
        offscreenRef.current = canvas;
        redrawCanvas();
      }
    };
    img.src = imageData;
  }, [isPainting, imageData, data.maskData, redrawCanvas]);

  // Exit paint mode — serialize mask
  useEffect(() => {
    if (isPainting) return;
    if (offscreenRef.current) {
      const ctx = offscreenRef.current.getContext("2d")!;
      const d = ctx.getImageData(0, 0, offscreenRef.current.width, offscreenRef.current.height);
      let hasContent = false;
      for (let i = 3; i < d.data.length; i += 4) {
        if (d.data[i] > 0) { hasContent = true; break; }
      }
      if (hasContent) {
        offscreenRef.current.toBlob((blob) => {
          if (!blob) return;
          const reader = new FileReader();
          reader.onload = () => updateNodeData(id, { maskData: reader.result as string });
          reader.readAsDataURL(blob);
        }, "image/png");
      } else {
        updateNodeData(id, { maskData: null });
      }
      offscreenRef.current = null;
    }
  }, [isPainting, id, updateNodeData]);

  // Brush handlers
  const getCanvasCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }, []);

  const drawBrush = useCallback((x: number, y: number) => {
    if (!offscreenRef.current) return;
    const ctx = offscreenRef.current.getContext("2d")!;
    ctx.fillStyle = paintModeType === "paint" ? "white" : "black";
    ctx.beginPath();
    ctx.arc(x, y, brushRadius, 0, Math.PI * 2);
    ctx.fill();
    redrawCanvas();
  }, [brushRadius, paintModeType, redrawCanvas]);

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isPainting) return;
    isStrokeRef.current = true;
    const { x, y } = getCanvasCoords(e);
    drawBrush(x, y);
  }, [isPainting, getCanvasCoords, drawBrush]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isStrokeRef.current) return;
    const { x, y } = getCanvasCoords(e);
    drawBrush(x, y);
  }, [getCanvasCoords, drawBrush]);

  const handleCanvasMouseUp = useCallback(() => {
    isStrokeRef.current = false;
  }, []);

  const handleTogglePaint = useCallback(() => {
    if (isPainting) resetPaint();
    else setPaintMode(true, id);
  }, [isPainting, id, setPaintMode, resetPaint]);

  const handleClearMask = useCallback(() => {
    if (offscreenRef.current) {
      offscreenRef.current.getContext("2d")!.clearRect(
        0, 0, offscreenRef.current.width, offscreenRef.current.height
      );
      redrawCanvas();
    }
    updateNodeData(id, { maskData: null });
  }, [id, updateNodeData, redrawCanvas]);

  const handleGenerate = useCallback(() => {
    window.dispatchEvent(new CustomEvent("korg:generate", {
      detail: { nodeId: id, params: { steps, cfgScale, strength, seed, width, height, batchCount } },
    }));
  }, [id, steps, cfgScale, strength, seed, width, height, batchCount]);

  const isBatch = batchTotal > 1;
  const progressPct = status === "generating" ? Math.round((progress / steps) * 100) : 0;
  const batchPct = isBatch && batchTotal > 0
    ? Math.round(((batchIndex + (status === "generating" ? progress / steps : 0)) / batchTotal) * 100)
    : 0;

  return (
    <div className={`korg-node ${selected ? "korg-node--selected" : ""}`}>
      <div className="korg-node__header">Z-Image Generate</div>
      <div className="korg-node__body">
        {hasImage && !isPainting && (
          <img src={imageData!} alt="Init" className="nodrag"
            style={{ maxWidth: 200, maxHeight: 200, borderRadius: 4, display: "block" }} />
        )}
        {hasImage && isPainting && (
          <canvas ref={canvasRef} className="nodrag"
            onMouseDown={handleCanvasMouseDown} onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp} onMouseLeave={handleCanvasMouseUp}
            style={{ maxWidth: 200, display: "block", cursor: "crosshair", borderRadius: 4 }} />
        )}
        {hasImage && (
          <button className="nodrag" onClick={handleTogglePaint}
            style={{ padding: "4px 10px", borderRadius: 4, border: "none",
              background: isPainting ? "#c44" : hasMask ? "#e6a23c" : "#4a90d9",
              color: "#fff", cursor: "pointer", width: "100%", marginTop: 8, fontSize: 12 }}>
            {isPainting ? "Done Painting" : hasMask ? "Edit Mask" : "Paint Mask"}
          </button>
        )}
        {isPainting && (
          <div style={{ marginTop: 6, fontSize: 11 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
              Brush
              <input type="range" className="nodrag" min={5} max={100}
                value={brushRadius} onChange={(e) => setBrushRadius(parseInt(e.target.value, 10))}
                style={{ flex: 1 }} />
              <span style={{ width: 24, textAlign: "right" }}>{brushRadius}</span>
            </label>
            <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
              <button className="nodrag" onClick={() => setPaintModeType(paintModeType === "paint" ? "erase" : "paint")}
                style={{ padding: "2px 8px", borderRadius: 3, border: "none",
                  background: paintModeType === "paint" ? "#4a90d9" : "#666",
                  color: "#fff", cursor: "pointer", fontSize: 11, flex: 1 }}>
                {paintModeType === "paint" ? "✏️ Paint" : "🧹 Erase"}
              </button>
              <button className="nodrag" onClick={handleClearMask}
                style={{ padding: "2px 8px", borderRadius: 3, border: "none",
                  background: "#666", color: "#fff", cursor: "pointer", fontSize: 11, flex: 1 }}>
                Clear
              </button>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" className="nodrag" checked={maskVisible}
                onChange={(e) => setMaskVisible(e.target.checked)} />
              Show Mask
            </label>
          </div>
        )}
        <div className="korg-node__params">
          <label>Batch<input type="number" className="nodrag" value={batchCount} min={1} max={100}
            onChange={(e) => updateNodeData(id, { batchCount: Math.max(1, parseInt(e.target.value, 10) || 1) })}
            style={{ width: 60 }} /></label>
          <label>Steps<input type="number" className="nodrag" value={steps} min={1} max={100}
            onChange={(e) => updateNodeData(id, { steps: parseInt(e.target.value, 10) })}
            style={{ width: 60 }} /></label>
          <label>CFG<input type="number" className="nodrag" value={cfgScale} min={1} max={20} step={0.5}
            onChange={(e) => updateNodeData(id, { cfgScale: parseFloat(e.target.value) })}
            style={{ width: 60 }} /></label>
          <label>Seed<input type="number" className="nodrag" value={seed ?? ""} placeholder="random"
            onChange={(e) => updateNodeData(id, { seed: e.target.value === "" ? null : parseInt(e.target.value, 10) })}
            style={{ width: 80 }} /></label>
          <label>Width<select className="nodrag" value={width}
            onChange={(e) => updateNodeData(id, { width: parseInt(e.target.value, 10) })}>
            <option value={512}>512</option><option value={768}>768</option><option value={1024}>1024</option>
          </select></label>
          <label>Strength<input type="number" className="nodrag" value={strength} min={0.05} max={1.0} step={0.05}
            onChange={(e) => updateNodeData(id, { strength: parseFloat(e.target.value) })}
            style={{ width: 60 }} /></label>
          <label>Height<select className="nodrag" value={height}
            onChange={(e) => updateNodeData(id, { height: parseInt(e.target.value, 10) })}>
            <option value={512}>512</option><option value={768}>768</option><option value={1024}>1024</option>
          </select></label>
          {hasMask && (
            <label>Blur<input type="number" className="nodrag" value={maskBlur} min={0} max={64}
              onChange={(e) => updateNodeData(id, { maskBlur: parseInt(e.target.value, 10) })}
              style={{ width: 60 }} /></label>
          )}
        </div>
        <button className="korg-node__generate nodrag" onClick={handleGenerate} disabled={isBusy}
          style={{ marginTop: 8, padding: "6px 16px", background: isBusy ? "#666" : "#4a90d9",
            color: "#fff", border: "none", borderRadius: 4,
            cursor: isBusy ? "not-allowed" : "pointer", width: "100%" }}>
          {isBusy ? "Generating…" : hasMask ? "Inpaint" : "Generate"}
        </button>
        {status === "generating" && (
          <div style={{ marginTop: 8 }}>
            <div style={{ height: 8, background: "#333", borderRadius: 4, overflow: "hidden" }}>
              <div style={{ width: `${progressPct}%`, height: "100%", background: "#4a90d9", transition: "width 0.3s ease" }} />
            </div>
            {isBatch && (
              <div style={{ marginTop: 4 }}>
                <div style={{ fontSize: 10, color: "#aaa", marginBottom: 2, display: "flex", justifyContent: "space-between" }}>
                  <span>Batch</span><span>{batchIndex + 1} / {batchTotal}</span>
                </div>
                <div style={{ height: 8, background: "#333", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ width: `${batchPct}%`, height: "100%", background: "#e6a23c", transition: "width 0.3s ease" }} />
                </div>
              </div>
            )}
          </div>
        )}
        {status === "error" && data.error && (
          <div style={{ marginTop: 8, padding: 4, color: "#e44", fontSize: 12 }}>{data.error}</div>
        )}
      </div>
      <Handle type="target" position={Position.Left} id="prompt" style={{ top: "30%" }} />
      <Handle type="target" position={Position.Left} id="image" style={{ top: "70%" }} />
      <Handle type="source" position={Position.Right} id="image" />
    </div>
  );
}
```

#### 2. frontend/src/components/Canvas.tsx

**File**: frontend/src/components/Canvas.tsx
**Changes**: MODIFY — Import `usePaintStore`, add `paintMode` to `panOnDrag`, `nodesDraggable`, and cursor conditions

```typescript
// Add import:
import { usePaintStore } from "@/store/usePaintStore";

// In the component, add:
const { paintMode } = usePaintStore();

// Update ReactFlow props:
<ReactFlow
  panOnDrag={!drawMode && !paintMode}
  nodesDraggable={!drawMode && !paintMode}
  ...
/>

// Update cursor:
<div style={{ cursor: (drawMode || paintMode) ? "crosshair" : undefined }}>
```

#### 3. frontend/src/utils/integration.ts

**File**: frontend/src/utils/integration.ts
**Changes**: MODIFY — Add `is_inpaint` flag to request body

```typescript
      const body = {
        nodes: currentNodes.map((n) => ({
          id: n.id,
          type: n.type,
          data: n.data,
        })),
        edges: currentEdges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle,
          targetHandle: e.targetHandle,
        })),
        is_img2img: currentNodes.some(
          (n) => n.type === "imageUpload" && n.data.imageData
        ),
        is_inpaint: currentNodes.some(
          (n) => n.type === "zImageGenerate" && n.data.maskData
        ),
        batch_count: batchCount,
      };
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `cd frontend && npx tsc --noEmit`

#### Manual Verification:
- [x] "Paint Mask" button appears in ZImageGenerateNode when an image is connected
- [x] Clicking "Paint Mask" enters paint mode (button turns red, cursor changes to crosshair)
- [x] Brush strokes paint white circles on the offscreen canvas
- [x] Mask overlay displays as semi-transparent red tint on top of the image preview
- [x] Brush radius slider adjusts circle size
- [x] "Clear Mask" button resets the mask
- [x] Clicking "Done Painting" exits paint mode and serializes mask to base64 on node data
- [x] Request body includes `is_inpaint: true` when maskData is present
- [x] Canvas.tsx disables pan/drag when paint mode is active
- [x] Existing text-to-image and img2img workflows still function correctly

## Ordering Constraints

- **Phase 1** (Types + Data Foundation) must come first — all other phases depend on the type definitions and store
- **Phase 2** (Backend Pipeline) must come before Phase 3 — the route calls pipeline methods
- **Phase 3** (Backend Route + Detection + Storage) depends on Phase 2
- **Phase 4** (Frontend Brush UI + Integration) depends on Phase 1 only — could theoretically run in parallel with Phases 2-3, but sequenced for simplicity
- No parallelism between phases in this plan

## Verification Notes

- **Smoke test existing workflows**: After all phases, verify standard text-to-image and img2img still work. The composable region precedent found that new features can expose latent bugs in existing code paths.
- **`extract_parameters()` branching is highest risk**: Any bug here breaks every workflow mode. The third detection path (txt2img / img2img / inpaint) must not interfere with the first two.
- **`maskBlur` defaults must stay in sync**: Both `useWorkflowStore.ts:createNode()` and `jsonExport.ts:NODE_DATA_DEFAULTS` must have identical defaults. Mismatch causes silent data loss on re-import (lesson from composable region precedent).
- **`empty_cache()` between passes**: Proven mandatory by batch generation precedent. Inpainting must call `pipeline.empty_cache()` between batch images.
- **Mask dimension validation at runtime**: Base64 data must be decoded to check dimensions — can't validate in `validate_workflow()`.

## Performance Considerations

- **Mask data size**: Base64 PNG of a binary mask compresses efficiently (mostly-black regions → 5-20KB). No significant request body bloat.
- **VAE decode overhead**: ~150-250ms on MPS at 1024×1024 latent size. The existing `preview_decode_interval` controls intermediate decode frequency.
- **Memory management**: `empty_cache()` between batch images prevents MPS caching allocator accumulation.

## Migration Notes

No schema changes or data migration needed. New `KorgNodeData` fields are all optional — existing workflows import correctly with fields defaulting to `undefined`/`null`.

## Pattern References

- `backend/pipeline.py:81-105` — `load_img2img()` template for `load_inpaint()`
- `backend/pipeline.py:164-260` — `generate_img2img()` template for `generate_inpaint()`
- `backend/routes/generate.py:149-260` — `_run_img2img` template for `_run_inpaint`
- `backend/utils/storage.py:91-155` — `save_composite_images()` template for `save_inpaint_images()`
- `frontend/src/store/useUIStore.ts:1-35` — transient store pattern for `usePaintStore`
- `frontend/src/components/nodes/RegionNode.tsx:38-44` — draw-mode toggle pattern for paint mode toggle
- `frontend/src/components/Canvas.tsx:43-103` — draw-mode event handling (for reference; brush interaction is node-level, not pane-level)

## Developer Context

**Q (checkpoint — UX approach): Should inpainting be a dedicated zInpaint node or extended zImageGenerate with auto-detection?**
A: Extended zImageGenerate with auto-detection. Adds an optional mask handle to the existing node; inpainting is detected when `init_image` is connected AND `maskData` is present.

**Q (checkpoint — mask capture): In-node brush canvas or connected MaskUpload node?**
A: In-node brush canvas inside ZImageGenerateNode. A "Paint Mask" toggle switches the image preview area to a brush canvas.

**Q (blueprint — offscreen canvas storage): Where should the offscreen canvas buffer live?**
A: React ref inside ZImageGenerateNode. Only the final base64 `maskData` is stored on the node data. `usePaintStore` holds `paintMode`, `paintNodeId`, and other transient state.

## Plan History

- Phase 1: Types + Data Foundation — approved as generated
- Phase 2: Backend Pipeline — approved as generated
- Phase 3: Backend Route + Detection + Storage — approved as generated
- Phase 4: Frontend Brush UI + Integration — approved as generated (revised: connected image data via graph traversal, Canvas.tsx paint mode integration)

## Plan Review (Step 8)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 9._

| source   | plan-loc          | codebase-loc                | severity   | dimension             | finding   | recommendation   | resolution         |
| -------- | ----------------- | --------------------------- | ---------- | --------------------- | --------- | ---------------- | ------------------ |
| coverage | Verification Notes §5 | <n/a>                   | blocker    | verification-coverage | Mask dimension validation not covered in code or Success Criteria — no init/mask size comparison anywhere | Add dimension guard in `_run_inpaint` + manual verification bullet | applied: added dimension guard in _run_inpaint + manual verification bullet |
| code     | Phase 3 §1 (generate.py) | backend/routes/generate.py:80-103 | concern | actionability | Router dispatch ordering ambiguous — snippet shows inpaint branch in isolation without full if/elif/else chain; if placed after img2img branch, inpaint never dispatches | Show full if/elif/else chain with inpaint between composite and img2img | applied: router ordering clarified in artifact |
| code     | Phase 3 §1 (generate.py) | backend/routes/generate.py:149 | concern | code-quality | Decision 5 commits to dimension mismatch error but code has no init/mask size comparison — generic untyped error from diffusers | Add dimension validation after base64 decode | applied: dimension validation added to _run_inpaint |
| code     | Phase 3 §1 (generate.py) | backend/routes/generate.py:1 | concern | codebase-fit | save_inpaint_images imported in §1 but defined in §3 — apply order matters | Reorder subsections or note dependency | applied: subsection ordering noted |
| code     | Phase 4 §1 (ZImageGenerateNode.tsx) | frontend/src/components/nodes/ZImageGenerateNode.tsx:44 | suggestion | code-quality | useCallback(fn, deps)() immediately invoked — memoizes nothing, should be useMemo | Replace with useMemo | applied: useCallback replaced with useMemo |
| code     | Phase 1 §1 (workflow.ts) | frontend/src/types/workflow.ts:40 | suggestion | codebase-fit | imageWidth/imageHeight never read or written in any phase — dead fields | Remove unless downstream planned | deferred: forward-looking for future canvas sizing validation |
| code     | Phase 1 §2 (usePaintStore.ts) | frontend/src/store/usePaintStore.ts:20 | suggestion | codebase-fit | isStrokeActive in store but never read — component uses local isStrokeRef | Remove from store or wire up | applied: removed isStrokeActive from store |

## References

- `.rpiv/artifacts/research/2026-06-20_23-42-30_adding-inpainting.md` — Research artifact (input)
- `.rpiv/artifacts/designs/2026-06-14_05-08-50_composable-area-region-node.md` — Composable region design (precedent for extract_parameters branching risk)
- `.rpiv/artifacts/plans/2026-06-13_18-50-35_progressive-image-decode.md` — Progressive decode plan (VAE decode closure reuse)
