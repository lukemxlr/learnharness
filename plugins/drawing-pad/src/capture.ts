import { exportBounds, exportRaster } from "./geometry.ts";
import { drawGridLines, paintInkTransparent } from "./strokes.ts";
import type { Capture } from "./state.ts";
import { resolvePaperTheme } from "./theme.ts";

export function hasVisibleInk(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not read the drawing canvas.");
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  return pixels.some((value, index) => index % 4 === 3 && value > 0);
}

/** Freeze strokes + resolved opaque paper (+ optional subtle grid) into a tight PNG. */
export async function exportSheet(
  captured: Capture,
  signal: AbortSignal,
): Promise<{ type: "image"; mimeType: "image/png"; data: string }> {
  signal.throwIfAborted();
  const draft = captured.draft;
  const bounds = exportBounds(0, 0, draft.strokes);
  if (!bounds) throw new Error("No visible ink could be captured. Your drawing has been kept.");
  const raster = exportRaster(bounds, draft.pixelRatio, captured.imageScale);
  const paper = resolvePaperTheme(draft.paperTheme, captured.appInk);

  const ink = document.createElement("canvas");
  ink.width = raster.width;
  ink.height = raster.height;
  paintInkTransparent(ink, bounds.width, bounds.height, draft.strokes, paper, { x: -bounds.x, y: -bounds.y });
  if (!hasVisibleInk(ink)) {
    throw new Error("No visible ink could be captured at the export resolution. Your drawing has been kept.");
  }

  const combined = document.createElement("canvas");
  combined.width = raster.width;
  combined.height = raster.height;
  const context = combined.getContext("2d");
  if (!context) throw new Error("Could not export your drawing. Your drawing has been kept.");
  context.fillStyle = paper.backgroundColor;
  context.fillRect(0, 0, combined.width, combined.height);
  if (draft.grid) {
    drawGridLines(
      context,
      combined.width,
      combined.height,
      bounds.width,
      bounds.height,
      paper.exportGridColor,
      { x: -bounds.x, y: -bounds.y },
    );
  }
  context.drawImage(ink, 0, 0);
  signal.throwIfAborted();

  const data = combined.toDataURL("image/png").split(",")[1];
  if (!data) throw new Error("Could not encode your drawing. Your drawing has been kept.");
  return { type: "image", mimeType: "image/png", data };
}
