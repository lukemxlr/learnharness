import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GET as healthGet } from "../app/api/health/route.ts";
import {
	browserAPIRefusal,
	browserHostAllowed,
	isHttpsRequest,
	subscriptionRequestOrigin,
} from "../src/server/desktop-access.ts";

describe("Reverse proxy trust & Cloudflare Tunnel support (F3)", () => {
	it("ignores X-Forwarded-* headers when LH_TRUST_PROXY is unset", () => {
		const req = new Request("http://127.0.0.1:3000/api/chats", {
			method: "POST",
			headers: {
				host: "127.0.0.1:3000",
				"x-forwarded-proto": "https",
				"x-forwarded-host": "lh.example.com",
				origin: "https://lh.example.com",
				"sec-fetch-site": "same-origin",
			},
		});
		assert.equal(isHttpsRequest(req, {}), false);
		assert.equal(subscriptionRequestOrigin(req, {}), "http://127.0.0.1:3000");
		assert.match(browserAPIRefusal(req, { LH_ALLOWED_HOSTS: "lh.example.com" }) ?? "", /Cross-site/);
	});

	it("honors X-Forwarded-Proto and X-Forwarded-Host (first comma token) when LH_TRUST_PROXY=1", () => {
		const env = { LH_TRUST_PROXY: "1", LH_ALLOWED_HOSTS: "lh.example.com" };
		const req = new Request("http://127.0.0.1:3000/api/chats", {
			method: "POST",
			headers: {
				host: "127.0.0.1:3000",
				"x-forwarded-proto": "https, http",
				"x-forwarded-host": "lh.example.com, internal.proxy",
				origin: "https://lh.example.com",
				"sec-fetch-site": "same-origin",
			},
		});
		assert.equal(isHttpsRequest(req, env), true);
		assert.equal(subscriptionRequestOrigin(req, env), "https://lh.example.com");
		assert.equal(browserAPIRefusal(req, env), undefined);
	});

	it("still enforces LH_ALLOWED_HOSTS and CSRF Origin when LH_TRUST_PROXY=1", () => {
		const env = { LH_TRUST_PROXY: "1", LH_ALLOWED_HOSTS: "lh.example.com" };
		const disallowedHost = new Request("http://127.0.0.1:3000/api/chats", {
			method: "GET",
			headers: {
				host: "127.0.0.1:3000",
				"x-forwarded-host": "evil.example.com",
				"x-forwarded-proto": "https",
			},
		});
		assert.match(browserAPIRefusal(disallowedHost, env) ?? "", /LH_ALLOWED_HOSTS/);

		const crossOrigin = new Request("http://127.0.0.1:3000/api/chats", {
			method: "POST",
			headers: {
				host: "127.0.0.1:3000",
				"x-forwarded-host": "lh.example.com",
				"x-forwarded-proto": "https",
				origin: "https://attacker.example",
				"sec-fetch-site": "same-origin",
			},
		});
		assert.match(browserAPIRefusal(crossOrigin, env) ?? "", /Cross-site/);
	});

	it("supports simultaneous LAN HTTP and Cloudflare HTTPS with LH_TRUST_PROXY=1", () => {
		const env = { LH_TRUST_PROXY: "1", LH_ALLOWED_HOSTS: "lh.example.com" };
		const lanReq = new Request("http://192.168.1.50:3000/api/auth/login", {
			method: "POST",
			headers: {
				host: "192.168.1.50:3000",
				origin: "http://192.168.1.50:3000",
				"sec-fetch-site": "same-origin",
			},
		});
		assert.equal(isHttpsRequest(lanReq, env), false);
		assert.equal(subscriptionRequestOrigin(lanReq, env), "http://192.168.1.50:3000");
		assert.equal(browserAPIRefusal(lanReq, env), undefined);
	});

	it("hardens browserHostAllowed against userinfo, path, query, fragment, and malformed X-Forwarded-Proto", () => {
		assert.equal(browserHostAllowed("user:pass@localhost:3000", {}), false);
		assert.equal(browserHostAllowed("localhost/path", {}), false);
		assert.equal(browserHostAllowed("localhost?q=1", {}), false);
		assert.equal(browserHostAllowed("localhost#frag", {}), false);

		const badProto = new Request("http://127.0.0.1:3000/api/chats", {
			method: "POST",
			headers: {
				host: "127.0.0.1:3000",
				"x-forwarded-proto": "javascript",
				origin: "http://127.0.0.1:3000",
			},
		});
		assert.equal(subscriptionRequestOrigin(badProto, { LH_TRUST_PROXY: "1" }), undefined);
	});

	it("serves GET /api/health unauthenticated with Cache-Control: no-store", async () => {
		const res = healthGet();
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("Cache-Control"), "no-store");
		assert.deepEqual(await res.json(), { ok: true });
	});
});
