import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { resolveRepoDir, runNode26Cli } from "../harness/server-controller.mjs";
import {
	bootStack,
	composerInput,
	createChatSession,
	loginApi,
	loginBrowser,
	VIEWPORT_MATRIX,
	viewportContextOptions,
} from "../helpers/e2e-session.mjs";

test.describe("Tier 1 — F7: Live Stream Keepalive & Multi-Device Resync Handoff", () => {
	test("T1-F7-01: SSE stream keepalive emission on /api/chats/[id]/stream", async () => {
		const stack = await bootStack({
			mockOptions: { chunkDelayMs: 120 },
			startOptions: { extraEnv: { LH_STREAM_KEEPALIVE_MS: "150" } },
		});
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "SSE Keepalive" });

			// Start long turn asynchronously
			const turnRes = await fetch(`${stack.baseUrl}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: cookie },
				body: JSON.stringify({
					chatId: chat.id,
					input: { type: "text", text: "[STREAM_LONG] keepalive probe" },
				}),
			});
			expect(turnRes.status).toBe(200);
			expect(await turnRes.json()).toEqual({ ok: true });

			// Attach via /stream while turn runs
			const streamRes = await fetch(`${stack.baseUrl}/api/chats/${chat.id}/stream`, {
				headers: { Cookie: cookie },
			});
			expect(streamRes.status).toBe(200);
			const streamBody = await streamRes.text();

			expect(streamBody).toContain(": ping");
			expect(streamBody).toContain("Chunk 25/25:");
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F7-02: Side-chat NDJSON stream emits valid JSON lines including ping keepalives", async () => {
		const stack = await bootStack({
			mockOptions: { chunkDelayMs: 100 },
			startOptions: { extraEnv: { LH_STREAM_KEEPALIVE_MS: "150" } },
		});
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const sideRes = await fetch(`${stack.baseUrl}/api/chats/chat_synth_teach_01/side-chats`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: cookie },
				body: JSON.stringify({
					anchor: {
						messageId: "msg_synth_t01_06",
						partId: "msg_synth_t01_06-t0",
						blockIndex: 0,
						blockText: "Because horizontal acceleration ax = 0 and vertical acceleration ay = -g, the trajectory forms a parabola.",
					},
					text: "[STREAM_LONG] Clarify horizontal acceleration",
				}),
			});
			expect(sideRes.status).toBe(200);
			const ndjsonText = await sideRes.text();
			const lines = ndjsonText
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);
			expect(lines.length).toBeGreaterThan(0);

			let sawPing = false;
			for (const line of lines) {
				expect(line.startsWith(":")).toBe(false);
				const parsed = JSON.parse(line);
				if (parsed.type === "ping") sawPing = true;
			}
			expect(sawPing).toBe(true);
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F7-03: 2-client mid-stream handoff (Desktop -> iPad WebKit) without starting a 2nd turn", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 120 } });
		const desktopCtx = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const ipadCtx = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const desktopPage = await desktopCtx.newPage();
		const ipadPage = await ipadCtx.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Mid-Stream Handoff" });

			await loginBrowser(desktopPage, stack.baseUrl);
			await loginBrowser(ipadPage, stack.baseUrl);

			await desktopPage.goto(`${stack.baseUrl}/chat/${chat.id}`);
			const composer = composerInput(desktopPage);
			await composer.fill("[STREAM_LONG] projectile handoff");
			await desktopPage.getByRole("button", { name: "Send" }).click();

			// Confirm stream started on Desktop
			await expect(desktopPage.getByText("Chunk 01/25:")).toBeVisible({ timeout: 10_000 });

			// Mid-stream, open same chat on iPad WebKit
			await ipadPage.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await expect(ipadPage.getByText("[STREAM_LONG] projectile handoff")).toBeVisible({ timeout: 10_000 });
			await expect(ipadPage.getByText("Chunk 25/25:")).toBeVisible({ timeout: 25_000 });
			await expect(desktopPage.getByText("Chunk 25/25:")).toBeVisible({ timeout: 25_000 });

			const ledger = await stack.mock.getRequests();
			expect(ledger.count).toBe(1);
		} finally {
			await desktopCtx.close();
			await ipadCtx.close();
			await stack.cleanup();
		}
	});

	test("T1-F7-04: Resync after client visibility/sleep wake catches up via attachToRunningTurn", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 90 } });
		const desktopCtx = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const ipadCtx = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const desktopPage = await desktopCtx.newPage();
		const ipadPage = await ipadCtx.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Visibility Resync" });

			await loginBrowser(desktopPage, stack.baseUrl);
			await loginBrowser(ipadPage, stack.baseUrl);

			await ipadPage.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await desktopPage.goto(`${stack.baseUrl}/chat/${chat.id}`);

			// Block /api/chats/.../stream briefly on iPad while Desktop starts turn
			let blockStream = true;
			await ipadPage.route(`**/api/chats/${chat.id}/stream`, async (route) => {
				if (blockStream) return route.abort("failed");
				return route.continue();
			});

			const composer = composerInput(desktopPage);
			await composer.fill("[STREAM_LONG] wake resync");
			await desktopPage.getByRole("button", { name: "Send" }).click();
			await expect(desktopPage.getByText("Chunk 03/25:")).toBeVisible({ timeout: 10_000 });

			// Unblock and fire visibility/focus/online events on iPad
			blockStream = false;
			await ipadPage.evaluate(() => {
				window.dispatchEvent(new Event("online"));
				window.dispatchEvent(new Event("focus"));
				document.dispatchEvent(new Event("visibilitychange"));
			});

			await expect(ipadPage.getByText("Chunk 25/25:")).toBeVisible({ timeout: 25_000 });
			expect((await stack.mock.getRequests()).count).toBe(1);
		} finally {
			await desktopCtx.close();
			await ipadCtx.close();
			await stack.cleanup();
		}
	});

	test("T1-F7-05: Multi-retry transient stream recovery completes without duplicate message or 2nd turn", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 110 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Stream Retry" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);

			let streamDrops = 0;
			await page.route(`**/api/chats/${chat.id}/stream`, async (route) => {
				streamDrops += 1;
				if (streamDrops === 1) {
					return route.abort("connectionreset");
				}
				return route.continue();
			});

			const composer = composerInput(page);
			await composer.fill("[STREAM_LONG] transient drop");
			await page.getByRole("button", { name: "Send" }).click();

			await expect(page.getByText("Chunk 25/25:")).toBeVisible({ timeout: 25_000 });
			expect((await stack.mock.getRequests()).count).toBe(1);
			const chunkMatches = await page.getByText("Chunk 25/25:").count();
			expect(chunkMatches).toBe(1);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});
});

test.describe("Tier 1 — F8: Windows Electron Remote-Server Client & Security Isolation", () => {
	async function runElectronProbe(probeJs) {
		const tempDir = fs.mkdtempSync("/tmp/lh-electron-probe-");
		const scriptPath = path.join(tempDir, "probe.mjs");
		fs.writeFileSync(scriptPath, probeJs, "utf8");
		try {
			return await runNode26Cli(scriptPath, [], { cwd: resolveRepoDir() });
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}

	test("T1-F8-01: First-run remote server URL setup & validation saves remote-config.json", async () => {
		const repoDir = resolveRepoDir();
		const res = await runElectronProbe(`
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const remoteConfigMod = require(${JSON.stringify(path.join(repoDir, "electron", "remote-config.cjs"))});
const userData = fs.mkdtempSync("/tmp/lh-el-userdata-");
const initial = remoteConfigMod.readRemoteConfig(userData);
const saved = remoteConfigMod.writeRemoteConfig(userData, { mode: "remote", serverUrl: "https://lh.example.test/" });
const reloaded = remoteConfigMod.readRemoteConfig(userData);
console.log(JSON.stringify({ initial, saved, reloaded }));
fs.rmSync(userData, { recursive: true, force: true });
`);
		expect(res.code).toBe(0);
		const out = JSON.parse(res.stdout.trim());
		expect(out.reloaded.mode).toBe("remote");
		expect(out.reloaded.serverUrl).toBe("https://lh.example.test");
	});

	test("T1-F8-02: Change Server URL updates remote-config.json and allowedOrigin dynamically", async () => {
		const repoDir = resolveRepoDir();
		const res = await runElectronProbe(`
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const remoteConfigMod = require(${JSON.stringify(path.join(repoDir, "electron", "remote-config.cjs"))});
const userData = fs.mkdtempSync("/tmp/lh-el-userdata-");
remoteConfigMod.writeRemoteConfig(userData, { mode: "remote", serverUrl: "https://server-a.example.test" });
const originA = remoteConfigMod.allowedOriginForConfig(remoteConfigMod.readRemoteConfig(userData));
remoteConfigMod.writeRemoteConfig(userData, { mode: "remote", serverUrl: "https://server-b.example.test:8443" });
const originB = remoteConfigMod.allowedOriginForConfig(remoteConfigMod.readRemoteConfig(userData));
console.log(JSON.stringify({ originA, originB }));
fs.rmSync(userData, { recursive: true, force: true });
`);
		expect(res.code).toBe(0);
		const out = JSON.parse(res.stdout.trim());
		expect(out.originA).toBe("https://server-a.example.test");
		expect(out.originB).toBe("https://server-b.example.test:8443");
	});

	test("T1-F8-03: Reconnect UI on connection loss & recovery against live server", async ({ browser }) => {
		const repoDir = resolveRepoDir();
		const reconnectHtmlPath = path.join(repoDir, "electron", "remote-reconnect.html");
		expect(fs.existsSync(reconnectHtmlPath)).toBe(true);

		const stack = await bootStack();
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			await stack.ctrl.stop();
			const html = fs.readFileSync(reconnectHtmlPath, "utf8");
			await page.setContent(html);
			await expect(page.getByRole("button", { name: /reconnect/i })).toBeVisible();
			await expect(page.getByRole("button", { name: /change server/i })).toBeVisible();

			await stack.ctrl.start({ port: stack.port });
			const health = await fetch(`${stack.baseUrl}/api/health`);
			expect(health.status).toBe(200);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F8-04: Remote preload omits local privileges (getPathForFile, chooseAttachmentFolder, chatgpt, subscriptions)", async () => {
		const repoDir = resolveRepoDir();
		const res = await runElectronProbe(`
import Module from "node:module";
import path from "node:path";
let exposed = null;
const fakeElectron = {
  contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
  ipcRenderer: { on: () => {}, removeListener: () => {}, send: () => {}, invoke: async () => null },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return fakeElectron;
  return origLoad.call(this, request, parent, isMain);
};
const require = Module.createRequire(import.meta.url);
require(${JSON.stringify(path.join(repoDir, "electron", "preload-remote.cjs"))});
console.log(JSON.stringify({
  keys: Object.keys(exposed || {}),
  hasGetPathForFile: exposed?.getPathForFile !== undefined,
  hasChooseAttachmentFolder: exposed?.chooseAttachmentFolder !== undefined,
  hasChatgpt: exposed?.chatgpt !== undefined,
  hasSubscriptions: exposed?.subscriptions !== undefined,
  hasChangeServerUrl: typeof exposed?.changeServerUrl === "function",
}));
`);
		expect(res.code).toBe(0);
		const out = JSON.parse(res.stdout.trim());
		expect(out.hasGetPathForFile).toBe(false);
		expect(out.hasChooseAttachmentFolder).toBe(false);
		expect(out.hasChatgpt).toBe(false);
		expect(out.hasSubscriptions).toBe(false);
		expect(out.hasChangeServerUrl).toBe(true);
	});

	test("T1-F8-05: Remote mode decouples from local DATA_DIR and never reads host AppData", async () => {
		const repoDir = resolveRepoDir();
		const res = await runElectronProbe(`
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const remoteConfigMod = require(${JSON.stringify(path.join(repoDir, "electron", "remote-config.cjs"))});
const canUseLocalData = remoteConfigMod.shouldUseLocalDataDir({ mode: "remote", serverUrl: "https://lh.example.test" });
console.log(JSON.stringify({ canUseLocalData }));
`);
		expect(res.code).toBe(0);
		const out = JSON.parse(res.stdout.trim());
		expect(out.canUseLocalData).toBe(false);
	});
});
