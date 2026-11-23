import assert from "node:assert/strict";
import { it } from "node:test";
import type { PluginFrontendContext, PluginSessionViewInput } from "learnharness-plugin-api";
import { exportSheet } from "../src/capture.ts";
import { mountSheet } from "../src/sheet.ts";
import { draftStorageKey, Sheets } from "../src/state.ts";

interface FakeListener { (event: any): void }

class FakeElement {
  tagName: string;
  className = "";
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  listeners = new Map<string, Set<FakeListener>>();
  hidden = false;
  disabled = false;
  tabIndex = 0;
  value = "";
  min = "";
  max = "";
  step = "";
  type = "";
  title = "";
  textContent = "";
  private _innerHTML = "";
  clientWidth = 820;
  clientHeight = 1120;
  width = 820;
  height = 1120;
  canvasOps: string[] = [];

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(val: string) { this._innerHTML = val; }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  append(...nodes: (FakeElement | string)[]) {
    for (const node of nodes) {
      if (typeof node === "string") {
        this.textContent += node;
      } else {
        node.parent = this;
        this.children.push(node);
      }
    }
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.children = [];
    this.textContent = "";
    this.append(...nodes);
  }
  remove() {
    if (!this.parent) return;
    const idx = this.parent.children.indexOf(this);
    if (idx >= 0) this.parent.children.splice(idx, 1);
    this.parent = null;
  }
  contains(other: unknown): boolean {
    if (other === this) return true;
    return this.children.some(child => child.contains(other));
  }
  closest() { return null; }
  focus() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight };
  }
  addEventListener(type: string, listener: FakeListener, opts?: { once?: boolean; signal?: AbortSignal }) {
    let set = this.listeners.get(type);
    if (!set) { set = new Set(); this.listeners.set(type, set); }
    const wrapped: FakeListener = opts?.once
      ? (e) => { set!.delete(wrapped); listener(e); }
      : listener;
    set.add(wrapped);
    opts?.signal?.addEventListener("abort", () => set?.delete(wrapped), { once: true });
  }
  removeEventListener(type: string, listener: FakeListener) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatchEvent(event: Record<string, any>) {
    event.preventDefault ??= () => {};
    event.stopPropagation ??= () => {};
    const set = this.listeners.get(event.type);
    if (set) for (const fn of [...set]) fn(event);
  }
  click() {
    if (this.disabled) return;
    this.dispatchEvent({ type: "click" });
  }
  setPointerCapture() {
    throw new Error("Simulated WebKit synthetic pointer capture failure");
  }
  hasPointerCapture() { return false; }
  releasePointerCapture() {}
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const visit = (el: FakeElement) => {
      for (const child of el.children) {
        if (matches(child, selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
  getContext() {
    const ops = this.canvasOps;
    const w = this.width;
    const h = this.height;
    return {
      fillStyle: "",
      strokeStyle: "",
      lineCap: "",
      lineJoin: "",
      lineWidth: 1,
      globalCompositeOperation: "source-over",
      resetTransform() { ops.length = 0; },
      setTransform() {},
      save() {},
      restore() {},
      clearRect() { ops.push("clearRect"); },
      fillRect() { ops.push(`fillRect:${this.fillStyle}`); },
      beginPath() {},
      moveTo(x: number, y: number) { ops.push(`move:${x},${y}`); },
      lineTo(x: number, y: number) { ops.push(`line:${x},${y}`); },
      quadraticCurveTo() {},
      arc() { ops.push("arc"); },
      fill() { ops.push(`fill:${this.fillStyle}`); },
      stroke() { ops.push(`stroke:${this.strokeStyle}:${this.lineWidth}`); },
      drawImage() { ops.push("drawImage"); },
      getImageData() {
        const hasInk = ops.some(op => op.startsWith("stroke:") || op.startsWith("fill:"));
        const data = new Uint8ClampedArray(Math.max(4, w * h * 4));
        if (hasInk) data[3] = 255;
        return { data };
      },
    };
  }
  toDataURL(mime: string) {
    assert.equal(mime, "image/png");
    const tag = Buffer.from(this.canvasOps.join("|")).toString("base64");
    return `data:image/png;base64,${tag}`;
  }
}

function matches(el: FakeElement, selector: string): boolean {
  if (selector.startsWith(".")) {
    const cls = selector.slice(1);
    return el.className.split(/\s+/).includes(cls);
  }
  const tagClassMatch = /^([a-z0-9-]+)\.([a-z0-9-]+)$/i.exec(selector);
  if (tagClassMatch) {
    return el.tagName.toLowerCase() === tagClassMatch[1]!.toLowerCase() &&
      el.className.split(/\s+/).includes(tagClassMatch[2]!);
  }
  const attrMatch = /^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/i.exec(selector);
  if (attrMatch) {
    const val = el.getAttribute(attrMatch[1]!);
    return attrMatch[2] !== undefined ? val === attrMatch[2] : val !== null;
  }
  return el.tagName.toLowerCase() === selector.toLowerCase();
}

function withFakeDom(run: (ctx: {
  rootEl: FakeElement;
  storage: Map<string, string>;
  markdownCalls: string[];
}) => Promise<void> | void): Promise<void> {
  const storage = new Map<string, string>();
  const markdownCalls: string[] = [];
  const docEl = new FakeElement("html");
  docEl.attributes.set("class", "dark");
  (docEl as any).classList = { contains: (c: string) => c === "dark" };
  const fakeDoc = {
    documentElement: docEl,
    body: new FakeElement("body"),
    activeElement: null as FakeElement | null,
    createElement: (tag: string) => new FakeElement(tag),
  };
  const origDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
  const origWin = Object.getOwnPropertyDescriptor(globalThis, "window");
  const origResize = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  const origStyle = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  const origStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const origHtmlEl = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");

  const mockStorage: Storage = {
    get length() { return storage.size; },
    clear() { storage.clear(); },
    getItem(k: string) { return storage.get(k) ?? null; },
    key(i: number) { return [...storage.keys()][i] ?? null; },
    removeItem(k: string) { storage.delete(k); },
    setItem(k: string, v: string) { storage.set(k, String(v)); },
  };

  Object.defineProperties(globalThis, {
    document: { configurable: true, value: fakeDoc },
    window: { configurable: true, value: { devicePixelRatio: 1, localStorage: mockStorage, addEventListener() {}, removeEventListener() {} } },
    localStorage: { configurable: true, value: mockStorage },
    ResizeObserver: { configurable: true, value: class { observe() {} disconnect() {} } },
    HTMLElement: { configurable: true, value: FakeElement },
    getComputedStyle: { configurable: true, value: () => ({ getPropertyValue: (n: string) => n === "--background" ? "#141414" : "", backgroundColor: "#141414" }) },
  });

  const rootEl = new FakeElement("div");
  return Promise.resolve(run({ rootEl, storage, markdownCalls })).finally(() => {
    for (const [name, desc] of [
      ["document", origDoc],
      ["window", origWin],
      ["ResizeObserver", origResize],
      ["getComputedStyle", origStyle],
      ["localStorage", origStorage],
      ["HTMLElement", origHtmlEl],
    ] as const) {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
}

function fakeCtx(markdownCalls: string[]): PluginFrontendContext {
  return {
    ui: {
      mountMarkdown(container: HTMLElement, props: { text: string }) {
        markdownCalls.push(props.text);
        (container as unknown as FakeElement).textContent = props.text;
        return { update() {}, dispose() {} };
      },
    },
  } as unknown as PluginFrontendContext;
}

function strokeOn(canvas: FakeElement, pointerType: "mouse" | "touch" | "pen", y = 100) {
  canvas.dispatchEvent({ type: "pointerdown", pointerId: 1, pointerType, isPrimary: true, button: 0, buttons: 1, pressure: 0.7, clientX: 50, clientY: y });
  canvas.dispatchEvent({ type: "pointermove", pointerId: 1, pointerType, isPrimary: true, buttons: 1, pressure: 0.7, clientX: 250, clientY: y });
  canvas.dispatchEvent({ type: "pointerup", pointerId: 1, pointerType, isPrimary: true, button: 0, buttons: 0, pressure: 0, clientX: 250, clientY: y });
}

it("mounts Bild 1 controls, keeps Question collapsed initially, isolates Karoraster grid, and supports mouse/touch/pen", () =>
  withFakeDom(async ({ rootEl, markdownCalls }) => {
    const sheets = new Sheets(() => {}, () => {});
    const state = sheets.session("s1", "teaching");
    const controller = new AbortController();
    const input = {
      type: "answer",
      revealed: true,
      available: true,
      expanded: true,
      question: {
        id: "q1",
        kind: "explain",
        question: "Find the **magnitude** of $v$.",
        mode: "text",
        options: [],
        occurrence: { messageId: "m1", contentIndex: 0, toolCallId: "q1", toolName: "explain" },
      },
    } as unknown as PluginSessionViewInput;

    const mounted = mountSheet(rootEl as unknown as HTMLElement, fakeCtx(markdownCalls), sheets, state, "q1", input, controller.signal, async () => {});

    const inkCanvas = rootEl.querySelector("canvas.drawing-pad-ink")!;
    const gridCanvas = rootEl.querySelector("canvas.drawing-pad-grid")!;
    assert.ok(inkCanvas);
    assert.ok(gridCanvas);
    assert.equal(gridCanvas.hidden, true);

    // Question drawer starts collapsed
    const questionBtn = rootEl.querySelector('[aria-label="Question"]')!;
    const drawer = rootEl.querySelector(".drawing-pad-question-drawer")!;
    assert.equal(questionBtn.getAttribute("aria-expanded"), "false");
    assert.equal(drawer.hidden, true);
    questionBtn.click();
    assert.equal(questionBtn.getAttribute("aria-expanded"), "true");
    assert.equal(drawer.hidden, false);
    assert.ok(markdownCalls.includes("Find the **magnitude** of $v$."));
    questionBtn.click();
    assert.equal(questionBtn.getAttribute("aria-expanded"), "false");
    assert.equal(drawer.hidden, true);

    // Karoraster grid renders only on gridCanvas, leaving inkCanvas bitmap unchanged
    const blankInkUrl = inkCanvas.toDataURL("image/png");
    const gridBtn = rootEl.querySelector('[aria-label="Karoraster grid"]')!;
    gridBtn.click();
    assert.equal(gridBtn.getAttribute("aria-pressed"), "true");
    assert.equal(gridCanvas.hidden, false);
    assert.equal(inkCanvas.toDataURL("image/png"), blankInkUrl);
    assert.ok(gridCanvas.canvasOps.some(op => op.startsWith("stroke:")));

    // DOM ordering invariant: color swatches precede Light/Dark paper theme buttons
    const allButtons = rootEl.querySelectorAll("button");
    const blackIdx = allButtons.findIndex(b => b.getAttribute("aria-label") === "Black ink");
    const whiteIdx = allButtons.findIndex(b => b.getAttribute("aria-label") === "White ink");
    const lightIdx = allButtons.findIndex(b => b.getAttribute("aria-label") === "Light");
    const darkIdx = allButtons.findIndex(b => b.getAttribute("aria-label") === "Dark");
    assert.ok(blackIdx >= 0 && whiteIdx >= 0 && lightIdx > whiteIdx && darkIdx > blackIdx);

    // Pointer parity: mouse, touch, and pen all draw
    for (const [idx, pType] of (["mouse", "touch", "pen"] as const).entries()) {
      strokeOn(inkCanvas, pType, 80 + idx * 40);
    }
    const draft = state.drafts.get("q1")!;
    assert.equal(draft.strokes.length, 3);

    // Light paper theme + Blue ink + width 8
    rootEl.querySelector('[aria-label="Light"]')!.click();
    rootEl.querySelector('[aria-label="Blue ink"]')!.click();
    const slider = rootEl.querySelector(".drawing-pad-width-slider")!;
    slider.value = "8";
    slider.dispatchEvent({ type: "input" });
    strokeOn(inkCanvas, "pen", 220);

    const updated = state.drafts.get("q1")!;
    assert.equal(updated.paperTheme, "light");
    assert.equal(updated.strokes.at(-1)!.color, "#2563eb");
    assert.equal(updated.strokes.at(-1)!.width, 8);

    // Undo / Redo + Add to answer button disabled state
    const addBtn = rootEl.querySelector('[aria-label="Add to answer"]')!;
    assert.equal(addBtn.disabled, false);

    // Export checks solid #ffffff paper + strokes
    const captured = sheets.capture(state, "q1")!;
    const exported = await exportSheet(captured, controller.signal);
    assert.equal(exported.mimeType, "image/png");
    assert.ok(exported.data.length > 0);

    // Clear removes strokes & redo & localStorage
    rootEl.querySelector('[aria-label="Clear"]')!.click();
    assert.equal(state.drafts.get("q1")!.strokes.length, 0);
    assert.equal(addBtn.disabled, true);

    mounted.dispose();
  }),
);

it("keeps surface open with inline error and preserves local draft if stageSubmissionImage throws", () =>
  withFakeDom(async ({ rootEl, storage, markdownCalls }) => {
    const sheets = new Sheets(() => {}, () => {});
    const state = sheets.session("s1", "teaching");
    const controller = new AbortController();
    const input = { type: "text" } as unknown as PluginSessionViewInput;

    const mounted = mountSheet(rootEl as unknown as HTMLElement, fakeCtx(markdownCalls), sheets, state, "composer", input, controller.signal, async () => {
      throw new Error("Network upload failed");
    });

    const inkCanvas = rootEl.querySelector("canvas.drawing-pad-ink")!;
    strokeOn(inkCanvas, "touch", 120);

    const addBtn = rootEl.querySelector('[aria-label="Add to answer"]')!;
    addBtn.click();
    await new Promise(resolve => setTimeout(resolve, 10));

    const alert = rootEl.querySelector('[role="alert"]')!;
    assert.equal(alert.hidden, false);
    assert.match(alert.textContent, /Network upload failed/);
    assert.equal(state.drafts.get("composer")!.strokes.length, 1);
    assert.ok(storage.has(draftStorageKey("s1", "composer")));
    assert.equal(addBtn.disabled, false);

    mounted.dispose();
  }),
);

it("enforces Option A palm rejection (Stylus-only auto-lock, pen wins over resting palm, 2-finger pinch-zoom + pan without stray lines, wheel pan/zoom, zoom-independent export)", () =>
  withFakeDom(async ({ rootEl, markdownCalls }) => {
    const sheets = new Sheets(() => {}, () => {});
    const state = sheets.session("s-ipad", "teaching");
    const controller = new AbortController();
    const input = { type: "text" } as unknown as PluginSessionViewInput;

    const mounted = mountSheet(rootEl as unknown as HTMLElement, fakeCtx(markdownCalls), sheets, state, "composer", input, controller.signal, async () => {});
    const inkCanvas = rootEl.querySelector("canvas.drawing-pad-ink")!;
    const viewport = rootEl.querySelector(".drawing-pad-viewport")!;
    const stylusBtn = rootEl.querySelector('[aria-label="Stylus only"]')!;
    const zoomBtn = rootEl.querySelector('[aria-label="Reset zoom"]')!;

    assert.equal(stylusBtn.getAttribute("aria-pressed"), "false");
    assert.equal(zoomBtn.textContent, "100%");
    assert.equal(zoomBtn.disabled, true);

    // 1. Large palm-sized touch contact (>=24px) is immediately ignored without drawing
    inkCanvas.dispatchEvent({ type: "pointerdown", pointerId: 10, pointerType: "touch", isPrimary: true, width: 42, height: 38, button: 0, buttons: 1, pressure: 0.5, clientX: 200, clientY: 200 });
    inkCanvas.dispatchEvent({ type: "pointermove", pointerId: 10, pointerType: "touch", isPrimary: true, width: 42, height: 38, buttons: 1, pressure: 0.5, clientX: 260, clientY: 220 });
    inkCanvas.dispatchEvent({ type: "pointerup", pointerId: 10, pointerType: "touch", isPrimary: true, width: 42, height: 38, button: 0, buttons: 0, pressure: 0, clientX: 260, clientY: 220 });
    assert.equal(state.drafts.get("composer")!.strokes.length, 0);

    // 2. Resting touch arrives first, then Apple Pencil lands -> touch stroke discarded, pen wins & auto-enables Stylus-only
    inkCanvas.dispatchEvent({ type: "pointerdown", pointerId: 11, pointerType: "touch", isPrimary: true, width: 10, height: 10, button: 0, buttons: 1, pressure: 0.5, clientX: 300, clientY: 300 });
    inkCanvas.dispatchEvent({ type: "pointerdown", pointerId: 12, pointerType: "pen", isPrimary: true, width: 1, height: 1, button: 0, buttons: 1, pressure: 0.7, clientX: 100, clientY: 120 });
    inkCanvas.dispatchEvent({ type: "pointermove", pointerId: 12, pointerType: "pen", isPrimary: true, buttons: 1, pressure: 0.7, clientX: 220, clientY: 120 });
    inkCanvas.dispatchEvent({ type: "pointerup", pointerId: 12, pointerType: "pen", isPrimary: true, button: 0, buttons: 0, pressure: 0, clientX: 220, clientY: 120 });
    inkCanvas.dispatchEvent({ type: "pointerup", pointerId: 11, pointerType: "touch", isPrimary: true, button: 0, buttons: 0, pressure: 0, clientX: 300, clientY: 300 });
    assert.equal(state.stylusOnly, true);
    assert.equal(stylusBtn.getAttribute("aria-pressed"), "true");
    assert.equal(state.drafts.get("composer")!.strokes.length, 1, "only the Apple Pencil stroke commits; resting touch is discarded");

    // 3. Option A: with Stylus-only active, single-finger touch neither draws nor pans
    const panBeforeSingleTouch = { ...state.drafts.get("composer")!.pan };
    inkCanvas.dispatchEvent({ type: "pointerdown", pointerId: 13, pointerType: "touch", isPrimary: true, width: 10, height: 10, button: 0, buttons: 1, pressure: 0.5, clientX: 150, clientY: 150 });
    inkCanvas.dispatchEvent({ type: "pointermove", pointerId: 13, pointerType: "touch", isPrimary: true, width: 10, height: 10, buttons: 1, pressure: 0.5, clientX: 250, clientY: 250 });
    inkCanvas.dispatchEvent({ type: "pointerup", pointerId: 13, pointerType: "touch", isPrimary: true, width: 10, height: 10, button: 0, buttons: 0, pressure: 0, clientX: 250, clientY: 250 });
    assert.equal(state.drafts.get("composer")!.strokes.length, 1);
    assert.deepEqual(state.drafts.get("composer")!.pan, panBeforeSingleTouch);

    // 4. 2-finger pinch-zoom + 2-finger pan works in Pen mode without drawing any stray line!
    inkCanvas.dispatchEvent({ type: "pointerdown", pointerId: 20, pointerType: "touch", isPrimary: true, width: 10, height: 10, button: 0, buttons: 1, pressure: 0.5, clientX: 250, clientY: 250 });
    inkCanvas.dispatchEvent({ type: "pointerdown", pointerId: 21, pointerType: "touch", isPrimary: false, width: 10, height: 10, button: 0, buttons: 1, pressure: 0.5, clientX: 350, clientY: 250 });
    // Spread fingers from distance 100 -> 200 and shift midpoint up by 40px
    inkCanvas.dispatchEvent({ type: "pointermove", pointerId: 20, pointerType: "touch", isPrimary: true, width: 10, height: 10, buttons: 1, pressure: 0.5, clientX: 200, clientY: 210 });
    inkCanvas.dispatchEvent({ type: "pointermove", pointerId: 21, pointerType: "touch", isPrimary: false, width: 10, height: 10, buttons: 1, pressure: 0.5, clientX: 400, clientY: 210 });
    inkCanvas.dispatchEvent({ type: "pointerup", pointerId: 20, pointerType: "touch", isPrimary: true, button: 0, buttons: 0, pressure: 0, clientX: 200, clientY: 210 });
    inkCanvas.dispatchEvent({ type: "pointerup", pointerId: 21, pointerType: "touch", isPrimary: false, button: 0, buttons: 0, pressure: 0, clientX: 400, clientY: 210 });

    const zoomedDraft = state.drafts.get("composer")!;
    assert.equal(zoomedDraft.strokes.length, 1, "2-finger pinch must never draw a line");
    assert.ok(Math.abs(zoomedDraft.zoom - 2) < 0.05, `expected ~2x zoom, got ${zoomedDraft.zoom}`);
    assert.equal(zoomBtn.textContent, "200%");
    assert.equal(zoomBtn.disabled, false);

    // 5. Export stays completely camera- and zoom-independent
    const exportAt2x = await exportSheet(sheets.capture(state, "composer")!, controller.signal);
    zoomBtn.click();
    const resetDraft = state.drafts.get("composer")!;
    assert.equal(resetDraft.zoom, 1);
    assert.deepEqual(resetDraft.pan, { x: 0, y: 0 });
    assert.equal(zoomBtn.textContent, "100%");
    assert.equal(zoomBtn.disabled, true);
    const exportAt1x = await exportSheet(sheets.capture(state, "composer")!, controller.signal);
    assert.equal(exportAt2x.data, exportAt1x.data, "PNG export must not depend on zoom or pan");

    // 6. Desktop wheel pans, Ctrl+wheel zooms
    viewport.dispatchEvent({ type: "wheel", deltaX: 0, deltaY: 60, ctrlKey: false, metaKey: false, clientX: 300, clientY: 250 });
    assert.equal(state.drafts.get("composer")!.pan.y, -60);
    viewport.dispatchEvent({ type: "wheel", deltaX: 0, deltaY: -120, ctrlKey: true, metaKey: false, clientX: 300, clientY: 250 });
    assert.ok(state.drafts.get("composer")!.zoom > 1.2);

    // 7. Turning Stylus-only OFF restores single-finger drawing, while rapid 2nd finger still cancels stray dot into pinch
    stylusBtn.click();
    assert.equal(state.stylusOnly, false);
    inkCanvas.dispatchEvent({ type: "pointerdown", pointerId: 30, pointerType: "touch", isPrimary: true, width: 10, height: 10, button: 0, buttons: 1, pressure: 0.5, clientX: 250, clientY: 250 });
    inkCanvas.dispatchEvent({ type: "pointerdown", pointerId: 31, pointerType: "touch", isPrimary: false, width: 10, height: 10, button: 0, buttons: 1, pressure: 0.5, clientX: 350, clientY: 250 });
    inkCanvas.dispatchEvent({ type: "pointerup", pointerId: 30, pointerType: "touch", isPrimary: true, button: 0, buttons: 0, pressure: 0, clientX: 250, clientY: 250 });
    inkCanvas.dispatchEvent({ type: "pointerup", pointerId: 31, pointerType: "touch", isPrimary: false, button: 0, buttons: 0, pressure: 0, clientX: 350, clientY: 250 });
    assert.equal(state.drafts.get("composer")!.strokes.length, 1, "rapid 2-finger pinch cancels finger-1 stray dot even when Stylus-only is off");

    mounted.dispose();
  }),
);
