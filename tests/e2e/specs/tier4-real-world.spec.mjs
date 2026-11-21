import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	mountElectronHtml,
	probeServerHealthFromElectron,
	verifyRemoteSecurityGuards,
} from "../harness/electron-harness.mjs";
import { resolveRepoDir, resolveStandaloneDir } from "../harness/server-controller.mjs";
import {
	addDrawingToAnswer,
	assertCleanCanvasComparedTo,
	assertExportedDrawingContrast,
	closeDrawingPad,
	dispatchClipboardPaste,
	drawCanvasStroke,
	drawingCanvas,
	getCanvasSnapshot,
	openDrawingPad,
	selectPenColor,
	selectStrokeWidth,
	setPaperTheme,
	toggleKarorasterGrid,
	toggleQuestionContext,
} from "../helpers/drawing-pad.mjs";
import {
	bootStack,
	composerInput,
	createChatSession,
	DEFAULT_USER,
	discoverCustomProviderModels,
	loginApi,
	loginBrowser,
	questionInput,
	syntheticFixtureDir,
} from "../helpers/e2e-session.mjs";
import {
	assertClosedSidebarNotOverlapping,
	assertElementUnoccluded,
	assertKeyboardClearance,
	assertNoHorizontalOverflow,
	assertTouchTargets,
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

function snapshotDirChecksums(rootDir) {
	const entries = [];
	const walk = (dir) => {
		for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, item.name);
			const rel = path.relative(rootDir, full);
			if (item.isDirectory()) {
				walk(full);
			} else if (item.isFile()) {
				entries.push({
					rel,
					sha256: createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
				});
			}
		}
	};
	walk(rootDir);
	return entries;
}

test.describe("Tier 4 — Real-World End-to-End Application Scenarios", () => {
	test("T4-01: Acceptance Core Journey — Desktop -> iPad mid-stream handoff + Light-paper drawing in Dark app + cross-device history", async ({
		browser,
	}) => {
		test.slow();
		const stack = await bootStack({
			mockOptions: { chunkDelayMs: 110 },
			startOptions: { trustProxy: true, allowedHosts: "lh.study.test" },
		});
		const deskCtx = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const ipadCtx = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const deskPage = await deskCtx.newPage();
		const ipadPage = await ipadCtx.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl, {
				headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "lh.study.test" },
			});
			await fetch(`${stack.baseUrl}/api/settings/appearance`, {
				method: "PUT",
				headers: { "Content-Type": "application/json", Cookie: cookie },
				body: JSON.stringify({ theme: "default" }),
			});
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Acceptance Core Journey" });

			await loginBrowser(deskPage, stack.baseUrl);
			await deskPage.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(deskPage).fill("[STREAM_LONG] desktop launch");
			await deskPage.getByRole("button", { name: "Send" }).click();
			await expect(deskPage.getByText("Chunk 01/25:")).toBeVisible({ timeout: 10_000 });

			// Mid-stream switch to iPad WebKit
			await loginBrowser(ipadPage, stack.baseUrl);
			await ipadPage.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await expect(ipadPage.getByText("Chunk 25/25:")).toBeVisible({ timeout: 25_000 });
			await expect(deskPage.getByText("Chunk 25/25:")).toBeVisible({ timeout: 25_000 });
			expect((await stack.mock.getRequests()).count).toBe(1);

			// Tutor poses Free-Response question; iPad draws on Light paper inside Dark app
			await stack.mock.admin({ chunkDelayMs: 5 });
			await composerInput(ipadPage).fill("[TRIGGER_FREE]");
			await ipadPage.getByRole("button", { name: "Send" }).click();
			await expect(ipadPage.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });

			const canvas = await openDrawingPad(ipadPage);
			await setPaperTheme(ipadPage, "light");
			await toggleKarorasterGrid(ipadPage);
			await toggleQuestionContext(ipadPage);
			await expect(
				ipadPage.locator("[data-plugin-session-surface-frame]").getByText(/horizontal and vertical components/i),
			).toBeVisible();
			await toggleQuestionContext(ipadPage);

			await selectPenColor(ipadPage, /black|ink|#111|dark/i);
			await selectStrokeWidth(ipadPage, 6);
			await drawCanvasStroke(ipadPage, canvas, { pointerType: "pen", points: [[0.2, 0.3], [0.8, 0.3]] });
			await selectPenColor(ipadPage, /blue/i);
			await drawCanvasStroke(ipadPage, canvas, { pointerType: "pen", points: [[0.2, 0.6], [0.8, 0.6]] });
			const snapBeforeClose = await getCanvasSnapshot(canvas);

			// Close & reopen verifies local draft persistence before staging
			await closeDrawingPad(ipadPage);
			const reopenedCanvas = await openDrawingPad(ipadPage);
			expect((await getCanvasSnapshot(reopenedCanvas)).dataUrl).toBe(snapBeforeClose.dataUrl);

			await addDrawingToAnswer(ipadPage);
			const previewImg = ipadPage.getByTestId("question-dock").locator("img").first();
			await expect(previewImg).toBeVisible();
			await assertExportedDrawingContrast(ipadPage, stack.baseUrl, previewImg, {
				expectedBackground: "light",
				minStrokePixels: 25,
				minContrastRatio: 3.0,
			});

			await questionInput(ipadPage, "answer").fill("[ECHO_VISION] Core journey diagram");
			await stack.mock.clearRequests();
			await ipadPage.getByRole("button", { name: /Submit answer/i }).click();

			await expect(ipadPage.getByText(/VISION_ECHO count=1/)).toBeVisible({ timeout: 15_000 });
			expect((await stack.mock.getRequests()).requests.at(-1).images.length).toBe(1);
			await expect(ipadPage.locator("main img").first()).toBeVisible();
			await expect(deskPage.getByText(/VISION_ECHO count=1/)).toBeVisible({ timeout: 15_000 });
			await expect(deskPage.locator("main img").first()).toBeVisible();

			// Restart server and verify submitted drawing & transcript survive
			await stack.ctrl.restart();
			await deskPage.reload();
			await expect(deskPage.getByText(/VISION_ECHO count=1/)).toBeVisible({ timeout: 15_000 });
			await expect(deskPage.locator("main img").first()).toBeVisible();
		} finally {
			await deskCtx.close();
			await ipadCtx.close();
			await stack.cleanup();
		}
	});

	test("T4-02: Windows Profile Migration -> LXC Production Cutover", async ({ browser }) => {
		const stack = await bootStack({ seedProfile: false, initAuth: false, mockOptions: { chunkDelayMs: 5 } });
		const srcProfile = path.join(stack.ctrl.rootDir, "win-profile");
		const bundleDir = path.join(stack.ctrl.rootDir, "bundle");
		const dryRunTarget = path.join(stack.ctrl.rootDir, "dry-target");
		fs.mkdirSync(dryRunTarget, { recursive: true });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			fs.cpSync(syntheticFixtureDir(), srcProfile, { recursive: true });
			const reachableVector = path.join(srcProfile, "source-files", "vector.png");
			const vectorBytes = fs.readFileSync(reachableVector);
			const vectorSha = createHash("sha256").update(vectorBytes).digest("hex");

			const chatPath = path.join(srcProfile, "chats", "chat_synth_teach_01.json");
			fs.writeFileSync(
				chatPath,
				fs
					.readFileSync(chatPath, "utf8")
					.replaceAll("C:\\\\Users\\\\Synth\\\\Notes\\\\vector.png", reachableVector.replaceAll("\\", "\\\\")),
				"utf8",
			);

			const beforeChecksums = snapshotDirChecksums(srcProfile);
			const exp = await stack.ctrl.runMigrateCli(["export", "--source", srcProfile, "--out", bundleDir]);
			expect(exp.code).toBe(0);
			expect(snapshotDirChecksums(srcProfile)).toEqual(beforeChecksums);

			const hasManifest =
				fs.existsSync(path.join(bundleDir, "manifest.json")) ||
				fs.existsSync(path.join(bundleDir, "export-manifest.json"));
			expect(hasManifest).toBe(true);

			const dry = await stack.ctrl.runMigrateCli([
				"import",
				"--bundle",
				bundleDir,
				"--target",
				dryRunTarget,
				"--dry-run",
			]);
			expect(dry.code).toBe(0);
			expect(dry.stdout + dry.stderr).toMatch(/missing|C:\\Users\\Synth\\Notes|Windows/i);
			expect(fs.readdirSync(dryRunTarget)).toEqual([]);

			const imp1 = await stack.ctrl.runMigrateCli([
				"import",
				"--bundle",
				bundleDir,
				"--target",
				stack.ctrl.dataDir,
				"--apply",
			]);
			expect(imp1.code).toBe(0);
			const chatsBefore = fs.readdirSync(path.join(stack.ctrl.dataDir, "chats")).sort();
			const nodesBefore = fs.readFileSync(path.join(stack.ctrl.dataDir, "graph", "nodes.jsonl"), "utf8");

			// Second --apply must be strictly idempotent
			const imp2 = await stack.ctrl.runMigrateCli([
				"import",
				"--bundle",
				bundleDir,
				"--target",
				stack.ctrl.dataDir,
				"--apply",
			]);
			expect(imp2.code).toBe(0);
			expect(fs.readdirSync(path.join(stack.ctrl.dataDir, "chats")).sort()).toEqual(chatsBefore);
			expect(fs.readFileSync(path.join(stack.ctrl.dataDir, "graph", "nodes.jsonl"), "utf8")).toBe(nodesBefore);

			await stack.ctrl.initAuth({ username: DEFAULT_USER.username, password: DEFAULT_USER.password });
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

			const attRes = await fetch(`${stack.baseUrl}/api/attachments/${vectorSha}`, { headers: { Cookie: cookie } });
			expect(attRes.status).toBe(200);
			expect(Buffer.from(await attRes.arrayBuffer()).equals(vectorBytes)).toBe(true);
			expect(fs.existsSync(path.join(stack.ctrl.dataDir, "themes", "synth-dark.json"))).toBe(true);
			expect(fs.existsSync(path.join(stack.ctrl.dataDir, "prompts", "teacher", "20-teaching.md"))).toBe(true);

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/chat_synth_teach_01`);
			await expect(page.getByText(/trajectory forms a parabola/i)).toBeVisible();
			await composerInput(page).fill("Follow-up after LXC cutover");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByText(/Follow-up after LXC cutover/i)).toBeVisible({ timeout: 15_000 });
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T4-03: Desktop Screenshot Paste (Ctrl+V) + PDF Upload Multi-Modal Study Session", async ({ browser }) => {
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
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Multi-Modal Study Session" });
			const pdf = buildSample3PagePdf();
			const png = createVectorDiagramPng(64, 48);

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);

			// Upload PDF with fileAccess.restricted=true and ask about page 2
			await page.getByTestId("attach-files-input").setInputFiles({
				name: "sample-3page.pdf",
				mimeType: "application/pdf",
				buffer: pdf,
			});
			await expect(page.getByText(/sample-3page\.pdf/i)).toBeVisible();
			await composerInput(page).fill("Explain page 2 trajectory equation");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByText(/Synthetic tutor response/i)).toBeVisible({ timeout: 15_000 });
			expect(JSON.stringify((await stack.mock.getRequests()).requests.at(-1))).toContain(
				"Projectile trajectory equation",
			);

			// Trigger MC question, pick option C, test text paste & transient 500 image paste failure, then retry
			await composerInput(page).fill("[TRIGGER_MC]");
			await page.getByRole("button", { name: "Send" }).click();
			const dock = page.getByTestId("question-dock");
			await expect(dock).toBeVisible({ timeout: 15_000 });

			await page.getByRole("radio").nth(2).click();
			await expect(page.getByRole("radio").nth(2)).toHaveAttribute("aria-checked", "true");
			const mcInput = questionInput(page, "thinking");
			await mcInput.fill("[ECHO_VISION] Option C because ");
			await dispatchClipboardPaste(mcInput, { text: "ay = -g throughout flight" });
			await expect(mcInput).toContainText("ay = -g throughout flight");

			let failOnce = true;
			await page.route("**/api/attachments", async (route) => {
				if (route.request().method() === "POST" && failOnce) {
					failOnce = false;
					return route.fulfill({
						status: 500,
						contentType: "application/json",
						body: JSON.stringify({ error: "Transient 500 during upload" }),
					});
				}
				return route.continue();
			});

			await dispatchClipboardPaste(mcInput, { pngBuffer: png });
			await expect(dock.getByRole("alert").or(page.getByText(/failed|error|transient/i)).first()).toBeVisible({
				timeout: 10_000,
			});
			await expect(page.getByRole("radio").nth(2)).toHaveAttribute("aria-checked", "true");
			await expect(mcInput).toContainText("ay = -g throughout flight");

			// Retry paste now that transient 500 is cleared
			await dispatchClipboardPaste(mcInput, { pngBuffer: png });
			await expect(dock.locator("img")).toHaveCount(1, { timeout: 10_000 });

			await stack.mock.clearRequests();
			await page.getByRole("button", { name: /Submit answer/i }).click();
			await expect(page.getByText(/VISION_ECHO count=1/)).toBeVisible({ timeout: 15_000 });
			const last = (await stack.mock.getRequests()).requests.at(-1);
			expect(last.images.length).toBe(1);
			expect(JSON.stringify(last.messages)).toContain("ay = -g throughout flight");
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T4-04: iPad Split-View & Orientation Resilience During Practice Problem", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-LG-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "iPad Split Practice" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_MC]");
			await page.getByRole("button", { name: "Send" }).click();

			const dock = page.getByTestId("question-dock");
			await expect(dock).toBeVisible({ timeout: 15_000 });
			await page.getByRole("radio").nth(1).click();
			const mcInput = questionInput(page, "thinking");
			await mcInput.fill("[ECHO_VISION] Split-view resilience reasoning");

			const canvas = await openDrawingPad(page);
			await drawCanvasStroke(page, canvas, { pointerType: "pen", points: [[0.2, 0.3], [0.8, 0.7]] });
			await addDrawingToAnswer(page);
			await expect(dock.locator("img")).toHaveCount(1);

			// Rotate to landscape then resize to narrow 1/3 Split-View (375x1024)
			await applyViewport(page, "VP-LG-LAND");
			await assertNoHorizontalOverflow(page);
			await applyViewport(page, "VP-SPLIT-1");
			await assertNoHorizontalOverflow(page);

			const openBtn = page.getByRole("button", { name: /Open sidebar/i });
			if (await openBtn.isVisible().catch(() => false)) {
				await openBtn.tap();
				await expect(page.getByTestId("new-session")).toBeVisible();
				await assertNoHorizontalOverflow(page);
				const closeBtn = page.getByRole("button", { name: /Close sidebar/i });
				if (await closeBtn.isVisible().catch(() => false)) {
					await closeBtn.tap();
				}
			}
			await assertClosedSidebarNotOverlapping(page);

			await assertTouchTargets(page, ['[data-testid="question-dock"] button']);
			const submitBtn = page.getByRole("button", { name: /Submit answer/i });
			await assertKeyboardClearance(page, submitBtn, 360);

			const restoreKb = await simulateOnscreenKeyboard(page, 360);
			try {
				await assertElementUnoccluded(page, submitBtn);
			} finally {
				await restoreKb();
			}

			await expect(page.getByRole("radio").nth(1)).toHaveAttribute("aria-checked", "true");
			await expect(mcInput).toContainText("Split-view resilience reasoning");
			await expect(dock.locator("img")).toHaveCount(1);

			await stack.mock.clearRequests();
			await submitBtn.click();
			await expect(page.getByText(/VISION_ECHO count=1/)).toBeVisible({ timeout: 15_000 });
			expect((await stack.mock.getRequests()).requests.at(-1).images.length).toBe(1);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T4-05: Headless ChatGPT Plus Setup, New Model Discovery & Outage Resilience", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const subHeaders = {
				"Content-Type": "application/json",
				Cookie: cookie,
				Origin: stack.baseUrl,
				"x-learnharness-subscriptions": "1",
			};

			// Headless OAuth start + PKCE verification against mock-provider
			const startRes = await fetch(`${stack.baseUrl}/api/subscriptions`, {
				method: "POST",
				headers: subHeaders,
				body: JSON.stringify({ providerId: "chatgpt", op: "start-headless" }),
			});
			expect(startRes.status).toBe(200);
			const startValue = (await startRes.json()).value;
			const authUrl = new URL(startValue.authorizeUrl);
			expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");

			const oidc = await (await fetch(`${stack.mock.origin}/.well-known/openid-configuration`)).json();
			const verifier = randomBytes(32).toString("base64url");
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			const pkceUrl = new URL(oidc.authorization_endpoint);
			pkceUrl.searchParams.set("client_id", "learnharness-test");
			pkceUrl.searchParams.set("redirect_uri", startValue.redirectUri);
			pkceUrl.searchParams.set("state", "t4_05_state");
			pkceUrl.searchParams.set("code_challenge", challenge);
			pkceUrl.searchParams.set("code_challenge_method", "S256");
			pkceUrl.searchParams.set("mode", "json");
			const pkceAuth = await (await fetch(pkceUrl)).json();
			const tokenRes = await fetch(oidc.token_endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code: pkceAuth.code,
					code_verifier: verifier,
					client_id: "learnharness-test",
					redirect_uri: startValue.redirectUri,
					state: "t4_05_state",
				}),
			});
			expect(tokenRes.status).toBe(200);

			// Add gpt-test-9-nova (272k) and discover it in Model Picker
			await stack.mock.admin({
				extraModels: [
					{
						id: "gpt-test-9-nova",
						slug: "gpt-test-9-nova",
						display_name: "GPT Test 9 Nova",
						visibility: "list",
						context_length: 272000,
						input_modalities: ["text", "image"],
						reasoning: true,
					},
				],
			});
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Catalog Outage Resilience" });
			await discoverCustomProviderModels(stack.baseUrl, cookie, stack.mock.baseUrl);
			await fetch(`${stack.baseUrl}/api/models/refresh`, { method: "POST", headers: { Cookie: cookie } });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await page.getByTestId("stats-model").click();
			await page.getByTestId("model-search").fill("gpt-test-9-nova");
			await page.getByTestId("model-menu").getByTestId("model-option-gpt-test-9-nova").click();
			await expect(page.getByTestId("stats-model")).toContainText(/gpt-test-9-nova/i);

			await composerInput(page).fill("Verify gpt-test-9-nova turn");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByText(/Synthetic tutor response/i)).toBeVisible({ timeout: 15_000 });

			// Simulate /v1/models 503 outage; last-good catalog and session model must remain intact
			await stack.mock.admin({ modelsStatus: 503 });
			const outageRefresh = await fetch(`${stack.baseUrl}/api/models/refresh`, {
				method: "POST",
				headers: { Cookie: cookie },
			});
			expect(outageRefresh.status).toBe(200);
			const outageBody = await outageRefresh.json();
			expect(outageBody.models.some((m) => m.id === "gpt-test-9-nova")).toBe(true);

			const persistedChat = await (
				await fetch(`${stack.baseUrl}/api/chats/${chat.id}`, { headers: { Cookie: cookie } })
			).json();
			expect(persistedChat.settings.model.id).toBe("gpt-test-9-nova");
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T4-06: Electron Remote Client First-Run, Outage Reconnect & Server Migration", async ({ browser }) => {
		const guards = await verifyRemoteSecurityGuards();
		expect(guards.ok).toBe(true);

		const stackA = await bootStack({
			serverOptions: { id: "t4-06-a" },
			username: "serverAUser",
			password: "ServerAPassword123!",
		});
		const stackB = await bootStack({
			serverOptions: { id: "t4-06-b" },
			username: "serverBUser",
			password: "ServerBPassword123!",
		});
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			expect((await probeServerHealthFromElectron(stackA.baseUrl)).ok).toBe(true);
			const loginA = await loginApi(stackA.baseUrl, {
				username: "serverAUser",
				password: "ServerAPassword123!",
			});
			expect(loginA.res.status).toBe(200);

			// Simulate Server A outage + reconnect UI interaction
			await stackA.ctrl.stop();
			expect((await probeServerHealthFromElectron(stackA.baseUrl)).ok).toBe(false);

			let shouldRecover = false;
			const mounted = await mountElectronHtml(page, "remote-reconnect.html", {
				allowInlineScriptForWebkitTest: true,
				mockBridgeState: { serverUrl: stackA.baseUrl, error: "ECONNREFUSED" },
				bridgeHandlers: {
					reconnect: async () => {
						if (!shouldRecover) {
							return { ok: false, error: "Server still unreachable" };
						}
						return { ok: true };
					},
				},
			});
			await expect(page.locator("#server-origin")).toContainText(stackA.baseUrl);
			await page.locator("#reconnect-btn").click();
			await expect(page.locator("#error-text")).toContainText(/unreachable/i);

			await stackA.ctrl.start({ port: stackA.port });
			shouldRecover = true;
			await page.locator("#reconnect-btn").click();
			expect(mounted.calls.filter((c) => c.method === "reconnect").length).toBe(2);
			expect((await probeServerHealthFromElectron(stackA.baseUrl)).ok).toBe(true);

			// Server migration A -> B keeps origin & auth isolated
			expect((await fetch(`${stackB.baseUrl}/api/chats`, { headers: { Cookie: loginA.cookie } })).status).toBe(
				401,
			);
			const loginB = await loginApi(stackB.baseUrl, {
				username: "serverBUser",
				password: "ServerBPassword123!",
			});
			expect(loginB.res.status).toBe(200);
		} finally {
			await context.close();
			await stackA.cleanup();
			await stackB.cleanup();
		}
	});

	test("T4-07: Security & Auth Boundary Audit Across All Surfaces", async () => {
		const stack = await bootStack({
			startOptions: { trustProxy: true, allowedHosts: "lh.test" },
		});
		try {
			const proxyHeaders = {
				"X-Forwarded-Proto": "https",
				"X-Forwarded-Host": "lh.test",
			};

			// 1. Unauthenticated page routes redirect to /login
			for (const pageRoute of ["/", "/chat/chat_synth_teach_01", "/settings"]) {
				const res = await fetch(`${stack.baseUrl}${pageRoute}`, {
					redirect: "manual",
					headers: proxyHeaders,
				});
				expect(res.status).toBe(302);
				expect(res.headers.get("location")).toContain("/login");
			}

			// 2. Unauthenticated APIs, SSE/NDJSON streams, attachments & plugin markdown return 401
			const dummySha = "0".repeat(64);
			for (const [method, apiRoute] of [
				["GET", "/api/chats"],
				["GET", "/api/models"],
				["GET", "/api/graph"],
				["GET", "/api/settings"],
				["GET", "/api/events"],
				["GET", "/api/chats/chat_synth_teach_01/stream"],
				["GET", "/api/chats/chat_synth_teach_01/side-chats"],
				["GET", `/api/attachments/${dummySha}`],
				["POST", "/api/plugins/drawing-pad/documents/markdown"],
			]) {
				const res = await fetch(`${stack.baseUrl}${apiRoute}`, { method, headers: proxyHeaders });
				expect(res.status).toBe(401);
			}

			// 3. Disallowed Host and cross-origin write blocked (403)
			const badHost = await fetch(`${stack.baseUrl}/api/chats`, {
				headers: { "X-Forwarded-Host": "evil.invalid" },
			});
			expect(badHost.status).toBe(403);

			const { cookie: oldCookie, setCookie } = await loginApi(stack.baseUrl, { headers: proxyHeaders });
			expect(setCookie).toContain("Secure");
			expect(setCookie).toContain("HttpOnly");

			const crossOrigin = await fetch(`${stack.baseUrl}/api/chats`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: oldCookie,
					...proxyHeaders,
					Origin: "https://evil.invalid",
					"Sec-Fetch-Site": "cross-site",
				},
				body: JSON.stringify({ title: "CSRF Attempt" }),
			});
			expect(crossOrigin.status).toBe(403);

			// 4. Tampered cookie rejected (401)
			const tamperedCookie = `${oldCookie.slice(0, -4)}dead`;
			const tamperedRes = await fetch(`${stack.baseUrl}/api/chats`, {
				headers: { Cookie: tamperedCookie, ...proxyHeaders },
			});
			expect(tamperedRes.status).toBe(401);

			// 5. No browser password-reset endpoint exists
			const resetPost = await fetch(`${stack.baseUrl}/api/auth/reset-password`, {
				method: "POST",
				headers: { Cookie: oldCookie, ...proxyHeaders, Origin: "https://lh.test", "Sec-Fetch-Site": "same-origin" },
			});
			expect([404, 405]).toContain(resetPost.status);

			// 6. CLI password reset invalidates old password & pre-reset cookie
			await stack.ctrl.resetPassword({ password: "RotatedPassword999!" });
			expect((await loginApi(stack.baseUrl, { headers: proxyHeaders })).res.status).toBe(401);
			expect(
				(await fetch(`${stack.baseUrl}/api/chats`, { headers: { Cookie: oldCookie, ...proxyHeaders } })).status,
			).toBe(401);
			expect(
				(
					await loginApi(stack.baseUrl, {
						password: "RotatedPassword999!",
						headers: proxyHeaders,
					})
				).res.status,
			).toBe(200);

			// 7. Standalone bundle excludes secret files
			const standaloneDir = resolveStandaloneDir(resolveRepoDir());
			const secretEntries = fs
				.readdirSync(standaloneDir)
				.filter((name) =>
					/^(auth\.json|user-auth\.json.*|(chatgpt|github-copilot|xai)-credentials\.json.*|\.env.*|data)$/.test(
						name,
					),
				);
			expect(secretEntries).toEqual([]);
		} finally {
			await stack.cleanup();
		}
	});

	test("T4-08: Drawing Pad Multi-Question Lesson Lifecycle & Cross-Session Isolation", async ({ browser }) => {
		test.slow();
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const deskCtx = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const ipadCtx = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const deskPage = await deskCtx.newPage();
		const ipadPage = await ipadCtx.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			await fetch(`${stack.baseUrl}/api/settings/appearance`, {
				method: "PUT",
				headers: { "Content-Type": "application/json", Cookie: cookie },
				body: JSON.stringify({ theme: "default" }),
			});
			const s1 = await createChatSession(stack.baseUrl, cookie, { title: "Lesson S1 Multi-Q" });
			const s2 = await createChatSession(stack.baseUrl, cookie, { title: "Lesson S2 Isolated" });

			await loginBrowser(deskPage, stack.baseUrl);
			await loginBrowser(ipadPage, stack.baseUrl);

			// Session 1 Q1 (Free-Response): Karoraster + Light paper in Dark app
			await ipadPage.goto(`${stack.baseUrl}/chat/${s1.id}`);
			await composerInput(ipadPage).fill("[TRIGGER_FREE] Q1");
			await ipadPage.getByRole("button", { name: "Send" }).click();
			await expect(ipadPage.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });

			const q1Canvas = await openDrawingPad(ipadPage);
			await toggleKarorasterGrid(ipadPage);
			await setPaperTheme(ipadPage, "light");
			await drawCanvasStroke(ipadPage, q1Canvas, { pointerType: "pen", points: [[0.2, 0.3], [0.8, 0.3]] });
			const q1Snap = await getCanvasSnapshot(q1Canvas);
			await addDrawingToAnswer(ipadPage);
			await questionInput(ipadPage, "answer").fill("[ECHO_VISION] Q1 answer");
			await ipadPage.getByRole("button", { name: /Submit answer/i }).click();
			await expect(ipadPage.getByText(/VISION_ECHO count=1/).first()).toBeVisible({ timeout: 15_000 });

			// Session 1 Q2 (MC): Drawing Pad opens blank, draw, close, reopen restored, Add to answer, pick A, submit
			await composerInput(ipadPage).fill("[TRIGGER_MC] Q2");
			await ipadPage.getByRole("button", { name: "Send" }).click();
			await expect(ipadPage.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });

			const q2Canvas = await openDrawingPad(ipadPage);
			await assertCleanCanvasComparedTo(q2Canvas, q1Snap.dataUrl);
			await drawCanvasStroke(ipadPage, q2Canvas, { pointerType: "pen", points: [[0.2, 0.65], [0.75, 0.65]] });
			const q2Snap = await getCanvasSnapshot(q2Canvas);
			await closeDrawingPad(ipadPage);

			const q2Reopened = await openDrawingPad(ipadPage);
			expect((await getCanvasSnapshot(q2Reopened)).dataUrl).toBe(q2Snap.dataUrl);
			await addDrawingToAnswer(ipadPage);
			await ipadPage.getByRole("radio").nth(0).click();
			await questionInput(ipadPage, "thinking").fill("[ECHO_VISION] Q2 answer");
			await ipadPage.getByRole("button", { name: /Submit answer/i }).click();
			await expect(ipadPage.getByText(/VISION_ECHO count=1/).nth(1)).toBeVisible({ timeout: 15_000 });

			// Session 2 must open with blank Drawing Pad (zero Q2 draft leak)
			await ipadPage.goto(`${stack.baseUrl}/chat/${s2.id}`);
			const s2Canvas = await openDrawingPad(ipadPage);
			await assertCleanCanvasComparedTo(s2Canvas, q2Snap.dataUrl);
			await closeDrawingPad(ipadPage);

			// Return to Session 1 on both iPad and Desktop: both Q1 & Q2 drawings visible
			await ipadPage.goto(`${stack.baseUrl}/chat/${s1.id}`);
			await deskPage.goto(`${stack.baseUrl}/chat/${s1.id}`);
			expect(await ipadPage.locator("main img").count()).toBeGreaterThanOrEqual(2);
			expect(await deskPage.locator("main img").count()).toBeGreaterThanOrEqual(2);
		} finally {
			await deskCtx.close();
			await ipadCtx.close();
			await stack.cleanup();
		}
	});
});
