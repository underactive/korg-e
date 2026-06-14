/**
 * Zustand store — single source of truth for the workflow graph.
 *
 * Synced with React Flow via onNodesChange / onEdgesChange / onConnect.
 */

import { create } from "zustand";
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type Edge,
  type Connection,
} from "@xyflow/react";
import type { KorgNode, KorgNodeType, KorgNodeData } from "@/types/workflow";
import { exportWorkflow, importWorkflow } from "@/utils/jsonExport";

// ── Default node factory ───────────────────────────────────────────────

let _nodeCounter = 0;

function createNode(type: KorgNodeType, position: { x: number; y: number }): KorgNode {
  _nodeCounter++;
  const id = `${type}_${_nodeCounter}`;

  const defaults: Record<KorgNodeType, Partial<KorgNodeData>> = {
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

  return {
    id,
    type,
    position,
    data: { ...defaults[type] } as KorgNodeData,
  };
}

// ── Starter workflow ───────────────────────────────────────────────────

function starterWorkflow(): { nodes: KorgNode[]; edges: Edge[] } {
  const textPrompt = createNode("textPrompt", { x: 50, y: 200 });
  const generate = createNode("zImageGenerate", { x: 400, y: 200 });
  const output = createNode("imageOutput", { x: 750, y: 200 });

  const nodes = [textPrompt, generate, output];
  const edges: Edge[] = [
    {
      id: `${textPrompt.id}→${generate.id}`,
      source: textPrompt.id,
      sourceHandle: "prompt",
      target: generate.id,
      targetHandle: "prompt",
    },
    {
      id: `${generate.id}→${output.id}`,
      source: generate.id,
      sourceHandle: "image",
      target: output.id,
      targetHandle: "image",
    },
  ];

  _nodeCounter = 3;
  return { nodes, edges };
}

// ── Store type ─────────────────────────────────────────────────────────

export type WorkflowStore = {
  nodes: KorgNode[];
  edges: Edge[];
  isFirstLaunch: boolean;

  // React Flow sync callbacks
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;

  // Node CRUD
  addNode: (type: KorgNodeType) => void;
  removeNode: (id: string) => void;
  updateNodeData: (id: string, data: Partial<KorgNodeData>) => void;

  // Workflow persistence
  saveWorkflow: (name: string) => Promise<void>;
  loadWorkflow: (name: string) => Promise<void>;

  // Reset
  resetToStarter: () => void;
};

// ── Store implementation ───────────────────────────────────────────────

export const useWorkflowStore = create<WorkflowStore>((set, get) => {
  const initial = starterWorkflow();

  return {
    nodes: initial.nodes,
    edges: initial.edges,
    isFirstLaunch: true,

    // React Flow sync
    onNodesChange: (changes) => {
      set({ nodes: applyNodeChanges(changes, get().nodes) as KorgNode[] });
    },

    onEdgesChange: (changes) => {
      const { edges, nodes } = get();
      const newEdges = applyEdgeChanges(changes, edges);

      // Prune composition node inputs when their edges are removed
      const removedEdgeTargets = new Set<string>();
      for (const change of changes) {
        if (change.type === "remove") {
          const removedEdge = edges.find((e) => e.id === change.id);
          if (removedEdge) {
            const targetNode = nodes.find((n) => n.id === removedEdge.target);
            if (targetNode?.type === "zComposition") {
              removedEdgeTargets.add(removedEdge.target);
            }
          }
        }
      }

      if (removedEdgeTargets.size > 0) {
        const updatedNodes = nodes.map((n) => {
          if (!removedEdgeTargets.has(n.id)) return n;
          const connectedSources = new Set(
            newEdges
              .filter((e) => e.target === n.id)
              .map((e) => e.source)
          );
          return {
            ...n,
            data: {
              ...n.data,
              inputs: n.data.inputs.filter(
                (inp) => !inp.sourceNodeId || connectedSources.has(inp.sourceNodeId)
              ),
            },
          };
        });
        set({ edges: newEdges, nodes: updatedNodes });
      } else {
        set({ edges: newEdges });
      }
    },

    onConnect: (connection: Connection) => {
      const { nodes, edges } = get();

      // If connecting to a composition node, register a new input handle
      const targetNode = nodes.find((n) => n.id === connection.target);
      if (
        targetNode &&
        targetNode.type === "zComposition" &&
        connection.source
      ) {
        // Generate a unique handle name based on source node ID
        const handleName = connection.sourceHandle ?? `input_${targetNode.data.inputs.length}`;

        // Check if this source is already connected (deduplicate)
        const alreadyConnected = targetNode.data.inputs.some(
          (inp) => inp.sourceNodeId === connection.source
        );

        if (!alreadyConnected) {
          const updatedNodes = nodes.map((n) => {
            if (n.id === connection.target) {
              return {
                ...n,
                data: {
                  ...n.data,
                  inputs: [
                    ...n.data.inputs,
                    {
                      name: handleName,
                      type: "image",
                      sourceNodeId: connection.source,
                    },
                  ],
                },
              };
            }
            return n;
          });

          // Rewrite the connection's targetHandle to use the new handle name
          // (the fallback "drop-target" handle is replaced by the dynamic one)
          const fixedConnection = {
            ...connection,
            targetHandle: handleName,
          };

          set({ edges: addEdge(fixedConnection, edges), nodes: updatedNodes });
          return;
        }
      }

      // Default: just add the edge
      set({ edges: addEdge(connection, edges) });
    },

    // Node CRUD
    addNode: (type: KorgNodeType) => {
      const pos = { x: 100 + Math.random() * 300, y: 100 + Math.random() * 300 };
      const newNode = createNode(type, pos);
      set({ nodes: [...get().nodes, newNode] });
    },

    removeNode: (id: string) => {
      set({
        nodes: get().nodes.filter((n) => n.id !== id),
        edges: get().edges.filter((e) => e.source !== id && e.target !== id),
      });
    },

    updateNodeData: (id: string, data: Partial<KorgNodeData>) => {
      set({
        nodes: get().nodes.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, ...data } } : n
        ),
      });
    },

    // Workflow persistence
    saveWorkflow: async (name: string) => {
      const { nodes, edges } = get();
      const workflow = exportWorkflow(nodes, edges);
      await fetch("/api/workflow/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, workflow }),
      });
    },

    loadWorkflow: async (name: string) => {
      const res = await fetch(`/api/workflow/load/${encodeURIComponent(name)}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`Failed to load workflow: ${res.statusText}`);
      const { workflow } = await res.json();
      const imported = importWorkflow(workflow);
      set({ nodes: imported.nodes, edges: imported.edges });
    },

    // Reset
    resetToStarter: () => {
      const fresh = starterWorkflow();
      set({ nodes: fresh.nodes, edges: fresh.edges });
    },
  };
});
