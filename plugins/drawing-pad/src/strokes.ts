import { resolveStrokeColor, type ResolvedPaper } from "./theme.ts";

/** Coordinates and pressure remain in unrestricted world space. */
export interface Point { x: number; y: number; pressure: number }

export interface Stroke {
  tool: "pen" | "eraser";
  /** Hex color or "auto" for adaptive monochrome ink. */
  color?: string;
  /** Base stroke width in CSS px. */
  width?: number;
  points: Point[];
}

export type Tool = Stroke["tool"] | "hand";

export const DEFAULT_STROKE_WIDTH = 4;
export const MIN_STROKE_WIDTH = 2;
export const MAX_STROKE_WIDTH = 16;

export function clampStrokeWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_STROKE_WIDTH;
  return Math.max(MIN_STROKE_WIDTH, Math.min(MAX_STROKE_WIDTH, Math.round(value)));
}

export function strokeWidth(a: Point, b: Point, baseWidth = DEFAULT_STROKE_WIDTH): number {
  const base = Number.isFinite(baseWidth) && baseWidth > 0 ? baseWidth : DEFAULT_STROKE_WIDTH;
  const avgPressure = (a.pressure + b.pressure) / 2;
  return Math.max(1, base * (0.65 + 0.7 * avgPressure));
}

function pointSegmentDistanceSquared(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return (point.x - a.x - t * dx) ** 2 + (point.y - a.y - t * dy) ** 2;
}

function segmentDistanceSquared(a: Point, b: Point, c: Point, d: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, ex = d.x - c.x, ey = d.y - c.y;
  const determinant = dx * ey - dy * ex;
  if (determinant !== 0) {
    const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / determinant;
    const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / determinant;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(
    pointSegmentDistanceSquared(a, c, d),
    pointSegmentDistanceSquared(b, c, d),
    pointSegmentDistanceSquared(c, a, b),
    pointSegmentDistanceSquared(d, a, b),
  );
}

/* Invariant: a Stroke object and a history array are immutable once committed.
 * The only mutable stroke is the sheet's live `active` stroke, which must
 * never reach the caches below (bounds and resolved histories). */
export interface StrokeBounds { left: number; top: number; right: number; bottom: number }

const bounds = new WeakMap<Stroke, StrokeBounds>();

function measure(stroke: Stroke): StrokeBounds {
  const base = stroke.width ?? DEFAULT_STROKE_WIDTH;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let i = 0; i < stroke.points.length; i++) {
    const a = stroke.points[Math.max(0, i - 1)]!, b = stroke.points[i]!;
    const radius = strokeWidth(a, b, base) / 2;
    left = Math.min(left, a.x - radius, b.x - radius);
    top = Math.min(top, a.y - radius, b.y - radius);
    right = Math.max(right, a.x + radius, b.x + radius);
    bottom = Math.max(bottom, a.y + radius, b.y + radius);
  }
  return { left, top, right, bottom };
}

/** Committed strokes only. Includes each segment's half width. */
export function strokeBounds(stroke: Stroke): StrokeBounds {
  let cached = bounds.get(stroke);
  if (!cached) {
    cached = measure(stroke);
    bounds.set(stroke, cached);
  }
  return cached;
}

/** Same as strokeBounds, never cached: for a still-growing (active) stroke. */
export function liveBounds(stroke: Stroke): StrokeBounds {
  return measure(stroke);
}

function eraserBounds(eraser: Stroke): StrokeBounds {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const point of eraser.points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return { left, top, right, bottom };
}

function touchesStroke(stroke: Stroke, eraser: Stroke, pen: StrokeBounds, erase: StrokeBounds): boolean {
  const base = stroke.width ?? DEFAULT_STROKE_WIDTH;
  const eraserRadius = Math.max(12, (eraser.width ?? 12) * 1.5);
  const contact = eraserRadius + 1e-6;
  if (
    pen.left - contact > erase.right ||
    pen.right + contact < erase.left ||
    pen.top - contact > erase.bottom ||
    pen.bottom + contact < erase.top
  ) {
    return false;
  }
  for (let i = 0; i < stroke.points.length; i++) {
    const a = stroke.points[Math.max(0, i - 1)]!, b = stroke.points[i]!;
    const radius = eraserRadius + strokeWidth(a, b, base) / 2;
    for (let j = 0; j < eraser.points.length; j++) {
      const c = eraser.points[Math.max(0, j - 1)]!, d = eraser.points[j]!;
      if (segmentDistanceSquared(a, b, c, d) <= radius * radius) return true;
    }
  }
  return false;
}

/** Pens in `visible` that `eraser` does not touch; the same array object when
 * it touches none (callers can use identity to skip repaints). */
function erase(visible: readonly Stroke[], eraser: Stroke): readonly Stroke[] {
  if (!visible.length) return visible;
  const area = eraserBounds(eraser);
  const kept = visible.filter(pen => !touchesStroke(pen, eraser, strokeBounds(pen), area));
  return kept.length === visible.length ? visible : kept;
}

const resolved = new WeakMap<readonly Stroke[], readonly Stroke[]>();
let last: { history: readonly Stroke[]; visible: readonly Stroke[] } | undefined;

function extendsLast(history: readonly Stroke[]): boolean {
  if (!last || history.length !== last.history.length + 1) return false;
  for (let i = 0; i < last.history.length; i++) {
    if (history[i] !== last.history[i]) return false;
  }
  return true;
}

/** Keep eraser gestures in history so undo restores complete removed strokes.
 * Memoised per history array; one appended stroke is resolved incrementally.
 * The result is shared: never mutate it. */
export function visibleStrokes(history: readonly Stroke[]): readonly Stroke[] {
  let visible = resolved.get(history);
  if (!visible) {
    if (extendsLast(history)) {
      const stroke = history.at(-1)!;
      visible = stroke.tool === "pen"
        ? (stroke.points.length ? [...last!.visible, stroke] : last!.visible)
        : erase(last!.visible, stroke);
    } else {
      let replay: Stroke[] = [];
      for (const stroke of history) {
        if (stroke.tool === "pen" && stroke.points.length) replay.push(stroke);
        else if (stroke.tool === "eraser") replay = erase(replay, stroke) as Stroke[];
      }
      visible = replay;
    }
    resolved.set(history, visible);
  }
  last = { history, visible };
  return visible;
}

/** Visible committed strokes minus those touched by a still-growing eraser stroke. Never cached. */
export function visibleUnderEraser(visible: readonly Stroke[], eraser: Stroke): readonly Stroke[] {
  return erase(visible, eraser);
}

export function inkSignature(history: readonly Stroke[], paperKey = "app", defaultColor = "auto"): string {
  const visible = visibleStrokes(history);
  return visible.length
    ? JSON.stringify([paperKey, defaultColor, visible.map(s => [s.color ?? "auto", s.width ?? DEFAULT_STROKE_WIDTH, s.points])])
    : "";
}

export function paintSegment(
  context: CanvasRenderingContext2D,
  a: Point,
  b: Point,
  color: string,
  baseWidth = DEFAULT_STROKE_WIDTH,
): void {
  context.globalCompositeOperation = "source-over";
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = strokeWidth(a, b, baseWidth);
  context.beginPath();
  if (a.x === b.x && a.y === b.y) {
    context.arc(a.x, a.y, context.lineWidth / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }
}

export function paintStroke(context: CanvasRenderingContext2D, stroke: Stroke, color: string): void {
  const points = stroke.points;
  if (!points.length) return;
  const baseWidth = stroke.width ?? DEFAULT_STROKE_WIDTH;
  if (points.length === 1) {
    paintSegment(context, points[0]!, points[0]!, color, baseWidth);
    return;
  }
  if (points.length === 2) {
    paintSegment(context, points[0]!, points[1]!, color, baseWidth);
    return;
  }
  context.globalCompositeOperation = "source-over";
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineCap = "round";
  context.lineJoin = "round";

  const mid0x = (points[0]!.x + points[1]!.x) / 2;
  const mid0y = (points[0]!.y + points[1]!.y) / 2;
  context.lineWidth = strokeWidth(points[0]!, points[1]!, baseWidth);
  context.beginPath();
  context.moveTo(points[0]!.x, points[0]!.y);
  context.lineTo(mid0x, mid0y);
  context.stroke();

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const ctrl = points[i]!;
    const next = points[i + 1]!;
    const startX = (prev.x + ctrl.x) / 2;
    const startY = (prev.y + ctrl.y) / 2;
    const endX = (ctrl.x + next.x) / 2;
    const endY = (ctrl.y + next.y) / 2;
    context.lineWidth = strokeWidth(prev, ctrl, baseWidth);
    context.beginPath();
    context.moveTo(startX, startY);
    context.quadraticCurveTo(ctrl.x, ctrl.y, endX, endY);
    context.stroke();
  }

  const lastPrev = points[points.length - 2]!;
  const last = points[points.length - 1]!;
  context.lineWidth = strokeWidth(lastPrev, last, baseWidth);
  context.beginPath();
  context.moveTo((lastPrev.x + last.x) / 2, (lastPrev.y + last.y) / 2);
  context.lineTo(last.x, last.y);
  context.stroke();
}

export function paintInk(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  strokes: readonly Stroke[],
  paper: ResolvedPaper,
  origin: { x: number; y: number } = { x: 0, y: 0 },
): void {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not create the drawing canvas.");
  context.resetTransform();
  context.globalCompositeOperation = "source-over";
  context.fillStyle = paper.backgroundColor;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.setTransform(
    canvas.width / width,
    0,
    0,
    canvas.height / height,
    origin.x * canvas.width / width,
    origin.y * canvas.height / height,
  );
  for (const stroke of visibleStrokes(strokes)) {
    paintStroke(context, stroke, resolveStrokeColor(stroke.color, paper));
  }
}

export function paintInkTransparent(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  strokes: readonly Stroke[],
  paper: ResolvedPaper,
  origin: { x: number; y: number } = { x: 0, y: 0 },
): void {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not create the drawing canvas.");
  context.resetTransform();
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.setTransform(
    canvas.width / width,
    0,
    0,
    canvas.height / height,
    origin.x * canvas.width / width,
    origin.y * canvas.height / height,
  );
  for (const stroke of visibleStrokes(strokes)) {
    paintStroke(context, stroke, resolveStrokeColor(stroke.color, paper));
  }
}

export function paintGrid(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  color: string,
  origin: { x: number; y: number } = { x: 0, y: 0 },
  spacing = 24,
): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  context.resetTransform();
  context.clearRect(0, 0, canvas.width, canvas.height);
  drawGridLines(context, canvas.width, canvas.height, width, height, color, origin, spacing);
}

export function drawGridLines(
  context: CanvasRenderingContext2D,
  pixelWidth: number,
  pixelHeight: number,
  cssWidth: number,
  cssHeight: number,
  color: string,
  origin: { x: number; y: number },
  spacing = 24,
): void {
  if (cssWidth <= 0 || cssHeight <= 0 || spacing <= 0) return;
  const sx = pixelWidth / cssWidth;
  const sy = pixelHeight / cssHeight;
  context.save();
  context.setTransform(sx, 0, 0, sy, 0, 0);
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.beginPath();
  const offsetX = ((origin.x % spacing) + spacing) % spacing;
  const offsetY = ((origin.y % spacing) + spacing) % spacing;
  for (let x = offsetX; x <= cssWidth; x += spacing) {
    const aligned = Math.round(x) + 0.5;
    context.moveTo(aligned, 0);
    context.lineTo(aligned, cssHeight);
  }
  for (let y = offsetY; y <= cssHeight; y += spacing) {
    const aligned = Math.round(y) + 0.5;
    context.moveTo(0, aligned);
    context.lineTo(cssWidth, aligned);
  }
  context.stroke();
  context.restore();
}
