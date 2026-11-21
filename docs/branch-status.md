# Branch Status — `feat/lxc-server-ipad-draw-migration`

## Current status (2026-11-21)

All automated implementation, upstream merge, and Docker acceptance gates are **PASS** on `feat/lxc-server-ipad-draw-migration`:

- **Upstream `v0.7.0` Merge (`269afdf2`):** Merged `origin/main` (`069a6a11`, `learnharness@0.7.0`, `Next.js 16.4.6`). Pre-merge rollback preserved at branch `backup/pre-v0.7.0-merge` and tag `pre-v0.7.0-merge` (`9e37b90c`).
- **Acceptance Blockers Resolved (`5f7e8f68`, `6bdbe6eb`, `17591263`, `6703fd02`, `ccf354c7`):**
  - `T2-F3-02` (untrusted forwarded headers): `scripts/build-server.mjs` now wraps the standalone entrypoint (`server.js` → `server.next.cjs`) and strips `x-forwarded-*` / `forwarded` headers whenever `LH_TRUST_PROXY !== "1"`.
  - `T1-F11-04` / `T2-F12-04` / `T2-F12-06` / `T4-04` (WebKit mobile viewport lockup & scale drift): added `minimumScale: 1` in `app/layout.tsx` (keeping pinch-zoom unrestricted), replaced native `placeholder` on `session-search` with an accessible overlay + deferred mount transition in `components/sidebar.tsx`, and aligned E2E helpers/specs with `v0.7.0` behavior.
- **Automated Docker Verification (`Node 26.13.1` + Playwright WebKit `Node 20.16.0`):**
  - `npm run typecheck`: Exit `0` (`0` errors)
  - `npm run lint`: Exit `0` (`0` errors, `1` pre-existing warning in `tests/source-name-ui.test.tsx:27:45`)
  - `plugins/drawing-pad` (`typecheck` + `test`): **`75/75` PASS**
  - Full repository unit/integration suite: **`5,644/5,644` PASS** (`0` failures, `4` pre-existing OS/fs skips)
  - Standalone production build (`Next.js 16.4.6`, 4 core plugins + authoring skill) + `scripts/build-server.mjs`: **PASS** (`0` leaked secret/data files)
  - All 5 smoke scripts (`smoke-provider-runtime`, `smoke-demo-runtime`, `smoke-compression-runtime`, `smoke-server --isolated`, `smoke-core-plugins`): **ALL PASS**
  - Full Playwright WebKit E2E acceptance suite (`--build-app --all --workers=2` on `ccf354c7`): **`167/167` PASS (`0` failed, `0` timeouts, `27.7m`)**

See the [developer handover](developer-handover.md#42-milestone-verification-status) for detailed verification results and the [manual checklist](../tests/e2e/MANUAL_IPAD_AND_WINDOWS_CHECKLIST.md) for the remaining physical iPad, Windows VM, and live LXC cutover checks.

## Checkpoint from 2026-11-19

## Completed, Gate PASS & Locally Committed
- **M0**: Cloned `https://github.com/amosblomqvist/learnharness` (`cb25c8e`) into `repo/` on `feat/lxc-server-ipad-draw-migration`; verified Linux Docker images (`node:26-bookworm-slim`, `mcr.microsoft.com/playwright:noble`).
- **M1 (`F1`–`F5`) — PASS (Verified & Committed `29fbecc`)**:
  - **Iteration 2 Docker Verification Gates (`learnharness-test:node26`)**:
    - `typecheck` (`tsc --noEmit`): Exit `0`
    - `lint` (`eslint .`): Exit `0` (`0` errors, `1` pre-existing warning in `tests/source-name-ui.test.tsx:27:45`)
    - `test` (`NODE_ENV=test tsx --test --test-concurrency=4 tests/*.test.ts tests/*.test.tsx`): Exit `0` (`5355` tests / `708` suites: `5351` passed, `0` failed, `0` cancelled, `4` pre-existing OS/fs skips [2 `win32`, 2 Linux case-sensitive filesystem], `0` M1 tests skipped)
    - `build` (`plugins:build-core`, `plugins:build-authoring`, `next build`): Exit `0`
    - `smoke` (`smoke-provider-runtime`, `build-server`, `smoke-server --isolated`): Exit `0` + standalone leak check (`0` leaked `user-auth.json*`/auth/credential/env/data files in `.next/standalone`)
  - **Iteration 2 Gate Verdicts**: `reviewer_1` APPROVE, `reviewer_2` APPROVE, `challenger_1` APPROVE, `challenger_2` APPROVE, `teamwork_auditor` CLEAN (**Gate Result: PASS**).
  - **Key Iter 1–2 Deliverables & Security Hardening**:
    - Docker runner (`scripts/docker-test.ps1`, `scripts/docker-test.sh`, `package.json`) with bounded `--test-concurrency=4`.
    - Shared attachment store (`src/core/contracts/attachments.ts`, `src/server/attachments.ts`): `<LH_DATA_DIR>/attachments/<sha256>/`, HTML/`%PDF-` polyglot rejection, `Content-Security-Policy: default-src 'none'; sandbox`, APNG consistency via `detectSupportedImageMimeType`, and `WIN32_RESERVED_STEM_RE` filename sanitization.
    - Isolated test provider & synthetic fixtures (`tests/helpers/test-provider.ts`, `tests/fixtures/synthetic-profile/`).
    - Reverse proxy trust & LXC baseline (`src/server/desktop-access.ts`, `app/api/health/route.ts`, `deploy/systemd/learnharness.service`): `parseValidatedHost` hardening (`[\s@?#\/\\]` and URL component validation), `LH_TRUST_PROXY`, `LH_ALLOWED_HOSTS`.
    - Single-account auth (`src/core/contracts/auth.ts`, `src/server/user-auth.ts`, `scripts/user-auth.mjs`, `proxy.ts`, `/login`, standalone `user-auth.json*` leak guards): `sanitizeNextPath` post-parse open-redirect fix rejecting dot-segment `//evil.com` & `/\\` paths.
    - Headless ChatGPT OAuth & dynamic model catalog (`electron/chatgpt.cjs`, `src/server/model-catalog.ts`, `components/model-catalog.ts`, `components/settings/keys-section.tsx`): `refreshConnectionCatalog` concurrent-call coalescing, `forceRefreshCatalog`/`KeysSection` `catalogErrors` UI error surfacing, `tests/chatgpt-headless-ui.test.tsx`, and strictly test+loopback-gated `LH_CHATGPT_OAUTH_ISSUER`/`LH_CHATGPT_API_BASE` seam (`NODE_ENV === "test"` or `LH_IGNORE_ENV_KEYS === "1"` + HTTP loopback only).
- **M2 (Safe Profile Migration Tooling — R2) — PASS (Verified & Committed `e2be1f6b`)**:
  - **Iteration 3 Gate Summary**:
    - Targeted tests: `177/177` passed across `37` suites / `11` files
    - `tsc --noEmit`: Exit `0`
    - `npm run lint`: Exit `0`
    - Live Node 26 CLI smoke: `export` -> `dry-run` `0` bytes -> `apply` `11003` bytes -> repeat `apply` `0` bytes
  - **Iteration 3 Gate Verdicts**: Reviewers 1&2 APPROVE, Challengers 1&2 APPROVE, Forensic Auditor CLEAN (**Gate Result: PASS**).
  - **Key Deliverables**: `src/core/contracts/migration.ts`, `src/server/migration.ts`, `scripts/migrate-profile.mjs`, `src/store/chats.ts`, `src/store/settings.ts`, `tests/migration.test.ts`, `tests/fixtures/synthetic-profile/legacy-windows/**`.
- **M3 (Live Stream Handoff & Electron Remote Client — R3) — DONE & VERIFIED (`2045a76`)**:
  - **Iteration 4 Gate Verdict — PASS 5/5**:
    - `reviewer_m3_r4_1`: APPROVE (`507/507` 28-file suite)
    - `reviewer_m3_r4_2`: APPROVE (`219/219` 8-file suite)
    - `challenger_m3_r4_1`: APPROVE (`188/188` + Probes 1–4)
    - `challenger_m3_r4_2`: APPROVE (`83/83` + Electron probes)
    - `auditor_m3_r4`: CLEAN (2x cold `10/10` `tests/live-stream-handoff.test.ts`, `9/9` electron-remote, & `228/228` target suite)
  - **Packaging Verification**: `electron-builder.yml` (`files: ["!**/*", "electron/**/*", "package.json"]`) already covers `electron/remote-config.cjs`, `electron/preload-remote.cjs`, `electron/preload-setup.cjs`, `electron/setup.html`, and `electron/remote-reconnect.html` (`package.json` unchanged).
  - **Key M3 Deliverables (24 files)**:
    - Server keepalive & live-stream handoff: `src/server/stream-keepalive.ts`, `src/server/pi/ui-stream.ts`, `src/server/side-chat.ts`, `src/server/chat-handler.ts`, `app/api/jobs/route.ts`, `app/api/chats/[id]/route.ts`, `app/api/chats/[id]/stream/route.ts`, `app/api/chats/[id]/side-chats/route.ts`, `app/api/chats/[id]/side-chats/[threadId]/route.ts`
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
  - **E2E Note**: Core plugins default disabled per `tests/core-plugins.test.ts`, so E2E Drawing Pad runs must enable `drawing-pad` via `plugins-state.json` or `PUT /api/plugins/drawing-pad`.
- **`M-E2E-1` & `M-E2E-2` — Gate 18 & Gate 19 PASS (Committed in Checkpoint)**: Isolated Playwright WebKit harness (`tests/e2e/**`) and synthetic fixtures (`tests/fixtures/e2e-synthetic/**`) with `167` Tiers 1–4 specs across `11` files under `tests/e2e/**`, `21/21` Dual-Node ESM, `--selfcheck 15/15`, Auditors CLEAN — now committed in this checkpoint.

- **`M5` (iPadOS Safari / WebKit UI & Responsive Matrix — R4) — PASS (`7298239`, `9e37b90c`, `5f7e8f68`, `17591263`)**: Responsive drawer navigation, safe-area clearance, `visualViewport` keyboard avoidance, touch controls, editor/sign-in readiness guards, and mobile WebKit viewport scaling stability verified across all portrait, landscape, Split View (`375px` / `507px` / `320px`), and rotation scenarios.
- **Upstream `v0.7.0` Merge (`269afdf2`) & Proxy Guard (`5f7e8f68`) — PASS**: Integrated `origin/main` (`069a6a11`, `Next.js 16.4.6`) cleanly with pre-merge rollback `backup/pre-v0.7.0-merge` / tag `pre-v0.7.0-merge` (`9e37b90c`); resolved `T2-F3-02` via the `scripts/build-server.mjs` proxy-header guard wrapper.
- **Combined Final Acceptance Gate (`M-E2E-3` + `M6`) & `R7` Docs — PASS (`ccf354c7`)**: `typecheck` `0`, `lint` `0`, `plugins/drawing-pad` `75/75`, full repo suite `5,644/5,644` (`0` failed, `4` pre-existing OS/fs skips), standalone build + 5 smoke scripts + `0` leaks, and full Playwright WebKit E2E **`167/167` PASS (`0` failed, `0` timeouts, `27.7m`)**.

## Remaining Manual User Verification (Hardware / VM / Live LXC)
- Run the physical hardware, isolated Windows VM, and live LXC cutover checks in [`tests/e2e/MANUAL_IPAD_AND_WINDOWS_CHECKLIST.md`](../tests/e2e/MANUAL_IPAD_AND_WINDOWS_CHECKLIST.md):
  1. Isolated Windows VM Electron x64 NSIS installer, `setup.html` / `remote-reconnect.html`, and native `Win+Shift+S` + `Ctrl+V` paste.
  2. Physical iPadOS Safari + Apple Pencil palm rejection, native keyboard / safe-area clearance, and Photo Library / Files pickers.
  3. Live Proxmox LXC + `systemd` + Cloudflare Tunnel + headless ChatGPT Plus OAuth + real Windows → LXC `--dry-run` → `--apply` profile migration cutover.

See `PROJECT.md` at repository root for architecture contracts and baseline design notes.
