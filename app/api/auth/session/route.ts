import { parseCookieHeader, verifyCookieValue } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
	const cookieValue = parseCookieHeader(request.headers.get("cookie"));
	const status = verifyCookieValue(cookieValue);
	return Response.json(
		{
			authenticated: status.authenticated,
			configured: status.configured,
			authRequired: status.authRequired,
			...(status.authenticated && status.username ? { username: status.username } : {}),
		},
		{
			status: 200,
			headers: { "Cache-Control": "no-store" },
		},
	);
}
