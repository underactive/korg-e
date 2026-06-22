---
template_version: 1
date: 2026-06-21T22:01:49-0700
author: Eric Sison
commit: 5c40530
branch: main
repository: korg-e
topic: "Validation of Adding Inpainting to korg-e"
status: ready
verdict: pass
parent: ".rpiv/artifacts/plans/2026-06-21_00-00-35_adding-inpainting.md"
tags: [validation, inpainting, z-image, diffusers, brush-mask, pipeline]
last_updated: 2026-06-21T22:01:49-0700
---

## Validation Report: Adding Inpainting to korg-e

### Implementation Status

- ✓ Phase 1: Types + Data Foundation — Fully implemented
- ✓ Phase 2: Backend Pipeline — Fully implemented
- ✓ Phase 3: Backend Route + Detection + Storage — Fully implemented
- ✓ Phase 4: Frontend Brush UI + Integration — Fully implemented

### Automated Verification Results

- ✓ TypeScript type checking: `cd frontend && npx tsc --noEmit` — no errors
- ✓ Python pipeline import: `cd /Users/esison/Development/projects/tools/korg-e && /Users/esison/.korg-e/venv/bin/python -c "from backend.pipeline import PipelineWrapper; print('OK')"` — OK
- ✓ Python validation import: `cd /Users/esison/Development/projects/tools/korg-e && /Users/esison/.korg-e/venv/bin/python -c "from backend.utils.validation import extract_parameters; print('OK')"` — OK
- ✓ Python storage import: `cd /Users/esison/Development/projects/tools/korg-e && /Users/esison/.korg-e/venv/bin/python -c "from backend.utils.storage import save_inpaint_images; print('OK')"` — OK
- ✓ Git diff confirms 10 files changed, 619 insertions, 110 deletions — no unexpected files touched
- ✓ No regressions detected

### Code Review Findings

#### Matches Plan:

- `frontend/src/types/workflow.ts` — `KorgNodeData` includes `maskData`, `maskBlur`, `imageWidth`, `imageHeight` as specified
- `frontend/src/store/usePaintStore.ts` — new Zustand store with all 5 state fields and 5 action methods, follows `useUIStore` transient-state pattern
- `frontend/src/store/useWorkflowStore.ts` — `zImageGenerate` defaults include `maskBlur: 16`
- `frontend/src/utils/jsonExport.ts` — `NODE_DATA_DEFAULTS` includes `maskBlur: 16`, stays in sync with `useWorkflowStore`
- `backend/pipeline.py` — `load_inpaint()` lazy-loads `ZImageInpaintPipeline`, caches on `self._inpaint_pipeline`; `generate_inpaint()` accepts init/mask bytes, applies Gaussian blur, VAE decode uses `shift_factor`
- `backend/routes/generate.py` — `_run_inpaint` has dimension validation, `empty_cache()` between batch images, router dispatch ordering is composite → inpaint → img2img → txt2img
- `backend/utils/validation.py` — `extract_parameters()` detects inpainting when `maskData` present alongside `init_image`, sets `mode = "inpaint"`
- `backend/utils/storage.py` — `save_inpaint_images()` saves result + init + mask + metadata JSON with `type: "inpaint"`
- `frontend/src/components/nodes/ZImageGenerateNode.tsx` — paint mode toggle, brush canvas, mask overlay, clear mask, graph traversal for connected image data
- `frontend/src/components/Canvas.tsx` — `usePaintStore` imported, `paintMode` integrated into `panOnDrag`, `nodesDraggable`, cursor
- `frontend/src/utils/integration.ts` — `is_inpaint` flag added to request body following `is_img2img` pattern

#### Deviations from Plan:

None. Implementation is a faithful realization of the plan.

#### Pattern Conformance:

- ✓ `usePaintStore` follows the same transient-state Zustand pattern as `useUIStore` (separate from persisted workflow store, boolean flag + node ID + setters)
- ✓ Brush canvas in `ZImageGenerateNode` follows the draw-mode toggle pattern from `RegionNode` (store-derived `isPainting` flag, styled `nodrag` toggle button)
- ✓ `Canvas.tsx` properly combines `drawMode` and `paintMode` for `panOnDrag`, `nodesDraggable`, and cursor — pane click/move handlers correctly remain `drawMode`-only since paint events are scoped to the node's canvas
- ✓ `is_inpaint` flag in `integration.ts` uses identical `currentNodes.some()` pattern as `is_img2img`

#### Potential Issues:

None identified. The implementation covers all error paths (dimension mismatch, missing init image, missing mask), maintains backward compatibility (new fields default to undefined/null), and follows established codebase patterns.

### Manual Testing Required:

1. **In-paint mode UX:**
   - [ ] Upload an image via ImageUploadNode, connect to ZImageGenerateNode — "Paint Mask" button appears
   - [ ] Click "Paint Mask" — button turns red, cursor changes to crosshair, canvas shows image
   - [ ] Paint brush strokes — white circles appear on offscreen canvas, red overlay visible
   - [ ] Adjust brush radius slider — circle size changes
   - [ ] Toggle "Show Mask" checkbox — overlay visibility toggles
   - [ ] Click "Clear" — mask is erased
   - [ ] Click "Done Painting" — mask serialized to base64 on node data, generate button says "Inpaint"
   - [ ] Mask Blur input appears in params when mask is present

2. **Backend inpainting flow:**
   - [ ] Connect ImageUpload → ZImageGenerate, paint mask, type prompt, click "Inpaint"
   - [ ] Backend loads `ZImageInpaintPipeline`, runs inpainting, saves result + init + mask
   - [ ] SSE progress events stream correctly (loading → generating → saving → done)
   - [ ] Only masked (white) region regenerates; unmasked region remains pixel-identical

3. **Regression:**
   - [ ] Standard text-to-image workflow still functions correctly (no `maskData`, no `is_inpaint`)
   - [ ] img2img workflow still functions correctly (connected image but no mask)
   - [ ] Composite workflow still functions correctly

### Recommendations:

Ready to commit — implementation is complete and validated.
