import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { detectSupportedImageMimeType } from "../agent/image-processing/index.ts";
import {
	attachmentKindForMime,
	attachmentMaxBytesForKind,
	attachmentUrl,
	isAttachmentSha256,
	normalizeAttachmentMimeType,
	parseAttachmentMetaRecord,
	sanitizeAttachmentFilename,
	type AttachmentMetaRecord,
	type AttachmentMimeType,
	type AttachmentRef,
} from "../core/contracts/attachments.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";

const PDF_MAGIC = Buffer.from("%PDF-", "ascii");

export class AttachmentValidationError extends Error {
	readonly statusCode: 400 | 413 | 415;
	constructor(message: string, statusCode: 400 | 413 | 415) {
		super(message);
		this.name = "AttachmentValidationError";
		this.statusCode = statusCode;
	}
}

export interface StoreAttachmentInput {
	bytes: Uint8Array;
	filename: string;
	mimeType?: string;
	dataDir?: string;
	createdAt?: string;
}

export interface StoredAttachmentResult {
	ref: AttachmentRef;
	meta: AttachmentMetaRecord;
	deduplicated: boolean;
	filePath: string;
	metaPath: string;
}

export function detectAttachmentMimeType(bytes: Uint8Array): AttachmentMimeType | null {
	if (bytes.byteLength === 0) return null;
	const imageMime = detectSupportedImageMimeType(bytes);
	if (imageMime === "image/png" || imageMime === "image/jpeg" || imageMime === "image/webp" || imageMime === "image/gif") {
		return imageMime;
	}
	// Accept PDF magic header only at start (after optional UTF-8 BOM / ASCII whitespace),
	// rejecting HTML/script polyglot prefixes before %PDF-.
	const limit = Math.min(bytes.byteLength, 1024);
	let offset = 0;
	if (limit >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		offset = 3;
	}
	while (offset < limit && (bytes[offset] === 0x20 || bytes[offset] === 0x09 || bytes[offset] === 0x0a || bytes[offset] === 0x0d)) {
		offset++;
	}
	if (limit - offset >= PDF_MAGIC.byteLength && Buffer.from(bytes.subarray(offset, offset + PDF_MAGIC.byteLength)).equals(PDF_MAGIC)) {
		return "application/pdf";
	}
	return null;
}

function assertNotSymlinkOrEscaping(root: string, target: string, expectedType?: "dir" | "file"): void {
	const resolvedRoot = path.resolve(/* turbopackIgnore: true */ root);
	const resolvedTarget = path.resolve(/* turbopackIgnore: true */ target);
	const relative = path.relative(resolvedRoot, resolvedTarget);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error("Attachment path escapes attachments root");
	}
	const stat = fs.lstatSync(resolvedTarget, { throwIfNoEntry: false });
	if (!stat) return;
	if (stat.isSymbolicLink()) {
		throw new Error("Attachment path cannot be a symbolic link");
	}
	if (expectedType === "dir" && !stat.isDirectory()) {
		throw new Error("Attachment path is not a directory");
	}
	if (expectedType === "file" && !stat.isFile()) {
		throw new Error("Attachment path is not a regular file");
	}
}

function attachmentsRoot(dataDir: string): string {
	return path.join(/* turbopackIgnore: true */ path.resolve(/* turbopackIgnore: true */ dataDir), "attachments");
}

function writeBinaryAtomicSync(file: string, bytes: Uint8Array, mode = 0o644): void {
	const tmp = `${file}.tmp-${randomUUID()}`;
	try {
		const fd = fs.openSync(tmp, "wx", mode);
		try {
			fs.fchmodSync(fd, mode);
			fs.writeFileSync(fd, bytes);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, file);
	} catch (error) {
		try { fs.unlinkSync(tmp); } catch { /* ignore */ }
		throw error;
	}
}

function toRef(meta: AttachmentMetaRecord): AttachmentRef {
	const kind = attachmentKindForMime(meta.mimeType);
	if (!kind) throw new Error(`Unsupported stored MIME type: ${meta.mimeType}`);
	return {
		id: meta.id,
		filename: meta.filename,
		mimeType: meta.mimeType,
		sizeBytes: meta.sizeBytes,
		kind,
		url: attachmentUrl(meta.id),
	};
}

export function storeAttachment(input: StoreAttachmentInput): StoredAttachmentResult {
	const { bytes, filename, mimeType: declaredRaw, dataDir = PATHS.data, createdAt } = input;
	if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
		throw new AttachmentValidationError("Attachment is empty", 400);
	}
	const sniffed = detectAttachmentMimeType(bytes);
	if (!sniffed) {
		throw new AttachmentValidationError("Unsupported or unrecognized attachment format", 415);
	}
	if (declaredRaw !== undefined && declaredRaw.trim() !== "") {
		const normalizedDeclared = normalizeAttachmentMimeType(declaredRaw);
		if (!normalizedDeclared || normalizedDeclared !== sniffed) {
			throw new AttachmentValidationError(`Attachment bytes (${sniffed}) do not match declared MIME type (${declaredRaw})`, 415);
		}
	}
	const kind = attachmentKindForMime(sniffed)!;
	const maxBytes = attachmentMaxBytesForKind(kind);
	if (bytes.byteLength > maxBytes) {
		throw new AttachmentValidationError(`Attachment exceeds ${Math.round(maxBytes / (1024 * 1024))} MiB limit`, 413);
	}

	const id = createHash("sha256").update(bytes).digest("hex");
	const root = attachmentsRoot(dataDir);
	fs.mkdirSync(root, { recursive: true });
	assertNotSymlinkOrEscaping(root, root, "dir");

	const shaDir = path.join(/* turbopackIgnore: true */ root, id);
	const metaPath = path.join(/* turbopackIgnore: true */ root, `${id}.meta.json`);
	assertNotSymlinkOrEscaping(root, shaDir, "dir");
	assertNotSymlinkOrEscaping(root, metaPath, "file");

	const existingMeta = readAttachmentMeta(id, dataDir);
	if (existingMeta) {
		const existingFilePath = path.join(/* turbopackIgnore: true */ shaDir, existingMeta.filename);
		assertNotSymlinkOrEscaping(shaDir, existingFilePath, "file");
		const fileStat = fs.lstatSync(existingFilePath, { throwIfNoEntry: false });
		if (
			existingMeta.mimeType === sniffed &&
			existingMeta.sizeBytes === bytes.byteLength &&
			fileStat?.isFile() &&
			!fileStat.isSymbolicLink() &&
			fileStat.size === bytes.byteLength
		) {
			const existingDigest = createHash("sha256").update(fs.readFileSync(existingFilePath)).digest("hex");
			if (existingDigest === id) {
				return {
					ref: toRef(existingMeta),
					meta: existingMeta,
					deduplicated: true,
					filePath: existingFilePath,
					metaPath,
				};
			}
		}
	}

	const sanitized = sanitizeAttachmentFilename(filename, sniffed);
	const filePath = path.join(/* turbopackIgnore: true */ shaDir, sanitized);
	fs.mkdirSync(shaDir, { recursive: true });
	assertNotSymlinkOrEscaping(root, shaDir, "dir");
	assertNotSymlinkOrEscaping(shaDir, filePath, "file");

	const timestamp = createdAt && !Number.isNaN(Date.parse(createdAt))
		? new Date(createdAt).toISOString()
		: new Date().toISOString();

	const meta: AttachmentMetaRecord = {
		id,
		filename: sanitized,
		mimeType: sniffed,
		sizeBytes: bytes.byteLength,
		createdAt: timestamp,
	};

	writeBinaryAtomicSync(filePath, bytes);
	try {
		writeFileAtomicSync(metaPath, `${JSON.stringify(meta, null, "\t")}\n`, { allowInPlaceFallback: true });
	} catch (error) {
		try { fs.unlinkSync(filePath); } catch { /* ignore */ }
		try { fs.rmdirSync(shaDir); } catch { /* ignore */ }
		throw error;
	}

	return {
		ref: toRef(meta),
		meta,
		deduplicated: false,
		filePath,
		metaPath,
	};
}

export function readAttachmentMeta(id: string, dataDir: string = PATHS.data): AttachmentMetaRecord | null {
	if (!isAttachmentSha256(id)) return null;
	const root = attachmentsRoot(dataDir);
	const metaPath = path.join(/* turbopackIgnore: true */ root, `${id}.meta.json`);
	try {
		assertNotSymlinkOrEscaping(root, root, "dir");
		assertNotSymlinkOrEscaping(root, metaPath, "file");
		const stat = fs.lstatSync(metaPath, { throwIfNoEntry: false });
		if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
		const parsed = parseAttachmentMetaRecord(JSON.parse(fs.readFileSync(metaPath, "utf8")));
		if (parsed.id !== id) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function resolveAttachmentFile(
	id: string,
	dataDir: string = PATHS.data,
): { meta: AttachmentMetaRecord; filePath: string } | null {
	const meta = readAttachmentMeta(id, dataDir);
	if (!meta) return null;
	const root = attachmentsRoot(dataDir);
	const shaDir = path.join(/* turbopackIgnore: true */ root, id);
	const filePath = path.join(/* turbopackIgnore: true */ shaDir, meta.filename);
	try {
		assertNotSymlinkOrEscaping(root, shaDir, "dir");
		assertNotSymlinkOrEscaping(shaDir, filePath, "file");
		const dirStat = fs.lstatSync(shaDir, { throwIfNoEntry: false });
		const fileStat = fs.lstatSync(filePath, { throwIfNoEntry: false });
		if (!dirStat || !dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
		if (!fileStat || !fileStat.isFile() || fileStat.isSymbolicLink()) return null;
		if (fileStat.size !== meta.sizeBytes) return null;
		return { meta, filePath };
	} catch {
		return null;
	}
}

export function readAttachmentBytes(
	id: string,
	dataDir: string = PATHS.data,
): { meta: AttachmentMetaRecord; bytes: Buffer } | null {
	const resolved = resolveAttachmentFile(id, dataDir);
	if (!resolved) return null;
	const bytes = fs.readFileSync(resolved.filePath);
	if (bytes.byteLength !== resolved.meta.sizeBytes) return null;
	return { meta: resolved.meta, bytes };
}

export function attachmentResponseHeaders(meta: AttachmentMetaRecord): Record<string, string> {
	const asciiFallback = meta.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "attachment";
	const encoded = encodeURIComponent(meta.filename);
	return {
		"Content-Type": meta.mimeType,
		"Content-Length": String(meta.sizeBytes),
		"Content-Disposition": `inline; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": "default-src 'none'; sandbox",
		"Cache-Control": "private, no-store",
	};
}
