import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const DEFAULT_NODE26_BIN = process.env.LH_NODE26_BIN || "/opt/node26/bin/node";

export async function getFreePort(host = "127.0.0.1") {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.unref();
		srv.on("error", reject);
		srv.listen(0, host, () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close((err) => (err ? reject(err) : resolve(port)));
		});
	});
}

export function resolveRepoDir() {
	return path.resolve(process.env.LH_REPO_DIR || "/repo");
}

export function resolveStandaloneDir(repoDir = resolveRepoDir()) {
	if (process.env.LH_STANDALONE_DIR) {
		return path.resolve(process.env.LH_STANDALONE_DIR);
	}
	return path.join(repoDir, ".next", "standalone");
}

export function hasStandaloneBuild(repoDir = resolveRepoDir()) {
	const standaloneDir = resolveStandaloneDir(repoDir);
	return fs.existsSync(path.join(standaloneDir, "server.js"));
}

export async function runNode26Cli(scriptRelOrAbs, args = [], options = {}) {
	const node26Bin = options.node26Bin || DEFAULT_NODE26_BIN;
	const repoDir = options.repoDir || resolveRepoDir();
	const scriptPath = path.isAbsolute(scriptRelOrAbs)
		? scriptRelOrAbs
		: path.join(repoDir, scriptRelOrAbs);

	if (!fs.existsSync(scriptPath)) {
		return {
			code: -1,
			signal: null,
			stdout: "",
			stderr: `Missing script: ${scriptPath}`,
			missingScript: true,
		};
	}

	const env = {
		...process.env,
		LH_IGNORE_ENV_KEYS: "1",
		NEXT_TELEMETRY_DISABLED: "1",
		...(options.env || {}),
	};

	return new Promise((resolve, reject) => {
		const child = spawn(node26Bin, [scriptPath, ...args], {
			cwd: options.cwd || repoDir,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const stdoutChunks = [];
		const stderrChunks = [];
		child.stdout.on("data", (d) => stdoutChunks.push(d));
		child.stderr.on("data", (d) => stderrChunks.push(d));
		child.on("error", reject);

		if (options.stdin !== undefined) {
			child.stdin.write(options.stdin);
		}
		child.stdin.end();

		child.on("close", (code, signal) => {
			resolve({
				code: code ?? -1,
				signal,
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: Buffer.concat(stderrChunks).toString("utf8"),
				missingScript: false,
			});
		});
	});
}

function normalizeCustomBaseUrl(raw) {
	if (typeof raw !== "string") {
		throw new Error(`Invalid customProvider baseUrl: expected string, got ${typeof raw}`);
	}
	const value = raw.trim();
	if (!value) {
		throw new Error("Invalid customProvider baseUrl: empty URL");
	}
	if (value.includes("?") || value.includes("#")) {
		throw new Error(`Invalid customProvider baseUrl "${raw}": query strings and hash fragments are not allowed`);
	}
	let url;
	try {
		url = new URL(value);
	} catch (err) {
		throw new Error(`Invalid customProvider baseUrl "${raw}": ${err.message}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Invalid customProvider baseUrl "${raw}": protocol must be http: or https:`);
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error(`Invalid customProvider baseUrl "${raw}": credentials, query strings, and hash fragments are not allowed`);
	}
	return url.toString().replace(/\/+$/, "");
}

export class ServerController {
	constructor(options = {}) {
		this.id = options.id || randomUUID().slice(0, 8);
		this.node26Bin = options.node26Bin || DEFAULT_NODE26_BIN;
		this.repoDir = options.repoDir || resolveRepoDir();
		this.standaloneDir = options.standaloneDir || resolveStandaloneDir(this.repoDir);
		this.rootDir = options.rootDir || `/tmp/lh-e2e-${this.id}`;
		this.dataDir = path.join(this.rootDir, "data");
		this.authDir = path.join(this.rootDir, "auth");
		this.authFile = path.join(this.authDir, "auth.json");
		this.userAuthFile = path.join(this.authDir, "user-auth.json");
		this.homeDir = path.join(this.rootDir, "home");
		this.tmpDir = path.join(this.rootDir, "tmp");

		fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
		fs.mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
		fs.mkdirSync(this.homeDir, { recursive: true, mode: 0o700 });
		fs.mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });

		this.port = options.port ?? null;
		this.hostname = options.hostname || "127.0.0.1";
		this.process = null;
		this.logs = [];
		this.lastStartOptions = null;
	}

	get baseUrl() {
		if (!this.port) throw new Error("ServerController port not assigned yet");
		return `http://127.0.0.1:${this.port}`;
	}

	baseEnv(extra = {}) {
		return {
			...process.env,
			HOME: this.homeDir,
			TMPDIR: this.tmpDir,
			LH_DATA_DIR: this.dataDir,
			LH_AUTH_FILE: this.authFile,
			LH_IGNORE_ENV_KEYS: "1",
			NEXT_TELEMETRY_DISABLED: "1",
			...extra,
		};
	}

	seedSyntheticProfile(fixtureDir, options = {}) {
		const src = fixtureDir || path.join(this.repoDir, "tests", "fixtures", "e2e-synthetic");
		if (!fs.existsSync(src)) {
			throw new Error(`Synthetic fixture directory not found: ${src}`);
		}
		for (const entry of ["settings.json", "chats", "jobs", "graph", "prompts", "themes"]) {
			const from = path.join(src, entry);
			const to = path.join(this.dataDir, entry);
			if (fs.existsSync(from)) {
				fs.cpSync(from, to, { recursive: true });
			}
		}
		const settingsPath = path.join(this.dataDir, "settings.json");
		if (!fs.existsSync(settingsPath)) {
			return;
		}
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		if (!settings.customProvider) {
			return;
		}

		const hasExplicitMockBaseUrl = options.mockBaseUrl !== undefined && options.mockBaseUrl !== null;
		const existingAuthMode = settings.customProvider.authMode;
		const shouldBindFromSettings = Boolean(settings.customProvider.baseUrl) && existingAuthMode !== "disabled";

		if (!hasExplicitMockBaseUrl && !shouldBindFromSettings) {
			if (options.apiKey !== undefined) {
				if (typeof options.apiKey !== "string" || !options.apiKey.trim()) {
					throw new Error("Invalid options.apiKey: expected non-empty string");
				}
				fs.mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
				const existingAuth = this._readExistingAuthObject();
				const nextAuth = {
					...existingAuth,
					CUSTOM_OPENAI_API_KEY: options.apiKey,
				};
				fs.writeFileSync(this.authFile, `${JSON.stringify(nextAuth, null, "\t")}\n`, {
					encoding: "utf8",
					mode: 0o600,
				});
				fs.chmodSync(this.authFile, 0o600);
			}
			return;
		}

		const rawBaseUrl = hasExplicitMockBaseUrl ? options.mockBaseUrl : settings.customProvider.baseUrl;
		const normalizedBaseUrl = normalizeCustomBaseUrl(rawBaseUrl);
		const authMode = existingAuthMode || "keyless";
		const bindingId = randomBytes(16).toString("hex");

		settings.customProvider.baseUrl = normalizedBaseUrl;
		settings.customProvider.authMode = authMode;
		settings.customProvider.credentialBindingId = bindingId;

		fs.mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
		const existingAuth = this._readExistingAuthObject();
		const nextAuth = { ...existingAuth };
		if (options.apiKey !== undefined) {
			if (typeof options.apiKey !== "string" || !options.apiKey.trim()) {
				throw new Error("Invalid options.apiKey: expected non-empty string");
			}
			nextAuth.CUSTOM_OPENAI_API_KEY = options.apiKey;
		}
		const hasFileApiKey =
			typeof nextAuth.CUSTOM_OPENAI_API_KEY === "string" && nextAuth.CUSTOM_OPENAI_API_KEY.trim().length > 0;
		const binding = {
			version: 1,
			id: bindingId,
			baseUrl: normalizedBaseUrl,
			authMode,
			...(authMode === "apiKey" && hasFileApiKey ? { fileKeyBaseUrl: normalizedBaseUrl } : {}),
		};
		nextAuth.__learnharness_custom_provider_binding = JSON.stringify(binding);

		fs.writeFileSync(this.authFile, `${JSON.stringify(nextAuth, null, "\t")}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		fs.chmodSync(this.authFile, 0o600);
		fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`, "utf8");
	}

	_readExistingAuthObject() {
		if (!fs.existsSync(this.authFile)) {
			return {};
		}
		const rawAuth = fs.readFileSync(this.authFile, "utf8");
		let parsed;
		try {
			parsed = JSON.parse(rawAuth);
		} catch (err) {
			throw new Error(`Malformed JSON in ${this.authFile}: ${err.message}`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Invalid auth.json in ${this.authFile}: expected a JSON object`);
		}
		return parsed;
	}

	writeSettings(settingsObj) {
		const settingsPath = path.join(this.dataDir, "settings.json");
		fs.writeFileSync(settingsPath, `${JSON.stringify(settingsObj, null, "\t")}\n`, "utf8");
	}

	async initAuth({ username = "synthlearner", password = "SynthPassword123!", force = true } = {}) {
		const args = ["init", "--username", username, "--password-stdin"];
		if (force) args.push("--force");
		const res = await runNode26Cli("scripts/user-auth.mjs", args, {
			node26Bin: this.node26Bin,
			repoDir: this.repoDir,
			env: this.baseEnv(),
			stdin: `${password}\n`,
		});
		if (res.code !== 0) {
			throw new Error(`user-auth init failed (${res.code}): ${res.stderr || res.stdout}`);
		}
		return res;
	}

	async resetPassword({ password }) {
		const res = await runNode26Cli("scripts/user-auth.mjs", ["reset-password", "--password-stdin"], {
			node26Bin: this.node26Bin,
			repoDir: this.repoDir,
			env: this.baseEnv(),
			stdin: `${password}\n`,
		});
		if (res.code !== 0) {
			throw new Error(`user-auth reset-password failed (${res.code}): ${res.stderr || res.stdout}`);
		}
		return res;
	}

	async authStatus() {
		const res = await runNode26Cli("scripts/user-auth.mjs", ["status"], {
			node26Bin: this.node26Bin,
			repoDir: this.repoDir,
			env: this.baseEnv(),
		});
		return {
			...res,
			parsed: res.stdout ? JSON.parse(res.stdout) : null,
		};
	}

	async runMigrateCli(args = []) {
		return runNode26Cli("scripts/migrate-profile.mjs", args, {
			node26Bin: this.node26Bin,
			repoDir: this.repoDir,
			env: this.baseEnv(),
		});
	}

	_appendLog(line) {
		this.logs.push(line);
		if (this.logs.length > 400) this.logs.shift();
	}

	async start(options = {}) {
		if (this.process) {
			throw new Error("ServerController already running");
		}
		const serverJs = path.join(this.standaloneDir, "server.js");
		if (!fs.existsSync(serverJs)) {
			throw new Error(
				`Standalone server not built at ${serverJs}. Run with --build-app or build .next/standalone first.`,
			);
		}
		if (!this.port || options.port) {
			this.port = options.port ?? (await getFreePort("127.0.0.1"));
		}
		this.hostname = options.hostname || this.hostname || "127.0.0.1";
		this.lastStartOptions = options;

		const env = this.baseEnv({
			NODE_ENV: "production",
			PORT: String(this.port),
			HOSTNAME: this.hostname,
			...(options.trustProxy !== undefined ? { LH_TRUST_PROXY: options.trustProxy ? "1" : "0" } : {}),
			...(options.allowedHosts ? { LH_ALLOWED_HOSTS: options.allowedHosts } : {}),
			...(options.requireAuth !== undefined ? { LH_REQUIRE_AUTH: options.requireAuth ? "1" : "0" } : {}),
			...(options.desktopServer !== undefined ? { LH_DESKTOP_SERVER: options.desktopServer ? "1" : "0" } : {}),
			...(options.desktopSecret ? { LH_DESKTOP_API_SECRET: options.desktopSecret } : {}),
			...(options.extraEnv || {}),
		});

		const child = spawn(this.node26Bin, [serverJs], {
			cwd: this.standaloneDir,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.process = child;
		child.stdout.on("data", (d) => this._appendLog(`[stdout] ${d.toString("utf8").trimEnd()}`));
		child.stderr.on("data", (d) => this._appendLog(`[stderr] ${d.toString("utf8").trimEnd()}`));

		let spawnError = null;
		const exitPromise = new Promise((resolve) => {
			child.once("error", (err) => {
				spawnError = err;
				this._appendLog(`[error] ${err.message}`);
				if (this.process === child) this.process = null;
				resolve({ code: -1, signal: null, error: err });
			});
			child.once("exit", (code, signal) => {
				if (this.process === child) this.process = null;
				resolve({ code, signal });
			});
		});
		this._exitPromise = exitPromise;

		const timeoutMs = options.bootTimeoutMs ?? 30_000;
		const deadline = Date.now() + timeoutMs;
		const healthUrl = `${this.baseUrl}/api/health`;
		let lastErr = null;
		while (Date.now() < deadline) {
			if (spawnError) {
				throw new Error(
					`Server failed to spawn (${spawnError.message}):\n${this.logs.slice(-20).join("\n")}`,
				);
			}
			if (!this.process) {
				const exited = await exitPromise;
				if (exited.error) {
					throw new Error(
						`Server failed to spawn (${exited.error.message}):\n${this.logs.slice(-20).join("\n")}`,
					);
				}
				throw new Error(
					`Server exited prematurely (${JSON.stringify(exited)}):\n${this.logs.slice(-20).join("\n")}`,
				);
			}
			try {
				const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
				if (res.status === 200) {
					return { baseUrl: this.baseUrl, port: this.port };
				}
			} catch (err) {
				lastErr = err;
			}
			await Promise.race([new Promise((r) => setTimeout(r, 150)), exitPromise]);
		}
		if (spawnError) {
			throw new Error(
				`Server failed to spawn (${spawnError.message}):\n${this.logs.slice(-20).join("\n")}`,
			);
		}
		await this.stop();
		throw new Error(
			`Server failed health check at ${healthUrl} within ${timeoutMs}ms (${lastErr}). Logs:\n${this.logs.slice(-25).join("\n")}`,
		);
	}

	async stop(graceMs = 5000) {
		const child = this.process;
		if (!child) return { code: 0, signal: null };
		child.kill("SIGTERM");
		const result = await Promise.race([
			this._exitPromise,
			new Promise((resolve) =>
				setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* ignore */
					}
					resolve({ code: null, signal: "SIGKILL" });
				}, graceMs),
			),
		]);
		this.process = null;
		return result;
	}

	async restart(overrideOptions = {}) {
		await this.stop();
		return this.start({ ...(this.lastStartOptions || {}), ...overrideOptions, port: this.port });
	}

	async cleanup() {
		await this.stop();
		fs.rmSync(this.rootDir, { recursive: true, force: true });
	}
}
