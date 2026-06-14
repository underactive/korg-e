---
date: 2026-06-13T23:25:22-07:00
author: Eric Sison
commit: no-commit
branch: detached
repository: korg-e
topic: "Composable Area/Region Node for Image Composition"
tags: [plan, region-node, image-composition, react-flow, diffusers, pipeline-compositing]
status: ready
parent: .rpiv/artifacts/designs/2026-06-14_05-08-50_composable-area-region-node.md
phase_count: 6
phases:
  - { n: 1, title: "Types & Data Foundation" }
  - { n: 2, title: "Region Node Component" }
  - { n: 3, title: "Composition Node Component" }
  - { n: 4, title: "Generate Orchestration" }
  - { n: 5, title: "Backend Validation & Storage" }
  - { n: 6, title: "Backend Pipeline Compositing" }
last_updated: 2026-06-13T23:30:00-07:00
last_updated_by: Eric Sison
last_updated_note: "Step 5 triage complete — 6 reviewer findings resolved (2 applied, 1 applied, 3 applied)"
---

# Composable Area/Region Node for Image Composition — Implementation Plan

## Overview

Add two new node types to the korg-e node graph — **zRegion** (a rectangular area with its own prompt and generation parameters) and **zComposition** (composites all region outputs onto a final canvas) — enabling multi-region image composition. Region nodes define geometry in `KorgNodeData` fields, click-drag drawing on the canvas via SVG overlay with `panOnDrag` toggle, sequential per-region diffusion passes in a new `PipelineWrapper.generate_composite()` method composited with PIL `Image.paste()`, and per-region SSE progress via `regionId`-tagged events. Implicit composite detection: the integration hook checks for a `zComposition` node and dispatches a composite request; the backend branches on whether `extract_parameters()` returns a `regions` list.

Design artifact: `.rpiv/artifacts/designs/2026-06-14_05-08-50_composable-area-region-node.md`

## Desired End State

A composite workflow consisting of:
- `zRegion` nodes defining rectangular areas with per-region prompts, steps, CFG, seed
- `zComposition` node with dynamic input handles (one per connected region), canvas dimensions, and a Generate button
- Draw-mode interaction: click-drag on canvas to place region rectangles
- Backend runs N sequential diffusion passes (one per region) reusing the loaded pipeline
- PIL compositing: each region generated at its own resolution, pasted onto a transparent RGBA canvas
- Per-region SSE progress with `regionId`-tagged events and intermediate VAE decode previews
- Per-region + composite images saved to disk with extended sidecar metadata
- Implicit composite detection (no `mode` field needed in request body)
- Existing single-pass txt2img/img2img workflows continue to work unchanged

## What We're NOT Doing

- Per-region img2img (each region with its own init image) — deferred to follow-up
- Live canvas preview showing region layout before generation
- Reordering regions via click interaction — array order suffices for v1
- Region overlap visualization beyond z-order compositing
- Parallel region generation (impractical on MPS memory)
- Tool-level draw mode toggle — draw mode toggled per-region from the node itself

---

## Phase 1: Types & Data Foundation

### Overview
Add TypeScript types for the two new node types (`zRegion`, `zComposition`), extend `HandleDef` with `sourceNodeId`, add SSE event type extensions (`regionId`, `region_images`), create the transient `useUIStore` for draw state, and add default node data in `createNode()` and `NODE_DATA_DEFAULTS`.

### Changes Required:

#### 1. Type definitions
**File**: `frontend/src/types/workflow.ts`
**Changes**: Add geometry fields to `KorgNodeData`, add `sourceNodeId` to `HandleDef`, extend SSE types with `regionId` and `region_images`, add `zRegion` and `zComposition` to `KorgNodeType`.

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

#### 2. New UI store
**File**: `frontend/src/store/useUIStore.ts` (VERIFY) — file already exists at HEAD with identical content; verify matches plan code block
**Changes**: Create `useUIStore` with `drawMode`, `drawingRect`, `drawingNodeId` and setter methods.

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

#### 3. Store defaults
**File**: `frontend/src/store/useWorkflowStore.ts`
**Changes**: Add `zRegion` and `zComposition` defaults inside `createNode()`.

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

#### 4. Export defaults
**File**: `frontend/src/utils/jsonExport.ts`
**Changes**: Add matching `zRegion` and `zComposition` defaults to `NODE_DATA_DEFAULTS`.

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

### Success Criteria:

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
- [ ] Load an existing non-composite workflow JSON (from before this feature) and confirm all four original node types render without errors in the canvas

---

## Phase 2: Region Node Component

### Overview
Create the `RegionNode` component with draw-mode toggle, geometry fields, and generation parameters. Add SVG overlay drawing interaction to the Canvas for click-drag region placement. Register the new node type in the Toolbar and Canvas nodeTypes map.

### Changes Required:

#### 1. Region node component
**File**: `frontend/src/components/nodes/RegionNode.tsx` (VERIFY) — file already exists at HEAD with identical content; verify matches plan code block
**Changes**: Full node component with "Draw Region" button, geometry inputs (X, Y, W, H, Z), steps/CFG/seed params, status display, input/output handles.

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

#### 2. Canvas — node registration + draw mode
**File**: `frontend/src/components/Canvas.tsx`
**Changes**: Register `zRegion` in `nodeTypes`, add `zRegion` import, implement `handleMouseDown`/`handleMouseMove`/`handleMouseUp` draw mode handlers, add SVG overlay for live drawing rect and saved region rects, set `panOnDrag` and `nodesDraggable` based on `drawMode`.

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

#### 3. Toolbar registration
**File**: `frontend/src/components/Toolbar.tsx`
**Changes**: Add `{ type: "zRegion", label: "Region" }` to the dropdown options.

```typescript
// Inside NODE_TYPES array, added after zImageGenerate:
  { type: "zRegion", label: "Region" },
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes: `npm run check`

#### Manual Verification:
- [ ] RegionNode renders with "Draw Region" button, geometry fields (x, y, w, h, z), steps/CFG/seed params
- [ ] Clicking "Draw Region" enters draw mode — cursor changes to crosshair, panOnDrag disabled
- [ ] Click-drag on canvas draws a live rectangle (SVG overlay) that follows the mouse (reactive via hook subscription)
- [ ] On mouse-up, the rectangle position is saved to node data and the SVG overlay updates
- [ ] Existing nodes still render and interact correctly alongside RegionNode
- [ ] Toolbar "Add node" dropdown includes "Region"

---

## Phase 3: Composition Node Component

### Overview
Create the `CompositionNode` component with dynamic input handles, canvas dimension controls, Generate button, and connected-region list display. Wire up dynamic handle re-measurement via `useUpdateNodeInternals`.

### Changes Required:

#### 1. Composition node component
**File**: `frontend/src/components/nodes/CompositionNode.tsx` (MODIFY) — add syntax fix: replace stray `"` with backtick on line 130 in template literal "Generate (${connectedRegions.length} regions)"
**Changes**: Full node component with canvas width/height inputs, dynamic input handles via `useEffect` + `useUpdateNodeInternals`, connected-region listing, Generate button, error display.

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

#### 2. Canvas registration
**File**: `frontend/src/components/Canvas.tsx`
**Changes**: Register `zComposition` in `nodeTypes`, add import.

```typescript
// Add import:
import CompositionNode from "@/components/nodes/CompositionNode";

// Add to nodeTypes map:
  zComposition: CompositionNode,
```

#### 3. Toolbar registration
**File**: `frontend/src/components/Toolbar.tsx`
**Changes**: Add `{ type: "zComposition", label: "Composition" }` to the dropdown options.

```typescript
// Inside NODE_TYPES array, added after zRegion:
  { type: "zComposition", label: "Composition" },
```

#### 4. Store — onConnect extension
**File**: `frontend/src/store/useWorkflowStore.ts`
**Changes**: Extend `onConnect` handler to update composition node's `data.inputs` when a region connects or disconnects.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes: `npm run check`

#### Manual Verification:
- [ ] CompositionNode renders with canvas width/height fields and a Generate button
- [ ] Connecting a RegionNode's output to CompositionNode's input creates a new dynamic handle on the composition node
- [ ] Disconnecting removes the handle (pruned from `data.inputs` by `onEdgesChange`)
- [ ] Handles are well-positioned and don't overlap (distributed evenly via CSS `top`)
- [ ] CompositionNode's `data.inputs` array reflects current connected regions
- [ ] Generate button is disabled when no regions connected; shows error placeholder before Phase 4
- [ ] Toolbar "Add node" dropdown includes "Composition"

---

## Phase 4: Generate Orchestration

### Overview
Wire up composite dispatch in `integration.ts` — detect composite mode when Generate is clicked on a CompositionNode, construct the composite request body with `is_composite: true`, forward per-region SSE events with `regionId`, handle per-region intermediate previews, and handle final `done` event with composite `image_url` and `region_images`.

### Changes Required:

#### 1. Integration hook — composite dispatch
**File**: `frontend/src/utils/integration.ts`

**Note**: Remove `params` destructuring from the CustomEvent detail — it was dead code (never read in either composite or standard dispatch paths). The event contract now carries only `nodeId`.
**Changes**: Add composite detection branch in `handleGenerate`, construct composite body with `is_composite`, `canvas_width`, `canvas_height`, forward per-region SSE progress with `regionId`, handle `done` event with `region_images` array, maintain backward compatibility with standard workflows.

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
      const { nodeId } = (e as CustomEvent).detail as {
        nodeId: string;
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

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes: `npm run check`

#### Manual Verification:
- [ ] Clicking "Generate" on CompositionNode detects composite mode and dispatches body with `is_composite: true`, `canvas_width`, `canvas_height`
- [ ] SSE `progress` events with `regionId` are correctly parsed and forwarded
- [ ] Per-region intermediate previews (VAE decode) are forwarded to connected ImageOutput nodes
- [ ] Final `done` event with composite `image_url` and `region_images` array is handled
- [ ] Non-composite workflows (ZImageGenerate) still generate correctly (regression)
- [ ] The integration.ts `params` type cast is loosened to `Record<string, unknown>` to support both standard and composite param shapes

---

## Phase 5: Backend Validation & Storage

### Overview
Add composite workflow validation to `validate_workflow()` and composite parameter extraction to `extract_parameters()`. Add `save_composite_images()` to `storage.py` for persisting per-region + composite PNGs with extended sidecar metadata.

### Changes Required:

#### 1. Composite validation + parameter extraction
**File**: `backend/utils/validation.py`
**Changes**: Add composite validation (region geometry bounds, canvas containment, at least one region connected), add `_extract_composite_params()` helper, branch `extract_parameters()` on composite detection, add `mode: "composite"` return with `regions` list and `canvas_width`/`canvas_height`.

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

#### 2. Composite image storage
**File**: `backend/utils/storage.py`
**Changes**: Add `save_composite_images()` function that saves per-region PNGs (`{ts}_{seed}_region_{id}.png`) and composite PNG (`{ts}_{seed}_composite.png`) with extended sidecar metadata including `region_id`, `region_x`, `region_y`, `region_width`, `region_height`.

```python
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
```

### Success Criteria:

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

---

## Phase 6: Backend Pipeline Compositing

### Overview
Add `PipelineWrapper.generate_composite()` method that runs N sequential per-region diffusion passes with per-region VAE decode previews, PIL Image.paste() compositing with z-ordering and alpha compositing. Add composite route dispatch in `generate.py` with per-region SSE progress events tagged by `regionId`, per-region image persistence, and final composite output.

### Changes Required:

#### 1. Pipeline composite method
**File**: `backend/pipeline.py`
**Changes**: Add `generate_composite()` method with sequential per-region diffusion, per-region `_on_step` closure with VAE decode, PIL RGBA canvas compositing with alpha paste, per-region image collection for persistence. Add `get_region_images()` accessor.

```python
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
```

#### 2. Composite route runner
**File**: `backend/routes/generate.py`
**Changes**: Add composite detection branch after validation, `_run_composite()` background runner with per-region SSE progress via `step_callback` with `regionId`, `step`, `total`, `image_b64`. Wire per-region save via `save_composite_images()`. Maintain backward compatibility with txt2img and img2img routes.

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
```

### Success Criteria:

#### Automated Verification:
- [ ] Backend starts without import errors: `python -c "from backend.routes.generate import router"`
- [ ] Linter passes: `ruff check backend/`

#### Manual Verification:
- [ ] `PipelineWrapper.generate_composite()` runs N sequential diffusion passes, each at its own resolution
- [ ] Verify that SSE keepalive comments (`: keepalive`) are emitted at least once during a multi-region composite generation (e.g., 2+ regions with 50+ steps each)
- [ ] Regions are composited onto a transparent RGBA canvas of `canvas_width` × `canvas_height` at correct (x, y) positions via PIL Image.paste() with alpha channel
- [ ] Z-order is respected: regions sorted by `region_z_index` ascending (bottom = first)
- [ ] Alpha compositing works — overlapping regions show correct layering via RGBA paste
- [ ] Per-region VAE decode previews use the same `preview_decode_interval` / `preview_size` config
- [ ] Per-region SSE progress events carry `regionId` field identifying which region is generating
- [ ] Final SSE `done` event includes both `image_url` (composite) and `region_images` array with per-region URLs
- [ ] Non-composite generation routes (txt2img, img2img) work unchanged (regression)
- [ ] Cancellation (AbortController in frontend) correctly stops region processing via shared `cancel_event`

---

## Testing Strategy

### Automated:
- `npm run check` (TypeScript compilation) in `frontend/` after each frontend phase
- `ruff check backend/` after each backend phase
- Python import smoke tests after each backend phase

### Manual Testing Steps:
1. Create a workflow: TextPrompt → zRegion → zComposition → ImageOutput, add a second TextPrompt → second zRegion → same zComposition
2. Draw region rectangles on canvas via "Draw Region" button on each region node
3. Fine-tune geometry/adjust z-order in the region node's numeric inputs
4. Click Generate on the Composition node — verify SSE progress events show per-region `regionId`
5. Verify output shows composited image with both regions at correct positions
6. Verify per-region PNG files exist in the output directory alongside the composite
7. Verify existing single-pass txt2img workflow still works
8. Verify existing img2img workflow still works

## Performance Considerations

From design artifact:
- Sequential per-region diffusion: total time = sum(N region times). On MPS with 1024×1024 canvas and four 512×512 regions at 50 steps each: ~4× the single-pass time.
- Memory: only one region's latents in GPU at a time. Peak memory same as single-pass generation.
- VAE decode previews: `preview_decode_interval` and `preview_size` apply per-region independently. 128px JPEG at quality 60 is ~3-8KB per preview.
- 20 regions × 50 steps × decode every 10th step = 100 intermediate decode events. At ~5KB each = 500KB of SSE data. Acceptable.

## Migration Notes

No existing schema changes — this feature is additive. Existing saved workflows (JSON) don't reference `zRegion` or `zComposition` types, so `importWorkflow()` with `NODE_DATA_DEFAULTS` will simply not find matching defaults for the old nodes. Existing workflows load and render unchanged.

## Parallelism

Per design's Ordering Constraints:
- **Phase 2 and Phase 3** can be implemented in any order (both depend on Phase 1 only)
- **Phase 4** depends on Phases 2 + 3
- **Phase 5 and Phase 6** depend on each other and are independent of frontend phases — they can be developed in parallel with Phases 2-4
- Backend phases (5, 6) and frontend phases (1-4) have no cross-dependency

## Plan Review (Step 4)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 5._

| source   | plan-loc                                   | codebase-loc                | severity   | dimension             | finding                                                                                                                                                                            | recommendation                                                                                                                                                                                                  | resolution         |
| -------- | ------------------------------------------ | --------------------------- | ---------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| code     | Phase 3 §1 (CompositionNode.tsx)           | `<n/a>`                     | blocker    | actionability         | Plan marks CompositionNode.tsx as (NEW) but the file already exists at HEAD with a TypeScript syntax error on line 130 — template literal `` `Generate (${connectedRegions.length} regions)"}` `` has a stray `"` character before `}` instead of a closing backtick, causing `tsc --noEmit` to fail | Change Phase 3 §1 annotation from (NEW) to (MODIFY) and add a fix for the syntax error: replace the stray `"` with a backtick                                                                                 | applied: changed (NEW) → (MODIFY) with syntax fix note |
| coverage | ## Migration Notes                          | `<n/a>`                     | blocker    | verification-coverage | Migration note states "Existing workflows load and render unchanged" — no Success Criteria bullet tests importing an old workflow JSON through importWorkflow() and confirming all four original node types render correctly | Add a Manual Verification bullet under Phase 1: "Load an existing non-composite workflow JSON (from before this feature) and confirm all four original node types render without errors in the canvas"         | applied: added import-workflow bullet to Phase 1 Manual Verification |
| coverage | ## Verification Notes (SSE keepalive)       | `<n/a>`                     | concern    | verification-coverage | Note "SSE keepalive comments continue to work during long composite generations" — no Success Criteria bullet that verifies keepalive emission during long composite runs | Add a Manual Verification bullet under Phase 6: "Verify that SSE keepalive comments (`: keepalive`) are emitted at least once during a multi-region composite generation"                                        | applied: added keepalive bullet to Phase 6 Manual Verification |
| code     | Phase 1 §2 (useUIStore.ts)                 | `<n/a>`                     | suggestion | actionability         | Plan marks useUIStore.ts as (NEW) but the file already exists at HEAD with identical content — implementer has no way to know whether to create or verify                                                                                         | Change Phase 1 §2 annotation from (NEW) to (VERIFY) to signal the file already exists and the plan's code block is a reference                                                                                  | applied: changed (NEW) → (VERIFY) with note |
| code     | Phase 2 §1 (RegionNode.tsx)                | `<n/a>`                     | suggestion | actionability         | Plan marks RegionNode.tsx as (NEW) but the file already exists at HEAD with identical content                                                                                                                                                    | Change Phase 2 §1 annotation from (NEW) to (VERIFY) to match the existing state of the file                                                                                                                       | applied: changed (NEW) → (VERIFY) with note |
| code     | Phase 4 (integration.ts)                   | integration.ts:56-58        | suggestion | code-quality          | `params` is destructured from the CustomEvent detail but never read in either composite or standard dispatch path — all params are read from graph data                                                                                            | Remove the `params` destructuring from both the type annotation and the event detail; the event contract should only carry `nodeId`                                                                               | applied: removed params from event detail type and code block |

## Developer Context

_Step 4 review findings: 2 blockers, 1 concern, 3 suggestions. Triage at Step 5._

## References

- Design: `.rpiv/artifacts/designs/2026-06-14_05-08-50_composable-area-region-node.md`
- Research: `.rpiv/artifacts/research/2026-06-14_04-58-10_composable-area-region-node.md`
