import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { PATHS } from "../config.ts";
import { MAX_ATTACHMENT_IMAGE_BYTES, parseAttachmentRef } from "../src/core/contracts/attachments.ts";
import { MAX_IMPORT_BODY_BYTES } from "../lib/notes-import-limits.ts";
import { POST } from "../app/api/attachments/route.ts";
import { GET } from "../app/api/attachments/[id]/route.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
	"base64",
);

const createdIds = new Set<string>();

function attachmentsRoot(): string {
	return path.join(PATHS.data, "attachments");
}

function listAttachmentEntries(): string[] {
	const root = attachmentsRoot();
	if (!fs.existsSync(root)) return [];
	return fs.readdirSync(root).sort();
}

function makeUploadRequest(file: File | null, extraField?: { name: string; value: string }): Request {
	const form = new FormData();
	if (file) form.append("file", file);
	if (extraField) form.append(extraField.name, extraField.value);
	return new Request("http://localhost/api/attachments", {
		method: "POST",
		body: form,
	});
}

afterEach(() => {
	const root = attachmentsRoot();
	for (const id of createdIds) {
		fs.rmSync(path.join(root, id), { recursive: true, force: true });
	}
	createdIds.clear();
});

describe("POST /api/attachments & GET /api/attachments/[id]", () => {
	it("stores valid PNG and PDF, deduplicates by sha256, and serves bytes with nosniff + sandbox CSP", async () => {
		const pngFile = new File([PNG_1X1], "sketch.png", { type: "image/png" });
		const res1 = await POST(makeUploadRequest(pngFile));
		assert.equal(res1.status, 201);
		const ref1 = parseAttachmentRef(await res1.json());
		assert.ok(ref1);
		createdIds.add(ref1.id);
		const expectedSha = crypto.createHash("sha256").update(PNG_1X1).digest("hex");
		assert.equal(ref1.id, expectedSha);
		assert.equal(ref1.kind, "image");
		assert.equal(ref1.mimeType, "image/png");
		assert.equal(ref1.sizeBytes, PNG_1X1.length);
		assert.equal(ref1.url, `/api/attachments/${expectedSha}`);

		// GET returns exact bytes and strict hardening headers.
		const getRes = await GET(new Request(`http://localhost${ref1.url}`), { params: Promise.resolve({ id: ref1.id }) });
		assert.equal(getRes.status, 200);
		assert.equal(getRes.headers.get("Content-Type"), "image/png");
		assert.equal(getRes.headers.get("X-Content-Type-Options"), "nosniff");
		assert.equal(getRes.headers.get("Content-Security-Policy"), "default-src 'none'; sandbox");
		const gotBytes = Buffer.from(await getRes.arrayBuffer());
		assert.ok(gotBytes.equals(PNG_1X1));

		// PDF upload and GET with inline filename disposition.
		const pdfBytes = tinyPdf([{ runs: [{ text: "Hello attachment PDF", x: 72, y: 720 }] }]);
		const pdfRes = await POST(makeUploadRequest(new File([pdfBytes], "notes.pdf", { type: "application/pdf" })));
		assert.equal(pdfRes.status, 201);
		const pdfRef = parseAttachmentRef(await pdfRes.json());
		assert.ok(pdfRef);
		createdIds.add(pdfRef.id);
		assert.equal(pdfRef.kind, "pdf");
		assert.equal(pdfRef.mimeType, "application/pdf");

		const getPdf = await GET(new Request(`http://localhost${pdfRef.url}`), { params: Promise.resolve({ id: pdfRef.id }) });
		assert.equal(getPdf.status, 200);
		assert.equal(getPdf.headers.get("Content-Type"), "application/pdf");
		assert.equal(getPdf.headers.get("X-Content-Type-Options"), "nosniff");
		assert.equal(getPdf.headers.get("Content-Security-Policy"), "default-src 'none'; sandbox");
		assert.match(getPdf.headers.get("Content-Disposition") ?? "", /inline; filename=/);
	});

	it("rejects missing, empty, XSS/SVG, spoofed, and fake/polyglot PDFs with 400/415 and leaves zero partial files", async () => {
		const before = listAttachmentEntries();

		const missingRes = await POST(makeUploadRequest(null, { name: "note", value: "hi" }));
		assert.equal(missingRes.status, 400);
		const missingBody = (await missingRes.json()) as { error?: string };
		assert.ok(missingBody.error);

		const emptyRes = await POST(makeUploadRequest(new File([], "empty.png", { type: "image/png" })));
		assert.equal(emptyRes.status, 400);

		const payloads: Array<{ name: string; type: string; bytes: Uint8Array }> = [
			{ name: "xss.html", type: "text/html", bytes: Buffer.from("<html><script>alert(1)</script></html>") },
			{ name: "evil.svg", type: "image/svg+xml", bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>') },
			{ name: "spoofed.png", type: "image/png", bytes: Buffer.from("<html><body>not a png</body></html>") },
			{ name: "fake.pdf", type: "application/pdf", bytes: Buffer.from("plain text pretending to be a pdf") },
			{ name: "polyglot.pdf", type: "application/pdf", bytes: Buffer.concat([Buffer.from("GIF89a\x01\x00"), Buffer.from("%PDF-1.4\n%%EOF")]) },
			{ name: "script.js", type: "application/javascript", bytes: Buffer.from("console.log(1)") },
		];

		for (const sample of payloads) {
			const res = await POST(makeUploadRequest(new File([new Uint8Array(sample.bytes)], sample.name, { type: sample.type })));
			assert.ok(res.status === 400 || res.status === 415, `expected 400/415 for ${sample.name}, got ${res.status}`);
			const json = (await res.json()) as { error?: string };
			assert.ok(typeof json.error === "string" && json.error.length > 0);
		}

		assert.deepEqual(listAttachmentEntries(), before, "rejected uploads must leave zero partial files");
	});

	it("rejects oversized images (>20 MiB) and oversized bodies (>26 MiB) with 413 and zero partial files", async () => {
		const before = listAttachmentEntries();

		const bigPngHeader = Buffer.alloc(MAX_ATTACHMENT_IMAGE_BYTES + 64, 0);
		PNG_1X1.copy(bigPngHeader, 0, 0, 24); // valid PNG + IHDR header
		const tooBigImgRes = await POST(makeUploadRequest(new File([bigPngHeader], "huge.png", { type: "image/png" })));
		assert.equal(tooBigImgRes.status, 413);
		const imgErr = (await tooBigImgRes.json()) as { error?: string };
		assert.ok(imgErr.error);

		const overBodyRes = await POST(
			new Request("http://localhost/api/attachments", {
				method: "POST",
				headers: {
					"Content-Type": "multipart/form-data; boundary=----bound",
					"Content-Length": String(MAX_IMPORT_BODY_BYTES + 1024),
				},
				body: "x",
			}),
		);
		assert.equal(overBodyRes.status, 413);
		const bodyErr = (await overBodyRes.json()) as { error?: string };
		assert.ok(bodyErr.error);

		assert.deepEqual(listAttachmentEntries(), before);
	});

	it("returns 400/404 for invalid or missing IDs on GET without exposing paths or stack traces", async () => {
		for (const badId of ["../etc/passwd", "not-a-sha", "ZZZZ", "0".repeat(63)]) {
			const res = await GET(new Request(`http://localhost/api/attachments/${encodeURIComponent(badId)}`), {
				params: Promise.resolve({ id: badId }),
			});
			assert.equal(res.status, 400);
			const text = await res.text();
			assert.doesNotMatch(text, /dataDir|rootDir|attachments|Error:|at\s+\//);
		}

		const missingSha = "f".repeat(64);
		const notFound = await GET(new Request(`http://localhost/api/attachments/${missingSha}`), {
			params: Promise.resolve({ id: missingSha }),
		});
		assert.equal(notFound.status, 404);
		const notFoundText = await notFound.text();
		assert.doesNotMatch(notFoundText, /dataDir|rootDir|Users|Error:|at\s+\//);
		assert.ok(!notFoundText.includes(PATHS.data));
	});
});
