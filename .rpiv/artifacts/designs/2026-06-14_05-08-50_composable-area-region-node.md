---
date: 2026-06-14T05:08:50-0700
author: Eric Sison
commit: no-commit
branch: detached
repository: korg-e
topic: "Composable Area/Region Node for Image Composition"
tags: [design, region-node, image-composition, react-flow, diffusers, pipeline-compositing]
status: ready
parent: .rpiv/artifacts/research/2026-06-14_04-58-10_composable-area-region-node.md
last_updated: 2026-06-14T05:08:50-0700
last_updated_by: Eric Sison
---

# Design: Composable Area/Region Node for Image Composition

## Summary

Add two new node types to the korg-e node graph — **zRegion** (a rectangular area with its own prompt and generation parameters) and **zComposition** (composites all region outputs onto a final canvas) — enabling multi-region image composition. Architecture: region nodes define geometry in `KorgNodeData` fields, click-drag drawing on the canvas via SVG overlay with `panOnDrag` toggle, sequential per-region diffusion passes in a new `PipelineWrapper.generate_composite()` method composited with PIL `Image.paste()`, and per-region SSE progress via `regionId`-tagged events. Implicit composite detection: the integration hook checks for a `zComposition` node and dispatches a composite request; the backend branches on whether `extract_parameters()` returns a `regions` list.

## Requirements

- User can place a **zRegion** node and define a rectangular area via click-drag on the canvas
- Region geometry stored as `regionX`, `regionY`, `regionWidth`, `regionHeight`, `regionZIndex` on `KorgNodeData`
- Each region has its own prompt (connected via TextPrompt node), steps, CFG scale, seed, and width/height
- User can place a **zComposition** node that composites all connected region outputs
- Composition node has dynamic input handles (one per connected region)
- Composition node exposes canvas width/height and a Generate button
- Backend runs N sequential diffusion passes (one per region) reusing the loaded pipeline
- PIL compositing: each region generated at its own resolution, pasted onto a transparent RGBA canvas at (x, y) with alpha compositing
- Per-region SSE progress: `regionId` field on progress events, per-region intermediate VAE decode previews
- Per-region images saved to disk alongside the final composite
- Explicit z-order compositing sorted by `regionZIndex`
- Validate composite workflows: each region must have geometry, no region exceeds canvas bounds, at least one region connected

## Current State Analysis

The codebase currently supports 4 node types (textPrompt, imageUpload, zImageGenerate, imageOutput) with a single-pass txt2img or img2img pipeline. The routing dispatches based on `is_img2img` boolean. SSE events carry a flat schema with no `regionId` field. Frontend node rendering uses static handles. There is no PIL compositing, no SVG overlay drawing, and no draw-mode interaction anywhere in the codebase.

### Key Discoveries

- **Node registration chain**: 5 locations — type union (`workflow.ts:36`), store factory (`useWorkflowStore.ts:28-50`), Canvas nodeTypes (`Canvas.tsx:13-23`), Toolbar dropdown (`Toolbar.tsx:8-15`), jsonExport defaults (`jsonExport.ts:15-46`). Must stay in sync.
- **Handle discovery is DOM-driven**: @xyflow/react queries `[data-handleid]` DOM attributes at render time — dynamic handles work if rendered in JSX (`workflow.ts HandleDef` is the source of truth).
- **useUpdateNodeInternals()** is required after any programmatic handle change — best called via `useEffect` inside the node component watching `data.inputs.length`.
- **CustomEvent pattern**: Components dispatch events (`korg:generate`, `korg:updateNode`); `useWorkflowIntegration()` in `integration.ts` catches them. The ref-based pattern avoids stale closures.
- **Pipeline already has VAE decode**: `backend/pipeline.py:135-175` — the `_on_step` closure, VAE decode formula (scaling_factor + shift_factor), `preview_decode_interval`, and `preview_size` are all directly reusable per-region.
- **No existing CSS files**: All styling is inline via `style={{}}` objects — new nodes follow this pattern.
- **No existing tests**: Project has no `tests/` directory or test configuration.

### Patterns to Follow

1. **Node component template** (`TextPromptNode.tsx:1-35`): `NodeProps<KorgNode>` generic, `useWorkflowStore((s) => s.updateNodeData)`, BEM `korg-node` classes, `nodrag` on interactive elements
2. **Static node type map** (`Canvas.tsx:10-17`): Defined outside component, not inline
3. **CustomEvent → integration hook** (`integration.ts:34-120`): ref-based stable closures, single `useEffect` with `[]` deps
4. **Store + jsonExport dual defaults** (`useWorkflowStore.ts:28-50` and `jsonExport.ts:15-46`): must stay in sync
5. **Sequential thread-pool runners** (`generate.py:125-266`): three-phase pattern (load → generate → persist), `_push` closure for SSE
6. **VAE decode pattern** (`pipeline.py:135-175`): `callback_on_step_end` with `torch.no_grad()`, latents → VAE decode → postprocess → PIL → JPEG base64

### Constraints

- React Flow's `width`/`height` are computed (DOM-measured), not stored — geometry must use dedicated fields on `KorgNodeData`
- `applyNodeChanges()` has no `'zIndex'` change type — `zIndex` is read-once during initial render
- `nodrag` class on interactive elements is required to allow canvas pan/drag through node internals
- Draw mode conflicts with `panOnDrag` — must toggle off pan/drag while drawing
- MPS memory limit (~24GB shared) constrains us to sequential region generation (one region's latents at a time)

## Scope

### Building

- `zRegion` and `zComposition` node types (new components, types, defaults)
- Click-drag rectangle drawing with SVG overlay for region placement
- `useUIStore` for transient draw state (drawMode, drawingRect)
- Dynamic input handles on `zComposition` node rendered from `data.inputs`
- Composite mode detection (frontend + backend implicit)
- `PipelineWrapper.generate_composite()` — sequential per-region diffusion + PIL compositing with z-ordering
- Per-region SSE progress events tagged with `regionId`
- Per-region intermediate VAE decode previews
- `save_composite_images()` — per-region + composite image persistence with extended sidecar metadata
- `extract_parameters()` composite branch returning `regions` list + canvas dimensions
- `validate_workflow()` accepts `zComposition` as root with per-region geometry validation
- `_run_composite` background runner in routes
- `onConnect` extended to update composition node `data.inputs` + trigger `useUpdateNodeInternals()`

### Not Building

- Per-region img2img (each region with its own init image) — deferred to follow-up
- Live canvas preview showing region layout before generation
- Reordering regions via click interaction — array order suffices for v1
- Region overlap visualization beyond z-order compositing
- Parallel region generation (impractical on MPS memory)
- Tool-level draw mode toggle — draw mode toggled per-region from the node itself

## Decisions

### Decision 1: Geometry stored in KorgNodeData fields

- **Ambiguity**: Use `Node.position` vs dedicated `regionX/regionY/regionWidth/regionHeight` fields
- **Explored**: `Node.position` gives the settings panel position, not the rectangle. React Flow's `width`/`height` are computed from DOM. `zIndex` is read-once.
- **Decision**: Dedicated fields `regionX`, `regionY`, `regionWidth`, `regionHeight`, `regionZIndex` on `KorgNodeData` — full lifecycle support, serialization, store updates.

### Decision 2: Draw mode state in separate useUIStore

- **Ambiguity**: Add transient UI state to `useWorkflowStore` vs new store
- **Explored**: Existing store mixes node data with a single `isFirstLaunch` flag. Adding draw mode fields to it creates a concern boundary violation.
- **Decision**: New `useUIStore` for `drawMode`, `drawingRect`, `setDrawMode`, `setDrawingRect`, `setDrawingRect` — cleaner separation confirmed by developer.

### Decision 3: useEffect + useUpdateNodeInternals for dynamic handles

- **Ambiguity**: How to trigger handle re-measurement after composition node `data.inputs` change
- **Explored**: CustomEvent dispatch from `onConnect` vs `useEffect` inside CompositionNode
- **Decision**: `useEffect` inside CompositionNode watching `data.inputs.length` — matches the @xyflow/react documentation pattern directly. Developer confirmed.

### Decision 4: Implicit composite detection (frontend + backend)

- **Ambiguity**: How to detect composite vs single-pass mode
- **Explored**: Explicit `mode` field on `GenerateRequest` vs implicit detection by graph structure
- **Decision**: Frontend detects `zComposition` presence in node array; backend returns `regions` key from `extract_parameters()`. Keeps the request body backward-compatible and consistent across stack. Developer confirmed.

### Decision 5: Implicit composite dispatch (one Generate button on Composition)

- **Ambiguity**: Separate Generate per region vs one Generate on Composition vs detect-and-dispatch
- **Explored**: Each approach has different frontend complexity and UX tradeoffs
- **Decision**: Integration hook detects composite mode implicitly. When user clicks "Generate" on the Composition node, it dispatches the full composite request. No separate Generate buttons on region nodes for v1. Developer confirmed.

### Decision 6: Sequential per-region diffusion

- **Ambiguity**: Parallel vs sequential region generation
- **Explored**: Parallel requires multiple pipeline instances — impractical on MPS. Sequential reuses the loaded model.
- **Decision**: Sequential, sorted by `regionZIndex`. Memory-efficient, natural seed isolation, same `callback_on_step_end` pattern reused.

### Decision 7: HandleDef extended with sourceNodeId

- **Ambiguity**: How to track which region connects to which composition input handle
- **Explored**: Separate `regionConnections` map vs extending `HandleDef`
- **Decision**: Extend `HandleDef` with optional `sourceNodeId?: string` — minimal change, composition node uses it to render handle labels and track connections.

## Architecture

### frontend/src/types/workflow.ts — MODIFY

```typescript
/* korg-e workflow type definitions */

import type { Node, Edge } from "@xyflow/react";

// ── Node data types ────────────────────────────────────────────────────

export type HandleDef = {
  name: string;
  type: string; // "image" | "prompt" | "any"
  required?: boolean;
  sourceNodeId?: string; // for composition node — tracks which region an input handle belongs to
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
  strength?: number;
  seed?: number | null;
  width?: number;
  height?: number;
  // ImageOutputNode
  imageUrl?: string | null;
  seedInfo?: number;
  // RegionNode
  regionX?: number;
  regionY?: number;
  regionWidth?: number;
  regionHeight?: number;
  regionZIndex?: number;
  // CompositionNode
  canvasWidth?: number;
  canvasHeight?: number;
};

export type KorgNodeType =
  | "textPrompt"
  | "imageUpload"
  | "zImageGenerate"
  | "imageOutput"
  | "zRegion"
  | "zComposition";

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
  regionId?: string;   // NEW — which region this progress is for
  step?: number;
  total?: number;
  phase?: string;
  image_b64?: string;  // base64-encoded JPEG preview (no data URL prefix)
};

export type SSEDoneEvent = {
  event: "done";
  status: "complete";
  image_url: string;
  seed: number;
  regionId?: string;             // NEW — per-region done events
  region_images?: Array<{        // NEW — on final composite done
    regionId: string;
    image_url: string;
    seed: number;
  }>;
};

export type SSEErrorEvent = {
  event: "error";
  status: "error";
  message?: string;
  errors?: string[];
};

export type SSEEvent = SSEProgressEvent | SSEDoneEvent | SSEErrorEvent;
```

### frontend/src/store/useUIStore.ts — NEW

```typescript
/**
 * Transient UI state — drawing interaction, canvas mode overrides.
 *
 * This store holds ephemeral state that is NOT persisted as part of
 * the workflow graph. Separated from useWorkflowStore to keep
 * persisted workflow data clean (no drawMode, drawingRect leaks
 * into save/load JSON).
 */

import { create } from "zustand";

export type DrawingRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type UIStore = {
  /** Whether the canvas is currently in "draw region" mode. */
  drawMode: boolean;
  /** The live rectangle being drawn (updated during mousemove). */
  drawingRect: DrawingRect | null;
  /** The region node ID currently being drawn for (or drawn from). */
  drawingNodeId: string | null;

  setDrawMode: (enabled: boolean, nodeId?: string) => void;
  setDrawingRect: (rect: DrawingRect | null) => void;
  resetDrawing: () => void;
};

export const useUIStore = create<UIStore>((set) => ({
  drawMode: false,
  drawingRect: null,
  drawingNodeId: null,

  setDrawMode: (enabled: boolean, nodeId?: string) =>
    set({
      drawMode: enabled,
      drawingNodeId: enabled ? (nodeId ?? null) : null,
      drawingRect: null, // clear any partial rect when toggling
    }),

  setDrawingRect: (rect: DrawingRect | null) =>
    set({ drawingRect: rect }),

  resetDrawing: () =>
    set({ drawMode: false, drawingRect: null, drawingNodeId: null }),
}));
```

### frontend/src/store/useWorkflowStore.ts — MODIFY

```typescript
// Inside createNode() defaults map, added after imageOutput:
    zRegion: {
      label: "Region",
      steps: 50,
      cfgScale: 5.0,
      strength: 0.6,
      seed: null,
      width: 256,
      height: 256,
      regionX: 0,
      regionY: 0,
      regionWidth: 256,
      regionHeight: 256,
      regionZIndex: 0,
      inputs: [
        { name: "prompt", type: "prompt", required: true },
        { name: "image", type: "image" },
      ],
      outputs: [{ name: "image", type: "image" }],
    },
    zComposition: {
      label: "Composition",
      canvasWidth: 1024,
      canvasHeight: 1024,
      inputs: [],
      outputs: [{ name: "image", type: "image" }],
    },
```

### frontend/src/utils/jsonExport.ts — MODIFY

```typescript
// Inside NODE_DATA_DEFAULTS, added after imageOutput:
  zRegion: {
    label: "Region",
    steps: 50,
    cfgScale: 5.0,
    strength: 0.6,
    seed: null,
    width: 256,
    height: 256,
    regionX: 0,
    regionY: 0,
    regionWidth: 256,
    regionHeight: 256,
    regionZIndex: 0,
    inputs: [
      { name: "prompt", type: "prompt", required: true },
      { name: "image", type: "image" },
    ],
    outputs: [{ name: "image", type: "image" }],
  },
  zComposition: {
    label: "Composition",
    canvasWidth: 1024,
    canvasHeight: 1024,
    inputs: [],
    outputs: [{ name: "image", type: "image" }],
  },
```

### frontend/src/components/nodes/RegionNode.tsx — NEW

```typescript
import { useCallback } from "react";
import {
  Handle,
  Position,
  type NodeProps,
} from "@xyflow/react";
import type { KorgNode } from "@/types/workflow";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { useUIStore } from "@/store/useUIStore";

export default function RegionNode({ id, data, selected }: NodeProps<KorgNode>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const { drawMode, drawingNodeId, setDrawMode, resetDrawing } =
    useUIStore();

  const isDrawing = drawMode && drawingNodeId === id;

  const steps = data.steps ?? 50;
  const cfgScale = data.cfgScale ?? 5.0;
  const seed = data.seed ?? null;
  const regionWidth = data.regionWidth ?? 256;
  const regionHeight = data.regionHeight ?? 256;
  const regionX = data.regionX ?? 0;
  const regionY = data.regionY ?? 0;
  const regionZIndex = data.regionZIndex ?? 0;

  const handleToggleDraw = useCallback(() => {
    if (isDrawing) {
      resetDrawing();
    } else {
      setDrawMode(true, id);
    }
  }, [isDrawing, id, setDrawMode, resetDrawing]);

  const updateGeometry = useCallback(
    (field: string, value: number) => {
      updateNodeData(id, { [field]: value });
    },
    [id, updateNodeData]
  );

  return (
    <div className={`korg-node ${selected ? "korg-node--selected" : ""}`}>
      <div className="korg-node__header">Region</div>
      <div className="korg-node__body">
        {/* Draw mode toggle */}
        <button
          className="nodrag"
          onClick={handleToggleDraw}
          style={{
            padding: "4px 10px",
            borderRadius: 4,
            border: "none",
            background: isDrawing ? "#c44" : "#4a90d9",
            color: "#fff",
            cursor: "pointer",
            width: "100%",
            marginBottom: 8,
            fontSize: 12,
          }}
        >
          {isDrawing ? "Cancel Draw" : "Draw Region"}
        </button>

        {/* Geometry fields — fine-tuning after drawing */}
        <div className="korg-node__params">
          <label>
            X
            <input
              type="number"
              className="nodrag"
              value={regionX}
              onChange={(e) => updateGeometry("regionX", parseInt(e.target.value, 10))}
              style={{ width: 60 }}
            />
          </label>
          <label>
            Y
            <input
              type="number"
              className="nodrag"
              value={regionY}
              onChange={(e) => updateGeometry("regionY", parseInt(e.target.value, 10))}
              style={{ width: 60 }}
            />
          </label>
          <label>
            Width
            <input
              type="number"
              className="nodrag"
              value={regionWidth}
              min={64}
              max={2048}
              onChange={(e) => {
                const w = parseInt(e.target.value, 10);
                updateGeometry("regionWidth", w);
                updateGeometry("width", w); // sync generation width
              }}
              style={{ width: 60 }}
            />
          </label>
          <label>
            Height
            <input
              type="number"
              className="nodrag"
              value={regionHeight}
              min={64}
              max={2048}
              onChange={(e) => {
                const h = parseInt(e.target.value, 10);
                updateGeometry("regionHeight", h);
                updateGeometry("height", h); // sync generation height
              }}
              style={{ width: 60 }}
            />
          </label>
          <label>
            Z
            <input
              type="number"
              className="nodrag"
              value={regionZIndex}
              min={0}
              max={100}
              onChange={(e) => updateGeometry("regionZIndex", parseInt(e.target.value, 10))}
              style={{ width: 60 }}
            />
          </label>
        </div>

        <hr style={{ border: "none", borderTop: "1px solid #444", margin: "8px 0" }} />

        {/* Generation params */}
        <div className="korg-node__params">
          <label>
            Steps
            <input
              type="number"
              className="nodrag"
              value={steps}
              min={1}
              max={100}
              onChange={(e) => updateNodeData(id, { steps: parseInt(e.target.value, 10) })}
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
        </div>

        {/* Status */}
        {data.status === "error" && data.error && (
          <div style={{ marginTop: 8, padding: 4, color: "#e44", fontSize: 12 }}>
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

### frontend/src/components/Canvas.tsx — MODIFY

```typescript
/** React Flow canvas container with node type registration, background,
 *  draw-mode interaction, and region rectangle SVG overlay. */

import { useMemo, useCallback } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  type NodeTypes,
  type MouseEvent as ReactFlowMouseEvent,
} from "@xyflow/react";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { useUIStore } from "@/store/useUIStore";
import { useWorkflowIntegration } from "@/utils/integration";
import TextPromptNode from "@/components/nodes/TextPromptNode";
import ImageUploadNode from "@/components/nodes/ImageUploadNode";
import ZImageGenerateNode from "@/components/nodes/ZImageGenerateNode";
import ImageOutputNode from "@/components/nodes/ImageOutputNode";
import RegionNode from "@/components/nodes/RegionNode";

const nodeTypes: NodeTypes = {
  textPrompt: TextPromptNode,
  imageUpload: ImageUploadNode,
  zImageGenerate: ZImageGenerateNode,
  imageOutput: ImageOutputNode,
  zRegion: RegionNode,
};

export default function FlowCanvas() {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, updateNodeData } =
    useWorkflowStore();
  const { drawMode, drawingNodeId, setDrawMode, setDrawingRect, resetDrawing } =
    useUIStore();
  const reactFlowInstance = useReactFlow();

  // Wire up CustomEvent integration
  useWorkflowIntegration();

  const defaultEdgeOptions = useMemo(
    () => ({
      type: "smoothstep",
      animated: true,
    }),
    []
  );

  // ── Draw mode event handlers ────────────────────────────────────────

  const handleMouseDown = useCallback(
    (event: ReactFlowMouseEvent) => {
      if (!drawMode || !drawingNodeId) return;

      const flowPos = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      setDrawingRect({
        x: flowPos.x,
        y: flowPos.y,
        width: 0,
        height: 0,
      });
    },
    [drawMode, drawingNodeId, reactFlowInstance, setDrawingRect]
  );

  const handleMouseMove = useCallback(
    (event: ReactFlowMouseEvent) => {
      const rect = useUIStore.getState().drawingRect;
      if (!drawMode || !drawingNodeId || !rect) return;

      const flowPos = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      setDrawingRect({
        x: Math.min(rect.x, flowPos.x),
        y: Math.min(rect.y, flowPos.y),
        width: Math.abs(flowPos.x - rect.x),
        height: Math.abs(flowPos.y - rect.y),
      });
    },
    [drawMode, drawingNodeId, reactFlowInstance, setDrawingRect]
  );

  const handleMouseUp = useCallback(
    () => {
      const rect = useUIStore.getState().drawingRect;
      if (!drawMode || !drawingNodeId || !rect || rect.width < 10 || rect.height < 10) {
        // Too small — ignore
        resetDrawing();
        return;
      }

      // Save the drawn rectangle to the region node's data
      updateNodeData(drawingNodeId, {
        regionX: Math.round(rect.x),
        regionY: Math.round(rect.y),
        regionWidth: Math.round(rect.width),
        regionHeight: Math.round(rect.height),
        // Sync generation width/height to match region dimensions
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });

      // Exit draw mode
      resetDrawing();
    },
    [drawMode, drawingNodeId, updateNodeData, resetDrawing]
  );

  // ── SVG overlay: draw live rect + saved region rectangles ───────────
  // Subscribe to drawingRect from the hook so the overlay re-renders
  // reactively during mousemove (not via getState()).
  const drawingRect = useUIStore((s) => s.drawingRect);

  const overlaySvg = useMemo(() => {
    return (
      <svg
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          zIndex: 100,
        }}
      >
        {/* Live rectangle being drawn */}
        {drawingRect && (
          <rect
            x={drawingRect.x}
            y={drawingRect.y}
            width={drawingRect.width}
            height={drawingRect.height}
            fill="rgba(74, 144, 217, 0.15)"
            stroke="#4a90d9"
            strokeWidth={2}
            strokeDasharray="6 3"
            rx={4}
          />
        )}

        {/* Saved region rectangles from all region nodes */}
        {nodes
          .filter(
            (n) =>
              n.type === "zRegion" &&
              n.data.regionWidth &&
              n.data.regionHeight &&
              n.data.regionWidth > 0 &&
              n.data.regionHeight > 0
          )
          .map((n) => (
            <rect
              key={n.id}
              x={n.data.regionX ?? 0}
              y={n.data.regionY ?? 0}
              width={n.data.regionWidth ?? 0}
              height={n.data.regionHeight ?? 0}
              fill="rgba(74, 144, 217, 0.08)"
              stroke="#4a90d9"
              strokeWidth={1.5}
              rx={3}
            />
          ))}
      </svg>
    );
  }, [nodes, drawingRect]);

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        position: "relative",
        cursor: drawMode ? "crosshair" : undefined,
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        panOnDrag={!drawMode}
        nodesDraggable={!drawMode}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        fitView
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls />
        <MiniMap />
        {/* Region rectangle overlay */}
        {overlaySvg}
      </ReactFlow>
    </div>
  );
}
```

### frontend/src/components/Toolbar.tsx — MODIFY

```typescript
// Inside NODE_TYPES array, added after zImageGenerate:
  { type: "zRegion", label: "Region" },
  { type: "zComposition", label: "Composition" },
```

### frontend/src/components/nodes/CompositionNode.tsx — NEW

```typescript
import { useCallback, useEffect } from "react";
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from "@xyflow/react";
import type { KorgNode } from "@/types/workflow";
import { useWorkflowStore } from "@/store/useWorkflowStore";

export default function CompositionNode({
  id,
  data,
  selected,
}: NodeProps<KorgNode>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const nodes = useWorkflowStore((s) => s.nodes);
  const updateNodeInternals = useUpdateNodeInternals();

  const canvasWidth = data.canvasWidth ?? 1024;
  const canvasHeight = data.canvasHeight ?? 1024;
  const inputs = data.inputs ?? [];
  const status = data.status ?? "idle";
  const isBusy = status === "loading" || status === "generating";

  // Re-measure handles whenever inputs change (dynamic handles)
  useEffect(() => {
    updateNodeInternals(id);
  }, [inputs.length, id, updateNodeInternals]);

  // Find connected region nodes to show labels
  const connectedRegions = nodes.filter(
    (n) =>
      n.type === "zRegion" &&
      inputs.some((inp) => inp.sourceNodeId === n.id)
  );

  const handleGenerate = useCallback(() => {
    const workflowEvent = new CustomEvent("korg:generate", {
      detail: {
        nodeId: id,
        params: {
          canvasWidth,
          canvasHeight,
        },
      },
    });
    window.dispatchEvent(workflowEvent);
  }, [id, canvasWidth, canvasHeight]);

  return (
    <div className={`korg-node ${selected ? "korg-node--selected" : ""}`}>
      <div className="korg-node__header">Composition</div>
      <div className="korg-node__body">
        {/* Canvas dimensions */}
        <div className="korg-node__params">
          <label>
            Canvas W
            <input
              type="number"
              className="nodrag"
              value={canvasWidth}
              min={256}
              max={4096}
              step={64}
              onChange={(e) =>
                updateNodeData(id, {
                  canvasWidth: parseInt(e.target.value, 10),
                })
              }
              style={{ width: 70 }}
            />
          </label>
          <label>
            Canvas H
            <input
              type="number"
              className="nodrag"
              value={canvasHeight}
              min={256}
              max={4096}
              step={64}
              onChange={(e) =>
                updateNodeData(id, {
                  canvasHeight: parseInt(e.target.value, 10),
                })
              }
              style={{ width: 70 }}
            />
          </label>
        </div>

        {/* Connected regions list */}
        {connectedRegions.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 11, color: "#999" }}>
            <div style={{ marginBottom: 4, fontWeight: "bold", color: "#ccc" }}>
              Regions ({connectedRegions.length}):
            </div>
            {connectedRegions.map((rn) => (
              <div key={rn.id} style={{ paddingLeft: 4, marginBottom: 2 }}>
                {rn.id}
              </div>
            ))}
          </div>
        )}

        {/* Generate button */}
        <button
          className="korg-node__generate nodrag"
          onClick={handleGenerate}
          disabled={isBusy || connectedRegions.length === 0}
          style={{
            marginTop: 8,
            padding: "6px 16px",
            background:
              isBusy || connectedRegions.length === 0 ? "#666" : "#4a90d9",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor:
              isBusy || connectedRegions.length === 0
                ? "not-allowed"
                : "pointer",
            width: "100%",
          }}
        >
          {isBusy
            ? "Generating…"
            : connectedRegions.length === 0
              ? "Connect regions"
              : `Generate (${connectedRegions.length} regions)`}
        </button>

        {/* Error display */}
        {status === "error" && data.error && (
          <div
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

      {/* Dynamic input handles: one per connected region */}
      {inputs.map((input, index) => (
        <Handle
          key={input.name}
          type="target"
          position={Position.Left}
          id={input.name}
          style={{
            top: `${((index + 1) * 100) / (inputs.length + 1)}%`,
          }}
        />
      ))}

      {/* Output handle for composited image */}
      <Handle type="source" position={Position.Right} id="image" />
    </div>
  );
}
```

### frontend/src/utils/integration.ts — MODIFY

```typescript
/** Integration wiring — listens for CustomEvents from node components
 *  and orchestrates the full generation workflow.
 *
 * Supports both standard (txt2img/img2img) and composite (multi-region)
 * generation modes, detected implicitly from the source node type.
 */

import { useEffect, useRef } from "react";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { createSSEConnection } from "@/utils/sse";
import type { KorgNodeData } from "@/types/workflow";

/**
 * Hook that registers CustomEvent listeners for the node graph.
 *
 * Place this in the Canvas component to wire up:
 * - ``korg:updateNode`` — ImageUploadNode sends base64 image data
 * - ``korg:generate`` — ZImageGenerateNode or CompositionNode triggers generation
 *
 * Uses refs for the graph snapshot to avoid re-registering listeners
 * on every state change (which would abort in-flight SSE connections).
 */
export function useWorkflowIntegration() {
  const { nodes, edges, updateNodeData } = useWorkflowStore();
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const sseRef = useRef<{ abort: () => void } | null>(null);

  // Keep refs in sync without triggering re-render
  nodesRef.current = nodes;
  edgesRef.current = edges;

  // Stable callback refs — never cause the effect to re-run
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
        params: Record<string, unknown>;
      };

      // Read latest graph state from refs (avoids stale closure)
      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;
      const updater = updateNodeDataRef.current;

      // ── Composite mode detection ────────────────────────────────────
      const sourceNode = currentNodes.find((n) => n.id === nodeId);
      const isComposite = sourceNode?.type === "zComposition";

      // Abort any previous generation
      sseRef.current?.abort();
      updater(nodeId, { status: "loading", progress: 0 });

      if (isComposite) {
        // ── Composite dispatch ────────────────────────────────────────
        const compositionData = sourceNode.data;
        const canvasWidth = compositionData.canvasWidth ?? 1024;
        const canvasHeight = compositionData.canvasHeight ?? 1024;

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
          is_composite: true,
          canvas_width: canvasWidth,
          canvas_height: canvasHeight,
        };

        sseRef.current = createSSEConnection(body, {
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

              // Forward per-region intermediate preview
              const imageB64 = data.image_b64 as string | undefined;
              if (imageB64) {
                const outputEdges = currentEdges.filter(
                  (e) => e.source === nodeId && e.sourceHandle === "image"
                );
                for (const oe of outputEdges) {
                  updater(oe.target, {
                    imageUrl: `data:image/jpeg;base64,${imageB64}`,
                  });
                }
              }
            } else if (status === "saving") {
              updater(nodeId, { status: "loading" });
            }
          },
          onDone: (data) => {
            const imageUrl = data.image_url as string;
            const seed = data.seed as number;

            updater(nodeId, {
              status: "complete",
              imageUrl,
              seedInfo: seed,
              progress: 0,
            });

            // Forward composite image to connected ImageOutput nodes
            const outputEdges = currentEdges.filter(
              (e) => e.source === nodeId && e.sourceHandle === "image"
            );
            for (const oe of outputEdges) {
              updater(oe.target, {
                imageUrl,
                seedInfo: seed,
              });
            }
          },
          onError: (data) => {
            updater(nodeId, {
              status: "error",
              error: (data.message as string) ?? "Composite generation failed",
              progress: 0,
            });
          },
        });
        return;
      }

      // ── Standard (non-composite) dispatch ─────────────────────────
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
      };

      sseRef.current = createSSEConnection(body, {
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

            // Forward intermediate preview to connected ImageOutput node
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
        onDone: (data) => {
          const imageUrl = data.image_url as string;
          const seed = data.seed as number;
          updater(nodeId, {
            status: "complete",
            imageUrl,
            seedInfo: seed,
            progress: 0,
          });

          // Also update the ImageOutput node if connected
          const outputEdge = currentEdges.find(
            (e) => e.source === nodeId && e.sourceHandle === "image"
          );
          if (outputEdge) {
            updater(outputEdge.target, {
              imageUrl,
              seedInfo: seed,
            });
          }
        },
        onError: (data) => {
          updater(nodeId, {
            status: "error",
            error: (data.message as string) ?? "Generation failed",
            progress: 0,
          });
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
    // Intentionally empty deps — refs avoid stale closures without
    // re-registering listeners on every graph mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
```

### backend/utils/validation.py — MODIFY

```python
"""Graph topology validation and parameter extraction for submitted workflows.

Supports both standard (single zImageGenerate) and composite
(zComposition + N zRegion) workflows.
"""

from typing import Any


def validate_workflow(nodes: list[dict], edges: list[dict]) -> list[str]:
    """Validate a workflow's graph topology.

    Returns a list of error messages (empty = valid).
    """
    errors: list[str] = []
    node_ids = {n["id"] for n in nodes}

    # ── 1. At least one root generation node ───────────────────────────
    generate_nodes = [
        n for n in nodes
        if n.get("type") in ("zImageGenerate", "zComposition")
    ]
    if not generate_nodes:
        errors.append(
            "Workflow must contain at least one Z-Image Generate or Composition node."
        )

    # ── 1b. Composite-specific validation ─────────────────────────────
    composition_nodes = [n for n in nodes if n.get("type") == "zComposition"]
    for comp_node in composition_nodes:
        comp_data = comp_node.get("data", {})
        canvas_w = comp_data.get("canvasWidth", 1024)
        canvas_h = comp_data.get("canvasHeight", 1024)

        # Find connected region nodes via edges
        connected_regions = [
            e.get("source") for e in edges
            if e.get("target") == comp_node["id"]
        ]
        if not connected_regions:
            errors.append(
                f"Composition node '{comp_node['id']}' has no connected region nodes."
            )

        for region_id in connected_regions:
            region_node = next(
                (n for n in nodes if n["id"] == region_id), None
            )
            if not region_node:
                continue
            region_data = region_node.get("data", {})
            rw = region_data.get("regionWidth", 0)
            rh = region_data.get("regionHeight", 0)
            rx = region_data.get("regionX", 0)
            ry = region_data.get("regionY", 0)

            if rw <= 0 or rh <= 0:
                errors.append(
                    f"Region node '{region_id}' has invalid dimensions "
                    f"({rw}×{rh}). Must be positive."
                )
            if rx + rw > canvas_w or ry + rh > canvas_h:
                errors.append(
                    f"Region node '{region_id}' exceeds canvas bounds "
                    f"(canvas: {canvas_w}×{canvas_h}, region: "
                    f"({rx},{ry}) {rw}×{rh})."
                )

    # ── 2. Every edge connects existing nodes ──────────────────────────
    for edge in edges:
        if edge.get("source") not in node_ids:
            errors.append(f"Edge references unknown source node: {edge.get('source')}")
        if edge.get("target") not in node_ids:
            errors.append(f"Edge references unknown target node: {edge.get('target')}")

    # ── 3. Every input handle must be connected (no floating inputs) ───
    #    (except for TextPrompt nodes whose prompt is user-entered)
    for node in nodes:
        node_type = node.get("type", "")
        data = node.get("data", {})
        inputs: list[dict] = data.get("inputs", [])
        for inp in inputs:
            handle_id = inp.get("name", "")
            # Check if this handle has any incoming edge
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


def extract_parameters(
    nodes: list[dict], edges: list[dict]
) -> dict[str, Any]:
    """Extract generation parameters from a valid workflow.

    For standard workflows returns a dict with ``prompt``, ``steps``,
    ``cfg_scale``, ``seed``, ``width``, ``height``, and optionally
    ``init_image`` base64 data.

    For composite workflows returns a dict with ``mode`` set to
    ``\"composite\"``, ``canvas_width``, ``canvas_height``, and
    a ``regions`` list of per-region parameter dicts.
    """
    # ── Detect composite mode ──────────────────────────────────────────
    composition_nodes = [n for n in nodes if n.get("type") == "zComposition"]
    if composition_nodes:
        return _extract_composite_params(nodes, edges, composition_nodes[0])

    # ── Standard (single-pass) mode ────────────────────────────────────
    params: dict[str, Any] = {}

    # Find the Generate node
    generate_node = next(n for n in nodes if n.get("type") == "zImageGenerate")
    gen_data = generate_node.get("data", {})
    params["steps"] = gen_data.get("steps", 50)
    params["cfg_scale"] = gen_data.get("cfgScale", 5.0)
    params["strength"] = gen_data.get("strength", 0.6)
    params["seed"] = gen_data.get("seed", None)
    params["width"] = gen_data.get("width", 1024)
    params["height"] = gen_data.get("height", 1024)

    # Find the connected TextPrompt node by traversing edges
    node_map = {n["id"]: n for n in nodes}
    for edge in edges:
        if edge["target"] == generate_node["id"] and edge.get("targetHandle") == "prompt":
            source_node = node_map.get(edge["source"])
            if source_node:
                params["prompt"] = source_node.get("data", {}).get("prompt", "")

    # Check for img2img (ImageUpload node connected to generate's image input)
    for edge in edges:
        if edge["target"] == generate_node["id"] and edge.get("targetHandle") == "image":
            source_node = node_map.get(edge["source"])
            if source_node and source_node.get("type") == "imageUpload":
                params["init_image"] = source_node.get("data", {}).get("imageData", None)

    return params


def _extract_composite_params(
    nodes: list[dict], edges: list[dict], comp_node: dict
) -> dict[str, Any]:
    """Extract composite generation parameters from a composition workflow."""
    comp_data = comp_node.get("data", {})
    node_map = {n["id"]: n for n in nodes}

    params: dict[str, Any] = {
        "mode": "composite",
        "canvas_width": comp_data.get("canvasWidth", 1024),
        "canvas_height": comp_data.get("canvasHeight", 1024),
        "regions": [],
    }

    # Find edges targeting the composition node (from region nodes)
    region_edges = [
        e for e in edges
        if e.get("target") == comp_node["id"]
    ]

    for edge in region_edges:
        region_node = node_map.get(edge.get("source", ""))
        if not region_node or region_node.get("type") != "zRegion":
            continue

        region_data = region_node.get("data", {})

        # Extract per-region prompt from connected TextPrompt node
        prompt = ""
        for pe in edges:
            if (
                pe["target"] == region_node["id"]
                and pe.get("targetHandle") == "prompt"
            ):
                prompt_node = node_map.get(pe["source"])
                if prompt_node:
                    prompt = prompt_node.get("data", {}).get("prompt", "")

        region_params = {
            "region_id": region_node["id"],
            "prompt": prompt,
            "steps": region_data.get("steps", 50),
            "cfg_scale": region_data.get("cfgScale", 5.0),
            "strength": region_data.get("strength", 0.6),
            "seed": region_data.get("seed", None),
            "region_x": region_data.get("regionX", 0),
            "region_y": region_data.get("regionY", 0),
            "region_width": region_data.get("regionWidth", 256),
            "region_height": region_data.get("regionHeight", 256),
            "region_z_index": region_data.get("regionZIndex", 0),
        }

        # Check for per-region img2img (deferred, but extract if present)
        for ie in edges:
            if (
                ie["target"] == region_node["id"]
                and ie.get("targetHandle") == "image"
            ):
                img_node = node_map.get(ie["source"])
                if img_node and img_node.get("type") == "imageUpload":
                    region_params["init_image"] = img_node.get("data", {}).get("imageData", None)

        params["regions"].append(region_params)

    # Sort regions by z-index for compositing order
    params["regions"].sort(key=lambda r: r.get("region_z_index", 0))

    return params
```

### backend/utils/storage.py — MODIFY

```python
"""Image storage — save, list, and delete generated images.

Supports single-image save (existing), composite-image save
(per-region + composite PNG with sidecar metadata).
"""

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


def save_composite_images(
    composite_bytes: bytes,
    region_images: list[tuple[str, bytes, dict]],
    prompt: str,
    seed: int,
    timestamp: str | None = None,
) -> dict:
    """Save composite + per-region images and return URL paths.

    ``region_images`` is a list of ``(region_id, png_bytes, metadata_dict)``
    tuples, one per region.

    Returns a dict with ``image_url`` (composite) and ``region_images``
    (list of ``{regionId, image_url, seed}`` dicts).
    """
    ts = timestamp or datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    base = f"{ts}_{seed}"

    # Save per-region images
    region_urls: list[dict] = []
    for region_id, region_data, region_meta in region_images:
        filename = f"{base}_region_{region_id}.png"
        output_path = _ensure_output_dir() / filename
        with open(output_path, "wb") as f:
            f.write(region_data)

        meta = {
            "filename": filename,
            "prompt": region_meta.get("prompt", prompt),
            "seed": region_meta.get("seed", seed),
            "timestamp": ts,
            "region_id": region_id,
            "region_x": region_meta.get("x"),
            "region_y": region_meta.get("y"),
            "region_width": region_meta.get("width"),
            "region_height": region_meta.get("height"),
        }
        meta_path = output_path.with_suffix(".json")
        meta_path.write_text(json.dumps(meta, indent=2))

        region_urls.append({
            "regionId": region_id,
            "image_url": f"/images/{filename}",
            "seed": region_meta.get("seed", seed),
        })

    # Save composite image
    composite_filename = f"{base}_composite.png"
    composite_path = _ensure_output_dir() / composite_filename
    with open(composite_path, "wb") as f:
        f.write(composite_bytes)

    composite_meta = {
        "filename": composite_filename,
        "prompt": prompt,
        "seed": seed,
        "timestamp": ts,
        "type": "composite",
    }
    meta_path = composite_path.with_suffix(".json")
    meta_path.write_text(json.dumps(composite_meta, indent=2))

    return {
        "image_url": f"/images/{composite_filename}",
        "region_images": region_urls,
    }


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

### backend/pipeline.py — MODIFY

```python
"""Z-Image pipeline wrapper — lazy loading, MPS optimizations, progress callback.

Supports single-pass (txt2img, img2img) and composite (multi-region) generation.
"""

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
        # ... (unchanged from original)
        ...

    # ── image-to-image support ──────────────────────────────────────────

    def load_img2img(self, progress_callback: Callable[[str], None] | None = None) -> None:
        # ... (unchanged from original)
        ...

    # ── single-pass generation ──────────────────────────────────────────

    def generate(self, ...) -> bytes:
        # ... (unchanged from original)
        ...

    def generate_img2img(self, ...) -> bytes:
        # ... (unchanged from original)
        ...

    # ── composite generation ────────────────────────────────────────────

    def generate_composite(
        self,
        regions: list[dict],
        canvas_width: int,
        canvas_height: int,
        *,
        step_callback: Callable[[int, int, int, str, str | None], None] | None = None,
    ) -> bytes:
        """Run N sequential per-region diffusion passes and composite.

        ``step_callback`` receives ``(region_index, step, total, region_id, image_b64)``
        where ``region_index`` is the 0-based index into the sorted regions list,
        ``step`` is 1-indexed, and ``image_b64`` is a base64 JPEG preview or None.

        Returns raw PNG bytes of the composited output.
        """
        if self._pipeline is None:
            raise RuntimeError("Pipeline not loaded. Call load() first.")

        from PIL import Image as PILImage
        import io
        import base64

        decode_interval = settings.preview_decode_interval
        preview_size = settings.preview_size

        # Create blank RGBA canvas
        canvas_image = PILImage.new(
            "RGBA", (canvas_width, canvas_height), (0, 0, 0, 0)
        )

        # Sort regions by z-index (ascending = bottom first)
        sorted_regions = sorted(regions, key=lambda r: r.get("region_z_index", 0))

        # Collect per-region images for saving
        self._region_pngs: list[tuple[str, bytes]] = []

        for ri, region in enumerate(sorted_regions):
            prompt = region.get("prompt", "")
            steps = region.get("steps", 50)
            cfg_scale = region.get("cfg_scale", 5.0)
            seed = region.get("seed", None)
            rw = region.get("region_width", 256)
            rh = region.get("region_height", 256)
            region_id = region.get("region_id", f"region_{ri}")

            # Create per-region generator for seed isolation
            generator = None
            if seed is not None:
                generator = torch.Generator(
                    device=settings.device
                ).manual_seed(seed)

            total = steps

            def _make_on_step(ri_idx: int, region_id_str: str):
                """Factory to capture per-region closure variables."""
                def _on_step(
                    pipe: object, step: int, timestep: int, callback_kwargs: dict
                ) -> dict:
                    image_b64: str | None = None

                    if step_callback and decode_interval > 0:
                        should_decode = (step == 0) or (
                            (step + 1) % decode_interval == 0
                        )
                        if should_decode:
                            try:
                                latents = callback_kwargs["latents"]

                                with torch.no_grad():
                                    latents_for_vae = latents.to(pipe.vae.dtype)
                                    latents_for_vae = (
                                        latents_for_vae
                                        / pipe.vae.config.scaling_factor
                                    ) + pipe.vae.config.shift_factor

                                    image_tensor = pipe.vae.decode(
                                        latents_for_vae, return_dict=False
                                    )[0]

                                    pil_images = pipe.image_processor.postprocess(
                                        image_tensor, output_type="pil"
                                    )
                                    preview_image = pil_images[0]

                                    if preview_size:
                                        preview_image = preview_image.resize(
                                            (preview_size, preview_size),
                                            PILImage.LANCZOS,
                                        )

                                    buf = io.BytesIO()
                                    preview_image.save(
                                        buf, format="JPEG", quality=60
                                    )
                                    image_b64 = base64.b64encode(
                                        buf.getvalue()
                                    ).decode("ascii")
                            except Exception:
                                logger.warning(
                                    "Region VAE decode failed", exc_info=True
                                )
                                image_b64 = None

                    if step_callback:
                        step_callback(
                            ri_idx, step, total, region_id_str, image_b64
                        )
                    return callback_kwargs
                return _on_step

            result = self._pipeline(
                prompt=prompt,
                num_inference_steps=steps,
                guidance_scale=cfg_scale,
                generator=generator,
                width=rw,
                height=rh,
                output_type="pil",
                callback_on_step_end=_make_on_step(ri, region_id),
                callback_on_step_end_tensor_inputs=["latents"],
            )

            region_pil = result.images[0]

            # Convert to RGBA for alpha compositing
            if region_pil.mode != "RGBA":
                region_pil = region_pil.convert("RGBA")

            # Paste onto canvas at region position (alpha compositing)
            rx = region.get("region_x", 0)
            ry = region.get("region_y", 0)
            canvas_image.paste(region_pil, (rx, ry), region_pil)

            # Save per-region PNG bytes
            region_buf = io.BytesIO()
            region_pil.save(region_buf, format="PNG")
            self._region_pngs.append((region_id, region_buf.getvalue()))

        # Save final composite
        composite_buf = io.BytesIO()
        composite_result = canvas_image.convert("RGB")
        composite_result.save(composite_buf, format="PNG")
        return composite_buf.getvalue()

    def get_region_images(self) -> list[tuple[str, bytes]]:
        """Return per-region PNG bytes from the last composite generation."""
        return getattr(self, "_region_pngs", [])


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

### backend/routes/generate.py — MODIFY

```python
"""POST /api/generate — SSE streaming endpoint for image generation.

Supports three modes detected from the request body:
- Standard txt2img (default)
- Image-to-image (is_img2img: true)
- Composite multi-region (is_composite: true or params mode == composite)
"""

import asyncio
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import AsyncIterable

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.pipeline import PipelineWrapper
from backend.utils.storage import save_composite_images, save_image
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
    canvas_width: int | None = None
    canvas_height: int | None = None


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
    pipeline: PipelineWrapper | None = request.app.state.model_pipeline
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
        )
    else:
        prompt = params.get("prompt", "")
        steps = params.get("steps", 50)
        cfg_scale = params.get("cfg_scale", 5.0)
        seed = params.get("seed", None)
        width = params.get("width", 1024)
        height = params.get("height", 1024)

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

    # ── 5. Return SSE stream ───────────────────────────────────────────
    return StreamingResponse(
        _sse_generator(request, progress_queue, cancel_event),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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
    """Run composite generation, pushing per-region SSE events."""
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

    total_steps = sum(r.get("steps", 50) for r in regions)
    _push({"event": "progress", "status": "generating", "step": 0, "total": total_steps})

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

    region_pngs = pipeline.get_region_images()

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


# ── existing runners: _run_text_to_image, _run_img2img ──── (unchanged)
# ── SSE response helpers: _sse_generator, _error_stream ── (unchanged)
```

## Slices

### Slice 1: Types & Data Foundation

**Files**: `frontend/src/types/workflow.ts`, `frontend/src/store/useUIStore.ts`, `frontend/src/store/useWorkflowStore.ts`, `frontend/src/utils/jsonExport.ts`

#### Automated Verification:
- [ ] TypeScript compilation passes: `npm run check` (from frontend/)

#### Manual Verification:
- [ ] New `zRegion` and `zComposition` types appear in the `KorgNodeType` union
- [ ] Geometry fields (`regionX`, `regionY`, `regionWidth`, `regionHeight`, `regionZIndex`) are present on `KorgNodeData`
- [ ] Canvas dimension fields (`canvasWidth`, `canvasHeight`) are present on `KorgNodeData`
- [ ] `regionId?` and `region_images?` fields added to SSE event types
- [ ] `HandleDef` has new `sourceNodeId?: string` field
- [ ] `useUIStore` has `drawMode`, `drawingRect`, `drawingNodeId`, and setter methods
- [ ] `createNode()` returns nodes with correct defaults for both new types
- [ ] `NODE_DATA_DEFAULTS` in `jsonExport.ts` matches store defaults

### Slice 2: Region Node Component

**Files**: `frontend/src/components/nodes/RegionNode.tsx`, `frontend/src/components/Canvas.tsx`, `frontend/src/components/Toolbar.tsx`

#### Automated Verification:
- [ ] TypeScript compilation passes: `npm run check`

#### Manual Verification:
- [ ] RegionNode renders with "Draw Region" button, geometry fields (x, y, w, h, z), steps/CFG/seed params
- [ ] Clicking "Draw Region" enters draw mode — cursor changes to crosshair, panOnDrag disabled
- [ ] Click-drag on canvas draws a live rectangle (SVG overlay) that follows the mouse (reactive via hook subscription)
- [ ] On mouse-up, the rectangle position is saved to node data and the SVG overlay updates
- [ ] Existing nodes still render and interact correctly alongside RegionNode
- [ ] Toolbar "Add node" dropdown includes "Region" and "Composition"

### Slice 3: Composition Node Component

**Files**: `frontend/src/components/nodes/CompositionNode.tsx`, `frontend/src/store/useWorkflowStore.ts`, `frontend/src/components/Canvas.tsx`, `frontend/src/utils/integration.ts`

#### Automated Verification:
- [ ] TypeScript compilation passes: `npm run check`

#### Manual Verification:
- [ ] CompositionNode renders with canvas width/height fields and a Generate button
- [ ] Connecting a RegionNode's output to CompositionNode's input creates a new dynamic handle on the composition node
- [ ] Disconnecting removes the handle (pruned from `data.inputs` by `onEdgesChange`)
- [ ] Handles are well-positioned and don't overlap (distributed evenly via CSS `top`)
- [ ] CompositionNode's `data.inputs` array reflects current connected regions
- [ ] Generate button is disabled when no regions connected; shows error placeholder before Slice 4

### Slice 4: Generate Orchestration

**Files**: `frontend/src/utils/integration.ts`, `frontend/src/types/workflow.ts`

#### Automated Verification:
- [ ] TypeScript compilation passes: `npm run check`

#### Manual Verification:
- [ ] Clicking "Generate" on CompositionNode detects composite mode and dispatches body with `is_composite: true`, `canvas_width`, `canvas_height`
- [ ] SSE `progress` events with `regionId` are correctly parsed and forwarded
- [ ] Per-region intermediate previews (VAE decode) are forwarded to connected ImageOutput nodes
- [ ] Final `done` event with composite `image_url` and `region_images` array is handled
- [ ] Non-composite workflows (ZImageGenerate) still generate correctly (regression)
- [ ] The integration.ts `params` type cast is loosened to `Record<string, unknown>` to support both standard and composite param shapes

### Slice 5: Backend Validation & Storage

**Files**: `backend/utils/validation.py`, `backend/utils/storage.py`

#### Automated Verification:
- [ ] Backend starts without import errors: `python -c "from backend.utils.validation import validate_workflow, extract_parameters; from backend.utils.storage import save_composite_images"`
- [ ] Linter passes: `ruff check backend/utils/`

#### Manual Verification:
- [ ] `validate_workflow()` accepts a workflow with `zComposition` + N `zRegion` nodes; still accepts `zImageGenerate` workflows
- [ ] Composite validation catches: missing region geometry (0 or negative), region exceeding canvas bounds, no regions connected
- [ ] `extract_parameters()` with composite workflow returns `{"mode": "composite", "regions": [...], "canvas_width": ..., "canvas_height": ...}` with regions sorted by z-index
- [ ] `extract_parameters()` with non-composite workflow returns the original flat structure (backward-compatible)
- [ ] `save_composite_images()` creates `{timestamp}_{seed}_region_{regionId}.png` and `{timestamp}_{seed}_composite.png`
- [ ] Sidecar `.json` files have `region_id` field where applicable

### Slice 6: Backend Pipeline Compositing

**Files**: `backend/pipeline.py`, `backend/routes/generate.py`

#### Automated Verification:
- [ ] Backend starts without import errors: `python -c "from backend.routes.generate import router"`
- [ ] Linter passes: `ruff check backend/`

#### Manual Verification:
- [ ] `PipelineWrapper.generate_composite()` runs N sequential diffusion passes, each at its own resolution
- [ ] Regions are composited onto a transparent RGBA canvas of `canvas_width` × `canvas_height` at correct (x, y) positions via PIL Image.paste() with alpha channel
- [ ] Z-order is respected: regions sorted by `region_z_index` ascending (bottom = first)
- [ ] Alpha compositing works — overlapping regions show correct layering via RGBA paste
- [ ] Per-region VAE decode previews use the same `preview_decode_interval` / `preview_size` config
- [ ] Per-region SSE progress events carry `regionId` field identifying which region is generating
- [ ] Final SSE `done` event includes both `image_url` (composite) and `region_images` array with per-region URLs
- [ ] Non-composite generation routes (txt2img, img2img) work unchanged (regression)
- [ ] Cancellation (AbortController in frontend) correctly stops region processing via shared `cancel_event`

## Desired End State

```typescript
// A composite workflow JSON:
const workflow = {
  nodes: [
    { id: "textPrompt_1", type: "textPrompt", data: { prompt: "woman in center" } },
    { id: "textPrompt_2", type: "textPrompt", data: { prompt: "sun in corner" } },
    { id: "zRegion_1", type: "zRegion", data: {
      regionX: 200, regionY: 100, regionWidth: 512, regionHeight: 512, regionZIndex: 0,
      steps: 50, cfgScale: 5.0, seed: null, width: 512, height: 512,
      inputs: [{ name: "prompt", type: "prompt", required: true }],
      outputs: [{ name: "image", type: "image" }],
    }},
    { id: "zRegion_2", type: "zRegion", data: {
      regionX: 800, regionY: 50, regionWidth: 200, regionHeight: 200, regionZIndex: 1,
      steps: 30, cfgScale: 4.0, seed: 123, width: 200, height: 200,
      inputs: [{ name: "prompt", type: "prompt", required: true }],
      outputs: [{ name: "image", type: "image" }],
    }},
    { id: "zComposition_1", type: "zComposition", data: {
      canvasWidth: 1024, canvasHeight: 1024,
      inputs: [],  // populated by connections
      outputs: [{ name: "image", type: "image" }],
    }},
    { id: "imageOutput_1", type: "imageOutput", data: {} },
  ],
  edges: [
    // Prompt connections
    { source: "textPrompt_1", target: "zRegion_1", sourceHandle: "prompt", targetHandle: "prompt" },
    { source: "textPrompt_2", target: "zRegion_2", sourceHandle: "prompt", targetHandle: "prompt" },
    // Region → Composition connections
    { source: "zRegion_1", target: "zComposition_1", sourceHandle: "image", targetHandle: "input_0" },
    { source: "zRegion_2", target: "zComposition_1", sourceHandle: "image", targetHandle: "input_1" },
    // Composite output
    { source: "zComposition_1", target: "imageOutput_1", sourceHandle: "image", targetHandle: "image" },
  ],
};
```

```python
# Backend composite request shape (extract_parameters returns):
composite_params = {
    "mode": "composite",
    "canvas_width": 1024,
    "canvas_height": 1024,
    "regions": [
        {
            "region_id": "zRegion_1",
            "prompt": "woman in center",
            "steps": 50,
            "cfg_scale": 5.0,
            "seed": None,
            "region_x": 200,
            "region_y": 100,
            "region_width": 512,
            "region_height": 512,
            "region_z_index": 0,
        },
        {
            "region_id": "zRegion_2",
            "prompt": "sun in corner",
            "steps": 30,
            "cfg_scale": 4.0,
            "seed": 123,
            "region_x": 800,
            "region_y": 50,
            "region_width": 200,
            "region_height": 200,
            "region_z_index": 1,
        },
    ],
}
```

```python
# Composite SSE events (order of emission):
# event: progress | data: {"status": "generating", "regionId": "zRegion_1", "step": 1, "total": 50, "image_b64": "..."}
# event: progress | data: {"status": "generating", "regionId": "zRegion_1", "step": 2, "total": 50, ...}
# ... (all steps for region 1)
# event: progress | data: {"status": "generating", "regionId": "zRegion_2", "step": 1, "total": 30, ...}
# ... (all steps for region 2)
# event: done | data: {"status": "complete", "image_url": "/images/..._composite.png", "seed": 42, "region_images": [{"regionId": "zRegion_1", "image_url": "/images/..._region_zRegion_1.png", "seed": 42}, ...]}
```

## File Map

- `frontend/src/types/workflow.ts`      # MODIFY — add types for region, composition, SSE extensions
- `frontend/src/store/useUIStore.ts`    # NEW — transient draw state store
- `frontend/src/store/useWorkflowStore.ts`  # MODIFY — add defaults, extend onConnect
- `frontend/src/utils/jsonExport.ts`    # MODIFY — add defaults for zRegion, zComposition
- `frontend/src/components/nodes/RegionNode.tsx`  # NEW — region node component
- `frontend/src/components/Canvas.tsx`   # MODIFY — register nodes, draw mode, SVG overlay
- `frontend/src/components/Toolbar.tsx`  # MODIFY — add region + composition to dropdown
- `frontend/src/components/nodes/CompositionNode.tsx`  # NEW — composition node component
- `frontend/src/utils/integration.ts`    # MODIFY — composite detection, SSE routing
- `backend/utils/validation.py`          # MODIFY — composite validation + parameter extraction
- `backend/utils/storage.py`             # MODIFY — save_composite_images
- `backend/pipeline.py`                  # MODIFY — generate_composite
- `backend/routes/generate.py`           # MODIFY — composite route dispatch

## Ordering Constraints

- **Slice 1 must complete** before any other slice (foundation types)
- **Slices 2 and 3** can be generated in any order (both depend on Slice 1 only)
- **Slice 4** depends on Slices 2 + 3 (wires frontend together)
- **Slices 5 and 6** depend on each other (validation → pipeline) and are independent of frontend slices
- Backend slices (5, 6) and frontend slices (1-4) have no cross-dependency — they can be developed in parallel

## Verification Notes

- Coverage of existing `zImageGenerate` workflows must be preserved (regression). Check both txt2img and img2img generation with the existing 4-node template after composite changes.
- The backend `extract_parameters()` branching logic is the highest-risk change — any bug here breaks all generation. Ensure the non-composite path produces the exact same output as before.
- Dynamic handle rendering on the Composition node: if `useUpdateNodeInternals()` isn't called after `data.inputs` changes, handles will render at the wrong positions or not at all.
- PIL `Image.new("RGBA")` is used for the canvas — ensure all region images are converted to RGBA before paste for proper alpha compositing.
- SSE keepalive comments (`: keepalive\n\n`) continue to work during long composite generations (multiple regions × steps).
- Sequential diffusion for `N` regions takes `N × steps` inference steps total — the SSE stream stays open for the entire duration.

## Performance Considerations

- Sequential per-region diffusion: total time = sum(N region times). On MPS with 1024×1024 canvas and four 512×512 regions at 50 steps each: ~4× the single-pass time.
- Memory: only one region's latents in GPU at a time. Peak memory same as single-pass generation.
- VAE decode previews: `preview_decode_interval` and `preview_size` apply per-region independently. 128px JPEG at quality 60 is ~3-8KB per preview.
- 20 regions × 50 steps × decode every 10th step = 100 intermediate decode events. At ~5KB each = 500KB of SSE data. Acceptable.

## Migration Notes

No existing schema changes — this feature is additive. Existing saved workflows (JSON) don't reference `zRegion` or `zComposition` types, so `importWorkflow()` with `NODE_DATA_DEFAULTS` will simply not find matching defaults for the old nodes. Existing workflows load and render unchanged.

## Pattern References

- `frontend/src/components/nodes/TextPromptNode.tsx:1-35` — Node component template (BEM classes, useWorkflowStore, NodeProps<KorgNode>)
- `frontend/src/components/nodes/ZImageGenerateNode.tsx:32-37` — Generate button + CustomEvent dispatch pattern
- `frontend/src/store/useWorkflowStore.ts:28-50` — createNode() defaults pattern for new node types
- `frontend/src/store/useWorkflowStore.ts:146-148` — onConnect handler (extend for composition)
- `frontend/src/components/Canvas.tsx:10-17` — Static nodeTypes map pattern
- `frontend/src/utils/integration.ts:56-98` — CustomEvent handling, ref-based stable closures
- `backend/pipeline.py:121-215` — generate() method structure (callback_on_step_end, VAE decode)
- `backend/pipeline.py:135-175` — _on_step closure — reusable for per-region VAE decode
- `backend/routes/generate.py:125-196` — _run_text_to_image: three-phase background runner pattern
- `backend/routes/generate.py:40-108` — Route: validate → extract → exec → stream pattern

## Developer Context

**Checkpoint Q1 (Directional — follow existing patterns):** "Follow all" confirmed.
- Follow HandleDef for handles, inline styles, BEM class naming, CustomEvent communication, sequential thread pool runners.

**Checkpoint Q2 (Draw state location):** "Separate useUIStore" confirmed.
- Use `create<UIStore>` with `drawMode`, `drawingRect`, `setDrawMode`, `setDrawingRect`.

**Checkpoint Q3 (Handle re-measurement):** "useEffect in node" confirmed.
- CompositionNode watches `data.inputs.length` in useEffect, calls `useUpdateNodeInternals(id)`.

**Checkpoint Q4 (Composite detection — frontend dispatch):** "Implicit detection" confirmed.
- Integration hook checks for zComposition node presence, constructs composite body.

**Checkpoint Q5 (Composite detection — backend param shape):** "Implicit via params shape" confirmed.
- `extract_parameters()` returns `regions` key for composite mode; route checks `if "regions" in params`.

## Design History

- Slice 1: Types & Data Foundation — approved as generated
- Slice 2: Region Node Component — approved as generated (revised: SVG overlay reactivity fix)
- Slice 3: Composition Node Component — approved as generated (revised: onEdgesChange pruning, integration.ts composite guard)
- Slice 4: Generate Orchestration — approved as generated
- Slice 5: Backend Validation & Storage — approved as generated
- Slice 6: Backend Pipeline Compositing — approved as generated

## References

- Research artifact: `.rpiv/artifacts/research/2026-06-14_04-58-10_composable-area-region-node.md`
- Original v1 design: `.rpiv/artifacts/designs/2026-06-13_07-55-56_simplified-comfyui-image-gen.md`
- @xyflow/react dynamic handles: TypeScript definition at `node_modules/@xyflow/react/dist/esm/hooks/useUpdateNodeInternals.d.ts:13-43`
- Z-Image diffusers pipeline: `Tongyi-MAI/Z-Image` on HuggingFace
