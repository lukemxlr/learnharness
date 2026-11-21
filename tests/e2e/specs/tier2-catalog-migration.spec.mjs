import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { ServerController } from "../harness/server-controller.mjs";
import {
	bootStack,
	loginApi,
	loginBrowser,
	syntheticFixtureDir,
} from "../helpers/e2e-session.mjs";

function countJsonlLines(filePath) {
	if (!fs.existsSync(filePath)) return 0;
	return fs
		.readFileSync(filePath, "utf8")
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0).length;
}

function findBundleManifestPath(bundleDir) {
	for (const candidate of ["manifest.json", "export-manifest.json"]) {
		const full = path.join(bundleDir, candidate);
		if (fs.existsSync(full)) return full;
	}
	return null;
}

test.describe("Tier 2 — F5: Headless OAuth Boundaries & Model Catalog Resilience", () => {
	test("T2-F5-01: Invalid/tampered state and expired OAuth code rejected while preserving existing account", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const subHeaders = {
				"Content-Type": "application/json",
				Cookie: cookie,
				Origin: stack.baseUrl,
				"x-learnharness-subscriptions": "1",
			};

			// 1. Verify mock OAuth PKCE rejects expired codes and mismatched code_verifier
			const oidc = await (await fetch(`${stack.mock.origin}/.well-known/openid-configuration`)).json();
			const verifier = randomBytes(32).toString("base64url");
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			const authUrl = new URL(oidc.authorization_endpoint);
			authUrl.searchParams.set("client_id", "learnharness-test");
			authUrl.searchParams.set("redirect_uri", "http://127.0.0.1:1455/auth/callback");
			authUrl.searchParams.set("state", "t2_f5_01_state");
			authUrl.searchParams.set("code_challenge", challenge);
			authUrl.searchParams.set("code_challenge_method", "S256");
			authUrl.searchParams.set("mode", "json");

			const authResp = await (await fetch(authUrl)).json();
			expect(authResp.code).toBeTruthy();

			await stack.mock.admin({ expirePendingCodes: true });
			const expiredTokenRes = await fetch(oidc.token_endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code: authResp.code,
					code_verifier: verifier,
					client_id: "learnharness-test",
					redirect_uri: "http://127.0.0.1:1455/auth/callback",
					state: "t2_f5_01_state",
				}),
			});
			expect(expiredTokenRes.status).toBe(400);

			// Fresh code with wrong PKCE verifier must also fail
			const authResp2 = await (await fetch(authUrl)).json();
			const wrongVerifierRes = await fetch(oidc.token_endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code: authResp2.code,
					code_verifier: "wrong-pkce-verifier",
					client_id: "learnharness-test",
					redirect_uri: "http://127.0.0.1:1455/auth/callback",
					state: "t2_f5_01_state",
				}),
			});
			expect(wrongVerifierRes.status).toBe(400);

			// 2. Seed an existing ChatGPT credentials file and verify complete-headless rejects tampered state
			const credFile = path.join(stack.ctrl.authDir, "chatgpt-credentials.json");
			fs.writeFileSync(
				credFile,
				JSON.stringify(
					{
						version: 1,
						hostId: "urn:uuid:11111111-2222-4333-8444-555555555555",
						activeId: "acct_keep_01",
						registrations: [
							{
								id: "acct_keep_01",
								clientId: "learnharness-test",
								issuer: "https://auth.openai.com",
								subject: "keep_sub_01",
								email: "keep-synth@example.invalid",
								tokens: {
									accessToken: "mock_at_keep",
									refreshToken: "mock_rt_keep",
									idToken: "mock.id.keep",
									scopes: ["openid", "profile", "email", "offline_access"],
									expiresAt: Date.now() + 3600_000,
								},
							},
						],
					},
					null,
					"\t",
				),
				{ mode: 0o600 },
			);

			await fetch(`${stack.baseUrl}/api/subscriptions`, {
				method: "POST",
				headers: subHeaders,
				body: JSON.stringify({ providerId: "chatgpt", op: "reload" }),
			});

			const startRes = await fetch(`${stack.baseUrl}/api/subscriptions`, {
				method: "POST",
				headers: subHeaders,
				body: JSON.stringify({ providerId: "chatgpt", op: "start-headless" }),
			});
			expect(startRes.status).toBe(200);

			const badCompleteRes = await fetch(`${stack.baseUrl}/api/subscriptions`, {
				method: "POST",
				headers: subHeaders,
				body: JSON.stringify({
					providerId: "chatgpt",
					op: "complete-headless",
					callbackUrlOrCode: "http://127.0.0.1:1455/auth/callback?code=bogus&state=tampered_state_999",
				}),
			});
			const badCompleteBody = await badCompleteRes.json().catch(() => ({}));
			const badCompleteVal = badCompleteBody.value ?? badCompleteBody;
			expect(
				badCompleteRes.status >= 400 ||
					(typeof badCompleteVal?.error === "string" && badCompleteVal.error.length > 0),
			).toBe(true);

			// Existing registration remains intact
			const statusAfter = await (
				await fetch(`${stack.baseUrl}/api/subscriptions`, {
					headers: { Cookie: cookie, "x-learnharness-subscriptions": "1" },
				})
			).json();
			expect(statusAfter.chatgpt?.accounts?.some((a) => a.id === "acct_keep_01")).toBe(true);
		} finally {
			await stack.cleanup();
		}
	});

	test("T2-F5-02: Transient /v1/models 503 failure preserves last-known-good catalog", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const cpGet = await fetch(`${stack.baseUrl}/api/custom-provider`, { headers: { Cookie: cookie } });
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
				body: JSON.stringify({ baseUrl: stack.mock.baseUrl, authMode: "keyless" }),
			});
			expect(cpPost.status).toBe(200);

			const initialModels = await (
				await fetch(`${stack.baseUrl}/api/models`, { headers: { Cookie: cookie } })
			).json();
			expect(initialModels.models.some((m) => m.id === "gpt-test-7-pro")).toBe(true);

			// Inject transient 503 on upstream /v1/models
			await stack.mock.admin({ modelsStatus: 503 });

			const cpGetBefore503 = await fetch(`${stack.baseUrl}/api/custom-provider`, { headers: { Cookie: cookie } });
			const etagBefore503 = cpGetBefore503.headers.get("etag") || "";
			const cp503Post = await fetch(`${stack.baseUrl}/api/custom-provider`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookie,
					Origin: stack.baseUrl,
					"Sec-Fetch-Site": "same-origin",
					"If-Match": etagBefore503,
				},
				body: JSON.stringify({ baseUrl: stack.mock.baseUrl, authMode: "keyless" }),
			});
			expect(cp503Post.status).toBe(502);

			const refreshRes = await fetch(`${stack.baseUrl}/api/models/refresh`, {
				method: "POST",
				headers: { Cookie: cookie, Origin: stack.baseUrl },
			});
			expect(refreshRes.status).toBe(200);
			const afterRefresh = await refreshRes.json();
			expect(afterRefresh.models.some((m) => m.id === "gpt-test-1")).toBe(true);
			expect(afterRefresh.models.some((m) => m.id === "gpt-test-7-pro")).toBe(true);

			// Settings refresh and Model Picker stay functional without wiping catalog
			await loginBrowser(page, stack.baseUrl);
			await page.getByTestId("settings-entry").click();
			await page.getByTestId("refresh-models-btn").click();
			await page.getByTestId("settings-close").click();

			await page.getByTestId("stats-model").click();
			await expect(page.getByTestId("model-menu")).toBeVisible();
			await expect(page.getByTestId("model-menu").getByTestId("model-option-gpt-test-7-pro")).toBeVisible();
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F5-03: Catalog refresh never silently mutates an existing session's pinned model", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const beforeChat = await (
				await fetch(`${stack.baseUrl}/api/chats/chat_synth_teach_01`, { headers: { Cookie: cookie } })
			).json();
			expect(beforeChat.settings.model).toEqual({ provider: "custom", id: "gpt-test-1" });

			await stack.mock.admin({
				extraModels: [
					{
						id: "gpt-test-10-fresh",
						slug: "gpt-test-10-fresh",
						display_name: "GPT Test 10 Fresh",
						visibility: "list",
						context_length: 256000,
					},
				],
			});

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

			const refreshRes = await fetch(`${stack.baseUrl}/api/models/refresh`, {
				method: "POST",
				headers: { Cookie: cookie, Origin: stack.baseUrl },
			});
			expect(refreshRes.status).toBe(200);

			const afterChat = await (
				await fetch(`${stack.baseUrl}/api/chats/chat_synth_teach_01`, { headers: { Cookie: cookie } })
			).json();
			expect(afterChat.settings.model).toEqual({ provider: "custom", id: "gpt-test-1" });
		} finally {
			await stack.cleanup();
		}
	});

	test("T2-F5-04: Concurrent POST /api/models/refresh requests coalesce cleanly without race errors", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			await stack.mock.admin({
				modelsDelayMs: 250,
				extraModels: [{ id: "gpt-test-race-1", slug: "gpt-test-race-1", visibility: "list" }],
			});

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

			const [res1, res2] = await Promise.all([
				fetch(`${stack.baseUrl}/api/models/refresh`, {
					method: "POST",
					headers: { Cookie: cookie, Origin: stack.baseUrl },
				}),
				fetch(`${stack.baseUrl}/api/models/refresh`, {
					method: "POST",
					headers: { Cookie: cookie, Origin: stack.baseUrl },
				}),
			]);

			expect(res1.status).toBe(200);
			expect(res2.status).toBe(200);
			const body1 = await res1.json();
			const body2 = await res2.json();
			expect(Array.isArray(body1.models)).toBe(true);
			expect(Array.isArray(body2.models)).toBe(true);
			expect(body1.models.some((m) => m.id === "gpt-test-race-1")).toBe(true);
			expect(body2.models.some((m) => m.id === "gpt-test-race-1")).toBe(true);
		} finally {
			await stack.cleanup();
		}
	});

	test("T2-F5-05: Minimal model metadata omitting context_length and reasoning_levels uses safe defaults", async ({ browser }) => {
		const bareSrv = http.createServer((req, res) => {
			if (req.url === "/v1/models" || req.url === "/models") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						object: "list",
						data: [{ id: "gpt-test-bare", slug: "gpt-test-bare", visibility: "list" }],
					}),
				);
				return;
			}
			res.writeHead(404);
			res.end();
		});
		await new Promise((resolve) => bareSrv.listen(0, "127.0.0.1", resolve));
		const barePort = bareSrv.address().port;
		const bareBaseUrl = `http://127.0.0.1:${barePort}/v1`;

		const stack = await bootStack();
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const cpGet = await fetch(`${stack.baseUrl}/api/custom-provider`, { headers: { Cookie: cookie } });
			const cpPost = await fetch(`${stack.baseUrl}/api/custom-provider`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookie,
					Origin: stack.baseUrl,
					"Sec-Fetch-Site": "same-origin",
					"If-Match": cpGet.headers.get("etag") || "",
				},
				body: JSON.stringify({ baseUrl: bareBaseUrl, authMode: "keyless" }),
			});
			expect(cpPost.status).toBe(200);

			const modelsBody = await (
				await fetch(`${stack.baseUrl}/api/models`, { headers: { Cookie: cookie } })
			).json();
			const bare = modelsBody.models.find((m) => m.id === "gpt-test-bare");
			expect(bare).toBeTruthy();
			expect(bare.contextWindow).toBeGreaterThan(0);
			expect(bare.reasoning).toBe(false);

			await loginBrowser(page, stack.baseUrl);
			await page.getByTestId("stats-model").click();
			await page.getByTestId("model-search").fill("gpt-test-bare");
			await expect(page.getByTestId("model-menu").getByTestId("model-option-gpt-test-bare")).toBeVisible();
		} finally {
			await context.close();
			await stack.cleanup();
			await new Promise((resolve) => bareSrv.close(resolve));
		}
	});
});

test.describe("Tier 2 — F6: Profile Migration Diagnostics, Idempotency & Conflict Guards", () => {
	test("T2-F6-01: Missing attachment files reported clearly in --dry-run and --apply", async () => {
		const ctrl = new ServerController({ id: "t2-f6-01" });
		const sourceCopy = path.join(ctrl.rootDir, "source");
		const bundleDir = path.join(ctrl.rootDir, "bundle");
		const targetDir = path.join(ctrl.rootDir, "target");
		fs.mkdirSync(targetDir, { recursive: true });
		try {
			fs.cpSync(syntheticFixtureDir(), sourceCopy, { recursive: true });
			const pracPath = path.join(sourceCopy, "chats", "chat_synth_prac_01.json");
			const prac = JSON.parse(fs.readFileSync(pracPath, "utf8"));
			prac.messages.push({
				id: "msg_synth_missing_posix",
				role: "user",
				content: "Also check missing file `/tmp/gone-t2-f6-01.pdf`.",
				timestamp: 1794302000000,
			});
			fs.writeFileSync(pracPath, `${JSON.stringify(prac, null, "\t")}\n`, "utf8");

			const exp = await ctrl.runMigrateCli(["export", "--source", sourceCopy, "--out", bundleDir]);
			expect(exp.code).toBe(0);
			expect(findBundleManifestPath(bundleDir)).toBeTruthy();

			const dry = await ctrl.runMigrateCli([
				"import",
				"--bundle",
				bundleDir,
				"--target",
				targetDir,
				"--dry-run",
			]);
			expect(dry.code).toBe(0);
			expect(fs.readdirSync(targetDir)).toEqual([]);
			const dryOutput = dry.stdout + dry.stderr;
			expect(dryOutput).toMatch(/missing\.png/i);
			expect(dryOutput).toMatch(/gone-t2-f6-01\.pdf|missing/i);

			const apply = await ctrl.runMigrateCli([
				"import",
				"--bundle",
				bundleDir,
				"--target",
				targetDir,
				"--apply",
			]);
			expect(apply.code).toBe(0);
			expect(apply.stdout + apply.stderr).toMatch(/missing\.png/i);
		} finally {
			await ctrl.cleanup();
		}
	});

	test("T2-F6-02: Windows drive and UNC paths detected across chat text, tool calls & jobs", async () => {
		const ctrl = new ServerController({ id: "t2-f6-02" });
		const sourceCopy = path.join(ctrl.rootDir, "source");
		const bundleDir = path.join(ctrl.rootDir, "bundle");
		const targetDir = path.join(ctrl.rootDir, "target");
		fs.mkdirSync(targetDir, { recursive: true });
		try {
			fs.cpSync(syntheticFixtureDir(), sourceCopy, { recursive: true });
			const teachPath = path.join(sourceCopy, "chats", "chat_synth_teach_01.json");
			const teach = JSON.parse(fs.readFileSync(teachPath, "utf8"));
			teach.messages.push({
				id: "msg_synth_unc_01",
				role: "user",
				content: "Check UNC diagram at \\\\fileserver.invalid\\StudyNotes\\diagram.png",
				timestamp: 1794302100000,
			});
			fs.writeFileSync(teachPath, `${JSON.stringify(teach, null, "\t")}\n`, "utf8");

			const exp = await ctrl.runMigrateCli(["export", "--source", sourceCopy, "--out", bundleDir]);
			expect(exp.code).toBe(0);
			expect(findBundleManifestPath(bundleDir)).toBeTruthy();

			const imp = await ctrl.runMigrateCli([
				"import",
				"--bundle",
				bundleDir,
				"--target",
				targetDir,
				"--apply",
			]);
			expect(imp.code).toBe(0);
			const diagOutput = exp.stdout + exp.stderr + imp.stdout + imp.stderr;
			expect(diagOutput).toMatch(/C:\\Users\\Synth\\Notes|windows/i);
			expect(diagOutput).toMatch(/fileserver\.invalid|unc/i);
			expect(diagOutput).toMatch(/kinematics\.pdf/i);
		} finally {
			await ctrl.cleanup();
		}
	});

	test("T2-F6-03: Duplicate consecutive --apply imports produce zero duplicate records", async () => {
		const ctrl = new ServerController({ id: "t2-f6-03" });
		const bundleDir = path.join(ctrl.rootDir, "bundle");
		const targetDir = path.join(ctrl.rootDir, "target");
		fs.mkdirSync(targetDir, { recursive: true });
		try {
			const exp = await ctrl.runMigrateCli([
				"export",
				"--source",
				syntheticFixtureDir(),
				"--out",
				bundleDir,
			]);
			expect(exp.code).toBe(0);
			expect(findBundleManifestPath(bundleDir)).toBeTruthy();

			const first = await ctrl.runMigrateCli([
				"import",
				"--bundle",
				bundleDir,
				"--target",
				targetDir,
				"--apply",
			]);
			expect(first.code).toBe(0);

			const snapshotCounts = () => ({
				chats: fs.readdirSync(path.join(targetDir, "chats")).filter((f) => f.endsWith(".json")).length,
				jobs: fs.existsSync(path.join(targetDir, "jobs"))
					? fs.readdirSync(path.join(targetDir, "jobs")).filter((f) => f.endsWith(".json")).length
					: 0,
				nodes: countJsonlLines(path.join(targetDir, "graph", "nodes.jsonl")),
				chains: countJsonlLines(path.join(targetDir, "graph", "chains.jsonl")),
				sessions: countJsonlLines(path.join(targetDir, "graph", "sessions.jsonl")),
				coverage: countJsonlLines(path.join(targetDir, "graph", "coverage.jsonl")),
				sourcesSize: fs.existsSync(path.join(targetDir, "graph", "sources.json"))
					? fs.readFileSync(path.join(targetDir, "graph", "sources.json"), "utf8").length
					: 0,
			});

			const afterFirst = snapshotCounts();
			expect(afterFirst.chats).toBeGreaterThanOrEqual(3);
			expect(afterFirst.nodes).toBeGreaterThanOrEqual(1);

			const second = await ctrl.runMigrateCli([
				"import",
				"--bundle",
				bundleDir,
				"--target",
				targetDir,
				"--apply",
			]);
			expect(second.code).toBe(0);

			const afterSecond = snapshotCounts();
			expect(afterSecond).toEqual(afterFirst);
		} finally {
			await ctrl.cleanup();
		}
	});

	test("T2-F6-04: Newer server record chat_synth_newer_01 is never overwritten by older bundle", async () => {
		const ctrl = new ServerController({ id: "t2-f6-04" });
		const bundleDir = path.join(ctrl.rootDir, "bundle");
		const targetDir = path.join(ctrl.rootDir, "target");
		fs.mkdirSync(targetDir, { recursive: true });
		try {
			const exp = await ctrl.runMigrateCli([
				"export",
				"--source",
				syntheticFixtureDir(),
				"--out",
				bundleDir,
			]);
			expect(exp.code).toBe(0);
			expect(findBundleManifestPath(bundleDir)).toBeTruthy();

			const first = await ctrl.runMigrateCli([
				"import",
				"--bundle",
				bundleDir,
				"--target",
				targetDir,
				"--apply",
			]);
			expect(first.code).toBe(0);

			const serverChatPath = path.join(targetDir, "chats", "chat_synth_newer_01.json");
			const serverChat = JSON.parse(fs.readFileSync(serverChatPath, "utf8"));
			serverChat.updatedAt = "2026-11-19T12:00:00.000Z";
			serverChat.messages.push({
				id: "msg_synth_n01_03_server_newer",
				role: "user",
				content: "Newer follow-up recorded directly on LXC server.",
				timestamp: 1795075200000,
			});
			fs.writeFileSync(serverChatPath, `${JSON.stringify(serverChat, null, "\t")}\n`, "utf8");

			const second = await ctrl.runMigrateCli([
				"import",
				"--bundle",
				bundleDir,
				"--target",
				targetDir,
				"--apply",
			]);
			expect(second.code).toBe(0);

			const preserved = JSON.parse(fs.readFileSync(serverChatPath, "utf8"));
			expect(preserved.updatedAt).toBe("2026-11-19T12:00:00.000Z");
			expect(preserved.messages.some((m) => m.id === "msg_synth_n01_03_server_newer")).toBe(true);
			expect(second.stdout + second.stderr).toMatch(/chat_synth_newer_01|newer|skip/i);
		} finally {
			await ctrl.cleanup();
		}
	});

	test("T2-F6-05: Equal updatedAt with divergent message content flags conflict and avoids silent overwrite", async () => {
		const ctrl = new ServerController({ id: "t2-f6-05" });
		const bundleDir = path.join(ctrl.rootDir, "bundle");
		const targetDir = path.join(ctrl.rootDir, "target");
		fs.mkdirSync(targetDir, { recursive: true });
		try {
			const exp = await ctrl.runMigrateCli([
				"export",
				"--source",
				syntheticFixtureDir(),
				"--out",
				bundleDir,
			]);
			expect(exp.code).toBe(0);
			expect(findBundleManifestPath(bundleDir)).toBeTruthy();

			const first = await ctrl.runMigrateCli([
				"import",
				"--bundle",
				bundleDir,
				"--target",
				targetDir,
				"--apply",
			]);
			expect(first.code).toBe(0);

			// Mutate message content while keeping identical updatedAt timestamp
			const serverChatPath = path.join(targetDir, "chats", "chat_synth_newer_01.json");
			const serverChat = JSON.parse(fs.readFileSync(serverChatPath, "utf8"));
			serverChat.messages[0] = {
				id: "msg_synth_n01_divergent",
				role: "user",
				content: "Divergent server question with identical updatedAt.",
				timestamp: serverChat.messages[0].timestamp,
			};
			fs.writeFileSync(serverChatPath, `${JSON.stringify(serverChat, null, "\t")}\n`, "utf8");

			const second = await ctrl.runMigrateCli([
				"import",
				"--bundle",
				bundleDir,
				"--target",
				targetDir,
				"--apply",
			]);
			const after = JSON.parse(fs.readFileSync(serverChatPath, "utf8"));
			expect(after.messages.some((m) => m.id === "msg_synth_n01_divergent")).toBe(true);
			expect(second.stdout + second.stderr).toMatch(/chat_synth_newer_01|conflict|diver|skip|preserve/i);
		} finally {
			await ctrl.cleanup();
		}
	});

	test("T2-F6-06: Incompatible future schema version (version: 99) rejected safely without target corruption", async () => {
		const ctrl = new ServerController({ id: "t2-f6-06" });
		const bundleDir = path.join(ctrl.rootDir, "bundle");
		const futureChatBundle = path.join(ctrl.rootDir, "future-chat-bundle");
		const futureManifestBundle = path.join(ctrl.rootDir, "future-manifest-bundle");
		const futureGraphBundle = path.join(ctrl.rootDir, "future-graph-bundle");
		const targetDir = path.join(ctrl.rootDir, "target");
		fs.mkdirSync(targetDir, { recursive: true });
		try {
			const exp = await ctrl.runMigrateCli([
				"export",
				"--source",
				syntheticFixtureDir(),
				"--out",
				bundleDir,
			]);
			expect(exp.code).toBe(0);
			expect(findBundleManifestPath(bundleDir)).toBeTruthy();

			const baselineImp = await ctrl.runMigrateCli([
				"import",
				"--bundle",
				bundleDir,
				"--target",
				targetDir,
				"--apply",
			]);
			expect(baselineImp.code).toBe(0);

			// Case A: future chat record version: 99
			fs.cpSync(bundleDir, futureChatBundle, { recursive: true });
			const futureChatPath = path.join(futureChatBundle, "chats", "chat_synth_newer_01.json");
			const futureChat = JSON.parse(fs.readFileSync(futureChatPath, "utf8"));
			futureChat.version = 99;
			futureChat.updatedAt = "2099-01-01T00:00:00.000Z";
			fs.writeFileSync(futureChatPath, `${JSON.stringify(futureChat, null, "\t")}\n`, "utf8");

			const chatVerImp = await ctrl.runMigrateCli([
				"import",
				"--bundle",
				futureChatBundle,
				"--target",
				targetDir,
				"--apply",
			]);
			const targetChat = JSON.parse(
				fs.readFileSync(path.join(targetDir, "chats", "chat_synth_newer_01.json"), "utf8"),
			);
			expect(targetChat.version).not.toBe(99);
			expect(chatVerImp.code !== 0 || /version|schema|unsupported|skip/i.test(chatVerImp.stdout + chatVerImp.stderr)).toBe(true);

			// Case B: future manifest formatVersion / version: 99
			fs.cpSync(bundleDir, futureManifestBundle, { recursive: true });
			const manifestPath = findBundleManifestPath(futureManifestBundle);
			expect(manifestPath).toBeTruthy();
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
			if ("formatVersion" in manifest) manifest.formatVersion = 99;
			else manifest.version = 99;
			fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");

			const manifestVerImp = await ctrl.runMigrateCli([
				"import",
				"--bundle",
				futureManifestBundle,
				"--target",
				targetDir,
				"--apply",
			]);
			expect(manifestVerImp.code).not.toBe(0);

			// Case C: future graph/format.json version: 99
			fs.cpSync(bundleDir, futureGraphBundle, { recursive: true });
			const bundleGraphFormatPath = path.join(futureGraphBundle, "graph", "format.json");
			if (fs.existsSync(bundleGraphFormatPath)) {
				fs.writeFileSync(bundleGraphFormatPath, JSON.stringify({ version: 99 }, null, "\t") + "\n", "utf8");
				const graphVerImp = await ctrl.runMigrateCli([
					"import",
					"--bundle",
					futureGraphBundle,
					"--target",
					targetDir,
					"--apply",
				]);
				const targetGraphFormat = JSON.parse(
					fs.readFileSync(path.join(targetDir, "graph", "format.json"), "utf8"),
				);
				expect(targetGraphFormat.version).not.toBe(99);
				expect(
					graphVerImp.code !== 0 ||
						/version|schema|unsupported|format|skip/i.test(graphVerImp.stdout + graphVerImp.stderr),
				).toBe(true);
			}
		} finally {
			await ctrl.cleanup();
		}
	});
});
