import {
	createSessionToken,
	readUserAuthRecord,
	serializeSessionCookie,
	verifyUserCredentials,
} from "@/src/server";

export const dynamic = "force-dynamic";

const MAX_LOGIN_BODY_BYTES = 4096;
const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
	if (Number(request.headers.get("content-length")) > MAX_LOGIN_BODY_BYTES) {
		return Response.json({ error: "Request body too large" }, { status: 413, headers: NO_STORE });
	}
	const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
	if (contentType !== "application/json") {
		return Response.json({ error: "Expected application/json" }, { status: 415, headers: NO_STORE });
	}
	const reader = request.body?.getReader();
	if (!reader) {
		return Response.json({ error: "Expected credentials payload" }, { status: 400, headers: NO_STORE });
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > MAX_LOGIN_BODY_BYTES) {
				await reader.cancel();
				return Response.json({ error: "Request body too large" }, { status: 413, headers: NO_STORE });
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return Response.json({ error: "Invalid JSON payload" }, { status: 400, headers: NO_STORE });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return Response.json({ error: "Invalid JSON payload" }, { status: 400, headers: NO_STORE });
	}
	const body = parsed as Record<string, unknown>;
	const username = typeof body.username === "string" ? body.username.trim() : "";
	const password = typeof body.password === "string" ? body.password : "";
	if (!username || !password) {
		return Response.json({ error: "Username and password are required" }, { status: 400, headers: NO_STORE });
	}

	if (!readUserAuthRecord()) {
		return Response.json(
			{ error: "Server account is not initialized. Run scripts/user-auth.mjs init on the server." },
			{ status: 503, headers: NO_STORE },
		);
	}

	const check = verifyUserCredentials(username, password);
	if (!check.ok) {
		return Response.json({ error: "Invalid username or password" }, { status: 401, headers: NO_STORE });
	}

	const token = createSessionToken(check.record);
	return Response.json(
		{ ok: true, username: check.record.username },
		{
			status: 200,
			headers: {
				...NO_STORE,
				"Set-Cookie": serializeSessionCookie(token, request),
			},
		},
	);
}
