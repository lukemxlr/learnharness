import type { PluginFrontendContext, PluginSessionViewInput } from "learnharness-plugin-api";
import { CHEVRON_DOWN, CHEVRON_UP, ERASER, GRID, HAND, PEN, REDO, TRASH, UNDO } from "./icons.ts";
import { mountReference, referenceFor } from "./reference.ts";
import { viewOrigin } from "./geometry.ts";
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
import type { Draft, SessionSheet, Sheets } from "./state.ts";
import { INK_COLORS, resolvePaperTheme, resolveStrokeColor, type PaperTheme } from "./theme.ts";

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
  let activePointerType: string | undefined;
  let activeStartedAt = 0;
  let pointerId: number | undefined;
  let panDrag: { x: number; y: number; pan: Draft["pan"]; rightButton: boolean } | undefined;

  const commitActive = () => {
    const stroke = active;
    const id = activeDraftId;
    active = undefined;
    activeDraftId = undefined;
    activePointerType = undefined;
    panDrag = undefined;
    const draft = currentDraft();
    if (stroke && draft.id === id && stroke.points.length > 0) {
      sheets.commitStroke(state, draft, stroke);
    }
  };

  const canUndo = () => !disposed && !signal.aborted && !staging && pointerId === undefined && currentDraft().strokes.length > 0;
  const canRedo = () => !disposed && !signal.aborted && !staging && pointerId === undefined && currentDraft().redoStack.length > 0;
  const undoHistory = () => { if (canUndo()) sheets.undo(state, currentDraft()); };
  const redoHistory = () => { if (canRedo()) sheets.redo(state, currentDraft()); };
  const clearCanvas = () => {
    if (disposed || signal.aborted || staging || pointerId !== undefined) return;
    inlineError = undefined;
    sheets.clear(state, currentDraft());
  };
  const togglePenEraser = () => {
    if (!disposed && !signal.aborted && pointerId === undefined) {
      sheets.setTool(state, state.tool === "pen" ? "eraser" : "pen");
    }
  };
  const selectHand = () => {
    if (!disposed && !signal.aborted && pointerId === undefined) {
      sheets.setTool(state, "hand");
    }
  };
  const canUseEditingShortcuts = () => {
    if (disposed || signal.aborted || staging || pointerId !== undefined) return false;
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

  topbarLeft.append(questionBtn, gridBtn);

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

  const render = () => {
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
    for (const key of ["light", "dark", "app"] as const) {
      themeButtons[key].setAttribute("aria-pressed", String(draft.paperTheme === key));
    }

    addBtn.disabled = staging || !draft.hasInk;
    if (staging) addBtn.setAttribute("aria-busy", "true");
    else addBtn.removeAttribute("aria-busy");

    errorBanner.hidden = !inlineError;
    errorBanner.textContent = inlineError ?? "";

    // Bottom pill controls
    undoBtn.disabled = staging || pointerId !== undefined || !draft.strokes.length;
    redoBtn.disabled = staging || pointerId !== undefined || !draft.redoStack.length;
    clearBtn.disabled = staging || pointerId !== undefined || (!draft.strokes.length && !draft.redoStack.length && draft.pan.x === 0 && draft.pan.y === 0);

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

    inkCanvas.style.cursor = panDrag ? "grabbing" : state.tool === "hand" ? "grab" : "crosshair";

    // Canvas backing buffers and painting
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
    paintInk(inkCanvas, width, height, history, paper, origin);

    gridCanvas.hidden = !draft.grid;
    if (draft.grid) {
      paintGrid(gridCanvas, width, height, paper.gridColor, origin, 24);
    } else {
      const gctx = gridCanvas.getContext("2d");
      gctx?.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
    }
  };

  const point = (event: PointerEvent): Point => {
    const rect = inkCanvas.getBoundingClientRect();
    const draft = currentDraft();
    const origin = viewOrigin(rect.width, rect.height, draft.pan, 0);
    return {
      x: event.clientX - rect.left - origin.x,
      y: event.clientY - rect.top - origin.y,
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

  const down = (event: PointerEvent) => {
    const rightButton = event.pointerType === "mouse" && event.button === 2;
    if (disposed || signal.aborted || staging || !event.isPrimary) return;
    // Apple Pencil priority / palm rejection: if a fresh uncommitted touch contact
    // just landed (<250ms, <=4 samples) and an active stylus ("pen") touches down,
    // discard the accidental palm stroke without committing to undo history.
    if (
      pointerId !== undefined &&
      event.pointerType === "pen" &&
      activePointerType === "touch" &&
      !panDrag &&
      active &&
      active.points.length <= 4 &&
      performance.now() - activeStartedAt < 250
    ) {
      const staleId = pointerId;
      active = undefined;
      activeDraftId = undefined;
      activePointerType = undefined;
      pointerId = undefined;
      try {
        if (inkCanvas.hasPointerCapture(staleId)) inkCanvas.releasePointerCapture(staleId);
      } catch {}
    }
    if (pointerId !== undefined) return;
    if (event.pointerType === "mouse" && event.button !== 0 && !rightButton) return;
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    pointerId = event.pointerId;
    activePointerType = event.pointerType;
    activeStartedAt = performance.now();
    try { inkCanvas.setPointerCapture(event.pointerId); } catch {}
    if (rightButton || state.tool === "hand") {
      panDrag = { x: event.clientX, y: event.clientY, pan: currentDraft().pan, rightButton };
      render();
    } else if (event.pointerType !== "pen" || event.pressure > 0) {
      start(event);
    }
  };

  const move = (event: PointerEvent) => {
    if (disposed || signal.aborted || pointerId !== event.pointerId) return;
    if (panDrag) {
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
    if (state.tool === "hand") return;
    const coalesced = event.getCoalescedEvents?.() ?? [];
    const samples = coalesced.length ? coalesced : [event];
    const draft = currentDraft();
    const paper = resolvePaperTheme(draft.paperTheme, sheets.appInk);
    const inkCtx = inkCanvas.getContext("2d");

    for (const sample of samples) {
      if (sample.pointerType === "pen" && sample.pressure <= 0) {
        commitActive();
        continue;
      }
      const nextTool = (sample.buttons & 32) !== 0 ? "eraser" : state.tool;
      if (active && active.tool !== nextTool) commitActive();
      if (!active) {
        start(sample);
        continue;
      }
      const next = point(sample);
      const prev = active.points.at(-1)!;
      if (active.tool === "pen" && inkCtx) {
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
    if (active?.tool === "eraser") render();
  };

  const finish = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    if (panDrag && event.type === "pointerup" && event.pointerType !== "pen") {
      sheets.setPan(state, currentDraft(), {
        x: panDrag.pan.x + event.clientX - panDrag.x,
        y: panDrag.pan.y + event.clientY - panDrag.y,
      });
    }
    if (active && event.type === "pointerup" && event.pointerType !== "pen") {
      active.points.push(point(event));
    }
    commitActive();
    pointerId = undefined;
    activePointerType = undefined;
    try {
      if (inkCanvas.hasPointerCapture(event.pointerId)) {
        inkCanvas.releasePointerCapture(event.pointerId);
      }
    } catch {}
    render();
  };

  inkCanvas.addEventListener("pointerdown", down, { signal });
  inkCanvas.addEventListener("pointermove", move, { signal });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    inkCanvas.addEventListener(name, finish, { signal });
  }
  inkCanvas.addEventListener("touchstart", event => {
    if (event.touches.length > 1 && event.cancelable) event.preventDefault();
  }, { signal, passive: false });
  inkCanvas.addEventListener("contextmenu", event => event.preventDefault(), { signal });
  viewport.addEventListener("gesturestart", event => event.preventDefault(), { signal });
  viewport.addEventListener("wheel", event => event.preventDefault(), { signal, passive: false });

  const unsubscribe = sheets.onChange(render);
  const resize = new ResizeObserver(render);
  resize.observe(viewport);
  if (typeof window !== "undefined") {
    window.addEventListener("resize", render, { signal });
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    commitActive();
    pointerId = undefined;
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
