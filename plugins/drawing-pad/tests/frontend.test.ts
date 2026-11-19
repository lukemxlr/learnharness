import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  PluginAction,
  PluginActionContext,
  PluginActionPlacement,
  PluginFrontendContext,
  PluginNotification,
  PluginSettingsSchema,
  PluginStagedImageInput,
  PluginSubmissionInterceptor,
  PluginSurfaceProps,
} from "learnharness-plugin-api";
import { activate } from "../src/main.ts";

function fixture() {
  const signal = new AbortController();
  const notifications = new Set<(event: PluginNotification) => void>();
  const events = new Set<(event: unknown) => void>();
  const resyncs = new Set<() => void>();
  const actions = new Map<string, PluginAction>();
  const placements: PluginActionPlacement[] = [];
  const interceptors: PluginSubmissionInterceptor[] = [];
  const staged: { target: unknown; image: PluginStagedImageInput }[] = [];
  let schema: PluginSettingsSchema | undefined;
  let surface: PluginSurfaceProps | undefined;
  let closes = 0;
  let disposedSettings = 0;
  let saved = { revision: 0, darkInkColor: "#ffffff", lightInkColor: "#000000", imageScale: 50 };
  const calls: { name: string; value: unknown }[] = [];
  let read: () => unknown | Promise<unknown> = () => ({ ...saved });

  const ctx = {
    manifest: { id: "drawing-pad" },
    signal: signal.signal,
    cleanup() {},
    registerAction(action: PluginAction) {
      actions.set(action.id, action);
      return () => { actions.delete(action.id); };
    },
    placeAction(placement: PluginActionPlacement) {
      placements.push(placement);
      return () => {
        const idx = placements.indexOf(placement);
        if (idx >= 0) placements.splice(idx, 1);
      };
    },
    registerSubmissionInterceptor(def: PluginSubmissionInterceptor) {
      interceptors.push(def);
      return () => {
        const idx = interceptors.indexOf(def);
        if (idx >= 0) interceptors.splice(idx, 1);
      };
    },
    refreshActions() {},
    refreshSubmissions() {},
    async stageSubmissionImage(target: unknown, image: PluginStagedImageInput) {
      staged.push({ target, image });
    },
    registerSettings(value: PluginSettingsSchema) {
      schema = value;
      return {
        update(next: PluginSettingsSchema) { schema = next; },
        dispose() { disposedSettings++; schema = undefined; },
      };
    },
    async call(name: string, value: unknown) {
      calls.push({ name, value });
      if (name === "get-settings") return await read();
      if (name === "set-ink-color" || name === "set-image-scale") {
        saved = { ...saved, ...(value as Partial<typeof saved>), revision: saved.revision + 1 };
        return { ...saved };
      }
      throw new Error(name);
    },
    onNotification(fn: (event: PluginNotification) => void) { notifications.add(fn); return () => notifications.delete(fn); },
    onAppEvent(fn: (event: unknown) => void) { events.add(fn); return () => events.delete(fn); },
    onResync(fn: () => void) { resyncs.add(fn); return () => resyncs.delete(fn); },
    app: { pathname: () => "/opaque-path" },
    ui: {
      openSurface(_target: unknown, props: PluginSurfaceProps) {
        surface = props;
        return { update() {}, dispose() { closes++; surface = undefined; } };
      },
    },
  } as unknown as PluginFrontendContext;

  return {
    ctx,
    actions,
    placements,
    interceptors,
    staged,
    signal,
    notifications,
    events,
    resyncs,
    calls,
    schema: () => schema,
    surface: () => surface,
    closes: () => closes,
    disposedSettings: () => disposedSettings,
    setRead(fn: typeof read) { read = fn; },
    notify(value: unknown) {
      for (const fn of notifications) fn({ pluginId: "drawing-pad", topic: "settings-changed", data: value });
    },
  };
}

it("places top-bar action with id 'draw' (drawing-pad/draw) and registers settings", async () => {
  const f = fixture();
  const off = await activate(f.ctx);
  try {
    assert.equal(f.actions.get("draw")!.name, "Draw");
    assert.deepEqual(f.placements, [
      { id: "draw", actionId: "draw", location: "top-bar", sessions: ["teaching", "practice"] },
    ]);
    assert.equal(f.schema()!.rows.length, 3);
    assert.deepEqual(
      f.schema()!.rows.map(row => [row.type, row.label, row.value]),
      [
        ["text", "Dark mode ink color", "#ffffff"],
        ["text", "Light mode ink color", "#000000"],
        ["number", "Image scale", 50],
      ],
    );
    for (const [index, key, color] of [[0, "darkInkColor", "#123456"], [1, "lightInkColor", "#abcdef"]] as const) {
      const row = f.schema()!.rows[index]!;
      assert.ok(row.validate?.("invalid" as never));
      assert.equal(row.validate?.(color as never), undefined);
      await row.onChange(color as never);
      assert.deepEqual(f.calls.at(-1), { name: "set-ink-color", value: { [key]: color } });
      assert.equal(f.schema()!.rows[index]!.value, color);
    }
    const scale = f.schema()!.rows[2]!;
    assert.ok(scale.validate?.(0 as never));
    assert.equal(scale.validate?.(25 as never), undefined);
    await scale.onChange(25 as never);
    assert.equal(f.schema()!.rows[2]!.value, 25);
  } finally {
    off();
  }
});

it("submission observer never silently attaches images or alters submissions", async () => {
  const f = fixture();
  const off = await activate(f.ctx);
  try {
    assert.equal(f.interceptors.length, 1);
    const obs = f.interceptors[0]!;
    assert.equal(obs.hasPendingInput?.({ type: "text", sessionId: "a", sessionKind: "teaching", surfaceTarget: {} as never, channels: ["content"] }), false);
    const acceptedCallbacks: (() => void | Promise<void>)[] = [];
    const input = { type: "text", content: { text: "hello", images: [] } } as const;
    const out = await obs.intercept(input, {
      type: "text",
      sessionId: "a",
      sessionKind: "teaching",
      surfaceTarget: {} as never,
      channels: ["content"],
      messages: [],
      signal: new AbortController().signal,
      onAccepted(fn) { acceptedCallbacks.push(fn); },
    });
    assert.equal(out, undefined);
    assert.equal(acceptedCallbacks.length, 1);
  } finally {
    off();
  }
});

it("older settings notifications/reads cannot replace a newer accepted value", async () => {
  const f = fixture();
  const off = await activate(f.ctx);
  try {
    f.notify({ revision: 2, darkInkColor: "#123456", lightInkColor: "#abcdef", imageScale: 25 });
    f.notify({ revision: 1, darkInkColor: "#000000", lightInkColor: "#ffffff", imageScale: 100 });
    assert.deepEqual(f.schema()!.rows.map(row => row.value), ["#123456", "#abcdef", 25]);
    f.setRead(() => ({ revision: 0, darkInkColor: "#ffffff", lightInkColor: "#000000", imageScale: 50 }));
    for (const fn of f.resyncs) fn();
    await new Promise<void>(resolve => queueMicrotask(resolve));
    assert.deepEqual(f.schema()!.rows.map(row => row.value), ["#123456", "#abcdef", 25]);
  } finally {
    off();
  }
});

it("declares approved session shortcuts including redo and toggles surface cleanly", async () => {
  const f = fixture();
  const off = await activate(f.ctx);
  try {
    const draw = f.actions.get("draw")!;
    const undo = f.actions.get("undo")!;
    const redo = f.actions.get("redo")!;
    const toggle = f.actions.get("toggle-pen-eraser")!;
    const hand = f.actions.get("hand")!;
    assert.deepEqual(draw.shortcut, { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+shift+d" });
    assert.deepEqual(undo.shortcut, { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+z" });
    assert.deepEqual(redo.shortcut, { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+shift+z" });
    assert.deepEqual(toggle.shortcut, { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+shift+e" });
    assert.deepEqual(hand.shortcut, { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+shift+h" });

    const context = {
      placement: "keyboard",
      surface: "session",
      sessionId: "a",
      kind: "teaching",
      surfaceTarget: {},
      view: { messages: [], input: { type: "unavailable", expanded: false, revealed: false } },
    } as unknown as PluginActionContext;
    const disabled = undo.disabled as (context: PluginActionContext) => boolean;
    assert.equal((toggle.disabled as (context: PluginActionContext) => boolean)(context), true);
    assert.equal((redo.disabled as (context: PluginActionContext) => boolean)(context), true);
    assert.equal((hand.disabled as (context: PluginActionContext) => boolean)(context), true);
    assert.equal(disabled(context), true);

    await draw.run(context);
    assert.equal(f.surface()?.title, "Drawing pad");
    assert.equal(disabled(context), true, "an unmounted/not-ready surface cannot claim drawing Undo");
    await draw.run(context);
    assert.equal(f.surface(), undefined);
    assert.equal(f.closes(), 1);
    assert.equal(disabled({ placement: "keyboard", surface: "app", pathname: "/" }), true);
  } finally {
    off();
  }
});

it("disposal removes registrations/listeners exactly once", async () => {
  const f = fixture();
  const off = await activate(f.ctx);
  off();
  off();
  assert.equal(f.actions.size, 0);
  assert.equal(f.placements.length, 0);
  assert.equal(f.interceptors.length, 0);
  assert.equal(f.notifications.size, 0);
  assert.equal(f.events.size, 0);
  assert.equal(f.resyncs.size, 0);
  assert.equal(f.disposedSettings(), 1);
});

it("late initial settings after activation cancellation cannot create UI registrations", async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  f.setRead(() => new Promise(resolve => { finish = resolve; }));
  const activating = activate(f.ctx);
  await new Promise<void>(resolve => queueMicrotask(resolve));
  f.signal.abort();
  finish({ revision: 0, darkInkColor: "#ffffff", lightInkColor: "#000000", imageScale: 50 });
  const off = await activating;
  assert.equal(f.actions.size, 0);
  assert.equal(f.schema(), undefined);
  off();
});

it("scopes .drawing-pad-root in its own stacking context below the host Close button", () => {
  const stylesPath = fileURLToPath(new URL("../src/styles.css", import.meta.url));
  const css = fs.readFileSync(stylesPath, "utf8");
  const match = css.match(/\.drawing-pad-root\s*\{([^}]*)\}/);
  assert.ok(match, "expected .drawing-pad-root rule in src/styles.css");
  const body = match[1]!;
  assert.match(body, /\bisolation\s*:\s*isolate\s*;/, ".drawing-pad-root must set isolation: isolate");
  assert.match(body, /\bz-index\s*:\s*0\s*;/, ".drawing-pad-root must set z-index: 0");
});
