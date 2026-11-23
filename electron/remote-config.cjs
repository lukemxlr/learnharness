"use strict";

const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const CONFIG_FILENAME = "remote-config.json";
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function configPath(userDataDir) {
	return path.join(userDataDir, CONFIG_FILENAME);
}

function validateServerUrl(raw) {
	if (typeof raw !== "string") {
		return { ok: false, error: "Server URL must be a string." };
	}
	if (CONTROL_CHARS_RE.test(raw)) {
		return { ok: false, error: "Server URL must not contain control characters." };
	}
	const trimmed = raw.trim();
	if (!trimmed) {
		return { ok: false, error: "Server URL is required." };
	}
	if (/\s/.test(trimmed)) {
		return { ok: false, error: "Server URL must not contain whitespace." };
	}
	if (trimmed.includes("?") || trimmed.includes("#")) {
		return { ok: false, error: "Server URL must not include a query string or fragment." };
	}
	let parsed;
	try {
		parsed = new URL(trimmed);
	} catch {
		return { ok: false, error: "Enter a valid http:// or https:// server URL." };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, error: "Only http:// and https:// server URLs are supported." };
	}
	if (parsed.username || parsed.password) {
		return { ok: false, error: "Server URL must not include credentials." };
	}
	if (parsed.search || parsed.hash) {
		return { ok: false, error: "Server URL must not include a query string or fragment." };
	}
	if (!parsed.hostname || !parsed.origin || parsed.origin === "null") {
		return { ok: false, error: "Enter a valid server host." };
	}
	return { ok: true, serverUrl: parsed.origin, origin: parsed.origin };
}

/**
 * True ONLY for plain `http://` origins pointing to a private LAN or Tailscale
 * host (RFC1918, Tailscale CGNAT 100.64.0.0/10, link-local, IPv6 ULA, `*.local`,
 * `*.ts.net`, or single-label LAN hostnames). Excludes localhost/127.0.0.1
 * (already secure contexts) and public internet hosts.
 */
function isPrivateLanOrTailscaleHttpOrigin(rawUrl) {
	if (typeof rawUrl !== "string" || !rawUrl) return false;
	let parsed;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:") return false;
	const host = parsed.hostname.toLowerCase();
	if (!host || host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
		return false;
	}
	// IPv4 private & Tailscale CGNAT ranges
	const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (ipv4) {
		const [a, b, c, d] = ipv4.slice(1).map((n) => Number.parseInt(n, 10));
		if ([a, b, c, d].some((n) => n < 0 || n > 255)) return false;
		if (a === 10) return true; // 10.0.0.0/8
		if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
		if (a === 192 && b === 168) return true; // 192.168.0.0/16
		if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale CGNAT 100.64.0.0/10
		if (a === 169 && b === 254) return true; // Link-local
		return false;
	}
	// IPv6 ULA (fc00::/7) or link-local (fe80::/10)
	const bareV6 = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (bareV6.includes(":")) {
		return /^(fc|fd|fe[89ab])/i.test(bareV6);
	}
	if (host.endsWith(".local") || host.endsWith(".ts.net")) return true;
	// Single-label LAN hostname (e.g. http://learnharness:3000)
	if (!host.includes(".") && /^[a-z0-9-]+$/.test(host)) return true;
	return false;
}

function isCloudflareAccessUrl(rawUrl) {
	if (typeof rawUrl !== "string" || !rawUrl) return false;
	try {
		const parsed = new URL(rawUrl);
		if (parsed.protocol !== "https:") return false;
		const host = parsed.hostname.toLowerCase();
		return host.endsWith(".cloudflareaccess.com") && host.length > ".cloudflareaccess.com".length;
	} catch {
		return false;
	}
}

function detectCloudflareAccessResponse(statusCode, locationHeader, wwwAuthenticateHeader) {
	const loc = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
	const www = Array.isArray(wwwAuthenticateHeader) ? wwwAuthenticateHeader.join(", ") : wwwAuthenticateHeader;
	if ([301, 302, 303, 307, 308].includes(statusCode) && typeof loc === "string" && isCloudflareAccessUrl(loc)) {
		try {
			const parsed = new URL(loc);
			return { isCfAccess: true, authUrl: loc, teamOrigin: parsed.origin };
		} catch {
			return { isCfAccess: true, authUrl: loc, teamOrigin: null };
		}
	}
	if (typeof www === "string" && /cloudflare-access/i.test(www) && [301, 302, 303, 307, 401, 403].includes(statusCode)) {
		return { isCfAccess: true, authUrl: typeof loc === "string" && isCloudflareAccessUrl(loc) ? loc : null, teamOrigin: null };
	}
	return { isCfAccess: false, authUrl: null, teamOrigin: null };
}

function readRemoteConfig(userDataDir) {
	const failClosed = { mode: "unset", serverUrl: null, allowInsecureLanMic: false, autoUpdate: true };
	if (typeof userDataDir !== "string" || !userDataDir) return failClosed;
	try {
		const raw = fs.readFileSync(configPath(userDataDir), "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return failClosed;
		const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;
		const autoUpdate = parsed.autoUpdate !== false;
		if (parsed.mode === "local") {
			return { mode: "local", serverUrl: null, allowInsecureLanMic: false, autoUpdate, ...(updatedAt ? { updatedAt } : {}) };
		}
		if (parsed.mode === "remote") {
			const validated = validateServerUrl(parsed.serverUrl);
			if (!validated.ok) return failClosed;
			const allowInsecureLanMic =
				parsed.allowInsecureLanMic === true && isPrivateLanOrTailscaleHttpOrigin(validated.serverUrl);
			return {
				mode: "remote",
				serverUrl: validated.serverUrl,
				allowInsecureLanMic,
				autoUpdate,
				...(updatedAt ? { updatedAt } : {}),
			};
		}
		return failClosed;
	} catch {
		return failClosed;
	}
}

function writeRemoteConfig(userDataDir, next) {
	if (typeof userDataDir !== "string" || !userDataDir) {
		throw new Error("userDataDir is required.");
	}
	if (!next || (next.mode !== "remote" && next.mode !== "local")) {
		throw new Error('Config mode must be "remote" or "local".');
	}
	let normalizedServerUrl = null;
	let allowInsecureLanMic = false;
	if (next.mode === "remote") {
		const validated = validateServerUrl(next.serverUrl);
		if (!validated.ok) throw new Error(validated.error);
		normalizedServerUrl = validated.serverUrl;
		allowInsecureLanMic =
			next.allowInsecureLanMic === true && isPrivateLanOrTailscaleHttpOrigin(normalizedServerUrl);
	}
	const prevAutoUpdate = next.autoUpdate === undefined ? readRemoteConfig(userDataDir).autoUpdate : next.autoUpdate !== false;
	const record = {
		mode: next.mode,
		serverUrl: normalizedServerUrl,
		allowInsecureLanMic,
		autoUpdate: prevAutoUpdate,
		updatedAt: new Date().toISOString(),
	};
	fs.mkdirSync(userDataDir, { recursive: true });
	const target = configPath(userDataDir);
	const tmp = path.join(userDataDir, `.${CONFIG_FILENAME}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
	fs.writeFileSync(tmp, `${JSON.stringify(record, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(tmp, target);
	try { fs.chmodSync(target, 0o600); } catch { /* best-effort on Windows */ }
	return record;
}

function allowedOriginForConfig(config) {
	if (config?.mode !== "remote") return null;
	const validated = validateServerUrl(config.serverUrl);
	return validated.ok ? validated.origin : null;
}

function shouldUseLocalDataDir(config) {
	return config?.mode === "local";
}

async function probeWithFetch(healthUrl, origin, fetchImpl, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`Connection timed out after ${timeoutMs}ms.`)), timeoutMs);
	timer.unref?.();
	try {
		const res = await fetchImpl(healthUrl, {
			method: "GET",
			headers: { accept: "application/json" },
			redirect: "manual",
			signal: controller.signal,
		});
		if (typeof res.url === "string" && isCloudflareAccessUrl(res.url)) {
			let teamOrigin = null;
			try { teamOrigin = new URL(res.url).origin; } catch { /* ignore */ }
			return {
				ok: false,
				needsCloudflareAuth: true,
				origin,
				authUrl: res.url,
				teamOrigin,
				error: "Cloudflare Access sign-in required.",
			};
		}
		const cf = detectCloudflareAccessResponse(
			res.status,
			res.headers?.get?.("location"),
			res.headers?.get?.("www-authenticate"),
		);
		if (cf.isCfAccess) {
			return {
				ok: false,
				needsCloudflareAuth: true,
				origin,
				authUrl: cf.authUrl || healthUrl,
				teamOrigin: cf.teamOrigin,
				error: "Cloudflare Access sign-in required.",
			};
		}
		if (res.status !== 200) {
			return { ok: false, error: `Server responded with HTTP ${res.status ?? "unknown"}.` };
		}
		const text = await res.text();
		if (Buffer.byteLength(text, "utf8") > 16_384) {
			return { ok: false, error: "Server health response exceeded maximum size." };
		}
		try {
			const body = JSON.parse(text);
			if (body && body.ok === true) {
				return { ok: true, origin };
			}
			return { ok: false, error: "Server health check returned an unexpected response." };
		} catch {
			return { ok: false, error: "Server health check returned invalid JSON." };
		}
	} catch (err) {
		if (controller.signal.aborted) {
			return { ok: false, error: `Connection timed out after ${timeoutMs}ms.` };
		}
		return { ok: false, error: err?.message || "Could not reach the server." };
	} finally {
		clearTimeout(timer);
	}
}

function probeServerHealth(serverUrl, opts = {}) {
	const validated = validateServerUrl(serverUrl);
	if (!validated.ok) {
		return Promise.resolve({ ok: false, error: validated.error });
	}
	const timeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 5000;
	const healthUrl = `${validated.origin}/api/health`;
	if (typeof opts.fetchImpl === "function") {
		return probeWithFetch(healthUrl, validated.origin, opts.fetchImpl, timeoutMs);
	}

	const target = new URL(healthUrl);
	const client = target.protocol === "https:" ? https : http;

	return new Promise((resolve) => {
		let settled = false;
		let deadlineTimer;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			if (deadlineTimer !== undefined) {
				clearTimeout(deadlineTimer);
				deadlineTimer = undefined;
			}
			resolve(result);
		};
		const req = client.request(
			target,
			{ method: "GET", headers: { accept: "application/json" } },
			(res) => {
				const cf = detectCloudflareAccessResponse(
					res.statusCode,
					res.headers?.location,
					res.headers?.["www-authenticate"],
				);
				if (cf.isCfAccess) {
					res.resume();
					finish({
						ok: false,
						needsCloudflareAuth: true,
						origin: validated.origin,
						authUrl: cf.authUrl || healthUrl,
						teamOrigin: cf.teamOrigin,
						error: "Cloudflare Access sign-in required.",
					});
					return;
				}
				const chunks = [];
				let bytes = 0;
				res.on("error", (err) => {
					finish({ ok: false, error: err?.message || "Server health response failed." });
				});
				res.on("close", () => {
					if (!settled) {
						finish({ ok: false, error: "Server health response closed unexpectedly." });
					}
				});
				res.on("data", (chunk) => {
					bytes += chunk.length;
					if (bytes > 16_384) {
						finish({ ok: false, error: "Server health response exceeded maximum size." });
						res.destroy();
						req.destroy();
						return;
					}
					chunks.push(chunk);
				});
				res.on("end", () => {
					if (res.statusCode !== 200) {
						finish({ ok: false, error: `Server responded with HTTP ${res.statusCode ?? "unknown"}.` });
						return;
					}
					try {
						const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
						if (body && body.ok === true) {
							finish({ ok: true, origin: validated.origin });
						} else {
							finish({ ok: false, error: "Server health check returned an unexpected response." });
						}
					} catch {
						finish({ ok: false, error: "Server health check returned invalid JSON." });
					}
				});
			},
		);
		deadlineTimer = setTimeout(() => {
			const err = new Error(`Connection timed out after ${timeoutMs}ms.`);
			finish({ ok: false, error: err.message });
			req.destroy(err);
		}, timeoutMs);
		deadlineTimer.unref?.();
		req.setTimeout(timeoutMs, () => {
			req.destroy(new Error(`Connection timed out after ${timeoutMs}ms.`));
		});
		req.on("error", (err) => {
			finish({ ok: false, error: err?.message || "Could not reach the server." });
		});
		req.end();
	});
}

module.exports = {
	CONFIG_FILENAME,
	readRemoteConfig,
	writeRemoteConfig,
	allowedOriginForConfig,
	shouldUseLocalDataDir,
	validateServerUrl,
	isPrivateLanOrTailscaleHttpOrigin,
	isCloudflareAccessUrl,
	detectCloudflareAccessResponse,
	probeServerHealth,
};
