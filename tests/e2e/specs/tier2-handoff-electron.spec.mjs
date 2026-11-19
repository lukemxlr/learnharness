import { expect, test } from "@playwright/test";
import {
	evaluateRemoteConfig,
	inspectPreloadSurface,
	mountElectronHtml,
	probeServerHealthFromElectron,
	runElectronProbe,
	verifyRemoteSecurityGuards,
	withTempUserData,
} from "../harness/electron-harness.mjs";
import { resolveRepoDir, ServerController } from "../harness/server-controller.mjs";
import {
	bootStack,
	createChatSession,
	loginApi,
	loginBrowser,
	VIEWPORT_MATRIX,
	viewportContextOptions,
} from "../helpers/e2e-session.mjs";

test.describe("Tier 2 — F7: Multi-Device Stream Handoff & Edge Recovery", () => {
	test("T2-F7-01: Client A disconnects mid-turn; server completes turn and Client B receives full reply", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 65 } });
		const ctxA = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const ctxB = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Disconnect Mid-Turn" });

			await loginBrowser(pageA, stack.baseUrl);
			await pageA.goto(`${stack.baseUrl}/chat/${chat.id}`, { waitUntil: "domcontentloaded" });

			const composer = pageA.getByTestId("composer").locator("[data-file-path-input]");
			await composer.fill("[STREAM_LONG] client A disconnects early");
			await pageA.getByRole("button", { name: "Send" }).click();

			await expect(pageA.getByText("Chunk 01/25:")).toBeVisible({ timeout: 10_000 });
			await ctxA.close();

			// Wait for server-owned background turn to settle after Client A closed
			await expect
				.poll(
					async () => {
						const r = await fetch(`${stack.baseUrl}/api/jobs?chatId=${chat.id}`, {
							headers: { Cookie: cookie },
						});
						if (r.status !== 200) return false;
						const data = await r.json();
						return data.turnInFlight === false;
					},
					{ timeout: 25_000 },
				)
				.toBe(true);

			await loginBrowser(pageB, stack.baseUrl);
			await pageB.goto(`${stack.baseUrl}/chat/${chat.id}`, { waitUntil: "domcontentloaded" });
			await expect(pageB.getByText("Chunk 25/25:")).toBeVisible({ timeout: 15_000 });

			const ledger = await stack.mock.getRequests();
			expect(ledger.count).toBe(1);
		} finally {
			await ctxA.close().catch(() => {});
			await ctxB.close().catch(() => {});
			await stack.cleanup();
		}
	});

	test("T2-F7-02: Reconnect after turn settled returns turn-settled + [DONE] and starts zero duplicate turns", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 25 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Settled Race Window" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`, { waitUntil: "domcontentloaded" });

			let abortStream = true;
			await page.route(`**/api/chats/${chat.id}/stream`, async (route) => {
				if (abortStream) return route.abort("failed");
				return route.continue();
			});

			const composer = page.getByTestId("composer").locator("[data-file-path-input]");
			await composer.fill("[STREAM_LONG] settled race check");
			await page.getByRole("button", { name: "Send" }).click();

			// Wait for server turn to settle completely
			await expect
				.poll(
					async () => {
						const r = await fetch(`${stack.baseUrl}/api/jobs?chatId=${chat.id}`, {
							headers: { Cookie: cookie },
						});
						if (r.status !== 200) return false;
						const j = await r.json();
						return j.turnInFlight === false && (await stack.mock.getRequests()).count === 1;
					},
					{ timeout: 20_000 },
				)
				.toBe(true);

			// Direct stream call after settlement returns cheap turn-settled + [DONE]
			const settledStream = await fetch(`${stack.baseUrl}/api/chats/${chat.id}/stream`, {
				headers: { Cookie: cookie },
			});
			expect(settledStream.status).toBe(200);
			const settledBody = await settledStream.text();
			expect(settledBody).toContain('"type":"turn-settled"');
			expect(settledBody).toContain("[DONE]");

			abortStream = false;
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.getByText("Chunk 25/25:")).toBeVisible({ timeout: 15_000 });
			expect((await stack.mock.getRequests()).count).toBe(1);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F7-03: Mid-stream page.reload() on single device re-attaches without duplicating message", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 90 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Mid-Stream Reload" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`, { waitUntil: "domcontentloaded" });

			const composer = page.getByTestId("composer").locator("[data-file-path-input]");
			await composer.fill("[STREAM_LONG] reload reattach");
			await page.getByRole("button", { name: "Send" }).click();

			await expect(page.getByText("Chunk 03/25:")).toBeVisible({ timeout: 10_000 });
			await page.reload({ waitUntil: "domcontentloaded" });

			await expect(page.getByText("Chunk 25/25:")).toBeVisible({ timeout: 25_000 });
			await expect(page.getByText("Chunk 25/25:")).toHaveCount(1);
			expect((await stack.mock.getRequests()).count).toBe(1);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F7-04: 3 simultaneous viewers (Desktop + 2 iPad viewports) share single live turn", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 100 } });
		const deskCtx = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const ipadPortCtx = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const ipadLandCtx = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-SM-LAND"]));
		const deskPage = await deskCtx.newPage();
		const ipadPortPage = await ipadPortCtx.newPage();
		const ipadLandPage = await ipadLandCtx.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Three Viewer Broadcast" });

			await Promise.all([
				loginBrowser(deskPage, stack.baseUrl),
				loginBrowser(ipadPortPage, stack.baseUrl),
				loginBrowser(ipadLandPage, stack.baseUrl),
			]);
			await Promise.all([
				deskPage.goto(`${stack.baseUrl}/chat/${chat.id}`, { waitUntil: "domcontentloaded" }),
				ipadPortPage.goto(`${stack.baseUrl}/chat/${chat.id}`, { waitUntil: "domcontentloaded" }),
				ipadLandPage.goto(`${stack.baseUrl}/chat/${chat.id}`, { waitUntil: "domcontentloaded" }),
			]);

			const composer = deskPage.getByTestId("composer").locator("[data-file-path-input]");
			await composer.fill("[STREAM_LONG] three-client handoff");
			await deskPage.getByRole("button", { name: "Send" }).click();

			await Promise.all([
				expect(deskPage.getByText("Chunk 25/25:")).toBeVisible({ timeout: 30_000 }),
				expect(ipadPortPage.getByText("Chunk 25/25:")).toBeVisible({ timeout: 30_000 }),
				expect(ipadLandPage.getByText("Chunk 25/25:")).toBeVisible({ timeout: 30_000 }),
			]);

			expect((await stack.mock.getRequests()).count).toBe(1);
		} finally {
			await deskCtx.close();
			await ipadPortCtx.close();
			await ipadLandCtx.close();
			await stack.cleanup();
		}
	});

	test("T2-F7-05: Side-chat NDJSON stream disconnect and reopen completes without 2nd side-model turn", async () => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 60 } });
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			await stack.mock.clearRequests();

			const ac = new AbortController();
			const postRes = await fetch(`${stack.baseUrl}/api/chats/chat_synth_teach_01/side-chats`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: cookie },
				signal: ac.signal,
				body: JSON.stringify({
					anchor: {
						messageId: "msg_synth_t01_06",
						partId: "msg_synth_t01_06-t0",
						blockIndex: 0,
						blockText:
							"Because horizontal acceleration ax = 0 and vertical acceleration ay = -g, the trajectory forms a parabola.",
					},
					text: "[STREAM_LONG] side disconnect recovery",
				}),
			});
			expect(postRes.status).toBe(200);

			// Read until first NDJSON event gives us threadId, then abort client stream mid-flight
			const reader = postRes.body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			let threadId = null;
			while (!threadId) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				for (const line of buf.split("\n")) {
					if (!line.trim()) continue;
					const parsed = JSON.parse(line);
					if (parsed.thread?.id) threadId = parsed.thread.id;
					else if (parsed.threadId) threadId = parsed.threadId;
				}
			}
			expect(threadId).toBeTruthy();
			ac.abort();

			// Re-attach to the durable side-thread NDJSON stream and verify full completion
			const watchRes = await fetch(
				`${stack.baseUrl}/api/chats/chat_synth_teach_01/side-chats/${threadId}`,
				{ headers: { Cookie: cookie } },
			);
			expect(watchRes.status).toBe(200);
			const watchText = await watchRes.text();
			expect(watchText).toContain("Chunk 25/25:");

			const listRes = await fetch(`${stack.baseUrl}/api/chats/chat_synth_teach_01/side-chats`, {
				headers: { Cookie: cookie },
			});
			expect(listRes.status).toBe(200);
			const listData = await listRes.json();
			const thread = listData.threads.find((t) => t.id === threadId);
			expect(thread).toBeTruthy();
			expect(JSON.stringify(thread.messages)).toContain("Chunk 25/25:");
			expect((await stack.mock.getRequests()).count).toBe(1);
		} finally {
			await stack.cleanup();
		}
	});
});

test.describe("Tier 2 — F8: Electron Remote Security, Preload Isolation & Reconnect", () => {
	test("T2-F8-01: Invalid/unsafe server URLs rejected in remote-config.cjs and setup.html", async ({ browser }) => {
		const invalidUrls = [
			"",
			"   ",
			"file:///etc/passwd",
			"javascript:alert(1)",
			"ftp://host.invalid",
			"https://user:pass@host.invalid",
			"https://host.invalid?token=1",
			"https://host.invalid#frag",
			"https://host.invalid/\n",
		];

		const evalRes = await evaluateRemoteConfig({
			initialUrl: "https://lh.example.test",
			nextUrl: "https://lh-next.example.test:8443",
			invalidUrls,
		});
		for (const item of evalRes.invalidResults) {
			expect(item.validation.ok, `Expected validation failure for ${item.candidate}`).toBe(false);
			expect(item.writeThrew, `Expected writeRemoteConfig to throw for ${item.candidate}`).toBe(true);
		}

		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { calls } = await mountElectronHtml(page, "setup.html", {
				allowInlineScriptForWebkitTest: true,
				bridgeHandlers: {
					saveServerUrl: async () => ({ ok: false, error: "Only http:// and https:// server URLs are supported." }),
				},
			});

			await page.locator("#server-url").fill("javascript:alert(1)");
			await page.locator("#connect-btn").click();
			await expect(page.locator("#error-text")).toContainText(/http:\/\/ and https:\/\//i);
			expect(calls.some((c) => c.method === "saveServerUrl" && c.args[0] === "javascript:alert(1)")).toBe(true);
		} finally {
			await context.close();
		}
	});

	test("T2-F8-02: Foreign-origin navigation/popup guard enforces exact allowedOriginForConfig", async () => {
		const guards = await verifyRemoteSecurityGuards();
		expect(guards.ok).toBe(true);

		const remoteConfigPath = `${resolveRepoDir()}/electron/remote-config.cjs`;
		const probe = await runElectronProbe(`
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const rc = require(${JSON.stringify(remoteConfigPath)});
const allowed = rc.allowedOriginForConfig({ mode: "remote", serverUrl: "https://study.example.test:8443/app" });
const localAllowed = rc.allowedOriginForConfig({ mode: "local", serverUrl: "https://study.example.test:8443" });
const unsetAllowed = rc.allowedOriginForConfig({ mode: "unset", serverUrl: null });
console.log(JSON.stringify({
  allowed,
  localAllowed,
  unsetAllowed,
  foreignMatches: new URL("https://evil.invalid/login").origin === allowed,
  portMismatchMatches: new URL("https://study.example.test:8444/login").origin === allowed,
  schemeMismatchMatches: new URL("http://study.example.test:8443/login").origin === allowed,
  exactMatches: new URL("https://study.example.test:8443/chat/1").origin === allowed,
}));
`);
		expect(probe.code).toBe(0);
		expect(probe.json.allowed).toBe("https://study.example.test:8443");
		expect(probe.json.localAllowed).toBeNull();
		expect(probe.json.unsetAllowed).toBeNull();
		expect(probe.json.foreignMatches).toBe(false);
		expect(probe.json.portMismatchMatches).toBe(false);
		expect(probe.json.schemeMismatchMatches).toBe(false);
		expect(probe.json.exactMatches).toBe(true);
	});

	test("T2-F8-03: Remote preload and setup preload strictly omit local filesystem/OAuth/updater APIs", async () => {
		const remote = await inspectPreloadSurface("preload-remote.cjs");
		expect(remote.exposedName).toBe("lh");
		expect(remote.isRemoteMode).toBe(true);
		expect(remote.hasChangeServerUrl).toBe(true);
		expect(remote.hasGetPathForFile).toBe(false);
		expect(remote.hasChooseAttachmentFolder).toBe(false);
		expect(remote.hasChatgpt).toBe(false);
		expect(remote.hasSubscriptions).toBe(false);
		for (const forbiddenKey of [
			"getPathForFile",
			"chooseAttachmentFolder",
			"chatgpt",
			"subscriptions",
			"installUpdate",
			"checkForUpdates",
			"getUpdateState",
			"onUpdateStatus",
		]) {
			expect(remote.keys).not.toContain(forbiddenKey);
		}
		expect(remote.keys).toEqual([
			"isRemoteMode",
			"platform",
			"expandWindow",
			"setAppearance",
			"onZoom",
			"getZoom",
			"onOpenSettings",
			"changeServerUrl",
		]);

		const setup = await inspectPreloadSurface("preload-setup.cjs");
		expect(setup.exposedName).toBe("lhSetup");
		expect(setup.hasGetPathForFile).toBe(false);
		expect(setup.hasChooseAttachmentFolder).toBe(false);
		expect(setup.hasChatgpt).toBe(false);
		expect(setup.hasSubscriptions).toBe(false);
		expect(setup.keys).toEqual(["platform", "getState", "saveServerUrl", "reconnect", "openSetup", "cancel"]);
	});

	test("T2-F8-04: Reconnect UI renders error and preserves Change Server URL when server stays unreachable", async ({ browser }) => {
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { calls } = await mountElectronHtml(page, "remote-reconnect.html", {
				allowInlineScriptForWebkitTest: true,
				mockBridgeState: {
					serverUrl: "https://offline-study.example.test",
					lastError: "Initial connection refused",
				},
				bridgeHandlers: {
					reconnect: async () => ({ ok: false, error: "ECONNREFUSED: server still unreachable" }),
				},
			});

			await expect(page.locator("#server-origin")).toBeVisible();
			await expect(page.locator("#server-origin")).toHaveText("https://offline-study.example.test");
			await expect(page.locator("#error-text")).toHaveText("Initial connection refused");

			await page.locator("#reconnect-btn").click();
			await expect(page.locator("#error-text")).toHaveText("ECONNREFUSED: server still unreachable");
			await expect(page.locator("#reconnect-btn")).toBeEnabled();
			await expect(page.locator("#reconnect-btn")).toHaveText("Reconnect");

			await expect(page.locator("#change-server-btn")).toBeEnabled();
			await page.locator("#change-server-btn").click();
			expect(calls.some((c) => c.method === "reconnect")).toBe(true);
			expect(calls.some((c) => c.method === "openSetup")).toBe(true);
		} finally {
			await context.close();
		}
	});

	test("T2-F8-05: Switching from offline Server A to healthy Server B updates origin and loads login", async ({ browser }) => {
		const serverA = new ServerController({ id: "t2-f8-05-a" });
		const serverB = new ServerController({ id: "t2-f8-05-b" });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			await serverA.initAuth();
			await serverB.initAuth();
			await serverA.start();
			await serverB.start();
			const urlA = serverA.baseUrl;
			const urlB = serverB.baseUrl;

			// Stop Server A so it is unreachable while Server B stays healthy
			await serverA.stop();

			const probeA = await probeServerHealthFromElectron(urlA, { timeoutMs: 1500 });
			expect(probeA.ok).toBe(false);

			const probeB = await probeServerHealthFromElectron(urlB, { timeoutMs: 3000 });
			expect(probeB.ok).toBe(true);
			expect(probeB.origin).toBe(urlB);

			await withTempUserData(async () => {
				const cfg = await evaluateRemoteConfig({ initialUrl: urlA, nextUrl: urlB });
				expect(cfg.allowedOrigin).toBe(urlA);
				expect(cfg.nextAllowedOrigin).toBe(urlB);
			});

			await page.goto(`${urlB}/login`, { waitUntil: "domcontentloaded" });
			await expect(page.getByTestId("login-username")).toBeVisible();
		} finally {
			await context.close();
			await serverA.cleanup();
			await serverB.cleanup();
		}
	});
});
