import { isAttachmentSha256 } from "@/src/core";
import {
	AttachmentValidationError,
	storeAttachment,
} from "@/src/server";
import { FormBodyLimitError, readBoundedFormData } from "@/lib/bounded-form-data";
import { MAX_IMPORT_BODY_BYTES } from "@/lib/notes-import-limits";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
	let form: FormData;
	try {
		form = await readBoundedFormData(request, MAX_IMPORT_BODY_BYTES, request.signal);
	} catch (error) {
		if (error instanceof FormBodyLimitError) {
			return Response.json({ error: "Attachment upload exceeds the size limit." }, { status: 413 });
		}
		if (error instanceof DOMException && error.name === "AbortError") {
			return Response.json({ error: "Attachment upload was cancelled." }, { status: 499 });
		}
		return Response.json({ error: "Invalid multipart attachment upload." }, { status: 400 });
	}

	const entry = form.get("file");
	if (!entry || typeof entry === "string" || typeof entry.arrayBuffer !== "function") {
		return Response.json({ error: 'Missing "file" upload field.' }, { status: 400 });
	}
	if (entry.size === 0) {
		return Response.json({ error: "Attachment is empty." }, { status: 400 });
	}

	const bytes = new Uint8Array(await entry.arrayBuffer());
	const filename = typeof (entry as File).name === "string" && (entry as File).name.trim()
		? (entry as File).name
		: "attachment";
	const mimeType = typeof entry.type === "string" && entry.type.trim() ? entry.type : undefined;

	try {
		const stored = storeAttachment({ bytes, filename, mimeType });
		if (!isAttachmentSha256(stored.ref.id)) {
			return Response.json({ error: "Failed to store attachment." }, { status: 500 });
		}
		return Response.json(stored.ref, { status: 201 });
	} catch (error) {
		if (error instanceof AttachmentValidationError) {
			return Response.json({ error: error.message }, { status: error.statusCode });
		}
		return Response.json({ error: "Failed to store attachment." }, { status: 500 });
	}
}
