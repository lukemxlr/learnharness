import { DEFAULT_STROKE_WIDTH, strokeWidth, visibleStrokes, type Stroke } from "./strokes.ts";

export interface Offset { x: number; y: number }
export interface Bounds extends Offset { width: number; height: number }

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
export const DEFAULT_ZOOM = 1;

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ZOOM;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

export function screenToWorld(offsetX: number, offsetY: number, origin: Offset, zoom = DEFAULT_ZOOM): Offset {
  const scale = clampZoom(zoom);
  return {
    x: (offsetX - origin.x) / scale,
    y: (offsetY - origin.y) / scale,
  };
}

/** Zoom the display camera while keeping the world point under (anchorX, anchorY) fixed on screen. */
export function zoomAroundAnchor(
  width: number,
  height: number,
  pan: Offset,
  currentZoom: number,
  nextZoom: number,
  anchorX: number,
  anchorY: number,
): { pan: Offset; zoom: number } {
  const z1 = clampZoom(currentZoom);
  const z2 = clampZoom(nextZoom);
  const origin = viewOrigin(width, height, pan, 0);
  const wx = (anchorX - origin.x) / z1;
  const wy = (anchorY - origin.y) / z1;
  return {
    zoom: z2,
    pan: {
      x: anchorX - width / 2 - wx * z2,
      y: anchorY - height / 2 - wy * z2,
    },
  };
}

/** Simultaneous 2-finger pinch-zoom + pan: keeps the world point under startMid glued to currentMid. */
export function pinchCamera(
  width: number,
  height: number,
  startPan: Offset,
  startZoom: number,
  startMid: Offset,
  startDist: number,
  currentMid: Offset,
  currentDist: number,
): { pan: Offset; zoom: number } {
  const z1 = clampZoom(startZoom);
  const ratio = startDist > 0 && currentDist > 0 ? currentDist / startDist : 1;
  const z2 = clampZoom(z1 * ratio);
  const startOrigin = viewOrigin(width, height, startPan, 0);
  const wx = (startMid.x - startOrigin.x) / z1;
  const wy = (startMid.y - startOrigin.y) / z1;
  return {
    zoom: z2,
    pan: {
      x: currentMid.x - width / 2 - wx * z2,
      y: currentMid.y - height / 2 - wy * z2,
    },
  };
}

/** Bound only the export raster, never world geometry or the display camera. */
export function exportRaster(bounds: Bounds, pixelRatio: number, imageScale: number): { width: number; height: number } {
  if (![bounds.x, bounds.y, bounds.width, bounds.height, pixelRatio, imageScale].every(Number.isFinite) ||
    bounds.width <= 0 || bounds.height <= 0 || pixelRatio <= 0 || imageScale <= 0 || imageScale > 100) {
    throw new Error("The drawing bounds cannot be exported. Your drawing has been kept.");
  }
  const scale = Math.min(pixelRatio * imageScale / 100, 2000 / bounds.width, 2000 / bounds.height);
  return {
    width: Math.max(1, Math.min(2000, Math.round(bounds.width * scale))),
    height: Math.max(1, Math.min(2000, Math.round(bounds.height * scale))),
  };
}

/** A camera translation, never a scale. Centered origin preserves strokes across orientation changes. */
export function viewOrigin(width: number, height: number, pan: Offset, referenceHeight = 0): Offset {
  return {
    x: width / 2 + pan.x,
    y: (referenceHeight > 0 ? height - 24 - referenceHeight / 2 : height / 2) + pan.y,
  };
}

export function referenceBounds(width: number, height: number): Bounds {
  return { x: -width / 2, y: -height / 2, width, height };
}

/** Includes round caps and each pressure- and width-dependent segment's full painted extent. */
export function inkBounds(history: readonly Stroke[]): Bounds | undefined {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const stroke of visibleStrokes(history)) {
    const base = stroke.width ?? DEFAULT_STROKE_WIDTH;
    for (let i = 0; i < stroke.points.length; i++) {
      const a = stroke.points[Math.max(0, i - 1)]!, b = stroke.points[i]!;
      const radius = strokeWidth(a, b, base) / 2;
      left = Math.min(left, a.x - radius, b.x - radius);
      top = Math.min(top, a.y - radius, b.y - radius);
      right = Math.max(right, a.x + radius, b.x + radius);
      bottom = Math.max(bottom, a.y + radius, b.y + radius);
    }
  }
  return left === Infinity ? undefined : { x: left, y: top, width: right - left, height: bottom - top };
}

/** Independent of camera, viewport, and erased history. Reuse the existing 24px margin. */
export function exportBounds(width: number, height: number, history: readonly Stroke[], padding = 24): Bounds | undefined {
  const ink = inkBounds(history);
  if (!ink) return undefined;
  const reference = referenceBounds(width, height);
  const hasReference = width > 0 && height > 0;
  const x = Math.floor(Math.min(ink.x, hasReference ? reference.x : ink.x) - padding);
  const y = Math.floor(Math.min(ink.y, hasReference ? reference.y : ink.y) - padding);
  const right = Math.ceil(Math.max(ink.x + ink.width, hasReference ? reference.x + width : ink.x + ink.width) + padding);
  const bottom = Math.ceil(Math.max(ink.y + ink.height, hasReference ? reference.y + height : ink.y + ink.height) + padding);
  return { x, y, width: right - x, height: bottom - y };
}
