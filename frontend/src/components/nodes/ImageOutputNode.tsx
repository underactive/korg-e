import { useState } from "react";
import {
  Handle,
  Position,
  type NodeProps,
} from "@xyflow/react";
import type { KorgNode } from "@/types/workflow";

export default function ImageOutputNode({ data, selected }: NodeProps<KorgNode>) {
  const imageUrl = data.imageUrl ?? null;
  const seedInfo = data.seedInfo;
  const [imageLoaded, setImageLoaded] = useState(false);

  // Intermediate previews (base64 data URLs) render sharp;
  // final image (server path) gets blur→sharp transition on load
  const isIntermediate = imageUrl?.startsWith("data:") ?? false;

  return (
    <div className={`korg-node ${selected ? "korg-node--selected" : ""}`}>
      <div className="korg-node__header">Image Output</div>
      <div className="korg-node__body">
        {imageUrl ? (
          <div>
            <img
              key={imageUrl}
              src={imageUrl}
              alt="Generated output"
              className="nodrag"
              onLoad={() => setImageLoaded(true)}
              style={{
                maxWidth: 256,
                maxHeight: 256,
                borderRadius: 4,
                display: "block",
                filter: !isIntermediate && !imageLoaded ? "blur(8px)" : "blur(0px)",
                transition: "filter 0.5s ease",
              }}
            />
            {seedInfo !== undefined && (
              <div
                style={{
                  fontSize: 11,
                  color: "#888",
                  marginTop: 4,
                  textAlign: "center",
                }}
              >
                Seed: {seedInfo}
              </div>
            )}
          </div>
        ) : (
          <div
            className="korg-node__placeholder"
            style={{
              width: 200,
              height: 150,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#666",
              fontSize: 13,
              border: "1px solid #444",
              borderRadius: 4,
            }}
          >
            Waiting for output…
          </div>
        )}
      </div>
      <Handle
        type="target"
        position={Position.Left}
        id="image"
      />
    </div>
  );
}
