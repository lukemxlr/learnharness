import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startMockProvider } from "../harness/mock-provider.mjs";
import {
	getFreePort,
	resolveRepoDir,
	resolveStandaloneDir,
	ServerController,
} from "../harness/server-controller.mjs";
import {
	bootStack,
	composerInput,
	createChatSession,
	DEFAULT_USER,
	loginApi,
	loginBrowser,
	syntheticFixtureDir,
} from "../helpers/e2e-session.mjs";
import { buildSample3PagePdf, createVectorDiagramPng } from "../helpers/test-assets.mjs";

test.describe("Tier 1 — F1: Docker Runner & Attachment Store Contract", () => {
	test("T1-F1-01: Containerized server boot & health check", async () => {
		const stack = await bootStack();
		try {
			const res = await fetch(`${stack.baseUrl}/api/health`);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({ ok: true });
			expect(fs.existsSync(path.join(stack.ctrl.repoDir, "data"))).toBe(false);
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F1-02: WebKit font rendering availability on /login and /chat/[id]", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true });
		const page = await context.newPage();
		const failedFonts = [];
		page.on("response", (resp) => {
			if (resp.url().includes("/_next/static/") && /\.(woff2?|ttf|otf)(\?|$)/i.test(resp.url()) && resp.status() >= 400) {
				failedFonts.push({ url: resp.url(), status: resp.status() });
			}
		});
		try {
			await page.goto(`${stack.baseUrl}/login`, { waitUntil: "networkidle" });
			const loginFont = await page.evaluate(async () => {
				await document.fonts.ready;
				return getComputedStyle(document.body).fontFamily;
			});
			expect(loginFont.length).toBeGreaterThan(0);

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/chat_synth_teach_01`, { waitUntil: "networkidle" });
			const chatFonts = await page.evaluate(async () => {
				await document.fonts.ready;
				return {
					body: getComputedStyle(document.body).fontFamily,
					loadedCount: document.fonts.size,
				};
			});
			expect(chatFonts.body.length).toBeGreaterThan(0);
			expect(failedFonts).toEqual([]);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F1-03: Content-addressed attachment storage on upload", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const png = createVectorDiagramPng(64, 48);
			const expectedSha = createHash("sha256").update(png).digest("hex");

			const form = new FormData();
			form.append("file", new Blob([png], { type: "image/png" }), "vector.png");
			const uploadRes = await fetch(`${stack.baseUrl}/api/attachments`, {
				method: "POST",
				headers: { Cookie: cookie },
				body: form,
			});
			expect(uploadRes.status).toBe(201);
			const ref = await uploadRes.json();
			expect(ref.id).toBe(expectedSha);
			expect(ref.kind).toBe("image");
			expect(ref.mimeType).toBe("image/png");
			expect(ref.sizeBytes).toBe(png.byteLength);
			expect(ref.url).toBe(`/api/attachments/${expectedSha}`);

			const shaDir = path.join(stack.ctrl.dataDir, "attachments", expectedSha);
			const metaFile = path.join(stack.ctrl.dataDir, "attachments", `${expectedSha}.meta.json`);
			expect(fs.existsSync(shaDir)).toBe(true);
			expect(fs.existsSync(metaFile)).toBe(true);
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F1-04: Attachment deduplication by SHA-256", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const png = createVectorDiagramPng(40, 40);

			const uploadOnce = async (name) => {
				const form = new FormData();
				form.append("file", new Blob([png], { type: "image/png" }), name);
				const res = await fetch(`${stack.baseUrl}/api/attachments`, {
					method: "POST",
					headers: { Cookie: cookie },
					body: form,
				});
				expect(res.status).toBe(201);
				return res.json();
			};

			const first = await uploadOnce("first.png");
			const second = await uploadOnce("second.png");
			expect(second.id).toBe(first.id);

			const attDirs = fs
				.readdirSync(path.join(stack.ctrl.dataDir, "attachments"))
				.filter((n) => !n.endsWith(".meta.json"));
			expect(attDirs).toEqual([first.id]);

			const dlRes = await fetch(`${stack.baseUrl}${first.url}`, { headers: { Cookie: cookie } });
			expect(dlRes.status).toBe(200);
			const dlBytes = Buffer.from(await dlRes.arrayBuffer());
			expect(dlBytes.equals(png)).toBe(true);
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F1-05: Attachment store persistence across server restart", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const png = createVectorDiagramPng(50, 50);
			const pdf = buildSample3PagePdf();

			const postFile = async (buf, mime, name) => {
				const form = new FormData();
				form.append("file", new Blob([buf], { type: mime }), name);
				const res = await fetch(`${stack.baseUrl}/api/attachments`, {
					method: "POST",
					headers: { Cookie: cookie },
					body: form,
				});
				expect(res.status).toBe(201);
				return res.json();
			};

			const pngRef = await postFile(png, "image/png", "persisted.png");
			const pdfRef = await postFile(pdf, "application/pdf", "persisted.pdf");

			await stack.ctrl.restart();

			const pngGet = await fetch(`${stack.baseUrl}${pngRef.url}`, { headers: { Cookie: cookie } });
			expect(pngGet.status).toBe(200);
			expect(pngGet.headers.get("content-type")).toContain("image/png");
			expect(Buffer.from(await pngGet.arrayBuffer()).equals(png)).toBe(true);

			const pdfGet = await fetch(`${stack.baseUrl}${pdfRef.url}`, { headers: { Cookie: cookie } });
			expect(pdfGet.status).toBe(200);
			expect(pdfGet.headers.get("content-type")).toContain("application/pdf");
			expect(Buffer.from(await pdfGet.arrayBuffer()).equals(pdf)).toBe(true);
		} finally {
			await stack.cleanup();
		}
	});
});

test.describe("Tier 1 — F2: Isolated Test LLM Provider & Synthetic Fixtures", () => {
	test("T1-F2-01: Mock provider /v1/models catalog serving", async () => {
		const mock = await startMockProvider();
		try {
			const res = await fetch(`${mock.baseUrl}/models`);
			expect(res.status).toBe(200);
			const body = await res.json();
			const ids = body.data.map((m) => m.id);
			expect(ids).toContain("gpt-test-1");
			expect(ids).toContain("gpt-test-7-pro");
			const pro = body.data.find((m) => m.id === "gpt-test-7-pro");
			expect(pro.context_length).toBe(272000);
			expect(pro.input_modalities).toContain("image");
		} finally {
			await mock.close();
		}
	});

	test("T1-F2-02: Mock provider SSE streaming completion renders progressively", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 65 } });
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Streaming Check" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`, { waitUntil: "domcontentloaded" });

			const input = composerInput(page);
			await input.click();
			await input.fill("[STREAM_LONG] Explain projectile motion");
			await page.getByRole("button", { name: "Send" }).click();

			await expect(page.getByText("Chunk 01/25:")).toBeVisible({ timeout: 10_000 });
			await expect(page.getByText("Chunk 25/25:")).toBeVisible({ timeout: 20_000 });
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F2-03: Mock provider deterministic [TRIGGER_MC] and [TRIGGER_FREE] tool calls", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 10 } });
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const mcChat = await createChatSession(stack.baseUrl, cookie, { title: "MC Trigger" });
			const freeChat = await createChatSession(stack.baseUrl, cookie, { title: "Free Trigger" });

			await loginBrowser(page, stack.baseUrl);

			await page.goto(`${stack.baseUrl}/chat/${mcChat.id}`);
			const mcInput = composerInput(page);
			await mcInput.fill("[TRIGGER_MC]");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });
			await expect(page.getByRole("radio").first()).toBeVisible();

			await page.goto(`${stack.baseUrl}/chat/${freeChat.id}`);
			const freeInput = composerInput(page);
			await freeInput.fill("[TRIGGER_FREE]");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });
			await expect(page.getByTestId("answer-field")).toBeVisible();
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F2-04: Mock provider vision request ledger captures uploaded image bytes", async () => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Vision Ledger" });
			const png = createVectorDiagramPng(64, 48);
			const expectedShaPrefix = createHash("sha256").update(png).digest("hex").slice(0, 12);

			const form = new FormData();
			form.append("file", new Blob([png], { type: "image/png" }), "vision.png");
			const attRes = await fetch(`${stack.baseUrl}/api/attachments`, {
				method: "POST",
				headers: { Cookie: cookie },
				body: form,
			});
			expect(attRes.status).toBe(201);
			const ref = await attRes.json();

			const turnRes = await fetch(`${stack.baseUrl}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: cookie },
				body: JSON.stringify({
					chatId: chat.id,
					input: {
						type: "text",
						text: "[ECHO_VISION] inspect attached image",
						attachments: [ref],
					},
				}),
			});
			expect(turnRes.status).toBe(200);
			expect(await turnRes.json()).toEqual({ ok: true });

			const streamRes = await fetch(`${stack.baseUrl}/api/chats/${chat.id}/stream`, {
				headers: { Cookie: cookie },
			});
			expect(streamRes.status).toBe(200);
			const streamText = await streamRes.text();

			const chatRes = await fetch(`${stack.baseUrl}/api/chats/${chat.id}`, {
				headers: { Cookie: cookie },
			});
			expect(chatRes.status).toBe(200);
			const chatJson = await chatRes.text();
			expect(
				streamText.includes(`sha256=${expectedShaPrefix}`) || chatJson.includes(`sha256=${expectedShaPrefix}`),
			).toBe(true);

			const ledger = await stack.mock.getRequests();
			expect(ledger.count).toBeGreaterThanOrEqual(1);
			const last = ledger.requests[ledger.requests.length - 1];
			expect(last.images.length).toBeGreaterThanOrEqual(1);
			expect(last.images[0].sha256).toContain(expectedShaPrefix);
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F2-05: Synthetic fixture profile isolation check", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chatsRes = await fetch(`${stack.baseUrl}/api/chats`, { headers: { Cookie: cookie } });
			expect(chatsRes.status).toBe(200);
			const chatsData = await chatsRes.json();
			const titles = chatsData.chats.map((c) => c.title);
			expect(titles).toContain("Kinematics & Projectile Vectors");
			expect(titles).toContain("Graph BFS/DFS Traversal Practice");

			const graphRes = await fetch(`${stack.baseUrl}/api/graph`, { headers: { Cookie: cookie } });
			expect(graphRes.status).toBe(200);
			const graphData = await graphRes.json();
			expect(graphData.propositions.some((n) => n.name === "Projectile Velocity Decomposition")).toBe(true);

			await loginBrowser(page, stack.baseUrl);
			const physicsFolder = page.getByTestId("sidebar-folder-folder_synth_physics");
			await expect(physicsFolder).toBeVisible();
			if ((await physicsFolder.getAttribute("aria-expanded")) !== "true") {
				await physicsFolder.click();
			}
			await expect(page.getByText("Kinematics & Projectile Vectors")).toBeVisible();
			const bodyText = await page.locator("body").innerText();
			expect(bodyText).not.toMatch(/AppData\\Roaming/i);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});
});

test.describe("Tier 1 — F3: LXC / systemd Deployment & Cloudflare Proxy Support", () => {
	test("T1-F3-01: Configurable HOSTNAME, PORT, and LH_ALLOWED_HOSTS bind", async () => {
		const port = await getFreePort("127.0.0.1");
		const stack = await bootStack({
			startOptions: { hostname: "0.0.0.0", port, allowedHosts: "lh.lan" },
		});
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
				headers: { Host: `lh.lan:${port}` },
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F3-02: Reverse-proxy HTTPS termination trust (LH_TRUST_PROXY=1)", async () => {
		const stack = await bootStack({
			startOptions: { trustProxy: true, allowedHosts: "study.example.test" },
		});
		try {
			const { res, cookie, setCookie } = await loginApi(stack.baseUrl, {
				headers: {
					"X-Forwarded-Proto": "https",
					"X-Forwarded-Host": "study.example.test",
				},
			});
			expect(res.status).toBe(200);
			expect(setCookie).toContain("HttpOnly");
			expect(setCookie).toContain("SameSite=Lax");
			expect(setCookie).toContain("Secure");

			const postRes = await fetch(`${stack.baseUrl}/api/chats`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookie,
					"X-Forwarded-Proto": "https",
					"X-Forwarded-Host": "study.example.test",
					Origin: "https://study.example.test",
					"Sec-Fetch-Site": "same-origin",
				},
				body: JSON.stringify({ title: "Proxied Session" }),
			});
			expect(postRes.status).toBe(200);
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F3-03: Systemd-style clean SIGTERM shutdown & state survival", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const created = await createChatSession(stack.baseUrl, cookie, { title: "Restart Survival Session" });

			const stopRes = await stack.ctrl.stop();
			// Next can handle SIGTERM itself and report the conventional 128 + 15 exit code.
			expect(stopRes.signal === "SIGTERM" || stopRes.code === 0 || stopRes.code === 143, JSON.stringify(stopRes)).toBe(true);

			await stack.ctrl.start({ port: stack.port });
			const chatRes = await fetch(`${stack.baseUrl}/api/chats/${created.id}`, {
				headers: { Cookie: cookie },
			});
			expect(chatRes.status).toBe(200);
			const chatData = await chatRes.json();
			expect(chatData.title).toBe("Restart Survival Session");
			expect(fs.existsSync(stack.ctrl.userAuthFile)).toBe(true);
			expect(fs.existsSync(path.join(stack.ctrl.dataDir, "settings.json"))).toBe(true);
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F3-04: Unprivileged service-user 0600 file permissions outside LH_DATA_DIR", async () => {
		const ctrl = new ServerController({ id: "t1-f3-04" });
		try {
			await ctrl.initAuth({ username: "serviceuser", password: "StrongPassword123!" });
			const stat = fs.statSync(ctrl.userAuthFile);
			const mode = stat.mode & 0o777;
			expect(mode).toBe(0o600);
			expect(ctrl.userAuthFile.startsWith(ctrl.dataDir)).toBe(false);
		} finally {
			await ctrl.cleanup();
		}
	});

	test("T1-F3-05: Unauthenticated /api/health under proxy returns 200 with no-store and zero secrets", async () => {
		const stack = await bootStack({
			startOptions: { trustProxy: true, allowedHosts: "study.example.test" },
		});
		try {
			const res = await fetch(`${stack.baseUrl}/api/health`, {
				headers: {
					"X-Forwarded-Proto": "https",
					"X-Forwarded-Host": "study.example.test",
				},
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("cache-control")).toContain("no-store");
			expect(await res.json()).toEqual({ ok: true });
		} finally {
			await stack.cleanup();
		}
	});
});

test.describe("Tier 1 — F4: Single-Account Auth & Server-Side Route Protection", () => {
	test("T1-F4-01: CLI initial account creation & status", async () => {
		const ctrl = new ServerController({ id: "t1-f4-01" });
		try {
			await ctrl.initAuth({ username: "learner", password: "ValidPassword123!" });
			const raw = JSON.parse(fs.readFileSync(ctrl.userAuthFile, "utf8"));
			expect(raw.version).toBe(1);
			expect(raw.username).toBe("learner");
			expect(raw.passwordHash).toMatch(/^scrypt\$/);
			expect(raw.sessionSecret.length).toBeGreaterThanOrEqual(64);

			const status = await ctrl.authStatus();
			expect(status.code).toBe(0);
			expect(status.parsed.configured).toBe(true);
			expect(status.parsed.username).toBe("learner");
			expect(status.stdout).not.toContain("ValidPassword123!");
		} finally {
			await ctrl.cleanup();
		}
	});

	test("T1-F4-02: Browser login & HttpOnly session cookie issuance", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		try {
			await page.goto(`${stack.baseUrl}/`, { waitUntil: "domcontentloaded" });
			await expect(page).toHaveURL(/\/login\?next=%2F/);

			await page.getByTestId("login-username").fill(DEFAULT_USER.username);
			await page.getByTestId("login-password").fill(DEFAULT_USER.password);
			await page.getByTestId("login-submit").click();

			await page.waitForURL((u) => u.pathname === "/");
			const cookies = await context.cookies();
			const sessionCookie = cookies.find((c) => c.name === "lh_session");
			expect(sessionCookie).toBeTruthy();
			expect(sessionCookie.httpOnly).toBe(true);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F4-03: Protected API/SSR/stream/attachment/plugin access when logged in", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const png = createVectorDiagramPng(32, 32);
			const form = new FormData();
			form.append("file", new Blob([png], { type: "image/png" }), "protected.png");
			const attRes = await fetch(`${stack.baseUrl}/api/attachments`, {
				method: "POST",
				headers: { Cookie: cookie },
				body: form,
			});
			expect(attRes.status).toBe(201);
			const ref = await attRes.json();

			for (const route of ["/", "/api/chats", ref.url]) {
				const res = await fetch(`${stack.baseUrl}${route}`, { headers: { Cookie: cookie } });
				expect(res.status).toBe(200);
			}

			const unauthDocRes = await fetch(`${stack.baseUrl}/api/plugins/drawing-pad/documents/markdown`, {
				method: "POST",
			});
			expect(unauthDocRes.status).toBe(401);

			const docForm = new FormData();
			docForm.append("file", new Blob(["# Kinematics Note\nProjectile trajectory"], { type: "text/markdown" }), "note.md");
			const docRes = await fetch(`${stack.baseUrl}/api/plugins/drawing-pad/documents/markdown`, {
				method: "POST",
				headers: { Cookie: cookie },
				body: docForm,
			});
			expect(docRes.status).toBe(200);
			const docBody = await docRes.json();
			expect(docBody.markdown).toContain("Projectile trajectory");

			const ac = new AbortController();
			const sseRes = await fetch(`${stack.baseUrl}/api/events`, {
				headers: { Cookie: cookie },
				signal: ac.signal,
			});
			expect(sseRes.status).toBe(200);
			expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
			ac.abort();
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F4-04: Logout clears session cookie & re-gates routes", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const logoutRes = await fetch(`${stack.baseUrl}/api/auth/logout`, {
				method: "POST",
				headers: { Cookie: cookie },
			});
			expect(logoutRes.status).toBe(200);
			expect(logoutRes.headers.get("set-cookie")).toContain("Max-Age=0");

			const sessRes = await fetch(`${stack.baseUrl}/api/auth/session`);
			expect(await sessRes.json()).toMatchObject({ authenticated: false, configured: true });

			const apiRes = await fetch(`${stack.baseUrl}/api/chats`);
			expect(apiRes.status).toBe(401);

			const pageRes = await fetch(`${stack.baseUrl}/`, { redirect: "manual" });
			expect(pageRes.status).toBe(302);
			expect(pageRes.headers.get("location")).toContain("/login");
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F4-05: CLI password reset invalidates old password and pre-reset cookie", async () => {
		const stack = await bootStack();
		try {
			const { res: beforeRes, cookie: oldCookie } = await loginApi(stack.baseUrl);
			expect(beforeRes.status).toBe(200);

			await stack.ctrl.resetPassword({ password: "BrandNewPassword999!" });

			const oldPassRes = await loginApi(stack.baseUrl);
			expect(oldPassRes.res.status).toBe(401);

			const staleCookieRes = await fetch(`${stack.baseUrl}/api/chats`, {
				headers: { Cookie: oldCookie },
			});
			expect(staleCookieRes.status).toBe(401);

			const newPassRes = await loginApi(stack.baseUrl, { password: "BrandNewPassword999!" });
			expect(newPassRes.res.status).toBe(200);
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F4-06: Standalone build excludes secret files", async () => {
		const standaloneDir = resolveStandaloneDir(resolveRepoDir());
		expect(fs.existsSync(path.join(standaloneDir, "server.js"))).toBe(true);
		const entries = fs.readdirSync(standaloneDir);
		const forbidden = entries.filter((name) =>
			/^(auth\.json|user-auth\.json.*|(chatgpt|github-copilot|xai)-credentials\.json.*|\.env.*|data)$/.test(name),
		);
		expect(forbidden).toEqual([]);
	});
});
