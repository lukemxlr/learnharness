# Release & Verification Status (`main`)

This document tracks the implemented features and verification results for the self-hosted server, iPadOS Safari + Apple Pencil, unified attachments, and remote desktop fork of LearnHarness (based on upstream `v0.7.0`).

## Current status (`v0.7.3`)

All implementation milestones, upstream `v0.7.0` integration, `v0.7.1`–`v0.7.3` self-hosted server, Desktop remote/Cloudflare Access, backup/migration, and iPadOS UX fixes pass full automated Docker verification (`typecheck`, `lint`, full 5,650+ test suite, standalone server smoke, and Playwright WebKit E2E):

- **`v0.7.3` Stability, Cloudflare Access, iPadOS UX & Server Updater Polish:**
  - Switched Electron Cloudflare Access health probing from `net.fetch` (which threw `Redirect was cancelled` on `redirect: "manual"`) to `electron.net.request` redirect interception, flushed session cookies on `did-navigate`, hardened case-insensitive header parsing, and removed `redirect: "manual"` from `local-migrate.cjs`.
  - Split **Desktop app** and **Server** version display in Settings → General, displayed the connected server URL subtly under **Server connection**, added on-demand server release checks (`GET /api/version/latest`), and wired the remote-mode **Automatic updates** toggle directly into `remote-config.json`.
  - Added `scripts/update-server.sh` (1-command atomic Linux server upgrade with `/api/health` verification and automatic rollback).
  - Re-enabled unsigned macOS Apple Silicon `.dmg` packaging on `macos-26` (`8` verified draft assets, manual `.dmg` updates with auto-updater cleanly disabled on unsigned `darwin` bundles to avoid `latest-mac.yml` 404s).
  - Fixed iPadOS WebKit soft-keyboard dock collapse (`components/dock-height.ts` coordinate-invariant `visualViewport` intersection), eliminated stale `dockReserve` dead space after keyboard close (`components/chat.tsx`), added 2-finger pinch-zoom + simultaneous pan to `PlanPopup` and `MermaidOverlay` (`components/pan-zoom.ts`, `components/plan-block.tsx`, `components/session-overlay.tsx`), and shipped iPadOS PWA `apple-icon.png`, `icon-192.png`/`icon-512.png`, and `app/manifest.ts` (`LearnHarness`).
- **`v0.7.2` Onboarding, Cloudflare Access, Backups & UX Upgrades:**
  - Equal side-by-side Desktop first-run choice (**Run locally** with migration callout vs **Connect to a server** with setup docs link) and Settings → General mode switching (`electron/setup.html`, `electron/main.cjs`, `components/settings/settings-dialog.tsx`).
  - Built-in **Cloudflare Access** modal authentication & mid-session expiry recovery in Electron using `net.fetch` and an isolated modal `BrowserWindow` (`electron/remote-config.cjs`, `electron/main.cjs`).
  - Optional private LAN / Tailscale `http://` dictation opt-in (`allowInsecureLanMic`) in Electron + `tailscale serve` HTTPS guidance in docs.
  - Pure-Node `.tar.gz` **Backups & Restore**, automatic `pre-restore` / `pre-migration` safety snapshots, plugin runtime reload (including Flashcards v1 store merge), and 1-click **Migrate local data to server** in Settings → General (`src/server/backup-archive.ts`, `src/server/backups.ts`, `electron/local-migrate.cjs`, `app/api/backups/**`, `components/settings/backups-section.tsx`).
  - Always-visible **Knowledge Graph** button in the sidebar (`components/sidebar.tsx`), desktop auto-updater + desktop/server version display in remote mode (`components/settings/update-settings.tsx`), and `Ctrl+V` image paste & file attachment staging on new Teaching/Practice/Home sessions (`components/home.tsx`, `components/new-session.tsx`, `components/opening-prompt.ts`, `components/chat.tsx`).
- **Upstream `v0.7.0` Integration:** Merged `amosblomqvist/learnharness` `v0.7.0` (`Next.js 16.4.6`, `learnharness@0.7.0`).
- **Reverse-Proxy Header Guard:** `scripts/build-server.mjs` wraps the standalone entrypoint (`server.js` → `server.next.cjs`) and strips untrusted `x-forwarded-*` and `forwarded` headers whenever `LH_TRUST_PROXY !== "1"`.
- **LAN-HTTP Non-Secure Context Support:** Added RFC-4122 v4 browser UUID fallback (`src/core/uuid.ts`), optimistic-build guard in `components/session-core.ts`, clipboard copy fallback in `components/settings/chatgpt-connection.tsx`, and clean `DICTATION_INSECURE_CONTEXT` (`"Dictation requires HTTPS"`) handling in `components/dictation.tsx` (`tests/insecure-context-browser.test.tsx`).
- **iPadOS Viewport Overscroll Lock & Drawing Pad Option A Upgrade:**
  - Locked `html`/`body` against iPadOS rubber-banding (`app/globals.css`, `app/layout.tsx`, `components/sidebar.tsx`, `components/login-form.tsx`) while preserving smooth scrolling inside chat transcripts and overlay modals.
  - Added Option A palm rejection (large-contact filter, pen-over-palm priority, auto-enabling Stylus-only toggle persisted per device), 2-finger pinch-zoom (`0.5x`–`4.0x`) & 2-finger pan without stray strokes, zoom reset button, desktop wheel pan/zoom, and zoom-independent PNG export (`plugins/drawing-pad`, **`78/78` tests PASS**).
- **Automated Docker & WebKit Verification (`Node 26.13.1` + Playwright WebKit):**
  - `npm run typecheck`: Exit `0` (`0` errors)
  - `npm run lint`: Exit `0` (`0` errors)
  - `plugins/drawing-pad` (`typecheck` + `test`): **`78/78` PASS**
  - Full repository unit/integration suite: **`5,644+` PASS** (`0` failures)
  - Standalone production build (`Next.js 16.4.6`, core plugins + authoring skill) + `scripts/build-server.mjs`: **PASS** (`0` leaked secret/data files)
  - All 5 runtime smoke scripts (`smoke-provider-runtime`, `smoke-demo-runtime`, `smoke-compression-runtime`, `smoke-server --isolated`, `smoke-core-plugins`): **PASS**
  - Full Playwright WebKit E2E acceptance suite (`--build-app --all --workers=2`): **`167/167` PASS (`0` failed, `0` timeouts)**
- **Live Self-Hosted Verification:**
  - Deployed and verified on Debian 13 Proxmox LXC (`Node.js 26`, `systemd`, `~160 MB` RAM at runtime) behind Cloudflare Tunnel + Cloudflare Access with single-account `/login`, headless ChatGPT Plus OAuth, iPadOS Safari + Apple Pencil Drawing Pad, and full Windows → Linux profile migration (`--dry-run` → `--apply` → idempotent repeat `--apply` with `0` bytes written).

---

## Implemented Feature Summary

- **Self-Hosted LXC Server, Auth, Proxy & Headless ChatGPT OAuth:**
  - Docker test runner (`scripts/docker-test.ps1`, `scripts/docker-test.sh`, `docker/Dockerfile.test`)
  - Content-addressed attachment store (`src/core/contracts/attachments.ts`, `src/server/attachments.ts`)
  - Reverse-proxy trust & `systemd` deployment (`src/server/desktop-access.ts`, `app/api/health/route.ts`, `deploy/systemd/`)
  - Single-account login (`src/core/contracts/auth.ts`, `src/server/user-auth.ts`, `scripts/user-auth.mjs`, `proxy.ts`, `/login`)
  - Headless ChatGPT Plus OAuth & dynamic `/models` catalog (`electron/chatgpt.cjs`, `src/server/model-catalog.ts`, `app/api/models/refresh/route.ts`)
- **Safe Profile Migration Tooling (`scripts/migrate-profile.mjs`):**
  - Read-only `export` with SHA-256 manifest, reachability-filtered attachment/PDF bundling (`--source-files-root`), idempotent `import --dry-run` / `--apply`, Linux `fileAccess.folders` sanitization, and newer-server preservation.
- **Live Stream Handoff & Isolated Electron Remote Client:**
  - Server-owned turn execution + SSE/NDJSON keepalives (`src/server/stream-keepalive.ts`) + `useServerResync` reconnect/reattach across devices.
  - Privilege-isolated remote desktop client (`electron/remote-config.cjs`, `electron/preload-remote.cjs`, `electron/preload-setup.cjs`, `electron/setup.html`, `electron/remote-reconnect.html`) with `--local` fallback.
- **Attachments (`Ctrl+V` / PDF / Photos) & Overhauled Drawing Pad:**
  - Upload & staging across chat composer, Free-Response, and Multiple-Choice surfaces; PDF text extraction + scanned-page rendering fallback.
  - Full-screen Drawing Pad with Option A palm rejection, Stylus-only mode, 2-finger pinch-zoom & pan, grid overlay, independent `Light`/`Dark`/`App` paper theme, per-question local drafts, and "Add to answer" staging.
- **iPadOS Safari / WebKit Responsive UI & Release Pipeline:**
  - Overlay drawer, safe-area clearance, `visualViewport` keyboard avoidance, touch affordances, viewport overscroll lock, and GitHub Actions release pipeline shipping Windows x64 `.exe`, Linux x64 `AppImage`/`.deb`, and the prebuilt Linux x64 server tarball (`scripts/verify-release.ts`).

See [Setup and Operation](setup-and-operation.md) for deployment instructions and [Developer Handover](developer-handover.md) for architectural details.
