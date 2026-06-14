import { useCallback, useRef } from "react";
import {
  Handle,
  Position,
  type NodeProps,
} from "@xyflow/react";
import type { KorgNode } from "@/types/workflow";

export default function ImageUploadNode({ data, selected, id }: NodeProps<KorgNode>) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        // The parent component will call updateNodeData
        // For now, the data is stored in the customEvent
        const base64 = reader.result as string;
        // dispatch custom event or use store directly
        window.dispatchEvent(
          new CustomEvent("korg:updateNode", {
            detail: { id, data: { imageData: base64 } },
          })
        );
      };
      reader.readAsDataURL(file);
    },
    [id]
  );

  const previewUrl = data.imageData ?? null;

  return (
    <div className={`korg-node ${selected ? "korg-node--selected" : ""}`}>
      <div className="korg-node__header">Image Upload</div>
      <div className="korg-node__body">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt="Upload preview"
            className="nodrag"
            style={{ maxWidth: 200, maxHeight: 200, borderRadius: 4 }}
          />
        ) : (
          <div
            className="korg-node__upload-zone nodrag"
            onClick={() => inputRef.current?.click()}
            style={{
              width: 200,
              height: 120,
              border: "2px dashed #666",
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              color: "#888",
              fontSize: 13,
            }}
          >
            Click to upload
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id="image"
      />
    </div>
  );
}
