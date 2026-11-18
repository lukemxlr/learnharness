import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AUTH_FILE } from "../../config.ts";
import type { SessionStatusResponse } from "../core/contracts/auth.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { browserOnlyMode, isHttpsRequest } from "./desktop-access.ts";

export const USER_AUTH_COOKIE_NAME = "lh_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const DUMMY_HASH = hashPassword("learnharness-constant-work-placeholder");

export interface UserAuthRecord {
	version: 1;
	username: string;
	passwordHash: string;
	sessionSecret: string;
	updatedAt: string;
}

export function resolveUserAuthPath(
	env: Record<string, string | undefined> = process.env,
): string {
	const authFile = env.LH_AUTH_FILE
		? path.resolve(/* turbopackIgnore: true */ env.LH_AUTH_FILE)
		: AUTH_FILE;
	return path.join(/* turbopackIgnore: true */ path.dirname(authFile), "user-auth.json");
}

export function isAuthRequired(
	env: Record<string, string | undefined> = process.env,
): boolean {
	if (!browserOnlyMode(env)) return false;
	if (env.LH_REQUIRE_AUTH === "1") return true;
	return fs.existsSync(/* turbopackIgnore: true */ resolveUserAuthPath(env));
}

export function hashPassword(password: string): string {
	const salt = randomBytes(16).toString("hex");
	const derived = scryptSync(password, salt, SCRYPT_KEYLEN, {
		N: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
	}).toString("hex");
	return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
	const parts = encoded.split("$");
	if (parts.length !== 6 || parts[0] !== "scrypt") return false;
	const N = Number(parts[1]);
	const r = Number(parts[2]);
	const p = Number(parts[3]);
	const salt = parts[4];
	const expectedHex = parts[5];
	if (!Number.isSafeInteger(N) || N < 1024 || !Number.isSafeInteger(r) || r < 1 || !Number.isSafeInteger(p) || p < 1 || !salt || !expectedHex) {
		return false;
	}
	let expected: Buffer;
	try {
		expected = Buffer.from(expectedHex, "hex");
	} catch {
		return false;
	}
	if (expected.length === 0) return false;
	const actual = scryptSync(password, salt, expected.length, { N, r, p });
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isValidUserAuthRecord(raw: unknown): raw is UserAuthRecord {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
	const r = raw as Record<string, unknown>;
	return (
		r.version === 1 &&
		typeof r.username === "string" &&
		r.username.trim().length > 0 &&
		typeof r.passwordHash === "string" &&
		r.passwordHash.startsWith("scrypt$") &&
		typeof r.sessionSecret === "string" &&
		/^[a-f0-9]{64,}$/i.test(r.sessionSecret) &&
		typeof r.updatedAt === "string" &&
		!Number.isNaN(Date.parse(r.updatedAt))
	);
}

export function readUserAuthRecord(
	env: Record<string, string | undefined> = process.env,
): UserAuthRecord | null {
	const file = resolveUserAuthPath(env);
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8"));
		return isValidUserAuthRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function writeUserAuthRecord(
	record: UserAuthRecord,
	env: Record<string, string | undefined> = process.env,
): void {
	if (!isValidUserAuthRecord(record)) {
		throw new Error("Invalid UserAuthRecord");
	}
	const file = resolveUserAuthPath(env);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	writeFileAtomicSync(file, `${JSON.stringify(record, null, "\t")}\n`, {
		mode: 0o600,
		allowInPlaceFallback: true,
	});
}

function timingSafeStringEqual(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

export function verifyUserCredentials(
	username: string,
	password: string,
	env: Record<string, string | undefined> = process.env,
): { ok: true; record: UserAuthRecord } | { ok: false; configured: boolean } {
	const record = readUserAuthRecord(env);
	if (!record) {
		verifyPassword(password, DUMMY_HASH);
		return { ok: false, configured: false };
	}
	const passwordMatch = verifyPassword(password, record.passwordHash);
	const userMatch = timingSafeStringEqual(username, record.username);
	if (!passwordMatch || !userMatch) {
		return { ok: false, configured: true };
	}
	return { ok: true, record };
}

interface SessionPayload {
	v: 1;
	u: string;
	iat: number;
	exp: number;
}

export function createSessionToken(record: UserAuthRecord, nowMs = Date.now()): string {
	const payload: SessionPayload = {
		v: 1,
		u: record.username,
		iat: nowMs,
		exp: nowMs + SESSION_TTL_SECONDS * 1000,
	};
	const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	const sig = createHmac("sha256", record.sessionSecret).update(payloadB64).digest("base64url");
	return `${payloadB64}.${sig}`;
}

export function parseCookieHeader(
	cookieHeader: string | null | undefined,
	name = USER_AUTH_COOKIE_NAME,
): string | undefined {
	if (!cookieHeader) return undefined;
	for (const part of cookieHeader.split(";")) {
		const idx = part.indexOf("=");
		if (idx <= 0) continue;
		const key = part.slice(0, idx).trim();
		if (key === name) {
			return part.slice(idx + 1).trim();
		}
	}
	return undefined;
}

export function verifyCookieValue(
	cookieValue: string | undefined,
	env: Record<string, string | undefined> = process.env,
	nowMs = Date.now(),
): SessionStatusResponse {
	const authRequired = isAuthRequired(env);
	const record = readUserAuthRecord(env);
	const configured = record !== null;
	if (!record || !cookieValue) {
		return { authenticated: false, configured, authRequired };
	}
	const dot = cookieValue.indexOf(".");
	if (dot <= 0 || dot !== cookieValue.lastIndexOf(".")) {
		return { authenticated: false, configured, authRequired };
	}
	const payloadB64 = cookieValue.slice(0, dot);
	const sig = cookieValue.slice(dot + 1);
	if (!payloadB64 || !sig) {
		return { authenticated: false, configured, authRequired };
	}
	const expectedSig = createHmac("sha256", record.sessionSecret).update(payloadB64).digest("base64url");
	if (!timingSafeStringEqual(sig, expectedSig)) {
		return { authenticated: false, configured, authRequired };
	}
	try {
		const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Partial<SessionPayload>;
		if (
			payload.v !== 1 ||
			typeof payload.u !== "string" ||
			!timingSafeStringEqual(payload.u, record.username) ||
			typeof payload.exp !== "number" ||
			!Number.isFinite(payload.exp) ||
			nowMs >= payload.exp
		) {
			return { authenticated: false, configured, authRequired };
		}
		return { authenticated: true, configured: true, authRequired, username: record.username };
	} catch {
		return { authenticated: false, configured, authRequired };
	}
}

export function isRequestAuthenticated(
	request: Request,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const cookieValue = parseCookieHeader(request.headers.get("cookie"));
	return verifyCookieValue(cookieValue, env).authenticated;
}

export function userAuthRefusal(
	request: Request,
	env: Record<string, string | undefined> = process.env,
): { status: 401; error: string } | undefined {
	if (!isAuthRequired(env)) return undefined;
	if (isRequestAuthenticated(request, env)) return undefined;
	return { status: 401, error: "Authentication required" };
}

export function serializeSessionCookie(
	token: string,
	request: Request,
	env: Record<string, string | undefined> = process.env,
): string {
	const parts = [
		`${USER_AUTH_COOKIE_NAME}=${token}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${SESSION_TTL_SECONDS}`,
	];
	if (isHttpsRequest(request, env)) parts.push("Secure");
	return parts.join("; ");
}

export function serializeClearSessionCookie(
	request: Request,
	env: Record<string, string | undefined> = process.env,
): string {
	const parts = [
		`${USER_AUTH_COOKIE_NAME}=`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		"Max-Age=0",
	];
	if (isHttpsRequest(request, env)) parts.push("Secure");
	return parts.join("; ");
}
