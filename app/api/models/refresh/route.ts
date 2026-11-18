import { modelCatalog, refreshConnectionCatalog } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let provider: string | undefined;
	const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
	if (contentType === "application/json") {
		try {
			const body = (await request.json()) as { provider?: unknown };
			if (typeof body?.provider === "string" && body.provider.trim()) {
				provider = body.provider.trim();
			}
		} catch {
			/* treat empty/malformed optional body as full refresh */
		}
	}
	await refreshConnectionCatalog(provider, { force: true });
	return Response.json(modelCatalog(), { headers: { "Cache-Control": "no-store" } });
}
