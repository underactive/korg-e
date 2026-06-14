---
date: 2026-06-14T04:58:10-0700
author: Eric Sison
commit: no-commit
branch: detached
repository: korg-e
topic: "Composable Area/Region Node for Image Composition"
tags: [research, region-node, image-composition, react-flow, diffusers, pipeline-compositing]
status: ready
last_updated: 2026-06-14T04:58:10-0700
last_updated_by: Eric Sison
---

# Research: Composable Area/Region Node for Image Composition

## Research Question
Add a new node type that lets users define rectangular areas (via click-and-drag select) to place and compose elements in the generated image. For example: place a woman in the center, sun in the upper corner, house in the back layered behind the woman rectangle — each defined as a region with its own prompt and position within the overall image canvas.

## Summary
Adding a composable area/region system to korg-e requires touching every layer of the stack — type definitions, Zustand store, React Flow canvas, SSE event schema, backend validation, and the diffusers pipeline. The feature decomposes into two new node types: a **Region Generate node** (`zRegion`) that owns a rectangular area (geometry + generation params + prompt) and a **Composition node** (`zComposition`) that composites all region outputs onto a final canvas. A new `PipelineWrapper.generate_composite()` method runs N independent diffusion passes (reusing the same loaded model) and layers results using PIL `Image.paste()`. The frontend requires a click-drag-to-draw interaction mode on the React Flow canvas, toggling `panOnDrag` off while drawing. SSE events gain a `regionId` field for per-region progress tracking. All 10 research questions were answered through parallel codebase analysis spanning ~30 files across frontend and backend.

## Detailed Findings

### Frontend — Node Registration Chain (Q1, Q8)
A new node type must be registered at **5 locations** in 4 files to avoid runtime errors or silent data loss:

1. **Type union** (`frontend/src/types/workflow.ts:34-37`) — add `| "zRegion" | "zComposition"` to `KorgNodeType`. Missing this causes TypeScript compilation errors everywhere `KorgNodeType` is referenced.

2. **Store factory** (`frontend/src/store/useWorkflowStore.ts:28-50`) — add `zRegion` and `zComposition` entries to the `defaults` map inside `createNode()`. Missing this creates nodes with empty `data: {}` — no `label`, `inputs`, or `outputs`, causing invisible or broken rendering.

3. **Canvas node type map** (`frontend/src/components/Canvas.tsx:13-23`) — add `zRegion: RegionNode` and `zComposition: CompositionNode` to the `nodeTypes` map. Missing this causes a **hard React Flow runtime error**: "node type not found".

4. **Toolbar dropdown** (`frontend/src/components/Toolbar.tsx:8-15`) — add to the `NODE_TYPES` array so the user can create the node from the UI.

5. **JSON export defaults** (`frontend/src/utils/jsonExport.ts:15-46`) — add matching entries to `NODE_DATA_DEFAULTS`. Missing this means loaded workflows won't get default geometry values for region nodes that were saved with newer fields (`regionWidth`, `regionHeight`, `regionZIndex`).

The store factory and JSON export defaults are **manually duplicated** and must stay in sync. A mismatch causes subtle data loss: if the store factory has geometry defaults but JSON export doesn't, newly created nodes are fine, but saved-and-loaded nodes lose the defaults (the `importWorkflow()` merge `{ ...defaults, ...n.data }` collapses to just `n.data` when `defaults` is `undefined`).

### Frontend — Data Model Geometry (Q3)
The region node needs positional data beyond `Node.position` (which gives x/y of the node panel): specifically `regionWidth`, `regionHeight`, and optionally `regionZIndex`. These should be **new optional fields on `KorgNodeData`** (`frontend/src/types/workflow.ts:12-27`), not React Flow's `Node.width`/`Node.height`/`Node.zIndex`, because:

- React Flow's `width`/`height` are **computed** (from DOM measurement via `ResizeObserver`), not stored — they live in `node.measured`, not in `node` itself for non-resizable node types.
- `applyNodeChanges()` does **not** have a `'zIndex'` change type — it only handles `'select'`, `'position'`, and `'dimensions'`. `zIndex` is read-once during initial render.
- Fields on `KorgNodeData` get full lifecycle support: initial values via store factory defaults, user interaction via `updateNodeData()`, and serialization via `exportWorkflow`/`importWorkflow`.

Add to `KorgNodeData`:
```typescript
// RegionNode
regionX?: number;
regionY?: number;
regionWidth?: number;
regionHeight?: number;
regionZIndex?: number;
```

### Frontend — UI Interaction & Canvas Drawing (Q2, Q9)
Current pattern: each node component reads from `NodeProps<KorgNode>.data` and writes via `useWorkflowStore((s) => s.updateNodeData)` for form controls, or dispatches `CustomEvent("korg:generate", ...)` for the generate action (`frontend/src/components/nodes/ZImageGenerateNode.tsx:33`). The `useWorkflowIntegration` hook at `frontend/src/utils/integration.ts:56` intercepts the CustomEvent to serialize the full graph and start SSE generation.

A region node needs a **fundamentally different interaction**: click-drag on the canvas background to draw a rectangle. This conflicts with React Flow's default pan-on-drag behavior. The recommended approach:

- **Draw mode toggle** on the region node component — a "Draw Region" button sets `data.drawMode = true` on the node.
- **Canvas-level event handlers** on `ReactFlow` — `onMouseDown`, `onMouseMove`, `onMouseUp` when `drawMode` is active.
- **`panOnDrag={!drawMode}`** — disables panning while drawing, the single architectural knob resolving the interaction conflict.
- **Coordinate conversion** — use `useReactFlow().screenToFlowPosition()` to convert screen coordinates to flow coordinates, which are stored in `data.regionX`/`regionY`/`regionWidth`/`regionHeight`.
- **SVG overlay** — render the live-drawn rectangle as an SVG `<rect>` with `pointerEvents: 'none'` and absolute positioning over the canvas. Saved region rectangles from all region nodes are also rendered as overlays.
- **Node component renders the settings panel** (draw toggle + numeric fine-tuning fields for x/y/w/h + z-order), but the **rect overlay is rendered at the canvas level**, not inside the node component.

### Backend — Parameter Extraction (Q4)
The current `extract_parameters()` at `backend/utils/validation.py:57-88` hardcodes a single `zImageGenerate` node and walks edges to find its prompt and optional init image. For region composition, it must return a **list of per-region parameter dicts**.

Current structure (single flat dict):
```python
# backend/utils/validation.py:60-88
generate_node = next(n for n in nodes if n.get("type") == "zImageGenerate")
params["prompt"] = ...   # single prompt
params["steps"] = 50     # single steps
```

New structure for composite:
```python
params["canvas_width"] = 1024    # from composition node
params["canvas_height"] = 1024
params["regions"] = [
    {
        "region_id": "zRegion_1",
        "prompt": "woman in center",
        "x": 200, "y": 100,
        "region_width": 512, "region_height": 512,
        "steps": 50, "cfg_scale": 5.0, "seed": 42,
        "init_image": None,       # optional per-region
    },
    {
        "region_id": "zRegion_2",
        "prompt": "sun in upper corner",
        "x": 800, "y": 50,
        "region_width": 200, "region_height": 200,
        "steps": 30, "cfg_scale": 4.0, "seed": 123,
    },
]
```

The `validate_workflow()` at `backend/utils/validation.py:15-53` must also be extended to accept `zComposition` as a valid root node (currently requires at least one `zImageGenerate`). Additional validation for composite workflows: check each region has geometry defined, canvas dimensions are set, and no region exceeds canvas bounds.

A convention is needed for connecting TextPrompt nodes to each region. The simplest: each region has a `"prompt"` target handle, and any TextPrompt node connected to it feeds that region's prompt. Regions without a connected prompt default to an empty string.

### Backend — Compositing Pipeline (Q6)
The `PipelineWrapper` at `backend/pipeline.py:106-280` currently has `generate()` (txt2img) and `generate_img2img()` — both run one diffusion pass and return one PNG. A new `generate_composite()` method must:

1. Accept a `regions: list[dict]` parameter plus `canvas_width`/`canvas_height`.
2. Run N separate `self._pipeline(...)` calls, reusing the same loaded model.
3. For each region: use its own `prompt`, resolution (`region_width` × `region_height`), `steps`, `cfg_scale`, and optionally its own `seed` via a fresh `torch.Generator`.
4. Decode each region's output to PIL, then paste onto a blank canvas at (`x`, `y`) using `PIL.Image.paste()` with alpha compositing — `canvas.paste(region_image, (x, y), region_image)`.
5. Respect z-order: paste in `regionZIndex` order (or array order as fallback, first = bottom, last = top).
6. Report progress as `(region_index, step, total, image_b64)` so the SSE generator can tag events with `regionId`.

The existing `callback_on_step_end` pattern and VAE decode logic at `backend/pipeline.py:135-175` are directly reusable — just wrapped in a per-region closure that captures `region_index`.

Memory: each diffusion pass runs sequentially reusing the same pipeline instance. With MPS and `bfloat16`, this is memory-efficient — the model stays loaded, and only the current region's latents and decoded image are in memory at any time.

### SSE Integration (Q5, Q7)
The current SSE wiring is a **single request → single generation → single done event** pattern. For regions, two approaches:

**Option A (recommended): One request, interleaved progress** — The composition node dispatches one `korg:generate` event. The backend iterates over regions internally, pushing progress events tagged with `regionId` for each. The final `done` event carries `image_url` (composite) + `region_images: [{regionId, image_url, seed}]`.

**Option B: One request per region** — Each region node has its own generate button. Multiple concurrent SSE streams, each updating its own node. The singleton `sseRef` must become a map `nodeId → {abort: fn}`.

Option A is simpler for the user (one click to generate all regions) and requires fewer changes to the SSE client.

**SSE event schema changes** at `frontend/src/types/workflow.ts:42-60`:

```typescript
export type SSEProgressEvent = {
  event: "progress";
  status: "loading" | "generating" | "saving";
  regionId?: string;     // NEW — which region this progress is for
  step?: number;
  total?: number;
  phase?: string;
  image_b64?: string;
};

export type SSEDoneEvent = {
  event: "done";
  status: "complete";
  image_url: string;     // composite result
  seed: number;
  regionId?: string;     // NEW — per-region done events
  region_images?: Array<{  // NEW — on final composite done
    regionId: string;
    image_url: string;
    seed: number;
  }>;
};
```

**Handle naming convention**: Region nodes use fixed handles — `"prompt"` target (from TextPromptNode), optional `"image"` target (for per-region img2img), and `"image"` source (to Composition node). The Composition node needs **dynamic input handles** — rendered from `data.inputs` array to support a variable number of region connections. This is the recommended approach (Approach A from Q7) aligned with React Flow's data-driven model.

### Image Storage (Q5)
The `save_image()` at `backend/utils/storage.py:18-29` generates filenames as `{timestamp}_{seed}.png`. For N regions + 1 composite:
- Per-region: `{timestamp}_{seed}_region_{regionId}.png`
- Composite: `{timestamp}_{seed}_composite.png`
Sidecar metadata (.json) gains a `region_id` field for per-region query support.

### Existing Design Constraints
The v1 design at `.rpiv/artifacts/designs/2026-06-13_07-55-56_simplified-comfyui-image-gen.md` explicitly deferred inpainting and composable regions. The research at `.rpiv/artifacts/research/simplified-comfyui-image-gen.md` confirmed the Z-Image pipeline's single-pass generation model with no built-in region/area support. This feature retrofits region compositing on top of the single-pass model by running N independent diffusion passes.

## Code References
- `frontend/src/types/workflow.ts:34-37` — `KorgNodeType` union: add `zRegion`, `zComposition`
- `frontend/src/types/workflow.ts:12-27` — `KorgNodeData`: add `regionX?`, `regionY?`, `regionWidth?`, `regionHeight?`, `regionZIndex?`
- `frontend/src/types/workflow.ts:42-60` — SSE event types: add `regionId?`, `region_images?`
- `frontend/src/store/useWorkflowStore.ts:28-50` — `createNode()` defaults: add `zRegion`, `zComposition`
- `frontend/src/store/useWorkflowStore.ts:82-87` — `updateNodeData()`: used for geometry field updates
- `frontend/src/store/useWorkflowStore.ts:94-96` — `onConnect`: must handle dynamic handle registration for composition node
- `frontend/src/components/Canvas.tsx:13-23` — `nodeTypes` map: register region + composition components
- `frontend/src/components/Canvas.tsx:30-40` — `ReactFlow` element: add `onMouseDown`/`onMouseUp`/`onMouseMove` + `panOnDrag` toggle
- `frontend/src/components/nodes/TextPromptNode.tsx:22-24` — BEM pattern: `.korg-node`, `.korg-node__header`, `.korg-node__body`
- `frontend/src/components/nodes/ZImageGenerateNode.tsx:198-203` — Static handle pattern: `<Handle type="target" id="prompt" />`
- `frontend/src/components/Toolbar.tsx:8-15` — `NODE_TYPES` array: add region + composition
- `frontend/src/utils/integration.ts:56-98` — `handleGenerate`: extend for composition node dispatch
- `frontend/src/utils/integration.ts:83-84` — `sseRef`: singleton → potential map for multi-region SSE
- `frontend/src/utils/sse.ts:19-92` — `createSSEConnection`: SSE parser, add `regionId` routing
- `frontend/src/utils/jsonExport.ts:15-46` — `NODE_DATA_DEFAULTS`: add `zRegion`, `zComposition`
- `frontend/src/utils/jsonExport.ts:48-67` — `importWorkflow()` merge: `{ ...defaults, ...n.data }`
- `backend/utils/validation.py:15-53` — `validate_workflow()`: accept `zComposition` as root
- `backend/utils/validation.py:57-88` — `extract_parameters()`: return per-region param list
- `backend/routes/generate.py:40-108` — `generate()` route: route composite params to new runner
- `backend/routes/generate.py:115-163` — `_run_text_to_image`: template for per-region runner
- `backend/routes/generate.py:157` — `done` event: add `region_images` array
- `backend/pipeline.py:106-196` — `generate()`: full `callback_on_step_end` + VAE decode pattern
- `backend/pipeline.py:135-175` — `_on_step` closure: reusable VAE decode logic
- `backend/utils/storage.py:18-29` — `save_image()`: extend filename convention
- `backend/config.py:34-37` — Settings: `preview_decode_interval`, `preview_size`

## Integration Points

### Inbound References
- `frontend/src/components/Canvas.tsx:13-23` — Node type registration consumed by React Flow rendering
- `frontend/src/components/Toolbar.tsx:8-15` — Node type list consumed by the "+ Add node" dropdown
- `frontend/src/utils/integration.ts:56-98` — CustomEvent listener triggers the generation flow
- `frontend/src/utils/sse.ts:19-92` — Response body parsed by SSE client
- `backend/routes/generate.py:40-108` — Request payload parsed by backend route
- `backend/utils/validation.py:15-53` — Workflow validated before generation
- `backend/pipeline.py:106-280` — Pipeline invoked for each region

### Outbound Dependencies
- `frontend/src/store/useWorkflowStore.ts:82-87` — `updateNodeData` writes geometry + state to store
- `frontend/src/utils/jsonExport.ts:48-67` — `importWorkflow()` normalizes loaded node data using `NODE_DATA_DEFAULTS`
- `backend/utils/storage.py:18-29` — `save_image()` persists per-region and composite images
- `@xyflow/react` — `useReactFlow().screenToFlowPosition()`, `onMouseDown`/`onMouseUp`/`onMouseMove`, `panOnDrag`, `NodeResizer` (optionally)
- `PIL.Image` — `Image.paste()` for compositing, `Image.new("RGBA")` for canvas

### Infrastructure Wiring
- `frontend/src/store/useWorkflowStore.ts:94-96` — `onConnect` must be extended for dynamic handle registration on composition node
- `backend/routes/generate.py:65-75` — Route dispatcher branches on composite vs single-pass
- `backend/routes/generate.py:94-108` — `_sse_generator` consumes multi-region progress events unchanged (queue-based)
- `backend/pipeline.py` — `PipelineWrapper` gets new `generate_composite()` method alongside existing `generate()` and `generate_img2img()`

## Architecture Insights
1. **Two new node types**: `zRegion` (owns geometry + generation params + prompt connection) and `zComposition` (composites all region outputs). Clean separation: each region is an independent diffusion job, the composition node orchestrates.
2. **Click-drag-to-draw requires pan toggle**: The `panOnDrag={!drawMode}` prop is the single architectural knob that resolves the interaction conflict between canvas panning and rectangle drawing. Without it, users would pan the viewport instead of drawing.
3. **Dynamic handles on composition node**: The number of region inputs to the composition node is variable (1 to N). Must iterate `data.inputs` to render `<Handle>` elements rather than hardcoding. The `onConnect` handler needs to be extended to update the composition node's `data.inputs` when a new region edge is created.
4. **Sequential per-region diffusion**: Running N sequential `self._pipeline(...)` calls is memory-efficient (one region's latents at a time) and naturally supports per-region seeds. Parallel region generation would require multiple pipeline instances (impractical on MPS with ~24GB shared memory).
5. **Z-order compositing via paste order**: `Image.paste()` in array order, sorted by `regionZIndex`. The alpha channel of the pasted image (`canvas.paste(img, pos, img)`) means transparent pixels don't occlude underlying regions.
6. **Geometry stored in flow coordinates**: `regionX`/`regionY`/`regionWidth`/`regionHeight` are stored in React Flow's coordinate space, not screen pixels. The rendering overlay uses `screenToFlowPosition()` inverse to position the visual rectangle.
7. **Handle naming convention is load-bearing**: The backend's `extract_parameters()` walks edges using handle ID strings (`"prompt"`, `"image"`, etc.). Region nodes use the same convention: `"prompt"` for text input, `"image"` for image input/output. The composition node uses convention-based handle IDs like `"region_{nodeId}"` or simply iterates `data.inputs`.

## Precedents & Lessons
0 similar past changes analyzed in korg-e (git history unavailable).

### Composite Lessons
1. **Lazy loading + compositing**: The existing lazy-load pattern (pipeline loaded on first generation, cached thereafter) is compatible with multi-region generation — the model is loaded once and reused across all region diffusion passes.
2. **Progressive image decode already exists**: VAE decode for intermediate previews was previously added (`backend/pipeline.py:135-175`). The same `preview_decode_interval` and `preview_size` config parameters apply to per-region intermediate previews.
3. **No existing compositing abstraction**: The current codebase has no PIL compositing or canvas management. This is net-new functionality, not extending an existing compositing/rendering layer.

## Historical Context (from `.rpiv/artifacts/`)
- `.rpiv/artifacts/designs/2026-06-13_07-55-56_simplified-comfyui-image-gen.md` — Original design explicitly deferred inpainting and composable regions from v1 scope
- `.rpiv/artifacts/research/simplified-comfyui-image-gen.md` — Prior research confirming Z-Image pipeline's single-pass generation model with no built-in region support
- `.rpiv/artifacts/plans/2026-06-13_08-57-55_simplified-comfyui-image-gen.md` — V1 implementation plan for the base node-graph system
- `.rpiv/artifacts/plans/2026-06-13_18-50-35_progressive-image-decode.md` — Prior plan for intermediate VAE decode (the same decode pattern reused per-region)

## Developer Context
**Q (discover: Standalone project, no code reference — greenfield): Composable regions were explicitly deferred from v1. Is this a v2 feature on top of the existing architecture?**
A: Yes — this feature retrofits region compositing on top of the existing single-pass pipeline. The four existing node types remain unchanged; the new `zRegion` and `zComposition` types are additive.

**Q (scope-tracer Q3 — data model): Should region geometry use `regionX`/`regionY` fields in `KorgNodeData` or leverage `Node.position`?**
A: `Node.position` gives the top-left of the node's settings panel, not the rectangle. Geometry must be stored in dedicated `KorgNodeData` fields (`regionX`, `regionY`, `regionWidth`, `regionHeight`, `regionZIndex`) to decouple the rectangle position from the node panel position.

**Q (scope-tracer Q6 — backend compositing): Should the pipeline generate each region at its own resolution and then composite, or generate the full canvas and crop?**
A: Each region generates at its own resolution (e.g., 512×512 for a woman region, 200×200 for a sun region). Compositing via PIL `Image.paste()` onto a blank canvas. This is more memory-efficient and allows per-region resolution control.

## Related Research
- `.rpiv/artifacts/research/simplified-comfyui-image-gen.md` — Original architectural research for the korg-e project

## Open Questions
- **Dynamic handle registration**: The `onConnect` handler at `frontend/src/store/useWorkflowStore.ts:94-96` needs to be extended so that when a connection is made between a `zRegion` node's `"image"` source and a `zComposition` node's input handle, the composition node automatically registers the new input handle. Should this be done by detecting edge type in `onConnect`, or via a React Flow `ConnectionLine` component that pre-registers handles?
- **Per-region image previews**: During compositing, should the frontend show per-region intermediate previews (each region displays its own VAE decode as it generates) or only the final composite preview? Showing per-region decodes requires routing `regionId`-tagged SSE events to individual region nodes — adds frontend complexity but better UX.
- **Canvas preview during placement**: Should the user see a live composite preview (e.g., a low-resolution board showing all placed rectangles) while arranging regions? This would require rendering region rectangles on a dummy canvas before any generation runs.
- **Region overlap behavior**: When regions overlap, the z-order determines which region renders on top. Should the user be able to click to reorder regions, or is array-order (first added = bottom) sufficient for v1?
