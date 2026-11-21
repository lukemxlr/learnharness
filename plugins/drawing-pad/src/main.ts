import type {
  PluginAction,
  PluginActionContext,
  PluginFrontendContext,
  PluginSettingsSchema,
  PluginSurfaceProps,
  PluginWidgetHandle,
} from "learnharness-plugin-api";
import { abortable } from "./abort.ts";
import { exportSheet } from "./capture.ts";
import { PEN } from "./icons.ts";
import { acceptedPoseKeys, parsePoseResponse } from "./poses.ts";
import { colorError, imageScaleError, parseSettings, type Settings } from "./settings.ts";
import { mountSheet, type MountedSheet } from "./sheet.ts";
import { questionKeyForInput, questionKeyForSubmissionTarget, Sheets, type SessionSheet } from "./state.ts";
import { appPalette } from "./theme.ts";

type SessionAction = Extract<PluginActionContext, { surface: "session" }>;

interface OpenPad {
  session: SessionSheet;
  questionKey: string;
  controller: AbortController;
  handle?: PluginWidgetHandle<PluginSurfaceProps>;
  mounted?: MountedSheet;
  closed: boolean;
}

export async function activate(ctx: PluginFrontendContext): Promise<() => void> {
  let disposed = false;
  let open: OpenPad | undefined;
  let current: Settings | undefined;
  let settings: PluginWidgetHandle<PluginSettingsSchema> | undefined;
  const cleanups: (() => void)[] = [];
  const paletteController = new AbortController();
  const pageSessions = new Map<string, string>();
  let hostKey: string | undefined;
  const sheets = new Sheets(
    (reason) => {
      if (disposed || ctx.signal.aborted || reason === "camera" || reason === "tool") return;
      const key = [...sheets.sessions.values()].map(state => `${state.id}:${sheets.pending(state) ? 1 : 0}`).join("|");
      if (key !== hostKey) {
        hostKey = key;
        ctx.refreshActions();
      }
    },
    (state) => {
      if (open?.session === state) close(open);
    },
  );
  function close(pad: OpenPad): void {
    if (pad.closed) return;
    pad.closed = true;
    if (open === pad) open = undefined;
    pad.mounted?.dispose();
    pad.controller.abort();
    pad.handle?.dispose();
  }

  function toggle(context: SessionAction): void {
    if (!context.view) {
      throw new Error("This LearnHarness build does not expose the session view context required by Drawing Pad.");
    }
    const hadState = sheets.sessions.has(context.sessionId);
    const state = sheets.session(context.sessionId, context.kind);
    const questionKey = questionKeyForInput(context.view.input);
    const wasOpen = open?.session === state && open.questionKey === questionKey;
    pageSessions.set(ctx.app.pathname(), state.id);
    sheets.observePoses(state, acceptedPoseKeys(context.view.messages), !hadState);
    if (wasOpen) {
      if (open) close(open);
      return;
    }
    if (open) close(open);

    const pad: OpenPad = {
      session: state,
      questionKey,
      controller: new AbortController(),
      closed: false,
    };
    open = pad;

    const addToAnswer = async () => {
      if (pad.closed || pad.controller.signal.aborted) return;
      pad.mounted?.flush();
      const captured = sheets.capture(state, questionKey);
      if (!captured) return;
      const png = await exportSheet(captured, pad.controller.signal);
      if (pad.closed || pad.controller.signal.aborted) return;
      await ctx.stageSubmissionImage(context.surfaceTarget, {
        mimeType: "image/png",
        data: png.data,
        filename: "drawing.png",
      });
      sheets.markStaged(state, questionKey);
      if (!pad.closed) close(pad);
    };

    try {
      pad.handle = ctx.ui.openSurface(
        context.surfaceTarget,
        {
          title: "Drawing pad",
          background: "opaque",
          content(container, signal) {
            if (pad.closed || signal.aborted) return;
            const mounted = mountSheet(
              container,
              ctx,
              sheets,
              state,
              questionKey,
              context.view.input,
              signal,
              addToAnswer,
            );
            pad.mounted = mounted;
            return () => {
              mounted.dispose();
              queueMicrotask(() => {
                if (pad.mounted !== mounted) return;
                pad.mounted = undefined;
                close(pad);
              });
            };
          },
          onClose: () => close(pad),
        },
        { signal: pad.controller.signal },
      );
      if (pad.closed) pad.handle.dispose();
    } catch (error) {
      close(pad);
      throw error;
    }
  }

  const action: PluginAction = {
    id: "draw",
    icon: PEN,
    shortcut: { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+shift+d" },
    get name() {
      const id = pageSessions.get(ctx.app.pathname());
      const state = id ? sheets.sessions.get(id) : undefined;
      return state && sheets.pending(state) ? "Draw (unsent)" : "Draw";
    },
    run(context) {
      if (context.surface === "session") toggle(context);
    },
  };

  function editingPad(context: PluginActionContext): MountedSheet | undefined {
    if (
      disposed ||
      ctx.signal.aborted ||
      context.surface !== "session" ||
      !open ||
      open.closed ||
      open.session.id !== context.sessionId ||
      open.session.kind !== context.kind
    ) {
      return;
    }
    const mounted = open.mounted;
    return mounted?.canUseEditingShortcuts() ? mounted : undefined;
  }

  const undoAction: PluginAction = {
    id: "undo",
    name: "Undo drawing",
    shortcut: { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+z" },
    disabled: context => !editingPad(context)?.canUndo(),
    run(context) { editingPad(context)?.undo(); },
  };

  const redoAction: PluginAction = {
    id: "redo",
    name: "Redo drawing",
    shortcut: { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+shift+z" },
    disabled: context => !editingPad(context)?.canRedo(),
    run(context) { editingPad(context)?.redo(); },
  };

  const toggleToolsAction: PluginAction = {
    id: "toggle-pen-eraser",
    name: "Toggle pen/eraser",
    shortcut: { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+shift+e" },
    disabled: context => !editingPad(context),
    run(context) { editingPad(context)?.togglePenEraser(); },
  };

  const handAction: PluginAction = {
    id: "hand",
    name: "Hand",
    shortcut: { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+shift+h" },
    disabled: context => !editingPad(context),
    run(context) { editingPad(context)?.selectHand(); },
  };

  const rows = (value: Settings): PluginSettingsSchema["rows"] => [
    ...([
      { key: "darkInkColor", label: "Dark mode ink color" },
      { key: "lightInkColor", label: "Light mode ink color" },
    ] as const).map(({ key, label }) => ({
      key,
      type: "text" as const,
      label,
      value: value[key],
      description: "Six-digit hex color used for default monochrome ink when App paper theme is active.",
      validate: colorError,
      async onChange(color: string) {
        applySettings(await ctx.call("set-ink-color", { [key]: color }));
      },
    })),
    {
      key: "imageScale",
      type: "number",
      label: "Image scale",
      value: value.imageScale,
      min: 0,
      max: 100,
      description: "Export percentage (default 50%). Applied before the fixed 2000 × 2000 pixel cap. Does not change the drawing surface.",
      validate: imageScaleError,
      async onChange(imageScale) {
        applySettings(await ctx.call("set-image-scale", { imageScale }));
      },
    },
  ];

  function applySettings(value: unknown): void {
    if (disposed || ctx.signal.aborted) return;
    const next = parseSettings(value);
    if (current && next.revision <= current.revision) return;
    current = next;
    sheets.setImageScale(next.imageScale);
    sheets.setAppInkColors(next.darkInkColor, next.lightInkColor);
    if (settings) settings.update({ rows: rows(next) });
    else settings = ctx.registerSettings({ rows: rows(next) });
  }

  let settingsRead: Promise<void> = Promise.resolve();
  function refreshSettings(): Promise<void> {
    settingsRead = settingsRead.catch(() => {}).then(async () => {
      if (!disposed && !ctx.signal.aborted) applySettings(await ctx.call("get-settings"));
    });
    return settingsRead;
  }

  async function refreshPoses(state: SessionSheet, signal: AbortSignal): Promise<void> {
    const ticket = ++state.readTicket;
    const value = await abortable(ctx.call("get-session-poses", { sessionId: state.id }), signal);
    signal.throwIfAborted();
    if (disposed || sheets.sessions.get(state.id) !== state || ticket !== state.readTicket) return;
    sheets.observePoses(state, parsePoseResponse(value, state.id));
  }

  const report = (error: unknown) => {
    if (!disposed && !ctx.signal.aborted) console.error("Drawing Pad resync failed; retaining existing work.", error);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    paletteController.abort();
    if (open) close(open);
    for (const cleanup of cleanups.splice(0)) cleanup();
    settings?.dispose();
    sheets.dispose();
    pageSessions.clear();
  };

  ctx.cleanup(dispose);

  cleanups.push(
    ctx.onNotification(event => {
      if (event.pluginId === ctx.manifest.id && event.topic === "settings-changed") applySettings(event.data);
    }),
  );

  cleanups.push(
    ctx.onAppEvent(event => {
      const raw = event as { type?: string; chatId?: string; sessionId?: string; questionKey?: string };
      if (raw.type === "submission") {
        const sid = raw.sessionId ?? raw.chatId;
        if (sid && raw.questionKey) sheets.accepted(sid, raw.questionKey);
        return;
      }
      if (event.type !== "turn-settled" && event.type !== "record-changed") return;
      const state = sheets.sessions.get(event.chatId);
      if (state?.kind === "practice") void refreshPoses(state, ctx.signal).catch(report);
    }),
  );

  cleanups.push(
    ctx.onResync(() => {
      void refreshSettings().catch(report);
      for (const state of sheets.sessions.values()) {
        if (state.kind === "practice") void refreshPoses(state, ctx.signal).catch(report);
      }
    }),
  );

  if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
    let lastPaletteKey = appPalette().key;
    const observer = new MutationObserver(() => {
      const nextKey = appPalette().key;
      if (nextKey !== lastPaletteKey) {
        lastPaletteKey = nextKey;
        open?.mounted?.refresh();
        ctx.refreshActions();
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    cleanups.push(() => observer.disconnect());
  }

  try {
    await refreshSettings();
    if (disposed || ctx.signal.aborted) return dispose;
    cleanups.push(ctx.registerAction(action));
    cleanups.push(ctx.registerAction(undoAction));
    cleanups.push(ctx.registerAction(redoAction));
    cleanups.push(ctx.registerAction(toggleToolsAction));
    cleanups.push(ctx.registerAction(handAction));
    cleanups.push(ctx.placeAction({ id: "draw", actionId: "draw", location: "top-bar", sessions: ["teaching", "practice"] }));

    // Observe accepted learner submissions purely to clear the corresponding local draft.
    // Never silently attach un-staged sheets or mutate submission inputs.
    cleanups.push(
      ctx.registerSubmissionInterceptor({
        id: "drawing-draft-cleanup",
        priority: 0,
        hasPendingInput: () => false,
        intercept(_input, subContext) {
          const key = questionKeyForSubmissionTarget(subContext);
          subContext.onAccepted(() => {
            if (!disposed && !ctx.signal.aborted) {
              sheets.accepted(subContext.sessionId, key, subContext.type);
            }
          });
        },
      }),
    );
  } catch (error) {
    dispose();
    throw error;
  }

  return dispose;
}
