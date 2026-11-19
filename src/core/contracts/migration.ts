/**
 * Safe Profile Migration Contracts (Zone-1 pure, browser-safe, erasable TS).
 *
 * Zero Node built-in imports, zero Buffer usage, zero store/server/agent
 * imports. Used by both server migration tooling and pure UI/contract checks.
 */

import {
	ATTACHMENT_MIME_TYPES,
	attachmentKindForMime,
	attachmentMaxBytesForKind,
	isAttachmentSha256,
	normalizeAttachmentMimeType,
	type AttachmentMimeType,
} from "./attachments.ts";
import type { ChatRecord } from "./chat.ts";
import type { FileAccessSettings } from "../file-access.ts";

export const MIGRATION_BUNDLE_FORMAT_VERSION = 1 as const;

export type MigrationPathKind =
	| "windows_drive"
	| "unc"
	| "posix"
	| "home_relative"
	| "relative"
	| "attachment_url"
	| "unknown";

export type MigrationDiagnosticSeverity = "info" | "warning" | "error";

export type MigrationDiagnosticCode =
	| "missing_attachment_file"
	| "missing_referenced_file"
	| "windows_path"
	| "unc_path"
	| "unmapped_windows_path"
	| "relative_path"
	| "legacy_ledger"
	| "incompatible_file_access_folder"
	| "file_access_all_folders_stripped"
	| "newer_server_record"
	| "skipped_orphan"
	| "corrupt_record"
	| "symlink_skipped"
	| "excluded_secret"
	| "integrity_error";

export interface MigrationDiagnostic {
	code: MigrationDiagnosticCode;
	severity: MigrationDiagnosticSeverity;
	location: string;
	path?: string;
	message: string;
	chatId?: string;
	attachmentId?: string;
}

export interface MigrationAttachmentOriginRef {
	sourceType: "chat" | "job" | "source" | "attachments_dir";
	sourceId: string;
	location: string;
	originalPath?: string;
}

export interface MigrationBundleAttachmentEntry {
	id: string;
	filename: string;
	mimeType: AttachmentMimeType;
	sizeBytes: number;
	createdAt: string;
	bundlePath: string;
	metaBundlePath?: string;
	origins: MigrationAttachmentOriginRef[];
}

export interface MigrationBundleCounts {
	chats: number;
	attachments: number;
	skippedOrphans: number;
	graphNodes: number;
	graphChains: number;
	graphSessions: number;
	graphCoverage: number;
	graphSources: number;
	jobs: number;
	prompts: number;
	themes: number;
}

export interface MigrationBundleManifest {
	formatVersion: typeof MIGRATION_BUNDLE_FORMAT_VERSION;
	exportedAt: string;
	sourceOs: string;
	counts: MigrationBundleCounts;
	settingsUpdatedAt?: string;
	legacyLedgers: string[];
	attachments: MigrationBundleAttachmentEntry[];
	fileChecksums: Record<string, string>;
	diagnostics: MigrationDiagnostic[];
}

export interface MigrationExportReport {
	sourceDir: string;
	bundleDir: string;
	manifest: MigrationBundleManifest;
	diagnostics: MigrationDiagnostic[];
	skippedOrphans: {
		attachmentIds: string[];
		sourceFiles: string[];
		totalCount: number;
	};
	excludedSecrets: string[];
	legacyLedgers: string[];
}

export interface MigrationImportReport {
	mode: "dry-run" | "apply";
	dryRun: boolean;
	bundleDir: string;
	targetDir: string;
	targetPlatform: string;
	bytesWrittenToTarget: number;
	integrity: {
		valid: boolean;
		errors: string[];
	};
	chats: {
		create: string[];
		update: string[];
		skipServerNewer: string[];
		skipUnchanged: string[];
		skipNewerSchema: string[];
	};
	attachments: {
		ingest: string[];
		alreadyPresent: string[];
	};
	graph: {
		nodesAdded: number;
		nodesSkipped: number;
		chainsAdded: number;
		chainsSkipped: number;
		sessionsAdded: number;
		sessionsSkipped: number;
		coverageAdded: number;
		coverageUpdated: number;
		coverageSkipped: number;
		sourcesAdded: number;
		sourcesUpdated: number;
		sourcesPreserved: number;
		sourceOrganizationChanged: boolean;
		positionsChanged: boolean;
		renderSettingsChanged: boolean;
		legacyLedgersDetected: string[];
	};
	settings: {
		action: "create" | "update" | "preserve_server" | "skip_unchanged" | "none";
		strippedWindowsFolders: string[];
		preservedRestricted: boolean | null;
	};
	jobs: {
		create: string[];
		update: string[];
		skipServerNewer: string[];
		skipUnchanged: string[];
	};
	prompts: {
		create: string[];
		skipExisting: string[];
	};
	themes: {
		create: string[];
		skipExisting: string[];
	};
	diagnostics: MigrationDiagnostic[];
}

export type ChatRecordWithModifiedAt = ChatRecord & { modifiedAt?: string };

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isNonNegativeInt = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** True when a file-access folder entry uses Windows drive or UNC syntax. */
export function isWindowsFileAccessFolder(folder: string): boolean {
	const trimmed = folder.trim();
	if (trimmed.length === 0 || trimmed.includes("\0")) return false;
	return /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\");
}

/** Classify a path or attachment URL reference encountered during migration. */
export function classifyMigrationPath(rawPath: string): MigrationPathKind {
	const trimmed = rawPath.trim();
	if (trimmed.length === 0) return "unknown";
	if (trimmed.startsWith("/api/attachments/")) return "attachment_url";
	if (/^[A-Za-z]:[\\/]/.test(trimmed)) return "windows_drive";
	if (/^\\\\[^\\/]+[\\/][^\\/]+/.test(trimmed) || trimmed.startsWith("\\\\")) return "unc";
	if (trimmed === "~" || trimmed.startsWith("~/")) return "home_relative";
	if (trimmed.startsWith("/")) return "posix";
	return "relative";
}

/** Strict validation for bundle-relative POSIX file paths (blocks traversal, backslashes, drives, NUL). */
export function isValidBundleRelativePath(relPath: string): boolean {
	if (typeof relPath !== "string" || relPath.length === 0 || relPath.length > 512) return false;
	if (/[\x00-\x1f\x7f]/.test(relPath)) return false;
	if (relPath.includes("\\") || relPath.startsWith("/") || relPath.endsWith("/")) return false;
	if (/^[A-Za-z]:/.test(relPath)) return false;
	const segments = relPath.split("/");
	for (const segment of segments) {
		if (segment.length === 0 || segment === "." || segment === "..") return false;
	}
	return true;
}

/**
 * On non-win32 platforms, strip Windows drive and UNC folders from fileAccess
 * while preserving the `restricted` flag and all POSIX / `~/` folders.
 */
export function sanitizeFileAccessSettingsForPlatform(
	settings: FileAccessSettings,
	platform = "linux",
): { settings: FileAccessSettings; removedWindowsFolders: string[] } {
	if (platform === "win32") {
		return {
			settings: { restricted: settings.restricted, folders: [...settings.folders] },
			removedWindowsFolders: [],
		};
	}
	const kept: string[] = [];
	const removedWindowsFolders: string[] = [];
	for (const folder of settings.folders) {
		if (isWindowsFileAccessFolder(folder)) {
			removedWindowsFolders.push(folder);
		} else {
			kept.push(folder);
		}
	}
	return {
		settings: {
			restricted: settings.restricted,
			folders: kept,
		},
		removedWindowsFolders,
	};
}

/**
 * Compute the effective latest modification ISO timestamp across a ChatRecord
 * and all nested activity timestamps (`modifiedAt`, `updatedAt`, `createdAt`,
 * `sideChats[*].createdAt`, `sideChats[*].messages[*].at`, `turns[*].at`,
 * `extractions[*].at`). Returns `""` if no valid timestamp is present.
 */
export function effectiveChatModifiedAt(record: ChatRecordWithModifiedAt): string {
	let maxMs = -Infinity;
	const consider = (value: unknown): void => {
		if (typeof value !== "string" || value.length === 0) return;
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed) && parsed > maxMs) {
			maxMs = parsed;
		}
	};

	consider(record.modifiedAt);
	consider(record.updatedAt);
	consider(record.createdAt);

	if (Array.isArray(record.sideChats)) {
		for (const thread of record.sideChats) {
			if (!isPlainRecord(thread)) continue;
			consider(thread.createdAt);
			if (Array.isArray(thread.messages)) {
				for (const msg of thread.messages) {
					if (isPlainRecord(msg)) consider(msg.at);
				}
			}
		}
	}
	if (Array.isArray(record.turns)) {
		for (const turn of record.turns) {
			if (isPlainRecord(turn)) consider(turn.at);
		}
	}
	if (Array.isArray(record.extractions)) {
		for (const ext of record.extractions) {
			if (isPlainRecord(ext)) consider(ext.at);
		}
	}

	return Number.isFinite(maxMs) ? new Date(maxMs).toISOString() : "";
}

/** Deterministic sorted-key JSON serialization for idempotent equality checks. */
export function canonicalJsonString(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => (item === undefined ? "null" : canonicalJsonString(item))).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	const parts: string[] = [];
	for (const key of keys) {
		const v = record[key];
		if (v === undefined) continue;
		parts.push(`${JSON.stringify(key)}:${canonicalJsonString(v)}`);
	}
	return `{${parts.join(",")}}`;
}

function parseDiagnostic(raw: unknown, idx: number): MigrationDiagnostic {
	if (!isPlainRecord(raw)) throw new Error(`manifest.diagnostics[${idx}] must be an object`);
	if (typeof raw.code !== "string" || raw.code.length === 0) {
		throw new Error(`manifest.diagnostics[${idx}].code must be a string`);
	}
	if (raw.severity !== "info" && raw.severity !== "warning" && raw.severity !== "error") {
		throw new Error(`manifest.diagnostics[${idx}].severity is invalid`);
	}
	if (typeof raw.location !== "string" || typeof raw.message !== "string") {
		throw new Error(`manifest.diagnostics[${idx}].location and message must be strings`);
	}
	return {
		code: raw.code as MigrationDiagnosticCode,
		severity: raw.severity,
		location: raw.location,
		message: raw.message,
		...(typeof raw.path === "string" ? { path: raw.path } : {}),
		...(typeof raw.chatId === "string" ? { chatId: raw.chatId } : {}),
		...(typeof raw.attachmentId === "string" ? { attachmentId: raw.attachmentId } : {}),
	};
}

function parseAttachmentOriginRef(raw: unknown, label: string): MigrationAttachmentOriginRef {
	if (!isPlainRecord(raw)) throw new Error(`${label} must be an object`);
	if (raw.sourceType !== "chat" && raw.sourceType !== "job" && raw.sourceType !== "source" && raw.sourceType !== "attachments_dir") {
		throw new Error(`${label}.sourceType is invalid`);
	}
	if (typeof raw.sourceId !== "string" || typeof raw.location !== "string") {
		throw new Error(`${label}.sourceId and location must be strings`);
	}
	return {
		sourceType: raw.sourceType,
		sourceId: raw.sourceId,
		location: raw.location,
		...(typeof raw.originalPath === "string" ? { originalPath: raw.originalPath } : {}),
	};
}

function parseBundleAttachmentEntry(raw: unknown, idx: number): MigrationBundleAttachmentEntry {
	if (!isPlainRecord(raw)) throw new Error(`manifest.attachments[${idx}] must be an object`);
	if (!isAttachmentSha256(raw.id)) {
		throw new Error(`manifest.attachments[${idx}].id must be a 64-char SHA-256`);
	}
	if (
		typeof raw.filename !== "string" ||
		raw.filename.length === 0 ||
		raw.filename.length > 255 ||
		raw.filename === "." ||
		raw.filename === ".." ||
		/[\\/\x00-\x1f\x7f]/.test(raw.filename)
	) {
		throw new Error(`manifest.attachments[${idx}].filename is invalid`);
	}
	if (typeof raw.mimeType !== "string") {
		throw new Error(`manifest.attachments[${idx}].mimeType must be a string`);
	}
	const mimeType = normalizeAttachmentMimeType(raw.mimeType);
	if (!mimeType || !(ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType) || mimeType !== raw.mimeType) {
		throw new Error(`manifest.attachments[${idx}].mimeType is unsupported`);
	}
	const kind = attachmentKindForMime(mimeType)!;
	if (!isNonNegativeInt(raw.sizeBytes) || raw.sizeBytes === 0 || raw.sizeBytes > attachmentMaxBytesForKind(kind)) {
		throw new Error(`manifest.attachments[${idx}].sizeBytes is out of range`);
	}
	if (typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))) {
		throw new Error(`manifest.attachments[${idx}].createdAt must be a valid ISO timestamp`);
	}
	if (typeof raw.bundlePath !== "string" || !isValidBundleRelativePath(raw.bundlePath)) {
		throw new Error(`manifest.attachments[${idx}].bundlePath is invalid`);
	}
	if (raw.metaBundlePath !== undefined && (typeof raw.metaBundlePath !== "string" || !isValidBundleRelativePath(raw.metaBundlePath))) {
		throw new Error(`manifest.attachments[${idx}].metaBundlePath is invalid`);
	}
	if (!Array.isArray(raw.origins)) {
		throw new Error(`manifest.attachments[${idx}].origins must be an array`);
	}
	return {
		id: raw.id,
		filename: raw.filename,
		mimeType,
		sizeBytes: raw.sizeBytes,
		createdAt: raw.createdAt,
		bundlePath: raw.bundlePath,
		...(typeof raw.metaBundlePath === "string" ? { metaBundlePath: raw.metaBundlePath } : {}),
		origins: raw.origins.map((origin, oIdx) => parseAttachmentOriginRef(origin, `manifest.attachments[${idx}].origins[${oIdx}]`)),
	};
}

/** Validate and normalize a parsed migration `manifest.json` payload. */
export function parseMigrationBundleManifest(raw: unknown): MigrationBundleManifest {
	if (!isPlainRecord(raw)) throw new Error("Migration manifest must be a JSON object");
	if (raw.formatVersion !== MIGRATION_BUNDLE_FORMAT_VERSION) {
		throw new Error(`Unsupported migration bundle formatVersion: ${String(raw.formatVersion)}`);
	}
	if (typeof raw.exportedAt !== "string" || Number.isNaN(Date.parse(raw.exportedAt))) {
		throw new Error("manifest.exportedAt must be a valid ISO timestamp");
	}
	if (typeof raw.sourceOs !== "string" || raw.sourceOs.length === 0) {
		throw new Error("manifest.sourceOs must be a non-empty string");
	}
	if (!isPlainRecord(raw.counts)) {
		throw new Error("manifest.counts must be an object");
	}
	const c = raw.counts;
	const countKeys = [
		"chats",
		"attachments",
		"skippedOrphans",
		"graphNodes",
		"graphChains",
		"graphSessions",
		"graphCoverage",
		"graphSources",
		"jobs",
		"prompts",
		"themes",
	] as const;
	const counts = {} as MigrationBundleCounts;
	for (const key of countKeys) {
		if (!isNonNegativeInt(c[key])) {
			throw new Error(`manifest.counts.${key} must be a non-negative integer`);
		}
		counts[key] = c[key];
	}
	if (raw.settingsUpdatedAt !== undefined && (typeof raw.settingsUpdatedAt !== "string" || Number.isNaN(Date.parse(raw.settingsUpdatedAt)))) {
		throw new Error("manifest.settingsUpdatedAt must be a valid ISO timestamp");
	}
	if (!Array.isArray(raw.legacyLedgers) || !raw.legacyLedgers.every((entry) => typeof entry === "string")) {
		throw new Error("manifest.legacyLedgers must be an array of strings");
	}
	if (!Array.isArray(raw.attachments)) {
		throw new Error("manifest.attachments must be an array");
	}
	if (!isPlainRecord(raw.fileChecksums)) {
		throw new Error("manifest.fileChecksums must be an object");
	}
	const fileChecksums: Record<string, string> = {};
	for (const [relPath, sha] of Object.entries(raw.fileChecksums)) {
		if (!isValidBundleRelativePath(relPath)) {
			throw new Error(`Invalid bundle relative path in manifest.fileChecksums: ${relPath}`);
		}
		if (!isAttachmentSha256(sha)) {
			throw new Error(`Invalid SHA-256 checksum for ${relPath}`);
		}
		Object.defineProperty(fileChecksums, relPath, {
			value: sha,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	if (!Array.isArray(raw.diagnostics)) {
		throw new Error("manifest.diagnostics must be an array");
	}

	return {
		formatVersion: MIGRATION_BUNDLE_FORMAT_VERSION,
		exportedAt: raw.exportedAt,
		sourceOs: raw.sourceOs,
		counts,
		...(typeof raw.settingsUpdatedAt === "string" ? { settingsUpdatedAt: raw.settingsUpdatedAt } : {}),
		legacyLedgers: [...raw.legacyLedgers],
		attachments: raw.attachments.map((entry, idx) => parseBundleAttachmentEntry(entry, idx)),
		fileChecksums,
		diagnostics: raw.diagnostics.map((diag, idx) => parseDiagnostic(diag, idx)),
	};
}
