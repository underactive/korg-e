import { useCallback } from "react";
import {
  Handle,
  Position,
  type NodeProps,
} from "@xyflow/react";
import type { KorgNode } from "@/types/workflow";
import { useWorkflowStore } from "@/store/useWorkflowStore";

export default function TextPromptNode({ id, data, selected }: NodeProps<KorgNode>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const prompt = data.prompt ?? "";

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateNodeData(id, { prompt: e.target.value });
    },
    [id, updateNodeData]
  );

  return (
    <div className={`korg-node ${selected ? "korg-node--selected" : ""}`}>
      <div className="korg-node__header">Text Prompt</div>
      <div className="korg-node__body">
        <textarea
          className="korg-node__textarea nodrag nowheel"
          value={prompt}
          onChange={handleChange}
          placeholder="Enter a prompt…"
          rows={4}
          style={{ width: 240 }}
        />
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id="prompt"
      />
    </div>
  );
}
