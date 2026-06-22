/**
 * Transient paint state — brush interaction, mask mode.
 *
 * Separated from useWorkflowStore to keep persisted workflow data clean
 * (no paintMode, brushRadius leaks into save/load JSON).
 * Follows the useUIStore transient-state pattern.
 */

import { create } from "zustand";

export type PaintModeType = "paint" | "erase";

export type PaintStore = {
  /** Whether the canvas is currently in "paint mask" mode. */
  paintMode: boolean;
  /** The generate node ID currently being painted on. */
  paintNodeId: string | null;
  /** Brush radius in image pixels. */
  brushRadius: number;
  /** Add to mask (paint) or remove from mask (erase). */
  paintModeType: PaintModeType;
  /** Toggle mask overlay visibility. */
  maskVisible: boolean;

  setPaintMode: (enabled: boolean, nodeId?: string) => void;
  setBrushRadius: (radius: number) => void;
  setPaintModeType: (type: PaintModeType) => void;
  setMaskVisible: (visible: boolean) => void;
  resetPaint: () => void;
};

export const usePaintStore = create<PaintStore>((set) => ({
  paintMode: false,
  paintNodeId: null,
  brushRadius: 20,
  paintModeType: "paint",
  maskVisible: true,

  setPaintMode: (enabled, nodeId) =>
    set({
      paintMode: enabled,
      paintNodeId: enabled ? (nodeId ?? null) : null,
    }),

  setBrushRadius: (radius) => set({ brushRadius: radius }),
  setPaintModeType: (type) => set({ paintModeType: type }),
  setMaskVisible: (visible) => set({ maskVisible: visible }),
  resetPaint: () =>
    set({
      paintMode: false,
      paintNodeId: null,
    }),
}));
