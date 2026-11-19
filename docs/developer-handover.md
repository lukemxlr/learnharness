# Developer Handover

This document summarizes the architecture, key engineering decisions, module layout, on-disk data formats, Docker/E2E verification commands, tested viewports, and remaining open hardware/VM tasks for the `feat/lxc-server-ipad-draw-migration` extension branch.

---

## 1. Architecture & Key Decisions

### 1.1 4-Zone Module Boundaries (`eslint.config.mjs`)

LearnHarness enforces strict unidirectional dependencies via `import/no-restricted-paths` in [`eslint.config.mjs`](../eslint.config.mjs):

1. **Zone 1 (`components/**`)**: Browser/React UI imports **only** `@/src/core` (`src/core/index.ts`). Zero Node built-ins, zero `src/server`, zero `src/store`, zero `src/agent`.
2. **Zone 2 (`app/**`)**: Next.js App Router pages and API route handlers import **only** `@/src/core` and `@/src/server` (`src/server/index.ts`).
3. **Zone 3 (`src/core/**`)**: Pure domain types, contracts, and projections; never imports `src/agent`, `src/server`, or `src/store`.
4. **Zone 4 (`src/agent/**`)**: Agent loops, tools, PDF/image helpers, and prompt composition; never imports `src/server` or `src/store` (storage/runtime ports are passed in as closures/factories from `src/server/chat-handler.ts`).

`tests/**`, `scripts/**`, and `electron/**` sit outside the 4-zone restriction.

### 1.2 Single-Account Auth & Reverse-Proxy Trust

- **Files:** [`src/core/contracts/auth.ts`](../src/core/contracts/auth.ts), [`src/server/user-auth.ts`](../src/server/user-auth.ts), [`src/server/desktop-access.ts`](../src/server/desktop-access.ts), [`proxy.ts`](../proxy.ts), [`scripts/user-auth.mjs`](../scripts/user-auth.mjs), [`src/server/plugin-transport.ts`](../src/server/plugin-transport.ts).
- **Decisions:**
  - Single-account credential file `user-auth.json` (`0600`) lives in `dirname(LH_AUTH_FILE)` (outside `LH_DATA_DIR`), managed solely by `scripts/user-auth.mjs` (`init`, `reset-password`, `status`) with `scrypt` (`N=16384, r=8, p=1`) and HMAC-SHA256 `lh_session` cookies (`HttpOnly`, `SameSite=Lax`, 30-day TTL, `Secure` when `isHttpsRequest()` is true).
  - No browser-based signup or password reset exists; `reset-password` rotates `sessionSecret`, invalidating all existing cookies.
  - `proxy.ts` gates all UI routes (`302 /login?next=...` via `sanitizeNextPath`, blocking open redirects such as `//evil.com` and `/\`) and `/api/**` (`401`) except `/api/health`, `/api/auth/login`, `/api/auth/logout`, and `/api/auth/session`.
  - The streamed plugin document endpoint (`/api/plugins/[id]/documents/markdown`) bypasses Next Proxy body cloning and enforces identical host, CSRF, and `userAuthRefusal` checks inside `createPluginDocumentRoute`.
  - `LH_TRUST_PROXY=1` honors `X-Forwarded-Proto` and `X-Forwarded-Host` while `parseValidatedHost` + `LH_ALLOWED_HOSTS` block DNS rebinding and malformed host headers.
  - `next.config.ts` (`outputFileTracingExcludes`) and `scripts/build-server.mjs` hard-fail if `data/`, `auth.json`, `user-auth.json*`, `*-credentials.json*`, or `.env*` enter `.next/standalone`.

### 1.3 Content-Addressed Attachment Store & Zone-4 Delivery

- **Files:** [`src/core/contracts/attachments.ts`](../src/core/contracts/attachments.ts), [`src/server/attachments.ts`](../src/server/attachments.ts), [`src/server/attachment-delivery.ts`](../src/server/attachment-delivery.ts), [`src/server/chat-handler.ts`](../src/server/chat-handler.ts), [`src/core/compaction.ts`](../src/core/compaction.ts), [`src/agent/subagents/pdf-ops.ts`](../src/agent/subagents/pdf-ops.ts), [`app/api/attachments/route.ts`](../app/api/attachments/route.ts), [`app/api/attachments/[id]/route.ts`](../app/api/attachments/%5Bid%5D/route.ts).
- **Decisions:**
  - Accepted MIME types: `image/png`, `image/jpeg`, `image/webp`, `image/gif` (max `20 MiB`) and `application/pdf` (max `25 MiB`).
  - `detectAttachmentMimeType` performs magic-byte sniffing (`detectSupportedImageMimeType` for images including APNG rejection/consistency, `%PDF-` within the first `1024` bytes after optional BOM/whitespace for PDFs to reject HTML/`%PDF-` polyglots) and verifies declared MIME matches sniffed bytes.
  - Files are stored content-addressed under `<LH_DATA_DIR>/attachments/<sha256>/<sanitizedFilename>` (sanitizing Windows reserved stems via `WIN32_RESERVED_STEM_RE` and stripping path/control chars) with `<sha256>.meta.json`.
  - `GET /api/attachments/[id]` serves bytes with `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, and `Content-Disposition: inline` (RFC 5987 UTF-8 filename).
  - **Zone-4 compliant hydration (`attachment-delivery.ts`):** `resolveTurnAttachments` and `hydrateMessagesSync` run in `src/server/` before passing messages into `src/agent/`. Images are resized via `processImage` to model limits; PDFs are parsed via `convertPdf` (`pdfjs-dist`, `MAX_ATTACHMENT_PDF_PAGES = 200`) and cached in `<sha256>.extracted.json`. Scanned/image-only PDFs render up to `MAX_ATTACHMENT_PDF_RENDER_PAGES = 10` pages at `150` DPI via `realHeadless.renderPdfPages` (`@napi-rs/canvas`) when the selected model supports `"image"` input. Current-turn attachments fail loudly (`ChatInputError`, preserving user draft/selection) while historical turns degrade gracefully to descriptive text placeholders.

### 1.4 Live Stream Handoff & Keepalive

- **Files:** [`src/server/stream-keepalive.ts`](../src/server/stream-keepalive.ts), [`src/server/pi/ui-stream.ts`](../src/server/pi/ui-stream.ts), [`src/server/side-chat.ts`](../src/server/side-chat.ts), [`app/api/chats/[id]/stream/route.ts`](../app/api/chats/%5Bid%5D/stream/route.ts), [`components/server-events.tsx`](../components/server-events.tsx), [`components/chat.tsx`](../components/chat.tsx), [`components/session-core.ts`](../components/session-core.ts).
- **Decisions:**
  - `runPiTurn` executes each agent turn as a server-owned background handle decoupled from any HTTP response; `POST /api/chat` starts the turn and both initial and secondary clients subscribe to `GET /api/chats/[id]/stream`.
  - Cancelling/closing a client stream detaches only that subscriber without aborting the turn.
  - `resolveStreamKeepaliveMs()` reads `LH_STREAM_KEEPALIVE_MS` (default `15_000` ms, clamped `50`–`2_147_483_647` ms) to emit `: ping\n\n` on SSE (`ui-stream.ts`) and `{"type":"ping"}\n` on NDJSON (`side-chat.ts`), preventing Cloudflare Tunnel / NAT idle timeouts.
  - On EventSource `(re)open` (`useServerResync`), `visibilitychange`, `focus`, or `online`, `Chat` runs `runResync` (`fetchJobs` → `attachToRunningTurn()` if `turnInFlight`, or `syncFromServer()` when settled), allowing seamless mid-stream handoff between Windows Desktop and iPad Safari without starting a second model run.

### 1.5 Isolated Electron Remote Client

- **Files:** [`electron/main.cjs`](../electron/main.cjs), [`electron/remote-config.cjs`](../electron/remote-config.cjs), [`electron/preload-remote.cjs`](../electron/preload-remote.cjs), [`electron/preload-setup.cjs`](../electron/preload-setup.cjs), [`electron/setup.html`](../electron/setup.html), [`electron/remote-reconnect.html`](../electron/remote-reconnect.html), [`electron-builder.yml`](../electron-builder.yml).
- **Decisions:**
  - When `remote-config.json` is `"unset"` or `"remote"` (default on first run unless `--local` or `LH_LOCAL_MODE=1` or `LH_DEV_URL` is set), Electron boots in remote client mode without spawning a local Next server.
  - `preload-remote.cjs` exposes **only** window chrome (`expandWindow`, `setAppearance`, `onZoom`/`getZoom`, `onOpenSettings`, `changeServerUrl`, `isRemoteMode: true`, `platform`). Zero local filesystem (`getPathForFile`, `chooseAttachmentFolder`), OAuth/subscription, or auto-updater bridges are exposed to remote origins.
  - `preload-setup.cjs` (`lhSetup`) is restricted by `isTrustedSetupSender` strictly to local `file:` URLs matching `setup.html` or `remote-reconnect.html`.
  - `remote-config.cjs` validates `http://` / `https://` URLs (rejecting whitespace, credentials, control chars, queries/fragments) and verifies `GET /api/health` (`{"ok":true}`) before persisting `remote-config.json` (`0600`).
  - `installRemoteWebRequestHandlers()` injects a strict `REMOTE_CSP` fallback if headers omit CSP and triggers `remote-reconnect.html` on main-frame `502`/`503`/`504`/`530` or `did-fail-load`.
  - `will-navigate`, `will-redirect`, and `setWindowOpenHandler` lock navigation to `getAllowedOrigin()`, routing external `http:`/`https:`/`mailto:` links to `shell.openExternal`.

### 1.6 Headless ChatGPT Plus OAuth & Dynamic Model Catalog (R6)

- **Files:** [`electron/chatgpt.cjs`](../electron/chatgpt.cjs), [`src/server/web-subscriptions.ts`](../src/server/web-subscriptions.ts), [`src/server/web-subscription-http.ts`](../src/server/web-subscription-http.ts), [`src/agent/chatgpt-bridge.ts`](../src/agent/chatgpt-bridge.ts), [`src/server/model-catalog.ts`](../src/server/model-catalog.ts), [`app/api/models/route.ts`](../app/api/models/route.ts), [`app/api/models/refresh/route.ts`](../app/api/models/refresh/route.ts), [`components/model-catalog.ts`](../components/model-catalog.ts), [`components/settings/chatgpt-connection.tsx`](../components/settings/chatgpt-connection.tsx), [`components/settings/keys-section.tsx`](../components/settings/keys-section.tsx).
- **Decisions & Actual Provider Limits:**
  - **Headless OAuth:** `startHeadlessAuth` in `electron/chatgpt.cjs` binds an ephemeral loopback callback listener on `127.0.0.1:0/auth/callback` and returns `{ authorizeUrl, redirectUri, status }`. Because OpenAI's dynamic client registration (`auth.openai.com`) binds `redirect_uri` to `127.0.0.1`, a remote operator completes login in their local browser and pastes the redirected `http://127.0.0.1:<port>/auth/callback?...` URL into `completeHeadlessAuth` (or uses SSH port forwarding). Loopback overrides (`LH_CHATGPT_OAUTH_ISSUER`, `LH_CHATGPT_API_BASE`) are strictly gated to `NODE_ENV === "test"` or `LH_IGNORE_ENV_KEYS === "1"` and `http://` loopback hosts.
  - **Live ChatGPT catalog vs. static providers:** For ChatGPT Plus, `electron/chatgpt.cjs` fetches `GET ${currentResource()}/models` (`visibility === "list"`) and `refreshChatGPTModels` (`src/agent/chatgpt-bridge.ts`) merges live metadata with `pi-ai`'s `openai-responses` entries, **synthesizing valid `openai-responses` model definitions (`128_000` context / `16_384` maxTokens defaults if omitted)** for newly released slugs so new ChatGPT models appear without updating `@earendil-works/pi-ai`. In contrast, plain API-key providers still come from the installed `@earendil-works/pi-ai` package catalog (adding new static API-key models requires bumping `@earendil-works/pi-ai` or using a custom OpenAI-compatible endpoint).
  - **Cache, error retention & session preservation:** `refreshConnectionCatalog` (`src/server/model-catalog.ts`) caches refreshes for `5` minutes (`DEFAULT_CATALOG_TTL_MS`), coalesces concurrent callers, and exposes forced refresh via `POST /api/models/refresh` (**Refresh models** in Settings). On transient upstream errors, the last-known-good catalog stays intact and `catalogErrors.chatgpt` is surfaced in UI; no silent API-key fallback ever occurs. Because each chat session owns its `settings.model` from creation, catalog refreshes never overwrite existing session models.

### 1.7 Safe Profile Migration (`scripts/migrate-profile.mjs`)

- **Files:** [`src/core/contracts/migration.ts`](../src/core/contracts/migration.ts), [`src/server/migration.ts`](../src/server/migration.ts), [`scripts/migrate-profile.mjs`](../scripts/migrate-profile.mjs).
- **Merge & Safety Semantics:**
  - `exportProfile` is strictly read-only on `sourceDir`, rejects symlinks/path escapes, excludes secrets/debug (`auth.json`, `user-auth.json*`, `*-credentials.json*`, `.env*`, `debug/`), resolves only reachable `/api/attachments/<sha256>` and referenced local files, and writes SHA-256 `fileChecksums` in `manifest.json`.
  - `importProfile` verifies all bundle checksums before any write and supports `--dry-run` (`0` bytes written).
  - **Chats & Jobs:** Compares `effectiveChatModifiedAt` (latest across `modifiedAt`, `updatedAt`, `createdAt`, `sideChats`, `turns`, `extractions`) / job `updatedAt`. Preserves newer or equal-timestamp-differing server records (`skipServerNewer`), skips identical records (`skipUnchanged`), and skips unknown future schemas (`skipNewerSchema`).
  - **Graph ledgers:** Deduplicated append-only union (`nodes.jsonl` by `id` + statements/aliases/provenance; `chains.jsonl` by sorted `premises>conclusion` + provenance; `sessions.jsonl` by `chatId + foldedAt`; `coverage.jsonl` by `chatId + fp` keeping newest `foldedAt`; `sources.json` merges `extractions` and keeps newer `importedAt`; `positions.json` uses `updatedAt` precedence). Legacy `edges.jsonl` / `events.jsonl` are diagnosed without polluting target writes.
  - **Settings:** On non-`win32` targets, `sanitizeFileAccessSettingsForPlatform` strips Windows drive/UNC folders from `agent.fileAccess.folders` while preserving `restricted`, and preserves newer server `settings.json` (`preserve_server`).

### 1.8 Overhauled Drawing Pad & `PluginFrontendContext` Staging

- **Files:** [`plugins/drawing-pad/README.md`](../plugins/drawing-pad/README.md), [`plugins/drawing-pad/src/{main,sheet,state,strokes,theme,geometry,capture,reference,settings,backend}.ts`](../plugins/drawing-pad/src/main.ts), [`components/plugin-surface-targets.ts`](../components/plugin-surface-targets.ts), [`components/chat.tsx`](../components/chat.tsx), [`components/question-dock.tsx`](../components/question-dock.tsx), [`components/practice-dock.tsx`](../components/practice-dock.tsx).
- **Decisions:**
  - `registerSurfaceStaging` binds a `WeakMap<PluginSurfaceTarget, handler>` in `components/plugin-surface-targets.ts` so `stageSubmissionImage` stages PNG bytes through host `POST /api/attachments` into the active composer, question dock, or practice dock without auto-sending a turn.
  - `plugins/drawing-pad` provides `mouse`/`touch`/`pen` parity (`touch-action: none`, secondary-touch rejection), `Karoraster` grid overlay, colors, widths (`2`–`16` px), Undo/Redo, independent `Light`/`Dark`/`App` paper theme with monochrome ink legibility adaptation (`resolveStrokeColor`), cropped opaque PNG export (`imageScale` before `2000 × 2000` cap), and `localStorage` drafts keyed by `(sessionId, questionKey)` (`MAX_PERSISTED_DRAFTS = 24`).
  - **Core plugin default:** Core plugins start disabled by default (`tests/core-plugins.test.ts`); automated/E2E runs testing Drawing Pad must enable `drawing-pad` via `plugins-state.json` or `PUT /api/plugins/drawing-pad`.

---

## 2. Relevant Files & On-Disk Data Formats

### 2.1 Key Modules

| Area | Key Files |
| --- | --- |
| LXC / Systemd | `deploy/systemd/learnharness.service`, `deploy/systemd/learnharness.env.example` |
| Auth & Proxy | `proxy.ts`, `app/login/page.tsx`, `app/api/auth/{login,logout,session}/route.ts`, `src/server/{user-auth,desktop-access,plugin-transport}.ts`, `src/core/contracts/auth.ts`, `scripts/user-auth.mjs` |
| Migration | `scripts/migrate-profile.mjs`, `src/server/migration.ts`, `src/core/contracts/migration.ts` |
| Attachments & PDF | `app/api/attachments/route.ts`, `app/api/attachments/[id]/route.ts`, `src/core/contracts/attachments.ts`, `src/server/{attachments,attachment-delivery}.ts`, `src/agent/subagents/pdf-ops.ts`, `components/{attachment-staging,attach-files-button,path-input,question-dock,practice-dock,composer}.tsx` |
| Streaming & Sync | `src/server/{stream-keepalive,pi/ui-stream,side-chat,chat-handler}.ts`, `app/api/chats/[id]/{route,stream/route}.ts`, `app/api/jobs/route.ts`, `components/{server-events,chat,session,session-core}.ts*` |
| Electron Remote | `electron/{main,remote-config,preload-remote,preload-setup,chatgpt,chatgpt-ipc}.cjs`, `electron/{setup,remote-reconnect}.html`, `electron-builder.yml` |
| ChatGPT & Catalog | `src/agent/chatgpt-bridge.ts`, `src/server/{web-subscriptions,web-subscription-http,model-catalog}.ts`, `app/api/models/{route,refresh/route}.ts`, `app/api/subscriptions/route.ts`, `components/settings/{chatgpt-connection,keys-section}.tsx` |
| Drawing Pad | `plugins/drawing-pad/src/*.ts`, `plugins/drawing-pad/src/styles.css`, `components/plugin-surface-targets.ts` |
| Tests & E2E | `scripts/docker-test.{ps1,sh}`, `docker/Dockerfile.test`, `tests/*.test.ts*`, `tests/e2e/**`, `tests/fixtures/{synthetic-profile,e2e-synthetic}/**` |

### 2.2 On-Disk Data Formats

- **`<dir(LH_AUTH_FILE)>/user-auth.json`** (mode `0600`):
  ```json
  {
    "version": 1,
    "username": "learner",
    "passwordHash": "scrypt$16384$8$1$<16-byte-hex-salt>$<64-byte-hex-dk>",
    "sessionSecret": "<64-char-hex-secret>",
    "updatedAt": "2026-11-19T00:00:00.000Z"
  }
  ```
- **`<LH_DATA_DIR>/attachments/<sha256>/`**:
  - `<LH_DATA_DIR>/attachments/<sha256>/<sanitizedFilename>` — raw binary image or PDF.
  - `<LH_DATA_DIR>/attachments/<sha256>.meta.json` — `{ id, filename, mimeType, sizeBytes, createdAt }`.
  - `<LH_DATA_DIR>/attachments/<sha256>/<sha256>.extracted.json` — `CachedPdfExtraction` (`{ version: 1, id, kind: "text" | "image-only" | "empty", pageCount, markdown?, renderedPages? }`).
- **Electron `<userData>/remote-config.json`** (mode `0600`):
  ```json
  {
    "mode": "remote",
    "serverUrl": "https://learn.example.com",
    "updatedAt": "2026-11-19T00:00:00.000Z"
  }
  ```
- **Migration bundle directory (`--out <bundleDir>`)**:
  - `manifest.json` (`formatVersion: 1`, `exportedAt`, `sourceOs`, `counts`, `settingsUpdatedAt?`, `legacyLedgers`, `attachments[]`, `fileChecksums`, `diagnostics[]`)
  - `settings.json`, `chats/*.json`, `jobs/*.json`, `graph/{format.json,nodes.jsonl,chains.jsonl,sessions.jsonl,coverage.jsonl,sources.json,source-organization.json,positions.json,render-settings.json}`, `prompts/**/*.md`, `themes/*.json`, `attachments/<sha256>/<filename>`, `attachments/<sha256>.meta.json`.

---

## 3. Build, Start & Docker Test Commands

All repository tests and Linux standalone builds are designed to run inside Docker (`node:26-bookworm-slim` / `mcr.microsoft.com/playwright:noble`) mounting only the source checkout and disposable test directories:

```powershell
# PowerShell wrapper (Windows host -> Docker learnharness-test:node26)
.\scripts\docker-test.ps1 build-image
.\scripts\docker-test.ps1 setup          # npm ci && npm run plugins:setup
.\scripts\docker-test.ps1 typecheck      # tsc --noEmit
.\scripts\docker-test.ps1 lint           # eslint . (4-zone import law)
.\scripts\docker-test.ps1 test           # NODE_ENV=test tsx --test --test-concurrency=4 tests/*.test.ts tests/*.test.tsx
.\scripts\docker-test.ps1 test tests/migration.test.ts tests/live-stream-handoff.test.ts
.\scripts\docker-test.ps1 build          # plugins:build-core && plugins:build-authoring && next build
.\scripts\docker-test.ps1 smoke          # smoke-provider-runtime + build-server + smoke-server --isolated
.\scripts\docker-test.ps1 exec "cd plugins/drawing-pad && npm run typecheck && npm test"
```

```bash
# Bash equivalent (Linux / macOS)
./scripts/docker-test.sh baseline
```

### Playwright WebKit E2E Runner (`tests/e2e/run-docker-e2e.sh`)

```bash
# Inside the learnharness-e2e:local container (/repo mounted read-only):
bash tests/e2e/run-docker-e2e.sh --selfcheck
bash tests/e2e/run-docker-e2e.sh --build-app --tier1
bash tests/e2e/run-docker-e2e.sh --build-app --all
```

### Direct Production Start (LXC / Linux Node 26)

```bash
npm run plugins:build-core
npm run build
node scripts/build-server.mjs
HOSTNAME=0.0.0.0 PORT=3000 NODE_ENV=production node .next/standalone/server.js
```

---

## 4. Tested Devices, Viewports & Status

### 4.1 Playwright WebKit CSS-Pixel Viewport Matrix (`tests/e2e/helpers/viewport-matrix.mjs`)

| Preset ID | CSS Pixels (W × H) | Device Class / Mode | Context Flags |
| --- | --- | --- | --- |
| `VP-SM-PORT` | `744×1133` | Small iPad Portrait | `hasTouch=true`, `isMobile=true`, `dpr=2` |
| `VP-SM-LAND` | `1133×744` | Small iPad Landscape | `hasTouch=true`, `isMobile=true`, `dpr=2` |
| `VP-MD-PORT` | `820×1180` | Medium iPad Portrait | `hasTouch=true`, `isMobile=true`, `dpr=2` |
| `VP-MD-LAND` | `1180×820` | Medium iPad Landscape | `hasTouch=true`, `isMobile=true`, `dpr=2` |
| `VP-LG-PORT` | `1024×1366` | Large iPad Portrait | `hasTouch=true`, `isMobile=true`, `dpr=2` |
| `VP-LG-LAND` | `1366×1024` | Large iPad Landscape | `hasTouch=true`, `isMobile=true`, `dpr=2` |
| `VP-SPLIT-1` | `375×1024` | iPad Split View 1/3 / Slide Over | `hasTouch=true`, `isMobile=true`, `dpr=2` |
| `VP-SPLIT-2` | `507×1180` | iPad Split View 1/2 | `hasTouch=true`, `isMobile=true`, `dpr=2` |
| `EXTREME_SPLIT_VIEWPORT` | `320×1024` | Extreme narrow Split View stress test | `hasTouch=true`, `isMobile=true`, `dpr=2` |
| `VP-DESK-REF` | `1440×900` | Desktop Reference Client | `hasTouch=false`, `isMobile=false`, `dpr=1` |

### 4.2 Milestone Verification Status

| Milestone / Gate | Status | Notes |
| --- | --- | --- |
| **M1** (`F1`–`F5`: Docker, Attachments, Auth, Proxy, ChatGPT Headless & Catalog) | **PASS** (`29fbecc`) | Full Docker suite (`5351` passed, `0` failed, `4` pre-existing OS skips), `typecheck`, `lint`, `build`, `smoke` + standalone leak check (`5/5` gate approvals). |
| **M2** (Safe Profile Migration Tooling) | **PASS** (`e2be1f6`) | `177/177` targeted tests, `typecheck`, `lint`, live Node 26 `export` → `dry-run` (`0` bytes) → `apply` → repeat `apply` (`0` bytes) smoke (`5/5` gate approvals). |
| **M3** (Live Stream Handoff & Electron Remote Client) | **PASS** (`2045a76`) | `live-stream-handoff`, `electron-remote`, `session-core`, `side-chat-ping` suites + Electron preload/config probes (`5/5` gate approvals). |
| **M4** (Attachments, `Ctrl+V`, PDF/Image Delivery & Drawing Pad) | **PASS** | Unmocked `pdfjs` extraction/rendering probes, WebKit Drawing Pad hit-tests, `73/73` plugin tests, `394/394` targeted suite (`5/5` gate approvals). |
| **E2E Harness (`M-E2E-1` & `M-E2E-2`)** | **HARNESS READY** | Isolated Playwright WebKit container + `167` Tiers 1–4 specs staged under `tests/e2e/**`. |
| **M5** (iPadOS Safari / WebKit UI & Responsive Matrix) | `[PENDING FINAL M5/M6 RUN — update after M5/M6 Gate]` | Concurrently in progress; final WebKit matrix results will be recorded after the M5/M6 Gate. |
| **Combined `M-E2E-3` & M6** (Final Integration Gate: `167` E2E specs + `/tmp/lh-run` full suite & standalone build) | `[PENDING FINAL M5/M6 RUN — update after M5/M6 Gate]` | Final combined end-to-end and full-repo verification pending M5 completion. |

---

## 5. Known Limits & Open Tasks

Automated Docker/WebKit checks verify server contracts, mocked OAuth/API streams, synthetic migration profiles, and WebKit DOM/pointer behavior, **not** physical OS/hardware behavior. See [`tests/e2e/MANUAL_IPAD_AND_WINDOWS_CHECKLIST.md`](../tests/e2e/MANUAL_IPAD_AND_WINDOWS_CHECKLIST.md) for the full step-by-step manual sign-off checklist.

### 5.1 Deferred Isolated Windows-VM Checks
- Packaging and running the unsigned Windows x64 NSIS installer (`electron-builder --win --x64 --publish never`) inside a disposable Windows VM with zero access to any productive profile.
- Live `BrowserWindow` verification of `setup.html`, `remote-reconnect.html`, `Ctrl+Alt+S` / context-menu **Change Server URL…**, `electron-updater` against a test feed, and native Windows `Win+Shift+S` + `Ctrl+V` clipboard screenshot paste.

### 5.2 Deferred Physical iPadOS Safari & Apple Pencil Checks
- Safari dynamic URL toolbar collapse, onscreen/Magic Keyboard `visualViewport` behavior, and physical notch/home-indicator safe-area clearance across Portrait, Landscape, and Split View (`1/3`, `1/2`, Slide Over).
- Physical Apple Pencil palm rejection, pressure/tilt feel, and iPadOS Scribble/zoom gesture non-interference in Drawing Pad.
- Native iPadOS **Photo Library** and **Files** picker sheets for images and multi-page PDFs.

### 5.3 Live User Deployment & Cutover Tasks
- Provisioning the real Proxmox Linux LXC container, `systemd` unit, and Cloudflare Tunnel domain.
- Initializing the single user account (`scripts/user-auth.mjs init`) and completing the live headless ChatGPT Plus OAuth flow against `auth.openai.com` / `api.openai.com/v1/models`.
- Running the real Windows backup/export and LXC `--dry-run` → `--apply` migration cutover on the user's actual learning profile.
