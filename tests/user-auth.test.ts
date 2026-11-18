import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { sanitizeNextPath } from "../src/core/contracts/auth.ts";
import {
	USER_AUTH_COOKIE_NAME,
	createSessionToken,
	hashPassword,
	isAuthRequired,
	readUserAuthRecord,
	resolveUserAuthPath,
	serializeSessionCookie,
	verifyCookieValue,
	verifyPassword,
	verifyUserCredentials,
} from "../src/server/user-auth.ts";
import { createPluginDocumentRoute, createPluginTransport } from "../src/server/plugin-transport.ts";
import { proxy } from "../proxy.ts";
import { POST as loginPost } from "../app/api/auth/login/route.ts";
import { POST as logoutPost } from "../app/api/auth/logout/route.ts";
import { GET as sessionGet } from "../app/api/auth/session/route.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(ROOT, "scripts", "user-auth.mjs");

const tempDirs: string[] = [];
function mkTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-user-auth-test-"));
	tempDirs.push(dir);
	return dir;
}

async function withEnvAsync<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
	for (const [k, v] of Object.entries(values)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		return await run();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("Single-account auth contracts & CLI (F4)", () => {
	it("sanitizes post-login next paths against open redirects", () => {
		assert.equal(sanitizeNextPath("/chat/abc?x=1"), "/chat/abc?x=1");
		assert.equal(sanitizeNextPath("/"), "/");
		assert.equal(sanitizeNextPath("https://evil.example"), "/");
		assert.equal(sanitizeNextPath("//evil.example/path"), "/");
		assert.equal(sanitizeNextPath("/\\evil.example"), "/");
		assert.equal(sanitizeNextPath("javascript:alert(1)"), "/");
		assert.equal(sanitizeNextPath(undefined), "/");
	});

	it("CLI init, status (redacted), and reset-password (rotates sessionSecret) work with 0600 permissions", () => {
		const dir = mkTempDir();
		const authFile = path.join(dir, "auth", "auth.json");
		const userAuthFile = resolveUserAuthPath({ LH_AUTH_FILE: authFile });

		const initOut = execFileSync(
			process.execPath,
			[CLI_PATH, "init", "--username", "learner", "--password-stdin", "--auth-file", authFile],
			{ input: "correct-horse-battery-staple\n", encoding: "utf8" },
		);
		assert.match(initOut, /Initialized LearnHarness account 'learner'/);
		assert.equal(fs.statSync(userAuthFile).mode & 0o777, 0o600);

		const record1 = readUserAuthRecord({ LH_AUTH_FILE: authFile })!;
		assert(record1);
		assert.equal(record1.username, "learner");
		assert(verifyPassword("correct-horse-battery-staple", record1.passwordHash));
		assert.equal(verifyPassword("wrong-password", record1.passwordHash), false);

		const statusOut = execFileSync(
			process.execPath,
			[CLI_PATH, "status", "--auth-file", authFile],
			{ encoding: "utf8" },
		);
		const parsedStatus = JSON.parse(statusOut);
		assert.equal(parsedStatus.configured, true);
		assert.equal(parsedStatus.username, "learner");
		assert.equal(parsedStatus.mode, "0600");
		assert(!statusOut.includes(record1.passwordHash));
		assert(!statusOut.includes(record1.sessionSecret));

		const tokenBeforeReset = createSessionToken(record1);
		assert.equal(verifyCookieValue(tokenBeforeReset, { LH_AUTH_FILE: authFile }).authenticated, true);

		execFileSync(
			process.execPath,
			[CLI_PATH, "reset-password", "--password-stdin", "--auth-file", authFile],
			{ input: "new-secret-passphrase-123\n", encoding: "utf8" },
		);
		const record2 = readUserAuthRecord({ LH_AUTH_FILE: authFile })!;
		assert.notEqual(record2.sessionSecret, record1.sessionSecret);
		assert.equal(verifyPassword("new-secret-passphrase-123", record2.passwordHash), true);
		assert.equal(
			verifyCookieValue(tokenBeforeReset, { LH_AUTH_FILE: authFile }).authenticated,
			false,
			"old session cookies must be invalidated on password reset",
		);
		const tokenAfterReset = createSessionToken(record2);
		assert.equal(verifyCookieValue(tokenAfterReset, { LH_AUTH_FILE: authFile }).authenticated, true);
	});

	it("sets Secure cookie flag only on HTTPS or trusted-proxy HTTPS requests", () => {
		const lanReq = new Request("http://192.168.1.25:3000/api/auth/login", { method: "POST" });
		const lanCookie = serializeSessionCookie("tok.sig", lanReq, { LH_TRUST_PROXY: "1" });
		assert(lanCookie.includes("HttpOnly"));
		assert(lanCookie.includes("SameSite=Lax"));
		assert(!lanCookie.includes("Secure"));

		const cfReq = new Request("http://127.0.0.1:3000/api/auth/login", {
			method: "POST",
			headers: { "x-forwarded-proto": "https", "x-forwarded-host": "lh.example.com" },
		});
		const cfCookie = serializeSessionCookie("tok.sig", cfReq, { LH_TRUST_PROXY: "1" });
		assert(cfCookie.includes("Secure"));
	});

	it("hashes and verifies credentials with scrypt and timingSafeEqual", () => {
		const dir = mkTempDir();
		const authFile = path.join(dir, "auth.json");
		execFileSync(
			process.execPath,
			[CLI_PATH, "init", "--username", "alice", "--password", "super-secret-pw", "--auth-file", authFile],
			{ encoding: "utf8" },
		);
		const env = { LH_AUTH_FILE: authFile };
		assert.equal(isAuthRequired(env), true);
		assert.equal(verifyUserCredentials("alice", "super-secret-pw", env).ok, true);
		assert.equal(verifyUserCredentials("alice", "wrong", env).ok, false);
		assert.equal(verifyUserCredentials("bob", "super-secret-pw", env).ok, false);
		assert.match(hashPassword("test-pw"), /^scrypt\$16384\$8\$1\$/);
	});
});

describe("Proxy, auth APIs, and plugin document route protection (F4)", () => {
	it("gates pages (302 /login), APIs/streams/attachments (401), exempts /api/health & /login, and enforces auth in createPluginDocumentRoute", async () => {
		const dir = mkTempDir();
		const authFile = path.join(dir, "auth.json");
		execFileSync(
			process.execPath,
			[CLI_PATH, "init", "--username", "learner", "--password", "pass-123456", "--auth-file", authFile],
			{ encoding: "utf8" },
		);

		await withEnvAsync(
			{
				LH_AUTH_FILE: authFile,
				LH_REQUIRE_AUTH: "1",
				LH_DESKTOP_SERVER: undefined,
				LH_DESKTOP_API_SECRET: undefined,
				LH_ALLOWED_HOSTS: "lh.example.com",
				LH_TRUST_PROXY: "1",
			},
			async () => {
				// Unauthenticated pages -> 302 /login?next=...
				const pageRes = proxy(new NextRequest("http://localhost:3000/chat/abc?tab=1"));
				assert.equal(pageRes.status, 302);
				assert.equal(pageRes.headers.get("location"), "http://localhost:3000/login?next=%2Fchat%2Fabc%3Ftab%3D1");

				// Unauthenticated /login -> allowed
				const loginPageRes = proxy(new NextRequest("http://localhost:3000/login"));
				assert.equal(loginPageRes.headers.get("x-middleware-next"), "1");

				// Unauthenticated /api/health -> allowed
				const healthRes = proxy(new NextRequest("http://localhost:3000/api/health"));
				assert.equal(healthRes.headers.get("x-middleware-next"), "1");

				// Unauthenticated protected APIs/streams/images/attachments/plugin assets -> 401
				for (const apiPath of [
					"/api/events",
					"/api/chats",
					"/api/chats/abc/stream",
					"/api/chats/abc/side-chats",
					"/api/chats/abc/images/" + "a".repeat(64),
					"/api/attachments/" + "b".repeat(64),
					"/api/plugins/drawing-pad/assets/main.js",
					"/api/subscriptions",
				]) {
					const r = proxy(new NextRequest(`http://localhost:3000${apiPath}`));
					assert.equal(r.status, 401, apiPath);
				}

				// Streamed plugin document route (outside proxy matcher) must also return 401 before touching params/body
				let touched = false;
				const transport = createPluginTransport({
					getHost: async () => {
						touched = true;
						throw new Error("should not reach getHost");
					},
					directory: "/unused",
				});
				const docRoute = createPluginDocumentRoute(transport);
				const docRes = await docRoute.POST(
					new Request("http://localhost:3000/api/plugins/demo/documents/markdown", { method: "POST" }),
					{ params: Promise.resolve({ id: "demo" }) },
				);
				assert.equal(docRes.status, 401);
				assert.equal(touched, false);

				// Login API sets HttpOnly cookie
				const badLogin = await loginPost(
					new Request("http://localhost:3000/api/auth/login", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ username: "learner", password: "wrong" }),
					}),
				);
				assert.equal(badLogin.status, 401);

				const goodLogin = await loginPost(
					new Request("http://localhost:3000/api/auth/login", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ username: "learner", password: "pass-123456" }),
					}),
				);
				assert.equal(goodLogin.status, 200);
				const setCookie = goodLogin.headers.get("set-cookie") ?? "";
				assert(setCookie.includes(`${USER_AUTH_COOKIE_NAME}=`));
				assert(setCookie.includes("HttpOnly"));
				const cookiePair = setCookie.split(";")[0]!;

				// Authenticated session check & proxy pass-through
				const sessRes = sessionGet(
					new Request("http://localhost:3000/api/auth/session", {
						headers: { cookie: cookiePair },
					}),
				);
				assert.deepEqual(await sessRes.json(), {
					authenticated: true,
					configured: true,
					authRequired: true,
					username: "learner",
				});

				const authedApi = proxy(
					new NextRequest("http://localhost:3000/api/chats", {
						headers: { cookie: cookiePair },
					}),
				);
				assert.equal(authedApi.headers.get("x-middleware-next"), "1");

				const authedPage = proxy(
					new NextRequest("http://localhost:3000/chat/abc", {
						headers: { cookie: cookiePair },
					}),
				);
				assert.equal(authedPage.headers.get("x-middleware-next"), "1");

				// Logout clears cookie
				const outRes = logoutPost(new Request("http://localhost:3000/api/auth/logout", { method: "POST" }));
				assert.equal(outRes.status, 200);
				assert.match(outRes.headers.get("set-cookie") ?? "", /Max-Age=0/);
			},
		);
	});
});
