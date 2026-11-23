# Setup and Operation

This guide covers deploying LearnHarness as a central Linux server in a Proxmox LXC container, securing LAN and Cloudflare Tunnel access, configuring single-account authentication and headless ChatGPT Plus OAuth, safely migrating an existing Windows profile, running backups/updates, and using the Windows desktop remote client and iPadOS Safari.

> **Important safety rule:** Never test development builds, synthetic migrations, or installers against your active learning data directory. Always create a clean backup before migrating or upgrading a live server.

---

## 1. Proxmox LXC Server Setup (`Node.js 26` + `systemd`)

LearnHarness runs in production as a standalone Next.js server (`node /opt/learnharness/standalone/server.js`) managed by `systemd`. Reference unit and environment templates live in [`deploy/systemd/learnharness.service`](../deploy/systemd/learnharness.service) and [`deploy/systemd/learnharness.env.example`](../deploy/systemd/learnharness.env.example).

### 1.1 Prerequisites on the LXC container

1. Create a Debian/Ubuntu Linux LXC container under Proxmox (Bookworm/Noble x64).
2. Install **Node.js 26** (matching the repository build baseline) and native runtime prerequisites if needed (`ca-certificates`, `curl`, `rsync`). Verify:
   ```bash
   node -v   # v26.x
   ```
3. Create a dedicated unprivileged service user and persistent directories under `/var/lib/learnharness` and `/etc/learnharness`:
   ```bash
   sudo useradd --system --home /var/lib/learnharness --shell /usr/sbin/nologin learnharness
   sudo mkdir -p /opt/learnharness /etc/learnharness \
     /var/lib/learnharness/data /var/lib/learnharness/auth
   sudo chown -R learnharness:learnharness /var/lib/learnharness
   sudo chmod 0700 /var/lib/learnharness /var/lib/learnharness/data /var/lib/learnharness/auth
   ```
   Keep `/var/lib/learnharness/auth` **outside** `/var/lib/learnharness/data` (`LH_DATA_DIR`) so credentials are never mixed with learning exports or backups.

### 1.2 Install or build the standalone server payload

Choose **Option A** (fastest, works on 2 GB RAM LXCs) or **Option B** (build from source; recommend at least 4 GB RAM or building inside Docker on a build machine because `next build` + TypeScript checking peaks above 2 GB RAM, whereas the running server uses only `~150–200 MB` RAM).

#### Option A — Deploy the prebuilt Linux x64 release tarball (recommended for 2 GB RAM LXCs)

```bash
# Clone the repo once for systemd templates and CLI tools (user-auth.mjs, migrate-profile.mjs)
git clone https://github.com/lukemxlr/learnharness.git /opt/learnharness/src
cd /opt/learnharness/src

# Download and unpack the matching prebuilt standalone bundle from GitHub Releases
VERSION=0.7.1
curl -fsSL -o "/tmp/LearnHarness-${VERSION}-server-linux-x64.tar.gz" \
  "https://github.com/lukemxlr/learnharness/releases/download/v${VERSION}/LearnHarness-${VERSION}-server-linux-x64.tar.gz"

sudo rm -rf /opt/learnharness/standalone
sudo mkdir -p /opt/learnharness/standalone
sudo tar -xzf "/tmp/LearnHarness-${VERSION}-server-linux-x64.tar.gz" -C /opt/learnharness/standalone
sudo chown -R learnharness:learnharness /opt/learnharness/standalone
rm -f "/tmp/LearnHarness-${VERSION}-server-linux-x64.tar.gz"
```

#### Option B — Build the standalone server from source (4 GB+ RAM host or Docker)

On the LXC host (with >= 4 GB RAM) or a matching Linux x64 Node 26 build container:

```bash
git clone https://github.com/lukemxlr/learnharness.git /opt/learnharness/src
cd /opt/learnharness/src

npm ci
npm run plugins:setup
npm run build
node scripts/build-server.mjs
```

Copy the curated `.next/standalone` tree into `/opt/learnharness/standalone`:

```bash
sudo rm -rf /opt/learnharness/standalone
sudo cp -a .next/standalone /opt/learnharness/standalone
sudo chown -R learnharness:learnharness /opt/learnharness/standalone
```

> **Note:** `scripts/build-server.mjs` copies `.next/static/`, `public/`, `scripts/plugin-loader.cjs`, `core-plugins/`, and authoring assets into `.next/standalone/`, wraps the standalone entrypoint (`server.js` → `server.next.cjs`) to strip untrusted `X-Forwarded-*` / `Forwarded` headers unless `LH_TRUST_PROXY=1`, validates prompt assets, and aborts if any `data/`, `auth.json`, `user-auth.json*`, `*-credentials.json*`, or `.env*` file leaked into the bundle.

### 1.3 Environment configuration (`/etc/learnharness/learnharness.env`)

Copy the example file and restrict permissions:

```bash
sudo cp deploy/systemd/learnharness.env.example /etc/learnharness/learnharness.env
sudo chown root:learnharness /etc/learnharness/learnharness.env
sudo chmod 0640 /etc/learnharness/learnharness.env
```

Supported environment variables:

| Variable | Example / Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `production` | Enables Next.js production mode. |
| `NEXT_TELEMETRY_DISABLED` | `1` | Disables Next.js telemetry. |
| `HOSTNAME` | `0.0.0.0` | Listen address (`0.0.0.0` allows LAN and local Cloudflare Tunnel access). |
| `PORT` | `3000` | HTTP listen port for `server.js`. |
| `LH_DATA_DIR` | `/var/lib/learnharness/data` | Persistent directory for chats, knowledge graph, attachments, jobs, settings, prompt overrides, themes, and core-plugin data. |
| `LH_AUTH_FILE` | `/var/lib/learnharness/auth/auth.json` | BYOK provider key store (`{VAR: value}`, mode `0600`). `user-auth.json` and `*-credentials.json` are stored in the same directory (`dirname(LH_AUTH_FILE)`). |
| `LH_ALLOWED_HOSTS` | `learn.example.com,learnharness.local` | Comma-separated case-insensitive hostnames (ports ignored, no wildcards) permitted alongside `localhost` and IP literals. |
| `LH_TRUST_PROXY` | `1` | Honors `X-Forwarded-Proto` and `X-Forwarded-Host` from Cloudflare Tunnel / reverse proxies for `Secure` cookies, CSRF origin validation, and `/login` redirects. When unset or `0`, the standalone server wrapper strips incoming `X-Forwarded-*` and `Forwarded` headers before Next.js reads them. |
| `LH_REQUIRE_AUTH` | `1` | Enforces single-account login on pages, APIs, streams, and attachments (`user-auth.json` must be initialized). |
| `LH_STREAM_KEEPALIVE_MS` | `15000` (optional) | Interval in milliseconds (`50`–`2147483647`) for SSE `: ping\n\n` and NDJSON `{"type":"ping"}\n` keepalive frames during active turns and side-chat streams. |

### 1.4 Install and start the `systemd` unit

```bash
sudo cp deploy/systemd/learnharness.service /etc/systemd/system/learnharness.service
sudo systemctl daemon-reload
sudo systemctl enable learnharness
```

Initialize the single user account (see [Section 3](#3-single-account-authentication--password-reset)) **before** starting the service, then start and verify:

```bash
sudo systemctl start learnharness
sudo systemctl status learnharness
curl -fsS http://127.0.0.1:3000/api/health
# Expected: {"ok":true}
```

`deploy/systemd/learnharness.service` sets `StateDirectory=learnharness` (`0700`), `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectHome=true`, `ProtectSystem=strict`, and `ReadWritePaths=/var/lib/learnharness`. It intentionally omits `MemoryDenyWriteExecute` (required by Node V8 JIT/WASM) and `PrivateUsers` (for unprivileged Proxmox LXC compatibility).

---

## 2. LAN Access & Cloudflare Tunnel

LearnHarness validates the incoming `Host` (or `X-Forwarded-Host` when `LH_TRUST_PROXY=1`) on both page and API requests (`src/server/desktop-access.ts`):

- **`localhost`, `*.localhost`, and IP literals** (e.g., `192.168.1.50:3000`) are always accepted for direct LAN access.
- **Custom hostnames** (e.g., your Cloudflare Tunnel domain `learn.example.com` or LAN mDNS `learnharness.local`) must be listed in `LH_ALLOWED_HOSTS`:
  ```env
  LH_ALLOWED_HOSTS=learn.example.com,learnharness.local
  LH_TRUST_PROXY=1
  ```
- **Cloudflare Tunnel (`cloudflared`)**:
  - Point the tunnel ingress hostname (e.g., `https://learn.example.com`) to `http://127.0.0.1:3000`.
  - Keep `LH_TRUST_PROXY=1` enabled so LearnHarness sees `X-Forwarded-Proto: https` and marks the `lh_session` cookie `Secure`, while validating `Origin` and `Sec-Fetch-Site` against the public HTTPS origin.
  - Ensure no proxy rule buffers or caches `/api/chat`, `/api/chats/*/stream`, `/api/chats/*/side-chats/*`, or `/api/events` (LearnHarness emits `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`, plus periodic keepalive pings).
  - **Cloudflare Access:** Fully supported natively by the LearnHarness desktop app (`v0.7.2+`). When Cloudflare Access redirects `/api/health` or an expired session to `*.cloudflareaccess.com/cdn-cgi/access/login/...`, Electron opens an isolated modal sign-in window (zero preload/IPC) for your email OTP / SSO login, stores the `CF_Authorization` cookie in the app session, and resumes seamlessly — no `/api/health` bypass is required.
- **Tailscale HTTPS (private zero-config TLS for Browser, iPad, &amp; Desktop):**
  - If you prefer Tailscale over a public domain/Cloudflare Tunnel, enable automatic Let's Encrypt HTTPS on your LXC in one command:
    ```bash
    tailscale serve --bg http://127.0.0.1:3000
    ```
  - Add your MagicDNS hostname (`<machine>.<tailnet>.ts.net`) to `LH_ALLOWED_HOSTS` and set `LH_TRUST_PROXY=1` in `/etc/learnharness/learnharness.env`, then restart `learnharness`. Both iPad Safari and desktop browsers get full HTTPS (including microphone **Dictation**) without exposing your server to the public internet.
- **LAN / Tailscale HTTP vs. HTTPS:**
  - Chat, attachments, Drawing Pad, and copy buttons work over both HTTPS and direct trusted LAN/Tailscale HTTP (`http://<LXC-IP>:3000`), using a browser-safe UUID fallback when `crypto.randomUUID` is unavailable in non-secure contexts.
  - Browser microphone **Dictation** (`Dictate`) requires a secure context (`HTTPS` or `localhost`) in web browsers and iPad Safari. In the Electron desktop app, you can either connect over HTTPS (recommended: Cloudflare Tunnel or `tailscale serve`) or enable the explicit **Allow microphone (Dictation) over trusted LAN / Tailscale HTTP** opt-in checkbox in the server setup screen for private RFC1918 / Tailscale (`100.64.0.0/10`) / `.local` / `.ts.net` addresses.

---

## 3. Single-Account Authentication & Password Reset

LearnHarness protects all application pages, API routes, SSE/NDJSON streams, and `/api/attachments/*` behind a single-account login (`/login`) when `LH_REQUIRE_AUTH=1` or when `user-auth.json` exists. Only `/api/health`, `/api/auth/login`, `/api/auth/logout`, and `/api/auth/session` are reachable without a valid `lh_session` cookie.

**There is no browser-based registration or self-service password reset flow.** Account initialization and password resets are performed directly on the LXC host using `scripts/user-auth.mjs`:

```bash
# Load env or pass --auth-file explicitly
export LH_AUTH_FILE=/var/lib/learnharness/auth/auth.json

# 1. Create the initial account (interactive hidden password prompt; min 8 chars)
sudo -u learnharness LH_AUTH_FILE=/var/lib/learnharness/auth/auth.json \
  node /opt/learnharness/src/scripts/user-auth.mjs init --username learner

# 2. Check status (prints JSON with configured, username, updatedAt, mode)
sudo -u learnharness LH_AUTH_FILE=/var/lib/learnharness/auth/auth.json \
  node /opt/learnharness/src/scripts/user-auth.mjs status

# 3. Reset password directly on the server
sudo -u learnharness LH_AUTH_FILE=/var/lib/learnharness/auth/auth.json \
  node /opt/learnharness/src/scripts/user-auth.mjs reset-password
```

Notes:
- `scripts/user-auth.mjs` writes `user-auth.json` atomically in `dirname(LH_AUTH_FILE)` with mode `0600` using `scrypt` (`N=16384, r=8, p=1`) and a 32-byte `sessionSecret`.
- Running `reset-password` rotates `sessionSecret`, which **immediately invalidates all active browser and desktop sessions** on the next request without needing to clear client storage manually.
- For automated/non-interactive setups, pass `--password-stdin` (avoid `--password` in shared shell history).

---

## 4. Headless ChatGPT Plus OAuth Login & Model Catalog

Because the Proxmox LXC server has no graphical browser, LearnHarness includes a **Remote / headless sign-in** flow for ChatGPT Plus (`electron/chatgpt.cjs` + `src/server/web-subscriptions.ts`). Once connected on the server, **both the Windows desktop client and iPad Safari share that single server-side ChatGPT connection**.

### 4.1 Connect ChatGPT Plus on the headless server

1. Sign in to LearnHarness from any browser (Windows or iPad) and open **Settings → Providers → Subscriptions**.
2. Next to **ChatGPT**, click **Connect**.
3. Optionally toggle **Allow background use for all ChatGPT accounts** (controls whether helper/background agents may use your ChatGPT Plus plan).
4. In the **Running on a headless/remote server?** box, click **Get sign-in link**.
   - The server starts a temporary PKCE OAuth listener on `127.0.0.1:<ephemeral-port>/auth/callback` and returns the authorization URL.
5. Click **Copy link** or **Open** and complete the OpenAI sign-in in your local browser.
6. After authorizing, OpenAI redirects your browser to `http://127.0.0.1:<port>/auth/callback?code=...&state=...`.
   - Unless you forwarded `<port>` over SSH (`ssh -L <port>:127.0.0.1:<port> <lxc-host>`), your local browser will show a connection-refused page on `127.0.0.1` — **this is expected**.
7. Copy the **entire redirect URL** from your browser's address bar, paste it into **Paste redirect URL** in the LearnHarness dialog, and click **Complete sign-in**.
   - First-time sign-in requires the full redirect URL (including `state`, `code`, and `client_id`).
8. Credentials are stored server-side in `/var/lib/learnharness/auth/chatgpt-credentials.json` (`0600`).

### 4.2 Model catalog discovery and refresh

- On connection and via `GET /api/models` (with a 5-minute server TTL cache), LearnHarness queries OpenAI's `/models` endpoint with your server-side OAuth token and merges newly released ChatGPT models (`visibility === "list"`) with known `pi-ai` metadata.
- To fetch newly released models immediately without waiting for cache expiry, open **Settings → Providers → Subscriptions** and click **Refresh models** (`POST /api/models/refresh`).
- If a catalog refresh encounters a transient network or upstream error, LearnHarness keeps the last-known-good model list visible and displays a non-fatal error notice.
- Refreshing the model catalog **never silently changes the model pinned to existing chat sessions**; each session retains its own selected model.

---

## 5. Consistent Export & Safe Windows → LXC Migration

The migration tool (`scripts/migrate-profile.mjs`) transfers chats, knowledge graph ledgers, reachable attachments/local image & PDF references, jobs, custom themes, prompt overrides, and sanitized settings from Windows to Linux **without modifying your Windows source files**.

### 5.1 Step 1 — Create a consistent Windows snapshot

1. Finish your last local study session on Windows.
2. **Completely quit** the local LearnHarness desktop app (ensure no `LearnHarness.exe` process remains running in Task Manager) so no writes are in flight to chats or JSONL graph files.
3. Make a safety copy of your local learning data directory before running any export:
   - Default Windows Electron data location: `C:\Users\<user>\AppData\Roaming\LearnHarness\data`
   - Copy it to a temporary staging folder, e.g. `C:\Users\<user>\Desktop\lh-backup\data` (never modify the original).

### 5.2 Step 2 — Export a self-contained migration bundle

Run `migrate-profile.mjs export` (using Node 26 or a Docker Node 26 container mounting the backup copy read-only):

```bash
node scripts/migrate-profile.mjs export \
  --source /path/to/lh-backup/data \
  --out /path/to/lh-migration-bundle \
  --source-os win32
```

Optional flags:
- `--source-files-root <dir>`: extra local root folder (may be repeated) to search when resolving referenced files stored outside `data/` (for example, local lecture PDFs or images attached by path in desktop chats).
- `--json`: machine-readable export report.

> **Flashcards note:** If you used the built-in **Flashcards** core plugin locally, also copy `<backup>/data/core-plugin-data/flashcards/` to `/var/lib/learnharness/data/core-plugin-data/flashcards/` (owned by `learnharness:learnharness`) while the service is stopped during Step 4.

What `export` guarantees:
- **Strictly read-only** on `--source`.
- **Excludes secrets and debug dumps**: skips `auth.json`, `user-auth.json*`, `*-credentials.json*`, `.env*`, and `debug/`.
- **Reachability filtering**: only attachments/files actually referenced by chats, jobs, or notes sources are bundled; unreferenced orphans are counted under `Skipped orphans` and omitted.
- **Integrity manifest**: writes `manifest.json` containing counts, diagnostics, and SHA-256 `fileChecksums` for every file in the bundle.

### 5.3 Step 3 — Transfer to LXC and run `--dry-run` first

Copy the bundle directory to the LXC server (e.g., `/tmp/lh-migration-bundle`), ensure the `learnharness` service user can read it, and inspect a dry run first:

```bash
# On the LXC server
sudo -u learnharness LH_DATA_DIR=/var/lib/learnharness/data \
  node /opt/learnharness/src/scripts/migrate-profile.mjs import \
  --bundle /tmp/lh-migration-bundle \
  --target /var/lib/learnharness/data \
  --dry-run
```

`--dry-run` writes **`0` bytes** to the target directory and prints a full preview:
- `Integrity valid`: verifies every SHA-256 checksum in `manifest.json` and rejects symlinks or path traversal.
- `Chats` / `Jobs`: shows `create`, `update`, `skipServerNewer`, `skipUnchanged`, `skipNewerSchema`.
- `Attachments`: shows `ingest` vs. `alreadyPresent` (SHA-256 deduplicated).
- `Graph`: shows counts for `nodes`, `chains`, `sessions`, `coverage`, `sources`.
- `Settings`: shows whether `settings.json` will be created/updated/preserved and lists `strippedWindowsFolders` (Windows drive `C:\...` and UNC `\\...` paths removed from `agent.fileAccess.folders` on Linux while keeping `restricted` intact).
- `Diagnostics`: clearly flags missing referenced files (`missing_referenced_file`, `missing_attachment_file`), legacy Windows/UNC paths (`windows_path`, `unmapped_windows_path`), and retired legacy graph ledgers (`edges.jsonl` / `events.jsonl`).

### 5.4 Step 4 — Apply the migration & verify idempotency

Stop the `learnharness` service so no concurrent writes occur during cutover, run `--apply`, and start the service:

```bash
sudo systemctl stop learnharness

sudo -u learnharness LH_DATA_DIR=/var/lib/learnharness/data \
  node /opt/learnharness/src/scripts/migrate-profile.mjs import \
  --bundle /tmp/lh-migration-bundle \
  --target /var/lib/learnharness/data \
  --apply
```

Verify safety and idempotency:
1. Run the same `--apply` command a second time — it must report `Bytes written: 0` (no duplicate chats, no duplicate graph nodes/chains/checkpoints).
2. Start the server (`sudo systemctl start learnharness`), log in, and confirm your sessions, knowledge graph, and attachments render properly.
3. If you later edit or create sessions on the server and accidentally re-run `--apply` with an older bundle, newer server chats, jobs, settings, and coverage entries are **never overwritten** (`skipServerNewer` / `preserve_server`).
4. Remove `/tmp/lh-migration-bundle` after verifying the cutover, and keep your original Windows backup archived safely.

---

## 6. Backup, Restore & Server Updates

### 6.0 In-app Backups, Automatic Safety Snapshots &amp; 1-Click Restore

From **Settings → General → Backups &amp; Restore** (available in local mode, remote desktop, web browser, and iPad Safari):
- **Backup &amp; download:** creates a verified `.tar.gz` snapshot under `<LH_DATA_DIR>/.backups/` (excluding API keys and login credentials) and downloads it immediately.
- **Restore from file…:** upload any `.tar.gz` backup, preview its contents, and choose **Merge safely** (preserves newer existing chats) or **Full replace** (exact restore).
- **Automatic rollback protection:** before every restore or 1-click local-to-server migration, LearnHarness automatically creates a verified `pre-restore` or `pre-migration` safety snapshot so you can roll back with one click in **Saved snapshots** if anything goes wrong.

### 6.1 Periodic backups (CLI / Proxmox snapshot)

For a guaranteed consistent backup, stop the service briefly (or take an atomic Proxmox LXC/ZFS snapshot), then archive both `/var/lib/learnharness` and `/etc/learnharness`:

```bash
sudo systemctl stop learnharness
sudo tar -C / -czf "/root/learnharness-backup-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" \
  var/lib/learnharness/data \
  var/lib/learnharness/auth \
  etc/learnharness/learnharness.env
sudo systemctl start learnharness
```

Store backups off-host (they contain your learning history and `0600` credential files).

### 6.2 Restore from backup

```bash
sudo systemctl stop learnharness
sudo tar -C / -xzf /root/learnharness-backup-<timestamp>.tar.gz
sudo chown -R learnharness:learnharness /var/lib/learnharness
sudo chmod 0700 /var/lib/learnharness /var/lib/learnharness/data /var/lib/learnharness/auth
sudo chmod 0600 /var/lib/learnharness/auth/*.json 2>/dev/null || true
sudo systemctl start learnharness
```

### 6.3 Updating the server safely

**Fast update using the prebuilt release tarball (recommended for 2 GB RAM LXCs):**

```bash
cd /opt/learnharness/src
git pull --ff-only

VERSION=0.7.1   # replace with the target release version
curl -fsSL -o "/tmp/LearnHarness-${VERSION}-server-linux-x64.tar.gz" \
  "https://github.com/lukemxlr/learnharness/releases/download/v${VERSION}/LearnHarness-${VERSION}-server-linux-x64.tar.gz"

sudo systemctl stop learnharness
sudo rm -rf /opt/learnharness/standalone
sudo mkdir -p /opt/learnharness/standalone
sudo tar -xzf "/tmp/LearnHarness-${VERSION}-server-linux-x64.tar.gz" -C /opt/learnharness/standalone
sudo chown -R learnharness:learnharness /opt/learnharness/standalone
rm -f "/tmp/LearnHarness-${VERSION}-server-linux-x64.tar.gz"
sudo systemctl start learnharness

curl -fsS http://127.0.0.1:3000/api/health
```

**Or rebuild from source (4 GB+ RAM host):**

```bash
cd /opt/learnharness/src
git pull --ff-only
npm ci
npm run plugins:setup
npm run build
node scripts/build-server.mjs

sudo systemctl stop learnharness
sudo rm -rf /opt/learnharness/standalone
sudo cp -a .next/standalone /opt/learnharness/standalone
sudo chown -R learnharness:learnharness /opt/learnharness/standalone
sudo systemctl restart learnharness

curl -fsS http://127.0.0.1:3000/api/health
```

Your sessions, graph ledgers, attachments, `user-auth.json`, and provider credentials live in `/var/lib/learnharness` and persist across service restarts and upgrades.

---

## 7. Windows Desktop Remote Client & iPadOS Safari Usage

### 7.1 Installing or building the Windows desktop client

Download the prebuilt unsigned Windows x64 NSIS installer (`LearnHarness-<version>-x64-setup.exe`) from **[GitHub Releases](https://github.com/lukemxlr/learnharness/releases)**, or build it locally on a Windows x64 machine:

```powershell
npm ci
npm run plugins:setup
npm run build
node scripts/build-server.mjs
npx electron-builder --win --x64 --publish never
```

This produces `dist\LearnHarness-<version>-x64-setup.exe`.

**First-run connection & day-to-day behavior:**
1. Launch **LearnHarness** on Windows. Because no local server is started in remote mode, it opens **Connect to LearnHarness Server** (`electron/setup.html`).
2. Enter your server URL (prefer your HTTPS Cloudflare Tunnel URL `https://learn.example.com`, or LAN HTTP `http://<LXC-IP>:3000`) and click **Connect**.
   - Electron validates the URL (`http://` or `https://`, no query/fragment/userinfo) and checks `GET /api/health` (`{"ok":true}`) before saving `remote-config.json` in `C:\Users\<user>\AppData\Roaming\LearnHarness\remote-config.json`.
3. Sign in on `/login` with your server username and password.
4. **Changing the server URL later:**
   - Press `Ctrl+Alt+S`, or right-click inside the window and select **Change Server URL…**, or click **Change Server URL** from the reconnect screen.
5. **Connection loss recovery:**
   - If the server is unreachable or returns HTTP `502`/`503`/`504`/`530`, Electron displays **Could not reach your LearnHarness server** (`electron/remote-reconnect.html`) with **Reconnect** and **Change Server URL** buttons.
6. **Privilege isolation in remote mode:**
   - The remote window uses `electron/preload-remote.cjs` with `contextIsolation: true` and `sandbox: true`. Local filesystem path pickers, local OAuth bridges, and local auto-updater IPC are not exposed to the remote origin.
7. **Windows `Ctrl+V` screenshot paste:**
   - Capture a screenshot (e.g., `Win+Shift+S`), click into the chat composer, Free-Response answer field, or Multiple-Choice reasoning field, and press `Ctrl+V`. The screenshot uploads to `/api/attachments` and appears as a removable preview thumbnail. Normal text `Ctrl+V` continues to paste text as usual.

*(To force standalone local desktop mode temporarily for troubleshooting, launch with `--local` or `LH_LOCAL_MODE=1`.)*

### 7.2 iPadOS Safari workflow

1. Open `https://learn.example.com` in **iPadOS Safari** and sign in on `/login` (you can optionally tap **Share → Add to Home Screen**).
   - The app shell locks viewport overscroll so rubber-banding never drags the outer window while the chat transcript and overlay modals scroll smoothly with touch momentum.
   - In a narrow window, tap **Open sidebar** to show the sessions over the current page. Close it with **Close sidebar** or tap the backdrop.
2. **Seamless live-stream handoff between Windows and iPad:**
   - Start a prompt or answer on Windows, close your laptop lid, and open the same session URL (`/chat/<id>`) on your iPad.
   - The server executes turns independently of any single browser connection (`runPiTurn` + `GET /api/chats/[id]/stream`), so your iPad immediately displays prior messages, replays the in-flight turn log, and streams the rest of the response without starting a second model run.
   - If Safari suspends and later wakes the tab, `useServerResync` automatically refetches `/api/jobs` and reattaches to any active turn.
3. **Photos, Files, and PDF attachments:**
   - Tap the paperclip attachment control in the chat composer, Free-Response answer, or Multiple-Choice question to choose images (`PNG`, `JPEG`, `WebP`, `GIF` up to 20 MiB) or `.pdf` files (up to 25 MiB / 200 pages) from **Photo Library** or **Files**.
   - Staged attachments show removable previews before submission; if an upload fails, your typed draft and Multiple-Choice selection remain intact.
4. **Drawing Pad (Apple Pencil palm rejection &amp; pinch-zoom):**
   - Enable **Drawing Pad** once in **Settings → Core plugins**.
   - Tap **Draw** in the session top bar to open the full-screen canvas with Apple Pencil / touch / mouse support, optional **Grid** (`Karoraster`), **Undo** / **Redo**, **Pen** / **Eraser** / **Hand** / **Clear**, six ink color swatches, **Stroke width** slider (`2`–`16` px), and collapsible **Question** reference bar.
   - **Palm rejection (Option A):** Large touch contacts are filtered automatically, Apple Pencil takes priority over palm touches, and the **Stylus-only** toolbar toggle automatically activates on your first Apple Pencil touch (persisted per device, toggleable anytime if you want to sketch with a finger).
   - **Zoom &amp; pan:** Use **2-finger pinch** (`50%–400%`) to zoom in on fine handwriting and **2-finger drag** to pan across the sheet without leaving stray strokes. Tap the zoom readout button (e.g., `150%`) to reset to `100%` (desktop browsers also support scroll-wheel pan and `Ctrl/Cmd + wheel` zoom). Exported PNGs are always crisp and zoom-independent.
   - Use **Light** / **Dark** / **App** paper theme buttons independently of your app theme (e.g., **Light** paper while the app is in **Dark** mode); monochrome strokes automatically adapt so exported PNGs remain crisp and legible.
   - Incomplete drawings are saved in Safari on that device, per session and question. Tap **Add to answer** to stage the drawing as an attachment preview, then submit your answer so the image appears in the shared transcript on both iPad and Windows.

See the [Docker verification results](developer-handover.md#42-milestone-verification-status) and the [manual acceptance checklist](../tests/e2e/MANUAL_IPAD_AND_WINDOWS_CHECKLIST.md) before cutover. Use the checklist on a real iPad to verify Safari's keyboard, safe areas, native pickers, and Apple Pencil, and on your LXC to verify HTTPS, sign-in, and migration.
