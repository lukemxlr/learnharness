# Drawing Pad

A trusted-local Core LearnHarness plugin for sketching solutions and staging legible drawings onto learner submissions.
Requires the public [session-view context](../../docs/plugin-view-context.md),
[scoped action shortcuts](../../docs/plugin-authoring.md#action-shortcuts), surfaces,
and image-staging APIs. A version number alone does not establish capabilities;
use host documentation/types matching the target app.

## Core plugin and source reference

Enable Drawing Pad in **Settings → Core plugins**. The app supplies and updates its
code; writable preferences live under `<learning data>/core-plugin-data/drawing-pad/`.
This source project is reference material, not an installable Community copy.
`drawing-pad` is a reserved Core ID even when disabled or missing. A Community fork
needs its own manifest/folder ID and a review of conflicting contribution, tool and
fence names. Do not install this build into a Community `plugins/drawing-pad/` folder.

## Behavior

- **Draw** in teaching/practice top bars (`data-plugin-action="drawing-pad/draw"`)
  toggles the full-bleed Drawing Pad surface. **Draw (unsent)** indicates an
  unfinished local draft exists in the active session. Closing with X or Escape
  preserves the local draft without staging or submitting anything.
- The top bar provides a collapsible **Question** drawer (starts collapsed so the
  canvas center stays unoccluded), a **Grid** (`Karoraster`) toggle rendered on a
  separate non-interactive overlay layer, independent **Light** / **Dark** / **App**
  paper theme buttons, and an **Add to answer** action.
- When expanded, the Question drawer shows the host-selected learner-facing reference
  from `context.view.input` via public `mountMarkdown`. Answer keys, learner drafts,
  selections, confidence, custom payloads, and transcript are never read.
- The bottom floating pill toolbar provides **Undo**, **Redo**, **Pen**, **Eraser**,
  **Hand**, **Clear**, ink color swatches (**Black ink**, **White ink**, **Blue ink**,
  **Red ink**, **Green ink**, **Yellow ink**), and a **Stroke width** slider (`2`–`16` px).
  Drawing a new stroke after Undo clears the Redo stack.
- Pointer input supports **mouse**, **touch**, and pressure-sensitive **pen** (stylus)
  events with `touch-action: none` and pointer capture; secondary touches during an
  active stroke are ignored. **Hand** or right-mouse drag pans the centered world origin
  without altering ink or scaling strokes across viewport resizes.
- Switching between **Light**, **Dark**, and **App** paper themes adapts monochrome
  default strokes so ink remains legible against the active paper background.
- **Add to answer** exports a tightly cropped opaque PNG (honoring Image scale and
  the `2000 × 2000` pixel cap) and calls `stageSubmissionImage` to place a removable
  preview in the active submission dock without sending a turn. If staging fails,
  the surface remains open with an inline error and the draft is preserved.
- Per-question drafts persist locally in `window.localStorage` keyed by
  `(sessionId, questionKey)` so drafts survive closing Draw and page reloads without
  leaking across questions or sessions. **Clear** or accepted submission of that
  question removes only that question's local draft.

## Keyboard shortcuts

Settings → Keyboard → Drawing Pad lists all five actions, including when the pad
is closed. They use the host's shared action/shortcut registry, so Rebind, Clear,
and Reset work without reloading.

| Action | Default |
| --- | --- |
| Draw (toggle open/closed) | Cmd/Ctrl+Shift+D |
| Undo drawing | Cmd/Ctrl+Z |
| Redo drawing | Cmd/Ctrl+Shift+Z |
| Toggle pen/eraser | Cmd/Ctrl+Shift+E |
| Hand (select, not toggle) | Cmd/Ctrl+Shift+H |

These shortcuts are scoped to teaching/practice pages. Undo, Redo, and tool switching
additionally require an open pad with drawing focus and no active gesture, and do not
steal Undo from text inputs, textareas, or contenteditable editors.

## Settings

Settings → Drawing Pad:

- **Dark mode ink color**: default **white** (`#ffffff`) for App paper theme in dark mode.
- **Light mode ink color**: default **black** (`#000000`) for App paper theme in light mode.
  Both fields require six hex digits prefixed with `#`; case-insensitive input saves lowercase.
- **Image scale**: default **50%**; a numeric percentage greater than `0` and at most `100`,
  applied before the fixed `2000 × 2000` export pixel cap.

The backend stores only `{revision, darkInkColor, lightInkColor, imageScale}` in
`data/settings.json`.

## Public-API boundary

Reference content comes solely from click-time `context.view.input`. The backend's
read-only `get-session-poses` operation returns only accepted pose occurrence identifiers
from public native acknowledgment records so new accepted practice problems reset stale
practice sheets. Staging passes PNG bytes through `ctx.stageSubmissionImage`, leaving
upload validation, attachment storage, preview rendering, and submission delivery
under host authority.

## Development

In the extracted authoring kit, copy the shared **kit-root `types/` contents** into
`.sdk/` **before dependency setup**. From `plugins/drawing-pad/`:

```sh
mkdir -p .sdk
cp -R ../../types/. .sdk/
```

In a LearnHarness source checkout instead, `npm run sdk` generates `.sdk/` via
`../../scripts/build-plugin-types.mjs`. It is **checkout-only**, not a command available
in the extracted kit.

With dependencies already available, build without a host checkout:

```sh
npm run build
```

## Tests and boundaries

After SDK/dependency setup, plugin-only checks are:

```sh
npm run typecheck
npm test
```

Unit tests cover settings, public reference projection, stroke/color/width/eraser/undo/redo
mechanics, geometry, per-question local draft persistence/isolation, frontend lifecycle,
staging error preservation, and build-output guards.

## Source reading route

- [`src/main.ts`](src/main.ts): contextual actions/shortcuts, surface lifecycle,
  staging integration, and accepted-submission draft cleanup.
- [`src/sheet.ts`](src/sheet.ts) and [`src/styles.css`](src/styles.css): top bar,
  collapsible question drawer, floating pill toolbar, pointer parity, and grid overlay.
- [`src/state.ts`](src/state.ts): per-question draft state, Undo/Redo stacks, and
  `localStorage` persistence/isolation.
- [`src/strokes.ts`](src/strokes.ts), [`src/theme.ts`](src/theme.ts), and
  [`src/geometry.ts`](src/geometry.ts): adaptive ink colors, quadratic midpoint
  smoothing, Karoraster grid rendering, and world/export geometry.
- [`src/capture.ts`](src/capture.ts) and [`src/reference.ts`](src/reference.ts):
  legible opaque PNG export and host-selected question reference projection.
- [`src/backend.ts`](src/backend.ts), [`src/settings.ts`](src/settings.ts),
  [`scripts/build.mjs`](scripts/build.mjs), and [`tests/`](tests/): preferences,
  validation, packaging, and unit tests.

See the [example map](../../docs/plugin-examples.md),
[authoring guide](../../docs/plugin-authoring.md) and
[API reference](../../docs/plugin-api/README.md).

## License

AGPL-3.0-only. See [`LICENSE`](LICENSE) and [`THIRD-PARTY.md`](THIRD-PARTY.md)
for bundled package attribution.
