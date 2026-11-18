import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	MAX_ATTACHMENT_IMAGE_BYTES,
	attachmentUrl,
	parseAttachmentMetaRecord,
	parseAttachmentRef,
	sanitizeAttachmentFilename,
} from "../src/core/contracts/attachments.ts";
import {
	attachmentResponseHeaders,
	detectAttachmentMimeType,
	readAttachmentBytes,
	readAttachmentMeta,
	resolveAttachmentFile,
	storeAttachment,
} from "../src/server/attachments.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

// Minimal valid 1x1 PNG
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
	"base64",
);
// Minimal valid JPEG SOI + APP0 header
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
// Minimal valid GIF89a
const GIF_BYTES = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "binary");
// Minimal RIFF WEBP header
const WEBP_BYTES = Buffer.concat([
	Buffer.from("RIFF", "ascii"),
	Buffer.from([0x1a, 0x00, 0x00, 0x00]),
	Buffer.from("WEBPVP8 ", "ascii"),
	Buffer.alloc(14, 0),
]);

const tempDirs: string[] = [];
function mkTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-attachments-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("Attachment contracts & server storage", () => {
	it("sanitizes Windows paths, traversal, control chars, and missing extensions", () => {
		assert.equal(sanitizeAttachmentFilename("C:\\Users\\Alice\\notes\\fig?1*.png", "image/png"), "fig_1_.png");
		assert.equal(sanitizeAttachmentFilename("../../etc/passwd", "application/pdf"), "passwd.pdf");
		assert.equal(sanitizeAttachmentFilename("..", "image/jpeg"), "attachment.jpg");
		assert.equal(sanitizeAttachmentFilename("  \x00\x1f  ", "image/webp"), "attachment.webp");
		assert.equal(sanitizeAttachmentFilename("diagram", "image/gif"), "diagram.gif");
	});

	it("stores PNG, JPEG, WebP, GIF, and PDF deterministically by SHA-256 and deduplicates", () => {
		const dataDir = mkTempDir();
		const pdfBytes = tinyPdf([{ runs: [{ text: "Triangle Sum", x: 72, y: 700 }] }]);

		const cases = [
			{ bytes: PNG_1X1, filename: "pixel.png", mimeType: "image/png" as const, kind: "image" as const },
			{ bytes: JPEG_BYTES, filename: "photo.jpg", mimeType: "image/jpeg" as const, kind: "image" as const },
			{ bytes: WEBP_BYTES, filename: "diagram.webp", mimeType: "image/webp" as const, kind: "image" as const },
			{ bytes: GIF_BYTES, filename: "anim.gif", mimeType: "image/gif" as const, kind: "image" as const },
			{ bytes: pdfBytes, filename: "notes.pdf", mimeType: "application/pdf" as const, kind: "pdf" as const },
		];

		for (const item of cases) {
			const first = storeAttachment({
				bytes: item.bytes,
				filename: item.filename,
				mimeType: item.mimeType,
				dataDir,
				createdAt: "2026-11-18T12:00:00.000Z",
			});
			assert.equal(first.deduplicated, false);
			assert.equal(first.ref.mimeType, item.mimeType);
			assert.equal(first.ref.kind, item.kind);
			assert.equal(first.ref.sizeBytes, item.bytes.byteLength);
			assert.equal(first.ref.url, attachmentUrl(first.ref.id));
			assert.deepEqual(parseAttachmentRef(first.ref), first.ref);
			assert.deepEqual(parseAttachmentMetaRecord(first.meta), first.meta);

			assert(fs.existsSync(first.filePath));
			assert(fs.existsSync(first.metaPath));

			const second = storeAttachment({
				bytes: item.bytes,
				filename: "renamed-duplicate." + item.filename.split(".").pop(),
				mimeType: item.mimeType,
				dataDir,
				createdAt: "2026-11-19T00:00:00.000Z",
			});
			assert.equal(second.deduplicated, true);
			assert.equal(second.ref.filename, first.ref.filename);
			assert.equal(second.meta.createdAt, first.meta.createdAt);

			const loaded = readAttachmentBytes(first.ref.id, dataDir);
			assert(loaded);
			assert.equal(loaded.bytes.equals(Buffer.from(item.bytes)), true);

			const headers = attachmentResponseHeaders(loaded.meta);
			assert.equal(headers["Content-Type"], item.mimeType);
			assert.equal(headers["X-Content-Type-Options"], "nosniff");
			assert.equal(headers["Cache-Control"], "private, no-store");
		}
	});

	it("rejects MIME spoofing, unsupported formats, empty payloads, and oversized attachments", () => {
		const dataDir = mkTempDir();
		assert.throws(() => storeAttachment({ bytes: Buffer.alloc(0), filename: "empty.png", dataDir }), /empty/i);
		assert.throws(
			() => storeAttachment({ bytes: Buffer.from("<html><script>alert(1)</script></html>"), filename: "xss.html", dataDir }),
			/Unsupported/i,
		);
		assert.throws(
			() => storeAttachment({ bytes: PNG_1X1, filename: "fake.pdf", mimeType: "application/pdf", dataDir }),
			/do not match/i,
		);
		assert.throws(
			() => storeAttachment({ bytes: Buffer.from("not a pdf"), filename: "bad.pdf", mimeType: "application/pdf", dataDir }),
			/Unsupported/i,
		);
		assert.equal(detectAttachmentMimeType(Buffer.from("BM\x20\x00\x00\x00")), null);

		const huge = Buffer.alloc(MAX_ATTACHMENT_IMAGE_BYTES + 1, 0);
		PNG_1X1.copy(huge, 0, 0, 24);
		assert.throws(() => storeAttachment({ bytes: huge, filename: "huge.png", mimeType: "image/png", dataDir }), /limit/i);
	});

	it("rejects path traversal and symlinks when reading attachments", () => {
		const dataDir = mkTempDir();
		const stored = storeAttachment({ bytes: PNG_1X1, filename: "safe.png", dataDir });
		assert.equal(readAttachmentMeta("../etc/passwd", dataDir), null);
		assert.equal(resolveAttachmentFile("not-a-sha256", dataDir), null);

		const secretFile = path.join(dataDir, "secret.txt");
		fs.writeFileSync(secretFile, "top-secret");
		fs.unlinkSync(stored.filePath);
		fs.symlinkSync(secretFile, stored.filePath);
		assert.equal(resolveAttachmentFile(stored.ref.id, dataDir), null);
		assert.equal(readAttachmentBytes(stored.ref.id, dataDir), null);
	});
});
