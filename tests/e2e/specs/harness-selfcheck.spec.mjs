import { spawn } from "node:child_process";
import { createHash, createVerify, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startMockProvider } from "../harness/mock-provider.mjs";
import { getFreePort, resolveRepoDir, ServerController } from "../harness/server-controller.mjs";
import { assertTouchTargets, viewportContextOptions } from "../helpers/e2e-session.mjs";
import {
	analyzePngPixels,
	assertPngContrast,
	buildPng,
	buildSample3PagePdf,
	createVectorDiagramPng,
} from "../helpers/test-assets.mjs";

test.describe("E2E Harness Self-Check", () => {
	test("Dual-Node bridge: Playwright WebKit drives and restarts a Node 26 HTTP server", async ({ browser }) => {
		const node26Bin = process.env.LH_NODE26_BIN || "/opt/node26/bin/node";
		const tempDir = fs.mkdtempSync("/tmp/lh-selfcheck-n26-");
		const port = await getFreePort("127.0.0.1");
		const serverScript = path.join(tempDir, "bridge-server.mjs");
		const stateFile = path.join(tempDir, "counter.json");

		fs.writeFileSync(
			serverScript,
			`import http from "node:http";
import fs from "node:fs";
const stateFile = ${JSON.stringify(stateFile)};
const server = http.createServer((req, res) => {
  if (req.url === "/api/increment" && req.method === "POST") {
    const cur = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")).count : 0;
    const next = cur + 1;
    fs.writeFileSync(stateFile, JSON.stringify({ count: next }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: next, nodeVersion: process.version }));
    return;
  }
  const cur = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")).count : 0;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(\`<!doctype html><html><body>
    <div data-testid="node-ver">\${process.version}</div>
    <div data-testid="counter">\${cur}</div>
    <button id="inc" style="min-width:48px;min-height:48px" onclick="fetch('/api/increment',{method:'POST'}).then(r=>r.json()).then(d=>{document.querySelector('[data-testid=counter]').textContent=String(d.count)})">Increment</button>
  </body></html>\`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
server.listen(${port}, "127.0.0.1", () => console.log("READY"));
`,
			"utf8",
		);

		const spawnBridge = async () => {
			const child = spawn(node26Bin, [serverScript], { stdio: ["ignore", "pipe", "pipe"] });
			await new Promise((resolve, reject) => {
				child.once("error", reject);
				child.stdout.on("data", (d) => {
					if (d.toString("utf8").includes("READY")) resolve();
				});
			});
			return child;
		};

		const stopBridge = async (child) => {
			if (!child || child.exitCode !== null) return;
			child.kill("SIGTERM");
			await new Promise((resolve) => child.once("exit", resolve));
		};

		const context = await browser.newContext({
			viewport: { width: 820, height: 1180 },
			hasTouch: true,
			isMobile: true,
			deviceScaleFactor: 2,
		});
		const page = await context.newPage();

		let child = await spawnBridge();
		try {
			await page.goto(`http://127.0.0.1:${port}/`);
			await expect(page.getByTestId("node-ver")).toHaveText(/^v26\./);
			await expect(page.getByTestId("counter")).toHaveText("0");
			await page.locator("#inc").tap();
			await expect(page.getByTestId("counter")).toHaveText("1");

			await stopBridge(child);
			child = await spawnBridge();

			await page.reload();
			await expect(page.getByTestId("node-ver")).toHaveText(/^v26\./);
			await expect(page.getByTestId("counter")).toHaveText("1");
			await page.locator("#inc").tap();
			await expect(page.getByTestId("counter")).toHaveText("2");
		} finally {
			await stopBridge(child);
			await context.close();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("Mock provider: /v1/models, SSE stream, tool calls, [ECHO_VISION], fault injection, and PKCE OAuth", async () => {
		const mock = await startMockProvider({ chunkDelayMs: 25 });
		try {
			// 1. Models endpoint
			const modelsRes = await fetch(`${mock.baseUrl}/models`);
			expect(modelsRes.status).toBe(200);
			const modelsBody = await modelsRes.json();
			expect(modelsBody.data.some((m) => m.id === "gpt-test-7-pro" && m.context_length === 272000)).toBe(true);
			expect(modelsBody.models.some((m) => m.slug === "gpt-test-7-pro" && m.visibility === "list")).toBe(true);

			// 2. [ECHO_VISION] inspects real PNG payload
			const png = createVectorDiagramPng(64, 48);
			const expectedShaPrefix = createHash("sha256").update(png).digest("hex").slice(0, 12);
			const visionRes = await fetch(`${mock.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-test-1",
					stream: false,
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: "[ECHO_VISION] inspect diagram" },
								{ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
							],
						},
					],
				}),
			});
			expect(visionRes.status).toBe(200);
			const visionData = await visionRes.json();
			expect(visionData.choices[0].message.content).toContain(`count=1 bytes=${png.byteLength} sha256=${expectedShaPrefix}`);

			// 3. [TRIGGER_MC] & [TRIGGER_FREE]
			const mcRes = await fetch(`${mock.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-test-1",
					stream: false,
					messages: [{ role: "user", content: "[TRIGGER_MC]" }],
				}),
			});
			const mcData = await mcRes.json();
			expect(mcData.choices[0].message.tool_calls[0].function.name).toBe("quiz");

			const freeRes = await fetch(`${mock.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-test-1",
					stream: false,
					tools: [{ type: "function", function: { name: "explain", parameters: { properties: { nodeId: {}, type: {} } } } }],
					messages: [{ role: "user", content: "[TRIGGER_FREE]" }],
				}),
			});
			const freeData = await freeRes.json();
			expect(freeData.choices[0].message.tool_calls[0].function.name).toBe("explain");

			// 4. [STREAM_LONG] SSE streaming + /v1/responses
			const sseRes = await fetch(`${mock.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-test-1",
					stream: true,
					messages: [{ role: "user", content: "[STREAM_LONG]" }],
				}),
			});
			expect(sseRes.status).toBe(200);
			const sseText = await sseRes.text();
			expect(sseText).toContain("Chunk 01/25:");
			expect(sseText).toContain("Chunk 25/25:");
			expect(sseText).toContain("data: [DONE]");

			// 5. Fault injection via /__mock/admin & ledger via /__mock/requests
			await mock.admin({ modelsStatus: 503, failNextTurn: 429 });
			const errModels = await fetch(`${mock.baseUrl}/models`);
			expect(errModels.status).toBe(503);
			const errTurn = await fetch(`${mock.baseUrl}/responses`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "gpt-test-1", input: "hello" }),
			});
			expect(errTurn.status).toBe(429);

			const ledger = await mock.getRequests();
			expect(ledger.count).toBe(5);
			await mock.clearRequests();
			expect((await mock.getRequests()).count).toBe(0);

			// 6. Mock OAuth PKCE + RS256 id_token verification
			const oidc = await (await fetch(`${mock.origin}/.well-known/openid-configuration`)).json();
			const verifier = randomBytes(32).toString("base64url");
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			const state = "state_selfcheck_01";
			const authUrl = new URL(oidc.authorization_endpoint);
			authUrl.searchParams.set("client_id", "learnharness-test");
			authUrl.searchParams.set("redirect_uri", "http://127.0.0.1:1455/auth/callback");
			authUrl.searchParams.set("state", state);
			authUrl.searchParams.set("code_challenge", challenge);
			authUrl.searchParams.set("code_challenge_method", "S256");
			authUrl.searchParams.set("mode", "json");

			const authResp = await (await fetch(authUrl)).json();
			expect(authResp.state).toBe(state);

			const tokenResp = await (
				await fetch(oidc.token_endpoint, {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						grant_type: "authorization_code",
						code: authResp.code,
						code_verifier: verifier,
						client_id: "learnharness-test",
					}),
				})
			).json();
			expect(tokenResp.access_token).toMatch(/^mock_at_/);
			expect(tokenResp.refresh_token).toMatch(/^mock_rt_/);

			const jwks = await (await fetch(oidc.jwks_uri)).json();
			const [hdrB64, payB64, sigB64] = tokenResp.id_token.split(".");
			const verify = createVerify("RSA-SHA256");
			verify.update(`${hdrB64}.${payB64}`);
			expect(verify.verify({ key: jwks.keys[0], format: "jwk" }, sigB64, "base64url")).toBe(true);
		} finally {
			await mock.close();
		}
	});

	test("PNG contrast analyzer & WebKit canvas light-paper export check + 3-page PDF builder", async ({ browser }) => {
		// 1. Verify PNG contrast positive & negative cases
		const lightCanvas = buildPng({
			width: 80,
			height: 60,
			background: [255, 255, 255, 255],
			draw: ({ drawLine }) => drawLine(10, 10, 70, 50, [17, 24, 39, 255], 3),
		});
		const lightStats = assertPngContrast(lightCanvas, { expectedBackground: "light", minStrokePixels: 40, minContrastRatio: 8 });
		expect(lightStats.backgroundLuminance).toBeGreaterThan(250);

		const invisibleWhiteOnWhite = buildPng({
			width: 40,
			height: 40,
			background: [255, 255, 255, 255],
			draw: ({ drawLine }) => drawLine(5, 5, 35, 35, [254, 254, 254, 255], 2),
		});
		expect(() => assertPngContrast(invisibleWhiteOnWhite, { expectedBackground: "light" })).toThrow();

		// 2. Render dark app + light HTML5 canvas in Playwright WebKit and verify exported PNG pixels
		const context = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true });
		const page = await context.newPage();
		try {
			await page.setContent(`
				<!doctype html>
				<body style="margin:0;background:#0f172a;color:#f8fafc;">
					<canvas id="sheet" width="200" height="120"></canvas>
					<script>
						const c = document.getElementById("sheet");
						const ctx = c.getContext("2d");
						ctx.fillStyle = "#ffffff";
						ctx.fillRect(0, 0, c.width, c.height);
						ctx.strokeStyle = "#1d4ed8";
						ctx.lineWidth = 4;
						ctx.beginPath();
						ctx.moveTo(20, 90);
						ctx.lineTo(180, 25);
						ctx.stroke();
					</script>
				</body>
			`);
			const dataUrl = await page.evaluate(() => document.getElementById("sheet").toDataURL("image/png"));
			const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
			const exportedBuf = Buffer.from(base64, "base64");
			const stats = assertPngContrast(exportedBuf, {
				expectedBackground: "light",
				minStrokePixels: 100,
				minContrastRatio: 5.0,
			});
			expect(stats.width).toBe(200);
			expect(stats.height).toBe(120);
		} finally {
			await context.close();
		}

		// 2b. Verify assertTouchTargets exact-44px + ancestor opacity/offscreen/clipping/occlusion in WebKit dpr=2
		const touchCtx = await browser.newContext(viewportContextOptions("VP-MD-PORT"));
		const touchPage = await touchCtx.newPage();
		try {
			await touchPage.setContent(`
				<!doctype html>
				<html>
				<head>
					<meta name="viewport" content="width=device-width, initial-scale=1">
					<style>
						.pseudo-wrap { position: relative; width: 48px; height: 48px; }
						.pseudo-wrap::after { content: ""; position: absolute; inset: 0; z-index: 10; background: rgba(255, 0, 0, 0.5); }
					</style>
				</head>
				<body style="margin:0;position:relative;height:1180px;">
					<button id="ok" style="width:48px;height:48px;">OK</button>
					<button id="exact-44" style="width:44px;height:44px;padding:0;border:0;">44</button>
					<div style="opacity:0"><button id="ancestor-op-zero" style="width:48px;height:48px;">AOZ</button></div>
					<button id="offscreen-left" style="position:fixed;left:-200px;top:20px;width:48px;height:48px;">OL</button>
					<button id="offscreen-right" style="position:fixed;left:950px;top:20px;width:48px;height:48px;">OR</button>
					<div style="width:10px;height:10px;overflow:hidden;"><button id="clipped-overflow-10" style="width:48px;height:48px;">CO10</button></div>
					<button id="clip-path-zero" style="width:48px;height:48px;clip-path:inset(100%);">CPZ</button>
					<button id="pointer-none" style="width:48px;height:48px;pointer-events:none;">PN</button>
					<div style="position:relative;width:48px;height:48px;">
						<button id="occluded" style="width:48px;height:48px;">OCC</button>
						<div style="position:absolute;inset:0;z-index:10;background:red;"></div>
					</div>
					<button class="multi-btn" style="width:48px;height:48px;">M1</button>
					<button class="multi-btn" style="width:20px;height:20px;">M2</button>
					<button id="btn-with-span" style="width:48px;height:48px;"><span>BS</span></button>
					<div style="width:10px;height:10px;overflow:hidden;">
						<button id="fixed-in-overflow" style="position:fixed;left:400px;top:300px;width:48px;height:48px;">FIO</button>
					</div>
					<div style="width:10px;height:10px;overflow:hidden;">
						<div style="position:fixed;left:500px;top:300px;width:60px;height:60px;">
							<button id="static-inside-fixed" style="width:50px;height:50px;">SIF</button>
						</div>
					</div>
					<div style="width:10px;height:10px;overflow:hidden;transform:translateX(0);">
						<button id="fixed-inside-transform" style="position:fixed;left:0;top:0;width:48px;height:48px;">FIT</button>
					</div>
					<div style="position:relative;width:60px;height:60px;background:#fff;">
						<button id="zindex-neg-occluded" style="position:relative;z-index:-1;width:60px;height:60px;">Z-1</button>
					</div>
					<div style="position:fixed;left:200px;top:600px;width:30px;height:30px;overflow:hidden;will-change:transform;">
						<button id="fixed-inside-willchange" style="position:fixed;left:0;top:0;width:48px;height:48px;">FIWC</button>
					</div>
					<div style="position:fixed;left:300px;top:600px;width:30px;height:30px;overflow:hidden;translate:1px 0;">
						<button id="fixed-inside-translate" style="position:fixed;left:0;top:0;width:48px;height:48px;">FITR</button>
					</div>
					<div style="position:relative;width:100px;height:100px;">
						<div style="width:10px;height:10px;overflow:hidden;">
							<button id="abs-in-static-ovh10" style="position:absolute;left:20px;top:20px;width:48px;height:48px;">AISO</button>
						</div>
					</div>
					<div style="position:relative;width:10px;height:10px;overflow:hidden;">
						<button id="abs-in-rel-ovh10" style="position:absolute;left:0;top:0;width:48px;height:48px;">AIRO</button>
					</div>
					<div class="pseudo-wrap">
						<button id="pseudo-occluded" style="width:48px;height:48px;">PO</button>
					</div>
					<div style="position:fixed;left:200px;top:700px;width:30px;height:30px;overflow:hidden;container-type:inline-size;">
						<button id="fixed-in-container-type" style="position:fixed;left:0;top:0;width:48px;height:48px;">FICT</button>
					</div>
					<div style="position:relative;width:100px;height:100px;">
						<div style="position:static;width:30px;height:30px;overflow:hidden;container-type:inline-size;">
							<button id="abs-in-container-type" style="position:absolute;left:0;top:0;width:48px;height:48px;">AICT</button>
						</div>
					</div>
					<div style="position:fixed;left:300px;top:700px;width:30px;height:30px;overflow:hidden;content-visibility:auto;">
						<button id="fixed-in-content-vis" style="position:fixed;left:0;top:0;width:48px;height:48px;">FICV</button>
					</div>
					<div style="position:fixed;left:400px;top:700px;width:30px;height:30px;overflow:hidden;will-change:transform-style;">
						<button id="fixed-in-wc-transform-style" style="position:fixed;left:0;top:0;width:48px;height:48px;">FIWTS</button>
					</div>
					<div style="display:contents;width:10px;height:10px;overflow:hidden;">
						<button id="disp-contents-ovh" style="width:48px;height:48px;">DCO</button>
					</div>
					<div style="visibility:hidden;">
						<button id="vis-override" style="visibility:visible;width:48px;height:48px;">VO</button>
					</div>
				</body>
				</html>
			`);
			await expect(assertTouchTargets(touchPage, "#ok")).rejects.toThrow(TypeError);
			await assertTouchTargets(touchPage, [
				"#ok",
				"#exact-44",
				"#btn-with-span",
				"#fixed-in-overflow",
				"#static-inside-fixed",
				"#abs-in-static-ovh10",
				"#disp-contents-ovh",
				"#vis-override",
			]);
			for (const badSel of [
				"#ancestor-op-zero",
				"#offscreen-left",
				"#offscreen-right",
				"#clipped-overflow-10",
				"#clip-path-zero",
				"#pointer-none",
				"#occluded",
				".multi-btn",
				"#fixed-inside-transform",
				"#zindex-neg-occluded",
				"#fixed-inside-willchange",
				"#fixed-inside-translate",
				"#abs-in-rel-ovh10",
				"#pseudo-occluded",
				"#fixed-in-container-type",
				"#abs-in-container-type",
				"#fixed-in-content-vis",
				"#fixed-in-wc-transform-style",
				"#does-not-exist",
			]) {
				await expect(assertTouchTargets(touchPage, [badSel])).rejects.toThrow();
			}
		} finally {
			await touchCtx.close();
		}

		// 3. Verify 3-page PDF structure
		const pdf = buildSample3PagePdf();
		const pdfStr = pdf.toString("latin1");
		expect(pdfStr.startsWith("%PDF-1.4")).toBe(true);
		expect(pdfStr).toContain("/Count 3");
		expect(pdfStr).toContain("Page 1");
		expect(pdfStr).toContain("Page 2");
		expect(pdfStr).toContain("Page 3");
		expect(pdfStr.trimEnd().endsWith("%%EOF")).toBe(true);
	});

	test("Synthetic fixtures & ServerController Node 26 user-auth isolation", async () => {
		const repoDir = resolveRepoDir();
		const fixtureRoot = path.join(repoDir, "tests", "fixtures", "e2e-synthetic");

		// Verify synthetic assets & absence of intentional missing.png
		const vectorPng = fs.readFileSync(path.join(fixtureRoot, "source-files", "vector.png"));
		const stats = analyzePngPixels(vectorPng);
		expect(stats.width).toBe(160);
		expect(stats.height).toBe(120);
		expect(stats.strokePixelCount).toBeGreaterThan(50);

		const pdfBuf = fs.readFileSync(path.join(fixtureRoot, "source-files", "kinematics.pdf"));
		expect(pdfBuf.subarray(0, 8).toString("ascii")).toBe("%PDF-1.4");
		expect(fs.existsSync(path.join(fixtureRoot, "source-files", "missing.png"))).toBe(false);

		// Verify ServerController isolated temp state & Node 26 user-auth.mjs CLI
		const ctrl = new ServerController({ id: "selfcheck" });
		try {
			ctrl.seedSyntheticProfile(fixtureRoot, { mockBaseUrl: "http://127.0.0.1:4555/v1/" });
			const seededSettings = JSON.parse(fs.readFileSync(path.join(ctrl.dataDir, "settings.json"), "utf8"));
			expect(seededSettings.customProvider.baseUrl).toBe("http://127.0.0.1:4555/v1");
			expect(seededSettings.customProvider.credentialBindingId).toMatch(/^[a-f0-9]{32}$/);

			const authStat = fs.statSync(ctrl.authFile);
			expect(authStat.mode & 0o777).toBe(0o600);
			const seededAuth = JSON.parse(fs.readFileSync(ctrl.authFile, "utf8"));
			const binding = JSON.parse(seededAuth.__learnharness_custom_provider_binding);
			expect(binding).toEqual({
				version: 1,
				id: seededSettings.customProvider.credentialBindingId,
				baseUrl: "http://127.0.0.1:4555/v1",
				authMode: "keyless",
			});

			await ctrl.initAuth({ username: "synthlearner", password: "SynthPassword123!" });
			const status = await ctrl.authStatus();
			expect(status.code).toBe(0);
			expect(status.parsed.configured).toBe(true);
			expect(status.parsed.username).toBe("synthlearner");
			expect(status.parsed.mode).toBe("0600");

			await ctrl.resetPassword({ password: "UpdatedPassword456!" });
			const statusAfter = await ctrl.authStatus();
			expect(statusAfter.parsed.configured).toBe(true);
			expect(statusAfter.parsed.username).toBe("synthlearner");
		} finally {
			await ctrl.cleanup();
		}

		// Verify omitted mockBaseUrl binds settings.customProvider.baseUrl cleanly
		const ctrlOmitted = new ServerController({ id: "selfcheck-omitted" });
		try {
			ctrlOmitted.seedSyntheticProfile(fixtureRoot);
			const omittedSettings = JSON.parse(fs.readFileSync(path.join(ctrlOmitted.dataDir, "settings.json"), "utf8"));
			expect(omittedSettings.customProvider.baseUrl).toBe("http://127.0.0.1:4000/v1");
			expect(omittedSettings.customProvider.authMode).toBe("keyless");
			expect(omittedSettings.customProvider.credentialBindingId).toMatch(/^[a-f0-9]{32}$/);
			expect(fs.statSync(ctrlOmitted.authFile).mode & 0o777).toBe(0o600);
			const omittedBinding = JSON.parse(
				JSON.parse(fs.readFileSync(ctrlOmitted.authFile, "utf8")).__learnharness_custom_provider_binding,
			);
			expect(omittedBinding).toEqual({
				version: 1,
				id: omittedSettings.customProvider.credentialBindingId,
				baseUrl: "http://127.0.0.1:4000/v1",
				authMode: "keyless",
			});
		} finally {
			await ctrlOmitted.cleanup();
		}

		// Verify apiKey mode persists CUSTOM_OPENAI_API_KEY and sets fileKeyBaseUrl in binding
		const apiFixtureDir = fs.mkdtempSync("/tmp/lh-selfcheck-apikey-fix-");
		const ctrlApi = new ServerController({ id: "selfcheck-apikey" });
		try {
			fs.cpSync(fixtureRoot, apiFixtureDir, { recursive: true });
			const apiFixSettingsPath = path.join(apiFixtureDir, "settings.json");
			const apiFixSettings = JSON.parse(fs.readFileSync(apiFixSettingsPath, "utf8"));
			apiFixSettings.customProvider.authMode = "apiKey";
			fs.writeFileSync(apiFixSettingsPath, JSON.stringify(apiFixSettings, null, "\t"), "utf8");

			ctrlApi.seedSyntheticProfile(apiFixtureDir, {
				mockBaseUrl: "http://127.0.0.1:4556/v1/",
				apiKey: "sk-selfcheck-key-123",
			});
			const apiSettings = JSON.parse(fs.readFileSync(path.join(ctrlApi.dataDir, "settings.json"), "utf8"));
			expect(apiSettings.customProvider.authMode).toBe("apiKey");
			expect(apiSettings.customProvider.baseUrl).toBe("http://127.0.0.1:4556/v1");
			expect(fs.statSync(ctrlApi.authFile).mode & 0o777).toBe(0o600);

			const apiAuth = JSON.parse(fs.readFileSync(ctrlApi.authFile, "utf8"));
			expect(apiAuth.CUSTOM_OPENAI_API_KEY).toBe("sk-selfcheck-key-123");
			const apiBinding = JSON.parse(apiAuth.__learnharness_custom_provider_binding);
			expect(apiBinding).toEqual({
				version: 1,
				id: apiSettings.customProvider.credentialBindingId,
				baseUrl: "http://127.0.0.1:4556/v1",
				authMode: "apiKey",
				fileKeyBaseUrl: "http://127.0.0.1:4556/v1",
			});

			// Reject invalid baseUrl & malformed auth.json
			expect(() => ctrlApi.seedSyntheticProfile(apiFixtureDir, { mockBaseUrl: "http://127.0.0.1:4556/v1?x=1" })).toThrow();
			expect(() => ctrlApi.seedSyntheticProfile(apiFixtureDir, { mockBaseUrl: "ftp://127.0.0.1:4556/v1" })).toThrow();
			fs.writeFileSync(ctrlApi.authFile, "{malformed", { mode: 0o600 });
			expect(() => ctrlApi.seedSyntheticProfile(apiFixtureDir, { mockBaseUrl: "http://127.0.0.1:4556/v1" })).toThrow();
		} finally {
			await ctrlApi.cleanup();
			fs.rmSync(apiFixtureDir, { recursive: true, force: true });
		}
	});
});
