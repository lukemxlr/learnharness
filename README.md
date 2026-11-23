<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/lh_banner_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/lh_banner_light.png">
    <img src="docs/assets/lh_banner_light.png" alt="LearnHarness" width="640">
  </picture>
</p>

<p align="center"><strong>An agent harness for learning — Self-Hosted Server, iPadOS + Apple Pencil, &amp; Remote Desktop Edition.</strong></p>

<p align="center">
  <a href="https://github.com/lukemxlr/learnharness/releases">Releases</a> ·
  <a href="#what-this-fork-adds">What's new</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/setup-and-operation.md">Server &amp; iPad guide</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="https://github.com/lukemxlr/learnharness/issues">Issues</a>
</p>

> **Fork attribution:** This repository is an independent open-source fork of [LearnHarness](https://github.com/amosblomqvist/learnharness) by [Amos Blomqvist](https://github.com/amosblomqvist) (currently based on upstream `v0.7.0`), distributed under the same [GNU AGPL-3.0](LICENSE) license. It extends LearnHarness for central self-hosting on Linux / Proxmox LXC, seamless desktop-to-iPad live-stream handoff, Apple Pencil drawing &amp; attachments, headless ChatGPT Plus OAuth, and an isolated remote desktop client.

LearnHarness uses AI agents to plan and teach lessons from your current understanding to your goal. It builds a detailed picture of what you understand and how you reason, updating that picture as you learn. Teaching builds understanding one reasoning step at a time; practice makes it usable; a persistent knowledge graph carries it across sessions.

![LearnHarness teaching session](docs/assets/teaching-session.png)

---

## What this fork adds

1. **Central Self-Hosted Server (Linux / Proxmox LXC + `systemd`)**
   - Runs as a lean standalone `Node.js 26` server (`~150–200 MB` RAM at runtime) with a hardened `systemd` unit ([`deploy/systemd/learnharness.service`](deploy/systemd/learnharness.service)).
   - Single-account `/login` protection (`LH_REQUIRE_AUTH=1`, `scrypt` password hashing, HMAC-SHA256 `HttpOnly` session cookies, CLI-only account &amp; password management via `scripts/user-auth.mjs`).
   - Strict host validation (`LH_ALLOWED_HOSTS`) and reverse-proxy header guard (`LH_TRUST_PROXY=1` for Cloudflare Tunnel / reverse proxies; strips untrusted `X-Forwarded-*` headers when disabled).
   - Every release ships a **prebuilt Linux x64 standalone server tarball** (`LearnHarness-<version>-server-linux-x64.tar.gz`) so even 2 GB RAM LXC containers can deploy and upgrade in seconds without running `next build`.
2. **Seamless Multi-Device Live Stream Handoff (Desktop ↔ iPad)**
   - Agent turns run on the server independently of any single browser tab. Start a prompt on Windows or Linux, switch to your iPad mid-response, and the live stream attaches immediately without starting a duplicate turn.
   - SSE/NDJSON keepalive pings (`LH_STREAM_KEEPALIVE_MS`) and automatic reconnect/resync survive Cloudflare Tunnel idle windows and Safari tab suspension.
3. **iPadOS Safari UX &amp; Overhauled Drawing Pad**
   - Responsive overlay drawer, Split View (`1/3`, `1/2`, Slide Over), `visualViewport` keyboard clearance, 44 × 44 px touch targets, and iPadOS viewport overscroll lock (eliminating accidental rubber-banding of the shell while keeping chat and modals smoothly scrollable).
   - **Drawing Pad** (enable once in **Settings → Core plugins**): full-screen canvas with **Option A palm rejection** (large-contact rejection, pen-over-palm priority, auto-enabling Stylus-only toggle persisted per device), **2-finger pinch-zoom (`50%–400%`) &amp; 2-finger pan** without stray strokes, zoom reset button, `Karoraster` grid overlay, independent `Light` / `Dark` / `App` paper theme (e.g., white paper in dark mode with automatic stroke legibility), Undo/Redo, ink colors, stroke width slider, collapsible Question reference bar, per-question local drafts, and **Add to answer** staging.
4. **Unified Attachments &amp; `Ctrl+V` Screenshots Everywhere**
   - Upload images (`PNG`, `JPEG`, `WebP`, `GIF`, up to 20 MiB) and PDFs (up to 25 MiB / 200 pages) from desktop or iPad **Photo Library** / **Files** — including right from the start of a new Teaching or Practice session, in active chats, Free-Response questions, and Multiple-Choice reasoning fields.
   - Press `Ctrl+V` on Windows/Linux to paste screenshots straight from the clipboard on every input surface (including new sessions).
   - Content-addressed attachment store (`<LH_DATA_DIR>/attachments/<sha256>/`) with automatic PDF text extraction and vision page-rendering fallback for scanned PDFs.
5. **Headless ChatGPT Plus OAuth &amp; Dynamic Model Catalog**
   - Connect ChatGPT Plus once on a headless server (paste the loopback redirect URL or forward the callback port over SSH) — both your desktop client and iPad share the single server-side connection.
   - Dynamically discovers newly released ChatGPT models via `/models` with an on-demand **Refresh models** button in Settings, retaining the last-known-good catalog on transient errors and never altering models pinned to existing sessions.
6. **Flexible Local &amp; Remote Desktop App (Windows &amp; Linux) + Built-in Cloudflare Access**
   - First launch offers two equal choices side by side: **Run locally** on your PC (with seamless later migration to a server) or **Connect to a remote server** (with a direct link to the server setup guide).
   - Native **Cloudflare Access** login &amp; automatic session re-authentication inside an isolated modal window — no need to disable Cloudflare Access or bypass `/api/health`.
   - Optional **LAN / Tailscale HTTP microphone opt-in** for trusted private networks, automatic desktop updates in both local and remote modes, and an always-visible **Knowledge Graph** button in the sidebar.
7. **In-App Backups, Automatic Safety Snapshots &amp; 1-Click Migration**
   - **Settings → General → Backups &amp; Restore:** create &amp; download verified `.tar.gz` backups anytime, restore from a `.tar.gz` file (*Merge safely* or *Full replace*), or roll back with one click to an **automatic safety snapshot** (`pre-migration` / `pre-restore`) created before every change.
   - **1-Click Local → Server Migration:** when switching from local mode to a remote server, Electron detects local desktop data, saves automatic local + server safety backups, uploads attachments individually (avoiding Cloudflare's 100 MB request cap), and merges chats, knowledge graph, and flashcards idempotently. CLI tooling (`scripts/migrate-profile.mjs`) remains available for offline/scripted transfers.

---

## How LearnHarness works

1. **Measure.** Before teaching, the agent finds where your understanding ends on each part the lesson depends on.
2. **Plan.** It works out a dependency map from that starting point to your goal. You can see and steer the plan.
3. **Teach.** Each step builds on something you already understand. You predict, get an explanation, and check your understanding. Confusions are repaired before anything is built on them.
4. **Practice.** Separate sessions pose varied problems that require the right knowledge to come to mind without being named first.
5. **Knowledge that carries forward.** Propositions and reasoning chains accumulate in a persistent knowledge graph with links back to source sessions.

![LearnHarness knowledge graph](docs/assets/knowledge-graph.png)

---

## Quick start

### 1. Desktop App (macOS, Windows &amp; Linux)

Download the latest release from **[GitHub Releases](https://github.com/lukemxlr/learnharness/releases)**:

- **macOS (Apple Silicon / arm64):** `LearnHarness-<version>-arm64.dmg` (unsigned DMG — drag to **Applications**, then once run `xattr -cr /Applications/LearnHarness.app` in Terminal to clear the macOS Gatekeeper quarantine flag; updates install manually via the latest `.dmg` because Squirrel.Mac requires an Apple Developer signature).
- **Windows (x64):** `LearnHarness-<version>-x64-setup.exe` (unsigned per-user NSIS installer; Windows SmartScreen may show an "unknown publisher" prompt; supports automatic in-app updates).
- **Linux (x64):** `LearnHarness-<version>-x86_64.AppImage` or `LearnHarness-<version>-amd64.deb` (both support automatic in-app updates).

On first launch, choose **Run locally** on your computer or **Connect to a server** (enter `https://learn.example.com`, your Tailscale HTTPS URL, or a LAN `http://<server-ip>:3000` address). You can switch between local and remote modes anytime via **Settings → General** or `Ctrl+Alt+S` / `Cmd+Option+S`.

### 2. Self-Hosted Linux / Proxmox LXC Server

Full step-by-step guide: **[Setup and Operation](docs/setup-and-operation.md)**.

**Fast path (recommended for 2 GB RAM LXCs) — using the prebuilt server tarball:**

```bash
# 1. Install Node.js 26 on Debian/Ubuntu LXC and create service user + folders
sudo useradd --system --home /var/lib/learnharness --shell /usr/sbin/nologin learnharness
sudo mkdir -p /opt/learnharness/standalone /etc/learnharness \
  /var/lib/learnharness/data /var/lib/learnharness/auth
sudo chown -R learnharness:learnharness /var/lib/learnharness
sudo chmod 0700 /var/lib/learnharness /var/lib/learnharness/data /var/lib/learnharness/auth

# 2. Clone the repository (for systemd templates & CLI scripts) and unpack the prebuilt server
git clone https://github.com/lukemxlr/learnharness.git /opt/learnharness/src
curl -fsSL -o /tmp/learnharness-server.tar.gz \
  "https://github.com/lukemxlr/learnharness/releases/latest/download/LearnHarness-<version>-server-linux-x64.tar.gz"
sudo tar -xzf /tmp/learnharness-server.tar.gz -C /opt/learnharness/standalone
sudo chown -R learnharness:learnharness /opt/learnharness/standalone

# 3. Configure environment (/etc/learnharness/learnharness.env)
sudo cp /opt/learnharness/src/deploy/systemd/learnharness.env.example /etc/learnharness/learnharness.env
sudo chown root:learnharness /etc/learnharness/learnharness.env
sudo chmod 0640 /etc/learnharness/learnharness.env
# Edit LH_ALLOWED_HOSTS (your domain) and LH_TRUST_PROXY=1 (if behind Cloudflare Tunnel / reverse proxy)

# 4. Initialize your single login account (min 8-character password)
sudo -u learnharness LH_AUTH_FILE=/var/lib/learnharness/auth/auth.json \
  node /opt/learnharness/src/scripts/user-auth.mjs init --username yourname

# 5. Install and start the systemd service
sudo cp /opt/learnharness/src/deploy/systemd/learnharness.service /etc/systemd/system/learnharness.service
sudo systemctl daemon-reload
sudo systemctl enable --now learnharness
curl -fsS http://127.0.0.1:3000/api/health   # -> {"ok":true}
```

### 3. Connect ChatGPT Plus &amp; Enable Drawing Pad

- **ChatGPT Plus (headless):** Open **Settings → Providers → Subscriptions → ChatGPT → Connect → Get sign-in link**, sign in using your local browser, paste the resulting `http://127.0.0.1:<port>/auth/callback?...` URL back into **Complete sign-in**, and click **Refresh models** anytime new models roll out.
- **Drawing Pad:** Open **Settings → Core plugins** and enable **Drawing Pad** (applies to both Desktop and iPad).
- **HTTPS, Tailscale &amp; Dictation note:** Chat, attachments, and Drawing Pad work over both HTTPS and trusted LAN/Tailscale HTTP. Browser microphone **Dictation** requires HTTPS — Tailscale users can enable automatic private HTTPS in one command (`tailscale serve --bg http://127.0.0.1:3000` + `LH_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net` + `LH_TRUST_PROXY=1`), and the Electron desktop app also offers an explicit opt-in checkbox for trusted LAN/Tailscale HTTP.
- **Cloudflare Access:** Supported natively inside the desktop app via an isolated Cloudflare Access sign-in window (including automatic re-authentication when your Cloudflare session expires) — no `/api/health` bypass required.

### 4. Migrate Existing Local Chats, Knowledge Graph &amp; Flashcards

Always copy your local `data/` directory first and export from the copy (never mutate your live profile):

```bash
node scripts/migrate-profile.mjs export \
  --source /path/to/backup/data \
  --out /path/to/migration-bundle \
  --source-os win32 \
  --source-files-root /path/to/local-study-pdfs
```

Transfer the bundle to the server and verify with `--dry-run` before running `--apply`. See [Section 5 of Setup and Operation](docs/setup-and-operation.md#5-consistent-export--safe-windows--lxc-migration) for the full cutover steps (including migrating `core-plugin-data/flashcards/`).

---

## Your keys, your data

- **Your keys and models.** No LearnHarness subscription or markup. Connect provider API keys, supported subscriptions (ChatGPT Plus, GitHub Copilot, Grok), [Claude Code CLI](docs/claude-code.md), or a [custom OpenAI-compatible endpoint](docs/custom-providers.md).
- **Your server, plain files.** Chats, knowledge graph ledgers, attachments, settings, and credentials stay on your own server or machine in inspectable files.
- **External services.** Configured models, web research, and dictation still send request context to their respective external providers.

---

## Development

```bash
npm ci
npm run plugins:setup
npm run dev        # http://localhost:3000
npm test           # fixtures and fake providers
```

See the [documentation index](docs/README.md), [Setup and Operation](docs/setup-and-operation.md), [Developer Handover](docs/developer-handover.md), [Development](docs/development.md), [Architecture](docs/architecture.md), and [Desktop Builds &amp; Releases](docs/desktop-release.md).

- Questions, bug reports, and feature requests: [GitHub Issues](https://github.com/lukemxlr/learnharness/issues)
- Security vulnerabilities: report privately as described in [SECURITY.md](SECURITY.md)

---

## License &amp; Upstream Attribution

Licensed under **[GNU AGPL-3.0-only](LICENSE)**.

Original LearnHarness project by [Amos Blomqvist](https://github.com/amosblomqvist) ([`amosblomqvist/learnharness`](https://github.com/amosblomqvist/learnharness)). All modifications in this fork are released under the same AGPL-3.0 license.
