/** Toolbar — Add node menu, workflow save/load controls. */

import { useCallback, useState } from "react";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { useUIStore } from "@/store/useUIStore";
import type { KorgNodeType } from "@/types/workflow";

const NODE_TYPES: { type: KorgNodeType; label: string }[] = [
  { type: "textPrompt", label: "Text Prompt" },
  { type: "imageUpload", label: "Image Upload" },
  { type: "zImageGenerate", label: "Z-Image Generate" },
  { type: "zRegion", label: "Region" },
  { type: "zComposition", label: "Composition" },
  { type: "imageOutput", label: "Image Output" },
];

export default function Toolbar() {
  const { addNode, saveWorkflow, loadWorkflow, resetToStarter } =
    useWorkflowStore();
  const setDrawMode = useUIStore((s) => s.setDrawMode);
  const [workflowName, setWorkflowName] = useState("my-workflow");

  const handleSave = useCallback(async () => {
    await saveWorkflow(workflowName);
  }, [saveWorkflow, workflowName]);

  const handleLoad = useCallback(async () => {
    try {
      await loadWorkflow(workflowName);
    } catch (err) {
      alert(`Failed to load workflow: ${(err as Error).message}`);
    }
  }, [loadWorkflow, workflowName]);

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        left: 8,
        zIndex: 10,
        display: "flex",
        gap: 6,
        alignItems: "center",
        background: "#1a1a2e",
        padding: "8px 12px",
        borderRadius: 8,
        border: "1px solid #333",
        flexWrap: "wrap",
      }}
    >
      {/* Add node dropdown */}
      <select
        className="nodrag"
        defaultValue=""
        onChange={(e) => {
          const val = e.target.value as KorgNodeType;
          if (val) addNode(val);
          e.target.value = "";
        }}
        style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid #555", background: "#16213e", color: "#eee" }}
      >
        <option value="" disabled>
          + Add node
        </option>
        {NODE_TYPES.map((nt) => (
          <option key={nt.type} value={nt.type}>
            {nt.label}
          </option>
        ))}
      </select>

      {/* Draw Region shortcut — creates a region and enters draw mode */}
      <button
        className="nodrag"
        onClick={() => {
          addNode("zRegion");
          // The new region is the last node — enter draw mode for it
          const nodes = useWorkflowStore.getState().nodes;
          const newRegion = nodes[nodes.length - 1];
          if (newRegion && newRegion.type === "zRegion") {
            setDrawMode(true, newRegion.id);
          }
        }}
        style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid #4a90d9", background: "#1a3a5c", color: "#8ab8f0", cursor: "pointer", fontSize: 12 }}
        title="Add a region node and start drawing a rectangle"
      >
        Draw Region
      </button>

      {/* Workflow name */}
      <input
        className="nodrag"
        value={workflowName}
        onChange={(e) => setWorkflowName(e.target.value)}
        style={{
          padding: "4px 8px",
          borderRadius: 4,
          border: "1px solid #555",
          background: "#16213e",
          color: "#eee",
          width: 130,
        }}
        placeholder="Workflow name"
      />

      {/* Save / Load */}
      <button
        className="nodrag"
        onClick={handleSave}
        style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid #4a90d9", background: "#4a90d9", color: "#fff", cursor: "pointer" }}
      >
        Save
      </button>
      <button
        className="nodrag"
        onClick={handleLoad}
        style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid #555", background: "#333", color: "#eee", cursor: "pointer" }}
      >
        Load
      </button>

      {/* Reset */}
      <button
        className="nodrag"
        onClick={resetToStarter}
        style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid #c44", background: "#622", color: "#e88", cursor: "pointer" }}
      >
        Reset
      </button>
    </div>
  );
}
