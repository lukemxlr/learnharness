import assert from "node:assert/strict";
import { it } from "node:test";
import {
  clampZoom,
  exportBounds,
  exportRaster,
  inkBounds,
  pinchCamera,
  referenceBounds,
  screenToWorld,
  viewOrigin,
  zoomAroundAnchor,
} from "../src/geometry.ts";
import type { Stroke } from "../src/strokes.ts";

const pen = (x: number, y: number, pressure = 0.5, width?: number): Stroke => ({
  tool: "pen",
  ...(width !== undefined ? { width } : {}),
  points: [{ x, y, pressure }],
});

it("resize changes translation, never world scale; centered origin preserves strokes", () => {
  assert.deepEqual(viewOrigin(800, 600, { x: 0, y: 0 }), { x: 400, y: 300 });
  assert.deepEqual(viewOrigin(1200, 600, { x: 0, y: 0 }), { x: 600, y: 300 });
  assert.deepEqual(viewOrigin(1200, 600, { x: -1200, y: 2000 }), { x: -600, y: 2300 });
  assert.deepEqual(referenceBounds(600, 200), { x: -300, y: -100, width: 600, height: 200 });
});

it("ink bounds account for stroke width and pressure", () => {
  // baseWidth=4, pressure=1 -> strokeWidth = 4 * 1.35 = 5.4, radius = 2.7
  const b = inkBounds([pen(-2000, 3000, 1, 4)])!;
  assert.equal(b.x, -2002.7);
  assert.equal(b.y, 2997.3);
  assert.ok(Math.abs(b.width - 5.4) < 1e-9);
  assert.ok(Math.abs(b.height - 5.4) < 1e-9);
  // baseWidth=10, pressure=0.5 -> strokeWidth = 10, radius = 5
  assert.deepEqual(inkBounds([pen(0, 0, 0.5, 10)]), { x: -5, y: -5, width: 10, height: 10 });
});

it("bounds include both endpoints and full radius of variable-pressure segments", () => {
  // baseWidth=4 -> p=0 -> 4*0.65 = 2.6, p=1 -> 4*1.35 = 5.4, avg pressure = 0.5 -> 4 -> radius = 2
  assert.deepEqual(
    inkBounds([{ tool: "pen", width: 4, points: [{ x: -20, y: 10, pressure: 0 }, { x: 200, y: -100, pressure: 1 }] }]),
    { x: -22, y: -102, width: 224, height: 114 },
  );
});

it("blank references export only the minimal ink region, not the origin or viewport", () => {
  // width=4, pressure=0.5 -> radius=2, plus 24px padding -> 52x52
  assert.deepEqual(exportBounds(0, 0, [pen(-2000, 3000)]), { x: -2026, y: 2974, width: 52, height: 52 });
});

it("export raster preserves ordinary density and uniformly downsamples large crops", () => {
  assert.deepEqual(exportRaster({ x: -500, y: -100, width: 800, height: 500 }, 2, 100), { width: 1600, height: 1000 });
  assert.deepEqual(exportRaster({ x: -20000, y: 9000, width: 10000, height: 5000 }, 2, 100), { width: 2000, height: 1000 });
  assert.deepEqual(exportRaster({ x: 10, y: -50000, width: 2000, height: 10000 }, 1, 100), { width: 400, height: 2000 });
  assert.deepEqual(exportRaster({ x: 0, y: 0, width: 1, height: 1e8 }, 2, 100), { width: 1, height: 2000 });
});

it("image scale applies before the fixed cap rather than shrinking an already capped image", () => {
  assert.deepEqual(exportRaster({ x: 0, y: 0, width: 1000, height: 600 }, 1, 50), { width: 500, height: 300 });
  assert.deepEqual(exportRaster({ x: 0, y: 0, width: 6000, height: 4000 }, 1, 50), { width: 2000, height: 1333 });
  assert.deepEqual(exportRaster({ x: 0, y: 0, width: 6000, height: 4000 }, 1, 25), { width: 1500, height: 1000 });
  assert.deepEqual(exportRaster({ x: 0, y: 0, width: 1000, height: 600 }, 2, 50), { width: 1000, height: 600 });
  for (const scale of [0, -1, 101, Infinity, NaN]) {
    assert.throws(() => exportRaster({ x: 0, y: 0, width: 100, height: 100 }, 1, scale), /kept/);
  }
});

it("impossible export bounds fail closed before bitmap allocation", () => {
  for (const width of [0, -1, Infinity, NaN]) {
    assert.throws(() => exportRaster({ x: 0, y: 0, width, height: 100 }, 1, 100), /kept/);
  }
  assert.throws(() => exportRaster({ x: Infinity, y: 0, width: 100, height: 100 }, 1, 100), /kept/);
});

it("erased distant strokes do not expand the crop and Undo restores their bounds", () => {
  const far = pen(-100000, 4000), near = pen(0, 0), erase: Stroke = { tool: "eraser", points: far.points };
  assert.deepEqual(exportBounds(0, 0, [far, near, erase]), { x: -26, y: -26, width: 52, height: 52 });
  assert.ok(exportBounds(0, 0, [far, near])!.width > 100000);
  assert.equal(exportBounds(600, 200, [far, erase]), undefined);
  assert.equal(inkBounds([]), undefined);
});

it("clamps zoom, converts screen-to-world coordinates, and preserves anchor points under zoom and 2-finger pinch", () => {
  assert.equal(clampZoom(0.1), 0.5);
  assert.equal(clampZoom(10), 4);
  assert.equal(clampZoom(NaN), 1);
  assert.equal(clampZoom(2.25), 2.25);

  const origin = viewOrigin(800, 600, { x: 40, y: -20 });
  assert.deepEqual(screenToWorld(origin.x + 100, origin.y - 50, origin, 2), { x: 50, y: -25 });

  // Zoom around anchor (600, 450) from 1x -> 2x keeps the world point under (600, 450) fixed
  const beforeWorld = screenToWorld(600, 450, viewOrigin(800, 600, { x: 20, y: -10 }), 1);
  const zoomed = zoomAroundAnchor(800, 600, { x: 20, y: -10 }, 1, 2, 600, 450);
  assert.equal(zoomed.zoom, 2);
  const afterWorld = screenToWorld(600, 450, viewOrigin(800, 600, zoomed.pan), zoomed.zoom);
  assert.ok(Math.abs(afterWorld.x - beforeWorld.x) < 1e-9);
  assert.ok(Math.abs(afterWorld.y - beforeWorld.y) < 1e-9);

  // Pure 2-finger pan (equal distance) shifts pan 1:1
  const panned = pinchCamera(800, 600, { x: 10, y: 20 }, 1.5, { x: 200, y: 200 }, 100, { x: 240, y: 150 }, 100);
  assert.equal(panned.zoom, 1.5);
  assert.ok(Math.abs(panned.pan.x - 50) < 1e-9);
  assert.ok(Math.abs(panned.pan.y - -30) < 1e-9);

  // Simultaneous 2-finger pinch-zoom + pan keeps startMid's world point glued to currentMid
  const startMid = { x: 300, y: 250 };
  const curMid = { x: 360, y: 210 };
  const worldUnderStart = screenToWorld(startMid.x, startMid.y, viewOrigin(800, 600, { x: -30, y: 15 }), 1);
  const pinched = pinchCamera(800, 600, { x: -30, y: 15 }, 1, startMid, 100, curMid, 200);
  assert.equal(pinched.zoom, 2);
  const worldUnderCur = screenToWorld(curMid.x, curMid.y, viewOrigin(800, 600, pinched.pan), pinched.zoom);
  assert.ok(Math.abs(worldUnderCur.x - worldUnderStart.x) < 1e-9);
  assert.ok(Math.abs(worldUnderCur.y - worldUnderStart.y) < 1e-9);
});
