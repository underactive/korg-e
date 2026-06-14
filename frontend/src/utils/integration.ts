/** Integration wiring — listens for CustomEvents from node components
 *  and orchestrates the full generation workflow.
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
 * - ``korg:generate`` — ZImageGenerateNode triggers generation
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
        // Build the full composite request body including region params
        const compositionData = sourceNode.data;
        const canvasWidth = compositionData.canvasWidth ?? 1024;
        const canvasHeight = compositionData.canvasHeight ?? 1024;

        // Find all region nodes connected to this composition node
        const compositionInputs = compositionData.inputs ?? [];
        const connectedSourceIds = new Set(
          compositionInputs.map((inp: { sourceNodeId?: string }) => inp.sourceNodeId).filter(Boolean)
        );

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
            const regionId = data.regionId as string | undefined;

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
                // Forward to all connected ImageOutput nodes
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
            const regionImages = data.region_images as
              | Array<{ regionId: string; image_url: string; seed: number }>
              | undefined;

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

            // Store region_images on the composition node for reference
            if (regionImages) {
              updater(nodeId, { imageUrl, seedInfo: seed });
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
