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
from backend.utils.storage import save_composite_images, save_image, save_inpaint_images
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
    is_composite: bool = False
    is_inpaint: bool = False
    canvas_width: int | None = None
    canvas_height: int | None = None
    batch_count: int = 1


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

    # ── 4. Start generation in thread pool ─────────────────────────────
    loop = asyncio.get_running_loop()

    # ── Composite mode ─────────────────────────────────────────────────
    if body.is_composite or params.get("mode") == "composite":
        regions = params.get("regions", [])
        canvas_w = body.canvas_width or params.get("canvas_width", 1024)
        canvas_h = body.canvas_height or params.get("canvas_height", 1024)

        loop.run_in_executor(
            _executor,
            _run_composite,
            pipeline,
            regions,
            canvas_w,
            canvas_h,
            progress_queue,
            cancel_event,
            loop,
        )
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
    elif body.is_img2img:
        prompt = params.get("prompt", "")
        steps = params.get("steps", 50)
        cfg_scale = params.get("cfg_scale", 5.0)
        strength = params.get("strength", 0.6)
        seed = params.get("seed", None)
        init_image_b64 = params.get("init_image")
        if not init_image_b64:
            return StreamingResponse(
                _error_stream(["Image-to-image requires an uploaded image."]),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        batch_count = max(1, body.batch_count)

        loop.run_in_executor(
            _executor,
            _run_img2img,
            pipeline,
            prompt,
            init_image_b64,
            strength,
            steps,
            cfg_scale,
            seed,
            progress_queue,
            cancel_event,
            loop,
            batch_count,
        )
    else:
        prompt = params.get("prompt", "")
        steps = params.get("steps", 50)
        cfg_scale = params.get("cfg_scale", 5.0)
        seed = params.get("seed", None)
        width = params.get("width", 1024)
        height = params.get("height", 1024)

        batch_count = max(1, body.batch_count)

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
            batch_count,
        )

    # ── 5. Return SSE stream ───────────────────────────────────────────
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
    batch_count: int = 1,
) -> None:
    """Run t2i in a thread pool, pushing progress to the async queue.

    When batch_count > 1, generates that many images sequentially,
    emitting batchIndex/batchTotal in progress and done events.
    """
    def _push(data: dict) -> None:
        asyncio.run_coroutine_threadsafe(queue.put(data), loop)

    # Phase 1: ensure pipeline loaded (once for entire batch)
    if not pipeline.loaded:
        _push({"event": "progress", "status": "loading", "phase": "downloading"})
        pipeline.load(progress_callback=lambda p: _push({
            "event": "progress",
            "status": "loading",
            "phase": p,
        }))
        _push({"event": "progress", "status": "loading", "phase": "ready"})

    # Phase 2: generation loop
    for batch_idx in range(batch_count):
        if cancel_event.is_set():
            break

        _push({
            "event": "progress",
            "status": "generating",
            "step": 0,
            "total": steps,
            "batchIndex": batch_idx,
            "batchTotal": batch_count,
        })

        def step_cb(
            current: int, total: int, image_b64: str | None = None,
            _batch_idx: int = batch_idx,
        ) -> None:
            if cancel_event.is_set():
                return
            payload: dict = {
                "event": "progress",
                "status": "generating",
                "step": current + 1,
                "total": total,
                "batchIndex": _batch_idx,
                "batchTotal": batch_count,
            }
            if image_b64 is not None:
                payload["image_b64"] = image_b64
            asyncio.run_coroutine_threadsafe(queue.put(payload), loop)

        # Advance the seed per image so a batch is reproducible variations
        # rather than identical (fixed seed) or order-dependent (None → global RNG).
        per_seed = seed + batch_idx if seed is not None else None

        try:
            png_bytes = pipeline.generate(
                prompt=prompt,
                steps=steps,
                cfg_scale=cfg_scale,
                seed=per_seed,
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
        actual_seed = per_seed if per_seed is not None else 0
        path = save_image(png_bytes, prompt=prompt, seed=actual_seed)

        _push({
            "event": "done",
            "status": "complete",
            "image_url": f"/images/{path.name}",
            "seed": actual_seed,
            "batchIndex": batch_idx,
            "batchTotal": batch_count,
            "batchComplete": batch_idx == batch_count - 1,
        })

        # Release cached GPU memory before the next image so it can't
        # accumulate across the batch (slowdown + numerical degradation).
        del png_bytes
        pipeline.empty_cache()


def _run_img2img(
    pipeline: PipelineWrapper,
    prompt: str,
    init_image_b64: str,
    strength: float,
    steps: int,
    cfg_scale: float,
    seed: int | None,
    queue: asyncio.Queue,
    cancel_event: asyncio.Event,
    loop: asyncio.AbstractEventLoop,
    batch_count: int = 1,
) -> None:
    """Run i2i in a thread pool, pushing progress to the async queue.

    When batch_count > 1, generates that many images sequentially.
    """
    def _push(data: dict) -> None:
        asyncio.run_coroutine_threadsafe(queue.put(data), loop)

    # Phase 1: ensure both pipelines loaded (once for entire batch)
    if not pipeline.loaded:
        _push({"event": "progress", "status": "loading", "phase": "downloading"})
        pipeline.load(progress_callback=lambda p: _push({
            "event": "progress",
            "status": "loading",
            "phase": p,
        }))

    _push({"event": "progress", "status": "loading", "phase": "loading_img2img"})
    pipeline.load_img2img()

    import base64
    # Strip data URL prefix if present (frontend sends data:image/...;base64,...)
    clean_b64 = init_image_b64
    if "," in clean_b64:
        clean_b64 = clean_b64.split(",", 1)[1]
    init_bytes = base64.b64decode(clean_b64)

    # Phase 2: generation loop
    for batch_idx in range(batch_count):
        if cancel_event.is_set():
            break

        _push({
            "event": "progress",
            "status": "generating",
            "step": 0,
            "total": steps,
            "batchIndex": batch_idx,
            "batchTotal": batch_count,
        })

        def step_cb(
            current: int, total: int, image_b64: str | None = None,
            _batch_idx: int = batch_idx,
        ) -> None:
            if cancel_event.is_set():
                return
            payload: dict = {
                "event": "progress",
                "status": "generating",
                "step": current + 1,
                "total": total,
                "batchIndex": _batch_idx,
                "batchTotal": batch_count,
            }
            if image_b64 is not None:
                payload["image_b64"] = image_b64
            asyncio.run_coroutine_threadsafe(queue.put(payload), loop)

        # Advance the seed per image so a batch is reproducible variations
        # rather than identical (fixed seed) or order-dependent (None → global RNG).
        per_seed = seed + batch_idx if seed is not None else None

        try:
            png_bytes = pipeline.generate_img2img(
                prompt=prompt,
                init_image_bytes=init_bytes,
                strength=strength,
                steps=steps,
                cfg_scale=cfg_scale,
                seed=per_seed,
                step_callback=step_cb,
            )
        except Exception as exc:
            logger.exception("Img2img generation failed")
            _push({"event": "error", "status": "error", "message": str(exc)})
            return

        actual_seed = per_seed if per_seed is not None else 0
        path = save_image(png_bytes, prompt=prompt, seed=actual_seed)

        _push({
            "event": "done",
            "status": "complete",
            "image_url": f"/images/{path.name}",
            "seed": actual_seed,
            "batchIndex": batch_idx,
            "batchTotal": batch_count,
            "batchComplete": batch_idx == batch_count - 1,
        })

        # Release cached GPU memory before the next image so it can't
        # accumulate across the batch (slowdown + numerical degradation).
        del png_bytes
        pipeline.empty_cache()


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


# ── composite runner ──────────────────────────────────────────────────


def _run_composite(
    pipeline: PipelineWrapper,
    regions: list[dict],
    canvas_width: int,
    canvas_height: int,
    queue: asyncio.Queue,
    cancel_event: asyncio.Event,
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Run composite generation in a thread pool, pushing per-region SSE events."""
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

    _push({"event": "progress", "status": "generating", "step": 0, "total": sum(r.get("steps", 50) for r in regions)})

    def step_cb(
        region_index: int, current: int, total: int, region_id: str, image_b64: str | None = None
    ) -> None:
        if cancel_event.is_set():
            return
        payload: dict = {
            "event": "progress",
            "status": "generating",
            "regionId": region_id,
            "step": current + 1,
            "total": total,
        }
        if image_b64 is not None:
            payload["image_b64"] = image_b64
        asyncio.run_coroutine_threadsafe(queue.put(payload), loop)

    try:
        composite_png = pipeline.generate_composite(
            regions=regions,
            canvas_width=canvas_width,
            canvas_height=canvas_height,
            step_callback=step_cb,
        )
    except Exception as exc:
        logger.exception("Composite generation failed")
        _push({"event": "error", "status": "error", "message": str(exc)})
        return

    # Phase 3: persist per-region + composite images
    _push({"event": "progress", "status": "saving"})

    # Collect region metadata from the pipeline
    region_pngs = pipeline.get_region_images()

    # Build region metadata dicts for save_composite_images
    region_image_data: list[tuple[str, bytes, dict]] = []
    for region_id, png_bytes in region_pngs:
        region_info = next(
            (r for r in regions if r.get("region_id") == region_id),
            {},
        )
        region_image_data.append((
            region_id,
            png_bytes,
            {
                "prompt": region_info.get("prompt", ""),
                "seed": region_info.get("seed", 0) or 0,
                "x": region_info.get("region_x", 0),
                "y": region_info.get("region_y", 0),
                "width": region_info.get("region_width", 256),
                "height": region_info.get("region_height", 256),
            },
        ))

    actual_seed = regions[0].get("seed", 0) if regions else 0
    result = save_composite_images(
        composite_png,
        region_image_data,
        prompt=regions[0].get("prompt", "") if regions else "",
        seed=actual_seed or 0,
    )

    _push({
        "event": "done",
        "status": "complete",
        "image_url": result["image_url"],
        "seed": actual_seed or 0,
        "region_images": result["region_images"],
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
                # Keepalive comment
                yield ": keepalive\n\n"
                continue

            event_type = data.pop("event", "message")
            payload = json.dumps(data)
            yield f"event: {event_type}\ndata: {payload}\n\n"

            if event_type == "error":
                break
            if event_type == "done":
                # In batch mode, keep streaming until the last done event
                batch_complete = data.get("batchComplete")
                if batch_complete is not False:
                    break
    except asyncio.CancelledError:
        cancel_event.set()
        raise


async def _error_stream(errors: list[str]) -> AsyncIterable[str]:
    """Yield an error event and stop."""
    yield f"event: error\ndata: {json.dumps({'status': 'error', 'message': '; '.join(errors)})}\n\n"
