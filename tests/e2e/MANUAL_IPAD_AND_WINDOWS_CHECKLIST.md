# Manual Acceptance Checklist — Real iPadOS Hardware, Isolated Windows VM & Live LXC Deployment

This document explicitly separates **what is already covered automatically in Docker WebKit (`tests/e2e/`)** from **what requires physical iPadOS hardware, an isolated Windows VM, or the user's real LXC + ChatGPT Plus account**.

> **Strict Isolation Rule:** Never run development builds, test installers, auto-updater probes, or synthetic migration tests against the productive Windows laptop or its user data directory. Windows desktop/installer checks must run **only** inside a disposable Windows VM with no access to the productive profile. Do not include personal learning materials, real emails, or host user paths in any test or checklist run.

---

## Automated Docker WebKit Coverage vs. Manual Acceptance Scope

| Capability Area | Automated in Docker (`tests/e2e/`) | Requires Manual Hardware / Isolated VM / Live Account |
|---|---|---|
| Viewport layout, overflow, touch targets (`>=44x44` CSS px), `visualViewport` shrink simulation | **Covered** (`Tier 1–4` in WebKit 18 across all 8 iPad presets + `320x1024` + `1440x900`) | Real iPadOS Safari dynamic toolbar collapse, physical onscreen/hardware keyboard height & safe-area notch/home-indicator insets |
| Drawing Pad pointer parity (`mouse`/`touch`/`pen`), Karoraster, colors/widths, Light paper in Dark app, export contrast | **Covered** (synthetic `PointerEvent`s + PNG pixel contrast verification) | Real Apple Pencil palm rejection, tilt/pressure feel, iPadOS Scribble/zoom gesture interference |
| Clipboard image/text paste & file inputs | **Covered** (`ClipboardEvent("paste")` + `setInputFiles` + SHA-256 `/api/attachments`) | Real Windows `Win+Shift+S` OS clipboard + `Ctrl+V`; real iPadOS Photos/Camera/Files system sheets |
| Electron remote config, preload isolation & reconnect/setup UI | **Covered** (`electron-harness.mjs` under Node 26 + WebKit HTML checks) | Real NSIS Windows installer, OS window frame/tray/zoom shortcuts, live auto-updater against test feed |
| Auth gate, proxy headers, headless OAuth PKCE & migration idempotency | **Covered** (`mock-provider.mjs`, `ServerController`, synthetic fixture profile) | Live Proxmox Linux LXC `systemd` service, real Cloudflare Tunnel HTTPS, real ChatGPT Plus login, real profile export/import |

---

## Section A — Real iPadOS Safari & Apple Pencil (R4, R5, F12)

### A.1 Required CSS-px Viewport Matrix Reference

Confirm automated coverage aligns with physical iPad behavior across all 8 documented iPad CSS-pixel presets (plus `VP-DESK-REF` desktop reference):

| Preset ID | CSS Pixels (W × H) | Device Class / Mode | Automated Touch / DPR |
|---|---|---|---|
| `VP-SM-PORT` | `744×1133` | Small iPad (mini) Portrait | `hasTouch=true`, `isMobile=true`, `dpr=2` |
| `VP-SM-LAND` | `1133×744` | Small iPad (mini) Landscape | `hasTouch=true`, `isMobile=true`, `dpr=2` |
| `VP-MD-PORT` | `820×1180` | Medium iPad (Air / 10.9") Portrait | `hasTouch=true`, `isMobile=true`, `dpr=2` |
| `VP-MD-LAND` | `1180×820` | Medium iPad (Air / 10.9") Landscape | `hasTouch=true`, `isMobile=true`, `dpr=2` |
| `VP-LG-PORT` | `1024×1366` | Large iPad (Pro 12.9"/13") Portrait | `hasTouch=true`, `isMobile=true`, `dpr=2` |
| `VP-LG-LAND` | `1366×1024` | Large iPad (Pro 12.9"/13") Landscape | `hasTouch=true`, `isMobile=true`, `dpr=2` |
| `VP-SPLIT-1` | `375×1024` | iPad Split View 1/3 / Slide Over | `hasTouch=true`, `isMobile=true`, `dpr=2` |
| `VP-SPLIT-2` | `507×1180` | iPad Split View 1/2 | `hasTouch=true`, `isMobile=true`, `dpr=2` |
| `VP-DESK-REF` | `1440×900` | Desktop Reference Client | `hasTouch=false`, `isMobile=false`, `dpr=1` |

### A.2 Physical iPad Safari Checklist

- [ ] **A.1 Authentication & Safe Areas:** Open the HTTPS server URL in iPadOS Safari, sign in on `/login`, and verify top/bottom chrome clears the status bar and home indicator without clipping or horizontal page bounce.
- [ ] **A.2 Apple Pencil Strokes & Palm Rejection:** Open Drawing Pad (`Draw`), rest palm on screen while sketching with Apple Pencil. Confirm smooth pen strokes without unintended finger/palm marks or page scrolling (`touch-action: none`).
- [ ] **A.3 Tilt / Pressure, Karoraster & Paper Theme:** Enable the Karoraster grid, switch between colors and stroke widths, select **Light** paper while the app remains in **Dark** mode, click **Add to answer**, and verify the staged preview thumbnail and delivered image are crisp and high-contrast.
- [ ] **A.4 Question Context & Drawing Ergonomics:** Expand and collapse the `Question` bar on Landscape (`1133×744` or `1180×820`), verify the prompt is readable without blocking the canvas when collapsed.
- [ ] **A.5 Onscreen & Hardware Keyboard Clearance:** Tap into a Free-Response or Multiple-Choice reasoning box with the iPadOS software keyboard visible (and repeat with a Magic/Bluetooth keyboard + shortcut bar). Confirm the active input, staged attachment preview, and **Submit answer** button stay reachable without horizontal overflow.
- [ ] **A.6 Photos & Files Picker:** Attach both an image from **Photo Library** and a multi-page `.pdf` from **Files** into a chat or active question; confirm previews appear, can be removed before send, and render in the transcript after submission.
- [ ] **A.7 Split View, Slide Over & Orientation Preservation:** With a half-selected Multiple-Choice option, typed reasoning text, and an unsent Drawing Pad draft, rotate Portrait ↔ Landscape and toggle Split View (`1/3` / `1/2` width). Confirm selection, text, and drawing draft remain intact and the sidebar drawer opens/closes cleanly over the main column.
- [ ] **A.8 Touch-First Side Conversations & Target Sizing:** Tap prose without hover to reveal and open a side-question thread, open/scroll the Model Picker, and confirm every primary control is comfortable to tap (`>= 44×44` CSS px) with no clipped popovers.

---

## Section B — Isolated Windows VM Electron Desktop (R1, R3, R5, F8)

> **Disposable VM Only:** Execute Section B **exclusively** inside a clean, isolated Windows test VM with synthetic test credentials and zero access to the user's productive Windows installation or user profile data directory.

- [ ] **B.1 NSIS Installer & Isolated Launch:** Run the packaged NSIS Windows installer inside the disposable VM, launch LearnHarness Desktop, and verify it starts cleanly without touching any pre-existing local profile.
- [ ] **B.2 First-Run Server URL Validation & Setup:** On `Connect to LearnHarness Server`, test an invalid URL (confirm inline validation error without saving), then enter the test server URL and click **Connect**; confirm `/login` loads inside the app window.
- [ ] **B.3 Offline Reconnect Overlay & Change Server URL:** Temporarily stop the test server or disconnect the VM network, trigger a reload/request, and verify the **Could not reach your LearnHarness server** overlay appears with working **Reconnect** (once server returns) and **Change Server URL** actions.
- [ ] **B.4 Remote Privilege Isolation:** Confirm desktop local-only controls (local attachment folder picker, local OAuth subscription settings) are absent/disabled when running in remote-server mode.
- [ ] **B.5 Auto-Updater Check:** Point the VM test build at an isolated test update feed (if configured) and confirm **Check for Updates** reports status cleanly without corrupting `remote-config.json`.
- [ ] **B.6 Real `Win+Shift+S` + `Ctrl+V` Screenshot & Text Paste:** Capture a region with `Win+Shift+S`, focus a Free-Response answer box and press `Ctrl+V` (verify image preview attaches); repeat in a Multiple-Choice reasoning box; verify normal text `Ctrl+V` continues to paste plain text without creating bogus image attachments.

---

## Section C — Live LXC, Cloudflare Tunnel, ChatGPT Plus & Real Profile Migration (R2, R3, R6)

> Executed by the user against the real Proxmox Linux LXC server and real account after automated M1–M6 gates pass.

- [ ] **C.1 Linux LXC `systemd` Service & File Permissions:** Verify the dedicated service user owns the persistent data directory and `user-auth.json` has restrictive `0600` permissions. Restart the `systemd` unit mid-verification and confirm sessions, chat history, attachments, and auth state survive restart.
- [ ] **C.2 Cloudflare Tunnel HTTPS & Single-Account Auth:** Access the external Cloudflare Tunnel URL from both Windows and iPad, verify unauthenticated routes redirect/return `401`, log in via `/login`, and test CLI-only `scripts/user-auth.mjs reset-password` directly on the LXC host (confirming old cookies invalidate immediately).
- [ ] **C.3 Headless ChatGPT Plus OAuth & Model Catalog Refresh:** On the LXC server without a local browser, complete the headless ChatGPT Plus sign-in flow from Settings, verify model discovery populates the Model Picker, and confirm clicking **Refresh models** preserves existing session model selections.
- [ ] **C.4 Live Mid-Stream Desktop ↔ iPad Handoff:** Start a long response on the Windows Desktop client, switch immediately to iPadOS Safari on the same chat URL while tokens are still streaming, and confirm full prior history plus live streaming completion appear on the iPad without triggering a second model run.
- [ ] **C.5 Real Profile Migration (Safe Read-Only Cutover):**
  1. Take a clean backup/export after the final local Windows study session so source files remain unmodified.
  2. Run `scripts/migrate-profile.mjs import ... --dry-run` on the LXC server and inspect all missing-file and legacy Windows path warnings.
  3. Run `--apply` only after verifying the dry-run summary, verify migrated chats, knowledge graph, and reachable attachments in the web UI, and confirm a repeat `--apply` produces zero duplicates and never overwrites newer server edits.
