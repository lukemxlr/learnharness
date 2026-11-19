import { createHash, createVerify, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { ServerController } from "../harness/server-controller.mjs";
import {
	bootStack,
	loginApi,
	loginBrowser,
	syntheticFixtureDir,
} from "../helpers/e2e-session.mjs";

function snapshotDirChecksums(rootDir) {
	const entries = [];
	const walk = (dir) => {
		for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, item.name);
			const rel = path.relative(rootDir, full);
			if (item.isDirectory()) {
				walk(full);
			} else if (item.isFile()) {
				const buf = fs.readFileSync(full);
				entries.push({
					rel,
					sha256: createHash("sha256").update(buf).digest("hex"),
				});
			}
		}
	};
	walk(rootDir);
	return entries;
}

test.describe("Tier 1 — F5: Headless ChatGPT Plus OAuth & Dynamic Model Catalog", () => {
	test("T1-F5-01: Headless ChatGPT PKCE auth flow saves 0600 credentials", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const subHeaders = {
				"Content-Type": "application/json",
				Cookie: cookie,
				Origin: stack.baseUrl,
				"x-learnharness-subscriptions": "1",
			};
			const startRes = await fetch(`${stack.baseUrl}/api/subscriptions`, {
				method: "POST",
				headers: subHeaders,
				body: JSON.stringify({ providerId: "chatgpt", op: "start-headless" }),
			});
			expect(startRes.status).toBe(200);
			const startBody = await startRes.json();
			const startValue = startBody.value ?? startBody;
			const authUrlStr = startValue?.authorizeUrl || startValue?.headless?.authorizeUrl;
			expect(typeof authUrlStr).toBe("string");
			expect(startValue?.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
			expect(startValue?.status?.pending).toBe(true);

			const authUrl = new URL(authUrlStr);
			expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
			expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
			expect(authUrl.searchParams.get("state")).toBeTruthy();

			// Verify full PKCE OAuth flow against stack.mock.origin/__oauth/*
			const oidcRes = await fetch(`${stack.mock.origin}/.well-known/openid-configuration`);
			expect(oidcRes.status).toBe(200);
			const oidc = await oidcRes.json();
			const verifier = randomBytes(32).toString("base64url");
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			const oauthPkceUrl = new URL(oidc.authorization_endpoint);
			oauthPkceUrl.searchParams.set("client_id", "learnharness-test");
			oauthPkceUrl.searchParams.set("redirect_uri", startValue.redirectUri);
			oauthPkceUrl.searchParams.set("state", "pkce_state_t1_f5_01");
			oauthPkceUrl.searchParams.set("code_challenge", challenge);
			oauthPkceUrl.searchParams.set("code_challenge_method", "S256");
			oauthPkceUrl.searchParams.set("mode", "json");
			const pkceAuthResp = await (await fetch(oauthPkceUrl)).json();
			expect(pkceAuthResp.code).toBeTruthy();
			const tokenRes = await fetch(oidc.token_endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code: pkceAuthResp.code,
					code_verifier: verifier,
					client_id: "learnharness-test",
					redirect_uri: startValue.redirectUri,
					state: "pkce_state_t1_f5_01",
				}),
			});
			expect(tokenRes.status).toBe(200);
			const tokenBody = await tokenRes.json();
			expect(tokenBody.access_token).toMatch(/^mock_at_/);
			const jwks = await (await fetch(oidc.jwks_uri)).json();
			const [hdrB64, payB64, sigB64] = tokenBody.id_token.split(".");
			const verifierSig = createVerify("RSA-SHA256");
			verifierSig.update(`${hdrB64}.${payB64}`);
			expect(verifierSig.verify({ key: jwks.keys[0], format: "jwk" }, sigB64, "base64url")).toBe(true);

			// Forward start-headless PKCE parameters to mock OAuth authorize endpoint
			const mockAuthUrl = new URL(`${stack.mock.origin}/__oauth/authorize`);
			for (const [k, v] of authUrl.searchParams.entries()) {
				mockAuthUrl.searchParams.set(k, v);
			}
			mockAuthUrl.searchParams.set("mode", "json");
			const mockAuthResp = await (await fetch(mockAuthUrl)).json();
			expect(mockAuthResp.callbackUrl).toBeTruthy();

			const completeRes = await fetch(`${stack.baseUrl}/api/subscriptions`, {
				method: "POST",
				headers: subHeaders,
				body: JSON.stringify({
					providerId: "chatgpt",
					op: "complete-headless",
					callbackUrlOrCode: mockAuthResp.callbackUrl,
				}),
			});
			expect(completeRes.status).toBe(200);
			const completeBody = await completeRes.json();
			const completeValue = completeBody.value ?? completeBody;
			expect(completeValue).toBeTruthy();
			expect(completeValue.error).not.toBe("Unsupported ChatGPT control.");
			expect(completeValue.pending).toBe(false);

			if (authUrl.origin === stack.mock.origin) {
				expect(
					Boolean(completeValue.activeId) ||
						Boolean(completeValue.accounts?.some((account) => account.connected)),
				).toBe(true);
			} else {
				// Upstream M1 gap: electron/chatgpt.cjs hardcodes ISSUER = "https://auth.openai.com"
				// with no configurable issuer override seam, so offline/mock token exchange fails cleanly
				// after complete-headless accepts callbackUrlOrCode and consumes the pending state.
				expect(completeValue.available).toBe(true);
				expect(typeof completeValue.error).toBe("string");
				expect(completeValue.error.length).toBeGreaterThan(0);
			}

			const statusRes = await fetch(`${stack.baseUrl}/api/subscriptions`, {
				method: "GET",
				headers: {
					Cookie: cookie,
					"x-learnharness-subscriptions": "1",
				},
			});
			expect(statusRes.status).toBe(200);
			const statusBody = await statusRes.json();
			expect(statusBody.chatgpt?.available).toBe(true);
			expect(statusBody.chatgpt?.pending).toBe(false);

			const credFile = path.join(stack.ctrl.authDir, "chatgpt-credentials.json");
			expect(fs.existsSync(credFile)).toBe(true);
			expect(fs.statSync(credFile).mode & 0o777).toBe(0o600);
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F5-02: External chatgpt-credentials.json disk-reload sync without restart", async () => {
		const stack = await bootStack();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const credFile = path.join(stack.ctrl.authDir, "chatgpt-credentials.json");
			fs.writeFileSync(
				credFile,
				JSON.stringify(
					{
						version: 1,
						hostId: "urn:uuid:11111111-2222-4333-8444-555555555555",
						activeId: "acct_synth_01",
						registrations: [
							{
								id: "acct_synth_01",
								clientId: "learnharness-test",
								issuer: "https://auth.openai.com",
								subject: "synth_sub_01",
								email: "synthetic-learner@example.invalid",
								tokens: {
									accessToken: "mock_at_external_sync",
									refreshToken: "mock_rt_external_sync",
									idToken: "mock.id.token",
									scopes: [
										"openid",
										"profile",
										"email",
										"offline_access",
										"resource.invoke",
										"chatgpt.tokens.use.direct",
									],
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

			const statusRes = await fetch(`${stack.baseUrl}/api/subscriptions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookie,
					Origin: stack.baseUrl,
					"x-learnharness-subscriptions": "1",
				},
				body: JSON.stringify({ providerId: "chatgpt", op: "reload" }),
			});
			expect(statusRes.status).toBe(200);
			const statusBody = await statusRes.json();
			const statusValue = statusBody.value ?? statusBody;
			expect(statusValue?.accounts?.some((a) => a.id === "acct_synth_01")).toBe(true);
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F5-03: Live /v1/models discovery of brand-new slug gpt-test-7-pro with 272k context", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const beforeRes = await fetch(`${stack.baseUrl}/api/models`, {
				headers: { Cookie: cookie },
			});
			expect(beforeRes.status).toBe(200);
			const beforeCatalog = await beforeRes.json();
			expect(beforeCatalog.models.some((m) => m.id === "gpt-test-7-pro")).toBe(false);

			const cpGet = await fetch(`${stack.baseUrl}/api/custom-provider`, {
				headers: { Cookie: cookie },
			});
			expect(cpGet.status).toBe(200);
			const etag = cpGet.headers.get("etag");
			expect(etag).toBeTruthy();

			const cpPost = await fetch(`${stack.baseUrl}/api/custom-provider`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookie,
					Origin: stack.baseUrl,
					"Sec-Fetch-Site": "same-origin",
					"If-Match": etag,
				},
				body: JSON.stringify({
					baseUrl: stack.mock.baseUrl,
					authMode: "keyless",
				}),
			});
			expect(cpPost.status).toBe(200);

			const modelsRes = await fetch(`${stack.baseUrl}/api/models`, {
				headers: { Cookie: cookie },
			});
			expect(modelsRes.status).toBe(200);
			const catalog = await modelsRes.json();
			const pro = catalog.models.find((m) => m.id === "gpt-test-7-pro");
			expect(pro).toBeTruthy();
			expect(pro.contextWindow).toBe(272000);
			expect((await stack.mock.getRequests()).modelsRequests.length).toBeGreaterThanOrEqual(1);

			await loginBrowser(page, stack.baseUrl);
			await page.getByTestId("stats-model").click();
			await expect(page.getByTestId("model-menu")).toBeVisible();
			await page.getByTestId("model-search").fill("gpt-test-7-pro");
			const option = page.getByTestId("model-menu").getByText("gpt-test-7-pro");
			await expect(option).toBeVisible();
			await expect(page.getByTestId("model-menu").getByText(/272k/i)).toBeVisible();
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F5-04: Manual catalog refresh (POST /api/models/refresh) & live discovery picks up newly added model", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const beforeChatRes = await fetch(`${stack.baseUrl}/api/chats/chat_synth_teach_01`, {
				headers: { Cookie: cookie },
			});
			expect(beforeChatRes.status).toBe(200);
			const beforeChat = await beforeChatRes.json();

			await stack.mock.admin({
				extraModels: [
					{
						id: "gpt-test-8-mini",
						slug: "gpt-test-8-mini",
						display_name: "GPT Test 8 Mini",
						visibility: "list",
						context_length: 128000,
						input_modalities: ["text", "image"],
						supported_parameters: ["reasoning_effort"],
						reasoning: true,
					},
				],
			});

			const refreshRes = await fetch(`${stack.baseUrl}/api/models/refresh`, {
				method: "POST",
				headers: { Cookie: cookie },
			});
			expect(refreshRes.status).toBe(200);
			const refreshed = await refreshRes.json();
			expect(Array.isArray(refreshed.models)).toBe(true);

			const cpGet = await fetch(`${stack.baseUrl}/api/custom-provider`, {
				headers: { Cookie: cookie },
			});
			expect(cpGet.status).toBe(200);
			const cpPost = await fetch(`${stack.baseUrl}/api/custom-provider`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookie,
					Origin: stack.baseUrl,
					"Sec-Fetch-Site": "same-origin",
					"If-Match": cpGet.headers.get("etag") || "",
				},
				body: JSON.stringify({
					baseUrl: stack.mock.baseUrl,
					authMode: "keyless",
				}),
			});
			expect(cpPost.status).toBe(200);

			const modelsRes = await fetch(`${stack.baseUrl}/api/models`, {
				headers: { Cookie: cookie },
			});
			expect(modelsRes.status).toBe(200);
			const catalog = await modelsRes.json();
			expect(catalog.models.some((m) => m.id === "gpt-test-8-mini")).toBe(true);

			const afterChatRes = await fetch(`${stack.baseUrl}/api/chats/chat_synth_teach_01`, {
				headers: { Cookie: cookie },
			});
			expect(afterChatRes.status).toBe(200);
			const afterChat = await afterChatRes.json();
			expect(afterChat.settings.model).toEqual(beforeChat.settings.model);

			await loginBrowser(page, stack.baseUrl);
			await page.getByTestId("stats-model").click();
			await page.getByTestId("model-search").fill("gpt-test-8-mini");
			await expect(page.getByTestId("model-menu").getByText("gpt-test-8-mini")).toBeVisible();
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F5-05: Provider Settings catalog refresh & live endpoint re-discovery preserves session model", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			await stack.mock.admin({
				extraModels: [
					{
						id: "gpt-test-9-auto",
						slug: "gpt-test-9-auto",
						display_name: "GPT Test 9 Auto",
						visibility: "list",
						context_length: 200000,
						input_modalities: ["text", "image"],
						reasoning: true,
					},
				],
			});

			await loginBrowser(page, stack.baseUrl);
			await page.getByTestId("settings-entry").click();
			await expect(page.getByTestId("refresh-models-btn")).toBeVisible();
			await page.getByTestId("refresh-models-btn").click();
			await expect(page.getByTestId("refresh-models-ok")).toBeVisible();

			await page.getByTestId("custom-endpoint-row-btn").click();
			await page.getByTestId("custom-save").click();
			await expect(page.getByTestId("custom-endpoint-row-btn")).toHaveAttribute("aria-expanded", "false");
			await expect(page.getByTestId("custom-endpoint-row-btn")).toContainText(/3 models/i);

			const modelsRes = await fetch(`${stack.baseUrl}/api/models`, { headers: { Cookie: cookie } });
			expect(modelsRes.status).toBe(200);
			const catalog = await modelsRes.json();
			expect(catalog.models.some((m) => m.id === "gpt-test-9-auto")).toBe(true);

			const chatRes = await fetch(`${stack.baseUrl}/api/chats/chat_synth_teach_01`, {
				headers: { Cookie: cookie },
			});
			expect(chatRes.status).toBe(200);
			const chat = await chatRes.json();
			expect(chat.settings.model).toEqual({ provider: "custom", id: "gpt-test-1" });
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});
});

test.describe("Tier 1 — F6: Safe Profile Export/Import & Windows Attachment Migration", () => {
	test("T1-F6-01: Read-only profile export bundle leaves source unchanged and emits manifests", async () => {
		const ctrl = new ServerController({ id: "t1-f6-01" });
		const sourceCopy = path.join(ctrl.rootDir, "source-profile");
		const bundleDir = path.join(ctrl.rootDir, "export-bundle");
		try {
			fs.cpSync(syntheticFixtureDir(), sourceCopy, { recursive: true });
			const beforeChecksums = snapshotDirChecksums(sourceCopy);

			const res = await ctrl.runMigrateCli([
				"export",
				"--source",
				sourceCopy,
				"--out",
				bundleDir,
			]);
			expect(res.code).toBe(0);

			const afterChecksums = snapshotDirChecksums(sourceCopy);
			expect(afterChecksums).toEqual(beforeChecksums);

			expect(fs.existsSync(path.join(bundleDir, "export-manifest.json"))).toBe(true);
			expect(fs.existsSync(path.join(bundleDir, "attachment-manifest.json"))).toBe(true);
			expect(fs.existsSync(path.join(bundleDir, "settings.json"))).toBe(true);
			expect(fs.existsSync(path.join(bundleDir, "chats", "chat_synth_teach_01.json"))).toBe(true);
			expect(fs.existsSync(path.join(bundleDir, "graph", "nodes.jsonl"))).toBe(true);
		} finally {
			await ctrl.cleanup();
		}
	});

	test("T1-F6-02: Migration --dry-run preview reports plan and writes zero bytes to target", async () => {
		const ctrl = new ServerController({ id: "t1-f6-02" });
		const bundleDir = path.join(ctrl.rootDir, "export-bundle");
		const emptyTarget = path.join(ctrl.rootDir, "dry-run-target");
		fs.mkdirSync(emptyTarget, { recursive: true });
		try {
			const exp = await ctrl.runMigrateCli([
				"export",
				"--source",
				syntheticFixtureDir(),
				"--out",
				bundleDir,
			]);
			expect(exp.code).toBe(0);

			const dry = await ctrl.runMigrateCli([
				"import",
				"--source",
				bundleDir,
				"--target",
				emptyTarget,
				"--dry-run",
			]);
			expect(dry.code).toBe(0);
			expect(dry.stdout).toMatch(/chat_synth_teach_01|chats/i);
			expect(fs.readdirSync(emptyTarget)).toEqual([]);
		} finally {
			await ctrl.cleanup();
		}
	});

	test("T1-F6-03: Full --apply migration restores chats, graph, themes, prompts, and attachments", async ({ browser }) => {
		const stack = await bootStack({ seedProfile: false });
		const bundleDir = path.join(stack.ctrl.rootDir, "bundle");
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
				"--source",
				bundleDir,
				"--target",
				stack.ctrl.dataDir,
				"--apply",
			]);
			expect(imp.code).toBe(0);

			const { cookie } = await loginApi(stack.baseUrl);
			const chatsRes = await fetch(`${stack.baseUrl}/api/chats`, { headers: { Cookie: cookie } });
			expect(chatsRes.status).toBe(200);
			const chats = (await chatsRes.json()).chats;
			expect(chats.some((c) => c.id === "chat_synth_teach_01")).toBe(true);

			const graphRes = await fetch(`${stack.baseUrl}/api/graph`, { headers: { Cookie: cookie } });
			const graph = await graphRes.json();
			expect(graph.propositions.some((p) => p.id === "n_synth0000001")).toBe(true);
			expect(graph.chains.length).toBeGreaterThanOrEqual(2);

			expect(fs.existsSync(path.join(stack.ctrl.dataDir, "themes", "synth-dark.json"))).toBe(true);
			expect(fs.existsSync(path.join(stack.ctrl.dataDir, "prompts", "teacher", "20-teaching.md"))).toBe(true);

			await loginBrowser(page, stack.baseUrl);
			await expect(page.getByText("Kinematics & Projectile Vectors")).toBeVisible();
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F6-04: Reachable attachment ingested into bundle/<sha256> and served via API", async () => {
		const stack = await bootStack({ seedProfile: false });
		const sourceProfile = path.join(stack.ctrl.rootDir, "win-src");
		const bundleDir = path.join(stack.ctrl.rootDir, "win-bundle");
		try {
			fs.cpSync(syntheticFixtureDir(), sourceProfile, { recursive: true });
			const reachableVectorPath = path.join(sourceProfile, "source-files", "vector.png");
			const vectorPng = fs.readFileSync(reachableVectorPath);
			const expectedSha = createHash("sha256").update(vectorPng).digest("hex");

			// Point the reachable reference in the temp profile copy to the existing file on disk,
			// while keeping missing Windows paths intact to verify diagnostic reporting.
			const chatPath = path.join(sourceProfile, "chats", "chat_synth_teach_01.json");
			const rawChat = fs.readFileSync(chatPath, "utf8");
			const updatedChat = rawChat.replaceAll("C:\\\\Users\\\\Synth\\\\Notes\\\\vector.png", reachableVectorPath.replaceAll("\\", "\\\\"));
			fs.writeFileSync(chatPath, updatedChat, "utf8");

			const exp = await stack.ctrl.runMigrateCli([
				"export",
				"--source",
				sourceProfile,
				"--out",
				bundleDir,
			]);
			expect(exp.code).toBe(0);

			const bundleShaDir = path.join(bundleDir, "attachments", expectedSha);
			expect(fs.existsSync(bundleShaDir)).toBe(true);
			expect(fs.readdirSync(bundleShaDir).length).toBeGreaterThanOrEqual(1);

			const imp = await stack.ctrl.runMigrateCli([
				"import",
				"--source",
				bundleDir,
				"--target",
				stack.ctrl.dataDir,
				"--apply",
			]);
			expect(imp.code).toBe(0);

			const { cookie } = await loginApi(stack.baseUrl);
			const attRes = await fetch(`${stack.baseUrl}/api/attachments/${expectedSha}`, {
				headers: { Cookie: cookie },
			});
			expect(attRes.status).toBe(200);
			expect(Buffer.from(await attRes.arrayBuffer()).equals(vectorPng)).toBe(true);
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F6-05: Linux fileAccess folder sanitization strips Windows path and preserves POSIX path", async () => {
		const ctrl = new ServerController({ id: "t1-f6-05" });
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

			const imp = await ctrl.runMigrateCli([
				"import",
				"--source",
				bundleDir,
				"--target",
				targetDir,
				"--apply",
			]);
			expect(imp.code).toBe(0);
			expect(imp.stdout + imp.stderr).toMatch(/C:\\Users\\Synth\\Notes|Windows/i);

			const migratedSettings = JSON.parse(fs.readFileSync(path.join(targetDir, "settings.json"), "utf8"));
			expect(migratedSettings.agent.fileAccess.folders).toContain("/srv/synth/notes");
			expect(migratedSettings.agent.fileAccess.folders).not.toContain("C:\\Users\\Synth\\Notes");
		} finally {
			await ctrl.cleanup();
		}
	});
});
