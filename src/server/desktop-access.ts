import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

/** Browser-only mode: `next dev` / `next start` without the desktop shell's
 * per-launch secret. */
export function browserOnlyMode(env: Record<string, string | undefined> = process.env): boolean {
	return env.LH_DESKTOP_SERVER !== "1" && !env.LH_DESKTOP_API_SECRET;
}

/** Whether reverse-proxy X-Forwarded-Proto / X-Forwarded-Host headers are trusted. */
export function trustProxy(env: Record<string, string | undefined> = process.env): boolean {
	return env.LH_TRUST_PROXY === "1";
}

function firstHeaderToken(value: string | null): string | undefined {
	if (!value) return undefined;
	const token = value.split(",")[0]?.trim();
	return token || undefined;
}

export function effectiveRequestProto(
	request: Request,
	env: Record<string, string | undefined> = process.env,
): "http:" | "https:" | undefined {
	if (trustProxy(env) && request.headers.has("x-forwarded-proto")) {
		const token = firstHeaderToken(request.headers.get("x-forwarded-proto"))?.toLowerCase();
		if (token === "https") return "https:";
		if (token === "http") return "http:";
		return undefined;
	}
	try {
		const protocol = new URL(request.url).protocol;
		return protocol === "http:" || protocol === "https:" ? protocol : undefined;
	} catch {
		return undefined;
	}
}

export function effectiveRequestHost(
	request: Request,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	if (trustProxy(env) && request.headers.has("x-forwarded-host")) {
		return firstHeaderToken(request.headers.get("x-forwarded-host"));
	}
	const host = request.headers.get("host");
	if (host !== null) return host.trim() || undefined;
	try {
		return new URL(request.url).host || undefined;
	} catch {
		return undefined;
	}
}

export function isHttpsRequest(
	request: Request,
	env: Record<string, string | undefined> = process.env,
): boolean {
	return effectiveRequestProto(request, env) === "https:";
}

/** Per-launch desktop HTTP capability. This is not an OS-user malware
 * boundary and is not an OAuth credential. Browser-only mode is checked by
 * browserAPIRefusal instead. */
export function desktopAPIAuthorized(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const expected = env.LH_DESKTOP_API_SECRET;
	if (browserOnlyMode(env)) return true;
	if (!expected || expected.length < 64) return false;
	const supplied = headers.get("x-learnharness-desktop");
	if (!supplied) return false;
	const actual = Buffer.from(supplied);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function parseValidatedHost(
	proto: "http:" | "https:",
	host: string | null | undefined,
): URL | undefined {
	if (!host || /[\s@?#\/\\]/.test(host)) return undefined;
	try {
		const parsed = new URL(`${proto}//${host}`);
		if (
			!["http:", "https:"].includes(parsed.protocol) ||
			parsed.username ||
			parsed.password ||
			parsed.pathname !== "/" ||
			parsed.search ||
			parsed.hash ||
			!parsed.hostname
		) {
			return undefined;
		}
		return parsed;
	} catch {
		return undefined;
	}
}

/** Same-origin browser controls, honoring X-Forwarded-Proto/Host only when
 * LH_TRUST_PROXY=1 is explicitly enabled behind a trusted reverse proxy. */
export function subscriptionRequestOrigin(
	request: Request,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	const proto = effectiveRequestProto(request, env);
	if (!proto) return;
	const host = effectiveRequestHost(request, env);
	return parseValidatedHost(proto, host)?.origin;
}

/** DNS rebinding needs an attacker-owned DNS name, so localhost names and IP
 * literals are always safe. Any other name must be listed in LH_ALLOWED_HOSTS
 * (comma-separated, case-insensitive, port ignored). */
export function browserHostAllowed(host: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
	const parsed = parseValidatedHost("http:", host);
	if (!parsed) return false;
	const hostname = parsed.hostname.toLowerCase();
	if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
	if (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) return true;
	const allowed = (env.LH_ALLOWED_HOSTS ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
	return allowed.includes(hostname);
}

/** Shared by Proxy and the streamed document route that deliberately bypasses
 * Proxy's truncated body clone. Check before any route-specific work. */
export function apiRequestRefusal(request: Request, env: Record<string, string | undefined> = process.env): string | undefined {
	if (browserOnlyMode(env)) return browserAPIRefusal(request, env);
	if (!desktopAPIAuthorized(request.headers, env)) return "Desktop API access requires the trusted LearnHarness window.";
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Browser-only API gate: a Host check against DNS rebinding and a
 * cross-site check on writes. Writes without Origin or Sec-Fetch-Site come
 * from non-browser clients and are allowed. Returns the refusal, if any. */
export function browserAPIRefusal(request: Request, env: Record<string, string | undefined> = process.env): string | undefined {
	if (!browserHostAllowed(effectiveRequestHost(request, env) ?? null, env)) {
		return "This host name is not allowed. Use localhost or an IP address, or add the name to LH_ALLOWED_HOSTS.";
	}
	if (READ_METHODS.has(request.method.toUpperCase())) return;
	const site = request.headers.get("sec-fetch-site");
	const origin = request.headers.get("origin");
	if ((site !== null && site !== "same-origin") || (origin !== null && origin !== subscriptionRequestOrigin(request, env))) {
		return "Cross-site requests to the LearnHarness API are not allowed.";
	}
}
