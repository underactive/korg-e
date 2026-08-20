import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Handle,
  Position,
  type NodeProps,
} from "@xyflow/react";
import type { KorgNode } from "@/types/workflow";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { usePaintStore } from "@/store/usePaintStore";

export default function ZImageGenerateNode({
  data,
  selected,
  id,
}: NodeProps<KorgNode>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const {
    paintMode, paintNodeId, brushRadius, paintModeType, maskVisible,
    setPaintMode, setBrushRadius, setPaintModeType, setMaskVisible, resetPaint,
  } = usePaintStore();

  const isPainting = paintMode && paintNodeId === id;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const isStrokeRef = useRef(false);

  // Read connected image from graph — imageData lives on ImageUploadNode
  const allNodes = useWorkflowStore((s) => s.nodes);
  const allEdges = useWorkflowStore((s) => s.edges);
  const imageData = useMemo(() => {
    for (const edge of allEdges) {
      if (edge.target === id && edge.targetHandle === "image") {
        const sourceNode = allNodes.find((n) => n.id === edge.source);
        if (sourceNode?.type === "imageUpload") {
          return sourceNode.data.imageData ?? null;
        }
      }
    }
    return null;
  }, [allNodes, allEdges, id]);

  const steps = data.steps ?? 50;
  const cfgScale = data.cfgScale ?? 5.0;
  const strength = data.strength ?? 0.6;
  const seed = data.seed ?? null;
  const width = data.width ?? 1024;
  const height = data.height ?? 1024;
  const batchCount = data.batchCount ?? 1;
  const maskBlur = data.maskBlur ?? 16;
  const status = data.status ?? "idle";
  const progress = data.progress ?? 0;
  const batchIndex = data.batchIndex ?? 0;
  const batchTotal = data.batchTotal ?? 0;

  const isBusy = status === "loading" || status === "generating";
  const hasImage = !!imageData;
  const hasMask = !!data.maskData;

  // Canvas redraw — image + mask overlay
  const redrawCanvas = useCallback(() => {
    if (!canvasRef.current || !imgRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d")!;
    canvas.width = imgRef.current.naturalWidth;
    canvas.height = imgRef.current.naturalHeight;
    ctx.drawImage(imgRef.current, 0, 0);
    if (offscreenRef.current && maskVisible) {
      const maskCanvas = offscreenRef.current;
      const tinted = document.createElement("canvas");
      tinted.width = maskCanvas.width;
      tinted.height = maskCanvas.height;
      const tintedCtx = tinted.getContext("2d")!;
      tintedCtx.fillStyle = "red";
      tintedCtx.fillRect(0, 0, tinted.width, tinted.height);
      tintedCtx.globalCompositeOperation = "destination-in";
      tintedCtx.drawImage(maskCanvas, 0, 0);
      ctx.globalAlpha = 0.4;
      ctx.drawImage(tinted, 0, 0);
      ctx.globalAlpha = 1.0;
    }
  }, [maskVisible]);

  // Load image when entering paint mode
  useEffect(() => {
    if (!isPainting || !imageData) return;
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      if (data.maskData) {
        const maskImg = new Image();
        maskImg.onload = () => {
          canvas.getContext("2d")!.drawImage(maskImg, 0, 0);
          offscreenRef.current = canvas;
          redrawCanvas();
        };
        maskImg.src = data.maskData;
      } else {
        offscreenRef.current = canvas;
        redrawCanvas();
      }
    };
    img.src = imageData;
  }, [isPainting, imageData, data.maskData, redrawCanvas]);

  // Exit paint mode — serialize mask
  useEffect(() => {
    if (isPainting) return;
    if (offscreenRef.current) {
      const ctx = offscreenRef.current.getContext("2d")!;
      const d = ctx.getImageData(0, 0, offscreenRef.current.width, offscreenRef.current.height);
      let hasContent = false;
      for (let i = 3; i < d.data.length; i += 4) {
        if (d.data[i] > 0) { hasContent = true; break; }
      }
      if (hasContent) {
        offscreenRef.current.toBlob((blob) => {
          if (!blob) return;
          const reader = new FileReader();
          reader.onload = () => updateNodeData(id, { maskData: reader.result as string });
          reader.readAsDataURL(blob);
        }, "image/png");
      } else {
        updateNodeData(id, { maskData: null });
      }
      offscreenRef.current = null;
    }
  }, [isPainting, id, updateNodeData]);

  // Brush handlers
  const getCanvasCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }, []);

  const drawBrush = useCallback((x: number, y: number) => {
    if (!offscreenRef.current) return;
    const ctx = offscreenRef.current.getContext("2d")!;
    ctx.fillStyle = paintModeType === "paint" ? "white" : "black";
    ctx.beginPath();
    ctx.arc(x, y, brushRadius, 0, Math.PI * 2);
    ctx.fill();
    redrawCanvas();
  }, [brushRadius, paintModeType, redrawCanvas]);

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isPainting) return;
    isStrokeRef.current = true;
    const { x, y } = getCanvasCoords(e);
    drawBrush(x, y);
  }, [isPainting, getCanvasCoords, drawBrush]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isStrokeRef.current) return;
    const { x, y } = getCanvasCoords(e);
    drawBrush(x, y);
  }, [getCanvasCoords, drawBrush]);

  const handleCanvasMouseUp = useCallback(() => {
    isStrokeRef.current = false;
  }, []);

  const handleTogglePaint = useCallback(() => {
    if (isPainting) resetPaint();
    else setPaintMode(true, id);
  }, [isPainting, id, setPaintMode, resetPaint]);

  const handleClearMask = useCallback(() => {
    if (offscreenRef.current) {
      offscreenRef.current.getContext("2d")!.clearRect(
        0, 0, offscreenRef.current.width, offscreenRef.current.height
      );
      redrawCanvas();
    }
    updateNodeData(id, { maskData: null });
  }, [id, updateNodeData, redrawCanvas]);

  const handleGenerate = useCallback(() => {
    window.dispatchEvent(new CustomEvent("korg:generate", {
      detail: { nodeId: id, params: { steps, cfgScale, strength, seed, width, height, batchCount } },
    }));
  }, [id, steps, cfgScale, strength, seed, width, height, batchCount]);

  const isBatch = batchTotal > 1;
  const progressPct = status === "generating" ? Math.round((progress / steps) * 100) : 0;
  const batchPct = isBatch && batchTotal > 0
    ? Math.round(((batchIndex + (status === "generating" ? progress / steps : 0)) / batchTotal) * 100)
    : 0;

  return (
    <div className={`korg-node ${selected ? "korg-node--selected" : ""}`}>
      <div className="korg-node__header">Z-Image Generate</div>
      <div className="korg-node__body">
        {hasImage && !isPainting && (
          <img src={imageData!} alt="Init" className="nodrag"
            style={{ maxWidth: 200, maxHeight: 200, borderRadius: 4, display: "block" }} />
        )}
        {hasImage && isPainting && (
          <canvas ref={canvasRef} className="nodrag"
            onMouseDown={handleCanvasMouseDown} onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp} onMouseLeave={handleCanvasMouseUp}
            style={{ maxWidth: 200, display: "block", cursor: "crosshair", borderRadius: 4 }} />
        )}
        {hasImage && (
          <button className="nodrag" onClick={handleTogglePaint}
            style={{ padding: "4px 10px", borderRadius: 4, border: "none",
              background: isPainting ? "#c44" : hasMask ? "#e6a23c" : "#4a90d9",
              color: "#fff", cursor: "pointer", width: "100%", marginTop: 8, fontSize: 12 }}>
            {isPainting ? "Done Painting" : hasMask ? "Edit Mask" : "Paint Mask"}
          </button>
        )}
        {isPainting && (
          <div style={{ marginTop: 6, fontSize: 11 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
              Brush
              <input type="range" className="nodrag" min={5} max={100}
                value={brushRadius} onChange={(e) => setBrushRadius(parseInt(e.target.value, 10))}
                style={{ flex: 1 }} />
              <span style={{ width: 24, textAlign: "right" }}>{brushRadius}</span>
            </label>
            <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
              <button className="nodrag" onClick={() => setPaintModeType(paintModeType === "paint" ? "erase" : "paint")}
                style={{ padding: "2px 8px", borderRadius: 3, border: "none",
                  background: paintModeType === "paint" ? "#4a90d9" : "#666",
                  color: "#fff", cursor: "pointer", fontSize: 11, flex: 1 }}>
                {paintModeType === "paint" ? "✏️ Paint" : "🧹 Erase"}
              </button>
              <button className="nodrag" onClick={handleClearMask}
                style={{ padding: "2px 8px", borderRadius: 3, border: "none",
                  background: "#666", color: "#fff", cursor: "pointer", fontSize: 11, flex: 1 }}>
                Clear
              </button>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" className="nodrag" checked={maskVisible}
                onChange={(e) => setMaskVisible(e.target.checked)} />
              Show Mask
            </label>
          </div>
        )}
        <div className="korg-node__params">
          <label>
            Batch
            <input type="number" className="nodrag" value={batchCount} min={1} max={100}
              onChange={(e) => updateNodeData(id, { batchCount: Math.max(1, parseInt(e.target.value, 10) || 1) })}
              style={{ width: 60 }} />
          </label>
          <label>
            Steps
            <input type="number" className="nodrag" value={steps} min={1} max={100}
              onChange={(e) => updateNodeData(id, { steps: parseInt(e.target.value, 10) })}
              style={{ width: 60 }} />
          </label>
          <label>
            CFG
            <input type="number" className="nodrag" value={cfgScale} min={1} max={20} step={0.5}
              onChange={(e) => updateNodeData(id, { cfgScale: parseFloat(e.target.value) })}
              style={{ width: 60 }} />
          </label>
          <label>
            Seed
            <input type="number" className="nodrag" value={seed ?? ""} placeholder="random"
              onChange={(e) => {
                const val = e.target.value;
                updateNodeData(id, { seed: val === "" ? null : parseInt(val, 10) });
              }}
              style={{ width: 80 }} />
          </label>
          <label>
            Width
            <select className="nodrag" value={width}
              onChange={(e) => updateNodeData(id, { width: parseInt(e.target.value, 10) })}>
              <option value={512}>512</option>
              <option value={768}>768</option>
              <option value={1024}>1024</option>
              <option value={1280}>1280</option>
              <option value={1536}>1536</option>
              <option value={2048}>2048</option>
            </select>
          </label>
          <label>
            Strength
            <input type="number" className="nodrag" value={strength} min={0.05} max={1.0} step={0.05}
              onChange={(e) => updateNodeData(id, { strength: parseFloat(e.target.value) })}
              style={{ width: 60 }} />
          </label>
          <label>
            Height
            <select className="nodrag" value={height}
              onChange={(e) => updateNodeData(id, { height: parseInt(e.target.value, 10) })}>
              <option value={512}>512</option>
              <option value={768}>768</option>
              <option value={1024}>1024</option>
              <option value={1280}>1280</option>
              <option value={1536}>1536</option>
              <option value={2048}>2048</option>
            </select>
          </label>
          {hasMask && (
            <label>
              Blur
              <input type="number" className="nodrag" value={maskBlur} min={0} max={64}
                onChange={(e) => updateNodeData(id, { maskBlur: parseInt(e.target.value, 10) })}
                style={{ width: 60 }} />
            </label>
          )}
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
          {isBusy ? "Generating…" : hasMask ? "Inpaint" : "Generate"}
        </button>

        {/* Progress bars */}
        {status === "generating" && (
          <div style={{ marginTop: 8 }}>
            <div
              className="korg-node__progress"
              style={{
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
            {isBatch && (
              <div style={{ marginTop: 4 }}>
                <div
                  style={{
                    fontSize: 10,
                    color: "#aaa",
                    marginBottom: 2,
                    display: "flex",
                    justifyContent: "space-between",
                  }}
                >
                  <span>Batch</span>
                  <span>
                    {batchIndex + 1} / {batchTotal}
                  </span>
                </div>
                <div
                  className="korg-node__progress"
                  style={{
                    height: 8,
                    background: "#333",
                    borderRadius: 4,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${batchPct}%`,
                      height: "100%",
                      background: "#e6a23c",
                      transition: "width 0.3s ease",
                    }}
                  />
                </div>
              </div>
            )}
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

      <Handle type="target" position={Position.Left} id="prompt" style={{ top: "30%" }} />
      <Handle type="target" position={Position.Left} id="image" style={{ top: "70%" }} />
      <Handle type="source" position={Position.Right} id="image" />
    </div>
  );
}
