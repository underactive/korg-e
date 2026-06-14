/**
 * Transient UI state — drawing interaction, canvas mode overrides.
 *
 * This store holds ephemeral state that is NOT persisted as part of
 * the workflow graph. Separated from useWorkflowStore to keep
 * persisted workflow data clean (no drawMode, drawingRect leaks
 * into save/load JSON).
 */

import { create } from "zustand";

export type DrawingRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type UIStore = {
  /** Whether the canvas is currently in "draw region" mode. */
  drawMode: boolean;
  /** The live rectangle being drawn (updated during mousemove). */
  drawingRect: DrawingRect | null;
  /** The region node ID currently being drawn for (or drawn from). */
  drawingNodeId: string | null;

  setDrawMode: (enabled: boolean, nodeId?: string) => void;
  setDrawingRect: (rect: DrawingRect | null) => void;
  resetDrawing: () => void;
};

export const useUIStore = create<UIStore>((set) => ({
  drawMode: false,
  drawingRect: null,
  drawingNodeId: null,

  setDrawMode: (enabled: boolean, nodeId?: string) =>
    set({
      drawMode: enabled,
      drawingNodeId: enabled ? (nodeId ?? null) : null,
      drawingRect: null, // clear any partial rect when toggling
    }),

  setDrawingRect: (rect: DrawingRect | null) =>
    set({ drawingRect: rect }),

  resetDrawing: () =>
    set({ drawMode: false, drawingRect: null, drawingNodeId: null }),
}));
