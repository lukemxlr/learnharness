import { NextResponse, type NextRequest } from "next/server";
import { sanitizeNextPath } from "./src/core/contracts/auth.ts";
import {
	apiRequestRefusal,
	browserHostAllowed,
	browserOnlyMode,
	effectiveRequestHost,
	subscriptionRequestOrigin,
} from "./src/server/desktop-access.ts";
import { isAuthRequired, isRequestAuthenticated, userAuthRefusal } from "./src/server/user-auth.ts";

const PUBLIC_API_ROUTES = new Set([
	"/api/health",
	"/api/auth/login",
	"/api/auth/logout",
	"/api/auth/session",
]);

/** Protects API routes and page routes. The streamed plugin document route
 * enforces the identical host/CSRF/user-auth policy inside its handler,
 * avoiding Next's silently truncated Proxy body clone. */
export function proxy(request: NextRequest) {
	const pathname = request.nextUrl.pathname;

	if (pathname === "/api" || pathname.startsWith("/api/")) {
		const refusal = apiRequestRefusal(request);
		if (refusal) {
			return NextResponse.json(
				{ error: refusal },
				{ status: 403, headers: { "Cache-Control": "no-store" } },
			);
		}
		if (!PUBLIC_API_ROUTES.has(pathname)) {
			const authRefusal = userAuthRefusal(request);
			if (authRefusal) {
				return NextResponse.json(
					{ error: authRefusal.error },
					{ status: authRefusal.status, headers: { "Cache-Control": "no-store" } },
				);
			}
		}
		return NextResponse.next();
	}

	if (browserOnlyMode() && !browserHostAllowed(effectiveRequestHost(request))) {
		return NextResponse.json(
			{ error: "This host name is not allowed. Use localhost or an IP address, or add the name to LH_ALLOWED_HOSTS." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}

	if (pathname === "/login") {
		return NextResponse.next();
	}

	if (isAuthRequired() && !isRequestAuthenticated(request)) {
		const origin = subscriptionRequestOrigin(request) ?? request.nextUrl.origin;
		const safeNext = sanitizeNextPath(`${pathname}${request.nextUrl.search}`);
		const loginUrl = new URL(`/login?next=${encodeURIComponent(safeNext)}`, origin);
		const response = NextResponse.redirect(loginUrl, 302);
		response.headers.set("Cache-Control", "no-store");
		return response;
	}

	return NextResponse.next();
}

export const config = {
	// Keep /api itself covered while exempting only the streamed document endpoint;
	// also cover all app page routes for Host and single-account auth gating.
	matcher: [
		"/",
		"/login",
		"/chat/:path*",
		"/settings",
		"/settings/:path*",
		"/plugins/:path*",
		"/api",
		"/api/((?!plugins/[^/]+/documents/markdown/?$).*)",
	],
};
