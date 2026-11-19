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

function readRemoteConfig(userDataDir) {
	const failClosed = { mode: "unset", serverUrl: null };
	if (typeof userDataDir !== "string" || !userDataDir) return failClosed;
	try {
		const raw = fs.readFileSync(configPath(userDataDir), "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return failClosed;
		const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;
		if (parsed.mode === "local") {
			return { mode: "local", serverUrl: null, ...(updatedAt ? { updatedAt } : {}) };
		}
		if (parsed.mode === "remote") {
			const validated = validateServerUrl(parsed.serverUrl);
			if (!validated.ok) return failClosed;
			return {
				mode: "remote",
				serverUrl: validated.serverUrl,
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
	if (next.mode === "remote") {
		const validated = validateServerUrl(next.serverUrl);
		if (!validated.ok) throw new Error(validated.error);
		normalizedServerUrl = validated.serverUrl;
	}
	const record = {
		mode: next.mode,
		serverUrl: normalizedServerUrl,
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

function probeServerHealth(serverUrl, opts = {}) {
	const validated = validateServerUrl(serverUrl);
	if (!validated.ok) {
		return Promise.resolve({ ok: false, error: validated.error });
	}
	const timeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 5000;
	const healthUrl = `${validated.origin}/api/health`;
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
	probeServerHealth,
};
