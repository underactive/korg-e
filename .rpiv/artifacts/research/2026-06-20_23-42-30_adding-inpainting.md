---
date: 2026-06-20T23:42:30-0700
author: Eric Sison
commit: 5c40530
branch: main
repository: korg-e
topic: "Adding Inpainting to korg-e"
tags: [research, inpainting, z-image, diffusers, image-generation, brush-mask]
status: ready
last_updated: 2026-06-20T23:42:30-0700
last_updated_by: Eric Sison
---

# Research: Adding Inpainting to korg-e

## Research Question
What would it take to add Inpainting support to the korg-e webapp — allowing a user to upload a photo (e.g. of their car), paint a mask over the area to regenerate (e.g. where a woman should stand), and have only the masked area generated while the unmasked region remains pixel-identical?

## Summary
Adding inpainting requires extending the existing `zImageGenerate` node with an in-node brush canvas for mask painting and a new `is_inpaint` backend branch that loads a separate `ZImageInpaintPipeline` (confirmed available in diffusers 0.39.0.dev0). The approach reuses the existing img2img architecture (`load_img2img()` / `generate_img2img()` pattern at `backend/pipeline.py:81` / `line 164`) for the new `load_inpaint()` / `generate_inpaint()` methods, and the existing `_run_img2img` batch-loop template at `backend/routes/generate.py:149` for the new `_run_inpaint` runner. The mask is painted via a new Zustand store (`usePaintStore`) and a `<canvas>` overlay, stored as a base64 PNG in a new `maskData` field on `KorgNodeData`. The SSE event types need no new fields — the existing `progress`/`done`/`error` events handle inpainting identically to batch img2img. No new node types are needed; inpainting is auto-detected when an `ImageUploadNode` is connected to the `image` handle AND the `zImageGenerate` node has `maskData` populated. The validation layer (`backend/utils/validation.py:10`) gains new inpainting-specific checks. Storage (`backend/utils/storage.py`) gets a new `save_inpaint_images()` following the `save_composite_images()` template for multi-artifact saves.

## Detailed Findings

### Backend Pipeline — Loading and Generation

**`ZImageInpaintPipeline` is available** in the installed diffusers 0.39.0.dev0. It can be imported at `from diffusers import ZImageInpaintPipeline` and follows the same `from_pretrained()` pattern as `ZImageImg2ImgPipeline`.

A new `load_inpaint()` method at `backend/pipeline.py` (following the `load_img2img()` template at line 81) would:
1. Check cache via `hasattr(self, "_inpaint_pipeline")` — line 83
2. Import `ZImageInpaintPipeline` and call `from_pretrained(settings.model_id, ...)` — lines 85-92
3. Apply the same MPS optimizations (`enable_attention_slicing()`, `enable_vae_slicing()`) — lines 96-103
4. Store on `self._inpaint_pipeline` — line 105

A new `generate_inpaint()` method (following the `generate_img2img()` template at line 164) differs in two ways:
- Accepts **two** byte arrays: `init_image_bytes: bytes` and `mask_image_bytes: bytes`
- Opens `mask_image` as grayscale via `PILImage.open(...).convert("L")` — the diffuses inpainting pipeline expects a single-channel mask where white (255) = inpaint region, black (0) = preserve region
- Calls `self._inpaint_pipeline(image=init_image, mask_image=mask_image, ...)` — the pipeline handles per-step latent blending internally at `pipeline_z_image_inpaint.py:497-503`

The **VAE decode closure** at `backend/pipeline.py:135-175` is reused **identically** — it references only `pipe.vae`, `pipe.vae.config.scaling_factor`, `pipe.vae.config.shift_factor`, and `pipe.image_processor`, all of which exist on `ZImageInpaintPipeline` (inherited from `DiffusionPipeline`).

The `mask_blur` parameter (Gaussian blur applied to the mask edge before inpainting) would need PIL preprocessing — the diffuses `VaeImageProcessor` binarizes but does not blur. Applied before passing to the pipeline: `mask_image = mask_image.filter(PILImageFilter.GaussianBlur(radius=mask_blur))`.

### Backend Route — Runner and Detection

A new `_run_inpaint` function at `backend/routes/generate.py` follows the `_run_img2img` template at line 149. Key differences:
- **Pipeline load**: calls `pipeline.load_inpaint()` instead of `pipeline.load_img2img()` — line 171
- **Base64 decode**: decodes **two** images instead of one — lines 159-167 pattern duplicated for mask
- **Batch loop**: structurally identical — same `cancel_event.is_set()` check at line 187, same `step_cb` closure at line 195
- **Pipeline call**: calls `pipeline.generate_inpaint(init_image_bytes=init_bytes, mask_image_bytes=mask_bytes, ...)` instead of `pipeline.generate_img2img(...)` — line 198

The `GenerateRequest` model at line 28 gains `is_inpaint: bool = False`. Detection in the router (line 122+) gets a new branch between composite and img2img: `elif params.get("mode") == "inpaint"` or `elif body.is_inpaint`.

**Cancellation enhancement**: The existing cancellation pattern (asyncio.Event set on client disconnect at line 411, checked at batch-loop boundary line 187) works but does NOT abort mid-pipeline. For inpainting, a new `GenerationCancelledError` exception can be raised inside `_on_step` to truly stop inference — the `ZImageInpaintPipeline.__call__` continues processing steps even after the SSE generator stops, so a true abort avoids unnecessary GPU work.

### Frontend — In-Node Brush Mask Canvas

The mask capture uses a **brush canvas rendered inside the ZImageGenerateNode** (not a separate node). The lifecycle:

1. **Paint mode toggle**: A "Paint Mask" button inside `ZImageGenerateNode.tsx` (analogous to the "Draw Region" button at `RegionNode.tsx:38-44`) sets `usePaintStore.paintMode = true`

2. **Canvas element**: A `<canvas>` element replaces or overlays the init image preview inside the node. The canvas dimensions match the init image's natural pixel dimensions (stored in new `imageWidth`/`imageHeight` fields on `KorgNodeData`, populated when the ImageUpload image loads).

3. **Brush interaction**: `onMouseDown` starts a brush stroke at `(pixelX, pixelY)` converted from screen coords via `getBoundingClientRect()` + displayed-to-natural size ratio. `onMouseMove` draws antialiased circles via `ctx.arc()` + `ctx.fill()` into an offscreen canvas buffer. `onMouseUp` serializes the offscreen canvas to a base64 PNG via `toBlob()` + `FileReader.readAsDataURL()` and stores it as `maskData` on the node.

4. **Mask overlay display**: The mask is composited on top of the init image with a semi-transparent red tint, via CSS `mix-blend-mode` or Canvas 2D `globalCompositeOperation`.

**Coordinate mapping differs from region rectangles**: Region drawing uses `screenToFlowPosition()` (flow-space coordinates). Brush masking uses `getBoundingClientRect()` of the image element + ratio of natural size to displayed size (image-pixel coordinates). Both start from `event.clientX`/`event.clientY`, but the transformation is fundamentally different.

### Frontend — New State Store

A new `usePaintStore` (separate from `useUIStore` at `frontend/src/store/useUIStore.ts`) manages brush state:

```typescript
paintMode: boolean;            // draw mode vs paint mode (mutually exclusive)
paintNodeId: string | null;    // which node is being painted on
brushRadius: number;           // default 20 (image pixels)
paintModeType: 'paint' | 'erase';  // add to mask or remove from mask
maskVisible: boolean;          // toggle mask overlay visibility
isStrokeActive: boolean;       // transient — true between mousedown and mouseup
offscreenCanvas: HTMLCanvasElement | null;  // full-resolution mask buffer
```

A separate store keeps brush state isolated from both the persisted workflow store (`useWorkflowStore`) and the transient draw-mode store (`useUIStore`), following the existing pattern documented at `useUIStore.ts:7-8`.

### Data Transport — Request Body and SSE

The request body at `frontend/src/utils/integration.ts:92-110` gains:
```typescript
is_inpaint: currentNodes.some((n) => n.type === "zImageGenerate" && n.data.maskData),
```

The mask data (`maskData`, base64 PNG) rides in the existing `nodes` array as part of the `zImageGenerate` node's data — no new node type needed. The backend's `extract_parameters()` at `validation.py:57` detects inpainting by checking if the generate node has `maskData` populated in addition to `init_image`:

```python
# In extract_parameters() — after existing img2img detection at line 88
gen_data = generate_node.get("data", {})
mask_data = gen_data.get("maskData")
if mask_data and "init_image" in params:
    params["mode"] = "inpaint"
    params["mask_image"] = mask_data
    params["mask_blur"] = gen_data.get("maskBlur", 16)
```

**SSE events need no new fields** — existing `SSEProgressEvent` at `workflow.ts:64` and `SSEDoneEvent` at `workflow.ts:79` handle inpainting identically. The `image_b64` field in progress events shows intermediate VAE decodes. The `done` event's `image_url` points to the inpainted result.

### Validation — New Rules

The `validate_workflow()` function at `validation.py:10` gains a new block (after composite validation at line 52, before edge checks at line 54):

- Exactly one `ImageUploadNode` connected to the `image` handle (enforced by required handle check at line 63)
- If `maskData` is present, validate the generate node has `init_image` from a connected `ImageUploadNode`
- `maskBlur` must be in range (0-64)

Mask-dimension matching is best done at runtime inside `_run_inpaint` rather than in validation, because the base64 data must be decoded to check dimensions.

### Storage — Multi-Artifact Save

A new `save_inpaint_images()` at `backend/utils/storage.py` follows the `save_composite_images()` template at line 91:

```
{timestamp}_{seed}.png           — inpainted result
{timestamp}_{seed}_init.png      — init image (provenance)
{timestamp}_{seed}_mask.png      — mask image (provenance)
{timestamp}_{seed}.json          — enriched metadata with mask_filename,
                                   init_image_filename, mask_blur, inpaint_strength
```

Returns `{image_url, init_image_url, mask_url, seed}`. The SSE `done` event uses `image_url` (the inpainted result) as the primary output — `ImageOutputNode` receives this URL. Secondary URLs are stored on the generate node's data for reference.

### Node Registration — Extending zImageGenerate

Since inpainting extends `zImageGenerate` rather than introducing a new node type, the 5-point registration chain is simpler — only the existing `zImageGenerate` entry at each location gains new fields:

| Registration point | File:line | Change |
|---|---|---|
| Type union | `workflow.ts:52` | No change (no new type) |
| Store defaults | `useWorkflowStore.ts:70-79` | Add `maskBlur: 16` to `zImageGenerate` defaults |
| Canvas map | `Canvas.tsx:25` | No change (same component) |
| Toolbar | `Toolbar.tsx:8` | No change (same entry) |
| JSON export | `jsonExport.ts:8` | Add `maskBlur: 16` to `zImageGenerate` defaults |

New fields on `KorgNodeData` (`workflow.ts:28`):
```typescript
maskData?: string | null;       // base64 PNG of brush mask
maskBlur?: number;               // Gaussian blur radius for mask edge (default 16)
imageWidth?: number;             // natural width of uploaded init image
imageHeight?: number;            // natural height of uploaded init image
```

## Code References
- `backend/pipeline.py:81` — `load_img2img()` template for `load_inpaint()`
- `backend/pipeline.py:164` — `generate_img2img()` template for `generate_inpaint()`
- `backend/pipeline.py:135-175` — VAE decode closure (reused identically for inpainting)
- `backend/routes/generate.py:28-36` — `GenerateRequest` model: add `is_inpaint: bool = False`
- `backend/routes/generate.py:149` — `_run_img2img` template for `_run_inpaint`
- `backend/routes/generate.py:38` — `cancel_event = asyncio.Event()` cancellation pattern
- `backend/utils/validation.py:57` — `extract_parameters()`: add inpainting branch
- `backend/utils/validation.py:10` — `validate_workflow()`: add inpainting validation block
- `backend/utils/storage.py:30` — `save_image()` template
- `backend/utils/storage.py:91` — `save_composite_images()` template for `save_inpaint_images()`
- `frontend/src/types/workflow.ts:28` — `KorgNodeData`: add `maskData`, `maskBlur`, `imageWidth`, `imageHeight`
- `frontend/src/types/workflow.ts:64` — `SSEProgressEvent`: no changes needed
- `frontend/src/types/workflow.ts:79` — `SSEDoneEvent`: no changes needed
- `frontend/src/components/nodes/ZImageGenerateNode.tsx:33` — Add paint mode toggle + brush canvas
- `frontend/src/components/nodes/RegionNode.tsx:38-44` — Precedent: draw-mode toggle pattern
- `frontend/src/components/Canvas.tsx:25` — `nodeTypes`: no change needed
- `frontend/src/store/useUIStore.ts:15-35` — Precedent for separate transient store
- `frontend/src/store/usePaintStore.ts` — New file: brush state store
- `frontend/src/utils/integration.ts:92-110` — Request body: add `is_inpaint` flag
- `frontend/src/utils/integration.ts:42` — SSE abort pattern: extend with `GenerationCancelledError` support
- `frontend/src/store/useWorkflowStore.ts:70-79` — `zImageGenerate` defaults: add `maskBlur: 16`
- `frontend/src/utils/jsonExport.ts:8` — `NODE_DATA_DEFAULTS`: add `maskBlur: 16` to `zImageGenerate`
- `backend/config.py:40` — `preview_decode_interval`: reused unchanged
- `pipeline_z_image_inpaint.py:497-503` — (diffuses source) Latent blending: `latents = (1 - mask) * init_latents_proper + mask * latents`

## Integration Points

### Inbound References
- `backend/routes/generate.py:122` — Router branches on `body.is_inpaint` (or `params["mode"] == "inpaint"`) to dispatch `_run_inpaint`
- `backend/utils/validation.py:57` — `extract_parameters()` detects inpainting by checking `maskData` presence
- `frontend/src/utils/integration.ts:92` — Serializes `is_inpaint: true` into request body
- `frontend/src/components/nodes/ZImageGenerateNode.tsx` — Paint mode button dispatches `usePaintStore.setPaintMode()`
- `frontend/src/store/useWorkflowStore.ts:70-79` — Store defaults for new `maskBlur` field

### Outbound Dependencies
- `diffusers.pipelines.z_image.pipeline_z_image_inpaint.ZImageInpaintPipeline` — The diffuses pipeline class (exists in 0.39.0.dev0)
- `PIL.ImageFilter.GaussianBlur` — For `mask_blur` preprocessing
- `Zustand` — New `usePaintStore` for brush state
- `HTMLCanvasElement` / Canvas 2D API — Brush stroke capture and mask overlay rendering

### Infrastructure Wiring
- `backend/pipeline.py` — New `load_inpaint()` / `generate_inpaint()` methods on `PipelineWrapper`
- `backend/routes/generate.py` — New `_run_inpaint` runner + `is_inpaint` branch in router
- `backend/utils/validation.py` — Inpainting extraction in `extract_parameters()`, validation in `validate_workflow()`
- `backend/utils/storage.py` — New `save_inpaint_images()` function
- `frontend/src/store/usePaintStore.ts` — New Zustand store for brush interaction state
- `frontend/src/utils/integration.ts` — Extended request body serialization with `is_inpaint`
- `frontend/src/components/nodes/ZImageGenerateNode.tsx` — Paint mode toggle, brush canvas, mask overlay

## Architecture Insights

1. **Inpainting auto-detects from data, not node type** — Following the existing img2img pattern, inpainting is detected by the presence of `maskData` on the `zImageGenerate` node (alongside an `init_image` from a connected `ImageUpload`). No new node types needed. This extends the existing auto-detection schema at `validation.py:77-88`.

2. **In-node brush canvas, not separate node** — The mask is painted directly on top of the init image preview rendered inside `ZImageGenerateNode`, not via a separate `MaskUploadNode`. This follows from the user goal: "I want to paint on my photo to mark what to regenerate." The mask canvas overlays the image within the same node panel.

3. **Pixel-space vs flow-space coordinates** — Brush masking operates in image pixel coordinates (via `getBoundingClientRect()` + natural-to-displayed size ratio), fundamentally different from region drawing which uses flow-space coordinates (via `screenToFlowPosition()`). Both start from `event.clientX`/`event.clientY` but the transform is different.

4. **Separate paint store** — A new `usePaintStore` (not extending `useUIStore`) follows the existing architectural principle at `useUIStore.ts:7-8`: transient UI state stays out of the persisted workflow store. Paint state has different lifecycle and reset semantics from draw mode.

5. **Cancellation improves** — Inpainting introduces `GenerationCancelledError` for true mid-pipeline abort (raised inside `_on_step`). The existing pattern (batch-loop boundary check) only suppresses SSE events, not the model itself. This is an enhancement to the existing `cancel_event` at `generate.py:38`.

6. **SSE schema unchanged** — The existing `SSEProgressEvent` / `SSEDoneEvent` types at `workflow.ts:64-91` need no new fields. Batch fields (`batchIndex`, `batchTotal`) are reused if inpainting runs in batch mode. The `image_b64` intermediate preview works identically.

7. **`extract_parameters()` branching is highest risk** — Confirmed by both the composable region precedent and the batch generation precedent. The inpainting branch at `validation.py:57` adds a third detection path (after standard and composite). Any bug here breaks every workflow mode because the wrong runner could be dispatched.

8. **Memory management between sequential passes** — If inpainting runs multiple regions or batch images, `empty_cache()` at `pipeline.py:458-477` must be called between passes. The batch generation precedent (commits `7e8ef28`, `5c40530`) proved MPS caching allocator causes "progressive slowdown and numerical degradation" without it.

## Precedents & Lessons
2 similar past changes analyzed.

### Precedent: Batch Generation Support (multi-image generation)
**Commit(s)**: `7e8ef28` — "Add batch generation support" (2026-06-19); `5c40530` — "Implement batch generation support" (2026-06-20)
**Blast radius**: 7 files across 4 layers
- `backend/pipeline.py` — added `empty_cache()`, seed advancement per image
- `backend/routes/generate.py` — extended both txt2img + img2img runners with batch loop
- `frontend/src/types/workflow.ts` — added `batchCount`, `batchIndex`, `batchTotal`, `batchImages`
- `frontend/src/store/useWorkflowStore.ts` — `batchCount: 1` default
- `frontend/src/utils/integration.ts` — batch SSE handler with `batchComplete` flag

**Follow-up fixes**: None yet — project is 6 days old.

**Takeaway**: Memory management between sequential generations is mandatory on MPS — `empty_cache()` must be called after each pass.

### Precedent: Composable Area/Region Node (planned, uncommitted)
**Blast radius**: Design touches 8+ files across all layers (pipeline, routes, validation, storage, workflow types, Canvas, store, integration)

**Lessons from docs**:
- `.rpiv/artifacts/plans/2026-06-13_23-25-22_composable-area-region-node.md` — Plan review found a pre-existing TS syntax error (stray `"` in `CompositionNode.tsx`). New features can expose latent bugs in existing code paths.
- `.rpiv/artifacts/designs/2026-06-14_05-08-50_composable-area-region-node.md` — "Store + jsonExport dual defaults" must stay in sync; mismatch causes silent data loss on re-import.

**Takeaway**: `extract_parameters()` branching is the highest-risk change — any bug there breaks all workflow modes.

### Composite Lessons
- **Memory management between sequential passes is mandatory** — The batch generation precedent proves MPS caching allocator accumulates memory across sequential generations. Inpainting must call `empty_cache()` between passes (`pipeline.py:458-477`).
- **`extract_parameters()` branching is highest-risk** — The composable region design flags that any parameter-extraction bug breaks every workflow mode. Inpainting will need a third detection mode (txt2img / img2img / inpaint).
- **Data model stakes**: `KorgNodeData` fields are optional — missing defaults on read create `undefined` values. Inpainting's `maskData` and `maskBlur` must have identical defaults in both `useWorkflowStore.ts:createNode()` and `jsonExport.ts:NODE_DATA_DEFAULTS`.
- **Latent bugs in existing code can surface** — The composable region plan review found a pre-existing TS syntax error. Smoke-testing existing workflows after inpainting changes is essential.
- **SSE schema stability** — Batch generation added `batchIndex`/`batchTotal`/`batchComplete` to SSE events. Inpainting needs no new event fields, confirming that the existing schema at `workflow.ts:64-91` is forward-compatible.

## Historical Context (from `.rpiv/artifacts/`)
- `.rpiv/artifacts/designs/2026-06-13_07-55-56_simplified-comfyui-image-gen.md` — Original v1 design: explicitly deferred inpainting from v1 scope at line 75
- `.rpiv/artifacts/research/simplified-comfyui-image-gen.md` — Prior architectural research confirming Z-Image pipeline's single-pass model
- `.rpiv/artifacts/plans/2026-06-13_08-57-55_simplified-comfyui-image-gen.md` — V1 implementation plan
- `.rpiv/artifacts/designs/2026-06-14_05-08-50_composable-area-region-node.md` — Composable region design: confirms `extract_parameters()` branching as highest-risk change
- `.rpiv/artifacts/research/2026-06-14_04-58-10_composable-area-region-node.md` — Region node research: confirms PipelineWrapper pattern for new pipeline variants
- `.rpiv/artifacts/plans/2026-06-13_23-25-22_composable-area-region-node.md` — Region implementation plan: found pre-existing TS bug
- `.rpiv/artifacts/plans/2026-06-13_18-50-35_progressive-image-decode.md` — Intermediate VAE decode plan: the decode closure reused for inpainting previews

## Developer Context
**Q (checkpoint — UX approach): Should inpainting be a dedicated zInpaint node or extended zImageGenerate with auto-detection?**
A: Extended zImageGenerate with auto-detection. Adds an optional `mask` handle to the existing node; inpainting is detected when `init_image` is connected AND `maskData` is present. Less new code, matches existing img2img auto-detection pattern at `validation.py:77-88`.

**Q (checkpoint — mask capture): In-node brush canvas or connected MaskUpload node?**
A: In-node brush canvas inside ZImageGenerateNode. A "Paint Mask" toggle switches the image preview area to a brush canvas. The mask is stored as `maskData` on the node. No new node type. Follows the draw-mode toggle precedent at `RegionNode.tsx:38-44`.

## Related Research
- `.rpiv/artifacts/research/simplified-comfyui-image-gen.md` — Original architectural research for korg-e's node-graph system
- `.rpiv/artifacts/research/2026-06-14_04-58-10_composable-area-region-node.md` — Composable region node research (closest analogue for multi-pass generation)

## Open Questions
- **Mask dimension matching at runtime**: When the init image and mask image dimensions don't match (e.g., user uploads a different-resolution image after painting the mask), should `_run_inpaint` error immediately or attempt to resize the mask? The diffuses pipeline requires matching dimensions. Best approach: error with a clear message.
- **Paint store placement**: Should the offscreen mask canvas be stored in Zustand (serialized as `null` for persistence) or managed via React refs? Zustand makes it accessible to both Canvas.tsx and ZImageGenerateNode.tsx. React refs avoid serialization overhead.
- **Mask overlay during pan/zoom**: When the user zooms/pans the canvas after painting a mask, the mask overlay must track the image node's screen position. Does the Canvas-level `<canvas>` overlay need a `ResizeObserver` on the image element, or should the mask render inside the node component itself (inside React Flow's coordinate system)?
- **Batch inpainting**: Should batch inpainting use a single mask for all images (current goal) or per-image masks (future)? The `batch_count` parameter already exists — at minimum, the first batch image uses the mask; subsequent images would need the same mask reapplied or a new mask per image.
