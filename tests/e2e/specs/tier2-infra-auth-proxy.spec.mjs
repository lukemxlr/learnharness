import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { resolveRepoDir, ServerController } from "../harness/server-controller.mjs";
import {
	bootStack,
	composerInput,
	createChatSession,
	DEFAULT_USER,
	loginApi,
	loginBrowser,
	syntheticFixtureDir,
} from "../helpers/e2e-session.mjs";
import { buildPng, createVectorDiagramPng } from "../helpers/test-assets.mjs";

function rawHttpRequest({ host = "127.0.0.1", port, method = "GET", reqPath = "/", headers = {}, body }) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host, port, method, path: reqPath, headers }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				resolve({
					status: res.statusCode ?? 0,
					headers: res.headers,
					body: Buffer.concat(chunks).toString("utf8"),
				});
			});
		});
		req.on("error", reject);
		if (body !== undefined) {
			req.write(body);
		}
		req.end();
	});
}

function walkFiles(dir) {
	const results = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...walkFiles(full));
		} else if (entry.isFile()) {
			results.push(full);
		}
	}
	return results;
}

test.describe("Tier 2 — F1: Attachment Validation, Path Traversal & Security Headers", () => {
	test("T2-F1-01: Oversized image attachment (>20 MiB) rejected with 413 and zero partial files", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const oversized = buildPng({ width: 2800, height: 2000, compressionLevel: 0 });
			expect(oversized.length).toBeGreaterThan(20 * 1024 * 1024);

			const form = new FormData();
			form.append("file", new Blob([oversized], { type: "image/png" }), "oversized.png");
			const res = await fetch(`${stack.baseUrl}/api/attachments`, {
				method: "POST",
				headers: { Cookie: cookie },
				body: form,
			});

			expect(res.status).toBe(413);
			const payload = await res.json();
			expect(typeof payload.error).toBe("string");
			expect(payload.error.length).toBeGreaterThan(0);

			const attDir = path.join(stack.ctrl.dataDir, "attachments");
			if (fs.existsSync(attDir)) {
				expect(fs.readdirSync(attDir)).toEqual([]);
			}
		} finally {
			await stack.cleanup();
		}
	});

	test("T2-F1-02: Disallowed MIME, spoofed extension, and HTML+PDF polyglot rejected", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const badPayloads = [
				{
					name: "evil.html",
					mime: "text/html",
					buf: Buffer.from("<html><body><script>alert(1)</script></body></html>", "utf8"),
				},
				{
					name: "evil.js",
					mime: "text/javascript",
					buf: Buffer.from("console.log('xss');", "utf8"),
				},
				{
					name: "spoofed.png",
					mime: "image/png",
					buf: Buffer.from("<html><script>alert(1)</script></html>", "utf8"),
				},
				{
					name: "polyglot.pdf",
					mime: "application/pdf",
					buf: Buffer.from("<html><script>alert(1)</script></html>\n%PDF-1.4\n%%EOF", "utf8"),
				},
			];

			for (const item of badPayloads) {
				const form = new FormData();
				form.append("file", new Blob([item.buf], { type: item.mime }), item.name);
				const res = await fetch(`${stack.baseUrl}/api/attachments`, {
					method: "POST",
					headers: { Cookie: cookie },
					body: form,
				});
				expect([400, 415]).toContain(res.status);
				const body = await res.json();
				expect(typeof body.error).toBe("string");
				expect(body.error.length).toBeGreaterThan(0);
			}

			const attDir = path.join(stack.ctrl.dataDir, "attachments");
			if (fs.existsSync(attDir)) {
				expect(fs.readdirSync(attDir)).toEqual([]);
			}
		} finally {
			await stack.cleanup();
		}
	});

	test("T2-F1-03: Path traversal in attachment ID blocked and uploaded filename sanitized", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);

			for (const badPath of [
				"/api/attachments/..%2F..%2Fuser-auth.json",
				"/api/attachments/..%2F..%2Fauth%2Fuser-auth.json",
				"/api/attachments/not-a-valid-hex-id",
			]) {
				const res = await fetch(`${stack.baseUrl}${badPath}`, {
					headers: { Cookie: cookie },
				});
				expect([400, 404]).toContain(res.status);
				const text = await res.text();
				expect(text).not.toContain("scrypt$");
				expect(text).not.toContain("sessionSecret");
			}

			const png = createVectorDiagramPng(32, 32);
			const form = new FormData();
			form.append("file", new Blob([png], { type: "image/png" }), '../../evil"?.png');
			const uploadRes = await fetch(`${stack.baseUrl}/api/attachments`, {
				method: "POST",
				headers: { Cookie: cookie },
				body: form,
			});
			expect(uploadRes.status).toBe(201);
			const ref = await uploadRes.json();
			expect(ref.filename).not.toMatch(/[\\/"?]/);
			expect(ref.filename).not.toContain("..");

			const getRes = await fetch(`${stack.baseUrl}${ref.url}`, { headers: { Cookie: cookie } });
			expect(getRes.status).toBe(200);
			const disposition = getRes.headers.get("content-disposition") || "";
			expect(disposition).not.toContain("..");
		} finally {
			await stack.cleanup();
		}
	});

	test("T2-F1-04: Non-existent valid-hex attachment ID returns clean 404 without path or stack leak", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const missingId = "0".repeat(64);
			const res = await fetch(`${stack.baseUrl}/api/attachments/${missingId}`, {
				headers: { Cookie: cookie },
			});
			expect(res.status).toBe(404);
			const text = await res.text();
			const parsed = JSON.parse(text);
			expect(typeof parsed.error).toBe("string");
			expect(text).not.toContain(stack.ctrl.dataDir);
			expect(text).not.toContain(stack.ctrl.rootDir);
			expect(text).not.toMatch(/\bat\s+[A-Za-z0-9_.$]+\s+\(/);
		} finally {
			await stack.cleanup();
		}
	});

	test("T2-F1-05: SVG XSS rejected and valid attachment sets nosniff + sandbox CSP headers", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const svgBuf = Buffer.from(
				'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
				"utf8",
			);
			const svgForm = new FormData();
			svgForm.append("file", new Blob([svgBuf], { type: "image/svg+xml" }), "xss.svg");
			const svgRes = await fetch(`${stack.baseUrl}/api/attachments`, {
				method: "POST",
				headers: { Cookie: cookie },
				body: svgForm,
			});
			expect([400, 415]).toContain(svgRes.status);

			const png = createVectorDiagramPng(36, 36);
			const pngForm = new FormData();
			pngForm.append("file", new Blob([png], { type: "image/png" }), "safe.png");
			const pngRes = await fetch(`${stack.baseUrl}/api/attachments`, {
				method: "POST",
				headers: { Cookie: cookie },
				body: pngForm,
			});
			expect(pngRes.status).toBe(201);
			const ref = await pngRes.json();

			const dlRes = await fetch(`${stack.baseUrl}${ref.url}`, { headers: { Cookie: cookie } });
			expect(dlRes.status).toBe(200);
			expect(dlRes.headers.get("x-content-type-options")?.toLowerCase()).toBe("nosniff");
			const csp = dlRes.headers.get("content-security-policy") || "";
			expect(csp).toContain("default-src 'none'");
			expect(csp).toContain("sandbox");
			expect(dlRes.headers.get("cache-control")).toContain("no-store");
		} finally {
			await stack.cleanup();
		}
	});
});

test.describe("Tier 2 — F2: Mock Provider Faults, Isolation & Concurrency", () => {
	test("T2-F2-01: Mock provider 429 failure surfaces honest error and allows subsequent turn recovery", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 10 } });
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Rate Limit Recovery" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`, { waitUntil: "domcontentloaded" });

			await stack.mock.admin({ failNextTurn: 429 });
			const input = composerInput(page);
			await input.fill("Trigger injected 429 error");
			await page.getByRole("button", { name: "Send" }).click();

			// Wait for failed turn to settle and verify chat record stays valid JSON with turnError or clean non-hanging state
			await expect
				.poll(
					async () => {
						const r = await fetch(`${stack.baseUrl}/api/chats/${chat.id}`, { headers: { Cookie: cookie } });
						if (r.status !== 200) return false;
						const j = await r.json();
						return j.turnInFlight === false && (Boolean(j.turnError) || j.messages.length >= 1);
					},
					{ timeout: 15_000 },
				)
				.toBe(true);

			// Subsequent turn succeeds cleanly
			await input.fill("Retry after rate limit");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByText(/Synthetic tutor response: Retry after rate limit/i)).toBeVisible({
				timeout: 15_000,
			});
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F2-02: Mock provider mid-stream socket abort leaves valid recoverable chat state", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 10 } });
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Socket Abort Recovery" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`, { waitUntil: "domcontentloaded" });

			await stack.mock.admin({ failNextTurn: { midStreamAbort: true } });
			const input = composerInput(page);
			await input.fill("Trigger mid-stream socket reset");
			await page.getByRole("button", { name: "Send" }).click();

			await expect
				.poll(
					async () => {
						const r = await fetch(`${stack.baseUrl}/api/chats/${chat.id}`, { headers: { Cookie: cookie } });
						if (r.status !== 200) return false;
						const j = await r.json();
						return j.turnInFlight === false && Array.isArray(j.messages);
					},
					{ timeout: 15_000 },
				)
				.toBe(true);

			await input.fill("Continue after socket abort");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByText(/Synthetic tutor response: Continue after socket abort/i)).toBeVisible({
				timeout: 15_000,
			});
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F2-03: Empty model catalog response does not crash Model Picker", async ({ browser }) => {
		let emptyModelHits = 0;
		const emptySrv = http.createServer((req, res) => {
			if (req.url === "/v1/models" || req.url === "/models") {
				emptyModelHits += 1;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [] }));
				return;
			}
			res.writeHead(404);
			res.end();
		});
		await new Promise((resolve) => emptySrv.listen(0, "127.0.0.1", resolve));
		const emptyAddr = emptySrv.address();
		const emptyBaseUrl = `http://127.0.0.1:${emptyAddr.port}/v1`;

		const stack = await bootStack({ seedProfile: false });
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		const pageErrors = [];
		page.on("pageerror", (err) => pageErrors.push(err.message));
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const cpGet = await fetch(`${stack.baseUrl}/api/custom-provider`, {
				headers: { Cookie: cookie },
			});
			expect(cpGet.status).toBe(200);
			const etag = cpGet.headers.get("etag") || "";

			const cpPost = await fetch(`${stack.baseUrl}/api/custom-provider`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookie,
					Origin: stack.baseUrl,
					"Sec-Fetch-Site": "same-origin",
					"If-Match": etag,
				},
				body: JSON.stringify({ baseUrl: emptyBaseUrl, authMode: "keyless" }),
			});
			expect(cpPost.status).toBe(200);
			expect(emptyModelHits).toBeGreaterThanOrEqual(1);

			const modelsRes = await fetch(`${stack.baseUrl}/api/models`, {
				headers: { Cookie: cookie },
			});
			expect(modelsRes.status).toBe(200);
			const modelsData = await modelsRes.json();
			expect(modelsData.models).toEqual([]);

			await loginBrowser(page, stack.baseUrl);
			await page.getByTestId("stats-model").click();
			await expect(page.getByTestId("model-menu")).toBeVisible();
			await expect(page.getByTestId("model-menu")).toContainText(/No models/i);
			expect(pageErrors).toEqual([]);
		} finally {
			await context.close();
			await stack.cleanup();
			await new Promise((resolve) => emptySrv.close(resolve));
		}
	});

	test("T2-F2-04: Synthetic fixture & E2E spec isolation audit", async () => {
		const repoDir = resolveRepoDir();
		const fixtureRoot = syntheticFixtureDir();
		const e2eRoot = path.join(repoDir, "tests", "e2e");

		const winUserPathRe = new RegExp("C:\\\\Users\\\\(?!Synth\\b)[A-Za-z0-9._-]+", "i");
		const macUserPathRe = new RegExp("/Users/[A-Za-z0-9._-]+/");
		const appDataDirRe = new RegExp("AppData(?:\\\\|/)(?:Roaming|Local)", "i");
		const appDataEnvRe = new RegExp("%" + "(?:APPDATA|LOCALAPPDATA)" + "%", "i");
		const personalEmailRe = new RegExp("@(?:gmail|yahoo|outlook|hotmail|icloud|proton)\\.", "i");
		const apiKeyRe = new RegExp("(?:sk-proj-|sk-ant-|ghp_|AIza)[A-Za-z0-9_-]{8,}");

		const forbiddenFixturePatterns = [
			winUserPathRe,
			macUserPathRe,
			appDataDirRe,
			appDataEnvRe,
			personalEmailRe,
			apiKeyRe,
		];

		const fixtureFiles = walkFiles(fixtureRoot);
		expect(fixtureFiles.length).toBeGreaterThan(0);
		for (const file of fixtureFiles) {
			if (/\.(png|pdf|jpg|jpeg|webp|gif)$/i.test(file)) continue;
			const content = fs.readFileSync(file, "utf8");
			for (const re of forbiddenFixturePatterns) {
				expect(content, `Forbidden pattern ${re} in fixture ${path.relative(repoDir, file)}`).not.toMatch(re);
			}
		}

		// Audit E2E specs, helpers, harness, and checklist for real personal data leaks without false-positives on checklist safety notes or regex declarations
		const universalE2ePatterns = [winUserPathRe, macUserPathRe, personalEmailRe, apiKeyRe];
		const nonChecklistEnvPatterns = [appDataDirRe, appDataEnvRe];
		const e2eFiles = walkFiles(e2eRoot);
		expect(e2eFiles.length).toBeGreaterThan(0);
		for (const file of e2eFiles) {
			if (!/\.(mjs|md|json)$/i.test(file)) continue;
			const content = fs.readFileSync(file, "utf8");
			const rel = path.relative(repoDir, file);
			for (const re of universalE2ePatterns) {
				expect(content, `Forbidden pattern ${re} in ${rel}`).not.toMatch(re);
			}
			if (path.basename(file) !== "MANUAL_IPAD_AND_WINDOWS_CHECKLIST.md") {
				for (const re of nonChecklistEnvPatterns) {
					expect(content, `Forbidden env/AppData literal ${re} in ${rel}`).not.toMatch(re);
				}
			}
		}
	});

	test("T2-F2-05: Concurrent mock turns from 2 independent sessions isolate prompts and replies", async () => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 25 } });
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const sessionA = await createChatSession(stack.baseUrl, cookie, { title: "Concurrent A" });
			const sessionB = await createChatSession(stack.baseUrl, cookie, { title: "Concurrent B" });

			await stack.mock.clearRequests();

			const startTurn = async (chatId, text) => {
				const res = await fetch(`${stack.baseUrl}/api/chat`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: cookie },
					body: JSON.stringify({ chatId, input: { type: "text", text } }),
				});
				expect(res.status).toBe(200);
				return res.json();
			};

			await Promise.all([
				startTurn(sessionA.id, "Prompt-Alpha-111 kinematics"),
				startTurn(sessionB.id, "Prompt-Beta-222 momentum"),
			]);

			await Promise.all([
				fetch(`${stack.baseUrl}/api/chats/${sessionA.id}/stream`, { headers: { Cookie: cookie } }).then((r) => r.text()),
				fetch(`${stack.baseUrl}/api/chats/${sessionB.id}/stream`, { headers: { Cookie: cookie } }).then((r) => r.text()),
			]);

			const [chatARes, chatBRes] = await Promise.all([
				fetch(`${stack.baseUrl}/api/chats/${sessionA.id}`, { headers: { Cookie: cookie } }),
				fetch(`${stack.baseUrl}/api/chats/${sessionB.id}`, { headers: { Cookie: cookie } }),
			]);
			const chatAText = await chatARes.text();
			const chatBText = await chatBRes.text();

			expect(chatAText).toContain("Prompt-Alpha-111");
			expect(chatAText).not.toContain("Prompt-Beta-222");
			expect(chatBText).toContain("Prompt-Beta-222");
			expect(chatBText).not.toContain("Prompt-Alpha-111");

			const ledger = await stack.mock.getRequests();
			expect(ledger.count).toBe(2);
		} finally {
			await stack.cleanup();
		}
	});
});

test.describe("Tier 2 — F3: Host Guard, Proxy Trust, CSRF & Data Dir Safety", () => {
	test("T2-F3-01: Disallowed Host header blocked with 403 (DNS rebinding guard)", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const apiRes = await rawHttpRequest({
				port: stack.port,
				method: "GET",
				reqPath: "/api/chats",
				headers: { Host: "evil-rebind.invalid", Cookie: cookie },
			});
			expect(apiRes.status).toBe(403);
			expect(apiRes.body).toContain("LH_ALLOWED_HOSTS");

			const pageRes = await rawHttpRequest({
				port: stack.port,
				method: "GET",
				reqPath: "/",
				headers: { Host: "evil-rebind.invalid", Cookie: cookie },
			});
			expect(pageRes.status).toBe(403);
			expect(pageRes.body).toContain("LH_ALLOWED_HOSTS");
		} finally {
			await stack.cleanup();
		}
	});

	test("T2-F3-02: Forged X-Forwarded-Proto and X-Forwarded-Host ignored when LH_TRUST_PROXY=0", async () => {
		const stack = await bootStack({ startOptions: { trustProxy: false } });
		try {
			const { res, cookie, setCookie } = await loginApi(stack.baseUrl, {
				headers: {
					"X-Forwarded-Proto": "https",
					"X-Forwarded-Host": "spoof.invalid",
				},
			});
			expect(res.status).toBe(200);
			expect(setCookie).not.toMatch(/;\s*Secure\b/i);

			const spoofOriginRes = await fetch(`${stack.baseUrl}/api/chats`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookie,
					"X-Forwarded-Proto": "https",
					"X-Forwarded-Host": "spoof.invalid",
					Origin: "https://spoof.invalid",
					"Sec-Fetch-Site": "same-origin",
				},
				body: JSON.stringify({ title: "Should Fail Spoofed Origin" }),
			});
			expect(spoofOriginRes.status).toBe(403);

			const trueOriginRes = await fetch(`${stack.baseUrl}/api/chats`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookie,
					"X-Forwarded-Proto": "https",
					"X-Forwarded-Host": "spoof.invalid",
					Origin: stack.baseUrl,
					"Sec-Fetch-Site": "same-origin",
				},
				body: JSON.stringify({ title: "Allowed Direct Origin" }),
			});
			expect(trueOriginRes.status).toBe(200);
		} finally {
			await stack.cleanup();
		}
	});

	test("T2-F3-03: Cross-origin Origin and Sec-Fetch-Site: cross-site writes blocked with 403", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const beforeChats = await (await fetch(`${stack.baseUrl}/api/chats`, { headers: { Cookie: cookie } })).json();
			const beforeCount = beforeChats.chats.length;

			const badOrigin = await fetch(`${stack.baseUrl}/api/chats`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookie,
					Origin: "https://attacker.invalid",
				},
				body: JSON.stringify({ title: "CSRF Origin" }),
			});
			expect(badOrigin.status).toBe(403);

			const crossSite = await fetch(`${stack.baseUrl}/api/chats`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookie,
					Origin: stack.baseUrl,
					"Sec-Fetch-Site": "cross-site",
				},
				body: JSON.stringify({ title: "CSRF Cross-Site" }),
			});
			expect(crossSite.status).toBe(403);

			const afterChats = await (await fetch(`${stack.baseUrl}/api/chats`, { headers: { Cookie: cookie } })).json();
			expect(afterChats.chats.length).toBe(beforeCount);
		} finally {
			await stack.cleanup();
		}
	});

	test("T2-F3-04: Restricted or unwritable LH_DATA_DIR fails loudly and never falls back to repo/data", async () => {
		const ctrl = new ServerController({ id: "t2-f3-04" });
		const repoDataDir = path.join(ctrl.repoDir, "data");
		const repoDataExistedBefore = fs.existsSync(repoDataDir);
		const blockerFile = path.join(ctrl.rootDir, "unwritable-data-dir-blocker");
		fs.writeFileSync(blockerFile, "not-a-directory", "utf8");
		try {
			let startFailed = false;
			try {
				await ctrl.start({
					bootTimeoutMs: 10_000,
					extraEnv: { LH_DATA_DIR: blockerFile },
				});
			} catch (err) {
				startFailed = true;
				expect(err.message.length).toBeGreaterThan(0);
			}

			if (!startFailed) {
				// If server booted lazily without touching dataDir at startup, writing a session must fail loudly with 500
				const writeRes = await fetch(`${ctrl.baseUrl}/api/chats`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "Should Fail Write" }),
				});
				expect(writeRes.status).toBeGreaterThanOrEqual(500);
			}

			expect(fs.existsSync(repoDataDir)).toBe(repoDataExistedBefore);
		} finally {
			await ctrl.cleanup();
		}
	});

	test("T2-F3-05: /api/health returns strict { ok: true } with no-store and zero secret leakage", async () => {
		const stack = await bootStack({
			startOptions: { trustProxy: true, allowedHosts: "study.example.test" },
		});
		try {
			const unauthRes = await fetch(`${stack.baseUrl}/api/health`);
			expect(unauthRes.status).toBe(200);
			expect(unauthRes.headers.get("cache-control")).toContain("no-store");
			const unauthText = await unauthRes.text();
			expect(JSON.parse(unauthText)).toEqual({ ok: true });
			expect(unauthText).not.toContain(DEFAULT_USER.username);
			expect(unauthText).not.toContain(stack.ctrl.dataDir);
			expect(unauthText).not.toContain(stack.ctrl.authDir);

			const { cookie } = await loginApi(stack.baseUrl, {
				headers: {
					"X-Forwarded-Proto": "https",
					"X-Forwarded-Host": "study.example.test",
				},
			});
			const authRes = await fetch(`${stack.baseUrl}/api/health`, {
				headers: {
					Cookie: cookie,
					"X-Forwarded-Proto": "https",
					"X-Forwarded-Host": "study.example.test",
				},
			});
			expect(authRes.status).toBe(200);
			expect(await authRes.json()).toEqual({ ok: true });
		} finally {
			await stack.cleanup();
		}
	});
});

test.describe("Tier 2 — F4: Auth Gating, Cookie Integrity, Reset Absence & Fail-Closed", () => {
	test("T2-F4-01: Unauthenticated requests gated across all protected pages, APIs, streams, attachments & plugins", async () => {
		const stack = await bootStack();
		try {
			for (const pagePath of ["/", "/chat/new", "/chat/chat_synth_teach_01", "/settings"]) {
				const res = await fetch(`${stack.baseUrl}${pagePath}`, { redirect: "manual" });
				expect(res.status, `Expected 302 for ${pagePath}`).toBe(302);
				const loc = res.headers.get("location") || "";
				expect(loc).toContain("/login");
				expect(loc).toContain("next=");
			}

			const getRoutes = [
				"/api/chats",
				"/api/events",
				"/api/chats/chat_synth_teach_01",
				"/api/chats/chat_synth_teach_01/stream",
				"/api/chats/chat_synth_teach_01/images/1111111111111111111111111111111111111111111111111111111111111111",
				"/api/chats/chat_synth_teach_01/side-chats",
				`/api/attachments/${"a".repeat(64)}`,
				"/api/models",
				"/api/graph",
				"/api/jobs?chatId=chat_synth_teach_01",
			];
			for (const route of getRoutes) {
				const res = await fetch(`${stack.baseUrl}${route}`);
				expect(res.status, `Expected 401 for GET ${route}`).toBe(401);
			}

			const subGet = await fetch(`${stack.baseUrl}/api/subscriptions`, {
				headers: { "x-learnharness-subscriptions": "1" },
			});
			expect(subGet.status).toBe(401);

			for (const postRoute of [
				"/api/plugins/drawing-pad/documents/markdown",
				"/api/chat",
				"/api/models/refresh",
			]) {
				const res = await fetch(`${stack.baseUrl}${postRoute}`, { method: "POST" });
				expect(res.status, `Expected 401 for POST ${postRoute}`).toBe(401);
			}
		} finally {
			await stack.cleanup();
		}
	});

	test("T2-F4-02: Tampered, malformed, wrong-secret & expired lh_session cookies rejected", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const token = cookie.replace(/^lh_session=/, "");
			const [payloadB64, sig] = token.split(".");
			const flippedSig = `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;

			const authRecord = JSON.parse(fs.readFileSync(stack.ctrl.userAuthFile, "utf8"));
			const expiredPayloadB64 = Buffer.from(
				JSON.stringify({
					v: 1,
					u: authRecord.username,
					iat: Date.now() - 120_000,
					exp: Date.now() - 10_000,
				}),
				"utf8",
			).toString("base64url");
			const expiredSig = createHmac("sha256", authRecord.sessionSecret)
				.update(expiredPayloadB64)
				.digest("base64url");
			const wrongSecretSig = createHmac("sha256", "wrong-secret-".repeat(6))
				.update(payloadB64)
				.digest("base64url");

			const badCookies = [
				`lh_session=${payloadB64}.${flippedSig}`,
				"lh_session=not-valid-base64",
				"lh_session=only_one_part",
				`lh_session=${payloadB64}.${wrongSecretSig}`,
				`lh_session=${expiredPayloadB64}.${expiredSig}`,
			];

			for (const badCookie of badCookies) {
				const apiRes = await fetch(`${stack.baseUrl}/api/chats`, { headers: { Cookie: badCookie } });
				expect(apiRes.status).toBe(401);

				const pageRes = await fetch(`${stack.baseUrl}/`, {
					redirect: "manual",
					headers: { Cookie: badCookie },
				});
				expect(pageRes.status).toBe(302);
				expect(pageRes.headers.get("location")).toContain("/login");
			}
		} finally {
			await stack.cleanup();
		}
	});

	test("T2-F4-03: Wrong password, unknown username & empty credentials rejected without session cookie", async () => {
		const stack = await bootStack();
		try {
			const wrongPass = await loginApi(stack.baseUrl, { password: "WrongPassword999!" });
			expect(wrongPass.res.status).toBe(401);
			expect(wrongPass.cookie).toBe("");

			const wrongUser = await loginApi(stack.baseUrl, { username: "unknown-user" });
			expect(wrongUser.res.status).toBe(401);
			expect(wrongUser.cookie).toBe("");

			const emptyBody = await fetch(`${stack.baseUrl}/api/auth/login`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
			expect(emptyBody.status).toBe(400);
			expect(emptyBody.headers.get("set-cookie")).toBeNull();

			const valid = await loginApi(stack.baseUrl);
			expect(valid.res.status).toBe(200);
			expect(valid.cookie).toMatch(/^lh_session=/);
		} finally {
			await stack.cleanup();
		}
	});

	test("T2-F4-04: Browser password-reset endpoints and pages are absent", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			for (const pagePath of ["/reset-password", "/forgot-password"]) {
				const unauth = await fetch(`${stack.baseUrl}${pagePath}`, { redirect: "manual" });
				expect([302, 404]).toContain(unauth.status);
				const authed = await fetch(`${stack.baseUrl}${pagePath}`, {
					redirect: "manual",
					headers: { Cookie: cookie },
				});
				expect(authed.status).toBe(404);
			}

			for (const apiPath of ["/api/auth/reset-password", "/api/auth/forgot-password"]) {
				const unauth = await fetch(`${stack.baseUrl}${apiPath}`, { method: "POST" });
				expect(unauth.status).not.toBe(200);
				const authed = await fetch(`${stack.baseUrl}${apiPath}`, {
					method: "POST",
					headers: { Cookie: cookie, "Content-Type": "application/json" },
					body: JSON.stringify({ password: "NewPassword123!" }),
				});
				expect([404, 405]).toContain(authed.status);
			}
		} finally {
			await stack.cleanup();
		}
	});

	test("T2-F4-05: Proxy-exempt plugin markdown route still enforces host, CSRF, auth & method rules", async () => {
		const stack = await bootStack({ startOptions: { allowedHosts: "lh.test" } });
		try {
			const { cookie } = await loginApi(stack.baseUrl);

			const unauth = await fetch(`${stack.baseUrl}/api/plugins/drawing-pad/documents/markdown`, {
				method: "POST",
			});
			expect(unauth.status).toBe(401);

			const badHost = await rawHttpRequest({
				port: stack.port,
				method: "POST",
				reqPath: "/api/plugins/drawing-pad/documents/markdown",
				headers: { Host: "evil.invalid", Cookie: cookie },
			});
			expect(badHost.status).toBe(403);

			const badOrigin = await fetch(`${stack.baseUrl}/api/plugins/drawing-pad/documents/markdown`, {
				method: "POST",
				headers: { Cookie: cookie, Origin: "https://attacker.invalid" },
			});
			expect(badOrigin.status).toBe(403);

			const crossSite = await fetch(`${stack.baseUrl}/api/plugins/drawing-pad/documents/markdown`, {
				method: "POST",
				headers: { Cookie: cookie, Origin: stack.baseUrl, "Sec-Fetch-Site": "cross-site" },
			});
			expect(crossSite.status).toBe(403);

			const badMethod = await fetch(`${stack.baseUrl}/api/plugins/drawing-pad/documents/markdown`, {
				method: "GET",
				headers: { Cookie: cookie },
			});
			expect(badMethod.status).toBe(405);
		} finally {
			await stack.cleanup();
		}
	});

	test("T2-F4-06: Unconfigured user-auth.json fails closed under LH_REQUIRE_AUTH=1", async ({ browser }) => {
		const stack = await bootStack({
			initAuth: false,
			startOptions: { requireAuth: true },
		});
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		try {
			const sessRes = await fetch(`${stack.baseUrl}/api/auth/session`);
			expect(sessRes.status).toBe(200);
			expect(await sessRes.json()).toMatchObject({
				authenticated: false,
				configured: false,
				authRequired: true,
			});

			const apiRes = await fetch(`${stack.baseUrl}/api/chats`);
			expect(apiRes.status).toBe(401);

			const rootRes = await fetch(`${stack.baseUrl}/`, { redirect: "manual" });
			expect(rootRes.status).toBe(302);
			expect(rootRes.headers.get("location")).toContain("/login");

			const loginRes = await loginApi(stack.baseUrl);
			expect(loginRes.res.status).toBe(503);

			await page.goto(`${stack.baseUrl}/login`, { waitUntil: "domcontentloaded" });
			await expect(page.getByTestId("login-unconfigured")).toBeVisible();
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});
});
