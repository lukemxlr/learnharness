import assert from "node:assert/strict";
import { it } from "node:test";
import {
  clampStrokeWidth,
  DEFAULT_STROKE_WIDTH,
  inkSignature,
  paintGrid,
  paintInk,
  paintStroke,
  strokeWidth,
  visibleStrokes,
  type Point,
  type Stroke,
} from "../src/strokes.ts";
import { resolvePaperTheme } from "../src/theme.ts";

const point = (x: number, y = 0, pressure = 0.5): Point => ({ x, y, pressure });
const pen = (points: Point[], extra: Partial<Stroke> = {}): Stroke => ({ tool: "pen", points, ...extra });
const erase = (points: Point[], extra: Partial<Stroke> = {}): Stroke => ({ tool: "eraser", points, ...extra });

it("scales width smoothly with pressure around the configured base stroke width", () => {
  assert.equal(strokeWidth(point(0, 0, 0.5), point(1, 0, 0.5), 4), 4);
  assert.equal(strokeWidth(point(0, 0, 0.5), point(1, 0, 0.5), 8), 8);
  assert.ok(strokeWidth(point(0, 0, 0), point(0, 0, 0), 4) < 4);
  assert.ok(strokeWidth(point(0, 0, 1), point(0, 0, 1), 4) > 4);
  assert.equal(clampStrokeWidth(1), 2);
  assert.equal(clampStrokeWidth(24), 16);
  assert.equal(clampStrokeWidth(7.6), 8);
});

it("erases a whole crossing stroke, not only its touched segment", () => {
  const a = pen([point(0), point(100)]), b = pen([point(0, 60), point(100, 60)]);
  assert.deepEqual(visibleStrokes([a, b, erase([point(50, -30), point(50, 30)])]), [b]);
});

it("handles dot strokes and single-contact erasers", () => {
  const dot = pen([point(10, 10)]);
  assert.deepEqual(visibleStrokes([dot, erase([point(10, 10)])]), []);
});

it("undoing an eraser restores exact complete strokes", () => {
  const a = pen([point(0), point(100)], { color: "#2563eb", width: 8 }), history = [a, erase([point(50)])];
  assert.equal(visibleStrokes(history).length, 0);
  assert.deepEqual(visibleStrokes(history.slice(0, -1)), [a]);
});

it("a pen stroke drawn after erasing is not retroactively erased", () => {
  const first = pen([point(0)]), next = pen([point(0)]);
  assert.deepEqual(visibleStrokes([first, erase([point(0)]), next]), [next]);
});

it("empty histories, empty pen records and fully erased histories have no signature", () => {
  assert.equal(inkSignature([]), "");
  assert.equal(inkSignature([pen([])]), "");
  assert.equal(inkSignature([pen([point(0)]), erase([point(0)])]), "");
});

it("signatures distinguish colors, widths, and paper themes", () => {
  const a = pen([point(0), point(100)], { color: "#2563eb", width: 4 });
  const b = pen([point(0), point(100)], { color: "#dc2626", width: 4 });
  const c = pen([point(0), point(100)], { color: "#2563eb", width: 8 });
  assert.equal(inkSignature([a]), inkSignature([a, erase([point(0, 100)])]));
  assert.notEqual(inkSignature([a]), inkSignature([b]));
  assert.notEqual(inkSignature([a]), inkSignature([c]));
  assert.notEqual(inkSignature([a], "light"), inkSignature([a], "dark"));
});

it("does not mutate stroke arrays while resolving erasers", () => {
  const a = pen([point(0), point(100)]), history = [a, erase([point(50)])];
  const before = JSON.stringify(history);
  visibleStrokes(history);
  assert.equal(JSON.stringify(history), before);
});

it("paintInk fills an opaque paper background and strokes with quadratic midpoint smoothing", () => {
  const ops: string[] = [];
  const fakeCtx = {
    globalCompositeOperation: "source-over",
    fillStyle: "",
    strokeStyle: "",
    lineCap: "",
    lineJoin: "",
    lineWidth: 0,
    resetTransform() { ops.push("resetTransform"); },
    fillRect(_x: number, _y: number, w: number, h: number) { ops.push(`fillRect:${this.fillStyle}:${w}x${h}`); },
    setTransform() { ops.push("setTransform"); },
    beginPath() { ops.push("beginPath"); },
    moveTo(x: number, y: number) { ops.push(`moveTo:${x},${y}`); },
    lineTo(x: number, y: number) { ops.push(`lineTo:${x},${y}`); },
    quadraticCurveTo(cx: number, cy: number, x: number, y: number) { ops.push(`quad:${cx},${cy}->${x},${y}`); },
    arc() { ops.push("arc"); },
    fill() { ops.push("fill"); },
    stroke() { ops.push(`stroke:${this.strokeStyle}:${this.lineWidth}`); },
  };
  const fakeCanvas = {
    width: 400,
    height: 300,
    getContext: () => fakeCtx,
  } as unknown as HTMLCanvasElement;

  const lightPaper = resolvePaperTheme("light");
  paintInk(
    fakeCanvas,
    400,
    300,
    [pen([point(0, 0), point(20, 10), point(40, 0)], { color: "auto", width: 6 })],
    lightPaper,
  );
  assert.equal(ops[0], "resetTransform");
  assert.equal(ops[1], "fillRect:#ffffff:400x300");
  assert.ok(ops.some(op => op.startsWith("quad:20,10->")));
  assert.ok(ops.some(op => op === "stroke:#111827:6"));

  ops.length = 0;
  paintStroke(fakeCtx as unknown as CanvasRenderingContext2D, pen([point(5, 5)], { width: DEFAULT_STROKE_WIDTH }), "#2563eb");
  assert.ok(ops.includes("arc") && ops.includes("fill"));
});

it("paintGrid renders Karoraster lines on its separate canvas without touching ink", () => {
  const ops: string[] = [];
  const fakeCtx = {
    strokeStyle: "",
    lineWidth: 0,
    resetTransform() { ops.push("resetTransform"); },
    clearRect(_x: number, _y: number, w: number, h: number) { ops.push(`clear:${w}x${h}`); },
    save() {},
    restore() {},
    setTransform() {},
    beginPath() {},
    moveTo(x: number, y: number) { ops.push(`m:${x},${y}`); },
    lineTo(x: number, y: number) { ops.push(`l:${x},${y}`); },
    stroke() { ops.push(`stroke:${this.strokeStyle}`); },
  };
  const gridCanvas = { width: 100, height: 100, getContext: () => fakeCtx } as unknown as HTMLCanvasElement;
  paintGrid(gridCanvas, 100, 100, "rgba(15, 23, 42, 0.12)", { x: 0, y: 0 }, 24);
  assert.equal(ops[0], "resetTransform");
  assert.equal(ops[1], "clear:100x100");
  assert.ok(ops.some(op => op === "stroke:rgba(15, 23, 42, 0.12)"));
});
