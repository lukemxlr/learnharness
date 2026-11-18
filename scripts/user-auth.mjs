#!/usr/bin/env node
/**
 * Server-side CLI for single-account authentication (pure Node built-ins only).
 *
 * Usage:
 *   node scripts/user-auth.mjs init --username <name> [--password-stdin | --password <pw>] [--auth-file <path>] [--force]
 *   node scripts/user-auth.mjs reset-password [--password-stdin | --password <pw>] [--auth-file <path>]
 *   node scripts/user-auth.mjs status [--auth-file <path>]
 */

import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function usage(exitCode = 1) {
	console.error(
		"Usage:\n" +
		"  node scripts/user-auth.mjs init --username <name> [--password-stdin | --password <pw>] [--auth-file <path>] [--force]\n" +
		"  node scripts/user-auth.mjs reset-password [--password-stdin | --password <pw>] [--auth-file <path>]\n" +
		"  node scripts/user-auth.mjs status [--auth-file <path>]",
	);
	process.exit(exitCode);
}

function parseArgs(argv) {
	const [subcommand, ...rest] = argv;
	const flags = {
		username: undefined,
		password: undefined,
		passwordStdin: false,
		authFile: undefined,
		force: false,
	};
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--username" && i + 1 < rest.length) {
			flags.username = rest[++i];
		} else if (arg === "--password" && i + 1 < rest.length) {
			flags.password = rest[++i];
		} else if (arg === "--password-stdin") {
			flags.passwordStdin = true;
		} else if (arg === "--auth-file" && i + 1 < rest.length) {
			flags.authFile = rest[++i];
		} else if (arg === "--force") {
			flags.force = true;
		} else if (arg === "--help" || arg === "-h") {
			usage(0);
		} else {
			console.error(`Unknown argument: ${arg}`);
			usage(1);
		}
	}
	return { subcommand, flags };
}

function resolveTargetPath(authFileFlag) {
	const authFile = authFileFlag
		? path.resolve(authFileFlag)
		: process.env.LH_AUTH_FILE
			? path.resolve(process.env.LH_AUTH_FILE)
			: path.join(process.cwd(), "auth.json");
	return path.join(path.dirname(authFile), "user-auth.json");
}

function hashPassword(password) {
	const salt = randomBytes(16).toString("hex");
	const derived = scryptSync(password, salt, SCRYPT_KEYLEN, {
		N: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
	}).toString("hex");
	return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived}`;
}

function writeAtomic0600(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const tmp = `${filePath}.tmp-${randomUUID()}`;
	try {
		const fd = fs.openSync(tmp, "wx", 0o600);
		try {
			fs.fchmodSync(fd, 0o600);
			fs.writeFileSync(fd, content, "utf8");
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, filePath);
	} catch (error) {
		try { fs.unlinkSync(tmp); } catch { /* ignore */ }
		throw error;
	}
}

async function readStdinAll() {
	const chunks = [];
	for await (const chunk of process.stdin) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
	}
	return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function promptHidden(promptText) {
	if (!process.stdin.isTTY) {
		throw new Error("Non-interactive stdin requires --password-stdin or --password");
	}
	return new Promise((resolve, reject) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
		const origWrite = rl._writeToOutput;
		rl._writeToOutput = function (str) {
			if (str === promptText || str.includes("\n")) {
				origWrite.call(rl, str);
			}
		};
		rl.question(promptText, (answer) => {
			process.stderr.write("\n");
			rl.close();
			resolve(answer);
		});
		rl.on("error", reject);
	});
}

async function resolvePassword(flags) {
	if (flags.password !== undefined) {
		return flags.password;
	}
	if (flags.passwordStdin) {
		return readStdinAll();
	}
	const pw = await promptHidden("Password: ");
	const confirm = await promptHidden("Confirm password: ");
	if (pw !== confirm) {
		throw new Error("Passwords do not match");
	}
	return pw;
}

async function main() {
	const { subcommand, flags } = parseArgs(process.argv.slice(2));
	if (!subcommand) usage(1);

	const targetPath = resolveTargetPath(flags.authFile);

	if (subcommand === "status") {
		if (!fs.existsSync(targetPath)) {
			console.log(JSON.stringify({
				configured: false,
				path: targetPath,
			}, null, 2));
			return;
		}
		const stat = fs.statSync(targetPath);
		let parsed = null;
		try {
			parsed = JSON.parse(fs.readFileSync(targetPath, "utf8"));
		} catch {
			console.log(JSON.stringify({
				configured: false,
				corrupt: true,
				path: targetPath,
				mode: (stat.mode & 0o777).toString(8).padStart(4, "0"),
			}, null, 2));
			process.exitCode = 1;
			return;
		}
		console.log(JSON.stringify({
			configured: Boolean(parsed && parsed.version === 1 && typeof parsed.username === "string"),
			path: targetPath,
			username: typeof parsed?.username === "string" ? parsed.username : null,
			updatedAt: typeof parsed?.updatedAt === "string" ? parsed.updatedAt : null,
			mode: (stat.mode & 0o777).toString(8).padStart(4, "0"),
		}, null, 2));
		return;
	}

	if (subcommand === "init") {
		const username = flags.username?.trim();
		if (!username) {
			throw new Error("--username is required for init");
		}
		if (fs.existsSync(targetPath) && !flags.force) {
			throw new Error(`Account already exists at ${targetPath}. Use reset-password or pass --force.`);
		}
		const password = await resolvePassword(flags);
		if (!password || password.length < 8) {
			throw new Error("Password must be at least 8 characters long");
		}
		const record = {
			version: 1,
			username,
			passwordHash: hashPassword(password),
			sessionSecret: randomBytes(32).toString("hex"),
			updatedAt: new Date().toISOString(),
		};
		writeAtomic0600(targetPath, `${JSON.stringify(record, null, "\t")}\n`);
		console.log(`Initialized LearnHarness account '${username}' at ${targetPath}`);
		return;
	}

	if (subcommand === "reset-password") {
		if (!fs.existsSync(targetPath)) {
			throw new Error(`No account file found at ${targetPath}. Run 'init' first.`);
		}
		const existing = JSON.parse(fs.readFileSync(targetPath, "utf8"));
		if (!existing || existing.version !== 1 || typeof existing.username !== "string" || !existing.username.trim()) {
			throw new Error(`Existing file at ${targetPath} is invalid`);
		}
		const password = await resolvePassword(flags);
		if (!password || password.length < 8) {
			throw new Error("Password must be at least 8 characters long");
		}
		const updated = {
			version: 1,
			username: existing.username,
			passwordHash: hashPassword(password),
			sessionSecret: randomBytes(32).toString("hex"),
			updatedAt: new Date().toISOString(),
		};
		writeAtomic0600(targetPath, `${JSON.stringify(updated, null, "\t")}\n`);
		console.log(`Reset password and rotated session secret for '${updated.username}' at ${targetPath}`);
		return;
	}

	console.error(`Unknown subcommand: ${subcommand}`);
	usage(1);
}

main().catch((err) => {
	console.error(`[user-auth] ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
