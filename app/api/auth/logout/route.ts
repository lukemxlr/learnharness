import { serializeClearSessionCookie } from "@/src/server";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
	return Response.json(
		{ ok: true },
		{
			status: 200,
			headers: {
				"Cache-Control": "no-store",
				"Set-Cookie": serializeClearSessionCookie(request),
			},
		},
	);
}
