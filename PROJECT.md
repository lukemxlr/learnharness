# Project: LearnHarness Production Multi-Device & LXC Extension

**Branch**: `feat/lxc-server-ipad-draw-migration` (in `c:\Users\User\Desktop\LearnHarness\repo`, branched from `cb25c8e49b85eed9e78315584731cad73a0118a6`)
**Checkpoint Date**: 2026-11-19T18:22:00Z (Milestone 3 Checkpoint Commit)
**Architecture Review Status**: Audited by `reviewer_architecture_plan` (`18939c38`); all 8 Critical/Major/Minor findings integrated prior to M1 execution.

## Hard Safety & Isolation Constraints
- Productive Windows LearnHarness installation, `%APPDATA%`, `%LOCALAPPDATA%`, real learning data, and real credentials are **strictly untouched**.
- Zero `node`, `npm`, `npx`, Electron, or Windows installer executions on the Windows host; all builds, tests, and Playwright/WebKit checks run inside Linux Docker containers mounting only `c:\Users\User\Desktop\LearnHarness\repo` and isolated test directories (`LH_IGNORE_ENV_KEYS=1`).
- Respect `eslint.config.mjs` 4-zone boundaries (`components -> @/src/core`, `app -> @/src/core + @/src/server`, `src/core !-> agent/server/store`, `src/agent !-> server/store`).

---

## Verified Progress vs. Open Items (Checkpoint 2026-11-19T18:22:00Z)

### 1. Completed & Passed
- **M0 (Checkout, Branch & Docker Readiness)**:
  - Cloned `https://github.com/amosblomqvist/learnharness` (`cb25c8e49b85eed9e78315584731cad73a0118a6`) into `c:\Users\User\Desktop\LearnHarness\repo` on dedicated branch `feat/lxc-server-ipad-draw-migration` (`.agents/skills` preserved).
  - Verified Linux Docker images (`node:26-bookworm-slim` v26.13.1, `mcr.microsoft.com/playwright:noble` with `webkit-2051`).
- **Architecture & Milestone Plan Audit**:
  - `PROJECT.md` audited against `ORIGINAL_REQUEST.md` (R1–R7, Acceptance Criteria, ESLint 4-zone rules, standalone leak guards) and updated for all 8 findings.
- **M1 (`F1`–`F5`: Docker Runner, Attachment Store, Test Provider, LXC/Proxy, Single-Account Auth, Headless ChatGPT OAuth & Model Catalog) — DONE & VERIFIED (`29fbecc`)**:
  - Iteration 2 Docker Verification Gates (`learnharness-test:node26`): `typecheck` Exit `0`, `lint` Exit `0` (`0` errors), full `test` (`5355` tests / `708` suites: `5351` passed, `0` failed, `4` pre-existing OS/fs skips), `build` Exit `0`, `smoke` Exit `0` + standalone leak check (`0` leaked auth/credential/env/data files).
  - Gate Verdicts: `reviewer_1` APPROVE, `reviewer_2` APPROVE, `challenger_1` APPROVE, `challenger_2` APPROVE, `teamwork_auditor` CLEAN (**PASS 5/5**).
- **M2 (Safe Profile Migration Tooling — R2) — DONE & VERIFIED (`e2be1f6`)**:
  - Targeted tests (`177/177` across `37` suites / `11` files), `typecheck` Exit `0`, `lint` Exit `0`, live Node 26 CLI smoke (`export` -> `dry-run` `0` bytes -> `apply` `11003` bytes -> repeat `apply` `0` bytes), Gate Verdicts **PASS 5/5**.
  - Key deliverables: `src/core/contracts/migration.ts`, `src/server/migration.ts`, `scripts/migrate-profile.mjs`, `src/store/chats.ts`, `src/store/settings.ts`, `tests/migration.test.ts`, `tests/fixtures/synthetic-profile/legacy-windows/**`.
- **M3 (Live Stream Handoff & Electron Remote Client — R3) — DONE & VERIFIED**:
  - **Iteration 4 Gate Verdict — PASS 5/5**:
    - `reviewer_m3_r4_1`: APPROVE (`507/507` 28-file suite)
    - `reviewer_m3_r4_2`: APPROVE (`219/219` 8-file suite)
    - `challenger_m3_r4_1`: APPROVE (`188/188` + Probes 1–4)
    - `challenger_m3_r4_2`: APPROVE (`83/83` + Electron probes)
    - `auditor_m3_r4`: CLEAN (2x cold `10/10` `tests/live-stream-handoff.test.ts` & `228/228` target suite)
  - **Packaging Verification**: `electron-builder.yml` (`files: ["!**/*", "electron/**/*", "package.json"]`) covers all 5 new Electron remote/setup files (`package.json` unchanged).
  - **Key M3 Deliverables (24 files)**:
    - Server keepalive & stream handoff: `src/server/stream-keepalive.ts`, `src/server/pi/ui-stream.ts`, `src/server/side-chat.ts`, `src/server/chat-handler.ts`, `app/api/jobs/route.ts`, `app/api/chats/[id]/route.ts`, `app/api/chats/[id]/stream/route.ts`, `app/api/chats/[id]/side-chats/route.ts`, `app/api/chats/[id]/side-chats/[threadId]/route.ts`
    - Client session resync: `components/chat.tsx`, `components/session-core.ts`, `components/session.ts`
    - Isolated Electron remote client: `electron/remote-config.cjs`, `electron/preload-remote.cjs`, `electron/preload-setup.cjs`, `electron/setup.html`, `electron/remote-reconnect.html`, `electron/chatgpt-ipc.cjs`, `electron/main.cjs`
    - Tests: `tests/live-stream-handoff.test.ts`, `tests/live-stream-handoff-ui.test.tsx`, `tests/side-chat-ping.test.tsx`, `tests/electron-remote.test.ts`, `tests/session-core.test.ts`
- **E2E Testing Track (`M-E2E-1` & `M-E2E-2`) — Harness Gate PASS**:
  - Isolated Playwright WebKit harness (`tests/e2e/**`) and synthetic fixtures (`tests/fixtures/e2e-synthetic/**`) with `167` Tiers 1–4 specs ready (kept unstaged until E2E execution checkpoint).

### 2. Still Running / Open (To Execute Next)
- **Next Milestone — M4 (Attachments & Overhauled Drawing Pad — R5)**:
  - `Ctrl+V` Windows screenshot paste, PDF model delivery, MC & Free-Response attachment previews, overhauled `plugins/drawing-pad` (`Bild 3` -> `Bild 1`, `Karoraster`, colors, widths, undo/redo, independent `Light`/`Dark`/`App` paper theme, per-question local draft, "Add to answer").
- **Remaining Milestones**:
  - **M5**: iPadOS Safari / WebKit UI & Responsive Viewport Matrix (R4) — `viewport-fit=cover`, `safe-area-inset-*`, overlay drawer, `visualViewport` handling, `PracticeDock` draft fix, touch controls, Playwright WebKit matrix + manual checklist.
  - **E2E Execution & M6**: Execute Tiers 1–4 against landed M2–M5 code + Tier 5 adversarial coverage hardening, full repo test run, standalone build, and R7 English docs (`docs/setup-and-operation.md`, `docs/developer-handover.md`, `docs/README.md`).
- **Deferred Hardware / VM / User-Account Tests**:
  - **Windows-VM Electron GUI / NSIS checks**: Electron desktop app launch, NSIS installer, auto-updater, remote URL first-run/reconnect GUI, and real Windows `Ctrl+V` clipboard screenshot paste.
  - **Real iPad Safari checks**: Safari virtual keyboard, Apple Pencil strokes/palm rejection, Photos/Files picker, Split View multitasking.
  - **Live LXC deployment checks**: systemd service + Cloudflare Tunnel + real ChatGPT Plus OAuth login & real profile migration (user-triggered).

---

## Concrete Next Step
Run on branch `feat/lxc-server-ipad-draw-migration` inside `c:\Users\User\Desktop\LearnHarness\repo` (**never** run `node`/`npm`/Electron on Windows host):

1. **Proceed with M4 (Attachments & Overhauled Drawing Pad — R5)**, validating targeted tests, `typecheck`, and `lint` in `learnharness-test:node26` via `.\scripts\docker-test.ps1`.
2. **Proceed to M5 (iPadOS Safari / WebKit UI & Viewport Matrix — R4)** and then **M6** (full repo test suite, standalone build, full E2E Tiers 1–4 + Tier 5 adversarial gate in Docker WebKit, and R7 English docs).

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
| E2E | E2E Testing Track (Parallel) | M1 interfaces | HARNESS_READY (`167` Tiers 1–4 specs unstaged under `tests/e2e/**`; full run at M6) |
| M1 | Docker Baseline, Shared Contracts, Auth, LXC/Proxy & ChatGPT Catalog | none | DONE & VERIFIED (`29fbecc`, Gate PASS 5/5) |
| M2 | Safe Profile Migration Tooling | M1 | DONE & VERIFIED (`e2be1f6`, Gate PASS 5/5) |
| M3 | Live Stream Handoff & Electron Remote Client | M1 | DONE & VERIFIED (Gate PASS 5/5) |
| M4 | Attachments (`Ctrl+V`/PDF/Photos) & Overhauled Drawing Pad | M1, M3 | NEXT / PLANNED |
| M5 | iPadOS Safari / WebKit UI & Viewport Matrix | M1, M3, M4 | PLANNED |
| M6 | Final Integration Gate (Tiers 1–4 + Tier 5) & R7 Docs | M1–M5, E2E | PLANNED |
