import { isAttachmentSha256 } from "@/src/core";
import { attachmentResponseHeaders, readAttachmentBytes } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(
	_request: Request,
	context: { params: Promise<{ id: string }> },
): Promise<Response> {
	const { id } = await context.params;
	if (!isAttachmentSha256(id)) {
		return Response.json({ error: "Invalid attachment id." }, { status: 400 });
	}
	try {
		const loaded = readAttachmentBytes(id);
		if (!loaded) {
			return Response.json({ error: "Attachment not found." }, { status: 404 });
		}
		return new Response(new Uint8Array(loaded.bytes), {
			status: 200,
			headers: attachmentResponseHeaders(loaded.meta),
		});
	} catch {
		return Response.json({ error: "Failed to read attachment." }, { status: 500 });
	}
}
