# Branch Status — `feat/lxc-server-ipad-draw-migration`

Last updated: 2026-11-19T15:10:00Z

## Completed & Passed
- **M0**: Cloned `https://github.com/amosblomqvist/learnharness` (`cb25c8e`) into `repo/` on `feat/lxc-server-ipad-draw-migration`; verified Linux Docker images (`node:26-bookworm-slim`, `mcr.microsoft.com/playwright:noble`).
- **M1 (`F1`–`F5`) — PASS (Verified & Committed)**:
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
- **M2 (Safe Profile Migration Tooling — R2) — PASS (Verified & Committed)**:
  - **Iteration 3 Gate Summary**:
    - Targeted tests: `177/177` passed across `37` suites / `11` files
    - `tsc --noEmit`: Exit `0`
    - `npm run lint`: Exit `0`
    - Live Node 26 CLI smoke: `export` -> `dry-run` `0` bytes -> `apply` `11003` bytes -> repeat `apply` `0` bytes
  - **Iteration 3 Gate Verdicts**: Reviewers 1&2 APPROVE, Challengers 1&2 APPROVE, Forensic Auditor CLEAN (**Gate Result: PASS**).
  - **Key Deliverables**: `src/core/contracts/migration.ts`, `src/server/migration.ts`, `scripts/migrate-profile.mjs`, `src/store/chats.ts`, `src/store/settings.ts`, `tests/migration.test.ts`, `tests/fixtures/synthetic-profile/legacy-windows/**`.
- **E2E Track (`M-E2E-1` & `M-E2E-2`) — Gate PASS**: Isolated Playwright WebKit harness (`tests/e2e/**`) and synthetic fixtures (`tests/fixtures/e2e-synthetic/**`) with `167` Tiers 1–4 specs ready under `tests/e2e/**` (kept unstaged until E2E checkpoint).

## Remaining Milestones & Open Work
1. **M3 (Live Stream Handoff & Electron Remote Client — R3)** — **Next / Active**: Server-side SSE `: ping` / NDJSON `{"type":"ping"}` keepalive, `useServerResync` mid-stream handoff between two independent clients without starting a second model run, `preload-remote.cjs` / `preload-setup.cjs`, server URL config/change/reconnect, strict local IPC isolation.
2. **M4 (Attachments & Overhauled Drawing Pad — R5)**: `Ctrl+V` Windows screenshot paste, PDF model delivery, MC & Free-Response attachment previews, overhauled `plugins/drawing-pad` (grid, colors, widths, undo/redo, independent `Light`/`Dark`/`App` paper theme, per-question local draft, "Add to answer").
3. **M5 (iPadOS Safari / WebKit UI & Responsive Viewport Matrix — R4)**: `viewport-fit=cover`, `safe-area-inset-*`, overlay drawer, `visualViewport` keyboard handling, touch targets, automated WebKit viewport matrix in CSS px.
4. **E2E Track (`M-E2E-1` & `M-E2E-2` execution against landed M2–M5)** & **M6 (Final Integration Gate Tiers 1–5 + R7 English Docs `docs/setup-and-operation.md`, `docs/developer-handover.md`, `docs/README.md`)**.
5. **Deferred Hardware / VM / LXC Tests (User-Triggered / Isolated Environment Only)**: Windows VM Electron launch/NSIS installer/updater/`Ctrl+V` tests, real iPadOS Safari/Apple Pencil hardware tests, live LXC systemd + Cloudflare Tunnel + real ChatGPT Plus OAuth + real profile migration.

See `PROJECT.md` at repository root for architecture contracts and baseline design notes.
