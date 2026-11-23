import type { PluginFrontendContext, PluginSessionViewInput } from "learnharness-plugin-api";
import { CHEVRON_DOWN, CHEVRON_UP, ERASER, GRID, HAND, PEN, REDO, STYLUS, TRASH, UNDO } from "./icons.ts";
import { mountReference, referenceFor } from "./reference.ts";
import { DEFAULT_ZOOM, pinchCamera, screenToWorld, viewOrigin, zoomAroundAnchor } from "./geometry.ts";
import {
  clampStrokeWidth,
  MAX_STROKE_WIDTH,
  MIN_STROKE_WIDTH,
  paintGrid,
  paintInk,
  paintSegment,
  type Point,
  type Stroke,
} from "./strokes.ts";
import type { Draft, PublishReason, SessionSheet, Sheets } from "./state.ts";
import { INK_COLORS, resolvePaperTheme, resolveStrokeColor, type PaperTheme } from "./theme.ts";

const PALM_CONTACT_PX = 24;
const PINCH_CANCEL_STROKE_MS = 350;
const PINCH_CANCEL_STROKE_PX = 30;
const POST_PEN_TOUCH_COOLDOWN_MS = 600;

export interface MountedSheet {
  flush(): void;
  refresh(): void;
  dispose(): void;
  canUseEditingShortcuts(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): void;
  redo(): void;
  togglePenEraser(): void;
  selectHand(): void;
}

function makeButton(className: string, label: string, onClick: () => void, html?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = label;
  button.setAttribute("aria-label", label);
  if (html) button.innerHTML = html;
  else button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

export function mountSheet(
  container: HTMLElement,
  ctx: PluginFrontendContext,
  sheets: Sheets,
  state: SessionSheet,
  questionKey: string,
  input: PluginSessionViewInput,
  signal: AbortSignal,
  onAddToAnswer: () => Promise<void>,
): MountedSheet {
  const root = document.createElement("div");
  root.className = "drawing-pad-root";

  // Hydrate or open draft synchronously so canvas is immediately ready.
  const initialReference = referenceFor(input);
  const pixelRatio = Math.min((typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1, 2);
  sheets.openDraft(state, questionKey, pixelRatio, initialReference);

  const currentDraft = (): Draft =>
    state.drafts.get(questionKey) ?? sheets.openDraft(state, questionKey, pixelRatio, initialReference);

  let disposed = false;
  let staging = false;
  let questionExpanded = false;
  let inlineError: string | undefined;
  let active: Stroke | undefined;
  let activeDraftId: number | undefined;
  let drawPointerId: number | undefined;
  let drawPointerType: string | undefined;
  let drawStartedAt = 0;
  let drawStartClient: { x: number; y: number } | undefined;
  let drawMaxTravelSq = 0;
  let lastPenActivityAt = -Infinity;
  let panDrag: { pointerId: number; x: number; y: number; pan: Draft["pan"]; rightButton: boolean } | undefined;
  const activeTouches = new Map<number, { clientX: number; clientY: number }>();
  let touchGestureLock = false;
  let pinchGesture: {
    id1: number;
    id2: number;
    startMid: { x: number; y: number };
    startDist: number;
    startPan: Draft["pan"];
    startZoom: number;
  } | undefined;
  let canvasFrame: number | undefined;

  const isInteracting = () => drawPointerId !== undefined || panDrag !== undefined || pinchGesture !== undefined;

  const cancelCanvasFrame = () => {
    if (canvasFrame !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(canvasFrame);
    }
    canvasFrame = undefined;
  };

  const releaseCapture = (id: number) => {
    try {
      if (inkCanvas.hasPointerCapture(id)) inkCanvas.releasePointerCapture(id);
    } catch {}
  };

  const discardActiveTouchStroke = () => {
    if (drawPointerType !== "touch") return;
    const staleId = drawPointerId;
    active = undefined;
    activeDraftId = undefined;
    drawPointerId = undefined;
    drawPointerType = undefined;
    drawStartClient = undefined;
    drawMaxTravelSq = 0;
    if (staleId !== undefined) releaseCapture(staleId);
  };

  const commitActive = () => {
    const stroke = active;
    const id = activeDraftId;
    active = undefined;
    activeDraftId = undefined;
    drawPointerId = undefined;
    drawPointerType = undefined;
    drawStartClient = undefined;
    drawMaxTravelSq = 0;
    panDrag = undefined;
    const draft = currentDraft();
    if (stroke && draft.id === id && stroke.points.length > 0) {
      sheets.commitStroke(state, draft, stroke);
    }
  };

  const canUndo = () => !disposed && !signal.aborted && !staging && !isInteracting() && currentDraft().strokes.length > 0;
  const canRedo = () => !disposed && !signal.aborted && !staging && !isInteracting() && currentDraft().redoStack.length > 0;
  const undoHistory = () => { if (canUndo()) sheets.undo(state, currentDraft()); };
  const redoHistory = () => { if (canRedo()) sheets.redo(state, currentDraft()); };
  const clearCanvas = () => {
    if (disposed || signal.aborted || staging || isInteracting()) return;
    inlineError = undefined;
    sheets.clear(state, currentDraft());
  };
  const togglePenEraser = () => {
    if (!disposed && !signal.aborted && !isInteracting()) {
      sheets.setTool(state, state.tool === "pen" ? "eraser" : "pen");
    }
  };
  const selectHand = () => {
    if (!disposed && !signal.aborted && !isInteracting()) {
      sheets.setTool(state, "hand");
    }
  };
  const canUseEditingShortcuts = () => {
    if (disposed || signal.aborted || staging || isInteracting()) return false;
    const focused = document.activeElement;
    return (
      focused instanceof HTMLElement &&
      root.contains(focused) &&
      !focused.isContentEditable &&
      !focused.closest('input:not([type="range"]),textarea,select,[role="textbox"],[role="combobox"]')
    );
  };

  // Place the floating bottom pill BEFORE the topbar in DOM order (positioned
  // visually at bottom via CSS) so color swatches ("Black ink", "White ink")
  // precede paper theme buttons ("Light", "Dark") in accessible query order.
  const pillWrap = document.createElement("div");
  pillWrap.className = "drawing-pad-pill-wrap";
  const pill = document.createElement("div");
  pill.className = "drawing-pad-pill";
  pill.setAttribute("role", "toolbar");
  pill.setAttribute("aria-label", "Drawing tools");

  const undoBtn = makeButton("drawing-pad-tool-btn", "Undo", undoHistory, UNDO);
  const redoBtn = makeButton("drawing-pad-tool-btn", "Redo", redoHistory, REDO);

  const div1 = document.createElement("span");
  div1.className = "drawing-pad-pill-sep";
  div1.setAttribute("aria-hidden", "true");

  const penBtn = makeButton("drawing-pad-tool-btn", "Pen", () => sheets.setTool(state, "pen"), PEN);
  const eraserBtn = makeButton("drawing-pad-tool-btn", "Eraser", () => sheets.setTool(state, "eraser"), ERASER);
  const handBtn = makeButton("drawing-pad-tool-btn", "Hand", () => sheets.setTool(state, "hand"), HAND);
  const clearBtn = makeButton(
    "drawing-pad-tool-btn drawing-pad-clear-btn",
    "Clear",
    clearCanvas,
    `${TRASH}<span class="drawing-pad-btn-label">Clear</span>`,
  );

  const div2 = document.createElement("span");
  div2.className = "drawing-pad-pill-sep";
  div2.setAttribute("aria-hidden", "true");

  const swatchesWrap = document.createElement("div");
  swatchesWrap.className = "drawing-pad-swatches";
  swatchesWrap.setAttribute("role", "group");
  swatchesWrap.setAttribute("aria-label", "Ink color");
  const swatchButtons = INK_COLORS.map((preset) => {
    const btn = makeButton(
      "drawing-pad-swatch",
      preset.label,
      () => sheets.setPenColor(state, preset.hex),
      `<span class="drawing-pad-swatch-dot" style="background:${preset.hex}" data-swatch-id="${preset.id}"></span>`,
    );
    btn.dataset.colorHex = preset.hex;
    swatchesWrap.append(btn);
    return btn;
  });

  const div3 = document.createElement("span");
  div3.className = "drawing-pad-pill-sep";
  div3.setAttribute("aria-hidden", "true");

  const widthWrap = document.createElement("div");
  widthWrap.className = "drawing-pad-width-wrap";
  const widthSlider = document.createElement("input");
  widthSlider.type = "range";
  widthSlider.className = "drawing-pad-width-slider";
  widthSlider.min = String(MIN_STROKE_WIDTH);
  widthSlider.max = String(MAX_STROKE_WIDTH);
  widthSlider.step = "1";
  widthSlider.value = String(state.strokeWidth);
  widthSlider.setAttribute("aria-label", "Stroke width");
  widthSlider.title = "Stroke width";
  const widthValue = document.createElement("span");
  widthValue.className = "drawing-pad-width-value";
  widthValue.setAttribute("aria-hidden", "true");
  widthValue.textContent = `${state.strokeWidth}px`;
  widthSlider.addEventListener("input", () => {
    sheets.setStrokeWidth(state, clampStrokeWidth(Number(widthSlider.value)));
  });
  widthWrap.append(widthSlider, widthValue);

  pill.append(undoBtn, redoBtn, div1, penBtn, eraserBtn, handBtn, clearBtn, div2, swatchesWrap, div3, widthWrap);
  pillWrap.append(pill);

  // Top Header Bar
  const topbar = document.createElement("div");
  topbar.className = "drawing-pad-topbar";
  const topbarLeft = document.createElement("div");
  topbarLeft.className = "drawing-pad-topbar-left";
  const topbarRight = document.createElement("div");
  topbarRight.className = "drawing-pad-topbar-right";

  const questionBtn = makeButton(
    "drawing-pad-top-btn",
    "Question",
    () => {
      questionExpanded = !questionExpanded;
      render();
    },
    `<span class="drawing-pad-top-text">Question</span><span class="drawing-pad-chevron">${CHEVRON_DOWN}</span>`,
  );
  questionBtn.setAttribute("aria-expanded", "false");

  const gridBtn = makeButton(
    "drawing-pad-top-btn",
    "Karoraster grid",
    () => {
      const draft = currentDraft();
      sheets.setGrid(state, draft, !draft.grid);
    },
    `${GRID}<span class="drawing-pad-top-text">Grid</span>`,
  );
  gridBtn.setAttribute("aria-pressed", "false");

  const stylusBtn = makeButton(
    "drawing-pad-top-btn",
    "Stylus only",
    () => {
      sheets.setStylusOnly(state, !state.stylusOnly, true);
    },
    `${STYLUS}<span class="drawing-pad-top-text">Stylus</span>`,
  );
  stylusBtn.title = "Stylus only (palm rejection): ignore single-finger touch; use two fingers to pan and zoom";
  stylusBtn.setAttribute("aria-pressed", String(state.stylusOnly));

  const zoomBtn = makeButton(
    "drawing-pad-top-btn drawing-pad-zoom-btn",
    "Reset zoom",
    () => {
      if (disposed || signal.aborted || staging) return;
      sheets.setCamera(state, currentDraft(), { x: 0, y: 0 }, DEFAULT_ZOOM);
    },
    "100%",
  );
  zoomBtn.title = "Reset zoom and view position";

  topbarLeft.append(questionBtn, gridBtn, stylusBtn, zoomBtn);

  const themeGroup = document.createElement("div");
  themeGroup.className = "drawing-pad-theme-group";
  themeGroup.setAttribute("role", "group");
  themeGroup.setAttribute("aria-label", "Paper theme");

  const themeButtons: Record<PaperTheme, HTMLButtonElement> = {
    light: makeButton("drawing-pad-theme-btn", "Light", () => sheets.setPaperTheme(state, currentDraft(), "light"), "Light"),
    dark: makeButton("drawing-pad-theme-btn", "Dark", () => sheets.setPaperTheme(state, currentDraft(), "dark"), "Dark"),
    app: makeButton("drawing-pad-theme-btn", "App", () => sheets.setPaperTheme(state, currentDraft(), "app"), "App"),
  };
  themeGroup.append(themeButtons.light, themeButtons.dark, themeButtons.app);

  const addBtn = makeButton(
    "drawing-pad-submit-btn",
    "Add to answer",
    () => {
      if (disposed || signal.aborted || staging || !currentDraft().hasInk) return;
      staging = true;
      inlineError = undefined;
      render();
      void onAddToAnswer()
        .catch((error: unknown) => {
          if (disposed || signal.aborted) return;
          inlineError = error instanceof Error && error.message
            ? error.message
            : "Could not add drawing to answer. Your draft has been kept.";
        })
        .finally(() => {
          if (disposed) return;
          staging = false;
          render();
        });
    },
    "Add to answer",
  );

  topbarRight.append(themeGroup, addBtn);
  topbar.append(topbarLeft, topbarRight);

  // Inline staging error banner
  const errorBanner = document.createElement("div");
  errorBanner.className = "drawing-pad-error";
  errorBanner.setAttribute("role", "alert");
  errorBanner.hidden = true;

  // Collapsible Question Drawer (starts collapsed)
  const questionDrawer = document.createElement("div");
  questionDrawer.className = "drawing-pad-question-drawer";
  questionDrawer.hidden = true;
  const questionInner = document.createElement("div");
  questionInner.className = "drawing-pad-question-inner";
  questionDrawer.append(questionInner);

  let referenceMount: ReturnType<typeof mountReference> | undefined;
  const activeRef = initialReference ?? currentDraft().reference;
  if (activeRef) {
    referenceMount = mountReference(questionInner, ctx, activeRef, signal);
  } else {
    const emptyMsg = document.createElement("div");
    emptyMsg.className = "drawing-pad-question-empty";
    emptyMsg.textContent = "No active question for this drawing sheet.";
    questionInner.append(emptyMsg);
  }

  // Main Canvas Viewport
  const viewport = document.createElement("div");
  viewport.className = "drawing-pad-viewport";
  viewport.tabIndex = -1;
  viewport.dataset.pluginInitialFocus = "";
  viewport.setAttribute("role", "group");
  viewport.setAttribute("aria-label", "Drawing sheet");

  const inkCanvas = document.createElement("canvas");
  inkCanvas.className = "drawing-pad-ink";
  inkCanvas.setAttribute("aria-label", "Draw with mouse, touch, or pen; pan with Hand or right mouse drag");

  const gridCanvas = document.createElement("canvas");
  gridCanvas.className = "drawing-pad-grid";
  gridCanvas.setAttribute("aria-hidden", "true");

  viewport.append(inkCanvas, gridCanvas);

  // Order in DOM: pillWrap -> topbar -> errorBanner -> questionDrawer -> viewport
  root.append(pillWrap, topbar, errorBanner, questionDrawer, viewport);
  container.append(root);

  const renderChrome = () => {
    if (disposed) return;
    const draft = currentDraft();
    const paper = resolvePaperTheme(draft.paperTheme, sheets.appInk);
    root.dataset.paperTheme = draft.paperTheme;
    root.dataset.paperMode = paper.mode;
    viewport.style.backgroundColor = paper.backgroundColor;

    // Topbar controls
    questionBtn.setAttribute("aria-expanded", String(questionExpanded));
    const chevron = questionBtn.querySelector(".drawing-pad-chevron");
    if (chevron) chevron.innerHTML = questionExpanded ? CHEVRON_UP : CHEVRON_DOWN;
    questionDrawer.hidden = !questionExpanded;

    gridBtn.setAttribute("aria-pressed", String(draft.grid));
    stylusBtn.setAttribute("aria-pressed", String(state.stylusOnly));
    const zoomPct = Math.round(draft.zoom * 100);
    zoomBtn.textContent = `${zoomPct}%`;
    const isDefaultCamera = Math.abs(draft.zoom - DEFAULT_ZOOM) < 0.005 && Math.abs(draft.pan.x) < 0.5 && Math.abs(draft.pan.y) < 0.5;
    zoomBtn.disabled = staging || isDefaultCamera;
    for (const key of ["light", "dark", "app"] as const) {
      themeButtons[key].setAttribute("aria-pressed", String(draft.paperTheme === key));
    }

    addBtn.disabled = staging || !draft.hasInk;
    if (staging) addBtn.setAttribute("aria-busy", "true");
    else addBtn.removeAttribute("aria-busy");

    errorBanner.hidden = !inlineError;
    errorBanner.textContent = inlineError ?? "";

    // Bottom pill controls
    const busy = isInteracting();
    undoBtn.disabled = staging || busy || !draft.strokes.length;
    redoBtn.disabled = staging || busy || !draft.redoStack.length;
    clearBtn.disabled = staging || busy || (!draft.strokes.length && !draft.redoStack.length && isDefaultCamera);

    penBtn.setAttribute("aria-pressed", String(state.tool === "pen"));
    eraserBtn.setAttribute("aria-pressed", String(state.tool === "eraser"));
    handBtn.setAttribute("aria-pressed", String(state.tool === "hand"));

    const activeResolvedColor = resolveStrokeColor(state.penColor, paper).toLowerCase();
    for (const btn of swatchButtons) {
      const hex = (btn.dataset.colorHex ?? "").toLowerCase();
      btn.setAttribute("aria-pressed", String(state.tool === "pen" && hex === activeResolvedColor));
    }

    if (widthSlider.value !== String(state.strokeWidth)) {
      widthSlider.value = String(state.strokeWidth);
    }
    widthValue.textContent = `${state.strokeWidth}px`;

    inkCanvas.style.cursor = panDrag || pinchGesture ? "grabbing" : state.tool === "hand" ? "grab" : "crosshair";
  };

  const renderCanvas = () => {
    if (disposed) return;
    const draft = currentDraft();
    const paper = resolvePaperTheme(draft.paperTheme, sheets.appInk);
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (!width || !height) return;

    const dpr = Math.min((typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1, 2);
    draft.pixelRatio = dpr;
    const pixelsWide = Math.max(1, Math.round(width * dpr));
    const pixelsHigh = Math.max(1, Math.round(height * dpr));
    if (inkCanvas.width !== pixelsWide) inkCanvas.width = pixelsWide;
    if (inkCanvas.height !== pixelsHigh) inkCanvas.height = pixelsHigh;
    if (gridCanvas.width !== pixelsWide) gridCanvas.width = pixelsWide;
    if (gridCanvas.height !== pixelsHigh) gridCanvas.height = pixelsHigh;

    const origin = viewOrigin(width, height, draft.pan, 0);
    const history = active && activeDraftId === draft.id ? [...draft.strokes, active] : draft.strokes;
    const inkCtx = inkCanvas.getContext("2d", { willReadFrequently: true });
    if (inkCtx && typeof inkCtx.isContextLost === "function" && inkCtx.isContextLost()) return;
    paintInk(inkCanvas, width, height, history, paper, origin, draft.zoom);

    gridCanvas.hidden = !draft.grid;
    if (draft.grid) {
      paintGrid(gridCanvas, width, height, paper.gridColor, origin, 24, draft.zoom);
    } else {
      const gctx = gridCanvas.getContext("2d");
      gctx?.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
    }
  };

  const scheduleCanvasRender = () => {
    if (disposed) return;
    if (typeof requestAnimationFrame !== "function") {
      renderCanvas();
      return;
    }
    if (canvasFrame !== undefined) return;
    canvasFrame = requestAnimationFrame(() => {
      canvasFrame = undefined;
      renderCanvas();
    });
  };

  const render = () => {
    if (disposed) return;
    cancelCanvasFrame();
    renderChrome();
    renderCanvas();
  };

  const point = (event: PointerEvent): Point => {
    const rect = inkCanvas.getBoundingClientRect();
    const draft = currentDraft();
    const origin = viewOrigin(rect.width, rect.height, draft.pan, 0);
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top, origin, draft.zoom);
    return {
      x: world.x,
      y: world.y,
      pressure: event.pointerType === "pen" && event.pressure > 0 ? event.pressure : 0.5,
    };
  };

  const start = (event: PointerEvent) => {
    if (state.tool === "hand") return;
    const draft = currentDraft();
    activeDraftId = draft.id;
    const isEraser = state.tool === "eraser" || (event.buttons & 32) !== 0;
    active = {
      tool: isEraser ? "eraser" : "pen",
      color: state.penColor,
      width: isEraser ? Math.max(12, state.strokeWidth * 2) : state.strokeWidth,
      points: [point(event)],
    };
    render();
  };

  const isPalmTouch = (event: PointerEvent): boolean =>
    event.pointerType === "touch" &&
    ((typeof event.width === "number" && event.width >= PALM_CONTACT_PX) ||
      (typeof event.height === "number" && event.height >= PALM_CONTACT_PX));

  const beginPinchFromTouches = () => {
    const entries = [...activeTouches.entries()];
    if (entries.length < 2) return;
    const [[id1, t1], [id2, t2]] = entries as [[number, { clientX: number; clientY: number }], [number, { clientX: number; clientY: number }]];
    const rect = inkCanvas.getBoundingClientRect();
    const x1 = t1.clientX - rect.left;
    const y1 = t1.clientY - rect.top;
    const x2 = t2.clientX - rect.left;
    const y2 = t2.clientY - rect.top;
    const draft = currentDraft();
    pinchGesture = {
      id1,
      id2,
      startMid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 },
      startDist: Math.max(10, Math.hypot(x2 - x1, y2 - y1)),
      startPan: { ...draft.pan },
      startZoom: draft.zoom,
    };
    touchGestureLock = true;
    renderChrome();
  };

  const down = (event: PointerEvent) => {
    const rightButton = event.pointerType === "mouse" && event.button === 2;
    if (disposed || signal.aborted || staging) return;

    // Touch handling: track ALL non-palm fingers (including non-primary) for
    // reliable 2-finger pinch-zoom + 2-finger pan, and enforce Option A palm rejection.
    if (event.pointerType === "touch") {
      event.preventDefault();
      if (isPalmTouch(event)) return;
      activeTouches.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });

      // Never let touch contacts interrupt an active stylus stroke.
      if (drawPointerType === "pen") return;

      // 2+ fingers always transition into pinch-zoom + 2-finger pan.
      if (activeTouches.size >= 2) {
        if (drawPointerType === "touch") {
          const elapsed = performance.now() - drawStartedAt;
          if (elapsed < PINCH_CANCEL_STROKE_MS || drawMaxTravelSq <= PINCH_CANCEL_STROKE_PX * PINCH_CANCEL_STROKE_PX) {
            discardActiveTouchStroke();
          } else {
            commitActive();
          }
        }
        if (panDrag) {
          releaseCapture(panDrag.pointerId);
          panDrag = undefined;
        }
        if (activeTouches.size === 2) {
          beginPinchFromTouches();
          render();
        }
        return;
      }

      // Single finger after a 2-finger gesture must wait until all fingers lift.
      if (touchGestureLock) return;

      // Explicit Hand tool allows 1-finger panning even when Stylus-only is on.
      if (state.tool === "hand") {
        viewport.focus({ preventScroll: true });
        panDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, pan: { ...currentDraft().pan }, rightButton: false };
        try { inkCanvas.setPointerCapture(event.pointerId); } catch {}
        renderChrome();
        return;
      }

      // Option A palm rejection: when Stylus-only is enabled (or immediately after
      // stylus activity), ignore single-finger touch completely (no ink, no pan).
      if (state.stylusOnly || performance.now() - lastPenActivityAt < POST_PEN_TOUCH_COOLDOWN_MS) {
        return;
      }

      if (drawPointerId !== undefined || !event.isPrimary) return;
      viewport.focus({ preventScroll: true });
      drawPointerId = event.pointerId;
      drawPointerType = "touch";
      drawStartedAt = performance.now();
      drawStartClient = { x: event.clientX, y: event.clientY };
      drawMaxTravelSq = 0;
      try { inkCanvas.setPointerCapture(event.pointerId); } catch {}
      start(event);
      return;
    }

    if (!event.isPrimary) return;

    // Apple Pencil / stylus always wins over any resting palm or uncommitted touch stroke,
    // and automatically enables Option A Stylus-only palm rejection on this device.
    if (event.pointerType === "pen") {
      lastPenActivityAt = performance.now();
      if (drawPointerType === "touch") {
        discardActiveTouchStroke();
      }
      if (panDrag && panDrag.rightButton === false) {
        releaseCapture(panDrag.pointerId);
        panDrag = undefined;
      }
      if (pinchGesture) {
        pinchGesture = undefined;
      }
      if (!state.stylusOnly) {
        sheets.setStylusOnly(state, true, true);
      }
    }

    if (drawPointerId !== undefined || panDrag !== undefined) return;
    if (event.pointerType === "mouse" && event.button !== 0 && !rightButton) return;
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    try { inkCanvas.setPointerCapture(event.pointerId); } catch {}

    if (rightButton || state.tool === "hand") {
      panDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, pan: { ...currentDraft().pan }, rightButton };
      renderChrome();
      return;
    }

    drawPointerId = event.pointerId;
    drawPointerType = event.pointerType;
    drawStartedAt = performance.now();
    drawStartClient = { x: event.clientX, y: event.clientY };
    drawMaxTravelSq = 0;
    if (event.pointerType !== "pen" || event.pressure > 0) {
      start(event);
    }
  };

  const move = (event: PointerEvent) => {
    if (disposed || signal.aborted) return;

    if (event.pointerType === "pen") {
      lastPenActivityAt = performance.now();
    }

    if (event.pointerType === "touch" && activeTouches.has(event.pointerId)) {
      activeTouches.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      if (pinchGesture) {
        const t1 = activeTouches.get(pinchGesture.id1);
        const t2 = activeTouches.get(pinchGesture.id2);
        if (t1 && t2) {
          const rect = inkCanvas.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const x1 = t1.clientX - rect.left;
            const y1 = t1.clientY - rect.top;
            const x2 = t2.clientX - rect.left;
            const y2 = t2.clientY - rect.top;
            const curMid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
            const curDist = Math.max(10, Math.hypot(x2 - x1, y2 - y1));
            const nextCam = pinchCamera(
              rect.width,
              rect.height,
              pinchGesture.startPan,
              pinchGesture.startZoom,
              pinchGesture.startMid,
              pinchGesture.startDist,
              curMid,
              curDist,
            );
            sheets.setCamera(state, currentDraft(), nextCam.pan, nextCam.zoom);
          }
        }
        return;
      }
    }

    if (panDrag && panDrag.pointerId === event.pointerId) {
      if (panDrag.rightButton && (event.buttons & 2) === 0) {
        finish(event);
        return;
      }
      if (event.pointerType !== "pen" || event.pressure > 0) {
        sheets.setPan(state, currentDraft(), {
          x: panDrag.pan.x + event.clientX - panDrag.x,
          y: panDrag.pan.y + event.clientY - panDrag.y,
        });
      }
      return;
    }

    if (drawPointerId !== event.pointerId) return;
    if (state.tool === "hand") return;
    if (drawStartClient) {
      const dx = event.clientX - drawStartClient.x;
      const dy = event.clientY - drawStartClient.y;
      const distSq = dx * dx + dy * dy;
      if (distSq > drawMaxTravelSq) drawMaxTravelSq = distSq;
    }

    const coalesced = event.getCoalescedEvents?.() ?? [];
    const samples = coalesced.length ? coalesced : [event];
    const draft = currentDraft();
    const paper = resolvePaperTheme(draft.paperTheme, sheets.appInk);
    const inkCtx = inkCanvas.getContext("2d", { willReadFrequently: true });

    for (const sample of samples) {
      if (sample.pointerType === "pen" && sample.pressure <= 0) {
        const stroke = active;
        const id = activeDraftId;
        active = undefined;
        activeDraftId = undefined;
        const latestDraft = currentDraft();
        if (stroke && latestDraft.id === id && stroke.points.length > 0) {
          sheets.commitStroke(state, latestDraft, stroke);
        }
        continue;
      }
      const nextTool = (sample.buttons & 32) !== 0 ? "eraser" : state.tool;
      if (active && active.tool !== nextTool) {
        const stroke = active;
        const id = activeDraftId;
        active = undefined;
        activeDraftId = undefined;
        const latestDraft = currentDraft();
        if (latestDraft.id === id && stroke.points.length > 0) {
          sheets.commitStroke(state, latestDraft, stroke);
        }
      }
      if (!active) {
        start(sample);
        continue;
      }
      const next = point(sample);
      const prev = active.points.at(-1)!;
      if (active.tool === "pen" && inkCtx && !(typeof inkCtx.isContextLost === "function" && inkCtx.isContextLost())) {
        paintSegment(
          inkCtx,
          prev,
          next,
          resolveStrokeColor(active.color, paper),
          active.width,
        );
      }
      active.points.push(next);
    }
    if (active?.tool === "eraser") scheduleCanvasRender();
  };

  const finish = (event: PointerEvent) => {
    if (event.pointerType === "pen") {
      lastPenActivityAt = performance.now();
    }

    if (event.pointerType === "touch") {
      activeTouches.delete(event.pointerId);
      if (pinchGesture && (pinchGesture.id1 === event.pointerId || pinchGesture.id2 === event.pointerId)) {
        pinchGesture = undefined;
        renderChrome();
      }
      if (activeTouches.size === 0) {
        touchGestureLock = false;
      }
    }

    if (panDrag && panDrag.pointerId === event.pointerId) {
      if (event.type === "pointerup" && event.pointerType !== "pen") {
        sheets.setPan(state, currentDraft(), {
          x: panDrag.pan.x + event.clientX - panDrag.x,
          y: panDrag.pan.y + event.clientY - panDrag.y,
        });
      }
      panDrag = undefined;
      releaseCapture(event.pointerId);
      render();
      return;
    }

    if (drawPointerId !== event.pointerId) return;
    if (active && event.type === "pointerup" && event.pointerType !== "pen") {
      active.points.push(point(event));
    }
    if (event.type === "pointercancel" && drawPointerType === "touch" && performance.now() - drawStartedAt < PINCH_CANCEL_STROKE_MS) {
      discardActiveTouchStroke();
    } else {
      commitActive();
    }
    releaseCapture(event.pointerId);
    render();
  };

  const onWheel = (event: WheelEvent) => {
    if (disposed || signal.aborted || staging) return;
    event.preventDefault();
    const draft = currentDraft();
    const rect = inkCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-event.deltaY * 0.004);
      const next = zoomAroundAnchor(
        rect.width,
        rect.height,
        draft.pan,
        draft.zoom,
        draft.zoom * factor,
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      sheets.setCamera(state, draft, next.pan, next.zoom);
    } else {
      sheets.setCamera(
        state,
        draft,
        { x: draft.pan.x - event.deltaX, y: draft.pan.y - event.deltaY },
        draft.zoom,
      );
    }
  };

  inkCanvas.addEventListener("contextrestored", render, { signal });
  gridCanvas.addEventListener("contextrestored", render, { signal });
  inkCanvas.addEventListener("pointerdown", down, { signal });
  inkCanvas.addEventListener("pointermove", move, { signal });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    inkCanvas.addEventListener(name, finish, { signal });
  }
  inkCanvas.addEventListener("touchstart", event => {
    if (event.touches.length > 1 && event.cancelable) event.preventDefault();
  }, { signal, passive: false });
  inkCanvas.addEventListener("contextmenu", event => event.preventDefault(), { signal });
  for (const name of ["gesturestart", "gesturechange", "gestureend"] as const) {
    viewport.addEventListener(name, event => event.preventDefault(), { signal });
  }
  viewport.addEventListener("wheel", onWheel, { signal, passive: false });

  const changed = (reason: PublishReason) => {
    if (disposed) return;
    if (reason === "tool") {
      renderChrome();
      return;
    }
    if (reason === "camera") {
      renderChrome();
      scheduleCanvasRender();
      return;
    }
    render();
  };
  const unsubscribe = sheets.onChange(changed);
  const resize = new ResizeObserver(scheduleCanvasRender);
  resize.observe(viewport);
  if (typeof window !== "undefined") {
    window.addEventListener("resize", scheduleCanvasRender, { signal });
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelCanvasFrame();
    commitActive();
    activeTouches.clear();
    pinchGesture = undefined;
    touchGestureLock = false;
    unsubscribe();
    resize.disconnect();
    referenceMount?.dispose();
    signal.removeEventListener("abort", dispose);
    root.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });

  render();

  return {
    flush: commitActive,
    refresh: render,
    dispose,
    canUseEditingShortcuts,
    canUndo,
    canRedo,
    undo: undoHistory,
    redo: redoHistory,
    togglePenEraser,
    selectHand,
  };
}
