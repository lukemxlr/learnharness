import { spawn } from "node:child_process";
import { createHash, createVerify, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startMockProvider } from "../harness/mock-provider.mjs";
import { getFreePort, resolveRepoDir, ServerController } from "../harness/server-controller.mjs";
import { loginApi, loginBrowser } from "../helpers/auth.mjs";
import {
	assertNoHorizontalOverflow,
	assertPopoversInViewport,
	assertTouchTargets,
	viewportContextOptions,
} from "../helpers/e2e-session.mjs";
import {
	analyzePngPixels,
	assertPngContrast,
	buildPng,
	buildSample3PagePdf,
	createVectorDiagramPng,
} from "../helpers/test-assets.mjs";

function buildStair350Html() {
	const stair350 = [];
	for (let x = 9; x < 340; x += 28) {
		stair350.push(`<div style="position:absolute;left:${x}px;top:0;width:10px;height:350px;z-index:10;"></div>`);
	}
	for (let k = 0; k < 4; k++) {
		stair350.push(`<div style="position:absolute;left:${270 + k * 14}px;top:${k * 14}px;width:14px;height:14px;z-index:10;"></div>`);
	}
	return stair350.join("");
}

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

			// 5b. Multi-turn & dynamic tool schema regression checks
			const probeMcRes = await fetch(`${mock.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-test-1",
					stream: false,
					tools: [
						{
							type: "function",
							function: {
								name: "probe",
								parameters: { properties: { question: {}, options: {}, explanation: {}, correctAnswer: {} } },
							},
						},
					],
					messages: [{ role: "user", content: "[TRIGGER_MC]" }],
				}),
			});
			const probeMcData = await probeMcRes.json();
			const probeCall = probeMcData.choices[0].message.tool_calls[0];
			expect(probeCall.function.name).toBe("probe");
			const probeArgs = JSON.parse(probeCall.function.arguments);
			expect(probeArgs.nodeId).toBeUndefined();
			expect(probeArgs.type).toBeUndefined();

			// Turn 2 [ECHO_VISION] after Turn 1 [TRIGGER_MC] (must NOT re-trigger MC)
			const multiVisionRes = await fetch(`${mock.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-test-1",
					stream: false,
					messages: [
						{ role: "user", content: "[TRIGGER_MC]" },
						{ role: "assistant", content: null, tool_calls: [probeCall] },
						{
							role: "tool",
							tool_call_id: probeCall.id,
							content: [
								{ type: "text", text: JSON.stringify({ kind: "quiz", thinking: "[ECHO_VISION] apex" }) },
								{ type: "text", text: "Answer images:" },
								{ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
							],
						},
					],
				}),
			});
			const multiVisionData = await multiVisionRes.json();
			expect(multiVisionData.choices[0].finish_reason).toBe("stop");
			expect(multiVisionData.choices[0].message.content).toContain(`VISION_ECHO count=1 bytes=${png.byteLength} sha256=${expectedShaPrefix}`);

			// Turn 1 [TRIGGER_FREE] with "recall" tool -> Turn 2 plain answer
			const recallRes = await fetch(`${mock.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-test-1",
					stream: false,
					tools: [
						{
							type: "function",
							function: {
								name: "recall",
								parameters: { properties: { question: {}, correctAnswer: {} } },
							},
						},
						{
							type: "function",
							function: {
								name: "ask_user_question",
								parameters: { properties: { question: {}, details: {} } },
							},
						},
					],
					messages: [{ role: "user", content: "[TRIGGER_FREE]" }],
				}),
			});
			const recallData = await recallRes.json();
			const recallCall = recallData.choices[0].message.tool_calls[0];
			expect(recallCall.function.name).toBe("recall");
			const recallArgs = JSON.parse(recallCall.function.arguments);
			expect(recallArgs.nodeId).toBeUndefined();
			expect(recallArgs.type).toBeUndefined();

			const turn2FreeRes = await fetch(`${mock.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-test-1",
					stream: false,
					tools: [
						{
							type: "function",
							function: {
								name: "recall",
								parameters: { properties: { question: {}, correctAnswer: {} } },
							},
						},
					],
					messages: [
						{ role: "user", content: "[TRIGGER_FREE]" },
						{ role: "assistant", content: null, tool_calls: [recallCall] },
						{ role: "tool", tool_call_id: recallCall.id, content: "Q1 completed text answer" },
					],
				}),
			});
			const turn2FreeData = await turn2FreeRes.json();
			expect(turn2FreeData.choices[0].finish_reason).toBe("stop");
			expect(turn2FreeData.choices[0].message.content).toContain("Synthetic tutor response");
			expect(turn2FreeData.choices[0].message.content).toContain("Q1 completed text answer");

			// 5c. A4: Split role:"tool" text + trailing role:"user" image after Turn 1 [TRIGGER_MC]
			const a4Res = await fetch(`${mock.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-test-1",
					stream: false,
					messages: [
						{ role: "user", content: "[TRIGGER_MC]" },
						{ role: "assistant", content: null, tool_calls: [probeCall] },
						{
							role: "tool",
							tool_call_id: probeCall.id,
							content: `${JSON.stringify({ kind: "quiz", thinking: "[ECHO_VISION] apex" })}\nAnswer images:`,
						},
						{
							role: "user",
							content: [
								{ type: "text", text: "Attached image(s) from tool result:" },
								{ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
							],
						},
					],
				}),
			});
			const a4Data = await a4Res.json();
			expect(a4Data.choices[0].finish_reason).toBe("stop");
			expect(a4Data.choices[0].message.content).toContain(`VISION_ECHO count=1 bytes=${png.byteLength} sha256=${expectedShaPrefix}`);

			// 5d. A4b: Consecutive user messages (text then image-only user message)
			const a4bRes = await fetch(`${mock.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-test-1",
					stream: false,
					messages: [
						{ role: "user", content: "[ECHO_VISION] look at attached" },
						{
							role: "user",
							content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } }],
						},
					],
				}),
			});
			const a4bData = await a4bRes.json();
			expect(a4bData.choices[0].finish_reason).toBe("stop");
			expect(a4bData.choices[0].message.content).toContain(`VISION_ECHO count=1 bytes=${png.byteLength} sha256=${expectedShaPrefix}`);

			// 5e. C4: /v1/responses namespaced tools resolution
			const c4Res = await fetch(`${mock.baseUrl}/responses`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-test-1",
					stream: false,
					tools: [
						{
							type: "namespace",
							name: "learnharness",
							tools: [
								{
									type: "function",
									name: "probe",
									parameters: { properties: { question: {}, options: {} } },
								},
							],
						},
					],
					input: [{ role: "user", content: "[TRIGGER_MC]" }],
				}),
			});
			const c4Data = await c4Res.json();
			expect(c4Data.output[0].type).toBe("function_call");
			expect(c4Data.output[0].name).toBe("probe");
			const c4Args = JSON.parse(c4Data.output[0].arguments);
			expect(c4Args.nodeId).toBeUndefined();
			expect(c4Args.type).toBeUndefined();

			// 5f. Multi-turn [ECHO_VISION] & ledger.requests[].images isolation + /v1/responses input_image { url }
			await mock.clearRequests();
			const png2 = buildPng({
				width: 24,
				height: 24,
				background: [255, 255, 255, 255],
				draw: ({ drawLine }) => drawLine(2, 2, 20, 20, [0, 0, 0, 255], 2),
			});
			const sha1 = expectedShaPrefix;
			const sha2 = createHash("sha256").update(png2).digest("hex").slice(0, 12);

			// Chat Completions: Turn 1 image must NOT bleed into Turn 2 with 0 images
			const mtZeroRes = await fetch(`${mock.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-test-1",
					stream: false,
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: "Turn 1" },
								{ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
							],
						},
						{ role: "assistant", content: "Noted Turn 1." },
						{ role: "user", content: "[ECHO_VISION] Turn 2 no image" },
					],
				}),
			});
			const mtZeroData = await mtZeroRes.json();
			expect(mtZeroData.choices[0].message.content).toBe("[VISION_ECHO count=0 bytes=0 sha256=none]");

			// Chat Completions: Turn 1 image must NOT bleed into Turn 2 with 1 new image
			const mtNewRes = await fetch(`${mock.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-test-1",
					stream: false,
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: "Turn 1" },
								{ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
							],
						},
						{ role: "assistant", content: "Noted Turn 1." },
						{
							role: "user",
							content: [
								{ type: "text", text: "[ECHO_VISION] Turn 2 new image" },
								{ type: "image_url", image_url: { url: `data:image/png;base64,${png2.toString("base64")}` } },
							],
						},
					],
				}),
			});
			const mtNewData = await mtNewRes.json();
			expect(mtNewData.choices[0].message.content).toBe(
				`[VISION_ECHO count=1 bytes=${png2.byteLength} sha256=${sha2}]`,
			);

			// /v1/responses: function_call boundary + function_call_output + { type: "input_image", image_url: { url } }
			const respMtRes = await fetch(`${mock.baseUrl}/responses`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-test-1",
					stream: false,
					input: [
						{
							role: "user",
							content: [
								{ type: "input_text", text: "Turn 1" },
								{ type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` },
							],
						},
						{ type: "function_call", call_id: "call_1", name: "probe", arguments: "{}" },
						{
							type: "function_call_output",
							call_id: "call_1",
							output: [
								{ type: "input_text", text: "[ECHO_VISION] Turn 2 object url" },
								{ type: "input_image", image_url: { url: `data:image/png;base64,${png2.toString("base64")}` } },
							],
						},
					],
				}),
			});
			const respMtData = await respMtRes.json();
			expect(respMtData.output[0].content[0].text).toBe(
				`[VISION_ECHO count=1 bytes=${png2.byteLength} sha256=${sha2}]`,
			);
			expect(respMtData.output[0].content[0].text).not.toContain(sha1);

			const mtLedger = await mock.getRequests();
			expect(mtLedger.requests[0].images).toHaveLength(0);
			expect(mtLedger.requests[0].allImages).toHaveLength(1);
			expect(mtLedger.requests[1].images).toHaveLength(1);
			expect(mtLedger.requests[1].allImages).toHaveLength(2);
			expect(mtLedger.requests[2].images).toHaveLength(1);
			expect(mtLedger.requests[2].allImages).toHaveLength(2);
			await mock.clearRequests();

			// 6. Mock OAuth PKCE + RS256 id_token verification (including /api/accounts/* & /.well-known/jwks.json parity)
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
						redirect_uri: "http://127.0.0.1:1455/auth/callback",
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

			// 6b. Verify /api/accounts/authorize, /api/accounts/oauth/token, /.well-known/jwks.json, dynamic client_id & nonce echo
			const aliasVerifier = randomBytes(32).toString("base64url");
			const aliasChallenge = createHash("sha256").update(aliasVerifier).digest("base64url");
			const aliasAuthUrl = new URL(`${mock.origin}/api/accounts/authorize`);
			aliasAuthUrl.searchParams.set("client_id", "dynamic_agent_client");
			aliasAuthUrl.searchParams.set("redirect_uri", "http://127.0.0.1:1455/auth/callback");
			aliasAuthUrl.searchParams.set("state", "state_alias_01");
			aliasAuthUrl.searchParams.set("nonce", "nonce_alias_01");
			aliasAuthUrl.searchParams.set("code_challenge", aliasChallenge);
			aliasAuthUrl.searchParams.set("code_challenge_method", "S256");
			aliasAuthUrl.searchParams.set("mode", "json");
			const aliasAuthResp = await (await fetch(aliasAuthUrl)).json();
			const aliasCb = new URL(aliasAuthResp.callbackUrl);
			const issuedClientId = aliasCb.searchParams.get("client_id");
			expect(issuedClientId).toBeTruthy();
			expect(issuedClientId).not.toBe("dynamic_agent_client");

			const aliasTokenResp = await (
				await fetch(`${mock.origin}/api/accounts/oauth/token`, {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						grant_type: "authorization_code",
						code: aliasAuthResp.code,
						code_verifier: aliasVerifier,
						client_id: issuedClientId,
						redirect_uri: "http://127.0.0.1:1455/auth/callback",
					}),
				})
			).json();
			expect(aliasTokenResp.access_token).toMatch(/^mock_at_/);
			const aliasJwks = await (await fetch(`${mock.origin}/.well-known/jwks.json`)).json();
			const [aHdr, aPay, aSig] = aliasTokenResp.id_token.split(".");
			const aVerify = createVerify("RSA-SHA256");
			aVerify.update(`${aHdr}.${aPay}`);
			expect(aVerify.verify({ key: aliasJwks.keys[0], format: "jwk" }, aSig, "base64url")).toBe(true);
			const decodedPayload = JSON.parse(Buffer.from(aPay, "base64url").toString("utf8"));
			expect(decodedPayload.nonce).toBe("nonce_alias_01");
			expect(decodedPayload.aud).toBe(issuedClientId);
			expect(decodedPayload.iss).toBe(oidc.issuer);

			// 6c. OAuth malformed redirect_uri -> 400, required token fields, refresh client_id & issuer parity
			const badRedirectRes = await fetch(
				`${mock.origin}/__oauth/authorize?client_id=learnharness-test&redirect_uri=not-a-valid-url&state=s1&code_challenge=${challenge}&code_challenge_method=S256`,
			);
			expect(badRedirectRes.status).toBe(400);
			const badRedirectBody = await badRedirectRes.json();
			expect(badRedirectBody.error).toBe("invalid_request");

			const wrongClientRefreshRes = await fetch(oidc.token_endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: tokenResp.refresh_token,
					client_id: "wrong-client-id",
				}),
			});
			expect(wrongClientRefreshRes.status).toBe(400);

			// 6d. Iteration 15 regressions: parseDataUrl extra params, malformed JSON 400, /v1/responses midStreamAbort, refresh_token auth claim, mock.close() active SSE
			const paramVisionRes = await fetch(`${mock.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-test-1",
					stream: false,
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: "[ECHO_VISION] extra data url params" },
								{
									type: "image_url",
									image_url: { url: `data:image/png;name=test.png;base64,${png.toString("base64")}` },
								},
							],
						},
					],
				}),
			});
			expect(paramVisionRes.status).toBe(200);
			const paramVisionData = await paramVisionRes.json();
			expect(paramVisionData.choices[0].message.content).toContain(
				`[VISION_ECHO count=1 bytes=${png.byteLength} sha256=${expectedShaPrefix}]`,
			);

			const badJsonTokenRes = await fetch(oidc.token_endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{bad-json",
			});
			expect(badJsonTokenRes.status).toBe(400);
			const badJsonTokenBody = await badJsonTokenRes.json();
			expect(badJsonTokenBody.error).toBe("invalid_request");

			await mock.admin({ failNextTurn: { midStreamAbort: true } });
			const abortResp = await fetch(`${mock.baseUrl}/responses`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "gpt-test-1", stream: true, input: "abort check" }),
			});
			expect(abortResp.status).toBe(200);
			const abortReader = abortResp.body.getReader();
			let partialAbortText = "";
			let abortThrew = false;
			try {
				while (true) {
					const { done, value } = await abortReader.read();
					if (done) break;
					partialAbortText += Buffer.from(value).toString("utf8");
				}
			} catch {
				abortThrew = true;
			}
			expect(abortThrew).toBe(true);
			expect(partialAbortText).toContain("event: response.created");
			expect(partialAbortText).not.toContain("chat.completion.chunk");

			const okRefreshRes = await fetch(oidc.token_endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: tokenResp.refresh_token,
					client_id: "learnharness-test",
				}),
			});
			expect(okRefreshRes.status).toBe(200);
			const okRefreshBody = await okRefreshRes.json();
			const [, refreshPayB64] = okRefreshBody.id_token.split(".");
			const refreshPayload = JSON.parse(Buffer.from(refreshPayB64, "base64url").toString("utf8"));
			expect(refreshPayload["https://api.openai.com/auth"]).toEqual({
				chatgpt_plan_type: "plus",
				chatgpt_account_id: "acct_synth_01",
			});

			await mock.admin({ chunkDelayMs: 200 });
			const activeSseRes = await fetch(`${mock.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-test-1",
					stream: true,
					messages: [{ role: "user", content: "[STREAM_LONG]" }],
				}),
			});
			expect(activeSseRes.status).toBe(200);
			const sseReader = activeSseRes.body.getReader();
			const firstSseChunk = await sseReader.read();
			expect(firstSseChunk.done).toBe(false);
			const tCloseStart = Date.now();
			await Promise.race([
				mock.close(),
				new Promise((_, reject) => setTimeout(() => reject(new Error("mock.close() hung on active SSE")), 1000)),
			]);
			expect(Date.now() - tCloseStart).toBeLessThan(1000);
			await sseReader.cancel().catch(() => {});
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

	test("DOM geometry 4a: core touch targets, clipping, opacity, and occlusion in WebKit", async ({ browser }) => {
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
					<button id="calc-ok" style="width:48px;height:48px;clip-path:inset(0px calc(0% + 1px));">COK</button>
					<button id="circle-44" style="width:44px;height:44px;border-radius:50%;padding:0;border:0;">C44</button>
					<div style="position:fixed;left:160px;top:450px;width:30px;height:30px;overflow:hidden;will-change:container-type;">
						<button id="wc-ct-escaped" style="position:fixed;left:560px;top:450px;width:48px;height:48px;">WCTE</button>
					</div>
					<div style="position:fixed;left:220px;top:450px;width:30px;height:30px;overflow:hidden;will-change:content-visibility;">
						<button id="wc-cv-escaped" style="position:fixed;left:620px;top:450px;width:48px;height:48px;">WCVE</button>
					</div>
					<button id="cp-inset-calc" style="width:48px;height:48px;clip-path:inset(0px calc(50% - 5px));">CIC</button>
					<button id="cp-xywh-20" style="width:48px;height:48px;clip-path:xywh(14px 14px 20px 20px);">CXY</button>
					<div style="position:relative;width:48px;height:48px;">
						<button id="partial-occ-left24" style="width:48px;height:48px;">POL</button>
						<div style="position:absolute;left:0;top:0;width:23px;height:48px;z-index:10;background:red;"></div>
					</div>
					<div style="position:relative;width:200px;height:48px;">
						<button id="partial-occ-top20" style="width:200px;height:48px;">POT</button>
						<div style="position:absolute;left:0;top:0;width:200px;height:20px;z-index:10;background:red;"></div>
					</div>
					<div style="position:relative;width:100px;height:48px;">
						<button id="partial-occ-sandwich" style="width:100px;height:48px;">POS</button>
						<div style="position:absolute;left:0;top:0;width:40px;height:48px;z-index:10;background:red;"></div>
						<div style="position:absolute;right:0;top:0;width:40px;height:48px;z-index:10;background:red;"></div>
					</div>
					<button id="cp-circle10-center" style="width:48px;height:48px;clip-path:circle(10px at 50% 50%);">CC10</button>
					<button id="cp-ellipse-10" style="width:48px;height:48px;clip-path:ellipse(10px 10px at 50% 50%);">CE10</button>
					<button id="cp-poly-20" style="width:48px;height:48px;clip-path:polygon(14px 14px, 34px 14px, 34px 34px, 14px 34px);">CP20</button>
					<div style="width:70px;height:70px;box-sizing:border-box;border:15px solid #0f0;overflow:hidden;">
						<button id="border-clipped-40" style="width:48px;height:48px;">BC40</button>
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
				"#calc-ok",
				"#circle-44",
				"#wc-ct-escaped",
				"#wc-cv-escaped",
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
				"#cp-inset-calc",
				"#cp-xywh-20",
				"#partial-occ-left24",
				"#partial-occ-top20",
				"#partial-occ-sandwich",
				"#cp-circle10-center",
				"#cp-ellipse-10",
				"#cp-poly-20",
				"#border-clipped-40",
				"#does-not-exist",
			]) {
				await expect(assertTouchTargets(touchPage, [badSel])).rejects.toThrow();
			}
		} finally {
			await touchCtx.close();
		}
	});

	test("DOM geometry 4b: Iter 10-12 clip-path, tie-break, hairline dots, and stair perf regressions", async ({ browser }) => {
		const touchCtx = await browser.newContext(viewportContextOptions("VP-MD-PORT"));
		const touchPage = await touchCtx.newPage();
		try {
			// 2b-ii. Positive & negative Iteration 10 geometry/occlusion regressions in WebKit 18.0
			await touchPage.setContent(`
				<!doctype html>
				<html>
				<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
				<body style="margin:0;display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;">
					<button id="cp-circle-24" style="width:48px;height:48px;clip-path:circle(24px at 50% 50%);padding:0;border:0;">C24</button>
					<button id="cp-circle-pct-ok" style="width:64px;height:64px;clip-path:circle(45% at 50% 50%);padding:0;border:0;">CPCT</button>
					<button id="cp-ellipse-ok" style="width:60px;height:60px;clip-path:ellipse(24px 24px at 50% 50%);padding:0;border:0;">ELOK</button>
					<button id="cp-xywh-ok" style="width:64px;height:64px;clip-path:xywh(8px 8px 44px 44px);padding:0;border:0;">XYOK</button>
					<button id="cp-poly-ok" style="width:60px;height:60px;clip-path:polygon(4px 4px, 52px 4px, 52px 52px, 4px 52px);padding:0;border:0;">PLOK</button>
					<div style="position:relative;width:200px;height:44px;">
						<button id="wide-right-ok" style="width:200px;height:44px;padding:0;border:0;">WRO</button>
						<div style="position:absolute;left:0;top:0;width:100px;height:30px;z-index:10;background:red;"></div>
					</div>
					<div style="position:relative;width:100px;height:100px;">
						<button id="scaled-down-clip-ok" style="width:200px;height:200px;transform:scale(0.5);transform-origin:0 0;clip-path:inset(40px);padding:0;border:0;">SDCO</button>
					</div>
					<div style="position:relative;width:100px;height:100px;">
						<button id="donut-50" style="width:100px;height:100px;padding:0;border:0;">D50</button>
						<div style="position:absolute;left:25px;top:25px;width:50px;height:50px;z-index:10;background:red;"></div>
					</div>
					<button id="poly-c-frame" style="width:100px;height:100px;clip-path:polygon(0px 0px, 100px 0px, 100px 100px, 0px 100px, 0px 25px, 25px 25px, 25px 75px, 75px 75px, 75px 25px, 0px 25px);padding:0;border:0;">PCF</button>
					<div style="position:relative;width:48px;height:48px;">
						<button id="hairline-2px" style="width:48px;height:48px;padding:0;border:0;">HL2</button>
						<div style="position:absolute;left:0;top:21px;width:48px;height:2px;z-index:10;background:red;"></div>
					</div>
					<div style="position:relative;width:48px;height:48px;">
						<button id="center-badge-occ" style="width:48px;height:48px;padding:0;border:0;">CBO</button>
						<div style="position:absolute;left:9px;top:9px;width:30px;height:30px;z-index:10;background:red;"></div>
					</div>
					<button id="cp-inset-content-box" style="width:48px;height:48px;padding:10px;box-sizing:border-box;border:0;clip-path:inset(0px) content-box;">CBX</button>
				</body>
				</html>
			`);
			await assertTouchTargets(touchPage, [
				"#cp-circle-24",
				"#cp-circle-pct-ok",
				"#cp-ellipse-ok",
				"#cp-xywh-ok",
				"#cp-poly-ok",
				"#wide-right-ok",
				"#scaled-down-clip-ok",
			]);
			for (const badSel of [
				"#donut-50",
				"#poly-c-frame",
				"#hairline-2px",
				"#center-badge-occ",
				"#cp-inset-content-box",
			]) {
				await expect(assertTouchTargets(touchPage, [badSel])).rejects.toThrow();
			}

			// 2b-iii. Iteration 11 geometry/occlusion regressions (considerCand tie-break, dense core/hairline, rounded active circle)
			await touchPage.setContent(`
				<!doctype html>
				<html>
				<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
				<body style="margin:0;display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;">
					<div style="position:relative;width:100px;height:100px;">
						<button id="cand-tie-int46" style="width:100px;height:100px;padding:0;border:0;">TI46</button>
						<div style="position:absolute;left:43px;top:0;width:11px;height:100px;z-index:10;background:red;"></div>
						<div style="position:absolute;left:0;top:90px;width:43px;height:10px;z-index:10;background:red;"></div>
						<div style="position:absolute;left:54px;top:46px;width:46px;height:54px;z-index:10;background:red;"></div>
					</div>
					<div style="position:relative;width:100px;height:100px;">
						<button id="cand-tie-valid" style="width:100px;height:100px;padding:0;border:0;">TV45</button>
						<div style="position:absolute;left:42.5px;top:0;width:12px;height:100px;z-index:10;background:red;"></div>
						<div style="position:absolute;left:0;top:90px;width:42.5px;height:10px;z-index:10;background:red;"></div>
						<div style="position:absolute;left:54.5px;top:45.5px;width:45.5px;height:54.5px;z-index:10;background:red;"></div>
					</div>
					<div style="position:relative;width:100px;height:100px;">
						<button id="cand-tie-445" style="width:100px;height:100px;padding:0;border:0;">TV445</button>
						<div style="position:absolute;left:43.2px;top:0;width:11.8px;height:100px;z-index:10;background:red;"></div>
						<div style="position:absolute;left:0;top:90px;width:43.2px;height:10px;z-index:10;background:red;"></div>
						<div style="position:absolute;left:55px;top:44.6px;width:45px;height:55.4px;z-index:10;background:red;"></div>
					</div>
					<div style="position:relative;width:100px;height:100px;">
						<button id="cand-tie-bad" style="width:100px;height:100px;padding:0;border:0;">TIBAD</button>
						<div style="position:absolute;left:43px;top:0;width:14px;height:100px;z-index:10;background:red;"></div>
						<div style="position:absolute;left:0;top:90px;width:43px;height:10px;z-index:10;background:red;"></div>
						<div style="position:absolute;left:57px;top:43px;width:43px;height:57px;z-index:10;background:red;"></div>
					</div>
					<div style="position:relative;width:60px;height:60px;">
						<button id="circle60-left15-ok" style="width:60px;height:60px;border-radius:50%;padding:0;border:0;">C60</button>
						<div style="position:absolute;left:0;top:0;width:15px;height:60px;z-index:10;background:red;"></div>
					</div>
					<div style="position:relative;width:80px;height:80px;">
						<button id="circle80-split40-bad" style="width:80px;height:80px;border-radius:50%;padding:0;border:0;">C80B</button>
						<div style="position:absolute;left:0;top:0;width:40px;height:80px;z-index:10;background:red;"></div>
					</div>
					<div style="position:relative;width:60px;height:60px;">
						<button id="rounded-4dots-bad" style="width:60px;height:60px;border-radius:6px;padding:0;border:0;">R4D</button>
						<div style="position:absolute;left:23px;top:23px;width:6px;height:6px;z-index:10;background:red;"></div>
						<div style="position:absolute;left:31px;top:23px;width:6px;height:6px;z-index:10;background:red;"></div>
						<div style="position:absolute;left:23px;top:31px;width:6px;height:6px;z-index:10;background:red;"></div>
						<div style="position:absolute;left:31px;top:31px;width:6px;height:6px;z-index:10;background:red;"></div>
					</div>
					<div style="position:relative;width:86px;height:86px;">
						<button id="hairline-4dots-bad" style="width:86px;height:86px;padding:0;border:0;">H4D</button>
						<div style="position:absolute;left:35px;top:35px;width:2px;height:2px;z-index:10;background:red;"></div>
						<div style="position:absolute;left:49px;top:35px;width:2px;height:2px;z-index:10;background:red;"></div>
						<div style="position:absolute;left:35px;top:49px;width:2px;height:2px;z-index:10;background:red;"></div>
						<div style="position:absolute;left:49px;top:49px;width:2px;height:2px;z-index:10;background:red;"></div>
					</div>
					<div style="position:relative;width:100px;height:100px;">
						<button id="donut-40" style="width:100px;height:100px;padding:0;border:0;">D40</button>
						<div style="position:absolute;left:30px;top:30px;width:40px;height:40px;z-index:10;background:red;"></div>
					</div>
				</body>
				</html>
			`);
			await assertTouchTargets(touchPage, [
				"#cand-tie-int46",
				"#cand-tie-valid",
				"#cand-tie-445",
				"#circle60-left15-ok",
			]);
			for (const badSel of [
				"#cand-tie-bad",
				"#circle80-split40-bad",
				"#rounded-4dots-bad",
				"#hairline-4dots-bad",
				"#donut-40",
			]) {
				await expect(assertTouchTargets(touchPage, [badSel])).rejects.toThrow();
			}

			// 2b-iv. Iteration 12 geometry/occlusion/perf regressions (candMap >48, 2D staggered dots, off-center circle, <5s large stair, 1x1 dots)
			const blockers56 = [
				`<div style="position:absolute;left:0;top:630px;width:750px;height:16px;z-index:10;"></div>`,
				`<div style="position:absolute;left:0;top:646px;width:646px;height:104px;z-index:10;"></div>`,
				`<div style="position:absolute;left:692px;top:646px;width:58px;height:104px;z-index:10;"></div>`,
				`<div style="position:absolute;left:646px;top:692px;width:46px;height:58px;z-index:10;"></div>`,
				`<div style="position:absolute;left:720px;top:0;width:30px;height:630px;z-index:10;"></div>`,
			];
			for (let cx = 0; cx < 8; cx++) {
				const xStart = 14 + cx * 90;
				if (cx === 0) blockers56.push(`<div style="position:absolute;left:0;top:0;width:14px;height:630px;z-index:10;"></div>`);
				blockers56.push(`<div style="position:absolute;left:${xStart + 43}px;top:0;width:47px;height:630px;z-index:10;"></div>`);
			}
			for (let ry = 0; ry < 7; ry++) {
				const yStart = 14 + ry * 90;
				if (ry === 0) blockers56.push(`<div style="position:absolute;left:0;top:0;width:750px;height:14px;z-index:10;"></div>`);
				blockers56.push(`<div style="position:absolute;left:0;top:${yStart + 43}px;width:750px;height:47px;z-index:10;"></div>`);
			}
			await touchPage.setContent(`<!doctype html><html><body style="margin:0;">
				<div style="position:relative;width:750px;height:750px;">
					<button id="cand-gt48-56strips-ok" style="width:750px;height:750px;padding:0;border:0;">G56</button>
					${blockers56.join("")}
				</div>
			</body></html>`);
			await assertTouchTargets(touchPage, ["#cand-gt48-56strips-ok"]);

			const staggeredDots = [[23, 23], [47, 27], [71, 31], [27, 47], [51, 51], [75, 55], [31, 71], [55, 75], [79, 79]]
				.map(([x, y]) => `<div style="position:absolute;left:${x}px;top:${y}px;width:2px;height:2px;z-index:10;"></div>`)
				.join("");
			const stairHtml = buildStair350Html();
			await touchPage.setContent(`<!doctype html><html><body style="margin:0;display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;">
				<div style="position:relative;width:94px;height:94px;">
					<button id="circle94-left48-ok" style="width:94px;height:94px;border-radius:50%;padding:0;border:0;">C94</button>
					<div style="position:absolute;left:0;top:0;width:48px;height:94px;z-index:10;"></div>
				</div>
				<div style="position:relative;width:100px;height:100px;">
					<button id="hairline-staggered-9dots-bad" style="width:100px;height:100px;padding:0;border:0;">S9</button>
					${staggeredDots}
				</div>
				<div style="position:relative;width:86px;height:86px;">
					<button id="hairline-4dots-1px-bad" style="width:86px;height:86px;padding:0;border:0;">H1PX</button>
					<div style="position:absolute;left:36px;top:36px;width:1px;height:1px;z-index:10;"></div>
					<div style="position:absolute;left:49px;top:36px;width:1px;height:1px;z-index:10;"></div>
					<div style="position:absolute;left:36px;top:49px;width:1px;height:1px;z-index:10;"></div>
					<div style="position:absolute;left:49px;top:49px;width:1px;height:1px;z-index:10;"></div>
				</div>
				<div style="position:relative;width:60px;height:60px;">
					<button id="rounded-4dots-1px-bad" style="width:60px;height:60px;border-radius:6px;padding:0;border:0;">R1PX</button>
					<div style="position:absolute;left:24px;top:24px;width:1px;height:1px;z-index:10;"></div>
					<div style="position:absolute;left:35px;top:24px;width:1px;height:1px;z-index:10;"></div>
					<div style="position:absolute;left:24px;top:35px;width:1px;height:1px;z-index:10;"></div>
					<div style="position:absolute;left:35px;top:35px;width:1px;height:1px;z-index:10;"></div>
				</div>
				<div style="position:relative;width:350px;height:350px;">
					<button id="perf-350-stair" style="width:350px;height:350px;padding:0;border:0;">P350</button>
					${stairHtml}
				</div>
			</body></html>`);
			await assertTouchTargets(touchPage, ["#circle94-left48-ok"]);
			for (const badSel of [
				"#hairline-staggered-9dots-bad",
				"#hairline-4dots-1px-bad",
				"#rounded-4dots-1px-bad",
			]) {
				await expect(assertTouchTargets(touchPage, [badSel])).rejects.toThrow();
			}
			const tPerf = Date.now();
			await expect(assertTouchTargets(touchPage, ["#perf-350-stair"])).rejects.toThrow();
			expect(Date.now() - tPerf).toBeLessThan(5000);
		} finally {
			await touchCtx.close();
		}
	});

	test("DOM geometry 4c: Iter 13 MD regressions, 4x350 stair perf, and popover viewport checks", async ({ browser }) => {
		const touchCtx = await browser.newContext(viewportContextOptions("VP-MD-PORT"));
		const touchPage = await touchCtx.newPage();
		try {
			// 2b-v (MD). Subpixel left/top edge strips, clear prefix before blocker, quadrant circle, 4x350 <5s
			await touchPage.setContent(`<!doctype html><html><body style="margin:0;position:relative;width:400px;height:300px;">
				<button id="sp1" style="position:absolute;left:10.1px;top:10px;width:44px;height:44px;padding:0;border:0;">SP1</button>
				<div style="position:absolute;left:10px;top:25px;width:1px;height:2px;z-index:10;"></div>
				<button id="sp2" style="position:absolute;left:10px;top:80.1px;width:44px;height:44px;padding:0;border:0;">SP2</button>
				<div style="position:absolute;left:25px;top:80px;width:2px;height:1px;z-index:10;"></div>
				<button id="int45" style="position:absolute;left:120px;top:0;width:44px;height:45px;padding:0;border:0;">I45</button>
				<div style="position:absolute;left:138px;top:44px;width:1px;height:1px;z-index:10;"></div>
				<div style="position:absolute;left:200px;top:0;width:108px;height:108px;">
					<button id="c108q" style="width:108px;height:108px;border-radius:50%;padding:0;border:0;">C108</button>
					<div style="position:absolute;left:0;top:0;width:54px;height:108px;z-index:10;"></div>
					<div style="position:absolute;left:54px;top:0;width:54px;height:54px;z-index:10;"></div>
				</div>
			</body></html>`);
			await expect(assertTouchTargets(touchPage, ["#sp1"])).rejects.toThrow();
			await expect(assertTouchTargets(touchPage, ["#sp2"])).rejects.toThrow();
			await assertTouchTargets(touchPage, ["#int45", "#c108q"]);

			const stairHtml = buildStair350Html();
			const mk350 = (id) =>
				`<div style="position:relative;width:350px;height:350px;"><button id="${id}" style="width:350px;height:350px;padding:0;border:0;">P</button>${stairHtml}</div>`;
			await touchPage.setContent(`<!doctype html><html><body style="margin:0;display:flex;flex-wrap:wrap;">
				${mk350("m1")}${mk350("m2")}${mk350("m3")}${mk350("m4")}
			</body></html>`);
			const tMulti = Date.now();
			await expect(assertTouchTargets(touchPage, ["#m1", "#m2", "#m3", "#m4"])).rejects.toThrow();
			expect(Date.now() - tMulti).toBeLessThan(5000);

			// 2c. Verify assertPopoversInViewport regression cases
			await touchPage.setContent(`
				<!doctype html>
				<html>
				<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
				<body style="margin:0;">
					<div role="menu" style="visibility:hidden;opacity:0;position:fixed;left:-300px;width:200px;height:200px;">Closed</div>
					<div role="menu" style="position:fixed;left:20px;top:20px;width:150px;height:120px;">Open OK</div>
				</body>
				</html>
			`);
			await assertPopoversInViewport(touchPage);

			await touchPage.setContent(`
				<!doctype html>
				<html>
				<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
				<body style="margin:0;">
					<div style="width:100px;height:50px;overflow:hidden;">
						<div role="menu" style="width:250px;height:200px;">Overflow clipped menu</div>
					</div>
				</body>
				</html>
			`);
			await expect(assertPopoversInViewport(touchPage)).rejects.toThrow();

			await touchPage.setContent(`
				<!doctype html>
				<html>
				<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
				<body style="margin:0;">
					<div role="listbox" style="position:fixed;left:700px;top:20px;width:250px;height:120px;">Offscreen listbox</div>
				</body>
				</html>
			`);
			await expect(assertPopoversInViewport(touchPage)).rejects.toThrow();

			await touchPage.setContent(`
				<!doctype html>
				<html>
				<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
				<body style="margin:0;">
					<div id="popover-calc-min-clip" role="menu" style="position:fixed;left:20px;top:20px;width:200px;height:200px;clip-path:inset(calc(min(60px, 40%)));">Calc min clipped</div>
				</body>
				</html>
			`);
			await expect(assertPopoversInViewport(touchPage)).rejects.toThrow();

			await touchPage.setContent(`
				<!doctype html>
				<html>
				<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
				<body style="margin:0;">
					<div id="popover-circle-clip" role="menu" style="position:fixed;left:20px;top:20px;width:200px;height:200px;clip-path:circle(10px at 50% 50%);">Circle clipped</div>
				</body>
				</html>
			`);
			await expect(assertPopoversInViewport(touchPage)).rejects.toThrow();

			await touchPage.setContent(`
				<!doctype html>
				<html>
				<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
				<body style="margin:0;">
					<div id="popover-clamp-min-gt-max" role="menu" style="position:fixed;left:20px;top:20px;width:200px;height:200px;clip-path:inset(clamp(20px, 50%, 0px));">Clamp min gt max clipped</div>
				</body>
				</html>
			`);
			await expect(assertPopoversInViewport(touchPage)).rejects.toThrow();
		} finally {
			await touchCtx.close();
		}
	});

	test("DOM geometry 4d: VP-LG-PORT 1000x1000 phantom dividers, #s120int, and multi-cell occlusion", async ({ browser }) => {
		const lgCtx = await browser.newContext(viewportContextOptions("VP-LG-PORT"));
		const lgPage = await lgCtx.newPage();
		try {
			// 2b-v (LG). >48 fake 52x52 + 46x46 <5s
			const blockersG49 = [];
			for (let gx = 0; gx < 7; gx++) {
				for (let gy = 0; gy < 7; gy++) {
					const cx = 10 + gx * 120;
					const cy = 10 + gy * 120;
					for (const dx of [16, 34]) {
						for (const dy of [16, 34]) {
							blockersG49.push(`<div style="position:absolute;left:${cx + dx}px;top:${cy + dy}px;width:2px;height:2px;z-index:10;"></div>`);
						}
					}
				}
			}
			blockersG49.push(`<div style="position:absolute;left:0;top:0;width:10px;height:840px;z-index:10;"></div>`);
			blockersG49.push(`<div style="position:absolute;left:0;top:0;width:840px;height:10px;z-index:10;"></div>`);
			for (let k = 0; k < 7; k++) {
				blockersG49.push(`<div style="position:absolute;left:${62 + k * 120}px;top:0;width:68px;height:840px;z-index:10;"></div>`);
				blockersG49.push(`<div style="position:absolute;left:0;top:${62 + k * 120}px;width:840px;height:68px;z-index:10;"></div>`);
			}
			blockersG49.push(`<div style="position:absolute;left:840px;top:0;width:160px;height:895px;z-index:10;"></div>`);
			blockersG49.push(`<div style="position:absolute;left:0;top:840px;width:895px;height:160px;z-index:10;"></div>`);
			blockersG49.push(`<div style="position:absolute;left:840px;top:840px;width:55px;height:160px;z-index:10;"></div>`);
			blockersG49.push(`<div style="position:absolute;left:941px;top:895px;width:59px;height:105px;z-index:10;"></div>`);
			blockersG49.push(`<div style="position:absolute;left:895px;top:941px;width:46px;height:59px;z-index:10;"></div>`);
			await lgPage.setContent(`<!doctype html><html><body style="margin:0;">
				<div style="position:relative;width:1000px;height:1000px;">
					<button id="g49-52b" style="width:1000px;height:1000px;padding:0;border:0;">G49</button>
					${blockersG49.join("")}
				</div>
			</body></html>`);
			const tG49 = Date.now();
			await assertTouchTargets(lgPage, ["#g49-52b"]);
			expect(Date.now() - tG49).toBeLessThan(5000);

			// 2b-vi. Iteration 14 regressions (#s120int, mid-span xMid/yMid dividers, multi-cell 96x96 & 52x52 odd 1x1 / 2x2 occlusion <5s)
			await lgPage.setContent(`<!doctype html><html><body style="margin:0;display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;">
				<div style="position:relative;width:120px;height:120px;">
					<button id="s120int" style="width:120px;height:120px;padding:0;border:0;">S120</button>
					<div style="position:absolute;left:43px;top:0;width:1px;height:120px;z-index:10;"></div>
					<div style="position:absolute;left:0;top:43px;width:120px;height:1px;z-index:10;"></div>
					<div style="position:absolute;left:88px;top:0;width:1px;height:120px;z-index:10;"></div>
					<div style="position:absolute;left:0;top:88px;width:120px;height:1px;z-index:10;"></div>
				</div>
			</body></html>`);
			await assertTouchTargets(lgPage, ["#s120int"]);

			await lgPage.setContent(`<!doctype html><html><body style="margin:0;">
				<div style="position:relative;width:1000px;height:1000px;">
					<button id="phantom-divider-50x63-ok" style="width:1000px;height:1000px;padding:0;border:0;">PD24</button>
					<div style="position:absolute;left:21px;top:0;width:24px;height:1000px;z-index:10;"></div>
					<div style="position:absolute;left:95px;top:0;width:905px;height:1000px;z-index:10;"></div>
					<div style="position:absolute;left:0;top:63px;width:1000px;height:937px;z-index:10;"></div>
				</div>
			</body></html>`);
			await assertTouchTargets(lgPage, ["#phantom-divider-50x63-ok"]);

			await lgPage.setContent(`<!doctype html><html><body style="margin:0;">
				<div style="position:relative;width:1000px;height:1000px;">
					<button id="phantom-divider-1px-54x63-ok" style="width:1000px;height:1000px;padding:0;border:0;">PD1</button>
					<div style="position:absolute;left:40px;top:0;width:1px;height:1000px;z-index:10;"></div>
					<div style="position:absolute;left:95px;top:0;width:905px;height:1000px;z-index:10;"></div>
					<div style="position:absolute;left:0;top:63px;width:1000px;height:937px;z-index:10;"></div>
				</div>
			</body></html>`);
			await assertTouchTargets(lgPage, ["#phantom-divider-1px-54x63-ok"]);

			const mk96Grid = (n, dots, id) => {
				const blks = [];
				const span = n * 120;
				for (let gx = 0; gx < n; gx++) {
					for (let gy = 0; gy < n; gy++) {
						const cx = 10 + gx * 120;
						const cy = 10 + gy * 120;
						for (const [dx, dy, sz] of dots) {
							blks.push(`<div style="position:absolute;left:${cx + dx}px;top:${cy + dy}px;width:${sz}px;height:${sz}px;z-index:10;"></div>`);
						}
					}
				}
				blks.push(`<div style="position:absolute;left:0;top:0;width:10px;height:${span}px;z-index:10;"></div>`);
				blks.push(`<div style="position:absolute;left:0;top:0;width:${span}px;height:10px;z-index:10;"></div>`);
				for (let k = 0; k < n; k++) {
					blks.push(`<div style="position:absolute;left:${106 + k * 120}px;top:0;width:24px;height:${span}px;z-index:10;"></div>`);
					blks.push(`<div style="position:absolute;left:0;top:${106 + k * 120}px;width:${span}px;height:24px;z-index:10;"></div>`);
				}
				blks.push(`<div style="position:absolute;left:${span}px;top:0;width:${1000 - span}px;height:1000px;z-index:10;"></div>`);
				blks.push(`<div style="position:absolute;left:0;top:${span}px;width:${span}px;height:${1000 - span}px;z-index:10;"></div>`);
				return `<!doctype html><html><body style="margin:0;"><div style="position:relative;width:1000px;height:1000px;"><button id="${id}" style="width:1000px;height:1000px;padding:0;border:0;">B</button>${blks.join("")}</div></body></html>`;
			};

			const dots2x2 = [];
			for (const dx of [24, 48, 72]) for (const dy of [24, 48, 72]) dots2x2.push([dx, dy, 2]);
			await lgPage.setContent(mk96Grid(7, dots2x2, "perf-49fake96-2x2-all-bad"));
			const t49_2 = Date.now();
			await expect(assertTouchTargets(lgPage, ["#perf-49fake96-2x2-all-bad"])).rejects.toThrow();
			expect(Date.now() - t49_2).toBeLessThan(5000);

			const dotsOdd1x1 = [];
			for (const dx of [23, 49, 73]) for (const dy of [23, 49, 73]) dotsOdd1x1.push([dx, dy, 1]);
			await lgPage.setContent(mk96Grid(7, dotsOdd1x1, "perf-49fake96-odd1x1-all-bad"));
			const t49_1 = Date.now();
			await expect(assertTouchTargets(lgPage, ["#perf-49fake96-odd1x1-all-bad"])).rejects.toThrow();
			expect(Date.now() - t49_1).toBeLessThan(5000);

			await lgPage.setContent(mk96Grid(4, dots2x2, "g16-96-bad"));
			const t16 = Date.now();
			await expect(assertTouchTargets(lgPage, ["#g16-96-bad"])).rejects.toThrow();
			expect(Date.now() - t16).toBeLessThan(5000);

			const blks52 = [];
			for (let gx = 0; gx < 7; gx++) {
				for (let gy = 0; gy < 7; gy++) {
					const cx = 34 + gx * 120;
					const cy = 34 + gy * 120;
					for (const dx of [17, 35]) {
						for (const dy of [17, 35]) {
							blks52.push(`<div style="position:absolute;left:${cx + dx}px;top:${cy + dy}px;width:1px;height:1px;z-index:10;"></div>`);
						}
					}
				}
			}
			blks52.push(`<div style="position:absolute;left:0;top:0;width:34px;height:860px;z-index:10;"></div>`);
			blks52.push(`<div style="position:absolute;left:0;top:0;width:860px;height:34px;z-index:10;"></div>`);
			for (let k = 0; k < 7; k++) {
				blks52.push(`<div style="position:absolute;left:${86 + k * 120}px;top:0;width:68px;height:860px;z-index:10;"></div>`);
				blks52.push(`<div style="position:absolute;left:0;top:${86 + k * 120}px;width:860px;height:68px;z-index:10;"></div>`);
			}
			blks52.push(`<div style="position:absolute;left:860px;top:0;width:140px;height:1000px;z-index:10;"></div>`);
			blks52.push(`<div style="position:absolute;left:0;top:860px;width:860px;height:140px;z-index:10;"></div>`);
			await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><div style="position:relative;width:1000px;height:1000px;"><button id="g49-52-odd1x1-bad" style="width:1000px;height:1000px;padding:0;border:0;">B52</button>${blks52.join("")}</div></body></html>`);
			const t52_1 = Date.now();
			await expect(assertTouchTargets(lgPage, ["#g49-52-odd1x1-bad"])).rejects.toThrow();
			expect(Date.now() - t52_1).toBeLessThan(5000);
		} finally {
			await lgCtx.close();
		}
	});

	test("DOM geometry 4e: Iter 15 edge badges, sxs[c1], xMid/yMid notches, and ::before/::after occlusion", async ({ browser }) => {
		const lgCtx = await browser.newContext(viewportContextOptions("VP-LG-PORT"));
		const lgPage = await lgCtx.newPage();
		try {
			await lgPage.setContent(`<!doctype html><html><body style="margin:0;">
				<div style="position:relative;width:1000px;height:1000px;">
					<button id="badge-2x19-5-side-74x63-ok" style="width:1000px;height:1000px;padding:0;border:0;">B74</button>
					<div style="position:absolute;left:19px;top:0;width:2px;height:19.5px;z-index:10;"></div>
					<div style="position:absolute;left:95px;top:0;width:905px;height:1000px;z-index:10;"></div>
					<div style="position:absolute;left:0;top:63px;width:1000px;height:937px;z-index:10;"></div>
				</div>
			</body></html>`);
			const tBadge = Date.now();
			await assertTouchTargets(lgPage, ["#badge-2x19-5-side-74x63-ok"]);
			expect(Date.now() - tBadge).toBeLessThan(5000);

			await lgPage.setContent(`<!doctype html><html><body style="margin:0;">
				<div style="position:relative;width:1000px;height:1000px;">
					<button id="divider-with-side-clip-54x63-ok" style="width:1000px;height:1000px;padding:0;border:0;">DSC</button>
					<div style="position:absolute;left:19px;top:0;width:2px;height:19.5px;z-index:10;"></div>
					<div style="position:absolute;left:40px;top:0;width:1px;height:1000px;z-index:10;"></div>
					<div style="position:absolute;left:95px;top:0;width:905px;height:1000px;z-index:10;"></div>
					<div style="position:absolute;left:0;top:63px;width:1000px;height:937px;z-index:10;"></div>
				</div>
			</body></html>`);
			const tDivSide = Date.now();
			await assertTouchTargets(lgPage, ["#divider-with-side-clip-54x63-ok"]);
			expect(Date.now() - tDivSide).toBeLessThan(5000);

			{
				const blks = [];
				for (const x of [18, 42, 66, 90, 114, 138]) {
					for (const y of [16, 48, 80, 112, 144, 176, 208, 240, 272, 304, 336]) {
						blks.push(`<div style="position:absolute;left:${x}px;top:${y}px;width:1px;height:1px;z-index:10;"></div>`);
					}
				}
				blks.push(`<div style="position:absolute;left:0;top:349px;width:150px;height:2px;z-index:10;"></div>`);
				blks.push(`<div style="position:absolute;left:0;top:396px;width:150px;height:4px;z-index:10;"></div>`);
				await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><div style="position:relative;width:150px;height:400px;"><button id="atk-1a-sxs-r1-oob" style="width:150px;height:400px;padding:0;border:0;">T</button>${blks.join("")}</div></body></html>`);
				const tAtk1a = Date.now();
				await assertTouchTargets(lgPage, ["#atk-1a-sxs-r1-oob"]);
				expect(Date.now() - tAtk1a).toBeLessThan(5000);
			}

			await lgPage.setContent(`<!doctype html><html><body style="margin:0;">
				<div style="position:relative;width:1000px;height:1000px;">
					<button id="atk-2b-1000x1000-notch-ymid" style="width:1000px;height:1000px;padding:0;border:0;">N</button>
					<div style="position:absolute;left:0;top:0;width:15px;height:1000px;z-index:10;"></div>
					<div style="position:absolute;left:61px;top:0;width:939px;height:1000px;z-index:10;"></div>
					<div style="position:absolute;left:0;top:100px;width:1000px;height:900px;z-index:10;"></div>
					<div style="position:absolute;left:15px;top:39px;width:4px;height:2px;z-index:10;"></div>
				</div>
			</body></html>`);
			const tAtk2b = Date.now();
			await assertTouchTargets(lgPage, ["#atk-2b-1000x1000-notch-ymid"]);
			expect(Date.now() - tAtk2b).toBeLessThan(5000);

			await lgPage.setContent(`<!doctype html><html><body style="margin:0;">
				<div style="position:relative;width:1000px;height:1000px;">
					<button id="atk-2c-1000x1000-notch-xmid" style="width:1000px;height:1000px;padding:0;border:0;">NX</button>
					<div style="position:absolute;left:0;top:0;width:1000px;height:15px;z-index:10;"></div>
					<div style="position:absolute;left:0;top:61px;width:1000px;height:939px;z-index:10;"></div>
					<div style="position:absolute;left:100px;top:0;width:900px;height:1000px;z-index:10;"></div>
					<div style="position:absolute;left:39px;top:15px;width:2px;height:4px;z-index:10;"></div>
				</div>
			</body></html>`);
			const tAtk2c = Date.now();
			await assertTouchTargets(lgPage, ["#atk-2c-1000x1000-notch-xmid"]);
			expect(Date.now() - tAtk2c).toBeLessThan(5000);

			{
				const blks = [];
				const cssRules = [];
				let idx = 0;
				for (let gx = 0; gx < 7; gx++) {
					for (let gy = 0; gy < 7; gy++) {
						const cx = 10 + gx * 120;
						const cy = 10 + gy * 120;
						const coords = [];
						for (const dx of [23, 49, 73]) for (const dy of [23, 49, 73]) coords.push([cx + dx, cy + dy]);
						for (let k = 0; k < coords.length; k += 2) {
							const [x1, y1] = coords[k];
							const pair = coords[k + 1];
							const cls = `pd${idx++}`;
							cssRules.push(`.${cls}::before{content:"";position:absolute;left:${x1}px;top:${y1}px;width:1px;height:1px;pointer-events:auto;}`);
							if (pair) cssRules.push(`.${cls}::after{content:"";position:absolute;left:${pair[0]}px;top:${pair[1]}px;width:1px;height:1px;pointer-events:auto;}`);
							blks.push(`<div class="${cls}" style="position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:10;"></div>`);
						}
					}
				}
				blks.push(`<div style="position:absolute;left:0;top:0;width:10px;height:840px;z-index:10;"></div>`);
				blks.push(`<div style="position:absolute;left:0;top:0;width:840px;height:10px;z-index:10;"></div>`);
				for (let k = 0; k < 7; k++) {
					blks.push(`<div style="position:absolute;left:${106 + k * 120}px;top:0;width:24px;height:840px;z-index:10;"></div>`);
					blks.push(`<div style="position:absolute;left:0;top:${106 + k * 120}px;width:840px;height:24px;z-index:10;"></div>`);
				}
				blks.push(`<div style="position:absolute;left:840px;top:0;width:160px;height:1000px;z-index:10;"></div>`);
				blks.push(`<div style="position:absolute;left:0;top:840px;width:840px;height:160px;z-index:10;"></div>`);
				await lgPage.setContent(`<!doctype html><html><head><style>${cssRules.join("")}</style></head><body style="margin:0;"><div style="position:relative;width:1000px;height:1000px;"><button id="atk-3a-pseudo-odd1x1-hang" style="width:1000px;height:1000px;padding:0;border:0;">H</button>${blks.join("")}</div></body></html>`);
				const tAtk3a = Date.now();
				await expect(assertTouchTargets(lgPage, ["#atk-3a-pseudo-odd1x1-hang"])).rejects.toThrow();
				expect(Date.now() - tAtk3a).toBeLessThan(5000);
			}
		} finally {
			await lgCtx.close();
		}
	});

	test("DOM geometry 4f: Iter 15 z-index:-1 and dense-DOM budget exhaustion (<5000ms each)", async ({ browser }) => {
		const lgCtx = await browser.newContext(viewportContextOptions("VP-LG-PORT"));
		const lgPage = await lgCtx.newPage();
		try {
			{
				const bgBars = [];
				const blks = [];
				for (let k = 0; k < 55; k++) {
					bgBars.push(`<div style="position:absolute;left:${k * 16}px;top:0;width:10px;height:1000px;z-index:-1;"></div>`);
				}
				for (let gx = 0; gx < 7; gx++) {
					for (let gy = 0; gy < 7; gy++) {
						const cx = 10 + gx * 120;
						const cy = 10 + gy * 120;
						for (const dx of [23, 49, 73]) {
							for (const dy of [23, 49, 73]) {
								blks.push(`<div style="position:absolute;left:${cx + dx}px;top:${cy + dy}px;width:1px;height:1px;z-index:10;"></div>`);
							}
						}
					}
				}
				blks.push(`<div style="position:absolute;left:0;top:0;width:10px;height:840px;z-index:10;"></div>`);
				blks.push(`<div style="position:absolute;left:0;top:0;width:840px;height:10px;z-index:10;"></div>`);
				for (let k = 0; k < 7; k++) {
					blks.push(`<div style="position:absolute;left:${106 + k * 120}px;top:0;width:24px;height:840px;z-index:10;"></div>`);
					blks.push(`<div style="position:absolute;left:0;top:${106 + k * 120}px;width:840px;height:24px;z-index:10;"></div>`);
				}
				blks.push(`<div style="position:absolute;left:840px;top:0;width:160px;height:1000px;z-index:10;"></div>`);
				blks.push(`<div style="position:absolute;left:0;top:840px;width:840px;height:160px;z-index:10;"></div>`);
				await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><div style="position:relative;width:1000px;height:1000px;">${bgBars.join("")}<button id="atk-3b-budget-exhaust-zneg1" style="position:relative;z-index:1;width:1000px;height:1000px;padding:0;border:0;">H</button>${blks.join("")}</div></body></html>`);
				const tAtk3b = Date.now();
				await expect(assertTouchTargets(lgPage, ["#atk-3b-budget-exhaust-zneg1"])).rejects.toThrow();
				expect(Date.now() - tAtk3b).toBeLessThan(5000);
			}

			{
				const blks = [];
				for (let row = 0; row < 28; row++) {
					for (let col = 0; col < 50; col++) {
						blks.push(`<div style="position:absolute;left:${10 + col * 19}px;top:${10 + row * 35}px;width:1px;height:1px;z-index:10;"></div>`);
					}
				}
				for (let y = 40; y < 1000; y += 43) {
					blks.push(`<div style="position:absolute;left:955px;top:${y}px;width:45px;height:1px;z-index:10;"></div>`);
				}
				await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><div style="position:relative;width:1000px;height:1000px;"><button id="atk-5-1400dots-o-p2-bad" style="width:1000px;height:1000px;padding:0;border:0;">O</button>${blks.join("")}</div></body></html>`);
				const tAtk5 = Date.now();
				await assertTouchTargets(lgPage, ["#atk-5-1400dots-o-p2-bad"]);
				expect(Date.now() - tAtk5).toBeLessThan(5000);
			}

			{
				const bg = [];
				const blks = [];
				for (let r = 0; r < 40; r++) {
					for (let c = 0; c < 40; c++) {
						bg.push(`<div style="position:absolute;left:${c * 24}px;top:${r * 24}px;width:2px;height:2px;z-index:0;"></div>`);
					}
				}
				for (let gx = 0; gx < 4; gx++) {
					for (let gy = 0; gy < 4; gy++) {
						const cx = 10 + gx * 110;
						const cy = 10 + gy * 110;
						for (const dx of [24, 48, 72]) {
							for (const dy of [24, 48, 72]) {
								blks.push(`<div style="position:absolute;left:${cx + dx}px;top:${cy + dy}px;width:2px;height:2px;z-index:10;"></div>`);
							}
						}
					}
				}
				blks.push(`<div style="position:absolute;left:0;top:0;width:10px;height:440px;z-index:10;"></div>`);
				blks.push(`<div style="position:absolute;left:0;top:0;width:440px;height:10px;z-index:10;"></div>`);
				for (let k = 0; k < 4; k++) {
					blks.push(`<div style="position:absolute;left:${106 + k * 110}px;top:0;width:10px;height:440px;z-index:10;"></div>`);
					blks.push(`<div style="position:absolute;left:0;top:${106 + k * 110}px;width:440px;height:10px;z-index:10;"></div>`);
				}
				blks.push(`<div style="position:absolute;left:440px;top:0;width:560px;height:1000px;z-index:10;"></div>`);
				blks.push(`<div style="position:absolute;left:0;top:440px;width:440px;height:560px;z-index:10;"></div>`);
				await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><div style="position:relative;width:1000px;height:1000px;">${bg.join("")}<button id="adv-16fake96-budget-exhaust" style="width:1000px;height:1000px;padding:0;border:0;">A</button>${blks.join("")}</div></body></html>`);
				const tAdv16 = Date.now();
				await expect(assertTouchTargets(lgPage, ["#adv-16fake96-budget-exhaust"])).rejects.toThrow();
				expect(Date.now() - tAdv16).toBeLessThan(5000);
			}

			{
				const blks = [];
				for (let r = 0; r < 41; r++) {
					for (let c = 0; c < 41; c++) {
						blks.push(`<div style="position:absolute;left:${12 + c * 24}px;top:${12 + r * 24}px;width:1px;height:1px;z-index:10;"></div>`);
					}
				}
				await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><div style="position:relative;width:1000px;height:1000px;"><button id="p1681-all-bad" style="width:1000px;height:1000px;padding:0;border:0;">P</button>${blks.join("")}</div></body></html>`);
				const tP1681 = Date.now();
				await expect(assertTouchTargets(lgPage, ["#p1681-all-bad"])).rejects.toThrow();
				expect(Date.now() - tP1681).toBeLessThan(5000);
			}
		} finally {
			await lgCtx.close();
		}
	});

	test("DOM geometry 4g: VP-SPLIT-2 top-left fixed corner, popover, and 0px overflow", async ({ browser }) => {
		const split2Ctx = await browser.newContext(viewportContextOptions("VP-SPLIT-2"));
		const split2Page = await split2Ctx.newPage();
		try {
			await split2Page.setContent(`
				<!doctype html>
				<html>
				<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
				<body style="margin:0;">
					<button id="tl-btn" style="position:fixed;left:8px;top:8px;width:44px;height:44px;padding:0;border:0;">TL</button>
					<button id="br-btn" style="position:fixed;right:8px;bottom:8px;width:44px;height:44px;padding:0;border:0;">BR</button>
					<div role="menu" style="position:fixed;left:20px;top:70px;width:120px;height:120px;">Menu</div>
				</body>
				</html>
			`);
			await assertNoHorizontalOverflow(split2Page);
			await assertPopoversInViewport(split2Page);
			await assertTouchTargets(split2Page, ["#tl-btn"]);
		} finally {
			await split2Ctx.close();
		}
	});

	test("DOM geometry 4h: VP-SPLIT-2 bottom-right fixed corner and horizontal overflow rejection", async ({ browser }) => {
		const split2Ctx = await browser.newContext(viewportContextOptions("VP-SPLIT-2"));
		const split2Page = await split2Ctx.newPage();
		try {
			await split2Page.setContent(`
				<!doctype html>
				<html>
				<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
				<body style="margin:0;">
					<button id="tl-btn" style="position:fixed;left:8px;top:8px;width:44px;height:44px;padding:0;border:0;">TL</button>
					<button id="br-btn" style="position:fixed;right:8px;bottom:8px;width:44px;height:44px;padding:0;border:0;">BR</button>
					<div role="menu" style="position:fixed;left:20px;top:70px;width:120px;height:120px;">Menu</div>
				</body>
				</html>
			`);
			await assertTouchTargets(split2Page, ["#br-btn"]);

			await split2Page.setContent(`
				<!doctype html>
				<html>
				<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
				<body style="margin:0;"><div style="width:520px;height:40px;">Real overflow</div></body>
				</html>
			`);
			await expect(assertNoHorizontalOverflow(split2Page)).rejects.toThrow();

			await split2Page.setContent(`
				<!doctype html>
				<html>
				<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
				<body style="margin:0;"><div style="width:509px;height:40px;">2px overflow</div></body>
				</html>
			`);
			await expect(assertNoHorizontalOverflow(split2Page)).rejects.toThrow();
		} finally {
			await split2Ctx.close();
		}
	});

	test("DOM geometry 4i: Iter 16 ::before/::after scroll/transform/margin/visibility and closed Shadow DOM soundness", async ({ browser }) => {
		const lgCtx = await browser.newContext(viewportContextOptions("VP-LG-PORT"));
		const lgPage = await lgCtx.newPage();
		try {
			await lgPage.setContent(`<!doctype html><html><head><style>
				.h{position:relative;width:88px;height:88px;visibility:hidden;}
				.h::before{content:"";position:absolute;left:0;top:43px;width:88px;height:2px;visibility:visible;}
			</style></head><body style="margin:0;"><button id="adv88-vis-override" style="width:88px;height:88px;padding:0;border:0;">B</button><div class="h" style="position:absolute;left:0;top:0;"></div></body></html>`);
			await expect(assertTouchTargets(lgPage, ["#adv88-vis-override"])).rejects.toThrow();

			await lgPage.setContent(`<!doctype html><html><head><style>
				.h{position:absolute;left:0;top:0;width:10px;height:10px;pointer-events:none;}
				.h::before{content:"";display:block;width:88px;height:2px;margin-top:43px;pointer-events:auto;}
			</style></head><body style="margin:0;"><button id="adv88-static-ov" style="width:88px;height:88px;padding:0;border:0;">B</button><div class="h"></div></body></html>`);
			await expect(assertTouchTargets(lgPage, ["#adv88-static-ov"])).rejects.toThrow();

			await lgPage.setContent(`<!doctype html><html><head><style>
				body{margin:0;height:2000px;}
				.abs-b::before{content:"";position:absolute;left:0;top:143px;width:88px;height:2px;}
			</style></head><body><button id="adv88-scroll-abs" style="position:fixed;left:0;top:0;width:88px;height:88px;padding:0;border:0;">B</button><div class="abs-b"></div></body></html>`);
			await lgPage.evaluate(() => window.scrollTo(0, 100));
			await expect(assertTouchTargets(lgPage, ["#adv88-scroll-abs"])).rejects.toThrow();

			await lgPage.setContent(`<!doctype html><html><head><style>
				.cb{position:fixed;left:0;top:0;width:176px;height:176px;scale:0.5;transform-origin:0 0;pointer-events:none;}
				.cb::before{content:"";position:absolute;left:0;top:86px;width:176px;height:4px;pointer-events:auto;}
			</style></head><body style="margin:0;"><button id="adv88-cb-scale-offset" style="position:fixed;left:0;top:0;width:88px;height:88px;padding:0;border:0;">B</button><div class="cb"></div></body></html>`);
			await expect(assertTouchTargets(lgPage, ["#adv88-cb-scale-offset"])).rejects.toThrow();

			await lgPage.setContent(`<!doctype html><html><head><style>
				.scroller{position:fixed;left:0;top:0;width:100px;height:100px;overflow:auto;pointer-events:none;}
				.scroller::after{content:"";position:absolute;left:19.5px;top:319.5px;width:2px;height:2px;pointer-events:auto;}
				.spacer{height:600px;}
			</style></head><body style="margin:0;"><button id="atk-scroll-pseudo-44" style="position:fixed;left:0;top:0;width:44px;height:44px;padding:0;border:0;">B</button><div class="scroller" id="sc"><div class="spacer"></div></div></body></html>`);
			await lgPage.evaluate(() => {
				document.getElementById("sc").scrollTop = 300;
			});
			await expect(assertTouchTargets(lgPage, ["#atk-scroll-pseudo-44"])).rejects.toThrow();

			await lgPage.setContent(`<!doctype html><html><head><style>
				body{margin:0;height:2000px;}
				.doc-p::after{content:"";position:absolute;left:19.5px;top:519.5px;width:2px;height:2px;}
			</style></head><body><button id="atk-docscroll-pseudo-44" style="position:fixed;left:0;top:0;width:44px;height:44px;padding:0;border:0;">B</button><div class="doc-p"></div></body></html>`);
			await lgPage.evaluate(() => window.scrollTo(0, 500));
			await expect(assertTouchTargets(lgPage, ["#atk-docscroll-pseudo-44"])).rejects.toThrow();

			await lgPage.setContent(`<!doctype html><html><head><style>
				.outer{position:fixed;left:0;top:0;transform:scale(0.5);transform-origin:0 0;pointer-events:none;}
				.cb{position:relative;left:-50px;top:-50px;width:300px;height:300px;}
				.cb::after{content:"";position:absolute;left:89px;top:89px;width:4px;height:4px;pointer-events:auto;}
			</style></head><body style="margin:0;"><button id="atk-pseudo-ancestor-scale-offset" style="position:fixed;left:0;top:0;width:44px;height:44px;padding:0;border:0;">B</button><div class="outer"><div class="cb"></div></div></body></html>`);
			await expect(assertTouchTargets(lgPage, ["#atk-pseudo-ancestor-scale-offset"])).rejects.toThrow();

			await lgPage.setContent(`<!doctype html><html><head><style>
				.tr-p{position:fixed;left:-100px;top:-100px;width:20px;height:20px;pointer-events:none;}
				.tr-p::after{content:"";display:block;width:2px;height:2px;translate:119.5px 119.5px;pointer-events:auto;}
			</style></head><body style="margin:0;"><button id="atk-pseudo-translate-44" style="position:fixed;left:0;top:0;width:44px;height:44px;padding:0;border:0;">B</button><div class="tr-p"></div></body></html>`);
			await expect(assertTouchTargets(lgPage, ["#atk-pseudo-translate-44"])).rejects.toThrow();

			await lgPage.setContent(`<!doctype html><html><head><style>
				.mg-p{position:fixed;left:-100px;top:-100px;width:20px;height:20px;pointer-events:none;}
				.mg-p::after{content:"";display:block;width:2px;height:2px;margin-left:119.5px;margin-top:119.5px;pointer-events:auto;}
			</style></head><body style="margin:0;"><button id="atk-pseudo-margin-44" style="position:fixed;left:0;top:0;width:44px;height:44px;padding:0;border:0;">B</button><div class="mg-p"></div></body></html>`);
			await expect(assertTouchTargets(lgPage, ["#atk-pseudo-margin-44"])).rejects.toThrow();

			await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><button id="atk-closed-shadow-44" style="position:fixed;left:0;top:0;width:44px;height:44px;padding:0;border:0;">B</button><div id="host" style="position:fixed;left:0;top:0;width:44px;height:44px;pointer-events:none;"></div></body></html>`);
			await lgPage.evaluate(() => {
				const sr = document.getElementById("host").attachShadow({ mode: "closed" });
				const d = document.createElement("div");
				d.style.cssText = "position:fixed;left:19.5px;top:19.5px;width:2px;height:2px;pointer-events:auto;";
				sr.appendChild(d);
			});
			await expect(assertTouchTargets(lgPage, ["#atk-closed-shadow-44"])).rejects.toThrow();

			const dense160 = Array.from(
				{ length: 160 },
				(_, i) => `<div style="position:fixed;left:${(i % 10) * 4}px;top:${Math.floor(i / 10) * 2}px;width:1px;height:1px;z-index:-1;"></div>`,
			).join("");
			await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><button id="atk-closed-shadow-44-dense" style="position:fixed;left:0;top:0;width:44px;height:44px;padding:0;border:0;">B</button><div id="host" style="position:fixed;left:0;top:0;width:44px;height:44px;pointer-events:none;"></div>${dense160}</body></html>`);
			await lgPage.evaluate(() => {
				const sr = document.getElementById("host").attachShadow({ mode: "closed" });
				const d = document.createElement("div");
				d.style.cssText = "position:fixed;left:19.5px;top:19.5px;width:2px;height:2px;pointer-events:auto;";
				sr.appendChild(d);
			});
			await expect(assertTouchTargets(lgPage, ["#atk-closed-shadow-44-dense"])).rejects.toThrow();
		} finally {
			await lgCtx.close();
		}
	});

	test("DOM geometry 4j: Iter 16 tiering, hitBudget cache-hit, >=2025 dense dots, and 1px divider latency (<5000ms)", async ({ browser }) => {
		const lgCtx = await browser.newContext(viewportContextOptions("VP-LG-PORT"));
		const lgPage = await lgCtx.newPage();
		try {
			const mk96Odd = () => {
				const blks = [];
				for (let gx = 0; gx < 7; gx++) {
					for (let gy = 0; gy < 7; gy++) {
						const cx = 10 + gx * 120;
						const cy = 10 + gy * 120;
						for (const dx of [23, 49, 73]) {
							for (const dy of [23, 49, 73]) {
								blks.push(`<div style="position:absolute;left:${cx + dx}px;top:${cy + dy}px;width:1px;height:1px;z-index:1;"></div>`);
							}
						}
					}
				}
				blks.push(`<div style="position:absolute;left:0;top:0;width:10px;height:840px;z-index:1;"></div>`);
				blks.push(`<div style="position:absolute;left:0;top:0;width:840px;height:10px;z-index:1;"></div>`);
				for (let k = 0; k < 7; k++) {
					blks.push(`<div style="position:absolute;left:${106 + k * 120}px;top:0;width:24px;height:840px;z-index:1;"></div>`);
					blks.push(`<div style="position:absolute;left:0;top:${106 + k * 120}px;width:840px;height:24px;z-index:1;"></div>`);
				}
				blks.push(`<div style="position:absolute;left:840px;top:0;width:160px;height:1000px;z-index:1;"></div>`);
				blks.push(`<div style="position:absolute;left:0;top:840px;width:840px;height:160px;z-index:1;"></div>`);
				return blks.join("");
			};
			const odd96Html = mk96Odd();

			{
				const z0 = [];
				for (let i = 0; i < 1250; i++) {
					z0.push(`<div style="position:absolute;left:${(i % 40) * 24}px;top:${Math.floor(i / 40) * 24}px;width:2px;height:2px;z-index:0;"></div>`);
				}
				await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><div style="position:relative;width:1000px;height:1000px;"><button id="atk-tier1-miss-1250" style="position:relative;z-index:1;width:1000px;height:1000px;padding:0;border:0;">B</button>${z0.join("")}${odd96Html}</div></body></html>`);
				const t0 = Date.now();
				await expect(assertTouchTargets(lgPage, ["#atk-tier1-miss-1250"])).rejects.toThrow();
				expect(Date.now() - t0).toBeLessThan(5000);
			}

			{
				const statics = [];
				for (let i = 0; i < 350; i++) {
					statics.push(`<div style="position:static;margin-top:-1px;width:20px;height:1px;"></div>`);
				}
				const blks = [];
				for (let gx = 0; gx < 7; gx++) {
					for (let gy = 0; gy < 7; gy++) {
						const cx = 10 + gx * 120;
						const cy = 10 + gy * 120;
						for (const dx of [23, 49, 73]) {
							for (const dy of [23, 49, 73]) {
								blks.push(`<div style="position:absolute;left:${cx + dx}px;top:${cy + dy}px;width:1px;height:1px;"></div>`);
							}
						}
					}
				}
				blks.push(`<div style="position:absolute;left:0;top:0;width:10px;height:840px;"></div>`);
				blks.push(`<div style="position:absolute;left:0;top:0;width:840px;height:10px;"></div>`);
				for (let k = 0; k < 7; k++) {
					blks.push(`<div style="position:absolute;left:${106 + k * 120}px;top:0;width:24px;height:840px;"></div>`);
					blks.push(`<div style="position:absolute;left:0;top:${106 + k * 120}px;width:840px;height:24px;"></div>`);
				}
				blks.push(`<div style="position:absolute;left:840px;top:0;width:160px;height:1000px;"></div>`);
				blks.push(`<div style="position:absolute;left:0;top:840px;width:840px;height:160px;"></div>`);
				await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><div style="position:relative;width:1000px;height:1000px;">${statics.join("")}${blks.join("")}<button id="atk-tier2-static-miss-350" style="width:1000px;height:1000px;padding:0;border:0;">B</button></div></body></html>`);
				const t0 = Date.now();
				await expect(assertTouchTargets(lgPage, ["#atk-tier2-static-miss-350"])).rejects.toThrow();
				expect(Date.now() - t0).toBeLessThan(5000);
			}

			{
				const bars = Array.from(
					{ length: 120 },
					() => `<div style="position:absolute;left:0;top:0;width:1000px;height:20px;z-index:10;"></div>`,
				).join("");
				await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><div style="position:relative;width:1000px;height:1000px;"><button id="atk-hitbudget-120bars" style="width:1000px;height:1000px;padding:0;border:0;">B</button>${bars}${odd96Html}</div></body></html>`);
				const t0 = Date.now();
				await expect(assertTouchTargets(lgPage, ["#atk-hitbudget-120bars"])).rejects.toThrow();
				expect(Date.now() - t0).toBeLessThan(5000);
			}

			{
				const dots = [];
				for (let r = 0; r < 45; r++) {
					for (let c = 0; c < 45; c++) {
						dots.push(`<div style="position:absolute;left:${11 + c * 22}px;top:${11 + r * 22}px;width:1px;height:1px;z-index:10;"></div>`);
					}
				}
				await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><div style="position:relative;width:1000px;height:1000px;"><button id="atk-p2025-all-bad" style="width:1000px;height:1000px;padding:0;border:0;">P</button>${dots.join("")}</div></body></html>`);
				const t0 = Date.now();
				await expect(assertTouchTargets(lgPage, ["#atk-p2025-all-bad"])).rejects.toThrow();
				expect(Date.now() - t0).toBeLessThan(5000);
			}

			{
				const divs = [];
				for (let x = 43; x < 1000; x += 44) {
					divs.push(`<div style="position:absolute;left:${x}px;top:0;width:1px;height:1000px;z-index:10;"></div>`);
				}
				await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><div style="position:relative;width:1000px;height:1000px;"><button id="adv-1px-every-44px" style="width:1000px;height:1000px;padding:0;border:0;">D</button>${divs.join("")}</div></body></html>`);
				const t0 = Date.now();
				await expect(assertTouchTargets(lgPage, ["#adv-1px-every-44px"])).rejects.toThrow();
				expect(Date.now() - t0).toBeLessThan(5000);
			}
		} finally {
			await lgCtx.close();
		}
	});

	test("DOM geometry 4k: Iter 16 Gate 16 fixed-cb, auto-z, closed Shadow DOM, and stacking-ctx soundness", async ({ browser }) => {
		const lgCtx = await browser.newContext(viewportContextOptions("VP-LG-PORT"));
		const lgPage = await lgCtx.newPage();
		try {
			const dense160 = Array.from(
				{ length: 160 },
				(_, i) => `<div style="position:fixed;left:${(i % 10) * 4}px;top:${Math.floor(i / 10) * 2}px;width:1px;height:1px;z-index:-1;"></div>`,
			).join("");

			await lgPage.setContent(`<!doctype html><html><head><style>
				.sc{position:fixed;left:0;top:0;width:100px;height:100px;overflow:auto;filter:blur(0px);pointer-events:none;}
				.sc::after{content:"";position:fixed;left:19.5px;top:19.5px;width:2px;height:2px;pointer-events:auto;}
				.sp{height:600px;}
			</style></head><body style="margin:0;"><button id="edge-fixedcb-scroll-pseudo-PURE" style="position:fixed;left:0;top:0;width:44px;height:44px;padding:0;border:0;">B</button>${dense160}<div class="sc" id="sc"><div class="sp"></div></div></body></html>`);
			await lgPage.evaluate(() => {
				document.getElementById("sc").scrollTop = 300;
			});
			await expect(assertTouchTargets(lgPage, ["#edge-fixedcb-scroll-pseudo-PURE"])).rejects.toThrow();

			await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><button id="edge-fixed-auto-z-sc-PURE" style="position:relative;z-index:0;width:44px;height:44px;padding:0;border:0;">B</button>${dense160}<div style="position:fixed;left:0;top:0;pointer-events:none;"><div style="position:static;margin-left:19.5px;margin-top:19.5px;width:2px;height:2px;pointer-events:auto;"></div></div></body></html>`);
			await expect(assertTouchTargets(lgPage, ["#edge-fixed-auto-z-sc-PURE"])).rejects.toThrow();

			await lgPage.setContent(`<!doctype html><html><head><style>
				.h{display:block;position:fixed;left:0;top:0;width:44px;height:44px;z-index:2;overflow:hidden;pointer-events:none;}
				.h::before{content:"";display:block;width:2px;height:2px;margin:19.5px 0 0 19.5px;pointer-events:auto;}
			</style></head><body style="margin:0;"><button id="edge4-b-pseudo-tier3" style="position:relative;z-index:1;width:44px;height:44px;padding:0;border:0;">B</button>${dense160}<b class="h"></b></body></html>`);
			await expect(assertTouchTargets(lgPage, ["#edge4-b-pseudo-tier3"])).rejects.toThrow();

			await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><button id="edge-closed-shadow-auto-pe-PURE" style="position:fixed;left:0;top:0;width:44px;height:44px;padding:0;border:0;">B</button>${dense160}<div id="host" style="position:fixed;left:-50px;top:-50px;width:10px;height:10px;"></div></body></html>`);
			await lgPage.evaluate(() => {
				const sr = document.getElementById("host").attachShadow({ mode: "closed" });
				const d = document.createElement("div");
				d.style.cssText = "position:fixed;left:19.5px;top:19.5px;width:2px;height:2px;pointer-events:auto;";
				sr.appendChild(d);
			});
			await expect(assertTouchTargets(lgPage, ["#edge-closed-shadow-auto-pe-PURE"])).rejects.toThrow();

			await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><button id="allowrp-closed-shadow-ptrauto-1x1" style="position:fixed;left:0;top:0;width:44px;height:44px;padding:0;border:0;">B</button>${dense160}<div id="host" style="position:fixed;left:500px;top:500px;width:1px;height:1px;"></div></body></html>`);
			await lgPage.evaluate(() => {
				const sr = document.getElementById("host").attachShadow({ mode: "closed" });
				const d = document.createElement("div");
				d.style.cssText = "position:fixed;left:19.5px;top:19.5px;width:2px;height:2px;pointer-events:auto;";
				sr.appendChild(d);
			});
			await expect(assertTouchTargets(lgPage, ["#allowrp-closed-shadow-ptrauto-1x1"])).rejects.toThrow();

			await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><button id="allowrp-closed-shadow-nonempty-host" style="position:fixed;left:0;top:0;width:44px;height:44px;padding:0;border:0;">B</button>${dense160}<div id="host" style="position:fixed;left:0;top:0;width:44px;height:44px;pointer-events:none;"><span>fallback</span></div></body></html>`);
			await lgPage.evaluate(() => {
				const sr = document.getElementById("host").attachShadow({ mode: "closed" });
				const d = document.createElement("div");
				d.style.cssText = "position:fixed;left:19.5px;top:19.5px;width:2px;height:2px;pointer-events:auto;";
				sr.appendChild(d);
			});
			await expect(assertTouchTargets(lgPage, ["#allowrp-closed-shadow-nonempty-host"])).rejects.toThrow();

			await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><div style="position:fixed;left:0;top:0;"><button id="allowrp-fixed-stacking-ctx-tier3" style="position:relative;z-index:1;width:44px;height:44px;padding:0;border:0;">B</button>${dense160}</div><div style="position:fixed;left:19.5px;top:19.5px;width:2px;height:2px;z-index:0;"></div></body></html>`);
			await expect(assertTouchTargets(lgPage, ["#allowrp-fixed-stacking-ctx-tier3"])).rejects.toThrow();

			await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><div style="display:flex;"><div style="position:static;z-index:0;"><button id="allowrp-flex-z0-stacking-ctx-tier3" style="position:relative;z-index:1;width:44px;height:44px;padding:0;border:0;">B</button>${dense160}</div></div><div style="position:fixed;left:19.5px;top:19.5px;width:2px;height:2px;z-index:0;"></div></body></html>`);
			await expect(assertTouchTargets(lgPage, ["#allowrp-flex-z0-stacking-ctx-tier3"])).rejects.toThrow();

			await lgPage.setContent(`<!doctype html><html><body style="margin:0;"><div style="position:sticky;top:0;"><button id="allowrp-sticky-stacking-ctx-tier3" style="position:relative;z-index:1;width:44px;height:44px;padding:0;border:0;">B</button>${dense160}</div><div style="position:fixed;left:19.5px;top:19.5px;width:2px;height:2px;z-index:0;"></div></body></html>`);
			await expect(assertTouchTargets(lgPage, ["#allowrp-sticky-stacking-ctx-tier3"])).rejects.toThrow();
		} finally {
			await lgCtx.close();
		}
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

			// Verify disabled authMode + explicit mockBaseUrl coerces to keyless (or apiKey if apiKey supplied)
			const disabledFix = JSON.parse(fs.readFileSync(apiFixSettingsPath, "utf8"));
			disabledFix.customProvider.authMode = "disabled";
			fs.writeFileSync(apiFixSettingsPath, JSON.stringify(disabledFix, null, "\t"), "utf8");
			const ctrlDisabled = new ServerController({ id: "selfcheck-disabled" });
			try {
				ctrlDisabled.seedSyntheticProfile(apiFixtureDir, { mockBaseUrl: "http://127.0.0.1:4557/v1/" });
				const disabledSettings = JSON.parse(fs.readFileSync(path.join(ctrlDisabled.dataDir, "settings.json"), "utf8"));
				expect(disabledSettings.customProvider.authMode).toBe("keyless");
				expect(disabledSettings.customProvider.baseUrl).toBe("http://127.0.0.1:4557/v1");
				const disabledBinding = JSON.parse(
					JSON.parse(fs.readFileSync(ctrlDisabled.authFile, "utf8")).__learnharness_custom_provider_binding,
				);
				expect(disabledBinding).toEqual({
					version: 1,
					id: disabledSettings.customProvider.credentialBindingId,
					baseUrl: "http://127.0.0.1:4557/v1",
					authMode: "keyless",
				});
			} finally {
				await ctrlDisabled.cleanup();
			}

			// Verify keyless authMode + options.apiKey coerces to apiKey with fileKeyBaseUrl
			const keylessFix = JSON.parse(fs.readFileSync(apiFixSettingsPath, "utf8"));
			keylessFix.customProvider.authMode = "keyless";
			fs.writeFileSync(apiFixSettingsPath, JSON.stringify(keylessFix, null, "\t"), "utf8");
			const ctrlKeylessApi = new ServerController({ id: "selfcheck-keyless-api" });
			try {
				ctrlKeylessApi.seedSyntheticProfile(apiFixtureDir, {
					mockBaseUrl: "http://127.0.0.1:4558/v1/",
					apiKey: "sk-coerced-123",
				});
				const coercedSettings = JSON.parse(fs.readFileSync(path.join(ctrlKeylessApi.dataDir, "settings.json"), "utf8"));
				expect(coercedSettings.customProvider.authMode).toBe("apiKey");
				const coercedAuth = JSON.parse(fs.readFileSync(ctrlKeylessApi.authFile, "utf8"));
				expect(coercedAuth.CUSTOM_OPENAI_API_KEY).toBe("sk-coerced-123");
				const coercedBinding = JSON.parse(coercedAuth.__learnharness_custom_provider_binding);
				expect(coercedBinding).toEqual({
					version: 1,
					id: coercedSettings.customProvider.credentialBindingId,
					baseUrl: "http://127.0.0.1:4558/v1",
					authMode: "apiKey",
					fileKeyBaseUrl: "http://127.0.0.1:4558/v1",
				});
			} finally {
				await ctrlKeylessApi.cleanup();
			}

			// Verify helpers/auth.mjs re-exports & apiKey validation / apiKey->keyless cleanup
			expect(typeof loginApi).toBe("function");
			expect(typeof loginBrowser).toBe("function");
			const ctrlApiGuard = new ServerController({ id: "selfcheck-apiguard" });
			try {
				expect(() =>
					ctrlApiGuard.seedSyntheticProfile(fixtureRoot, {
						mockBaseUrl: "http://127.0.0.1:4559/v1/",
						authMode: "apiKey",
					}),
				).toThrow();
				ctrlApiGuard.seedSyntheticProfile(fixtureRoot, {
					mockBaseUrl: "http://127.0.0.1:4559/v1/",
					authMode: "apiKey",
					apiKey: "sk-temp-123",
				});
				expect(JSON.parse(fs.readFileSync(ctrlApiGuard.authFile, "utf8")).CUSTOM_OPENAI_API_KEY).toBe("sk-temp-123");
				ctrlApiGuard.seedSyntheticProfile(fixtureRoot, {
					mockBaseUrl: "http://127.0.0.1:4559/v1/",
					authMode: "keyless",
				});
				const cleanedAuth = JSON.parse(fs.readFileSync(ctrlApiGuard.authFile, "utf8"));
				expect(cleanedAuth.CUSTOM_OPENAI_API_KEY).toBeUndefined();
				expect(JSON.parse(cleanedAuth.__learnharness_custom_provider_binding).fileKeyBaseUrl).toBeUndefined();
			} finally {
				await ctrlApiGuard.cleanup();
			}

			// Verify authMode:"disabled" without mockBaseUrl updates settings.customProvider & purges stale keys/bindings
			const ctrlDisabledOnly = new ServerController({ id: "selfcheck-disabled-only" });
			try {
				ctrlDisabledOnly.seedSyntheticProfile(fixtureRoot, { authMode: "disabled" });
				const disabledOnlySettings = JSON.parse(
					fs.readFileSync(path.join(ctrlDisabledOnly.dataDir, "settings.json"), "utf8"),
				);
				expect(disabledOnlySettings.customProvider.authMode).toBe("disabled");
				expect(disabledOnlySettings.customProvider.credentialBindingId).toBeUndefined();

				ctrlDisabledOnly.seedSyntheticProfile(fixtureRoot, {
					mockBaseUrl: "http://127.0.0.1:4560/v1/",
					authMode: "apiKey",
					apiKey: "sk-stale-123",
				});
				ctrlDisabledOnly.seedSyntheticProfile(fixtureRoot, { authMode: "disabled" });
				const reDisabledSettings = JSON.parse(
					fs.readFileSync(path.join(ctrlDisabledOnly.dataDir, "settings.json"), "utf8"),
				);
				expect(reDisabledSettings.customProvider.authMode).toBe("disabled");
				expect(reDisabledSettings.customProvider.credentialBindingId).toBeUndefined();
				const reDisabledAuth = JSON.parse(fs.readFileSync(ctrlDisabledOnly.authFile, "utf8"));
				expect(reDisabledAuth.CUSTOM_OPENAI_API_KEY).toBeUndefined();
				expect(reDisabledAuth.__learnharness_custom_provider_binding).toBeUndefined();
			} finally {
				await ctrlDisabledOnly.cleanup();
			}
		} finally {
			await ctrlApi.cleanup();
			fs.rmSync(apiFixtureDir, { recursive: true, force: true });
		}
	});
});
