# Project: LearnHarness Production Multi-Device & LXC Extension

**Branch**: `feat/lxc-server-ipad-draw-migration` (in `c:\Users\User\Desktop\LearnHarness\repo`, branched from `cb25c8e49b85eed9e78315584731cad73a0118a6`)
**Checkpoint Date**: 2026-11-19T21:02:47Z (Urgent Laptop Shutdown Checkpoint)
**Architecture Review Status**: Audited by `reviewer_architecture_plan` (`18939c38`); all 8 Critical/Major/Minor findings integrated prior to M1 execution.

## Hard Safety & Isolation Constraints
- Productive Windows LearnHarness installation, `%APPDATA%`, `%LOCALAPPDATA%`, real learning data, and real credentials are **strictly untouched**.
- Zero `node`, `npm`, `npx`, Electron, or Windows installer executions on the Windows host; all builds, tests, and Playwright/WebKit checks run inside Linux Docker containers mounting only `c:\Users\User\Desktop\LearnHarness\repo` and isolated test directories (`LH_IGNORE_ENV_KEYS=1`).
- Respect `eslint.config.mjs` 4-zone boundaries (`components -> @/src/core`, `app -> @/src/core + @/src/server`, `src/core !-> agent/server/store`, `src/agent !-> server/store`).

---

## Verified Progress vs. Open Items (Checkpoint 2026-11-19T21:02:47Z)

### 1. Completed, Gate PASS & Locally Committed
- **M0 (Checkout, Branch & Docker Readiness)**:
  - Cloned `https://github.com/amosblomqvist/learnharness` (`cb25c8e49b85eed9e78315584731cad73a0118a6`) into `c:\Users\User\Desktop\LearnHarness\repo` on dedicated branch `feat/lxc-server-ipad-draw-migration` (`.agents/skills` preserved).
  - Verified Linux Docker images (`node:26-bookworm-slim` v26.13.1, `mcr.microsoft.com/playwright:noble` with `webkit-2051`).
- **Architecture & Milestone Plan Audit**:
  - `PROJECT.md` audited against `ORIGINAL_REQUEST.md` (R1–R7, Acceptance Criteria, ESLint 4-zone rules, standalone leak guards) and updated for all 8 findings.
- **M1 (`F1`–`F5`: Docker Runner, Attachment Store, Test Provider, LXC/Proxy, Single-Account Auth, Headless ChatGPT OAuth & Model Catalog) — DONE & VERIFIED (`29fbecc`)**:
  - Iteration 2 Docker Verification Gates (`learnharness-test:node26`): `typecheck` Exit `0`, `lint` Exit `0` (`0` errors), full `test` (`5355` tests / `708` suites: `5351` passed, `0` failed, `4` pre-existing OS/fs skips), `build` Exit `0`, `smoke` Exit `0` + standalone leak check (`0` leaked auth/credential/env/data files).
  - Gate Verdicts: `reviewer_1` APPROVE, `reviewer_2` APPROVE, `challenger_1` APPROVE, `challenger_2` APPROVE, `teamwork_auditor` CLEAN (**PASS 5/5**).
- **M2 (Safe Profile Migration Tooling — R2) — DONE & VERIFIED (`e2be1f6b`)**:
  - Targeted tests (`177/177` across `37` suites / `11` files), `typecheck` Exit `0`, `lint` Exit `0`, live Node 26 CLI smoke (`export` -> `dry-run` `0` bytes -> `apply` `11003` bytes -> repeat `apply` `0` bytes), Gate Verdicts **PASS 5/5**.
  - Key deliverables: `src/core/contracts/migration.ts`, `src/server/migration.ts`, `scripts/migrate-profile.mjs`, `src/store/chats.ts`, `src/store/settings.ts`, `tests/migration.test.ts`, `tests/fixtures/synthetic-profile/legacy-windows/**`.
- **M3 (Live Stream Handoff & Electron Remote Client — R3) — DONE & VERIFIED (`2045a76`)**:
  - **Iteration 4 Gate Verdict — PASS 5/5**:
    - `reviewer_m3_r4_1`: APPROVE (`507/507` 28-file suite)
    - `reviewer_m3_r4_2`: APPROVE (`219/219` 8-file suite)
    - `challenger_m3_r4_1`: APPROVE (`188/188` + Probes 1–4)
    - `challenger_m3_r4_2`: APPROVE (`83/83` + Electron probes)
    - `auditor_m3_r4`: CLEAN (`10/10` 2x cold handoff, `9/9` electron-remote, `228/228` target suite)
  - **Packaging Verification**: `electron-builder.yml` (`files: ["!**/*", "electron/**/*", "package.json"]`) covers all 5 new Electron remote/setup files (`package.json` unchanged).
  - **Key M3 Deliverables (24 files)**:
    - Server keepalive & stream handoff: `src/server/stream-keepalive.ts`, `src/server/pi/ui-stream.ts`, `src/server/side-chat.ts`, `src/server/chat-handler.ts`, `app/api/jobs/route.ts`, `app/api/chats/[id]/route.ts`, `app/api/chats/[id]/stream/route.ts`, `app/api/chats/[id]/side-chats/route.ts`, `app/api/chats/[id]/side-chats/[threadId]/route.ts`
    - Client session resync: `components/chat.tsx`, `components/session-core.ts`, `components/session.ts`
    - Isolated Electron remote client: `electron/remote-config.cjs`, `electron/preload-remote.cjs`, `electron/preload-setup.cjs`, `electron/setup.html`, `electron/remote-reconnect.html`, `electron/chatgpt-ipc.cjs`, `electron/main.cjs`
    - Tests: `tests/live-stream-handoff.test.ts`, `tests/live-stream-handoff-ui.test.tsx`, `tests/side-chat-ping.test.tsx`, `tests/electron-remote.test.ts`, `tests/session-core.test.ts`
- **M4 (Attachments, Ctrl+V, PDF/Image Model Delivery & Overhauled Drawing Pad — R5) — DONE & VERIFIED (`40b6395`, Iteration 2 Gate PASS 5/5)**:
  - **Iteration 2 Gate Verdict — PASS 5/5**:
    - `reviewer_m4_r2_1`: APPROVE (`394/394` across `56` suites + `73/73` plugin tests + `typecheck`/`lint` `0`)
    - `reviewer_m4_r2_2`: APPROVE (`73/73` + `262/262`)
    - `challenger_m4_r2_1`: APPROVE (`95/95` + unmocked `pdfjs` 1p/80p/scanned/corrupt/SHA-256/MC+FR/compaction E2E probes)
    - `challenger_m4_r2_2`: APPROVE (Playwright WebKit hit-test + `179/179` + `73/73`)
    - `auditor_m4_r2`: CLEAN
  - **Key M4 Deliverables (62 files)**:
    - Attachment APIs, delivery & compaction: `app/api/attachments/route.ts`, `app/api/attachments/[id]/route.ts`, `src/core/contracts/attachments.ts`, `src/server/attachments.ts`, `src/server/attachment-delivery.ts`, `src/server/chat-handler.ts`, `src/server/index.ts`, `src/server/jobs.ts`, `src/core/compaction.ts`, `src/agent/subagents/pdf-ops.ts`, `src/agent/teacher-agent.ts`
    - Core events, question/plugin contracts & docs: `src/core/input-events.ts`, `src/core/native-messages.ts`, `src/core/plugin-submissions.ts`, `src/core/plugins.ts`, `src/core/question-core.ts`, `src/core/view.ts`, `docs/plugin-api/README.md`, `docs/plugin-api/contracts-attachments.md`, `docs/plugin-api/native-messages.md`, `docs/plugin-api/plugins.md`
    - Chat, question, `Ctrl+V` paste & attachment staging UI: `components/attachment-staging.tsx`, `components/attach-files-button.tsx`, `components/answered-card.tsx`, `components/chat.tsx`, `components/composer.tsx`, `components/path-input.tsx`, `components/plugin-chrome.tsx`, `components/plugin-manager.ts`, `components/plugin-surface-targets.ts`, `components/plugins.tsx`, `components/practice-cards.tsx`, `components/practice-dock.tsx`, `components/question-dock.tsx`, `components/session-core.ts`, `components/session.ts`, `components/submitted-images.tsx`, `components/thinking-block.tsx`
    - Overhauled `plugins/drawing-pad` (`Bild 1`: grid, colors, widths, undo/redo, independent `Light`/`Dark`/`App` paper theme, per-question local draft, "Add to answer" staging): `plugins/drawing-pad/README.md`, `plugins/drawing-pad/src/{capture,geometry,icons,main,sheet,state,strokes,theme}.ts`, `plugins/drawing-pad/src/styles.css`, `plugins/drawing-pad/tests/{browser-fixture.mjs,frontend.test.ts,geometry.test.ts,state.test.ts,strokes.test.ts,theme-races.test.ts,theme.test.ts}`
    - Tests: `tests/attachment-delivery.test.ts`, `tests/attachments-route.test.ts`, `tests/compaction-multimodal.test.ts`, `tests/composer-attach.test.tsx`, `tests/helpers/plugin-chrome.tsx`, `tests/path-input.test.tsx`, `tests/question-attachments-ui.test.tsx`
  - **E2E Note**: Core plugins default disabled per `tests/core-plugins.test.ts`; E2E Drawing Pad runs must explicitly enable `drawing-pad` (`plugins-state.json` or `PUT /api/plugins/drawing-pad`).
- **`M-E2E-1` & `M-E2E-2` (E2E Testing Harness & Specs) — Gate 18 & Gate 19 PASS (Now Committed in Checkpoint)**:
  - `167` Tiers 1–4 specs across `11` files under `tests/e2e/**`, `21/21` Dual-Node ESM, `--selfcheck 15/15`, Auditors CLEAN — now committed in this checkpoint commit.

### 2. Interrupted by Urgent Laptop Shutdown (Partially Completed & Committed Here)
- **R7 English Documentation Draft (`docs/setup-and-operation.md`, `docs/developer-handover.md`, `docs/README.md`)**:
  - Completed initial draft by `worker_r7_docs` (`396d5195`, link- & privacy-checked, retaining `[PENDING FINAL M5/M6 RUN — update after M5/M6 Gate]` markers) and committed in this checkpoint.
- **M5 (iPadOS Safari / WebKit UI & Responsive Matrix — R4)**:
  - 3 parallel Explorers completed (`dbb9bc62`, `0d848c12`, `5ad38e31` in brain scratch); implementation interrupted before code edits.

### 3. Remaining Next Session (Concrete Resume Order)
1. **Complete `M5` (iPadOS Safari / WebKit UI & responsive matrix)** per `2026-11-19T18:54:36Z` Gate threshold (`REQUEST_CHANGES`/`REJECT` only for functional/security/data-loss/WebKit-layout bugs) -> local commit.
2. **Finalize `R7` docs** (`docs/developer-handover.md` M5/M6 sections + `docs/setup-and-operation.md` review).
3. **Run Combined Final Acceptance Gate (`M-E2E-3` + `M6`)**: `167` E2E specs with `drawing-pad` enabled in E2E harness + single full 708-suite `npm test` & standalone `next build` + `smoke` inside container-internal `/tmp/lh-run` copy (no duplicate Reviewer full-suite re-runs) -> Victory Audit.
4. **Open user/hardware/LXC end-tests** (`tests/e2e/MANUAL_IPAD_AND_WINDOWS_CHECKLIST.md`): isolated Windows VM Electron/installer/`Ctrl+V`, real iPadOS Safari/Apple Pencil, live Proxmox LXC + Cloudflare Tunnel + ChatGPT OAuth + real profile migration.

---

## Concrete Next Step
Run on branch `feat/lxc-server-ipad-draw-migration` inside `c:\Users\User\Desktop\LearnHarness\repo` (**never** run `node`/`npm`/Electron on Windows host):

1. **Complete M5 (iPadOS Safari / WebKit UI & Responsive Matrix — R4)** using the 3 completed Explorer outputs (`dbb9bc62`, `0d848c12`, `5ad38e31` in brain scratch) and `2026-11-19T18:54:36Z` Gate threshold -> local commit.
2. **Finalize R7 English Docs** (`docs/developer-handover.md` M5/M6 sections + `docs/setup-and-operation.md` review, removing `[PENDING FINAL M5/M6 RUN — update after M5/M6 Gate]` markers after final runs).
3. **Execute Combined Final Acceptance Gate (`M-E2E-3` + `M6`)**: run the `167` E2E specs with `drawing-pad` enabled in E2E harness + single full 708-suite `npm test` & standalone `next build` + `smoke` inside container-internal `/tmp/lh-run` copy -> Victory Audit.

---

## Architecture & Interface Contracts (Baseline)

1. **Single-Account Auth & Proxy (`src/server/user-auth.ts`, `proxy.ts`, `src/server/desktop-access.ts`, `src/server/plugin-transport.ts`)**:
   - `<dir(LH_AUTH_FILE)>/user-auth.json` (`0600`), managed via `scripts/user-auth.mjs` (`init`, `reset-password`, `status`).
   - `proxy.ts` protects pages (`302 /login`) + `/api/**` (`401`), `createPluginDocumentRoute` enforces `userAuthRefusal`, `next.config.ts` & `scripts/build-server.mjs` block `user-auth.json*` leaks.
   - `LH_TRUST_PROXY=1` honors `X-Forwarded-Proto` / `X-Forwarded-Host` while enforcing `LH_ALLOWED_HOSTS` and CSRF checks.
2. **Shared Attachment Store (`src/core/contracts/attachments.ts`, `src/server/attachments.ts`)**:
   - `<LH_DATA_DIR>/attachments/<sha256>/<sanitizedFilename>` + `<sha256>.meta.json` (used by M2 Migration & M4 Uploads).
3. **Headless ChatGPT OAuth & Catalog (`electron/chatgpt.cjs`, `src/agent/chatgpt-bridge.ts`, `src/server/model-catalog.ts`)**:
   - `startHeadlessAuth` / `completeHeadlessAuth` + disk reload; dynamic `/v1/models` preservation beyond `pi-ai` static filter; retains last-known-good catalog on transient errors; 5-min TTL cache + `POST /api/models/refresh`.
4. **Planned Contracts (M2–M5)**:
   - **M2 Migration**: `scripts/migrate-profile.mjs` (`export` read-only + `import --dry-run / --apply`, SHA-256 attachment ingestion, Linux `fileAccess.folders` sanitization, JSONL dedup keys, newer-server preservation).
   - **M3 Stream & Electron**: SSE `: ping\n\n` (`ui-stream.ts`), NDJSON `{"type":"ping"}\n` (`side-chat.ts`), `useServerResync` chat refetch + `attachToRunningTurn()`, `electron/preload-remote.cjs` & `preload-setup.cjs`, dynamic `allowedOrigin()`.
   - **M4 Attachments & Drawing Pad**: `/api/attachments` upload/get, `ChatInput`/`LhMessage` `AttachmentRef`, PDF resolution in `chat-handler.ts` (Zone 4 compliant), `PathInput` `Ctrl+V` image paste, `PluginFrontendContext` staging API, `plugins/drawing-pad` (`Bild 1`: grid, colors, widths, undo/redo, independent paper theme, per-question draft, "Add to answer" for Free-Response & MC).
   - **M5 iPad WebKit**: `viewport-fit=cover`, `safe-area-inset-*`, overlay drawer, `visualViewport`, zero-unmount `PracticeDock`/`QuestionDock`/`DrawingPad`, touch controls >=44px, Playwright WebKit viewport matrix.

---

## Milestones

| # | Name | Dependencies | Status |
|---|------|-------------|--------|
| E2E | E2E Testing Track (`M-E2E-1` & `M-E2E-2`) | M1 interfaces | GATE 18 & 19 PASS (`167` Tiers 1–4 specs across `11` files under `tests/e2e/**`, `21/21` Dual-Node ESM, `--selfcheck 15/15`, Auditors CLEAN; committed) |
| M1 | Docker Baseline, Shared Contracts, Auth, LXC/Proxy & ChatGPT Catalog | none | DONE & VERIFIED (`29fbecc`, Gate PASS 5/5) |
| M2 | Safe Profile Migration Tooling | M1 | DONE & VERIFIED (`e2be1f6b`, Gate PASS 5/5) |
| M3 | Live Stream Handoff & Electron Remote Client | M1 | DONE & VERIFIED (`2045a76`, Gate PASS 5/5) |
| M4 | Attachments (`Ctrl+V`/PDF/Photos) & Overhauled Drawing Pad | M1, M3 | DONE & VERIFIED (`40b6395`, Iter 2 Gate PASS 5/5) |
| R7 | English Documentation Draft (`docs/setup-and-operation.md`, `docs/developer-handover.md`, `docs/README.md`) | M1–M4 | DRAFT COMMITTED (`worker_r7_docs` `396d5195`; `[PENDING FINAL M5/M6 RUN]` markers retained until M6) |
| M5 | iPadOS Safari / WebKit UI & Responsive Matrix | M1, M3, M4 | INTERRUPTED (3 Explorers `dbb9bc62`/`0d848c12`/`5ad38e31` complete; code edits next) |
| M6 | Combined `M-E2E-3` & Final Acceptance Gate (`/tmp/lh-run` Full Run + R7 Finalization) | M1–M5, E2E | PLANNED |
