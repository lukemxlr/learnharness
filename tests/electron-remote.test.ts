import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const mainSource = fs.readFileSync(mainFile, "utf8");
const mainRequire = createRequire(mainFile);

const remoteConfig = require("../electron/remote-config.cjs") as {
	readRemoteConfig: (dir: string) => { mode: string; serverUrl: string | null; updatedAt?: string };
	writeRemoteConfig: (dir: string, next: { mode: string; serverUrl?: string | null }) => { mode: string; serverUrl: string | null; updatedAt: string };
	allowedOriginForConfig: (config: { mode?: string; serverUrl?: string | null } | null) => string | null;
	shouldUseLocalDataDir: (config: { mode?: string; serverUrl?: string | null } | null) => boolean;
	validateServerUrl: (raw: unknown) => { ok: boolean; serverUrl?: string; origin?: string; error?: string };
	probeServerHealth: (url: string, opts?: { timeoutMs?: number }) => Promise<{ ok: boolean; origin?: string; error?: string }>;
};
const { trustedSender } = require("../electron/chatgpt-ipc.cjs") as {
	trustedSender: (event: unknown, origin: string, BrowserWindow: unknown) => boolean;
};

const tempDirs: string[] = [];
function mkTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

after(() => {
	while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("electron/remote-config.cjs", () => {
	it("fails closed on missing/corrupt/invalid config and normalizes valid remote URLs", () => {
		const dir = mkTempDir("lh-remote-cfg-");
		assert.deepEqual(remoteConfig.readRemoteConfig(dir), { mode: "unset", serverUrl: null });

		fs.writeFileSync(path.join(dir, "remote-config.json"), "{bad json", "utf8");
		assert.deepEqual(remoteConfig.readRemoteConfig(dir), { mode: "unset", serverUrl: null });

		fs.writeFileSync(
			path.join(dir, "remote-config.json"),
			JSON.stringify({ mode: "remote", serverUrl: "javascript:alert(1)" }),
			"utf8",
		);
		assert.deepEqual(remoteConfig.readRemoteConfig(dir), { mode: "unset", serverUrl: null });

		const saved = remoteConfig.writeRemoteConfig(dir, {
			mode: "remote",
			serverUrl: "https://lh.example.test/some/path/",
		});
		assert.equal(saved.mode, "remote");
		assert.equal(saved.serverUrl, "https://lh.example.test");
		const reloaded = remoteConfig.readRemoteConfig(dir);
		assert.equal(reloaded.mode, "remote");
		assert.equal(reloaded.serverUrl, "https://lh.example.test");
		if (process.platform !== "win32") {
			const mode = fs.statSync(path.join(dir, "remote-config.json")).mode & 0o777;
			assert.equal(mode, 0o600);
		}
	});

	it("validates schemes, credentials, query/hash, control chars, and local data dir policy", () => {
		assert.deepEqual(remoteConfig.validateServerUrl("https://server-b.example.test:8443/"), {
			ok: true,
			serverUrl: "https://server-b.example.test:8443",
			origin: "https://server-b.example.test:8443",
		});
		assert.equal(remoteConfig.validateServerUrl("http://192.168.1.50:3000").origin, "http://192.168.1.50:3000");

		for (const bad of [
			"",
			"   ",
			null,
			"javascript:alert(1)",
			"file:///etc/passwd",
			"data:text/html,hi",
			"blob:https://lh.example.test/123",
			"ftp://lh.example.test",
			"https://user:pass@lh.example.test",
			"https://user@lh.example.test",
			"https://lh.example.test/?token=1",
			"https://lh.example.test/#frag",
			"https://lh.example.test?",
			"https://lh.example.test#",
			"https://lh.example.test\nHost: evil",
			"https://lh.example.test\u0000",
			"https://lh.example.test/with space",
		]) {
			assert.equal(remoteConfig.validateServerUrl(bad).ok, false, `expected rejection for ${String(bad)}`);
		}

		assert.equal(remoteConfig.allowedOriginForConfig({ mode: "remote", serverUrl: "https://a.test/" }), "https://a.test");
		assert.equal(remoteConfig.allowedOriginForConfig({ mode: "local", serverUrl: "https://a.test" }), null);
		assert.equal(remoteConfig.allowedOriginForConfig({ mode: "remote", serverUrl: "file:///x" }), null);
		assert.equal(remoteConfig.shouldUseLocalDataDir({ mode: "remote", serverUrl: "https://lh.example.test" }), false);
		assert.equal(remoteConfig.shouldUseLocalDataDir({ mode: "unset", serverUrl: null }), false);
		assert.equal(remoteConfig.shouldUseLocalDataDir({ mode: "local", serverUrl: null }), true);
	});

	it("probeServerHealth validates /api/health 200 { ok: true } and rejects failures", async () => {
		let healthy = true;
		const server = http.createServer((req, res) => {
			if (req.url === "/api/health" && healthy) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
				return;
			}
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: false }));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as AddressInfo).port;
		try {
			const okRes = await remoteConfig.probeServerHealth(`http://127.0.0.1:${port}/`);
			assert.deepEqual(okRes, { ok: true, origin: `http://127.0.0.1:${port}` });

			healthy = false;
			const failRes = await remoteConfig.probeServerHealth(`http://127.0.0.1:${port}`);
			assert.equal(failRes.ok, false);

			const badUrl = await remoteConfig.probeServerHealth("file:///etc/passwd");
			assert.equal(badUrl.ok, false);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((r) => server.close(() => r()));
		}
	});

	it("probeServerHealth enforces wall-clock deadline on slow-drip responses, aborts >16KiB bodies, and handles mid-stream resets", async () => {
		let mode: "slow" | "oversized" | "reset" = "slow";
		const timers = new Set<ReturnType<typeof setInterval>>();
		const server = http.createServer((_req, res) => {
			if (mode === "slow") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.write("{");
				const timer = setInterval(() => {
					if (!res.destroyed && !res.writableEnded) res.write(" ");
					else clearInterval(timer);
				}, 25);
				timers.add(timer);
				res.on("close", () => {
					clearInterval(timer);
					timers.delete(timer);
				});
				return;
			}
			if (mode === "oversized") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.write("x".repeat(20_000));
				// Keep open intentionally; client must abort early without waiting for EOF
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.write('{"ok":');
			res.destroy(new Error("boom"));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as AddressInfo).port;
		try {
			mode = "slow";
			const slowRes = await remoteConfig.probeServerHealth(`http://127.0.0.1:${port}`, { timeoutMs: 80 });
			assert.equal(slowRes.ok, false);
			assert.match(slowRes.error ?? "", /timed out/i);

			mode = "oversized";
			const bigRes = await remoteConfig.probeServerHealth(`http://127.0.0.1:${port}`, { timeoutMs: 10_000 });
			assert.equal(bigRes.ok, false);
			assert.match(bigRes.error ?? "", /maximum size/i);

			mode = "reset";
			const resetRes = await remoteConfig.probeServerHealth(`http://127.0.0.1:${port}`, { timeoutMs: 10_000 });
			assert.equal(resetRes.ok, false);
		} finally {
			for (const t of timers) clearInterval(t);
			server.closeAllConnections();
			await new Promise<void>((r) => server.close(() => r()));
		}
	});
});

describe("electron/chatgpt-ipc.cjs trustedSender hardening", () => {
	it("rejects credentialed and blob: URLs even when origin substring matches", () => {
		const mainFrame = { url: "https://lh.example.test/chat" };
		const win = { isDestroyed: () => false };
		const sender = { mainFrame };
		const BW = { fromWebContents: (s: unknown) => (s === sender ? win : null) };

		assert.equal(trustedSender({ sender, senderFrame: mainFrame }, "https://lh.example.test", BW), true);

		const blobFrame = { url: "blob:https://lh.example.test/550e8400-e29b-41d4-a716-446655440000" };
		assert.equal(
			trustedSender({ sender: { mainFrame: blobFrame }, senderFrame: blobFrame }, "https://lh.example.test", BW),
			false,
		);

		const credFrame = { url: "https://user:pass@lh.example.test/chat" };
		assert.equal(
			trustedSender({ sender: { mainFrame: credFrame }, senderFrame: credFrame }, "https://lh.example.test", BW),
			false,
		);
	});
});

describe("electron remote & setup preloads + static HTML CSP", () => {
	it("preload-remote.cjs exposes minimal UI chrome + changeServerUrl and omits all privileged local/OAuth/updater APIs", async () => {
		let exposed: Record<string, unknown> = {};
		const invoked: unknown[][] = [];
		const sent: unknown[][] = [];
		runInNewContext(fs.readFileSync(new URL("../electron/preload-remote.cjs", import.meta.url), "utf8"), {
			process: { platform: "win32" },
			require: () => ({
				contextBridge: {
					exposeInMainWorld(name: string, api: Record<string, unknown>) {
						assert.equal(name, "lh");
						exposed = api;
					},
				},
				ipcRenderer: {
					on() {},
					removeListener() {},
					send: (...args: unknown[]) => sent.push(args),
					invoke: async (...args: unknown[]) => {
						invoked.push(args);
						return { ok: true };
					},
				},
			}),
		});

		assert.equal(exposed.isRemoteMode, true);
		assert.equal(exposed.platform, "win32");
		assert.equal(typeof exposed.changeServerUrl, "function");
		assert.deepEqual(Object.keys(exposed).sort(), [
			"changeServerUrl",
			"expandWindow",
			"getZoom",
			"isRemoteMode",
			"onOpenSettings",
			"onZoom",
			"platform",
			"setAppearance",
		]);

		for (const forbidden of [
			"getPathForFile",
			"chooseAttachmentFolder",
			"chatgpt",
			"subscriptions",
			"subscriptionTransport",
			"openSubscriptionBrowser",
			"getUpdateState",
			"onUpdateStatus",
			"checkForUpdates",
			"installUpdate",
			"fs",
			"shell",
		]) {
			assert.equal(Object.hasOwn(exposed, forbidden), false, `preload-remote must omit ${forbidden}`);
		}

		await (exposed.changeServerUrl as () => Promise<unknown>)();
		assert.deepEqual(invoked, [["lh:remote:change-server"]]);
	});

	it("preload-setup.cjs exposes window.lhSetup without window.lh or privileged local APIs", async () => {
		let exposed: Record<string, unknown> = {};
		const invoked: unknown[][] = [];
		runInNewContext(fs.readFileSync(new URL("../electron/preload-setup.cjs", import.meta.url), "utf8"), {
			process: { platform: "linux" },
			require: () => ({
				contextBridge: {
					exposeInMainWorld(name: string, api: Record<string, unknown>) {
						assert.equal(name, "lhSetup");
						exposed = api;
					},
				},
				ipcRenderer: {
					invoke: async (...args: unknown[]) => {
						invoked.push(args);
						return { ok: true };
					},
				},
			}),
		});
		assert.deepEqual(Object.keys(exposed).sort(), ["cancel", "getState", "openSetup", "platform", "reconnect", "saveServerUrl"]);
		await (exposed.saveServerUrl as (u: string) => Promise<unknown>)("https://lh.example.test");
		await (exposed.reconnect as () => Promise<unknown>)();
		await (exposed.openSetup as () => Promise<unknown>)();
		await (exposed.cancel as () => Promise<unknown>)();
		assert.deepEqual(invoked, [
			["lh:setup:save", "https://lh.example.test"],
			["lh:setup:reconnect"],
			["lh:setup:open"],
			["lh:setup:cancel"],
		]);
	});

	it("setup.html and remote-reconnect.html pin exact script SHA-256 CSP hashes and static reconnect/change-server buttons", () => {
		for (const file of ["setup.html", "remote-reconnect.html"]) {
			const html = fs.readFileSync(new URL(`../electron/${file}`, import.meta.url), "utf8");
			const cspMatch = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
			assert.ok(cspMatch, `${file} must have CSP meta tag`);
			const csp = cspMatch[1]!;
			assert.equal(csp.includes("https:"), false, `${file} CSP must not allow remote https origins`);
			assert.equal(csp.includes("http:"), false, `${file} CSP must not allow remote http origins`);
			assert.equal(/script-src[^;]*unsafe-inline/i.test(csp), false, `${file} script-src must not allow unsafe-inline`);

			const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
			assert.ok(scriptMatch, `${file} should have inline script`);
			const expectedHash = `sha256-${createHash("sha256").update(scriptMatch[1]!, "utf8").digest("base64")}`;
			assert.ok(csp.includes(`'${expectedHash}'`), `${file} CSP script-src hash mismatch: expected ${expectedHash}`);
		}

		const reconnectHtml = fs.readFileSync(new URL("../electron/remote-reconnect.html", import.meta.url), "utf8");
		assert.match(reconnectHtml, /<button[^>]*>[^<]*Reconnect[^<]*<\/button>/i);
		assert.match(reconnectHtml, /<button[^>]*>[^<]*Change Server[^<]*<\/button>/i);
		assert.match(reconnectHtml, /state\.lastError/);
		assert.match(reconnectHtml, /state\.error/);
	});
});

describe("electron/main.cjs remote isolation, dynamic origin, CSP, and reconnect", () => {
	function bootRemoteMain(userDataDir: string) {
		const windows: FakeWindow[] = [];
		const handleMap = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
		const onMap = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
		const externalOpened: string[] = [];
		const localCalls: string[] = [];
		let menuTemplate: Array<{ label?: string; role?: string; accelerator?: string; click?: () => void; submenu?: Array<{ label?: string; accelerator?: string; click?: () => void }> }> = [];
		let contextMenuCalls = 0;
		let permissionRequestHandler!: (wc: unknown, perm: string, cb: (ok: boolean) => void, details: { requestingUrl?: string }) => void;
		let permissionCheckHandler!: (wc: unknown, perm: string, origin: string) => boolean;
		let headersReceivedHandler: ((details: Record<string, unknown>, cb: (res: { responseHeaders: Record<string, string[]> }) => void) => void) | undefined;

		class FakeWebContents extends EventEmitter {
			id = Math.floor(Math.random() * 100000);
			windowOpenHandler?: (details: { url: string }) => { action: string };
			mainFrame = { url: "" };
			sent: unknown[][] = [];
			reloads = 0;
			setWindowOpenHandler(fn: (details: { url: string }) => { action: string }) { this.windowOpenHandler = fn; }
			send(...args: unknown[]) { this.sent.push(args); }
			reload() { this.reloads++; }
			getZoomFactor() { return 1; }
			setZoomFactor() {}
		}
		let nextWinId = 1;
		class FakeWindow extends EventEmitter {
			static getAllWindows() { return windows.filter((w) => !w.destroyed); }
			static fromWebContents(wc: unknown) { return windows.find((w) => !w.destroyed && w.webContents === wc); }
			id = nextWinId++;
			destroyed = false;
			shown = false;
			bounds = { x: 0, y: 0, width: 800, height: 600 };
			webContents = new FakeWebContents();
			loadedUrl = "";
			loadedFile = "";
			constructor(readonly options: { webPreferences: { preload: string; contextIsolation: boolean; sandbox: boolean; nodeIntegration: boolean; additionalArguments?: string[] } }) {
				super();
				windows.push(this);
			}
			loadURL(u: string) { this.loadedUrl = u; this.webContents.mainFrame = { url: u }; }
			loadFile(f: string) { this.loadedFile = f; this.webContents.mainFrame = { url: `file://${f}` }; }
			once(event: string, listener: (...args: unknown[]) => void) { return super.once(event, listener); }
			show() { this.shown = true; }
			close() { this.destroyed = true; this.emit("closed"); }
			isDestroyed() { return this.destroyed; }
			getBounds() { return this.bounds; }
			setBounds(b: typeof this.bounds) { this.bounds = b; }
			setBackgroundColor() {}
			setTitleBarOverlay() {}
		}

		const app = Object.assign(new EventEmitter(), {
			name: "LearnHarness",
			setName() {},
			getPath: (key: string) => {
				assert.equal(key, "userData");
				return userDataDir;
			},
			setPath() {},
			requestSingleInstanceLock: () => false,
			quit() {},
			exit(code: number) { localCalls.push(`exit:${code}`); },
			whenReady: async () => {},
			isPackaged: true,
		});

		const electron = {
			app,
			BrowserWindow: FakeWindow,
			nativeTheme: { themeSource: "system" },
			Menu: {
				buildFromTemplate(tpl: typeof menuTemplate) {
					menuTemplate = tpl;
					return {
						popup() { contextMenuCalls++; },
					};
				},
				setApplicationMenu() {},
			},
			ipcMain: {
				handle: (ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handleMap.set(ch, fn),
				on: (ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => onMap.set(ch, fn),
			},
			session: {
				defaultSession: {
					setPermissionRequestHandler: (fn: typeof permissionRequestHandler) => { permissionRequestHandler = fn; },
					setPermissionCheckHandler: (fn: typeof permissionCheckHandler) => { permissionCheckHandler = fn; },
					webRequest: {
						onBeforeSendHeaders: () => { localCalls.push("onBeforeSendHeaders"); },
						onHeadersReceived: (_filter: unknown, fn: NonNullable<typeof headersReceivedHandler>) => { headersReceivedHandler = fn; },
					},
				},
			},
			shell: { openExternal: (target: string) => externalOpened.push(target) },
			dialog: { showOpenDialog: () => { localCalls.push("dialog"); } },
		};

		const context = {
			require: (id: string) => {
				if (id === "electron") return electron;
				if (id === "./chatgpt.cjs") return {
					createChatGPT: () => { localCalls.push("createChatGPT"); return {}; },
					fileStore: () => { localCalls.push("chatgptFileStore"); return {}; },
				};
				if (id === "./subscriptions.cjs") return {
					createSubscriptions: () => { localCalls.push("createSubscriptions"); return { ready: Promise.resolve() }; },
					loadSubscriptionSDK: () => { localCalls.push("loadSubscriptionSDK"); },
				};
				if (id === "node:child_process") return { spawn: () => { localCalls.push("spawnServer"); } };
				return mainRequire(id);
			},
			process: Object.assign(new EventEmitter(), { platform: "win32", argv: [], env: {} }),
			__dirname: path.dirname(mainFile),
			AbortController,
			URL,
			setImmediate,
			setTimeout,
			clearTimeout,
			console: { log() {}, error() {} },
		};

		runInNewContext(mainSource, context, { filename: mainFile });
		const bootPromise = runInNewContext("main()", context) as Promise<void>;

		return {
			bootPromise,
			windows,
			handleMap,
			onMap,
			externalOpened,
			localCalls,
			getMenuTemplate: () => menuTemplate,
			getContextMenuCalls: () => contextMenuCalls,
			checkPermissionRequest: (perm: string, requestingUrl: string | undefined) =>
				new Promise<boolean>((resolve) => {
					permissionRequestHandler({}, perm, resolve, requestingUrl !== undefined ? { requestingUrl } : {});
				}),
			checkPermissionSync: (perm: string, origin: string) => permissionCheckHandler({}, perm, origin),
			runHeadersReceived: (details: Record<string, unknown>) =>
				new Promise<Record<string, string[]>>((resolve) => {
					headersReceivedHandler!(details, (res) => resolve(res.responseHeaders));
				}),
		};
	}

	it("remote mode skips local server/OAuth/updater/DATA_DIR, isolates preloads across windows, pins origin/CSP, and recovers on failure", async () => {
		const serverA = http.createServer((req, res) => {
			if (req.url === "/api/health") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
				return;
			}
			res.writeHead(404);
			res.end();
		});
		const serverB = http.createServer((req, res) => {
			if (req.url === "/api/health") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
				return;
			}
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((r) => serverA.listen(0, "127.0.0.1", r));
		await new Promise<void>((r) => serverB.listen(0, "127.0.0.1", r));
		const originA = `http://127.0.0.1:${(serverA.address() as AddressInfo).port}`;
		const originB = `http://127.0.0.1:${(serverB.address() as AddressInfo).port}`;

		const userDataDir = mkTempDir("lh-el-remote-");
		try {
			const m = bootRemoteMain(userDataDir);
			await m.bootPromise;

			// 1. Zero local server/OAuth/updater/DATA_DIR initialization
			assert.deepEqual(m.localCalls, []);
			for (const forbiddenIpc of [
				"lh:chatgpt:control",
				"lh:subscriptions:control",
				"lh:subscriptions:web-browser",
				"lh:attachment:pick",
				"lh:update:get",
				"lh:update:check",
			]) {
				assert.equal(m.handleMap.has(forbiddenIpc), false, `remote mode must not register ${forbiddenIpc}`);
			}
			assert.equal(m.onMap.has("lh:update-install"), false, "remote mode must not register lh:update-install");

			// 2. First-run opens setup.html in isolated setup window with preload-setup.cjs
			assert.equal(m.windows.length, 1);
			const setupWin = m.windows[0]!;
			assert.ok(setupWin.loadedFile.endsWith("setup.html"));
			assert.ok(setupWin.options.webPreferences.preload.endsWith("preload-setup.cjs"));
			assert.equal(setupWin.options.webPreferences.contextIsolation, true);
			assert.equal(setupWin.options.webPreferences.sandbox, true);
			assert.equal(setupWin.options.webPreferences.nodeIntegration, false);
			assert.equal(setupWin.options.webPreferences.additionalArguments, undefined);

			// Setup window blocks navigation/redirect/popup
			let navPrevented = false;
			setupWin.webContents.emit("will-navigate", { preventDefault: () => { navPrevented = true; } }, originA);
			assert.equal(navPrevented, true);

			// Menu has Change Server URL… and omits Check for Updates…
			const appMenu = m.getMenuTemplate()[0]!.submenu!;
			assert.ok(appMenu.some((item) => item.label === "Change Server URL…" && item.accelerator === "CommandOrControl+Alt+S"));
			assert.equal(appMenu.some((item) => item.label === "Check for Updates…"), false);

			// Untrusted sender cannot call lh:setup:save
			await assert.rejects(
				async () => m.handleMap.get("lh:setup:save")!({ sender: {}, senderFrame: { url: originA } }, originA),
				/Untrusted setup request/,
			);

			// 3. Valid setup save creates NEW BrowserWindow with preload-remote.cjs and closes setup window
			const setupEvent = { sender: setupWin.webContents, senderFrame: setupWin.webContents.mainFrame };
			const saveRes = await m.handleMap.get("lh:setup:save")!(setupEvent, `${originA}/`);
			assert.deepEqual(JSON.parse(JSON.stringify(saveRes)), { ok: true, serverUrl: originA });
			assert.equal(setupWin.isDestroyed(), true, "setup window must close on transition");
			assert.equal(m.windows.length, 2);
			const remoteWinA = m.windows[1]!;
			assert.equal(remoteWinA.loadedUrl, originA);
			assert.ok(remoteWinA.options.webPreferences.preload.endsWith("preload-remote.cjs"));
			assert.notEqual(remoteWinA, setupWin);

			// Setup window IPC must reject remote window sender
			await assert.rejects(
				async () => m.handleMap.get("lh:setup:get-state")!({ sender: remoteWinA.webContents, senderFrame: remoteWinA.webContents.mainFrame }),
				/Untrusted setup request/,
			);

			// 4. Origin pinning: navigation, redirect, windowOpenHandler, permissions, IPC sender
			let crossPrevented = false;
			remoteWinA.webContents.emit("will-navigate", { preventDefault: () => { crossPrevented = true; } }, "https://evil.example/steal");
			assert.equal(crossPrevented, true);
			assert.deepEqual(m.externalOpened, ["https://evil.example/steal"]);

			let redirectPrevented = false;
			remoteWinA.webContents.emit("will-redirect", { preventDefault: () => { redirectPrevented = true; } }, "https://evil.example/redirect");
			assert.equal(redirectPrevented, true);

			let malformedPrevented = false;
			remoteWinA.webContents.emit("will-redirect", { preventDefault: () => { malformedPrevented = true; } }, "not a valid url");
			assert.equal(malformedPrevented, true);

			let samePrevented = false;
			remoteWinA.webContents.emit("will-navigate", { preventDefault: () => { samePrevented = true; } }, `${originA}/chat/1`);
			assert.equal(samePrevented, false);

			// Credentialed and blob: URLs sharing the origin must be rejected in navigation & permissions
			let credNavPrevented = false;
			const credUrlA = originA.replace("http://", "http://user:pass@") + "/chat/1";
			remoteWinA.webContents.emit("will-navigate", { preventDefault: () => { credNavPrevented = true; } }, credUrlA);
			assert.equal(credNavPrevented, true);

			let blobNavPrevented = false;
			remoteWinA.webContents.emit("will-navigate", { preventDefault: () => { blobNavPrevented = true; } }, `blob:${originA}/abc`);
			assert.equal(blobNavPrevented, true);

			assert.equal(await m.checkPermissionRequest("media", credUrlA), false);
			assert.equal(await m.checkPermissionRequest("media", `blob:${originA}/abc`), false);

			assert.deepEqual(
				JSON.parse(JSON.stringify(remoteWinA.webContents.windowOpenHandler!({ url: "file:///C:/Windows/System32/calc.exe" }))),
				{ action: "deny" },
			);
			assert.equal(m.externalOpened.includes("file:///C:/Windows/System32/calc.exe"), false);

			assert.equal(await m.checkPermissionRequest("media", `${originA}/chat/1`), true);
			assert.equal(await m.checkPermissionRequest("media", "https://evil.example/x"), false);
			assert.equal(await m.checkPermissionRequest("media", "not-a-url"), false);
			assert.equal(await m.checkPermissionRequest("geolocation", `${originA}/chat/1`), false);
			assert.equal(m.checkPermissionSync("clipboard-sanitized-write", originA), true);
			assert.equal(m.checkPermissionSync("clipboard-sanitized-write", originB), false);

			// 5. CSP injection preserves attachment sandbox, replaces empty CSP, and pins remote origin
			const pageHeaders = await m.runHeadersReceived({ url: `${originA}/chat/1`, resourceType: "mainFrame", statusCode: 200, responseHeaders: {} });
			assert.ok(pageHeaders["Content-Security-Policy"]?.[0]?.includes("wss://api.deepgram.com"));
			const emptyCspHeaders = await m.runHeadersReceived({
				url: `${originA}/chat/1`,
				resourceType: "mainFrame",
				statusCode: 200,
				responseHeaders: { "content-security-policy": ["   "] },
			});
			assert.ok(emptyCspHeaders["Content-Security-Policy"]?.[0]?.includes("wss://api.deepgram.com"));
			assert.equal(emptyCspHeaders["content-security-policy"], undefined);
			const attachHeaders = await m.runHeadersReceived({
				url: `${originA}/api/attachments/abc/img.png`,
				resourceType: "subFrame",
				statusCode: 200,
				responseHeaders: { "content-security-policy": ["default-src 'none'; sandbox"] },
			});
			assert.deepEqual(attachHeaders["content-security-policy"], ["default-src 'none'; sandbox"]);

			// 6. Unreachable server recovery: did-fail-load -> remote-reconnect.html -> reconnect
			// ERR_ABORTED (-3) and subframe failure are ignored
			remoteWinA.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", originA, true);
			remoteWinA.webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", `${originA}/sub`, false);
			assert.equal(remoteWinA.isDestroyed(), false);

			// Main-frame failure opens remote-reconnect.html in setup window
			remoteWinA.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", originA, true);
			assert.equal(remoteWinA.isDestroyed(), true);
			const reconnectWin = m.windows.at(-1)!;
			assert.ok(reconnectWin.loadedFile.endsWith("remote-reconnect.html"));
			assert.ok(reconnectWin.options.webPreferences.preload.endsWith("preload-setup.cjs"));

			// Reconnect transitions back to remote window for originA
			const reconnectRes = await m.handleMap.get("lh:setup:reconnect")!({
				sender: reconnectWin.webContents,
				senderFrame: reconnectWin.webContents.mainFrame,
			});
			assert.deepEqual(JSON.parse(JSON.stringify(reconnectRes)), { ok: true, serverUrl: originA });
			const remoteWinA2 = m.windows.at(-1)!;
			assert.equal(remoteWinA2.loadedUrl, originA);

			// Remote context menu on frameless window exposes Change Server URL…, Reload, and Reconnect
			remoteWinA2.webContents.emit("context-menu", {}, { isEditable: true });
			assert.equal(m.getContextMenuCalls(), 1);
			const ctxItems = m.getMenuTemplate();
			assert.ok(ctxItems.some((item) => item.role === "paste"), "editable context menu should include paste role");
			const reloadItem = ctxItems.find((item) => item.label === "Reload");
			const reconnectMenuItem = ctxItems.find((item) => item.label === "Reconnect");
			const changeUrlMenuItem = ctxItems.find((item) => item.label === "Change Server URL…");
			assert.ok(reloadItem && reconnectMenuItem && changeUrlMenuItem);
			reloadItem.click!();
			assert.equal(remoteWinA2.webContents.reloads, 1);

			// Clicking "Change Server URL…" from context menu opens setup.html
			changeUrlMenuItem.click!();
			const menuSetupWin = m.windows.at(-1)!;
			assert.ok(menuSetupWin.loadedFile.endsWith("setup.html"));

			// Stale remoteWinA2 did-fail-load must be a no-op once no longer currentRemoteWindow
			(remoteWinA2 as unknown as { destroyed: boolean }).destroyed = false;
			remoteWinA2.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", originA, true);
			assert.equal(m.windows.at(-1), menuSetupWin, "stale remote window did-fail-load must not replace active setup window");

			// 7. Save serverB from setup.html updates dynamic allowedOrigin so serverA is now rejected
			await m.handleMap.get("lh:setup:save")!(
				{ sender: menuSetupWin.webContents, senderFrame: menuSetupWin.webContents.mainFrame },
				originB,
			);
			const remoteWinB = m.windows.at(-1)!;
			assert.equal(remoteWinB.loadedUrl, originB);
			assert.equal(m.checkPermissionSync("media", originA), false, "old originA must be rejected after switch to originB");
			assert.equal(m.checkPermissionSync("media", originB), true, "new originB must be allowed");

			// Context menu "Reconnect" opens remote-reconnect.html
			remoteWinB.webContents.emit("context-menu", {}, { isEditable: false, selectionText: "hello" });
			assert.equal(m.getContextMenuCalls(), 2);
			const ctxItemsB = m.getMenuTemplate();
			assert.ok(ctxItemsB.some((item) => item.role === "copy"));
			ctxItemsB.find((item) => item.label === "Reconnect")!.click!();
			assert.ok(m.windows.at(-1)!.loadedFile.endsWith("remote-reconnect.html"));

			// Reconnect back to originB, then verify gateway 502 on mainFrame triggers reconnect window
			const reconnectWinB = m.windows.at(-1)!;
			await m.handleMap.get("lh:setup:reconnect")!({
				sender: reconnectWinB.webContents,
				senderFrame: reconnectWinB.webContents.mainFrame,
			});
			const remoteWinB2 = m.windows.at(-1)!;

			// 8. Gateway 502 on mainFrame triggers reconnect window
			await m.runHeadersReceived({
				url: `${originB}/`,
				resourceType: "mainFrame",
				statusCode: 502,
				webContentsId: remoteWinB2.webContents.id,
				responseHeaders: {},
			});
			await new Promise((r) => setImmediate(r));
			assert.ok(m.windows.at(-1)!.loadedFile.endsWith("remote-reconnect.html"));
		} finally {
			serverA.closeAllConnections();
			serverB.closeAllConnections();
			await new Promise<void>((r) => serverA.close(() => r()));
			await new Promise<void>((r) => serverB.close(() => r()));
		}
	});
});
