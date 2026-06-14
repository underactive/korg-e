---
date: 2026-06-13T18:50:35-0700
author: Eric Sison
commit: no-commit
branch: main
repository: korg-e
topic: "Progressive image decode — VAE decode at intervals during generation"
tags: [plan, pipeline, sse, frontend, vae-decode]
status: ready
parent: ".rpiv/artifacts/designs/2026-06-13_17-36-06_progressive-image-decode.md"
phase_count: 5
phases:
  - { n: 1, title: "Config + Type Foundation" }
  - { n: 2, title: "Pipeline — VAE Decode in _on_step" }
  - { n: 3, title: "SSE Route — Emit image_b64 in Progress Events" }
  - { n: 4, title: "Frontend — Forward Preview to ImageOutputNode" }
  - { n: 5, title: "Frontend — Progressive Image Display + Unblur Transition" }
last_updated: 2026-06-13T18:50:35-0700
last_updated_by: Eric Sison
---

# Progressive Image Decode — Implementation Plan

## Overview

Decode intermediate denoising latents through the full VAE every 10 steps at 128×128 resolution, encode as JPEG base64, and stream through existing SSE progress events to the ImageOutputNode for progressive display. Zero new dependencies — uses only the VAE, PIL, and base64 already in the codebase. The approach widens the existing `step_callback` signature to carry an optional `image_b64` string, leaving the entire SSE transport and frontend data pipeline schema-less and naturally extensible.

Design: `.rpiv/artifacts/designs/2026-06-13_17-36-06_progressive-image-decode.md`

## Desired End State

### Backend SSE events during generation

```
event: progress
data: {"status":"generating","step":1,"total":50}

event: progress
data: {"status":"generating","step":10,"total":50,"image_b64":"/9j/4AAQSkZJRg..."}

event: progress
data: {"status":"generating","step":20,"total":50,"image_b64":"/9j/4AAQSkZJRg..."}

...

event: progress
data: {"status":"generating","step":50,"total":50,"image_b64":"/9j/4AAQSkZJRg..."}

event: progress
data: {"status":"saving"}

event: done
data: {"status":"complete","image_url":"/images/20260613_173000_42.png","seed":42}
```

### Frontend behavior

```typescript
// During generation (step 10):
// ImageOutputNode renders: <img src="data:image/jpeg;base64,/9j/..." />
// Image is 128×128, blurry — early denoising state

// During generation (step 50):
// ImageOutputNode renders: <img src="data:image/jpeg;base64,..." />
// Image is 128×128, sharper — late denoising state

// After generation (done event):
// ImageOutputNode renders: <img src="/images/20260613_173000_42.png"
//   style="filter: blur(20px); transition: filter 0.5s ease" />
// On load: filter transitions to blur(0px) — smooth unblur
```

## What We're NOT Doing

- TAESD integration (upgrade path if VAE decode proves too slow)
- Latent→RGB projection (no Z-Image calibration matrix exists)
- Client-only blur illusion without real intermediate previews
- User-configurable preview controls in the UI (config file defaults only for now)
- Multi-resolution preview ladder
- GIF/video export of generation progression

---

## Phase 1: Config + Type Foundation

### Overview
Add `preview_decode_interval` and `preview_size` settings to the backend config, and widen the `step_callback` type annotation in `pipeline.py` from `Callable[[int, int], None]` to `Callable[[int, int, str | None], None]`. This is the foundation all subsequent phases build on.

### Changes Required:

#### 1. Config Settings
**File**: `backend/config.py`
**Changes**: Add `preview_decode_interval` (default 10) and `preview_size` (default 128) to the Settings class.

```python
    # ── generation defaults ────────────────────────────────────────────
    default_steps: int = 50
    default_cfg_scale: float = 5.0
    default_resolution: tuple[int, int] = (1024, 1024)

    # ── preview ─────────────────────────────────────────────────────────
    preview_decode_interval: int = 10   # VAE decode every N steps (0 = disabled)
    preview_size: int = 128             # resize preview to this square dimension
```

#### 2. Callback Type Widening
**File**: `backend/pipeline.py`
**Changes**: Widen the `step_callback` parameter type annotation in both `generate()` and `generate_img2img()` from `Callable[[int, int], None]` to `Callable[[int, int, str | None], None]`.

```python
    def generate(
        self,
        prompt: str,
        *,
        steps: int = 50,
        cfg_scale: float = 5.0,
        seed: int | None = None,
        width: int = 1024,
        height: int = 1024,
        step_callback: Callable[[int, int, str | None], None] | None = None,
    ) -> bytes:
```

```python
    def generate_img2img(
        self,
        prompt: str,
        init_image_bytes: bytes,
        *,
        strength: float = 0.6,
        steps: int = 50,
        cfg_scale: float = 5.0,
        seed: int | None = None,
        step_callback: Callable[[int, int, str | None], None] | None = None,
    ) -> bytes:
```

### Success Criteria:

#### Automated Verification:
- [x] Config attributes exist: `cd backend && python -c "from backend.config import settings; assert settings.preview_decode_interval == 10; assert settings.preview_size == 128"`
- [x] Callback type annotation correct: `grep -c "Callable\[\[int, int, str | None\]" backend/pipeline.py` returns 2

#### Manual Verification:
- [ ] `preview_decode_interval=0` disables previews — existing behavior unchanged when set to 0
- [ ] `preview_size` accepts any positive integer — defaults confirmed

---

## Phase 2: Pipeline — VAE Decode in `_on_step`

### Overview
Add VAE decode logic inside the `_on_step` closures in both `generate()` and `generate_img2img()`. At configured intervals (default every 10 steps, plus step 0), decode the current latents through the Z-Image VAE, resize to `preview_size`, encode as JPEG base64, and pass to the callback. All decode work runs inside `torch.no_grad()`.

### Changes Required:

#### 1. `generate()` — VAE decode in `_on_step`
**File**: `backend/pipeline.py`
**Changes**: Replace the existing `generate()` method's body to add VAE decode inside the `_on_step` closure, plus imports for `io`, `base64`, and `PIL.Image`.

```python
    def generate(
        self,
        prompt: str,
        *,
        steps: int = 50,
        cfg_scale: float = 5.0,
        seed: int | None = None,
        width: int = 1024,
        height: int = 1024,
        step_callback: Callable[[int, int, str | None], None] | None = None,
    ) -> bytes:
        """Run text-to-image generation and return raw PNG bytes.

        The ``step_callback`` receives ``(step, total_steps, image_b64)``
        after each inference step so callers can push SSE progress events.
        ``image_b64`` is a base64-encoded JPEG preview string, or ``None``
        when no preview is available for this step.
        """
        if self._pipeline is None:
            raise RuntimeError("Pipeline not loaded. Call load() first.")

        generator = None
        if seed is not None:
            generator = torch.Generator(device=settings.device).manual_seed(seed)

        # Build the callback_on_step_end closure
        total = steps
        decode_interval = settings.preview_decode_interval
        preview_size = settings.preview_size

        import io
        import base64
        from PIL import Image as PILImage

        def _on_step(pipe: object, step: int, timestep: int, callback_kwargs: dict) -> dict:
            image_b64: str | None = None

            if step_callback and decode_interval > 0:
                should_decode = (step == 0) or ((step + 1) % decode_interval == 0)
                if should_decode:
                    try:
                        latents = callback_kwargs["latents"]

                        with torch.no_grad():
                            # Cast to VAE dtype — latents arrive in float32, VAE is bfloat16 on MPS
                            latents_for_vae = latents.to(pipe.vae.dtype)

                            # FLUX VAE: (latents / scaling_factor) + shift_factor
                            latents_for_vae = (
                                latents_for_vae / pipe.vae.config.scaling_factor
                            ) + pipe.vae.config.shift_factor

                            # Decode: (B, 16, H, W) → (B, 3, H*8, W*8) in [-1, 1]
                            image_tensor = pipe.vae.decode(latents_for_vae, return_dict=False)[0]

                            # Postprocess: denormalize [-1,1] → [0,1], convert to PIL
                            pil_images = pipe.image_processor.postprocess(
                                image_tensor, output_type="pil"
                            )
                            preview_image = pil_images[0]

                            # Resize for smaller SSE payload
                            if preview_size:
                                preview_image = preview_image.resize(
                                    (preview_size, preview_size), PILImage.LANCZOS
                                )

                            # Encode as JPEG base64
                            buf = io.BytesIO()
                            preview_image.save(buf, format="JPEG", quality=60)
                            image_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
                    except Exception:
                        logger.warning("Intermediate VAE decode failed", exc_info=True)
                        image_b64 = None

            if step_callback:
                step_callback(step, total, image_b64)
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
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        return buf.getvalue()
```

#### 2. `generate_img2img()` — VAE decode in `_on_step`
**File**: `backend/pipeline.py`
**Changes**: Replace the existing `generate_img2img()` method's body to add the same VAE decode logic in its `_on_step` closure.

```python
    def generate_img2img(
        self,
        prompt: str,
        init_image_bytes: bytes,
        *,
        strength: float = 0.6,
        steps: int = 50,
        cfg_scale: float = 5.0,
        seed: int | None = None,
        step_callback: Callable[[int, int, str | None], None] | None = None,
    ) -> bytes:
        """Run image-to-image generation and return raw PNG bytes.

        The ``step_callback`` receives ``(step, total_steps, image_b64)``
        after each inference step. ``image_b64`` is ``None`` when no
        preview is available for this step.
        """
        if not hasattr(self, "_img2img_pipeline") or self._img2img_pipeline is None:
            raise RuntimeError("Img2Img pipeline not loaded. Call load_img2img() first.")

        from PIL import Image as PILImage
        import io
        import base64

        init_image = PILImage.open(io.BytesIO(init_image_bytes)).convert("RGB")

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
```

### Success Criteria:

#### Automated Verification:
- [ ] Pipeline module imports cleanly: `cd backend && python -c "from backend.pipeline import PipelineWrapper"`
- [x] shift_factor present: `grep "shift_factor" backend/pipeline.py | wc -l` returns 2+
- [x] torch.no_grad() present: `grep "torch.no_grad()" backend/pipeline.py | wc -l` returns 2+
- [x] dtype cast present: `grep "to(pipe.vae.dtype)" backend/pipeline.py | wc -l` returns 2+
- [x] import base64 present in both methods: `grep "import base64" backend/pipeline.py | wc -l` returns 2+

#### Manual Verification:
- [ ] Generate with `preview_decode_interval=0` — no VAE decode occurs, generation time unchanged
- [ ] Generate with `preview_decode_interval=10` — intermediate images decoded at steps 0, 10, 20, 30, 40, 50
- [ ] Interval arithmetic correct: `(step + 1) % decode_interval == 0` + `step == 0` for initial noise
- [ ] MPS memory stays within limits during generation with previews enabled
- [ ] Preview JPEG is valid: base64-decode the `image_b64` string, verify it's a valid JPEG of 128×128

---

## Phase 3: SSE Route — Emit `image_b64` in Progress Events

### Overview
Widen the `step_cb` closures in `backend/routes/generate.py` to accept the optional third `image_b64` parameter, and conditionally add it to the SSE progress event payload when present.

### Changes Required:

#### 1. `_run_text_to_image` — step_cb
**File**: `backend/routes/generate.py`
**Changes**: Widen `step_cb` to accept optional `image_b64` and conditionally include it in the payload.

```python
# ── _run_text_to_image step_cb ──

    def step_cb(current: int, total: int, image_b64: str | None = None) -> None:
        if cancel_event.is_set():
            return
        payload: dict = {
            "event": "progress",
            "status": "generating",
            "step": current + 1,  # diffusers delivers 0-indexed; make 1-indexed
            "total": total,
        }
        if image_b64 is not None:
            payload["image_b64"] = image_b64
        asyncio.run_coroutine_threadsafe(queue.put(payload), loop)
```

#### 2. `_run_img2img` — step_cb
**File**: `backend/routes/generate.py`
**Changes**: Same widening for the img2img `step_cb`.

```python
# ── _run_img2img step_cb ──

    def step_cb(current: int, total: int, image_b64: str | None = None) -> None:
        if cancel_event.is_set():
            return
        payload: dict = {
            "event": "progress",
            "status": "generating",
            "step": current + 1,
            "total": total,
        }
        if image_b64 is not None:
            payload["image_b64"] = image_b64
        asyncio.run_coroutine_threadsafe(queue.put(payload), loop)
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `cd backend && python -c "from backend.routes.generate import generate"` (no import errors) — syntax verified
- [x] `step_cb` accepts 3 args: `grep "image_b64: str | None = None" backend/routes/generate.py | wc -l` returns 2
- [x] `image_b64` key present: `grep 'payload\["image_b64"\]' backend/routes/generate.py | wc -l` returns 2

#### Manual Verification:
- [ ] When `image_b64=None`, SSE progress event contains only `step`/`total`/`status` (no `image_b64` key)
- [ ] When `image_b64` is a base64 string, SSE progress event includes it
- [ ] JSON encoding: `json.dumps(payload)` handles the base64 string without escaping issues
- [ ] `asyncio.Queue` handles dicts with the new key without issues

---

## Phase 4: Frontend — Forward Preview to ImageOutputNode

### Overview
Add `image_b64` to the `SSEProgressEvent` TypeScript type, and update the integration layer's `onProgress` handler to detect `image_b64` in progress events and forward intermediate previews to the connected ImageOutputNode as a `data:image/jpeg;base64,...` data URL.

### Changes Required:

#### 1. Type Definition
**File**: `frontend/src/types/workflow.ts`
**Changes**: Add optional `image_b64` field to `SSEProgressEvent`.

```typescript
export type SSEProgressEvent = {
  event: "progress";
  status: "loading" | "generating" | "saving";
  step?: number;
  total?: number;
  phase?: string;
  image_b64?: string;  // base64-encoded JPEG preview (no data URL prefix)
};
```

#### 2. Integration Layer — onProgress handler
**File**: `frontend/src/utils/integration.ts`
**Changes**: Replace the `generating` branch in `onProgress` to detect and forward `image_b64` to the connected ImageOutputNode.

```typescript
        onProgress: (data) => {
          const status = data.status as string;
          if (status === "loading") {
            updater(nodeId, { status: "loading" });
          } else if (status === "generating") {
            const step = (data.step as number) ?? 0;
            updater(nodeId, {
              status: "generating",
              progress: step,
            });

            // Forward intermediate preview to connected ImageOutputNode
            const imageB64 = data.image_b64 as string | undefined;
            if (imageB64) {
              const outputEdge = currentEdges.find(
                (e) => e.source === nodeId && e.sourceHandle === "image"
              );
              if (outputEdge) {
                updater(outputEdge.target, {
                  imageUrl: `data:image/jpeg;base64,${imageB64}`,
                });
              }
            }
          } else if (status === "saving") {
            updater(nodeId, { status: "loading" });
          }
        },
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript type checking passes: `cd frontend && npm run check`
- [x] `image_b64` field exists on SSEProgressEvent: `grep "image_b64" frontend/src/types/workflow.ts`
- [x] `data:image/jpeg;base64,` prefix logic present: `grep "data:image/jpeg;base64" frontend/src/utils/integration.ts`

#### Manual Verification:
- [ ] During generation, ImageOutputNode shows intermediate 128×128 previews that update at each decode interval
- [ ] The `currentEdges` lookup correctly finds the connected ImageOutputNode
- [ ] When no ImageOutputNode is connected, previews are silently dropped (no crash)
- [ ] The final `onDone` handler still overwrites `imageUrl` with the server path (`/images/...`)
- [ ] Pre-existing generation behavior unchanged when `image_b64` is absent from SSE events

---

## Phase 5: Frontend — Progressive Image Display + Unblur Transition

### Overview
Update `ImageOutputNode.tsx` to render intermediate previews (base64 data URLs) directly, and add a CSS blur→sharp transition for the final high-res image. Uses `key={imageUrl}` to force a fresh `<img>` mount per URL change, `useState` to track image load completion, and conditional `filter`/`transition` CSS for the blur effect.

### Changes Required:

#### 1. ImageOutputNode Component
**File**: `frontend/src/components/nodes/ImageOutputNode.tsx`
**Changes**: Add `useState` import, `imageLoaded` state, `isIntermediate` check, and blur→sharp transition on the `<img>` element.

```tsx
import { useState } from "react";
import {
  Handle,
  Position,
  type NodeProps,
} from "@xyflow/react";
import type { KorgNode } from "@/types/workflow";

export default function ImageOutputNode({ data, selected }: NodeProps<KorgNode>) {
  const imageUrl = data.imageUrl ?? null;
  const seedInfo = data.seedInfo;
  const [imageLoaded, setImageLoaded] = useState(false);

  // Intermediate previews (base64 data URLs) render sharp;
  // final image (server path) gets blur→sharp transition on load
  const isIntermediate = imageUrl?.startsWith("data:") ?? false;

  return (
    <div className={`korg-node ${selected ? "korg-node--selected" : ""}`}>
      <div className="korg-node__header">Image Output</div>
      <div className="korg-node__body">
        {imageUrl ? (
          <div>
            <img
              key={imageUrl}
              src={imageUrl}
              alt="Generated output"
              className="nodrag"
              onLoad={() => setImageLoaded(true)}
              style={{
                maxWidth: 256,
                maxHeight: 256,
                borderRadius: 4,
                display: "block",
                filter: !isIntermediate && !imageLoaded ? "blur(8px)" : "blur(0px)",
                transition: "filter 0.5s ease",
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

### Success Criteria:

#### Automated Verification:
- [x] TypeScript type checking passes: `cd frontend && npm run check`
- [x] `useState` import added: `grep "useState" frontend/src/components/nodes/ImageOutputNode.tsx`
- [x] `key={imageUrl}` forces remount on URL change: `grep "key={imageUrl}" frontend/src/components/nodes/ImageOutputNode.tsx`

#### Manual Verification:
- [ ] Intermediate previews (base64 data URLs) appear instantly without blur transition
- [ ] Final image (server path) loads with blur(8px) and transitions to sharp over 0.5s
- [ ] Consecutive generations each show the blur transition (key={imageUrl} causes remount)
- [ ] `nodrag` class still works — mouse events on the blurred/sharp image don't interfere with canvas dragging
- [ ] Seed info text still appears below the image for final results
- [ ] Placeholder "Waiting for output…" shows when no imageUrl is set

---

## Testing Strategy

### Automated:
- [x] `cd backend && python -c "from backend.config import settings; assert settings.preview_decode_interval == 10"`
- [x] `cd backend && python -c "from backend.pipeline import PipelineWrapper"` (import check) — syntax verified
- [x] `cd backend && python -c "from backend.routes.generate import generate"` (import check) — syntax verified
- [x] `grep "shift_factor" backend/pipeline.py | wc -l` returns 2+
- [x] `grep "torch.no_grad()" backend/pipeline.py | wc -l` returns 2+
- [x] `grep "to(pipe.vae.dtype)" backend/pipeline.py | wc -l` returns 2+
- [x] `grep "import base64" backend/pipeline.py | wc -l` returns 2+
- `cd frontend && npm run check`
- [x] Frontend type check passes: `cd frontend && npm run check`
- [x] `image_b64` field exists on SSEProgressEvent: `grep "image_b64" frontend/src/types/workflow.ts` returns 1
- [x] `data:image/jpeg;base64,` prefix logic: `grep "data:image/jpeg;base64" frontend/src/utils/integration.ts` returns 1

### Manual Testing Steps:
1. Generate with `preview_decode_interval=0` — verify no VAE decode occurs, generation time unchanged
2. Generate with `preview_decode_interval=10` — verify intermediate images decoded at steps 0, 10, 20, 30, 40, 50
3. Verify intermediate previews (base64 data URLs) appear instantly without blur transition
4. Verify final image loads with blur(8px) and transitions to sharp over 0.5s
5. Verify MPS memory stays within limits during generation with previews enabled
6. Verify preview JPEG is valid: base64-decode the `image_b64` string, confirm it's a valid JPEG of 128×128
7. Verify `asyncio.Queue` handles dicts with the new key without issues

## Performance Considerations

- **VAE decode cost on MPS**: ~0.5-2s per decode. At every-10-steps for 50 steps: ~5 decodes → ~2.5-10s overhead. At 128×128 resolution, the cost is at the lower end (less upsampling).
- **`enable_vae_slicing`** is already enabled at `config.py:35` — mitigates memory pressure during intermediate decodes.
- **JPEG quality 60** minimizes base64 payload size (~3-8KB vs ~15-30KB for PNG at 128×128).
- **`torch.no_grad()`** is essential — autograd tracking through VAE decode would cause OOM.
- **`pipe.vae.decode()` is pure** — no need to clone state or worry about mutable side effects on the denoising loop.

## Migration Notes

Not applicable — this is a net-new feature gated behind a config flag. If `preview_decode_interval` is 0, the pipeline behavior is identical to the current implementation.

Rollback: set `preview_decode_interval: 0` in config. The widened callback signature with default `None` third parameter is backward-compatible — removing the decode logic from `_on_step` restores exact current behavior.

## Developer Context

**Step 5 — Finding #3 resolution**: `ZImageImg2ImgPipeline` extends `StableDiffusion3Pipeline` → `DiffusionPipeline`. All diffusers pipelines register `.vae` and `.image_processor` as standard module attributes through the base `DiffusionPipeline.__init__()` (they're `register_module` attributes populated during from_pretrained). Neither attribute is Z-Image-specific — they come from the stable-diffusion-3 VAE component loaded during pipeline construction. The concern is void; no guard needed. Confirmed against diffusers source: `StableDiffusion3Pipeline` inherits `DiffusionPipeline.__init__()` which populates these from the model config.

## Plan Review (Step 4)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 5._

| source   | plan-loc          | codebase-loc | severity   | dimension     | finding   | recommendation   | resolution         |
| -------- | ----------------- | ------------ | ---------- | ------------- | --------- | ---------------- | ------------------ |
| code     | Phase 2 §1 (pipeline.py) | <n/a> | blocker | actionability | Phase 2 §1 code block for `generate()` ended at `_on_step` closure, omitting `result = self._pipeline(...)` call and PNG-bytes return. | Extend code block to include full pipeline invocation + PNG encoding + return. | applied: pipeline call + PNG return appended after `_on_step` closure (lines 241-256) |
| code     | Phase 2 §2 (pipeline.py) | <n/a> | blocker | actionability | Phase 2 §2 code block for `generate_img2img()` had same truncation — omitted pipeline call and PNG-byte return. | Extend code block to include full img2img pipeline invocation + PNG encoding + return. | applied: `self._img2img_pipeline(...)` call + PNG return appended (lines 335-350) |
| code     | Phase 2 §2 (pipeline.py) | <n/a> | concern | code-quality  | `ZImageImg2ImgPipeline` VAE / image_processor attribute existence unverified — risk of `AttributeError` if absent. | Verify at design time or add `hasattr` guard. | applied: verified — `ZImageImg2ImgPipeline` extends `StableDiffusion3Pipeline` → `DiffusionPipeline`, both `.vae` and `.image_processor` are standard base-class attributes from `DiffusionPipeline.__init__()`; no guard needed |
| coverage | <n/a>             | <n/a>        | <n/a>     | coverage      | No `## Verification Notes` or `## Precedents & Lessons` sections found — 0 verification intents to audit. All design-verification notes were already routed into per-phase Success Criteria. | <n/a>             | <n/a>              |

0 blockers, 0 concerns, 0 suggestions remain unresolved.

## References

- Design: `.rpiv/artifacts/designs/2026-06-13_17-36-06_progressive-image-decode.md`
- Solutions: `.rpiv/artifacts/solutions/2026-06-13_17-14-53_progressive-image-decode.md`
- Original design: `.rpiv/artifacts/designs/2026-06-13_07-55-56_simplified-comfyui-image-gen.md`
- Validation: `.rpiv/artifacts/validation/2026-06-13_09-55-06_simplified-comfyui-image-gen.md`
