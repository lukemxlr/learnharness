/**
 * Single-account auth contracts — pure browser-safe types and redirect validation.
 */

export interface SessionStatusResponse {
	authenticated: boolean;
	configured: boolean;
	authRequired: boolean;
	username?: string;
}

/** Sanitize post-login `next` redirect targets to safe same-origin relative paths. */
export function sanitizeNextPath(next: string | null | undefined): string {
	if (typeof next !== "string") return "/";
	const trimmed = next.trim();
	if (!trimmed.startsWith("/")) return "/";
	if (trimmed.startsWith("//") || trimmed.startsWith("/\\")) return "/";
	if (/[\x00-\x1f\x7f\\]/.test(trimmed)) return "/";
	try {
		const parsed = new URL(trimmed, "http://localhost");
		if (parsed.origin !== "http://localhost") return "/";
		return `${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return "/";
	}
}
