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

      {/* Dynamic input handles: one per connected region
          Plus a permanent fallback handle when no regions are connected yet */}
      {inputs.length > 0
        ? inputs.map((input, index) => (
            <Handle
              key={input.name}
              type="target"
              position={Position.Left}
              id={input.name}
              style={{
                top: `${((index + 1) * 100) / (inputs.length + 1)}%`,
              }}
            />
          ))
        : (
            <Handle
              type="target"
              position={Position.Left}
              id="drop-target"
              style={{ top: "50%" }}
              title="Drag a Region node's output here to connect it"
            />
          )}

      {/* Output handle for composited image */}
      <Handle type="source" position={Position.Right} id="image" />
    </div>
  );
}
