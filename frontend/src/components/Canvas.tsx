/** React Flow canvas container with node type registration, background,
 *  draw-mode interaction, and region rectangle SVG overlay. */

import { useMemo, useCallback, useEffect, useRef } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  type NodeTypes,
} from "@xyflow/react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { useUIStore } from "@/store/useUIStore";
import { useWorkflowIntegration } from "@/utils/integration";
import TextPromptNode from "@/components/nodes/TextPromptNode";
import ImageUploadNode from "@/components/nodes/ImageUploadNode";
import ZImageGenerateNode from "@/components/nodes/ZImageGenerateNode";
import ImageOutputNode from "@/components/nodes/ImageOutputNode";
import RegionNode from "@/components/nodes/RegionNode";
import CompositionNode from "@/components/nodes/CompositionNode";

const nodeTypes: NodeTypes = {
  textPrompt: TextPromptNode,
  imageUpload: ImageUploadNode,
  zImageGenerate: ZImageGenerateNode,
  imageOutput: ImageOutputNode,
  zRegion: RegionNode,
  zComposition: CompositionNode,
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
  //
  // React Flow doesn't expose onPaneMouseDown/onPaneMouseUp, so we use
  // onPaneClick (fired on mousedown) to start, onPaneMouseMove to track,
  // and a global mouseup listener to finalise.

  const isDrawingRef = useRef(false);

  const handlePaneClick = useCallback(
    (event: ReactMouseEvent) => {
      if (!drawMode || !drawingNodeId) return;

      const flowPos = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      setDrawingRect({
        x: flowPos.x,
        y: flowPos.y,
        width: 1,
        height: 1,
      });
      isDrawingRef.current = true;
    },
    [drawMode, drawingNodeId, reactFlowInstance, setDrawingRect]
  );

  const handlePaneMouseMove = useCallback(
    (event: ReactMouseEvent) => {
      if (!drawMode || !drawingNodeId || !isDrawingRef.current) return;

      const rect = useUIStore.getState().drawingRect;
      if (!rect) return;

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

  // Global mouseup — finalises the draw even if mouse leaves the pane
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      const { drawMode: dm, drawingNodeId: dnd, drawingRect: dr } = useUIStore.getState();
      if (!dm || !isDrawingRef.current || !dnd) return;
      isDrawingRef.current = false;

      if (!dr || dr.width < 10 || dr.height < 10) {
        resetDrawing();
        return;
      }

      useWorkflowStore.getState().updateNodeData(dnd, {
        regionX: Math.round(dr.x),
        regionY: Math.round(dr.y),
        regionWidth: Math.round(dr.width),
        regionHeight: Math.round(dr.height),
        width: Math.round(dr.width),
        height: Math.round(dr.height),
      });

      resetDrawing();
    };

    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => window.removeEventListener("mouseup", handleGlobalMouseUp);
  }, [resetDrawing]);

  // ── SVG overlay: canvas boundary + live rect + region rectangles ────
  const drawingRect = useUIStore((s) => s.drawingRect);

  // Find composition node for canvas boundary reference
  const compositionNode = nodes.find((n) => n.type === "zComposition");
  const canvasWidth = compositionNode?.data.canvasWidth ?? 0;
  const canvasHeight = compositionNode?.data.canvasHeight ?? 0;
  const hasCanvas = canvasWidth > 0 && canvasHeight > 0;

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
        {/* Canvas boundary — shows where the output canvas lives */}
        {hasCanvas && (
          <rect
            x={0}
            y={0}
            width={canvasWidth}
            height={canvasHeight}
            fill="none"
            stroke="rgba(255, 200, 50, 0.4)"
            strokeWidth={2}
            rx={2}
          />
        )}
        {hasCanvas && (
          <text
            x={4}
            y={14}
            fill="rgba(255, 200, 50, 0.5)"
            fontSize={11}
            fontFamily="monospace"
          >
            {canvasWidth}×{canvasHeight} canvas
          </text>
        )}

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
  }, [nodes, drawingRect, canvasWidth, canvasHeight, hasCanvas]);

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
        onPaneClick={handlePaneClick}
        onPaneMouseMove={handlePaneMouseMove}
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
