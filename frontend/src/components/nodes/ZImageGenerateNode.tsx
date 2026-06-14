import { useCallback } from "react";
import {
  Handle,
  Position,
  type NodeProps,
} from "@xyflow/react";
import type { KorgNode } from "@/types/workflow";
import { useWorkflowStore } from "@/store/useWorkflowStore";

export default function ZImageGenerateNode({
  data,
  selected,
  id,
}: NodeProps<KorgNode>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);

  const steps = data.steps ?? 50;
  const cfgScale = data.cfgScale ?? 5.0;
  const strength = data.strength ?? 0.6;
  const seed = data.seed ?? null;
  const width = data.width ?? 1024;
  const height = data.height ?? 1024;
  const status = data.status ?? "idle";
  const progress = data.progress ?? 0;

  const isBusy = status === "loading" || status === "generating";

  const handleGenerate = useCallback(() => {
    const workflowEvent = new CustomEvent("korg:generate", {
      detail: {
        nodeId: id,
        params: { steps, cfgScale, strength, seed, width, height },
      },
    });
    window.dispatchEvent(workflowEvent);
  }, [id, steps, cfgScale, strength, seed, width, height]);

  const progressPct =
    status === "generating"
      ? Math.round((progress / steps) * 100)
      : 0;

  return (
    <div className={`korg-node ${selected ? "korg-node--selected" : ""}`}>
      <div className="korg-node__header">Z-Image Generate</div>
      <div className="korg-node__body">
        {/* Parameters */}
        <div className="korg-node__params">
          <label>
            Steps
            <input
              type="number"
              className="nodrag"
              value={steps}
              min={1}
              max={100}
              onChange={(e) =>
                updateNodeData(id, { steps: parseInt(e.target.value, 10) })
              }
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
          <label>
            Width
            <select
              className="nodrag"
              value={width}
              onChange={(e) =>
                updateNodeData(id, { width: parseInt(e.target.value, 10) })
              }
            >
              <option value={512}>512</option>
              <option value={768}>768</option>
              <option value={1024}>1024</option>
            </select>
          </label>
          <label>
            Strength
            <input
              type="number"
              className="nodrag"
              value={strength}
              min={0.05}
              max={1.0}
              step={0.05}
              onChange={(e) =>
                updateNodeData(id, { strength: parseFloat(e.target.value) })
              }
              style={{ width: 60 }}
            />
          </label>
          <label>
            Height
            <select
              className="nodrag"
              value={height}
              onChange={(e) =>
                updateNodeData(id, { height: parseInt(e.target.value, 10) })
              }
            >
              <option value={512}>512</option>
              <option value={768}>768</option>
              <option value={1024}>1024</option>
            </select>
          </label>
        </div>

        {/* Generate button */}
        <button
          className="korg-node__generate nodrag"
          onClick={handleGenerate}
          disabled={isBusy}
          style={{
            marginTop: 8,
            padding: "6px 16px",
            background: isBusy ? "#666" : "#4a90d9",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: isBusy ? "not-allowed" : "pointer",
            width: "100%",
          }}
        >
          {isBusy ? "Generating…" : "Generate"}
        </button>

        {/* Progress bar */}
        {status === "generating" && (
          <div
            className="korg-node__progress"
            style={{
              marginTop: 8,
              height: 8,
              background: "#333",
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${progressPct}%`,
                height: "100%",
                background: "#4a90d9",
                transition: "width 0.3s ease",
              }}
            />
          </div>
        )}

        {/* Error display */}
        {status === "error" && data.error && (
          <div
            className="korg-node__error"
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
