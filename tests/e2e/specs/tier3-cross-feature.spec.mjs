import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	evaluateRemoteConfig,
	probeServerHealthFromElectron,
} from "../harness/electron-harness.mjs";
import {
	addDrawingToAnswer,
	closeDrawingPad,
	dispatchClipboardPaste,
	drawCanvasStroke,
	drawingCanvas,
	getCanvasSnapshot,
	openDrawingPad,
	selectPenColor,
	selectStrokeWidth,
	setPaperTheme,
} from "../helpers/drawing-pad.mjs";
import {
	bootStack,
	composerInput,
	createChatSession,
	discoverCustomProviderModels,
	loginApi,
	loginBrowser,
	questionInput,
	syntheticFixtureDir,
} from "../helpers/e2e-session.mjs";
import {
	assertElementsInViewport,
	assertNoHorizontalOverflow,
	assertPopoversInViewport,
	simulateOnscreenKeyboard,
} from "../helpers/layout-assertions.mjs";
import {
	buildSample3PagePdf,
	createVectorDiagramPng,
} from "../helpers/test-assets.mjs";
import {
	applyViewport,
	VIEWPORT_MATRIX,
	viewportContextOptions,
} from "../helpers/viewport-matrix.mjs";

test.describe("Tier 3 — Cross-Feature Pairwise Integrations", () => {
	test("T3-01 (F3+F4): Reverse proxy HTTPS + Single-account Auth", async () => {
		const stack = await bootStack({
			startOptions: { trustProxy: true, allowedHosts: "lh.test" },
		});
		try {
			const unauthApi = await fetch(`${stack.baseUrl}/api/chats`, {
				headers: {
					"X-Forwarded-Proto": "https",
					"X-Forwarded-Host": "lh.test",
				},
			});
			expect(unauthApi.status).toBe(401);

			const unauthPage = await fetch(`${stack.baseUrl}/`, {
				redirect: "manual",
				headers: {
					"X-Forwarded-Proto": "https",
					"X-Forwarded-Host": "lh.test",
				},
			});
			expect(unauthPage.status).toBe(302);
			expect(unauthPage.headers.get("location")).toContain("/login");

			const { res, cookie, setCookie } = await loginApi(stack.baseUrl, {
				headers: {
					"X-Forwarded-Proto": "https",
					"X-Forwarded-Host": "lh.test",
				},
			});
			expect(res.status).toBe(200);
			expect(setCookie).toContain("HttpOnly");
			expect(setCookie).toContain("Secure");
			expect(setCookie).toContain("SameSite=Lax");

			const okCreate = await fetch(`${stack.baseUrl}/api/chats`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookie,
					"X-Forwarded-Proto": "https",
					"X-Forwarded-Host": "lh.test",
					Origin: "https://lh.test",
					"Sec-Fetch-Site": "same-origin",
				},
				body: JSON.stringify({ title: "Proxied Auth Chat" }),
			});
			expect(okCreate.status).toBe(200);

			const crossOriginCreate = await fetch(`${stack.baseUrl}/api/chats`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookie,
					"X-Forwarded-Proto": "https",
					"X-Forwarded-Host": "lh.test",
					Origin: "https://attacker.invalid",
					"Sec-Fetch-Site": "cross-site",
				},
				body: JSON.stringify({ title: "Cross-Origin Blocked" }),
			});
			expect(crossOriginCreate.status).toBe(403);
		} finally {
			await stack.cleanup();
		}
	});

	test("T3-02 (F4+F9): Auth Gate + Attachment Upload/Fetch", async () => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		try {
			const png = createVectorDiagramPng(64, 48);
			const sha = createHash("sha256").update(png).digest("hex");

			const unauthForm = new FormData();
			unauthForm.append("file", new Blob([png], { type: "image/png" }), "unauth.png");
			const unauthPost = await fetch(`${stack.baseUrl}/api/attachments`, {
				method: "POST",
				body: unauthForm,
			});
			expect(unauthPost.status).toBe(401);

			const unauthGetBefore = await fetch(`${stack.baseUrl}/api/attachments/${sha}`);
			expect(unauthGetBefore.status).toBe(401);

			const { cookie } = await loginApi(stack.baseUrl);
			const authForm = new FormData();
			authForm.append("file", new Blob([png], { type: "image/png" }), "auth-bound.png");
			const authPost = await fetch(`${stack.baseUrl}/api/attachments`, {
				method: "POST",
				headers: { Cookie: cookie },
				body: authForm,
			});
			expect(authPost.status).toBe(201);
			const ref = await authPost.json();
			expect(ref.id).toBe(sha);

			const unauthGetAfter = await fetch(`${stack.baseUrl}${ref.url}`);
			expect(unauthGetAfter.status).toBe(401);

			const authGet = await fetch(`${stack.baseUrl}${ref.url}`, { headers: { Cookie: cookie } });
			expect(authGet.status).toBe(200);
			expect(authGet.headers.get("x-content-type-options")).toBe("nosniff");
			expect(authGet.headers.get("content-security-policy")).toContain("sandbox");
			expect(Buffer.from(await authGet.arrayBuffer()).equals(png)).toBe(true);
		} finally {
			await stack.cleanup();
		}
	});

	test("T3-03 (F4+F7): Auth Gate + Live Stream Handoff", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 110 } });
		const deskCtx = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const ipadCtx = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const deskPage = await deskCtx.newPage();
		const ipadPage = await ipadCtx.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Auth Stream Handoff" });

			const unauthStream = await fetch(`${stack.baseUrl}/api/chats/${chat.id}/stream`);
			expect(unauthStream.status).toBe(401);

			await loginBrowser(deskPage, stack.baseUrl);
			await loginBrowser(ipadPage, stack.baseUrl);

			await deskPage.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(deskPage).fill("[STREAM_LONG] gated handoff");
			await deskPage.getByRole("button", { name: "Send" }).click();
			await expect(deskPage.getByText("Chunk 01/25:")).toBeVisible({ timeout: 10_000 });

			await ipadPage.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await expect(ipadPage.getByText("Chunk 25/25:")).toBeVisible({ timeout: 25_000 });
			await expect(deskPage.getByText("Chunk 25/25:")).toBeVisible({ timeout: 25_000 });

			expect((await stack.mock.getRequests()).count).toBe(1);
		} finally {
			await deskCtx.close();
			await ipadCtx.close();
			await stack.cleanup();
		}
	});

	test("T3-04 (F5+F2): Headless ChatGPT / Live Catalog + Mock Provider", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);

			const subStatusRes = await fetch(`${stack.baseUrl}/api/subscriptions`, {
				headers: { Cookie: cookie, "x-learnharness-subscriptions": "1" },
			});
			expect(subStatusRes.status).toBe(200);
			const subStatus = await subStatusRes.json();
			expect(subStatus.chatgpt?.available).toBe(true);

			await discoverCustomProviderModels(stack.baseUrl, cookie, stack.mock.baseUrl);

			const refreshRes = await fetch(`${stack.baseUrl}/api/models/refresh`, {
				method: "POST",
				headers: { Cookie: cookie },
			});
			expect(refreshRes.status).toBe(200);
			const catalog = await refreshRes.json();
			expect(catalog.models.some((m) => m.id === "gpt-test-7-pro")).toBe(true);

			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Model Pick Run" });
			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);

			await page.getByTestId("stats-model").click();
			await expect(page.getByTestId("model-menu")).toBeVisible();
			await page.getByTestId("model-search").fill("gpt-test-7-pro");
			await page.getByTestId("model-menu").getByTestId("model-option-gpt-test-7-pro").click();

			await stack.mock.clearRequests();
			await composerInput(page).fill("Explain momentum conservation");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByText(/Synthetic tutor response/i)).toBeVisible({ timeout: 15_000 });

			const ledger = await stack.mock.getRequests();
			expect(ledger.count).toBeGreaterThanOrEqual(1);
			expect(ledger.requests.at(-1).model).toBe("gpt-test-7-pro");
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T3-05 (F5+F7): Catalog Refresh Error + Live Active Turn", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 100 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			await discoverCustomProviderModels(stack.baseUrl, cookie, stack.mock.baseUrl);
			const modelsBefore = await (
				await fetch(`${stack.baseUrl}/api/models`, { headers: { Cookie: cookie } })
			).json();
			expect(modelsBefore.models.some((m) => m.id === "gpt-test-7-pro")).toBe(true);

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/chat_synth_teach_01`);
			await composerInput(page).fill("[STREAM_LONG] active turn");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByText("Chunk 01/25:")).toBeVisible({ timeout: 10_000 });

			await stack.mock.admin({ modelsStatus: 503 });
			const refreshRes = await fetch(`${stack.baseUrl}/api/models/refresh`, {
				method: "POST",
				headers: { Cookie: cookie },
			});
			expect(refreshRes.status).toBe(200);
			const refreshed = await refreshRes.json();
			expect(refreshed.models.some((m) => m.id === "gpt-test-7-pro")).toBe(true);

			await expect(page.getByText("Chunk 25/25:")).toBeVisible({ timeout: 25_000 });
			const chatAfter = await (
				await fetch(`${stack.baseUrl}/api/chats/chat_synth_teach_01`, { headers: { Cookie: cookie } })
			).json();
			expect(chatAfter.settings.model).toEqual({ provider: "custom", id: "gpt-test-1" });
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T3-06 (F6+F1): Profile Migration + SHA-256 Attachment Store", async () => {
		const stack = await bootStack({ seedProfile: false });
		const srcProfile = path.join(stack.ctrl.rootDir, "src-profile");
		const bundleDir = path.join(stack.ctrl.rootDir, "bundle");
		try {
			fs.cpSync(syntheticFixtureDir(), srcProfile, { recursive: true });
			const vectorPath = path.join(srcProfile, "source-files", "vector.png");
			const pdfPath = path.join(srcProfile, "source-files", "kinematics.pdf");
			const vectorBytes = fs.readFileSync(vectorPath);
			const pdfBytes = fs.readFileSync(pdfPath);
			const vectorSha = createHash("sha256").update(vectorBytes).digest("hex");
			const pdfSha = createHash("sha256").update(pdfBytes).digest("hex");

			const chatPath = path.join(srcProfile, "chats", "chat_synth_teach_01.json");
			const updated = fs
				.readFileSync(chatPath, "utf8")
				.replaceAll("C:\\\\Users\\\\Synth\\\\Notes\\\\vector.png", vectorPath.replaceAll("\\", "\\\\"))
				.replaceAll("\\\\\\\\srv\\\\docs\\\\kinematics.pdf", pdfPath.replaceAll("\\", "\\\\"));
			fs.writeFileSync(chatPath, updated, "utf8");

			const exp = await stack.ctrl.runMigrateCli(["export", "--source", srcProfile, "--out", bundleDir]);
			expect(exp.code).toBe(0);
			const imp = await stack.ctrl.runMigrateCli([
				"import",
				"--bundle",
				bundleDir,
				"--target",
				stack.ctrl.dataDir,
				"--apply",
			]);
			expect(imp.code).toBe(0);

			const { cookie } = await loginApi(stack.baseUrl);
			for (const [sha, expected] of [
				[vectorSha, vectorBytes],
				[pdfSha, pdfBytes],
			]) {
				const res = await fetch(`${stack.baseUrl}/api/attachments/${sha}`, {
					headers: { Cookie: cookie },
				});
				expect(res.status).toBe(200);
				expect(Buffer.from(await res.arrayBuffer()).equals(expected)).toBe(true);
			}
		} finally {
			await stack.cleanup();
		}
	});

	test("T3-07 (F6+F4): Migrated Profile + Fresh Single-Account Login", async ({ browser }) => {
		const stack = await bootStack({ seedProfile: false, initAuth: false });
		const bundleDir = path.join(stack.ctrl.rootDir, "bundle");
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const exp = await stack.ctrl.runMigrateCli([
				"export",
				"--source",
				syntheticFixtureDir(),
				"--out",
				bundleDir,
			]);
			expect(exp.code).toBe(0);
			const imp = await stack.ctrl.runMigrateCli([
				"import",
				"--bundle",
				bundleDir,
				"--target",
				stack.ctrl.dataDir,
				"--apply",
			]);
			expect(imp.code).toBe(0);

			await stack.ctrl.initAuth({ username: "migrateduser", password: "MigratedPassword123!" });

			expect((await fetch(`${stack.baseUrl}/api/chats`)).status).toBe(401);
			expect((await fetch(`${stack.baseUrl}/api/graph`)).status).toBe(401);

			await loginBrowser(page, stack.baseUrl, {
				username: "migrateduser",
				password: "MigratedPassword123!",
			});
			const physicsFolder = page.getByTestId("sidebar-folder-folder_synth_physics");
			await expect(physicsFolder).toBeVisible();
			if ((await physicsFolder.getAttribute("aria-expanded")) !== "true") {
				await physicsFolder.click();
			}
			await expect(page.getByText("Kinematics & Projectile Vectors")).toBeVisible();
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T3-08 (F6+F9): Migrated Session + New Multi-Device Attachment", async ({ browser }) => {
		const stack = await bootStack({ seedProfile: false, mockOptions: { chunkDelayMs: 5 } });
		const bundleDir = path.join(stack.ctrl.rootDir, "bundle");
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const exp = await stack.ctrl.runMigrateCli([
				"export",
				"--source",
				syntheticFixtureDir(),
				"--out",
				bundleDir,
			]);
			expect(exp.code).toBe(0);
			const imp = await stack.ctrl.runMigrateCli([
				"import",
				"--bundle",
				bundleDir,
				"--target",
				stack.ctrl.dataDir,
				"--apply",
			]);
			expect(imp.code).toBe(0);

			// Bind custom provider to mock server after migration
			const { cookie } = await loginApi(stack.baseUrl);
			const cpGet = await fetch(`${stack.baseUrl}/api/custom-provider`, { headers: { Cookie: cookie } });
			await fetch(`${stack.baseUrl}/api/custom-provider`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookie,
					Origin: stack.baseUrl,
					"Sec-Fetch-Site": "same-origin",
					"If-Match": cpGet.headers.get("etag") || "",
				},
				body: JSON.stringify({ baseUrl: stack.mock.baseUrl, authMode: "keyless" }),
			});

			const png = createVectorDiagramPng(64, 48);
			const shaPrefix = createHash("sha256").update(png).digest("hex").slice(0, 12);

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/chat_synth_teach_01`);
			await expect(page.getByText(/trajectory forms a parabola/i)).toBeVisible();

			await page.getByTestId("attach-files-input").setInputFiles({
				name: "new-diagram.png",
				mimeType: "image/png",
				buffer: png,
			});
			await expect(page.getByText(/new-diagram\.png/i)).toBeVisible();
			await composerInput(page).fill("[ECHO_VISION] post-migration");
			await page.getByRole("button", { name: "Send" }).click();

			await expect(page.getByText(new RegExp(`sha256=${shaPrefix}`))).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText(/trajectory forms a parabola/i)).toBeVisible();
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T3-09 (F7+F8): Electron Remote Harness + iPad WebKit Live Handoff", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 110 } });
		const deskCtx = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const ipadCtx = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const deskPage = await deskCtx.newPage();
		const ipadPage = await ipadCtx.newPage();
		try {
			const cfgEval = await evaluateRemoteConfig({ initialUrl: stack.baseUrl });
			expect(cfgEval.allowedOrigin).toBe(stack.baseUrl);
			const health = await probeServerHealthFromElectron(stack.baseUrl);
			expect(health.ok).toBe(true);

			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Electron + iPad Handoff" });

			await loginBrowser(deskPage, stack.baseUrl);
			await loginBrowser(ipadPage, stack.baseUrl);

			await deskPage.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(deskPage).fill("[STREAM_LONG] electron handoff");
			await deskPage.getByRole("button", { name: "Send" }).click();
			await expect(deskPage.getByText("Chunk 01/25:")).toBeVisible({ timeout: 10_000 });

			await ipadPage.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await expect(ipadPage.getByText("Chunk 25/25:")).toBeVisible({ timeout: 25_000 });
			await expect(deskPage.getByText("Chunk 25/25:")).toBeVisible({ timeout: 25_000 });

			expect((await stack.mock.getRequests()).count).toBe(1);
		} finally {
			await deskCtx.close();
			await ipadCtx.close();
			await stack.cleanup();
		}
	});

	test("T3-10 (F8+F4): Electron Remote Config + Auth & Server Switch", async () => {
		const stackA = await bootStack({
			serverOptions: { id: "t3-10-a" },
			username: "userA",
			password: "PasswordAlpha123!",
		});
		const stackB = await bootStack({
			serverOptions: { id: "t3-10-b" },
			username: "userB",
			password: "PasswordBeta123!",
		});
		try {
			const cfg = await evaluateRemoteConfig({
				initialUrl: stackA.baseUrl,
				nextUrl: stackB.baseUrl,
			});
			expect(cfg.allowedOrigin).toBe(stackA.baseUrl);
			expect(cfg.nextAllowedOrigin).toBe(stackB.baseUrl);

			expect((await probeServerHealthFromElectron(stackA.baseUrl)).ok).toBe(true);
			expect((await probeServerHealthFromElectron(stackB.baseUrl)).ok).toBe(true);

			const loginA = await loginApi(stackA.baseUrl, {
				username: "userA",
				password: "PasswordAlpha123!",
			});
			expect(loginA.res.status).toBe(200);

			// Server A session cookie must be rejected by Server B
			const crossServerRes = await fetch(`${stackB.baseUrl}/api/chats`, {
				headers: { Cookie: loginA.cookie },
			});
			expect(crossServerRes.status).toBe(401);

			const loginB = await loginApi(stackB.baseUrl, {
				username: "userB",
				password: "PasswordBeta123!",
			});
			expect(loginB.res.status).toBe(200);
			const okB = await fetch(`${stackB.baseUrl}/api/chats`, {
				headers: { Cookie: loginB.cookie },
			});
			expect(okB.status).toBe(200);
		} finally {
			await stackA.cleanup();
			await stackB.cleanup();
		}
	});

	test("T3-11 (F9+F10): Ctrl+V Screenshot + Drawing Pad PNG in Same Answer", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Paste + Drawing Same Answer" });
			const png = createVectorDiagramPng(48, 36);

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_FREE]");
			await page.getByRole("button", { name: "Send" }).click();

			const dock = page.getByTestId("question-dock");
			const freeInput = questionInput(page, "answer");
			await expect(freeInput).toBeVisible({ timeout: 15_000 });

			await dispatchClipboardPaste(freeInput, { pngBuffer: png });
			await expect(dock.locator("img")).toHaveCount(1);

			const canvas = await openDrawingPad(page);
			await drawCanvasStroke(page, canvas, { pointerType: "pen", points: [[0.2, 0.3], [0.8, 0.7]] });
			await addDrawingToAnswer(page);
			await expect(dock.locator("img")).toHaveCount(2);

			await freeInput.fill("[ECHO_VISION] screenshot plus drawing");
			await stack.mock.clearRequests();
			await page.getByRole("button", { name: /Submit answer/i }).click();
			await expect(page.getByText(/VISION_ECHO count=2/)).toBeVisible({ timeout: 15_000 });

			const ledger = await stack.mock.getRequests();
			expect(ledger.requests.at(-1).images.length).toBe(2);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T3-12 (F9+F11): iPad File Picker + visualViewport Keyboard Open", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-SM-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "iPad Picker + Keyboard" });
			const png = createVectorDiagramPng(48, 36);

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_MC]");
			await page.getByRole("button", { name: "Send" }).click();

			const dock = page.getByTestId("question-dock");
			await expect(dock).toBeVisible({ timeout: 15_000 });
			const mcInput = questionInput(page, "thinking");
			await mcInput.tap();

			const restoreKb = await simulateOnscreenKeyboard(page, 360);
			try {
				const dockFileInput = dock.locator('input[type="file"]').first();
				const pickerInput = (await dockFileInput.count()) > 0 ? dockFileInput : page.getByTestId("attach-files-input");
				await pickerInput.setInputFiles({
					name: "ipad-photo.png",
					mimeType: "image/png",
					buffer: png,
				});
				await expect(dock.locator("img").first()).toBeVisible();
				const submitBtn = page.getByRole("button", { name: /Submit answer/i });
				await submitBtn.scrollIntoViewIfNeeded();
				const box = await submitBtn.boundingBox();
				expect(box.y + box.height).toBeLessThanOrEqual(1133 - 360 + 2);
				await assertNoHorizontalOverflow(page);
			} finally {
				await restoreKb();
			}
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T3-13 (F10+F11): Drawing Pad + iPad Orientation & Split-View Resize", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/chat_synth_teach_01`);

			const canvas = await openDrawingPad(page);
			await setPaperTheme(page, "light");
			await selectPenColor(page, /blue|black/i);
			await selectStrokeWidth(page, 6);
			await drawCanvasStroke(page, canvas, { pointerType: "pen", points: [[0.2, 0.3], [0.8, 0.7]] });
			const drawnSnap = await getCanvasSnapshot(canvas);
			expect(drawnSnap.buffer.byteLength).toBeGreaterThan(0);

			for (const vpKey of ["VP-SPLIT-1", "VP-MD-LAND"]) {
				await applyViewport(page, vpKey);
				await expect(canvas).toBeVisible();
				await assertNoHorizontalOverflow(page);
				await assertElementsInViewport(page, ["[data-plugin-session-surface] canvas.drawing-pad-ink"]);
			}
			const afterResize = await getCanvasSnapshot(canvas);
			expect(afterResize.dataUrl.length).toBeGreaterThan(100);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T3-14 (F10+F7): Drawing Pad Draft + Mid-Stream/Reload Device Sync", async ({ browser }) => {
		test.slow();
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const deskCtx = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const ipadCtx = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const deskPage = await deskCtx.newPage();
		const ipadPage = await ipadCtx.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Drawing Reload + Sync" });

			await loginBrowser(deskPage, stack.baseUrl);
			await loginBrowser(ipadPage, stack.baseUrl);

			await deskPage.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(deskPage).fill("[TRIGGER_FREE]");
			await deskPage.getByRole("button", { name: "Send" }).click();
			await expect(deskPage.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });

			await ipadPage.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await expect(ipadPage.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });

			const canvas = await openDrawingPad(ipadPage);
			await drawCanvasStroke(ipadPage, canvas, { pointerType: "pen", points: [[0.2, 0.4], [0.8, 0.4]] });
			const snapBeforeReload = await getCanvasSnapshot(canvas);
			await closeDrawingPad(ipadPage);

			await ipadPage.reload();
			await expect(ipadPage.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });
			const reopenedCanvas = await openDrawingPad(ipadPage);
			expect((await getCanvasSnapshot(reopenedCanvas)).dataUrl).toBe(snapBeforeReload.dataUrl);

			await addDrawingToAnswer(ipadPage);
			await questionInput(ipadPage, "answer").fill("[ECHO_VISION] synced drawing");
			await ipadPage.getByRole("button", { name: /Submit answer/i }).click();

			await expect(ipadPage.getByText(/VISION_ECHO count=1/)).toBeVisible({ timeout: 15_000 });
			await expect(deskPage.getByText(/VISION_ECHO count=1/)).toBeVisible({ timeout: 15_000 });
			await expect(deskPage.locator("main img").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deskCtx.close();
			await ipadCtx.close();
			await stack.cleanup();
		}
	});

	test("T3-15 (F2+F9): PDF Upload + Restricted fileAccess + Mock Model", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			await fetch(`${stack.baseUrl}/api/settings/agent`, {
				method: "PUT",
				headers: { "Content-Type": "application/json", Cookie: cookie },
				body: JSON.stringify({ fileAccess: { restricted: true, folders: [] } }),
			});
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Restricted PDF Study" });
			const pdf = buildSample3PagePdf();

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);

			await page.getByTestId("attach-files-input").setInputFiles({
				name: "sample-3page.pdf",
				mimeType: "application/pdf",
				buffer: pdf,
			});
			await expect(page.getByText(/sample-3page\.pdf/i)).toBeVisible();

			await composerInput(page).fill("Read page 2 equation");
			await page.getByRole("button", { name: "Send" }).click();

			await expect(page.getByText(/Synthetic tutor response/i)).toBeVisible({ timeout: 15_000 });
			const ledger = await stack.mock.getRequests();
			expect(JSON.stringify(ledger.requests.at(-1))).toContain("Projectile trajectory equation");
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T3-16 (F11+F5): iPad Split-View (375x1024) + Model Picker Catalog", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-SPLIT-1"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			await discoverCustomProviderModels(stack.baseUrl, cookie, stack.mock.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Split-View Model Picker" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);

			await page.getByTestId("stats-model").tap();
			const menu = page.getByTestId("model-menu");
			await expect(menu).toBeVisible();
			await assertPopoversInViewport(page);

			await page.getByTestId("model-search").fill("gpt-test-7-pro");
			await menu.getByTestId("model-option-gpt-test-7-pro").tap();
			await expect(page.getByTestId("stats-model")).toContainText(/gpt-test-7-pro/i);
			await assertNoHorizontalOverflow(page);

			const persisted = await (
				await fetch(`${stack.baseUrl}/api/chats/${chat.id}`, { headers: { Cookie: cookie } })
			).json();
			expect(persisted.settings.model.id).toBe("gpt-test-7-pro");
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});
});
