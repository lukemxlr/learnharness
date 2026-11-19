import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveRepoDir, runNode26Cli } from "./server-controller.mjs";

const mountedBridgePages = new WeakMap();

export function createTempUserData() {
	return fs.mkdtempSync("/tmp/lh-el-userdata-");
}

export function cleanupTempUserData(dir) {
	if (dir) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

export async function withTempUserData(fn) {
	const dir = createTempUserData();
	try {
		return await fn(dir);
	} finally {
		cleanupTempUserData(dir);
	}
}

export async function runElectronProbe(probeBodyJs, { cwd } = {}) {
	const tempDir = fs.mkdtempSync("/tmp/lh-electron-probe-");
	const scriptPath = path.join(tempDir, "probe.mjs");
	fs.writeFileSync(scriptPath, probeBodyJs, "utf8");
	try {
		const res = await runNode26Cli(scriptPath, [], { cwd: cwd || resolveRepoDir() });
		let json = null;
		if (res.code === 0 && res.stdout) {
			const lines = res.stdout.trim().split(/\r?\n/).filter(Boolean);
			for (let i = lines.length - 1; i >= 0; i--) {
				try {
					json = JSON.parse(lines[i]);
					break;
				} catch {
					// try earlier line
				}
			}
		}
		return { ...res, json };
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

export async function evaluateRemoteConfig({
	initialUrl = "https://lh.example.test/",
	nextUrl = "https://lh-next.example.test:8443",
	invalidUrls = [],
} = {}) {
	const remoteConfigPath = path.join(resolveRepoDir(), "electron", "remote-config.cjs");
	const res = await runElectronProbe(`
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const remoteConfig = require(${JSON.stringify(remoteConfigPath)});
const userData = fs.mkdtempSync("/tmp/lh-el-userdata-");
try {
	const initial = remoteConfig.readRemoteConfig(userData);
	const saved = remoteConfig.writeRemoteConfig(userData, { mode: "remote", serverUrl: ${JSON.stringify(initialUrl)} });
	const reloaded = remoteConfig.readRemoteConfig(userData);
	const allowedOrigin = remoteConfig.allowedOriginForConfig(reloaded);
	const shouldUseLocal = remoteConfig.shouldUseLocalDataDir(reloaded);
	const nextSaved = remoteConfig.writeRemoteConfig(userData, { mode: "remote", serverUrl: ${JSON.stringify(nextUrl)} });
	const nextAllowedOrigin = remoteConfig.allowedOriginForConfig(nextSaved);
	const localShouldUseLocal = remoteConfig.shouldUseLocalDataDir({ mode: "local", serverUrl: null });
	const invalidResults = [];
	for (const candidate of ${JSON.stringify(invalidUrls)}) {
		const validation = remoteConfig.validateServerUrl(candidate);
		let writeThrew = false;
		try {
			remoteConfig.writeRemoteConfig(userData, { mode: "remote", serverUrl: candidate });
		} catch {
			writeThrew = true;
		}
		invalidResults.push({ candidate, validation, writeThrew });
	}
	console.log(JSON.stringify({
		initial,
		saved,
		reloaded,
		allowedOrigin,
		shouldUseLocal,
		nextSaved,
		nextAllowedOrigin,
		localShouldUseLocal,
		invalidResults,
	}));
} finally {
	fs.rmSync(userData, { recursive: true, force: true });
}
`);
	if (res.code !== 0) {
		throw new Error(`evaluateRemoteConfig probe failed (code=${res.code}): ${res.stderr || res.stdout}`);
	}
	return res.json;
}

export async function probeServerHealthFromElectron(serverUrl, opts = {}) {
	const remoteConfigPath = path.join(resolveRepoDir(), "electron", "remote-config.cjs");
	const res = await runElectronProbe(`
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const remoteConfig = require(${JSON.stringify(remoteConfigPath)});
const result = await remoteConfig.probeServerHealth(${JSON.stringify(serverUrl)}, ${JSON.stringify(opts)});
console.log(JSON.stringify(result));
`);
	if (res.code !== 0) {
		throw new Error(
			`probeServerHealthFromElectron probe failed (code=${res.code}): ${res.stderr || res.stdout}`,
		);
	}
	return res.json;
}

export async function inspectPreloadSurface(preloadFilename) {
	const baseName = path.basename(preloadFilename);
	const preloadPath = path.join(resolveRepoDir(), "electron", baseName);
	const res = await runElectronProbe(`
import Module from "node:module";
let exposedName = null;
let exposed = null;
const invokeChannels = new Set();
const sendChannels = new Set();
const onChannels = new Set();

const fakeElectron = {
	contextBridge: {
		exposeInMainWorld: (name, api) => {
			exposedName = name;
			exposed = api;
		},
	},
	ipcRenderer: {
		on: (channel, _listener) => { onChannels.add(channel); },
		removeListener: () => {},
		send: (channel) => { sendChannels.add(channel); },
		invoke: async (channel) => {
			invokeChannels.add(channel);
			return null;
		},
	},
	webUtils: {
		getPathForFile: () => "",
	},
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === "electron") return fakeElectron;
	return origLoad.call(this, request, parent, isMain);
};

const require = Module.createRequire(import.meta.url);
require(${JSON.stringify(preloadPath)});

async function exerciseApi(obj) {
	if (!obj || typeof obj !== "object") return;
	for (const key of Object.keys(obj)) {
		const val = obj[key];
		if (typeof val === "function") {
			try {
				const out = val(() => {});
				if (out && typeof out.catch === "function") {
					await out.catch(() => {});
				}
			} catch {
				// ignore stubbed arg errors
			}
		} else if (val && typeof val === "object") {
			await exerciseApi(val);
		}
	}
}
await exerciseApi(exposed);

const keys = exposed && typeof exposed === "object" ? Object.keys(exposed) : [];
console.log(JSON.stringify({
	exposedName,
	keys,
	invokeChannels: [...invokeChannels].sort(),
	sendChannels: [...sendChannels].sort(),
	onChannels: [...onChannels].sort(),
	hasGetPathForFile: exposed?.getPathForFile !== undefined,
	hasChooseAttachmentFolder: exposed?.chooseAttachmentFolder !== undefined,
	hasChatgpt: exposed?.chatgpt !== undefined,
	hasSubscriptions: exposed?.subscriptions !== undefined,
	hasChangeServerUrl: typeof exposed?.changeServerUrl === "function",
	isRemoteMode: exposed?.isRemoteMode === true,
}));
`);
	if (res.code !== 0) {
		throw new Error(`inspectPreloadSurface(${baseName}) failed (code=${res.code}): ${res.stderr || res.stdout}`);
	}
	return res.json;
}

export async function mountElectronHtml(
	page,
	htmlFilename,
	{ mockBridgeState = {}, bridgeHandlers = {}, allowInlineScriptForWebkitTest = false } = {},
) {
	const baseName = path.basename(htmlFilename);
	const htmlPath = path.join(resolveRepoDir(), "electron", baseName);
	let html = fs.readFileSync(htmlPath, "utf8");

	const calls = [];
	const state = { mockBridgeState, bridgeHandlers, calls };
	let entry = mountedBridgePages.get(page);
	if (!entry) {
		entry = { current: state, initInstalled: false };
		mountedBridgePages.set(page, entry);
		await page.exposeFunction("__lhSetupBridgeCall", async (method, args = []) => {
			const cur = entry.current;
			cur.calls.push({ method, args });
			const custom = cur.bridgeHandlers?.[method];
			if (typeof custom === "function") {
				return await custom(...args);
			}
			if (method === "getState") {
				return cur.mockBridgeState ?? {};
			}
			return { ok: true };
		});
	} else {
		entry.current = state;
	}

	if (!entry.initInstalled) {
		entry.initInstalled = true;
		await page.addInitScript(() => {
			window.lhSetup = {
				platform: "win32",
				getState: () => window.__lhSetupBridgeCall("getState", []),
				saveServerUrl: (rawUrl) => window.__lhSetupBridgeCall("saveServerUrl", [rawUrl]),
				reconnect: () => window.__lhSetupBridgeCall("reconnect", []),
				openSetup: () => window.__lhSetupBridgeCall("openSetup", []),
				cancel: () => window.__lhSetupBridgeCall("cancel", []),
			};
		});
	}
	await page.goto("about:blank", { waitUntil: "domcontentloaded" });

	let scriptSha256 = null;
	const scriptMatch = /<script>([\s\S]*?)<\/script>/i.exec(html);
	if (scriptMatch) {
		scriptSha256 = createHash("sha256").update(scriptMatch[1], "utf8").digest("base64");
		if (allowInlineScriptForWebkitTest) {
			html = html.replace(
				/(<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*content=["'][^"']*script-src\s+[^"']*?)sha256-[A-Za-z0-9+/=_-]+([^"']*["'][^>]*>)/i,
				`$1sha256-${scriptSha256}$2`,
			);
		}
	}

	await page.setContent(html, { waitUntil: "domcontentloaded" });
	return { html, calls, scriptSha256 };
}

export async function verifyRemoteSecurityGuards() {
	const invalidUrls = [
		"",
		"   ",
		"file:///etc/passwd",
		"javascript:alert(1)",
		"ftp://lh.example.test",
		"https://user:pass@lh.example.test",
		"https://lh.example.test?token=1",
		"https://lh.example.test#frag",
		"https://lh.example.test/\n",
	];
	const remoteConfig = await evaluateRemoteConfig({
		initialUrl: "https://lh.example.test/",
		nextUrl: "https://lh-next.example.test:8443",
		invalidUrls,
	});
	const remotePreload = await inspectPreloadSurface("preload-remote.cjs");
	const setupPreload = await inspectPreloadSurface("preload-setup.cjs");

	const electronDir = path.join(resolveRepoDir(), "electron");
	const setupHtml = fs.readFileSync(path.join(electronDir, "setup.html"), "utf8");
	const reconnectHtml = fs.readFileSync(path.join(electronDir, "remote-reconnect.html"), "utf8");

	const hasStrictCsp = (doc) =>
		/http-equiv=["']Content-Security-Policy["']/i.test(doc) &&
		/default-src\s+'none'/i.test(doc) &&
		/connect-src\s+'none'/i.test(doc) &&
		/base-uri\s+'none'/i.test(doc) &&
		/form-action\s+'none'/i.test(doc);

	const htmlChecks = {
		setupHtml: {
			strictCsp: hasStrictCsp(setupHtml),
			hasForm: /id=["']setup-form["']/.test(setupHtml),
			hasServerUrlInput: /id=["']server-url["']/.test(setupHtml),
			hasConnectButton: /id=["']connect-btn["']/.test(setupHtml),
			hasCancelButton: /id=["']cancel-btn["']/.test(setupHtml),
		},
		reconnectHtml: {
			strictCsp: hasStrictCsp(reconnectHtml),
			hasOriginDisplay: /id=["']server-origin["']/.test(reconnectHtml),
			hasReconnectButton: /id=["']reconnect-btn["']/.test(reconnectHtml),
			hasChangeServerButton: /id=["']change-server-btn["']/.test(reconnectHtml),
		},
	};

	const ok =
		remoteConfig.reloaded?.mode === "remote" &&
		remoteConfig.reloaded?.serverUrl === "https://lh.example.test" &&
		remoteConfig.allowedOrigin === "https://lh.example.test" &&
		remoteConfig.shouldUseLocal === false &&
		remoteConfig.localShouldUseLocal === true &&
		remoteConfig.invalidResults.every((r) => r.validation?.ok === false && r.writeThrew === true) &&
		remotePreload.isRemoteMode === true &&
		remotePreload.hasChangeServerUrl === true &&
		remotePreload.hasGetPathForFile === false &&
		remotePreload.hasChooseAttachmentFolder === false &&
		remotePreload.hasChatgpt === false &&
		remotePreload.hasSubscriptions === false &&
		!remotePreload.keys.includes("installUpdate") &&
		!remotePreload.keys.includes("checkForUpdates") &&
		!remotePreload.keys.includes("getUpdateState") &&
		!remotePreload.keys.includes("onUpdateStatus") &&
		setupPreload.exposedName === "lhSetup" &&
		setupPreload.hasGetPathForFile === false &&
		setupPreload.hasChooseAttachmentFolder === false &&
		setupPreload.hasChatgpt === false &&
		setupPreload.hasSubscriptions === false &&
		Object.values(htmlChecks.setupHtml).every(Boolean) &&
		Object.values(htmlChecks.reconnectHtml).every(Boolean);

	return { ok, remoteConfig, remotePreload, setupPreload, htmlChecks };
}
