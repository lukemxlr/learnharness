import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { after, describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const require = createRequire(import.meta.url);
const { createChatGPT, fileStore, SCOPES } = require("../electron/chatgpt.cjs");
const { chatGPTControl } = require("../electron/chatgpt-ipc.cjs");

const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), kid: "headless-key", alg: "RS256", use: "sig" };
const tokenUrl = "https://auth.openai.com/api/accounts/oauth/token";

async function signedIdToken(clientId: string, nonce: string, subject = "headless-sub") {
	return new SignJWT({ nonce, email: "headless@example.invalid" })
		.setProtectedHeader({ alg: "RS256", kid: "headless-key" })
		.setIssuer("https://auth.openai.com")
		.setSubject(subject)
		.setAudience(clientId)
		.setIssuedAt()
		.setExpirationTime("1h")
		.sign(privateKey);
}

describe("Headless ChatGPT OAuth, reload, and dynamic model catalog (F5)", () => {
	const tempDirs: string[] = [];
	after(async () => {
		while (tempDirs.length > 0) {
			await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("completes headless PKCE flow without openExternal, rejects bad paste without aborting pending, and rejects headless ops in desktop IPC guard", async () => {
		let failModels = false;
		let openCalls = 0;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-headless-cg-"));
		tempDirs.push(dir);
		const credPath = path.join(dir, "chatgpt-credentials.json");

		const service = createChatGPT({
			store: fileStore(credPath),
			openExternal: async () => { openCalls++; },
			fetch: async (target: string, init: RequestInit = {}) => {
				if (target.endsWith("jwks.json")) return Response.json({ keys: [jwk] });
				if (target === tokenUrl) {
					const form = init.body as URLSearchParams;
					const clientId = form.get("client_id")!;
					const nonce = new URL(started.authorizeUrl).searchParams.get("nonce")!;
					return Response.json({
						access_token: "headless-access-token",
						refresh_token: "headless-refresh-token",
						id_token: await signedIdToken(clientId, nonce),
						token_type: "Bearer",
						expires_in: 3600,
						scope: SCOPES.join(" "),
					});
				}
				if (target.endsWith("/models")) {
					if (failModels) return new Response(null, { status: 503 });
					return Response.json({
						models: [
							{
								slug: "gpt-5.3-codex",
								display_name: "GPT-5.3 Codex",
								visibility: "list",
								context_length: 256_000,
								max_output_tokens: 32_768,
								input_modalities: ["text", "image"],
								supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
							},
						],
					});
				}
				throw new Error(`Unexpected fetch: ${target}`);
			},
		});

		let started!: { authorizeUrl: string; redirectUri: string; status: any };
		try {
			started = await service.startHeadlessAuth();
			assert.equal(openCalls, 0, "headless OAuth must not invoke openExternal");
			const authUrl = new URL(started.authorizeUrl);
			assert.equal(authUrl.origin, "https://auth.openai.com");
			const state = authUrl.searchParams.get("state")!;
			const redirectUri = authUrl.searchParams.get("redirect_uri")!;

			// Bad state or bare code on first sign-in fails WITHOUT consuming pending
			const badReply = await chatGPTControl({ op: "complete-headless", callbackUrlOrCode: `${redirectUri}?code=abc&state=wrong&client_id=oaiapp_1` }, service);
			assert.match(badReply.error ?? "", /state/i);
			assert.equal((await service.status()).pending, true, "bad paste must keep pending attempt alive");

			const bareReply = await chatGPTControl({ op: "complete-headless", callbackUrlOrCode: "bare-code-only" }, service);
			assert.match(bareReply.error ?? "", /full redirect URL/i);
			assert.equal((await service.status()).pending, true);

			// Valid callback URL completes headless login
			const done = await service.completeHeadlessAuth(`${redirectUri}?code=valid-code&state=${state}&client_id=oaiapp_headless`);
			assert.equal(done.pending, false);
			assert.equal(done.accounts.length, 1);
			assert.equal(done.accounts[0].connected, true);

			// Preserves metadata from /v1/models
			const catalog1 = await service.models();
			assert.equal(catalog1.models.length, 1);
			assert.deepEqual(catalog1.models[0], {
				id: "gpt-5.3-codex",
				name: "GPT-5.3 Codex",
				contextWindow: 256_000,
				maxTokens: 32_768,
				input: ["text", "image"],
				reasoning: true,
				supportedReasoningLevels: ["low", "high"],
			});
			const revBeforeError = catalog1.authorityRevision;

			// Transient /v1/models failure retains last-known-good catalog and does NOT bump authorityRevision
			failModels = true;
			const catalogErr = await service.models();
			assert.equal(catalogErr.models.length, 1);
			assert.equal(catalogErr.models[0].id, "gpt-5.3-codex");
			assert.equal(catalogErr.authorityRevision, revBeforeError, "transient error must not bump authorityRevision");
			assert(catalogErr.status.catalogError);
		} finally {
			service.close();
		}
	});

	it("reload() picks up external disk updates while respecting storageDenied fail-closed invariant", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-reload-cg-"));
		tempDirs.push(dir);
		const credPath = path.join(dir, "chatgpt-credentials.json");

		const service = createChatGPT({
			store: fileStore(credPath),
			openExternal: async () => {},
			fetch: async () => Response.json({ models: [] }),
		});
		try {
			const s1 = await service.status();
			assert.equal(s1.accounts.length, 0);

			// Simulate external CLI writing credentials to disk
			const nextDiskState = {
				version: 1,
				hostId: "urn:uuid:00000000-0000-4000-8000-000000000002",
				activeId: "ext-acc-1",
				registrations: [
					{
						id: "ext-acc-1",
						clientId: "oaiapp_ext",
						issuer: "https://auth.openai.com",
						subject: "ext-sub",
						email: "ext@example.invalid",
						tokens: {
							accessToken: "ext-access",
							refreshToken: "ext-refresh",
							idToken: "ext-id",
							scopes: SCOPES,
							expiresAt: Date.now() + 3600_000,
						},
					},
				],
			};
			await new Promise((r) => setTimeout(r, 20));
			await fs.writeFile(credPath, JSON.stringify(nextDiskState), { mode: 0o600 });

			const reloaded = await service.reload();
			assert.equal(reloaded.activeId, "ext-acc-1");
			assert.equal(reloaded.accounts[0].connected, true);
		} finally {
			service.close();
		}

		// Verify storageDenied remains strictly fail-closed on reload()
		let reads = 0;
		let failWrite = false;
		const denied = createChatGPT({
			store: {
				async changedExternally() { return true; },
				async read() {
					reads++;
					return { version: 1, hostId: "urn:uuid:00000000-0000-4000-8000-000000000009", activeId: null, registrations: [] };
				},
				async write() {
					if (failWrite) throw Object.assign(new Error("storage"), { code: "storage" });
				},
			},
			openExternal: async () => {},
			fetch: async () => Response.json({ models: [] }),
		});
		try {
			await denied.status();
			assert.equal(reads, 1);
			failWrite = true;
			await assert.rejects(denied.consent(false), /storage/);
			failWrite = false;
			await denied.reload();
			assert.equal(reads, 1, "reload() must never read disk after storageDenied");
			assert.match((await denied.status()).error ?? "", /could not be read or saved/i);
			await assert.rejects(
				denied.lease(false, { expectedAccountId: "x", expectedAuthorityRevision: 0, selectedModelId: "gpt-5" }),
				/disconnected/,
			);
		} finally {
			denied.close();
		}
	});

	it("chatgpt-bridge synthesizes new slugs, retains catalog on transient error, TTL caches refreshConnectionCatalog, POST /api/models/refresh forces refresh, and chat.settings.model stays immutable", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-bridge-ttl-"));
		tempDirs.push(dir);
		const authFile = path.join(dir, "auth.json");
		const dataDir = path.join(dir, "data");
		await fs.mkdir(dataDir, { recursive: true });
		await fs.writeFile(authFile, "{}\n", { mode: 0o600 });

		let modelFetchCount = 0;
		let failModels = false;
		const credPath = path.join(dir, "chatgpt-credentials.json");
		await fs.writeFile(
			credPath,
			JSON.stringify({
				version: 1,
				hostId: "urn:uuid:00000000-0000-4000-8000-000000000003",
				activeId: "acc-1",
				registrations: [
					{
						id: "acc-1",
						clientId: "oaiapp_1",
						issuer: "https://auth.openai.com",
						subject: "sub-1",
						email: "user@example.invalid",
						tokens: {
							accessToken: "test-cg-access",
							refreshToken: "test-cg-refresh",
							idToken: "test-cg-id",
							scopes: SCOPES,
							expiresAt: Date.now() + 3600_000,
						},
					},
				],
			}),
			{ mode: 0o600 },
		);

		const prevAuth = process.env.LH_AUTH_FILE;
		const prevData = process.env.LH_DATA_DIR;
		const prevDesktop = process.env.LH_DESKTOP_SERVER;
		const prevSecret = process.env.LH_DESKTOP_API_SECRET;
		const realFetch = globalThis.fetch;

		process.env.LH_AUTH_FILE = authFile;
		process.env.LH_DATA_DIR = dataDir;
		delete process.env.LH_DESKTOP_SERVER;
		delete process.env.LH_DESKTOP_API_SECRET;

		globalThis.fetch = (async (input: unknown) => {
			if (String(input) === "https://api.openai.com/v1/models") {
				modelFetchCount++;
				if (failModels) return new Response(null, { status: 502 });
				return Response.json({
					models: [
						{
							slug: "gpt-5.4-experimental",
							display_name: "GPT-5.4 Experimental",
							visibility: "list",
							context_length: 300_000,
							max_output_tokens: 64_000,
							input_modalities: ["text", "image"],
							supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }],
						},
					],
				});
			}
			throw new Error(`Unexpected fetch: ${String(input)}`);
		}) as typeof fetch;

		try {
			const suffix = `?f5=${Date.now()}`;
			const { chatStore } = await import(`../src/store/chats.ts${suffix}`);
			const { refreshConnectionCatalog, modelCatalog, validateModelsSettings } = await import(`../src/server/model-catalog.ts${suffix}`);
			const { POST: refreshPost } = await import(`../app/api/models/refresh/route.ts${suffix}`);
			const { webSubscriptionOwner } = await import(`../src/server/web-subscriptions.ts${suffix}`);
			const { piEngineForSpec } = await import(`../src/agent/models.ts${suffix}`);

			// Create a chat with an explicit chat.settings.model to prove refresh never mutates it
			const chat = chatStore.createChat("Model Immutability Test");
			chatStore.saveSettings(chat.id, { model: { provider: "openai", id: "gpt-4o" } });

			await refreshConnectionCatalog("chatgpt", { force: true });
			assert.equal(modelFetchCount, 1);

			const cat = modelCatalog();
			const synth = cat.models.find((m: any) => m.provider === "chatgpt" && m.id === "gpt-5.4-experimental");
			assert(synth, "unknown slug must be synthesized into catalog");
			assert.equal(synth.contextWindow, 300_000);
			assert.equal(synth.maxTokens, 64_000);
			assert.deepEqual(synth.input, ["text", "image"]);
			assert.deepEqual(synth.supportedLevels, ["medium", "high"]);
			assert.equal(validateModelsSettings({ strong: { model: { provider: "chatgpt", id: "gpt-5.4-experimental" } } }).ok, true);
			assert.equal(piEngineForSpec({ provider: "chatgpt", id: "gpt-5.4-experimental" }, false).model.api, "openai-responses");

			// Second call within TTL must NOT hit /v1/models again
			await refreshConnectionCatalog("chatgpt");
			assert.equal(modelFetchCount, 1, "TTL cache should skip redundant /v1/models fetch");

			// POST /api/models/refresh forces fetch; transient error retains models and reports catalogErrors
			failModels = true;
			const refreshRes = await refreshPost(new Request("http://localhost:3000/api/models/refresh", { method: "POST" }));
			assert.equal(refreshRes.status, 200);
			assert.equal(modelFetchCount, 2, "POST /api/models/refresh must bypass TTL");
			const refreshBody = await refreshRes.json();
			assert(refreshBody.models.some((m: any) => m.id === "gpt-5.4-experimental"), "last-known-good model must remain on transient error");
			assert(refreshBody.catalogErrors?.chatgpt, "catalogErrors.chatgpt should surface non-destructively");

			// Existing chat.settings.model must remain untouched
			assert.deepEqual(chatStore.getChat(chat.id)?.settings, { model: { provider: "openai", id: "gpt-4o" } });

			webSubscriptionOwner().close();
		} finally {
			globalThis.fetch = realFetch;
			if (prevAuth === undefined) delete process.env.LH_AUTH_FILE; else process.env.LH_AUTH_FILE = prevAuth;
			if (prevData === undefined) delete process.env.LH_DATA_DIR; else process.env.LH_DATA_DIR = prevData;
			if (prevDesktop === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = prevDesktop;
			if (prevSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = prevSecret;
		}
	});

	it("coalesces concurrent initial-load and forced refreshConnectionCatalog calls to a single /v1/models fetch", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-coalesce-cg-"));
		tempDirs.push(dir);
		const authFile = path.join(dir, "auth.json");
		const dataDir = path.join(dir, "data");
		await fs.mkdir(dataDir, { recursive: true });
		await fs.writeFile(authFile, "{}\n", { mode: 0o600 });
		const credPath = path.join(dir, "chatgpt-credentials.json");
		await fs.writeFile(
			credPath,
			JSON.stringify({
				version: 1,
				hostId: "urn:uuid:00000000-0000-4000-8000-000000000004",
				activeId: "acc-coalesce",
				registrations: [
					{
						id: "acc-coalesce",
						clientId: "oaiapp_coalesce",
						issuer: "https://auth.openai.com",
						subject: "sub-coalesce",
						email: "coalesce@example.invalid",
						tokens: {
							accessToken: "test-coalesce-access",
							refreshToken: "test-coalesce-refresh",
							idToken: "test-coalesce-id",
							scopes: SCOPES,
							expiresAt: Date.now() + 3600_000,
						},
					},
				],
			}),
			{ mode: 0o600 },
		);

		const prevAuth = process.env.LH_AUTH_FILE;
		const prevData = process.env.LH_DATA_DIR;
		const prevDesktop = process.env.LH_DESKTOP_SERVER;
		const prevSecret = process.env.LH_DESKTOP_API_SECRET;
		const realFetch = globalThis.fetch;

		process.env.LH_AUTH_FILE = authFile;
		process.env.LH_DATA_DIR = dataDir;
		delete process.env.LH_DESKTOP_SERVER;
		delete process.env.LH_DESKTOP_API_SECRET;

		const { AUTH_FILE } = await import("../config.ts");
		const effectiveCredPath = path.join(path.dirname(AUTH_FILE), "chatgpt-credentials.json");
		const prevCredBytes = await fs.readFile(effectiveCredPath).catch(() => null);
		if (effectiveCredPath !== credPath) {
			await fs.mkdir(path.dirname(effectiveCredPath), { recursive: true });
			await fs.copyFile(credPath, effectiveCredPath);
		}

		let modelFetchCount = 0;
		globalThis.fetch = (async (input: unknown) => {
			if (String(input) === "https://api.openai.com/v1/models") {
				modelFetchCount++;
				await new Promise((r) => setTimeout(r, 25));
				return Response.json({
					models: [
						{ slug: "gpt-5.4-coalesced", display_name: "GPT-5.4 Coalesced", visibility: "list" },
					],
				});
			}
			throw new Error(`Unexpected fetch: ${String(input)}`);
		}) as typeof fetch;

		try {
			for (const sym of ["lh.webSubscriptions", "lh.chatgpt.bridge", "lh.modelCatalog.refreshCache", "lh.webSubscriptionRuntime"]) {
				Reflect.deleteProperty(globalThis, Symbol.for(sym));
			}
			const suffix = `?coalesce=${Date.now()}`;
			const { chatGPTConnected, chatGPTModels } = await import(`../src/agent/chatgpt-bridge.ts${suffix}`);
			const { refreshConnectionCatalog } = await import(`../src/server/model-catalog.ts${suffix}`);
			const { webSubscriptionOwner } = await import(`../src/server/web-subscriptions.ts${suffix}`);

			// Initialize bridge listener before consent() emits state packet, so
			// chatGPTConnected() === true and chatGPTModels().length === 0 (needsInitialChatGPT === true)
			// with 0 /v1/models fetches so far.
			assert.equal(chatGPTConnected(), false);
			const owner = webSubscriptionOwner();
			await owner.control("chatgpt", { op: "consent", enabled: true }, "http://localhost:3000");
			assert.equal(chatGPTConnected(), true);
			assert.equal(chatGPTModels().length, 0);
			assert.equal(modelFetchCount, 0);

			// 3 concurrent initial-load calls with needsInitialChatGPT=true must coalesce to 1 fetch
			await Promise.all([
				refreshConnectionCatalog("chatgpt"),
				refreshConnectionCatalog("chatgpt"),
				refreshConnectionCatalog("chatgpt"),
			]);
			assert.equal(modelFetchCount, 1, "3 concurrent initial-load calls with needsInitialChatGPT=true must coalesce to 1 fetch");
			assert.equal(chatGPTModels().length, 1);

			// 3 concurrent forced refreshes must also coalesce to 1 fetch
			await Promise.all([
				refreshConnectionCatalog("chatgpt", { force: true }),
				refreshConnectionCatalog("chatgpt", { force: true }),
				refreshConnectionCatalog("chatgpt", { force: true }),
			]);
			assert.equal(modelFetchCount, 2, "3 concurrent force refreshes must coalesce to 1 additional /v1/models fetch");

			owner.close();
			for (const sym of ["lh.webSubscriptions", "lh.chatgpt.bridge", "lh.modelCatalog.refreshCache", "lh.webSubscriptionRuntime"]) {
				Reflect.deleteProperty(globalThis, Symbol.for(sym));
			}
		} finally {
			globalThis.fetch = realFetch;
			if (effectiveCredPath !== credPath) {
				if (prevCredBytes) await fs.writeFile(effectiveCredPath, prevCredBytes, { mode: 0o600 });
				else await fs.rm(effectiveCredPath, { force: true });
			}
			if (prevAuth === undefined) delete process.env.LH_AUTH_FILE; else process.env.LH_AUTH_FILE = prevAuth;
			if (prevData === undefined) delete process.env.LH_DATA_DIR; else process.env.LH_DATA_DIR = prevData;
			if (prevDesktop === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = prevDesktop;
			if (prevSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = prevSecret;
		}
	});

	it("allows loopback OAuth & API overrides strictly in test/LH_IGNORE_ENV_KEYS mode and ignores non-loopback or production overrides", async () => {
		const env = process.env as Record<string, string | undefined>;
		const prevNodeEnv = env.NODE_ENV;
		const prevIgnore = env.LH_IGNORE_ENV_KEYS;
		const prevIssuer = env.LH_CHATGPT_OAUTH_ISSUER;
		const prevApi = env.LH_CHATGPT_API_BASE;

		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-loopback-seam-"));
		tempDirs.push(dir);
		const credPath = path.join(dir, "chatgpt-credentials.json");

		try {
			// 1. Loopback http://127.0.0.1 & http://localhost & http://[::1] work when NODE_ENV=test
			env.NODE_ENV = "test";
			delete env.LH_IGNORE_ENV_KEYS;
			env.LH_CHATGPT_OAUTH_ISSUER = "http://127.0.0.1:43210";
			env.LH_CHATGPT_API_BASE = "http://127.0.0.1:43210/v1";

			const fetchedUrls: string[] = [];
			const svc = createChatGPT({
				store: fileStore(credPath),
				openExternal: async () => {},
				fetch: async (target: string, init: RequestInit = {}) => {
					fetchedUrls.push(target);
					if (target === "http://127.0.0.1:43210/.well-known/jwks.json") return Response.json({ keys: [jwk] });
					if (target === "http://127.0.0.1:43210/api/accounts/oauth/token") {
						const form = init.body as URLSearchParams;
						assert.equal(form.get("resource"), "http://127.0.0.1:43210/v1");
						const nonce = new URL(started.authorizeUrl).searchParams.get("nonce")!;
						const idToken = await new SignJWT({ nonce, email: "loopback@example.invalid" })
							.setProtectedHeader({ alg: "RS256", kid: "headless-key" })
							.setIssuer("http://127.0.0.1:43210")
							.setSubject("loopback-sub")
							.setAudience(form.get("client_id")!)
							.setIssuedAt()
							.setExpirationTime("1h")
							.sign(privateKey);
						return Response.json({
							access_token: "loopback-access",
							refresh_token: "loopback-refresh",
							id_token: idToken,
							token_type: "Bearer",
							expires_in: 3600,
							scope: SCOPES.join(" "),
						});
					}
					if (target === "http://127.0.0.1:43210/v1/models") {
						return Response.json({ models: [{ slug: "gpt-loopback", display_name: "GPT Loopback", visibility: "list" }] });
					}
					throw new Error(`Unexpected fetch: ${target}`);
				},
			});
			let started!: { authorizeUrl: string; redirectUri: string; status: any };
			try {
				started = await svc.startHeadlessAuth();
				assert.equal(new URL(started.authorizeUrl).origin, "http://127.0.0.1:43210");
				assert.equal(new URL(started.authorizeUrl).searchParams.get("resource"), "http://127.0.0.1:43210/v1");
				const done = await svc.completeHeadlessAuth(
					`${started.redirectUri}?code=lb-code&state=${new URL(started.authorizeUrl).searchParams.get("state")}&client_id=oaiapp_lb`,
				);
				assert.equal(done.accounts[0]?.connected, true);
				const cat = await svc.models();
				assert.equal(cat.models[0]?.id, "gpt-loopback");
				assert.ok(fetchedUrls.includes("http://127.0.0.1:43210/v1/models"));
			} finally {
				svc.close();
			}

			// 2. Non-loopback, https:, userinfo, or production mode without LH_IGNORE_ENV_KEYS must be ignored
			for (const badIssuer of [
				"https://evil.com",
				"https://127.0.0.1:43210",
				"http://192.168.1.10:43210",
				"http://localhost.evil.com:43210",
				"http://user@127.0.0.1:43210",
				"http://127.0.0.1:43210/extra-path",
			]) {
				env.NODE_ENV = "test";
				env.LH_CHATGPT_OAUTH_ISSUER = badIssuer;
				const svcBad = createChatGPT({
					store: fileStore(path.join(dir, "bad.json")),
					openExternal: async () => {},
					fetch: async () => Response.json({ models: [] }),
				});
				try {
					const st = await svcBad.startHeadlessAuth();
					assert.equal(new URL(st.authorizeUrl).origin, "https://auth.openai.com", `must ignore ${badIssuer}`);
				} finally {
					svcBad.close();
				}
			}

			// Production NODE_ENV without LH_IGNORE_ENV_KEYS=1 ignores even loopback override
			env.NODE_ENV = "production";
			delete env.LH_IGNORE_ENV_KEYS;
			env.LH_CHATGPT_OAUTH_ISSUER = "http://localhost:43210";
			const svcProd = createChatGPT({
				store: fileStore(path.join(dir, "prod.json")),
				openExternal: async () => {},
				fetch: async () => Response.json({ models: [] }),
			});
			try {
				const st = await svcProd.startHeadlessAuth();
				assert.equal(new URL(st.authorizeUrl).origin, "https://auth.openai.com");
			} finally {
				svcProd.close();
			}

			// LH_IGNORE_ENV_KEYS=1 with [::1] enables loopback override even if NODE_ENV=production
			env.LH_IGNORE_ENV_KEYS = "1";
			env.LH_CHATGPT_OAUTH_ISSUER = "http://[::1]:43210";
			const svcV6 = createChatGPT({
				store: fileStore(path.join(dir, "v6.json")),
				openExternal: async () => {},
				fetch: async () => Response.json({ models: [] }),
			});
			try {
				const st = await svcV6.startHeadlessAuth();
				assert.equal(new URL(st.authorizeUrl).origin, "http://[::1]:43210");
			} finally {
				svcV6.close();
			}
		} finally {
			if (prevNodeEnv === undefined) delete env.NODE_ENV; else env.NODE_ENV = prevNodeEnv;
			if (prevIgnore === undefined) delete env.LH_IGNORE_ENV_KEYS; else env.LH_IGNORE_ENV_KEYS = prevIgnore;
			if (prevIssuer === undefined) delete env.LH_CHATGPT_OAUTH_ISSUER; else env.LH_CHATGPT_OAUTH_ISSUER = prevIssuer;
			if (prevApi === undefined) delete env.LH_CHATGPT_API_BASE; else env.LH_CHATGPT_API_BASE = prevApi;
		}
	});
});
