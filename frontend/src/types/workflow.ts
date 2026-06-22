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
  batchCount?: number;
  // Batch runtime state
  batchIndex?: number;
  batchTotal?: number;
  batchImages?: Array<{ imageUrl: string; seed: number }>;
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
  // Inpainting (extends zImageGenerate)
  maskData?: string | null;       // base64 PNG of brush mask
  maskBlur?: number;              // Gaussian blur radius for mask edge (default 16)
  imageWidth?: number;            // natural width of uploaded init image
  imageHeight?: number;           // natural height of uploaded init image
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
  batchIndex?: number; // 0-based current batch image index
  batchTotal?: number; // total number of images in batch
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
  batchIndex?: number;           // which batch image just completed
  batchTotal?: number;           // total images in batch
  batchComplete?: boolean;       // true on the very last done event
};

export type SSEErrorEvent = {
  event: "error";
  status: "error";
  message?: string;
  errors?: string[];
};

export type SSEEvent = SSEProgressEvent | SSEDoneEvent | SSEErrorEvent;
