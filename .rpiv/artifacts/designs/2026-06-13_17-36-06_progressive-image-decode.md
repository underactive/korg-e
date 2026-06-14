---
date: 2026-06-13T17:36:06-0700
author: Eric Sison
commit: no-commit
branch: main
repository: korg-e
topic: "Progressive image decode — VAE decode at intervals during generation"
tags: [design, pipeline, sse, frontend, vae-decode]
status: ready
parent: .rpiv/artifacts/solutions/2026-06-13_17-14-53_progressive-image-decode.md
last_updated: 2026-06-13T17:36:06-0700
last_updated_by: Eric Sison
---

# Design: Progressive Image Decode ("Fuzzy → Sharp" Previews)

## Summary

Decode intermediate denoising latents through the full VAE every 10 steps at 128×128 resolution, encode as JPEG base64, and stream through existing SSE progress events to the ImageOutputNode for progressive display. Zero new dependencies — uses only the VAE, PIL, and base64 already in the codebase. The approach widens the existing `step_callback` signature to carry an optional `image_b64` string, leaving the entire SSE transport and frontend data pipeline schema-less and naturally extensible.

## Requirements

- Show progressive image previews during generation (not just a step-count bar)
- The previews must visibly sharpen as denoising advances (the "fuzzy → sharp" experience)
- Must work with Z-Image's FLUX-style VAE (scaling_factor=0.3611, shift_factor=0.1159, 16 latent channels) on MPS
- Must flow through the existing SSE transport without architectural changes
- Must be additive — the pipeline must work without previews if `preview_decode_interval` is 0
- Default decode interval: every 10 steps; default preview size: 128×128; JPEG quality 60

## Current State Analysis

### Key Discoveries

- **`callback_on_step_end_tensor_inputs=["latents"]`** at `backend/pipeline.py:161` already requests latents at every step — they arrive in `callback_kwargs["latents"]` but are discarded (only `(step, total)` integers forwarded)
- **VAE decode requires both scaling AND shift**: `(latents / 0.3611) + 0.1159` — the solutions doc's Z-Image issue #55 reference code was missing `shift_factor`, which produces "very uniform" noise. Confirmed by ZImagePipeline source and Z-Image VAE config on HuggingFace
- **`pipe.vae.decode()` and `pipe.image_processor.postprocess()` are pure functions** — no shared mutable state with the denoising loop, safe to call mid-inference
- **SSE transport is schema-less**: `asyncio.Queue` holds plain `dict`, `_sse_generator` does `json.dumps(data)` on all keys except `"event"`, frontend `JSON.parse` preserves all keys. Adding `image_b64` to any progress event dict flows through with zero parser changes
- **ImageOutputNode already renders `data.imageUrl`** as `<img src={imageUrl}>` at `ImageOutputNode.tsx:15-25` — accepts any valid `src` (base64 data URL or server path)
- **`updateNodeData` does shallow spread merge** at `useWorkflowStore.ts:164-169` — `{ ...n.data, ...data }`. Adding any key to the partial is safe; absent keys in previous updates are preserved

### Patterns to Follow

- **SSE event payload extension**: `backend/routes/generate.py:160-169` — `step_cb` constructs dict, `asyncio.run_coroutine_threadsafe(queue.put(dict), loop)`. Add key, no parser changes.
- **PIL → BytesIO → bytes**: `backend/pipeline.py:165-170` — `buf = io.BytesIO(); image.save(buf, format="PNG"); return buf.getvalue()`
- **CSS transitions inline**: `ZImageGenerateNode.tsx:175` — `transition: "width 0.3s ease"` on inline style object
- **Frontend refs for stale-closure avoidance**: `integration.ts:29-34` — `nodesRef`, `edgesRef`, `updateNodeDataRef` pattern

### Constraints to Work Within

- Z-Image VAE has `force_upcast: true` — internally upcasts to float32; latents must be cast to `pipe.vae.dtype` before decode
- Denoising loop keeps latents in `float32`; VAE is in `bfloat16` on MPS
- `_on_step` must return `callback_kwargs` unmodified for the denoising loop to continue
- MPS memory: VAE decode adds ~220MB peak; `enable_vae_slicing` already enabled
- 0-based step indexing from diffusers; SSE emits 1-indexed (`current + 1`)

## Scope

### Building

- VAE intermediate decode every N steps (configurable, default 10) at configurable preview size (default 128×128)
- Base64 JPEG encoding and SSE streaming of previews during `status: "generating"` progress events
- Progressive image display in ImageOutputNode (intermediate previews update `imageUrl` to data URLs, final result overwrites with server path)
- CSS blur→sharp transition on the final image for polish

### Not Building

- TAESD integration (upgrade path if VAE decode proves too slow)
- Latent→RGB projection (no Z-Image calibration matrix exists)
- Client-only blur illusion without real intermediate previews
- User-configurable preview controls in the UI (config file defaults only for now)
- Multi-resolution preview ladder
- GIF/video export of generation progression

## Decisions

### VAE Decode Formula: `(latents / scaling_factor) + shift_factor`

**Ambiguity**: The solutions doc referenced Z-Image issue #55 code which used `latents / pipe.vae.config.scaling_factor` without `shift_factor`. Research confirmed this is incomplete — the Z-Image VAE (identical to Flux VAE) requires both operations.

**Explored**:
- Option A: `latents / scaling_factor` only — used in issue #55, produces "very uniform" noise (reporter's own observation). Missing `shift_factor` means the decoded image is in the wrong color space.
- Option B: `(latents / scaling_factor) + shift_factor` — matches the ZImagePipeline's own final decode at `pipeline_z_image.py:587-592` AND the FluxPipeline decode. This is the correct formula.

**Decision**: Option B. Z-Image VAE config confirms `scaling_factor=0.3611`, `shift_factor=0.1159` (from `vae/config.json` on HuggingFace). The official pipeline uses both. Evidence: `pipeline_z_image.py:587-592`, Z-Image-Turbo `vae/config.json`.

### Callback Signature: Widen to `Callable[[int, int, str | None], None]`

**Ambiguity**: How to carry image data through the existing callback chain.

**Explored**:
- Option A: Separate preview callback parameter — adds a second callback to `generate()`/`generate_img2img()`, keeping step_callback unchanged. More complex API surface, two parallel callback channels.
- Option B: Widen step_callback to accept optional third parameter — single callback with backward-compatible optional arg. Simpler, follows existing pattern.

**Decision**: Option B. Only 2 call sites exist (both in `routes/generate.py`), and adding `str | None = None` as a third defaulted parameter is backward-compatible — existing code that only passes 2 args works unchanged. Follows Python convention for optional callback data.

### Defaults: Decode Every 10 Steps at 128×128

**Decision**: Developer confirmed via checkpoint. 10 steps at 128×128 minimizes MPS VAE decode overhead (~5 decodes for 50 steps) while still showing ~5 intermediate frames. Configurable via `Settings.preview_decode_interval` and `Settings.preview_size`.

### Zero New Files

**Decision**: All changes fit within existing modules. The VAE decode logic goes into the `_on_step` closure in `pipeline.py`. The SSE payload extension goes into `step_cb` in `generate.py`. Frontend changes go into existing `integration.ts` and `ImageOutputNode.tsx`.

## Architecture

### `backend/config.py:26-37` — MODIFY

```python
    # ── generation defaults ────────────────────────────────────────────
    default_steps: int = 50
    default_cfg_scale: float = 5.0
    default_resolution: tuple[int, int] = (1024, 1024)

    # ── preview ─────────────────────────────────────────────────────────
    preview_decode_interval: int = 10   # VAE decode every N steps (0 = disabled)
    preview_size: int = 128             # resize preview to this square dimension
```

### `backend/pipeline.py:120-165` — MODIFY (Slice 1 + Slice 2)

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
```

### `backend/pipeline.py:184-235` — MODIFY (Slice 1 + Slice 2)

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
```

### `backend/routes/generate.py:142-220` — MODIFY

```python
# ── _run_text_to_image step_cb (replaces lines 155-169) ──

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


# ── _run_img2img step_cb (replaces lines 204-214) ──

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

### `frontend/src/types/workflow.ts:53-59` — MODIFY

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

### `frontend/src/utils/integration.ts:88-97` — MODIFY

Replace the `generating` branch in `onProgress` to forward intermediate previews:

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

### `frontend/src/components/nodes/ImageOutputNode.tsx:1-57` — MODIFY

Add `useState` import, `imageLoaded` state, `isIntermediate` check, blur transition:

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

## Slices

### Slice 1: Config + Type Foundation

**Files**: `backend/config.py`, `backend/pipeline.py`

#### Automated Verification:
- [ ] Config attributes exist: `cd backend && python -c "from backend.config import settings; assert settings.preview_decode_interval == 10; assert settings.preview_size == 128"`
- [ ] Callback type annotation correct: `cd backend && python -c "from backend.pipeline import PipelineWrapper; import inspect; sig = inspect.signature(PipelineWrapper.generate); params = list(sig.parameters.values()); assert params[-1].annotation.__args__[2].__args__ == (int, str, type(None))"`

#### Manual Verification:
- [ ] `preview_decode_interval=0` disables previews — existing behavior unchanged when set to 0
- [ ] `preview_size` accepts any positive integer — defaults confirmed


### Slice 2: Pipeline — VAE Decode in `_on_step`

**Files**: `backend/pipeline.py`

#### Automated Verification:
- [ ] Pipeline module imports cleanly: `cd backend && python -c "from backend.pipeline import PipelineWrapper"`
- [ ] shift_factor present: `grep "shift_factor" backend/pipeline.py | wc -l` returns 2+
- [ ] torch.no_grad() present: `grep "torch.no_grad()" backend/pipeline.py | wc -l` returns 2+
- [ ] dtype cast present: `grep "to(pipe.vae.dtype)" backend/pipeline.py | wc -l` returns 2+
- [ ] import base64 present in both methods: `grep "import base64" backend/pipeline.py | wc -l` returns 2+

#### Manual Verification:
- [ ] Generate with `preview_decode_interval=0` — no VAE decode occurs, generation time unchanged
- [ ] Generate with `preview_decode_interval=10` — intermediate images decoded at steps 0, 10, 20, 30, 40, 50
- [ ] Interval arithmetic correct: `(step + 1) % decode_interval == 0` + `step == 0` for initial noise
- [ ] MPS memory stays within limits during generation with previews enabled
- [ ] Preview JPEG is valid: base64-decode the `image_b64` string, verify it's a valid JPEG of 128×128



### Slice 3: SSE Route — Emit `image_b64` in Progress Events

**Files**: `backend/routes/generate.py`

#### Automated Verification:
- [ ] Type checking passes: `cd backend && python -c "from backend.routes.generate import generate"` (no import errors)
- [ ] `step_cb` accepts 3 args: `grep "image_b64: str | None = None" backend/routes/generate.py | wc -l` returns 2
- [ ] `image_b64` key present: `grep 'payload\["image_b64"\]' backend/routes/generate.py | wc -l` returns 2

#### Manual Verification:
- [ ] When `image_b64=None`, SSE progress event contains only `step`/`total`/`status` (no `image_b64` key)
- [ ] When `image_b64` is a base64 string, SSE progress event includes it
- [ ] JSON encoding: `json.dumps(payload)` handles the base64 string without escaping issues
- [ ] `asyncio.Queue` handles dicts with the new key without issues



### Slice 4: Frontend — Forward Preview to ImageOutputNode

**Files**: `frontend/src/types/workflow.ts`, `frontend/src/utils/integration.ts`

#### Automated Verification:
- [ ] TypeScript type checking passes: `cd frontend && npm run check`
- [ ] `image_b64` field exists on SSEProgressEvent: `grep "image_b64" frontend/src/types/workflow.ts`
- [ ] `data:image/jpeg;base64,` prefix logic present: `grep "data:image/jpeg;base64" frontend/src/utils/integration.ts`

#### Manual Verification:
- [ ] During generation, ImageOutputNode shows intermediate 128×128 previews that update at each decode interval
- [ ] The `currentEdges` lookup correctly finds the connected ImageOutputNode
- [ ] When no ImageOutputNode is connected, previews are silently dropped (no crash)
- [ ] The final `onDone` handler still overwrites `imageUrl` with the server path (`/images/...`)
- [ ] Pre-existing generation behavior unchanged when `image_b64` is absent from SSE events



### Slice 5: Frontend — Progressive Image Display + Unblur Transition

**Files**: `frontend/src/components/nodes/ImageOutputNode.tsx`

#### Automated Verification:
- [ ] TypeScript type checking passes: `cd frontend && npm run check`
- [ ] `useState` import added: `grep "useState" frontend/src/components/nodes/ImageOutputNode.tsx`
- [ ] `key={imageUrl}` forces remount on URL change: `grep "key={imageUrl}" frontend/src/components/nodes/ImageOutputNode.tsx`

#### Manual Verification:
- [ ] Intermediate previews (base64 data URLs) appear instantly without blur transition
- [ ] Final image (server path) loads with blur(8px) and transitions to sharp over 0.5s
- [ ] Consecutive generations each show the blur transition (key={imageUrl} causes remount)
- [ ] `nodrag` class still works — mouse events on the blurred/sharp image don't interfere with canvas dragging
- [ ] Seed info text still appears below the image for final results
- [ ] Placeholder "Waiting for output…" shows when no imageUrl is set



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

## File Map

```
backend/config.py            # MODIFY — add preview_decode_interval, preview_size
backend/pipeline.py          # MODIFY — widen step_callback type, add VAE decode in _on_step
backend/routes/generate.py   # MODIFY — widen step_cb, emit image_b64 in SSE payload
frontend/src/types/workflow.ts          # MODIFY — add image_b64 to SSEProgressEvent
frontend/src/utils/integration.ts       # MODIFY — detect image_b64, forward to output node
frontend/src/components/nodes/ImageOutputNode.tsx  # MODIFY — progressive display + unblur
```

## Ordering Constraints

- Slice 1 (config + types) must come first — Slice 2-5 depend on the widened callback signature and config fields
- Slice 2 (pipeline decode) must come before Slice 3 (SSE route) — the callback must produce image_b64 before the route emits it
- Slice 3 (SSE emit) must come before Slice 4 (frontend forwarding) — the SSE events must carry image_b64 before the frontend detects it
- Slice 4 (frontend forwarding) must come before Slice 5 (ImageOutputNode) — the imageUrl must be set before the node renders it
- All slices are sequential — no parallelism

## Verification Notes

- **shift_factor is mandatory** — the solutions doc reference code from Z-Image issue #55 omitted it. Verify decode uses both `scaling_factor` AND `shift_factor`. The official ZImagePipeline source at the final decode step is the authority.
- **Dtype casting**: latents arrive in float32 from denoising loop; must cast to `pipe.vae.dtype` (bfloat16 on MPS) before VAE decode. The official pipeline does `latents = latents.to(self.vae.dtype)`.
- **Step indexing**: diffusers delivers 0-indexed steps. Interval check should use `(step + 1) % decode_interval == 0` for human-intuitive semantics (decode at steps 10, 20, 30, ...). Also decode at step 0 to get the initial noise state.
- **ImageOutputNode stuck-button bug**: The validation report flagged that `ZImageGenerateNode`'s button stays disabled after completion because `isGenerating` is local state that never syncs from `data.status`. This pre-existing bug is unchanged by this design — it's a separate fix.
- **SSE base64 size**: A 128×128 JPEG at quality 60 is ~3-8KB — well within SSE frame limits. No risk of chunk-boundary corruption.
- **Git history unavailable**: No precedent commits — all lessons are from the design and validation artifacts.

## Performance Considerations

- **VAE decode cost on MPS**: ~0.5-2s per decode. At every-10-steps for 50 steps: ~5 decodes → ~2.5-10s overhead. At 128×128 resolution, the cost is at the lower end (less upsampling).
- **`enable_vae_slicing`** is already enabled at `config.py:35` — mitigates memory pressure during intermediate decodes.
- **JPEG quality 60** minimizes base64 payload size (~3-8KB vs ~15-30KB for PNG at 128×128).
- **`torch.no_grad()`** is essential — autograd tracking through VAE decode would cause OOM.
- **`pipe.vae.decode()` is pure** — no need to clone state or worry about mutable side effects on the denoising loop.

## Migration Notes

Not applicable — this is a net-new feature gated behind a config flag. If `preview_decode_interval` is 0, the pipeline behavior is identical to the current implementation.

Rollback: set `preview_decode_interval: 0` in config. The widened callback signature with default `None` third parameter is backward-compatible — removing the decode logic from `_on_step` restores exact current behavior.

## Pattern References

- `backend/pipeline.py:144-166` — existing `_on_step` closure with `callback_on_step_end_tensor_inputs=["latents"]` (model for decode hook point)
- `backend/pipeline.py:120-134` — existing `step_callback` parameter in `generate()` method (model for callback widening)
- `backend/pipeline.py:165-170` — existing PIL → BytesIO → bytes pattern (model for JPEG encoding)
- `backend/routes/generate.py:155-163` — existing `step_cb` → `queue.put()` → SSE pattern (model for payload extension)
- `frontend/src/components/nodes/ZImageGenerateNode.tsx:175` — existing CSS `transition` inline style (model for blur transition)
- `frontend/src/utils/integration.ts:29-34` — existing refs-for-stale-closure pattern (model for edge/output-node lookup)

## Developer Context

**Step 4 — Directional confirm**:
- Q: "Follow step_callback widening?" → Follow. Widen `Callable[[int, int], None]` → `Callable[[int, int, str | None], None]` per existing callback pattern at `pipeline.py:134` and `routes/generate.py:155`.

**Step 4 — Genuine ambiguity**:
- Q: "Decode interval and preview size defaults?" → 10 steps · 128×128 (Recommended). Decode every 10 steps at 128×128 resolution for conservative MPS overhead (~5 frames per 50-step generation).

**Step 5 — Decomposition approved**: 5 slices across 6 files, all sequential.

## Design History

- Slice 1: Config + Type Foundation — approved as generated
- Slice 2: Pipeline — VAE Decode in `_on_step` — approved as generated
- Slice 3: SSE Route — Emit `image_b64` in Progress Events — approved as generated
- Slice 4: Frontend — Forward Preview to ImageOutputNode — approved as generated
- Slice 5: Frontend — Progressive Image Display + Unblur Transition — approved as generated

## References

- `.rpiv/artifacts/solutions/2026-06-13_17-14-53_progressive-image-decode.md` — Upstream solutions analysis (4 candidates, VAE Decode recommended)
- `.rpiv/artifacts/designs/2026-06-13_07-55-56_simplified-comfyui-image-gen.md` — Original architecture decisions (SSE, callback_on_step_end, thread→async bridge)
- `.rpiv/artifacts/validation/2026-06-13_09-55-06_simplified-comfyui-image-gen.md` — Known issues (1-indexed step offset, stuck button bug)
- `backend/pipeline.py:137-149` — `_on_step` closure where latents arrive but are discarded
- `backend/pipeline.py:161` — `callback_on_step_end_tensor_inputs=["latents"]` — the exact hook point
- `backend/routes/generate.py:155-169` — `step_cb` → SSE progress event
- [Z-Image Issue #55](https://github.com/Tongyi-MAI/Z-Image/issues/55) — Working callback decode code (missing shift_factor — corrected in this design)
- [Z-Image-Turbo VAE config.json](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo/blob/main/vae/config.json) — Confirmed scaling_factor=0.3611, shift_factor=0.1159
- [ZImagePipeline source](https://github.com/huggingface/diffusers/blob/main/src/diffusers/pipelines/z_image/pipeline_z_image.py) — Official decode logic at end of `__call__()`
