import type { PluginSessionViewInput, PluginSubmissionTarget } from "learnharness-plugin-api";
import { clampZoom, DEFAULT_ZOOM } from "./geometry.ts";
import { occurrenceKey } from "./poses.ts";
import { DEFAULT_DARK_INK_COLOR, DEFAULT_IMAGE_SCALE, DEFAULT_LIGHT_INK_COLOR } from "./settings.ts";
import type { Reference } from "./reference.ts";
import {
  clampStrokeWidth,
  DEFAULT_STROKE_WIDTH,
  inkSignature,
  visibleStrokes,
  type Point,
  type Stroke,
  type Tool,
} from "./strokes.ts";
import { resolvePaperTheme, type PaperTheme } from "./theme.ts";

export interface Draft {
  id: number;
  revision: number;
  sessionId: string;
  questionKey: string;
  strokes: Stroke[];
  redoStack: Stroke[];
  paperTheme: PaperTheme;
  grid: boolean;
  pan: { x: number; y: number };
  zoom: number;
  pixelRatio: number;
  hasInk: boolean;
  reference?: Reference;
}

export interface SessionSheet {
  readonly id: string;
  readonly kind: "teaching" | "practice";
  readonly drafts: Map<string, Draft>;
  readonly stagedKeys: Set<string>;
  activeQuestionKey?: string;
  tool: Tool;
  penColor: string;
  strokeWidth: number;
  stylusOnly: boolean;
  readonly seenPoses: Set<string>;
  readTicket: number;
}

export type PublishReason = "sheet" | "ink" | "camera" | "tool";

export interface Capture {
  session: SessionSheet;
  draft: Draft;
  signature: string;
  imageScale: number;
  appInk: { darkInkColor: string; lightInkColor: string };
}

interface PersistedDraft {
  version: 1;
  strokes: Stroke[];
  redoStack: Stroke[];
  paperTheme: PaperTheme;
  grid: boolean;
  pan: { x: number; y: number };
  zoom?: number;
  updatedAt: number;
}

const DRAFT_STORAGE_PREFIX = "lh:drawing-pad:draft:v1:";
const STYLUS_ONLY_STORAGE_KEY = "lh:drawing-pad:stylus-only:v1";
const MAX_PERSISTED_DRAFTS = 24;

function loadStylusOnlyPreference(): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    return storage.getItem(STYLUS_ONLY_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveStylusOnlyPreference(enabled: boolean): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STYLUS_ONLY_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore storage restriction errors.
  }
}

export function draftStorageKey(sessionId: string, questionKey: string): string {
  return `${DRAFT_STORAGE_PREFIX}${sessionId}:${questionKey}`;
}

export function questionKeyForInput(input: PluginSessionViewInput): string {
  switch (input.type) {
    case "answer": return occurrenceKey(input.question.occurrence);
    case "thinking": return occurrenceKey(input.problem.occurrence);
    case "plugin-question-answer": return occurrenceKey(input.question.occurrence);
    case "plugin-problem-submission": return occurrenceKey(input.problem.occurrence);
    default: return "composer";
  }
}

export function questionKeyForSubmissionTarget(target: PluginSubmissionTarget): string {
  switch (target.type) {
    case "answer": return occurrenceKey(target.question.occurrence);
    case "thinking": return occurrenceKey(target.problem.occurrence);
    case "plugin-question-answer": return occurrenceKey(target.question.occurrence);
    case "plugin-problem-submission": return occurrenceKey(target.problem.occurrence);
    default: return "composer";
  }
}

function getStorage(): Storage | undefined {
  try {
    const g = globalThis as { window?: { localStorage?: Storage } };
    if (g.window?.localStorage) return g.window.localStorage;
    const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    if (desc && "value" in desc && desc.value) return desc.value as Storage;
    return undefined;
  } catch {
    return undefined;
  }
}

function isValidPoint(value: unknown): value is Point {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  return typeof p.x === "number" && Number.isFinite(p.x) &&
    typeof p.y === "number" && Number.isFinite(p.y) &&
    typeof p.pressure === "number" && Number.isFinite(p.pressure);
}

function isValidStroke(value: unknown): value is Stroke {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  if (s.tool !== "pen" && s.tool !== "eraser") return false;
  if (s.color !== undefined && typeof s.color !== "string") return false;
  if (s.width !== undefined && (typeof s.width !== "number" || !Number.isFinite(s.width) || s.width <= 0)) return false;
  return Array.isArray(s.points) && s.points.every(isValidPoint);
}

function isPaperTheme(value: unknown): value is PaperTheme {
  return value === "app" || value === "light" || value === "dark";
}

function parsePersistedDraft(raw: string | null): PersistedDraft | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1) return undefined;
    if (!Array.isArray(parsed.strokes) || !parsed.strokes.every(isValidStroke)) return undefined;
    if (!Array.isArray(parsed.redoStack) || !parsed.redoStack.every(isValidStroke)) return undefined;
    if (!isPaperTheme(parsed.paperTheme)) return undefined;
    if (typeof parsed.grid !== "boolean") return undefined;
    const pan = parsed.pan as Record<string, unknown> | undefined;
    if (!pan || typeof pan.x !== "number" || !Number.isFinite(pan.x) || typeof pan.y !== "number" || !Number.isFinite(pan.y)) return undefined;
    const zoom = typeof parsed.zoom === "number" && Number.isFinite(parsed.zoom) ? clampZoom(parsed.zoom) : DEFAULT_ZOOM;
    const updatedAt = typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0;
    return {
      version: 1,
      strokes: parsed.strokes,
      redoStack: parsed.redoStack,
      paperTheme: parsed.paperTheme,
      grid: parsed.grid,
      pan: { x: pan.x, y: pan.y },
      zoom,
      updatedAt,
    };
  } catch {
    return undefined;
  }
}

function hasMeaningfulState(draft: Pick<Draft, "strokes" | "redoStack" | "paperTheme" | "grid" | "pan" | "zoom">): boolean {
  return draft.strokes.length > 0 ||
    draft.redoStack.length > 0 ||
    draft.paperTheme !== "app" ||
    draft.grid ||
    draft.pan.x !== 0 ||
    draft.pan.y !== 0 ||
    draft.zoom !== DEFAULT_ZOOM;
}

function savePersistedDraft(draft: Draft): void {
  const storage = getStorage();
  if (!storage) return;
  const key = draftStorageKey(draft.sessionId, draft.questionKey);
  try {
    if (!hasMeaningfulState(draft)) {
      storage.removeItem(key);
      return;
    }
    const payload: PersistedDraft = {
      version: 1,
      strokes: draft.strokes,
      redoStack: draft.redoStack,
      paperTheme: draft.paperTheme,
      grid: draft.grid,
      pan: draft.pan,
      zoom: draft.zoom,
      updatedAt: Date.now(),
    };
    storage.setItem(key, JSON.stringify(payload));
    pruneOldDrafts(storage, key);
  } catch {
    // Ignore quota or storage restriction errors cleanly without losing in-memory work.
  }
}

function pruneOldDrafts(storage: Storage, keepKey: string): void {
  try {
    const entries: { key: string; updatedAt: number }[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k || !k.startsWith(DRAFT_STORAGE_PREFIX) || k === keepKey) continue;
      const parsed = parsePersistedDraft(storage.getItem(k));
      entries.push({ key: k, updatedAt: parsed?.updatedAt ?? 0 });
    }
    const excess = entries.length + 1 - MAX_PERSISTED_DRAFTS;
    if (excess <= 0) return;
    entries.sort((a, b) => a.updatedAt - b.updatedAt);
    for (let i = 0; i < excess; i++) {
      storage.removeItem(entries[i]!.key);
    }
  } catch {
    // Ignore storage enumeration failures.
  }
}

function loadPersistedDraft(sessionId: string, questionKey: string): PersistedDraft | undefined {
  const storage = getStorage();
  if (!storage) return undefined;
  try {
    return parsePersistedDraft(storage.getItem(draftStorageKey(sessionId, questionKey)));
  } catch {
    return undefined;
  }
}

function removePersistedDraft(sessionId: string, questionKey: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(draftStorageKey(sessionId, questionKey));
  } catch {
    // Ignore storage failures.
  }
}

export class Sheets {
  readonly sessions = new Map<string, SessionSheet>();
  imageScale = DEFAULT_IMAGE_SCALE;
  appInk = { darkInkColor: DEFAULT_DARK_INK_COLOR, lightInkColor: DEFAULT_LIGHT_INK_COLOR };
  private nextId = 0;
  private readonly listeners = new Set<(reason: PublishReason) => void>();

  constructor(
    private readonly changed: (reason: PublishReason) => void,
    private readonly newProblem: (session: SessionSheet) => void,
  ) {}

  onChange(listener: (reason: PublishReason) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private publish(reason: PublishReason): void {
    this.changed(reason);
    for (const listener of this.listeners) listener(reason);
  }

  session(id: string, kind: SessionSheet["kind"]): SessionSheet {
    let state = this.sessions.get(id);
    if (!state) {
      state = {
        id,
        kind,
        drafts: new Map(),
        stagedKeys: new Set(),
        tool: "pen",
        penColor: "auto",
        strokeWidth: DEFAULT_STROKE_WIDTH,
        stylusOnly: loadStylusOnlyPreference(),
        seenPoses: new Set(),
        readTicket: 0,
      };
      this.sessions.set(id, state);
    }
    if (state.kind !== kind) throw new Error("Drawing session kind changed.");
    return state;
  }

  openDraft(state: SessionSheet, questionKey: string, pixelRatio: number, reference?: Reference): Draft {
    state.activeQuestionKey = questionKey;
    const existing = state.drafts.get(questionKey);
    if (existing) {
      existing.pixelRatio = pixelRatio;
      if (reference) existing.reference = reference;
      return existing;
    }
    const persisted = loadPersistedDraft(state.id, questionKey);
    const strokes = persisted?.strokes ?? [];
    const draft: Draft = {
      id: ++this.nextId,
      revision: 0,
      sessionId: state.id,
      questionKey,
      strokes,
      redoStack: persisted?.redoStack ?? [],
      paperTheme: persisted?.paperTheme ?? "app",
      grid: persisted?.grid ?? false,
      pan: persisted?.pan ?? { x: 0, y: 0 },
      zoom: clampZoom(persisted?.zoom ?? DEFAULT_ZOOM),
      pixelRatio,
      hasInk: visibleStrokes(strokes).length > 0,
      reference,
    };
    state.drafts.set(questionKey, draft);
    this.publish("sheet");
    return draft;
  }

  setImageScale(imageScale: number): void {
    this.imageScale = imageScale;
  }

  setAppInkColors(darkInkColor: string, lightInkColor: string): void {
    if (this.appInk.darkInkColor === darkInkColor && this.appInk.lightInkColor === lightInkColor) return;
    this.appInk = { darkInkColor, lightInkColor };
    this.publish("sheet");
  }

  commitStroke(state: SessionSheet, draft: Draft, stroke: Stroke): void {
    if (state.drafts.get(draft.questionKey) !== draft) return;
    const strokes = [...draft.strokes, stroke];
    const next: Draft = {
      ...draft,
      revision: draft.revision + 1,
      strokes,
      redoStack: [],
      hasInk: visibleStrokes(strokes).length > 0,
    };
    state.drafts.set(draft.questionKey, next);
    savePersistedDraft(next);
    this.publish("ink");
  }

  undo(state: SessionSheet, draft: Draft): void {
    const current = state.drafts.get(draft.questionKey);
    if (!current || !current.strokes.length) return;
    const popped = current.strokes.at(-1)!;
    const strokes = current.strokes.slice(0, -1);
    const next: Draft = {
      ...current,
      revision: current.revision + 1,
      strokes,
      redoStack: [...current.redoStack, popped],
      hasInk: visibleStrokes(strokes).length > 0,
    };
    state.drafts.set(draft.questionKey, next);
    savePersistedDraft(next);
    this.publish("ink");
  }

  redo(state: SessionSheet, draft: Draft): void {
    const current = state.drafts.get(draft.questionKey);
    if (!current || !current.redoStack.length) return;
    const restored = current.redoStack.at(-1)!;
    const strokes = [...current.strokes, restored];
    const next: Draft = {
      ...current,
      revision: current.revision + 1,
      strokes,
      redoStack: current.redoStack.slice(0, -1),
      hasInk: visibleStrokes(strokes).length > 0,
    };
    state.drafts.set(draft.questionKey, next);
    savePersistedDraft(next);
    this.publish("ink");
  }

  clear(state: SessionSheet, draft: Draft): void {
    const current = state.drafts.get(draft.questionKey);
    if (!current) return;
    const next: Draft = {
      ...current,
      revision: current.revision + 1,
      strokes: [],
      redoStack: [],
      pan: { x: 0, y: 0 },
      zoom: DEFAULT_ZOOM,
      hasInk: false,
    };
    state.drafts.set(draft.questionKey, next);
    state.stagedKeys.delete(draft.questionKey);
    removePersistedDraft(state.id, draft.questionKey);
    this.publish("ink");
  }

  setPaperTheme(state: SessionSheet, draft: Draft, paperTheme: PaperTheme): void {
    const current = state.drafts.get(draft.questionKey);
    if (!current || current.paperTheme === paperTheme) return;
    const next: Draft = { ...current, revision: current.revision + 1, paperTheme };
    state.drafts.set(draft.questionKey, next);
    savePersistedDraft(next);
    this.publish("sheet");
  }

  setGrid(state: SessionSheet, draft: Draft, grid: boolean): void {
    const current = state.drafts.get(draft.questionKey);
    if (!current || current.grid === grid) return;
    const next: Draft = { ...current, revision: current.revision + 1, grid };
    state.drafts.set(draft.questionKey, next);
    savePersistedDraft(next);
    this.publish("sheet");
  }

  setPan(state: SessionSheet, draft: Draft, pan: { x: number; y: number }): void {
    const current = state.drafts.get(draft.questionKey);
    if (!current) return;
    const next: Draft = { ...current, pan };
    state.drafts.set(draft.questionKey, next);
    savePersistedDraft(next);
    this.publish("camera");
  }

  setCamera(state: SessionSheet, draft: Draft, pan: { x: number; y: number }, zoom: number): void {
    const current = state.drafts.get(draft.questionKey);
    if (!current) return;
    const next: Draft = { ...current, pan, zoom: clampZoom(zoom) };
    state.drafts.set(draft.questionKey, next);
    savePersistedDraft(next);
    this.publish("camera");
  }

  setStylusOnly(state: SessionSheet, enabled: boolean, persist = true): void {
    if (persist) saveStylusOnlyPreference(enabled);
    if (state.stylusOnly === enabled) return;
    state.stylusOnly = enabled;
    this.publish("tool");
  }

  setTool(state: SessionSheet, tool: Tool): void {
    if (state.tool === tool) return;
    state.tool = tool;
    this.publish("tool");
  }

  setPenColor(state: SessionSheet, color: string): void {
    state.penColor = color;
    if (state.tool !== "pen") state.tool = "pen";
    this.publish("tool");
  }

  setStrokeWidth(state: SessionSheet, width: number): void {
    const clamped = clampStrokeWidth(width);
    if (state.strokeWidth === clamped) return;
    state.strokeWidth = clamped;
    this.publish("tool");
  }

  markStaged(state: SessionSheet, questionKey: string): void {
    state.stagedKeys.add(questionKey);
  }

  pending(state: SessionSheet): boolean {
    for (const draft of state.drafts.values()) {
      if (draft.hasInk) return true;
    }
    return false;
  }

  signature(draft: Draft): string {
    if (!draft.hasInk) return "";
    const paper = resolvePaperTheme(draft.paperTheme, this.appInk);
    return inkSignature(draft.strokes, `${draft.paperTheme}:${paper.backgroundColor}`, paper.defaultInk);
  }

  capture(state: SessionSheet, questionKey: string): Capture | undefined {
    const draft = state.drafts.get(questionKey);
    if (!draft || !draft.hasInk) return undefined;
    return {
      session: state,
      draft,
      signature: this.signature(draft),
      imageScale: this.imageScale,
      appInk: { ...this.appInk },
    };
  }

  accepted(sessionId: string, questionKey: string, submissionType?: PluginSubmissionTarget["type"]): void {
    const state = this.sessions.get(sessionId);
    if (submissionType === "thinking" || submissionType === "plugin-problem-submission") {
      if (state && !state.stagedKeys.has(questionKey)) return;
    }
    if (state) {
      state.drafts.delete(questionKey);
      state.stagedKeys.delete(questionKey);
    }
    removePersistedDraft(sessionId, questionKey);
    this.publish("sheet");
  }

  /** Only accepted pose identities reset practice sheets. */
  observePoses(state: SessionSheet, poses: readonly string[], baseline = false): boolean {
    if (state.kind !== "practice") return false;
    const latest = poses.at(-1);
    const newLatest = latest !== undefined && !state.seenPoses.has(latest);
    for (const pose of poses) state.seenPoses.add(pose);
    if (!newLatest || baseline) return false;
    for (const key of state.drafts.keys()) {
      removePersistedDraft(state.id, key);
    }
    state.drafts.clear();
    state.stagedKeys.clear();
    state.tool = "pen";
    this.newProblem(state);
    this.publish("sheet");
    return true;
  }

  dispose(): void {
    this.sessions.clear();
    this.listeners.clear();
  }
}
