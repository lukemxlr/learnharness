import assert from "node:assert/strict";
import { it } from "node:test";
import type { PluginSessionViewInput, PluginSubmissionTarget } from "learnharness-plugin-api";
import { draftStorageKey, questionKeyForInput, questionKeyForSubmissionTarget, Sheets } from "../src/state.ts";
import type { Stroke } from "../src/strokes.ts";

const stroke = (x = 10, color = "auto", width = 4): Stroke => ({
  tool: "pen",
  color,
  width,
  points: [{ x, y: 10, pressure: 0.5 }],
});

function withMockStorage(run: (store: Map<string, string>) => void): void {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(key: string) { return store.get(key) ?? null; },
    key(index: number) { return [...store.keys()][index] ?? null; },
    removeItem(key: string) { store.delete(key); },
    setItem(key: string, value: string) { store.set(key, String(value)); },
  };
  const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  try {
    run(store);
  } finally {
    if (desc) Object.defineProperty(globalThis, "localStorage", desc);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

it("derives identical question keys from view inputs and submission targets", () => {
  const occ = { messageId: "m1", contentIndex: 0, toolCallId: "q1", toolName: "quiz" } as const;
  const viewAnswer = { type: "answer", question: { occurrence: occ } } as unknown as PluginSessionViewInput;
  const subAnswer = { type: "answer", question: { occurrence: occ } } as unknown as PluginSubmissionTarget;
  assert.equal(questionKeyForInput(viewAnswer), questionKeyForSubmissionTarget(subAnswer));
  assert.equal(questionKeyForInput({ type: "text" } as unknown as PluginSessionViewInput), "composer");
  assert.equal(questionKeyForInput({ type: "unavailable", expanded: false, revealed: false } as unknown as PluginSessionViewInput), "composer");
});

it("supports undo, redo, and post-undo branch truncation", () => {
  const sheets = new Sheets(() => {}, () => {});
  const state = sheets.session("s1", "teaching");
  const draft = sheets.openDraft(state, "q1", 1);

  sheets.commitStroke(state, state.drafts.get("q1")!, stroke(10));
  sheets.commitStroke(state, state.drafts.get("q1")!, stroke(20));
  sheets.commitStroke(state, state.drafts.get("q1")!, stroke(30));
  assert.equal(state.drafts.get("q1")!.strokes.length, 3);
  assert.equal(state.drafts.get("q1")!.redoStack.length, 0);

  sheets.undo(state, state.drafts.get("q1")!);
  sheets.undo(state, state.drafts.get("q1")!);
  assert.equal(state.drafts.get("q1")!.strokes.length, 1);
  assert.equal(state.drafts.get("q1")!.redoStack.length, 2);

  sheets.redo(state, state.drafts.get("q1")!);
  assert.equal(state.drafts.get("q1")!.strokes.length, 2);
  assert.equal(state.drafts.get("q1")!.redoStack.length, 1);

  // Branching stroke truncates redoStack
  sheets.commitStroke(state, state.drafts.get("q1")!, stroke(99, "#2563eb", 8));
  assert.equal(state.drafts.get("q1")!.strokes.length, 3);
  assert.equal(state.drafts.get("q1")!.redoStack.length, 0);
  assert.equal(draft.id > 0, true);
});

it("persists drafts per (sessionId, questionKey) across reloads and isolates questions/sessions", () => withMockStorage((store) => {
  const sheets1 = new Sheets(() => {}, () => {});
  const s1 = sheets1.session("sess-1", "teaching");
  sheets1.openDraft(s1, "q1", 2);
  sheets1.commitStroke(s1, s1.drafts.get("q1")!, stroke(15, "#2563eb", 8));
  sheets1.setPaperTheme(s1, s1.drafts.get("q1")!, "light");
  sheets1.setGrid(s1, s1.drafts.get("q1")!, true);
  sheets1.setPan(s1, s1.drafts.get("q1")!, { x: 24, y: -12 });

  assert.ok(store.has(draftStorageKey("sess-1", "q1")));

  // Simulate full page reload with new Sheets instance
  const sheets2 = new Sheets(() => {}, () => {});
  const s1Reloaded = sheets2.session("sess-1", "teaching");
  const restored = sheets2.openDraft(s1Reloaded, "q1", 2);
  assert.equal(restored.strokes.length, 1);
  assert.equal(restored.strokes[0]!.color, "#2563eb");
  assert.equal(restored.strokes[0]!.width, 8);
  assert.equal(restored.paperTheme, "light");
  assert.equal(restored.grid, true);
  assert.deepEqual(restored.pan, { x: 24, y: -12 });

  // Q2 in same session and Q1 in another session open clean
  const q2 = sheets2.openDraft(s1Reloaded, "q2", 2);
  assert.equal(q2.strokes.length, 0);
  assert.equal(q2.paperTheme, "app");
  assert.equal(q2.grid, false);

  const s2 = sheets2.session("sess-2", "teaching");
  const otherSession = sheets2.openDraft(s2, "q1", 2);
  assert.equal(otherSession.strokes.length, 0);
}));

it("clear and accepted submission delete only the targeted draft from localStorage", () => withMockStorage((store) => {
  const sheets = new Sheets(() => {}, () => {});
  const s1 = sheets.session("sess-1", "teaching");
  sheets.openDraft(s1, "q1", 1);
  sheets.commitStroke(s1, s1.drafts.get("q1")!, stroke(10));
  sheets.openDraft(s1, "q2", 1);
  sheets.commitStroke(s1, s1.drafts.get("q2")!, stroke(20));

  const s2 = sheets.session("sess-2", "teaching");
  sheets.openDraft(s2, "q1", 1);
  sheets.commitStroke(s2, s2.drafts.get("q1")!, stroke(30));

  assert.equal(store.size, 3);

  // Accepted submission clears only (sess-1, q1)
  sheets.accepted("sess-1", "q1", "answer");
  assert.equal(store.has(draftStorageKey("sess-1", "q1")), false);
  assert.equal(store.has(draftStorageKey("sess-1", "q2")), true);
  assert.equal(store.has(draftStorageKey("sess-2", "q1")), true);

  // Clear deletes only (sess-1, q2)
  sheets.clear(s1, s1.drafts.get("q2")!);
  assert.equal(store.has(draftStorageKey("sess-1", "q2")), false);
  assert.equal(store.has(draftStorageKey("sess-2", "q1")), true);
}));

it("handles corrupt storage entries gracefully and bounds persisted drafts via LRU", () => withMockStorage((store) => {
  store.set(draftStorageKey("sess-1", "corrupt"), "{bad json");
  const sheets = new Sheets(() => {}, () => {});
  const state = sheets.session("sess-1", "teaching");
  const recovered = sheets.openDraft(state, "corrupt", 1);
  assert.equal(recovered.strokes.length, 0);

  for (let i = 0; i < 30; i++) {
    const k = `q-${i}`;
    sheets.openDraft(state, k, 1);
    sheets.commitStroke(state, state.drafts.get(k)!, stroke(i));
  }
  const keys = [...store.keys()].filter(k => k.startsWith("lh:drawing-pad:draft:v1:"));
  assert.ok(keys.length <= 24);
}));

it("practice pose observation resets drafts only on a genuinely new accepted pose", () => withMockStorage((store) => {
  let resets = 0;
  const sheets = new Sheets(() => {}, () => resets++);
  const state = sheets.session("p1", "practice");
  sheets.observePoses(state, ["pose1"], true);
  sheets.openDraft(state, "pose1", 1);
  sheets.commitStroke(state, state.drafts.get("pose1")!, stroke(10));
  assert.equal(store.has(draftStorageKey("p1", "pose1")), true);

  sheets.observePoses(state, ["pose1"]);
  assert.equal(resets, 0);
  assert.equal(state.drafts.get("pose1")!.strokes.length, 1);

  sheets.observePoses(state, ["pose1", "pose2"]);
  assert.equal(resets, 1);
  assert.equal(state.drafts.size, 0);
  assert.equal(store.has(draftStorageKey("p1", "pose1")), false);
}));
