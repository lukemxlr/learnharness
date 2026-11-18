# Project: LearnHarness Production Multi-Device & LXC Extension

**Branch**: `feat/lxc-server-ipad-draw-migration` (in `c:\Users\User\Desktop\LearnHarness\repo`, branched from `cb25c8e49b85eed9e78315584731cad73a0118a6`)
**Checkpoint Date**: 2026-11-18T20:57:00Z (Urgent Pause & Clean Checkpoint)
**Architecture Review Status**: Audited by `reviewer_architecture_plan` (`18939c38`); all 8 Critical/Major/Minor findings integrated prior to M1 execution.

## Hard Safety & Isolation Constraints
- Productive Windows LearnHarness installation, `%APPDATA%`, `%LOCALAPPDATA%`, real learning data, and real credentials are **strictly untouched**.
- Zero `node`, `npm`, `npx`, Electron, or Windows installer executions on the Windows host; all builds, tests, and Playwright/WebKit checks run inside Linux Docker containers mounting only `c:\Users\User\Desktop\LearnHarness\repo` and isolated test directories (`LH_IGNORE_ENV_KEYS=1`).
- Respect `eslint.config.mjs` 4-zone boundaries (`components -> @/src/core`, `app -> @/src/core + @/src/server`, `src/core !-> agent/server/store`, `src/agent !-> server/store`).

---

## Verified Progress vs. Open Items (Checkpoint 2026-11-18T20:57:00Z)

### 1. Completed & Passed
- **M0 (Checkout, Branch & Docker Readiness)**:
  - Cloned `https://github.com/amosblomqvist/learnharness` (`cb25c8e49b85eed9e78315584731cad73a0118a6`) into `c:\Users\User\Desktop\LearnHarness\repo` on dedicated branch `feat/lxc-server-ipad-draw-migration` (`.agents/skills` preserved).
  - Verified Linux Docker images (`node:26-bookworm-slim` v26.13.1, `mcr.microsoft.com/playwright:noble` with `webkit-2051`).
- **Architecture & Milestone Plan Audit**:
  - `PROJECT.md` audited against `ORIGINAL_REQUEST.md` (R1–R7, Acceptance Criteria, ESLint 4-zone rules, standalone leak guards) and updated for all 8 findings.
- **M1 Implementation (`F1`–`F5`: Docker Runner, Attachment Store, Test Provider, LXC/Proxy, Single-Account Auth, Headless ChatGPT OAuth & Model Catalog)**:
  - **Implemented files**:
    - F1: `docker/Dockerfile.test`, `scripts/docker-test.ps1`, `scripts/docker-test.sh`, `src/core/contracts/attachments.ts`, `src/server/attachments.ts`, `tests/attachments-store.test.ts`
    - F2: `tests/helpers/test-provider.ts`, `tests/fixtures/synthetic-profile/` (100% synthetic geometry/algebra data), `tests/test-provider.test.ts`
    - F3: `src/server/desktop-access.ts` (`LH_TRUST_PROXY`, `X-Forwarded-Proto`/`Host`, hardened `browserHostAllowed`), `app/api/health/route.ts`, `deploy/systemd/learnharness.service`, `deploy/systemd/learnharness.env.example`, `tests/proxy-trust.test.ts`
    - F4: `config.ts` (`USER_AUTH_FILE`), `src/core/contracts/auth.ts`, `src/server/user-auth.ts`, `scripts/user-auth.mjs`, `app/api/auth/{login,logout,session}/route.ts`, `app/_lib/auth.ts`, `components/login-form.tsx`, `app/login/page.tsx`, `app/layout.tsx`, page auth guards (`app/page.tsx`, `app/chat/new/page.tsx`, `app/chat/[id]/page.tsx`, `app/plugins/[pluginId]/[viewId]/page.tsx`, `app/settings/page.tsx`), `components/settings/settings-dialog.tsx`, `proxy.ts`, `src/server/plugin-transport.ts`, `next.config.ts` & `scripts/build-server.mjs` (`user-auth.json*` leak guards), `tests/user-auth.test.ts`, updated `tests/plugin-document-proxy.test.ts`
    - F5 (R6): `electron/chatgpt.cjs`, `electron/chatgpt-ipc.cjs`, `electron/main.cjs`, `src/core/contracts/{chatgpt,models}.ts`, `src/server/web-subscription-http.ts`, `src/agent/chatgpt-bridge.ts`, `src/server/model-catalog.ts`, `app/api/models/refresh/route.ts`, `components/model-catalog.ts`, `components/settings/{subscription-client,chatgpt-connection,keys-section,agent-section}.tsx`, `components/sidebar.tsx`, `tests/chatgpt-headless-catalog.test.ts`, updated `tests/chatgpt-stream.test.ts`
  - **Checks actually passed in Linux Docker (`learnharness-test:node26`)**:
    - `docker-test.ps1 build-image` (Exit 0)
    - `docker-test.ps1 setup` (`npm ci` + `npm run plugins:setup`, Exit 0)
    - Targeted M1 suites (39/40 initial -> `test-provider.test.ts` fixed and passed 3/3 after final edit): `attachments-store.test.ts` (4/4), `chatgpt-headless-catalog.test.ts` (3/3), `chatgpt-stream.test.ts` (11/11), `plugin-document-proxy.test.ts` (8/8), `proxy-trust.test.ts` (6/6), `user-auth.test.ts` (5/5), `test-provider.test.ts` (3/3).
    - Worker 2 (`2602f3fe`) passed post-edit Docker `typecheck` (Exit 0), `lint` (Exit 0, 0 errors), `build` (Exit 0), and `smoke` (`smoke-provider-runtime`, `build-server`, `smoke-server --isolated`, Exit 0).
    - Worker 2 ran full `npm test` (`task-347`): **5,339 / 5,352 passed across 708 suites** (8 failed + 1 cancelled due to full-core CPU/bind-mount timeout; re-run with `--test-concurrency=4` was interrupted by urgent user pause).
- **E2E Testing Track (M-E2E-1 Infrastructure & Tier 1 Suite)**:
  - **Implemented files**: Standalone `tests/e2e/**` (`Dockerfile`, `package.json`, `playwright.config.mjs`, `run-docker-e2e.sh`, harness `mock-provider.mjs` + `server-controller.mjs` + `electron-harness.mjs` + `layout-assertions.mjs`, 64 Tier 1 specs) and synthetic fixtures under `tests/fixtures/e2e-synthetic/**`.
  - **Checks actually passed in Docker WebKit (`learnharness-e2e:local`, Playwright 1.46.1 / WebKit 18.0)**:
    - Worker 7 (`04f5aa00`) passed `--selfcheck` (4/4), `--list` (68 specs), `--tier1 --list` (64 specs), and 65-case WebKit layout/geometry probe; Iteration 7 Challenger 1 (`51e3ba11`) returned `CONFIRM` (18-case WebKit edge-case probe).

### 2. Still Running / Open (To Execute Next)
- **M1 Remaining Verification & Gate (OPEN / STILL TO RUN)**:
  - Re-run bounded `npm test` (`--test-concurrency=4`) and verify the 8 concurrency-timeout test files pass cleanly in Docker.
  - Run the full **M1 Concurrent Verification Wave** (2 Reviewers, 2 Challengers, 1 Forensic Auditor — **not yet run**) and record M1 Gate PASS.
- **E2E Track Remaining Work (OPEN / STILL TO RUN)**:
  - Complete M-E2E-1 Iteration 7 Verification Wave (Reviewers 1 & 2, Challenger 2, Forensic Auditor) & Gate.
  - Implement and verify M-E2E-2 (Tiers 2–4: 64 Tier 2, 16 Tier 3, 8 Tier 4, full iPad WebKit CSS-px viewport matrix, manual iPad/Windows checklist).
  - Execute full live E2E run against landed M1–M5 code and publish `TEST_READY.md`.
- **Remaining Implementation Milestones (OPEN / NOT STARTED)**:
  - **M2**: Safe Profile Migration Tooling (R2) — exporter, `--dry-run`/`--apply` importer, SHA-256 attachment ingestion, Windows path/fileAccess reporting, idempotent JSONL merge, newer-server preservation.
  - **M3**: Live Stream Keepalive/Resync Handoff & Electron Remote Client (R3) — SSE `: ping`, NDJSON `{"type":"ping"}\n`, `useServerResync`, `preload-remote.cjs` / `preload-setup.cjs`, Change Server URL, dynamic origin/CSP, local IPC isolation.
  - **M4**: Chat/Question Attachments (`Ctrl+V`, PDF model delivery, MC & Free-Response previews) & Overhauled Drawing Pad (`Bild 3` -> `Bild 1`, `Karoraster`, colors, widths, undo/redo, independent `Light`/`Dark`/`App` paper theme, per-question draft, "Add to answer") (R5).
  - **M5**: iPadOS Safari / WebKit UI & Responsive Viewport Matrix (R4) — `viewport-fit=cover`, `safe-area-inset-*`, overlay drawer, `visualViewport` handling, `PracticeDock` draft fix, touch controls, Playwright WebKit matrix + manual checklist.
  - **M6**: Final Integration Gate (Tiers 1–4 + Tier 5 adversarial coverage hardening) & R7 English docs (`docs/setup-and-operation.md`, `docs/developer-handover.md`, `docs/README.md`).
- **Open Hardware / VM / User-Account Tests**:
  - Isolated Windows VM tests: Electron desktop app launch, NSIS installer, auto-updater, remote URL first-run flow, real Windows `Ctrl+V` clipboard screenshot paste.
  - Real iPadOS hardware tests: Safari virtual keyboard, Apple Pencil strokes/palm rejection, Photos/Files picker, Split View multitasking.
  - Live headless LXC + Cloudflare Tunnel + real ChatGPT Plus OAuth login & real profile migration (to be triggered by user).

---

## Concrete Next Step to Resume Tomorrow
Run in exact order (inside `c:\Users\User\Desktop\LearnHarness\repo` on branch `feat/lxc-server-ipad-draw-migration`; **never** run `node`/`npm` on Windows host):

1. **Ensure Docker Desktop is running**, verify clean branch:
   ```powershell
   Set-Location c:\Users\User\Desktop\LearnHarness\repo
   git status
   git branch --show-current   # must be feat/lxc-server-ipad-draw-migration
   docker info --format "OSType={{.OSType}}"
   ```
2. **Finish M1 Verification & Gate**:
   - Update `scripts/docker-test.sh` / run `npm test` with bounded concurrency (`--test-concurrency=4`) inside `learnharness-test:node26` and confirm 100% pass across all 708 suites, plus re-confirm `typecheck`, `lint`, `build`, and `smoke`.
   - Dispatch **M1 Concurrent Verification Wave** (2 Reviewers, 2 Challengers, 1 Forensic Auditor) on the committed M1 implementation; resolve any findings until M1 Gate = **PASS**.
3. **Complete M-E2E-1 Verification Wave** in `tests/e2e/` (`./tests/e2e/run-docker-e2e.sh --selfcheck`, `--tier1`) and advance to **M-E2E-2** (Tiers 2–4).
4. **Proceed sequentially per dependency graph**:
   - **M2** (Migration) and **M3** (Stream Handoff + Electron Remote) in parallel once M1 Gate passes ->
   - **M4** (Attachments + Drawing Pad) ->
   - **M5** (iPadOS WebKit Responsive + Viewport Matrix) ->
   - **M6** (Full E2E Tiers 1–4 + Tier 5 Adversarial Hardening + R7 English Docs `docs/setup-and-operation.md` & `docs/developer-handover.md`).

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
| E2E | E2E Testing Track (Parallel) | M1 interfaces | IN_PROGRESS (M-E2E-1 Iter 7 wave paused; Tiers 2–4 & `TEST_READY.md` open) |
| M1 | Docker Baseline, Shared Contracts, Auth, LXC/Proxy & ChatGPT Catalog | none | IMPLEMENTATION_COMPLETE / VERIFICATION_PAUSED (F1–F5 implemented; `typecheck`/`lint`/`build`/`smoke` passed; bounded `npm test` & Verification Wave/Auditor open) |
| M2 | Safe Profile Migration Tooling | M1 | PLANNED |
| M3 | Live Stream Handoff & Electron Remote Client | M1 | PLANNED |
| M4 | Attachments (`Ctrl+V`/PDF/Photos) & Overhauled Drawing Pad | M1, M3 | PLANNED |
| M5 | iPadOS Safari / WebKit UI & Viewport Matrix | M1, M3, M4 | PLANNED |
| M6 | Final Integration Gate (Tiers 1–4 + Tier 5) & R7 Docs | M1–M5, E2E | PLANNED |
