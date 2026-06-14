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
      // Cancelling draw mode — save current regionX/Y from drawingRect if available
      resetDrawing();
    } else {
      // Enter draw mode for this node
      setDrawMode(true, id);
    }
  }, [isDrawing, id, setDrawMode, resetDrawing]);

  // Update geometry from user input fields
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
