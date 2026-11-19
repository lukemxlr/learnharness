/**
 * Shared attachment storage contracts — browser-safe pure types, validation,
 * and filename/URL helpers. Re-exported via `@/src/core`.
 */

export const ATTACHMENT_SHA256_RE = /^[a-f0-9]{64}$/;

export const ATTACHMENT_IMAGE_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
] as const;

export const ATTACHMENT_PDF_MIME_TYPE = "application/pdf" as const;

export const ATTACHMENT_MIME_TYPES = [
	...ATTACHMENT_IMAGE_MIME_TYPES,
	ATTACHMENT_PDF_MIME_TYPE,
] as const;

export type AttachmentMimeType = (typeof ATTACHMENT_MIME_TYPES)[number];
export type AttachmentKind = "image" | "pdf";

// Aligned with lib/notes-import-limits.ts (25 MiB max file, 26 MiB multipart ceiling).
export const MAX_ATTACHMENT_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_PDF_BYTES = 25 * 1024 * 1024;

export interface AttachmentRef {
	id: string;
	filename: string;
	mimeType: AttachmentMimeType;
	sizeBytes: number;
	kind: AttachmentKind;
	url: string;
}

export interface AttachmentMetaRecord {
	id: string;
	filename: string;
	mimeType: AttachmentMimeType;
	sizeBytes: number;
	createdAt: string;
}

const MIME_EXTENSIONS: Record<AttachmentMimeType, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"application/pdf": "pdf",
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function isAttachmentSha256(id: unknown): id is string {
	return typeof id === "string" && ATTACHMENT_SHA256_RE.test(id);
}

export function normalizeAttachmentMimeType(mimeType: string): AttachmentMimeType | null {
	const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (base === "image/jpg") return "image/jpeg";
	if ((ATTACHMENT_MIME_TYPES as readonly string[]).includes(base)) {
		return base as AttachmentMimeType;
	}
	return null;
}

export function attachmentKindForMime(mimeType: string): AttachmentKind | null {
	const normalized = normalizeAttachmentMimeType(mimeType);
	if (!normalized) return null;
	return normalized === ATTACHMENT_PDF_MIME_TYPE ? "pdf" : "image";
}

export function attachmentMaxBytesForKind(kind: AttachmentKind): number {
	return kind === "pdf" ? MAX_ATTACHMENT_PDF_BYTES : MAX_ATTACHMENT_IMAGE_BYTES;
}

export function attachmentUrl(id: string): string {
	if (!isAttachmentSha256(id)) {
		throw new Error(`Invalid attachment SHA-256 id: ${String(id)}`);
	}
	return `/api/attachments/${id}`;
}

const WIN32_RESERVED_STEM_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function sanitizeAttachmentFilename(raw: string, mimeType: AttachmentMimeType): string {
	const defaultExt = MIME_EXTENSIONS[mimeType];
	const rawBase = (raw.split(/[\\/]/).pop() ?? "")
		.replace(/[\x00-\x1f\x7f]/g, "")
		.replace(/[<>:"/\\|?*]/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s]+|[.\s]+$/g, "");

	if (!rawBase || rawBase === "." || rawBase === "..") {
		return `attachment.${defaultExt}`;
	}

	const lastDot = rawBase.lastIndexOf(".");
	const hasExt = lastDot > 0 && lastDot < rawBase.length - 1;
	let stem = (hasExt ? rawBase.slice(0, lastDot) : rawBase)
		.trim()
		.replace(/^[.\s]+|[.\s]+$/g, "");
	let ext = hasExt
		? rawBase.slice(lastDot + 1).replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 12)
		: defaultExt;

	if (!stem || WIN32_RESERVED_STEM_RE.test(stem)) stem = "attachment";
	if (!ext) ext = defaultExt;
	if (stem.length > 120) stem = stem.slice(0, 120).replace(/[.\s]+$/g, "") || "attachment";
	return `${stem}.${ext}`;
}

function isSafeStoredFilename(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
	if (value === "." || value === "..") return false;
	if (/[\\/\x00-\x1f\x7f]/.test(value)) return false;
	return true;
}

export function parseAttachmentRef(raw: unknown): AttachmentRef {
	if (!isPlainRecord(raw)) throw new Error("AttachmentRef must be an object");
	if (!isAttachmentSha256(raw.id)) throw new Error("AttachmentRef.id must be a 64-char lowercase hex SHA-256");
	if (!isSafeStoredFilename(raw.filename)) throw new Error("AttachmentRef.filename is invalid");
	if (typeof raw.mimeType !== "string") throw new Error("AttachmentRef.mimeType must be a string");
	const mimeType = normalizeAttachmentMimeType(raw.mimeType);
	if (!mimeType || mimeType !== raw.mimeType) throw new Error(`Unsupported AttachmentRef.mimeType: ${raw.mimeType}`);
	const kind = attachmentKindForMime(mimeType)!;
	if (raw.kind !== kind) throw new Error("AttachmentRef.kind does not match mimeType");
	if (typeof raw.sizeBytes !== "number" || !Number.isSafeInteger(raw.sizeBytes) || raw.sizeBytes <= 0 || raw.sizeBytes > attachmentMaxBytesForKind(kind)) {
		throw new Error("AttachmentRef.sizeBytes is out of range");
	}
	const expectedUrl = attachmentUrl(raw.id);
	if (raw.url !== expectedUrl) throw new Error("AttachmentRef.url does not match id");
	return {
		id: raw.id,
		filename: raw.filename,
		mimeType,
		sizeBytes: raw.sizeBytes,
		kind,
		url: expectedUrl,
	};
}

export function parseAttachmentMetaRecord(raw: unknown): AttachmentMetaRecord {
	if (!isPlainRecord(raw)) throw new Error("AttachmentMetaRecord must be an object");
	if (!isAttachmentSha256(raw.id)) throw new Error("AttachmentMetaRecord.id must be a 64-char lowercase hex SHA-256");
	if (!isSafeStoredFilename(raw.filename)) throw new Error("AttachmentMetaRecord.filename is invalid");
	if (typeof raw.mimeType !== "string") throw new Error("AttachmentMetaRecord.mimeType must be a string");
	const mimeType = normalizeAttachmentMimeType(raw.mimeType);
	if (!mimeType || mimeType !== raw.mimeType) throw new Error(`Unsupported AttachmentMetaRecord.mimeType: ${raw.mimeType}`);
	const kind = attachmentKindForMime(mimeType)!;
	if (typeof raw.sizeBytes !== "number" || !Number.isSafeInteger(raw.sizeBytes) || raw.sizeBytes <= 0 || raw.sizeBytes > attachmentMaxBytesForKind(kind)) {
		throw new Error("AttachmentMetaRecord.sizeBytes is out of range");
	}
	if (typeof raw.createdAt !== "string" || !raw.createdAt || Number.isNaN(Date.parse(raw.createdAt))) {
		throw new Error("AttachmentMetaRecord.createdAt must be a valid ISO timestamp");
	}
	return {
		id: raw.id,
		filename: raw.filename,
		mimeType,
		sizeBytes: raw.sizeBytes,
		createdAt: raw.createdAt,
	};
}
