/** Workflow JSON export/import helpers. */

import type { KorgNode, KorgNodeData, KorgNodeType, WorkflowJSON } from "@/types/workflow";
import type { Edge, Viewport } from "@xyflow/react";

// ── Per-node-type data defaults (must stay in sync with useWorkflowStore.createNode) ──

const NODE_DATA_DEFAULTS: Record<KorgNodeType, Partial<KorgNodeData>> = {
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
    strength: 0.6,
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
};

/**
 * Serialise the current workflow to a savable JSON object.
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
 * Import a saved workflow JSON and normalise node data with defaults
 * so every node always has a complete ``data`` shape.
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

  // Normalise: fill in missing data fields from per-type defaults
  const nodes: KorgNode[] = (wf.nodes as KorgNode[]).map((n) => {
    const defaults = NODE_DATA_DEFAULTS[n.type as KorgNodeType];
    if (!defaults) return n;
    return {
      ...n,
      data: { ...defaults, ...n.data } as KorgNodeData,
    };
  });

  return {
    nodes,
    edges: wf.edges as Edge[],
    viewport: wf.viewport,
  };
}
