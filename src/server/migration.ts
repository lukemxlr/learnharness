import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	attachmentKindForMime,
	attachmentMaxBytesForKind,
	isAttachmentSha256,
	parseAttachmentMetaRecord,
	sanitizeAttachmentFilename,
	type AttachmentMetaRecord,
	type AttachmentMimeType,
} from "../core/contracts/attachments.ts";
import { CURRENT_CHAT_VERSION, type ChatRecord } from "../core/contracts/chat.ts";
import {
	CURRENT_GRAPH_FORMAT_VERSION,
	type CoverageEntry,
	type GraphChain,
	type GraphNode,
	type NotesSource,
	type Position,
	type ProvenancePoint,
	type SessionCheckpoint,
} from "../core/contracts/graph.ts";
import type { JobRecord } from "../core/contracts/jobs.ts";
import {
	MIGRATION_BUNDLE_FORMAT_VERSION,
	canonicalJsonString,
	classifyMigrationPath,
	effectiveChatModifiedAt,
	isValidBundleRelativePath,
	isWindowsFileAccessFolder,
	parseMigrationBundleManifest,
	sanitizeFileAccessSettingsForPlatform,
	type ChatRecordWithModifiedAt,
	type MigrationAttachmentOriginRef,
	type MigrationBundleAttachmentEntry,
	type MigrationBundleManifest,
	type MigrationDiagnostic,
	type MigrationExportReport,
	type MigrationImportReport,
} from "../core/contracts/migration.ts";
import { parseFilePaths } from "../core/file-paths.ts";
import { isValidSegmentPath } from "../core/prompt-segments.ts";
import { sanitizeRenderSettings } from "../core/render-settings.ts";
import { sanitizeUserSettings, type UserSettings } from "../core/settings.ts";
import { emptySourceOrganization, parseSourceOrganization, type SourceOrganization } from "../core/source-organization.ts";
import { isBuiltinThemeId, isThemeId, sanitizeThemeFile } from "../core/themes.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "../store/atomic-write.ts";
import {
	detectAttachmentMimeType,
	resolveAttachmentFile,
	storeAttachment,
} from "./attachments.ts";

export interface ExportProfileOptions {
	sourceDir: string;
	bundleDir: string;
	sourceFilesRoot?: string;
	sourceOs?: string;
	now?: string;
}

export interface PlanProfileImportOptions {
	bundleDir: string;
	targetDir: string;
	targetPlatform?: string;
}

export interface ImportProfileOptions extends PlanProfileImportOptions {
	dryRun: boolean;
}

const SAFE_RECORD_ID_RE = /^[A-Za-z0-9_-]+$/;
const ATTACHMENT_URL_RE = /\/api\/attachments\/([a-f0-9]{64})\b/g;
const UNQUOTED_WIN_DRIVE_RE = /(?:^|[\s([{"'])([A-Za-z]:[\\/][^\s`"'<>|*?\r\n]+)/g;
const UNQUOTED_UNC_RE = /(?:^|[\s([{"'])(\\\\[^\\/\s]+[\\/][^\\/\s]+(?:[\\/][^\s`"'<>|*?\r\n]+)+)/g;

function sha256Hex(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isSecretName(name: string): boolean {
	const lower = name.toLowerCase();
	if (lower === "auth.json") return true;
	if (lower === "user-auth.json" || lower.startsWith("user-auth.json.")) return true;
	if (lower.endsWith("-credentials.json") || /-credentials\.json\./.test(lower)) return true;
	if (lower === ".env" || lower.startsWith(".env.")) return true;
	return false;
}

function isSecretRelativePath(relPath: string): boolean {
	const parts = relPath.split("/");
	if (parts[0] === "debug") return true;
	return parts.some((part) => isSecretName(part));
}

function setOwnProp<T>(obj: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(obj, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	});
}

function parseTimestampOrNegInf(value: unknown): number {
	if (typeof value !== "string" || value.length === 0) return -Infinity;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? -Infinity : ms;
}

function pushUniqueError(errors: string[], msg: string): void {
	if (!errors.includes(msg)) {
		errors.push(msg);
	}
}

function isSafeSubpath(rootReal: string, candidate: string): boolean {
	if (rootReal.includes("\0") || candidate.includes("\0")) {
		return false;
	}
	const resolved = path.resolve(/* turbopackIgnore: true */ candidate);
	const rel = path.relative(/* turbopackIgnore: true */ rootReal, resolved);
	if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
		return false;
	}
	const parts = rel === "" ? [] : rel.split(path.sep);
	let current = rootReal;
	const rootStat = fs.lstatSync(/* turbopackIgnore: true */ rootReal, { throwIfNoEntry: false });
	if (!rootStat || rootStat.isSymbolicLink()) return false;
	for (let i = 0; i < parts.length; i++) {
		current = path.join(/* turbopackIgnore: true */ current, parts[i]!);
		const stat = fs.lstatSync(/* turbopackIgnore: true */ current, { throwIfNoEntry: false });
		if (!stat) return true; // non-existent tail is safe from symlink traversal
		if (stat.isSymbolicLink()) return false;
		if (i < parts.length - 1 && !stat.isDirectory()) return false;
	}
	try {
		const real = fs.realpathSync(/* turbopackIgnore: true */ resolved);
		const realRel = path.relative(/* turbopackIgnore: true */ rootReal, real);
		return realRel === "" || (!realRel.startsWith("..") && realRel !== ".." && !path.isAbsolute(realRel));
	} catch {
		return true;
	}
}

function validateTargetSubpath(
	realTargetDir: string,
	relSegments: readonly string[],
	expectedLeafType: "dir" | "file",
	errors: string[],
): boolean {
	const label = relSegments.join("/");
	let current = realTargetDir;
	for (let i = 0; i < relSegments.length; i++) {
		const seg = relSegments[i]!;
		if (!seg || seg === "." || seg === ".." || seg.includes("/") || seg.includes("\\") || seg.includes("\0")) {
			pushUniqueError(errors, `Unsafe target relative path: ${label}`);
			return false;
		}
		current = path.join(/* turbopackIgnore: true */ current, seg);
		const stat = fs.lstatSync(/* turbopackIgnore: true */ current, { throwIfNoEntry: false });
		const partialLabel = relSegments.slice(0, i + 1).join("/");
		if (!stat) {
			if (!isSafeSubpath(realTargetDir, path.join(/* turbopackIgnore: true */ realTargetDir, ...relSegments))) {
				pushUniqueError(errors, `Target path escapes target directory: ${label}`);
				return false;
			}
			return true;
		}
		if (stat.isSymbolicLink()) {
			pushUniqueError(errors, `Target path cannot be a symbolic link: ${partialLabel}`);
			return false;
		}
		const expectedHere = i < relSegments.length - 1 ? "dir" : expectedLeafType;
		if (expectedHere === "dir" && !stat.isDirectory()) {
			pushUniqueError(errors, `Target directory path is not a directory: ${partialLabel}`);
			return false;
		}
		if (expectedHere === "file" && !stat.isFile()) {
			pushUniqueError(errors, `Target file path is not a regular file: ${partialLabel}`);
			return false;
		}
	}
	if (!isSafeSubpath(realTargetDir, current)) {
		pushUniqueError(errors, `Target path resolves outside target directory: ${label}`);
		return false;
	}
	return true;
}

function readFileNoSymlink(rootReal: string, filePath: string): { ok: true; bytes: Buffer; stat: fs.Stats } | { ok: false; reason: "missing" | "symlink" | "not_file" } {
	if (!isSafeSubpath(rootReal, filePath)) {
		return { ok: false, reason: "symlink" };
	}
	const stat = fs.lstatSync(/* turbopackIgnore: true */ filePath, { throwIfNoEntry: false });
	if (!stat) return { ok: false, reason: "missing" };
	if (stat.isSymbolicLink()) return { ok: false, reason: "symlink" };
	if (!stat.isFile()) return { ok: false, reason: "not_file" };
	return { ok: true, bytes: fs.readFileSync(/* turbopackIgnore: true */ filePath), stat };
}

function listDirSafe(rootReal: string, dirPath: string): fs.Dirent[] {
	if (!isSafeSubpath(rootReal, dirPath)) return [];
	const stat = fs.lstatSync(/* turbopackIgnore: true */ dirPath, { throwIfNoEntry: false });
	if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return [];
	return fs.readdirSync(/* turbopackIgnore: true */ dirPath, { withFileTypes: true });
}

function parseJsonlLines(text: string): { lines: unknown[]; corruptCount: number } {
	const lines: unknown[] = [];
	let corruptCount = 0;
	for (const rawLine of text.split(/\r?\n/)) {
		const trimmed = rawLine.trim();
		if (!trimmed) continue;
		try {
			lines.push(JSON.parse(trimmed));
		} catch {
			corruptCount++;
		}
	}
	return { lines, corruptCount };
}

const isProvenancePoint = (v: unknown): v is ProvenancePoint =>
	isPlainRecord(v) && isString(v.chatId) && isString(v.messageId);

const isGraphNode = (v: unknown): v is GraphNode =>
	isPlainRecord(v) &&
	isString(v.id) &&
	isString(v.name) &&
	isString(v.statement) &&
	Array.isArray(v.aliases) &&
	v.aliases.every(isString) &&
	isString(v.createdAt) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint);

const isGraphChain = (v: unknown): v is GraphChain =>
	isPlainRecord(v) &&
	isString(v.id) &&
	Array.isArray(v.premises) &&
	v.premises.length > 0 &&
	v.premises.every(isString) &&
	isString(v.conclusion) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint) &&
	isString(v.createdAt);

const isCheckpoint = (v: unknown): v is SessionCheckpoint =>
	isPlainRecord(v) && isString(v.chatId) && isString(v.foldedAt);

const isCoverageEntry = (v: unknown): v is CoverageEntry =>
	isPlainRecord(v) &&
	isString(v.chatId) &&
	isString(v.fp) &&
	typeof v.tokens === "number" &&
	Number.isFinite(v.tokens) &&
	isString(v.foldedAt);

const isNotesSource = (v: unknown): v is NotesSource =>
	isPlainRecord(v) && isString(v.id) && isString(v.filePath) && isString(v.importedAt);

const isPosition = (v: unknown): v is Position =>
	isPlainRecord(v) && typeof v.x === "number" && Number.isFinite(v.x) && typeof v.y === "number" && Number.isFinite(v.y);

function chainKey(premises: readonly string[], conclusion: string): string {
	return `${[...premises].sort().join("+")}>${conclusion}`;
}

function samePoint(a: ProvenancePoint, b: ProvenancePoint): boolean {
	return a.chatId === b.chatId && a.messageId === b.messageId;
}

function extractTextPaths(text: string): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	const add = (p: string): void => {
		const cleaned = p.trim();
		if (cleaned.length > 0 && !seen.has(cleaned)) {
			seen.add(cleaned);
			found.push(cleaned);
		}
	};
	for (const part of parseFilePaths(text)) {
		if (part.kind === "path") add(part.path);
	}
	const stripTrailingPunct = (raw: string): string => raw.replace(/[.,;:!?)]+$/, "");
	for (const re of [UNQUOTED_WIN_DRIVE_RE, UNQUOTED_UNC_RE]) {
		re.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = re.exec(text)) !== null) {
			const candidate = stripTrailingPunct(match[1] ?? "");
			if (candidate) add(candidate);
		}
	}
	return found;
}

interface ScannedReferences {
	attachmentIds: Map<string, MigrationAttachmentOriginRef[]>;
	filePaths: Array<{ path: string; origin: MigrationAttachmentOriginRef }>;
}

function addAttachmentOrigin(
	map: Map<string, MigrationAttachmentOriginRef[]>,
	id: string,
	origin: MigrationAttachmentOriginRef,
): void {
	const existing = map.get(id);
	if (existing) existing.push(origin);
	else map.set(id, [origin]);
}

function walkObjectForAttachmentRefs(
	value: unknown,
	sourceType: "chat" | "job",
	sourceId: string,
	location: string,
	out: Map<string, MigrationAttachmentOriginRef[]>,
	visited = new Set<unknown>(),
): void {
	if (value === null || value === undefined) return;
	if (typeof value === "string") {
		ATTACHMENT_URL_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = ATTACHMENT_URL_RE.exec(value)) !== null) {
			if (match[1]) {
				addAttachmentOrigin(out, match[1], { sourceType, sourceId, location, originalPath: match[0] });
			}
		}
		return;
	}
	if (typeof value !== "object") return;
	if (visited.has(value)) return;
	visited.add(value);
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			walkObjectForAttachmentRefs(value[i], sourceType, sourceId, `${location}[${i}]`, out, visited);
		}
		return;
	}
	const record = value as Record<string, unknown>;
	if (isAttachmentSha256(record.id) && typeof record.url === "string" && record.url === `/api/attachments/${record.id}`) {
		addAttachmentOrigin(out, record.id, {
			sourceType,
			sourceId,
			location,
			originalPath: typeof record.filename === "string" ? record.filename : record.url,
		});
	}
	for (const [k, v] of Object.entries(record)) {
		walkObjectForAttachmentRefs(v, sourceType, sourceId, `${location}.${k}`, out, visited);
	}
}

function scanChatReferences(
	chat: ChatRecord,
	refs: ScannedReferences,
	diagnostics: MigrationDiagnostic[],
): void {
	const chatId = chat.id;
	if (isPlainRecord(chat.imageSnapshots)) {
		for (const [snapshotId, snap] of Object.entries(chat.imageSnapshots)) {
			if (!isAttachmentSha256(snapshotId)) {
				diagnostics.push({
					code: "corrupt_record",
					severity: "warning",
					location: `chats/${chatId}.json:imageSnapshots.${snapshotId}`,
					chatId,
					message: `Invalid imageSnapshot id '${snapshotId}' in chat ${chatId}.`,
				});
				continue;
			}
			if (isPlainRecord(snap) && typeof snap.data === "string") {
				try {
					const buf = Buffer.from(snap.data, "base64");
					const digest = sha256Hex(buf);
					if (digest !== snapshotId) {
						diagnostics.push({
							code: "corrupt_record",
							severity: "warning",
							location: `chats/${chatId}.json:imageSnapshots.${snapshotId}`,
							chatId,
							attachmentId: snapshotId,
							message: `Image snapshot ${snapshotId} SHA-256 mismatch in chat ${chatId}.`,
						});
					}
				} catch {
					diagnostics.push({
						code: "corrupt_record",
						severity: "warning",
						location: `chats/${chatId}.json:imageSnapshots.${snapshotId}`,
						chatId,
						attachmentId: snapshotId,
						message: `Unreadable base64 image snapshot ${snapshotId} in chat ${chatId}.`,
					});
				}
			}
			addAttachmentOrigin(refs.attachmentIds, snapshotId, {
				sourceType: "chat",
				sourceId: chatId,
				location: `chats/${chatId}.json:imageSnapshots.${snapshotId}`,
			});
		}
	}

	const addFileRef = (rawPath: unknown, location: string): void => {
		if (typeof rawPath !== "string" || rawPath.trim().length === 0) return;
		refs.filePaths.push({
			path: rawPath.trim(),
			origin: { sourceType: "chat", sourceId: chatId, location, originalPath: rawPath.trim() },
		});
	};

	if (Array.isArray(chat.messages)) {
		for (let i = 0; i < chat.messages.length; i++) {
			const msg = chat.messages[i] as unknown;
			if (!isPlainRecord(msg)) continue;
			const baseLoc = `chats/${chatId}.json:messages[${i}]`;
			walkObjectForAttachmentRefs(msg, "chat", chatId, baseLoc, refs.attachmentIds);

			if (msg.role === "user") {
				if (typeof msg.content === "string") {
					for (const p of extractTextPaths(msg.content)) addFileRef(p, `${baseLoc}.content`);
				} else if (Array.isArray(msg.content)) {
					for (let j = 0; j < msg.content.length; j++) {
						const part = msg.content[j];
						if (isPlainRecord(part) && part.type === "text" && typeof part.text === "string") {
							for (const p of extractTextPaths(part.text)) addFileRef(p, `${baseLoc}.content[${j}]`);
						}
					}
				}
			} else if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (let j = 0; j < msg.content.length; j++) {
					const part = msg.content[j];
					if (!isPlainRecord(part) || part.type !== "toolCall") continue;
					const args = isPlainRecord(part.arguments) ? part.arguments : null;
					if (!args) continue;
					const name = typeof part.name === "string" ? part.name : "";
					if (name === "show_image" || name === "pdf" || name === "read" || name === "ls" || name === "find" || name === "grep") {
						addFileRef(args.path, `${baseLoc}.toolCall(${name}).path`);
					} else if (name === "visual") {
						addFileRef(args.image, `${baseLoc}.toolCall(visual).image`);
					}
				}
			} else if (msg.role === "toolResult") {
				const details = isPlainRecord(msg.details) ? msg.details : null;
				const toolName = typeof msg.toolName === "string" ? msg.toolName : "";
				if (details) {
					if (toolName === "show_image" || toolName === "pdf") {
						addFileRef(details.path, `${baseLoc}.details.path`);
					}
					if (isAttachmentSha256(details.snapshotId)) {
						addAttachmentOrigin(refs.attachmentIds, details.snapshotId, {
							sourceType: "chat",
							sourceId: chatId,
							location: `${baseLoc}.details.snapshotId`,
							originalPath: typeof details.path === "string" ? details.path : undefined,
						});
					}
					if (isPlainRecord(details.image)) {
						addFileRef(details.image.path, `${baseLoc}.details.image.path`);
						if (isAttachmentSha256(details.image.snapshotId)) {
							addAttachmentOrigin(refs.attachmentIds, details.image.snapshotId, {
								sourceType: "chat",
								sourceId: chatId,
								location: `${baseLoc}.details.image.snapshotId`,
								originalPath: typeof details.image.path === "string" ? details.image.path : undefined,
							});
						}
					}
					for (const field of ["text", "other", "thinking", "note", "readingThinking"]) {
						if (typeof details[field] === "string") {
							for (const p of extractTextPaths(details[field] as string)) {
								addFileRef(p, `${baseLoc}.details.${field}`);
							}
						}
					}
				}
			} else if (msg.role === "custom") {
				const details = isPlainRecord(msg.details) ? msg.details : null;
				if (details) {
					if (msg.customType === "subagent-steer" && isPlainRecord(details.result)) {
						addFileRef(details.result.path, `${baseLoc}.details.result.path`);
						if (isPlainRecord(details.result.image)) {
							addFileRef(details.result.image.path, `${baseLoc}.details.result.image.path`);
							if (isAttachmentSha256(details.result.image.snapshotId)) {
								addAttachmentOrigin(refs.attachmentIds, details.result.image.snapshotId, {
									sourceType: "chat",
									sourceId: chatId,
									location: `${baseLoc}.details.result.image.snapshotId`,
								});
							}
						}
					} else if (msg.customType === "practice-thinking" && typeof details.text === "string") {
						for (const p of extractTextPaths(details.text)) {
							addFileRef(p, `${baseLoc}.details.text`);
						}
					} else if (msg.customType === "plugin-problem-submission") {
						if (typeof details.submission === "string") {
							for (const p of extractTextPaths(details.submission)) {
								addFileRef(p, `${baseLoc}.details.submission`);
							}
						}
						if (isPlainRecord(details.thinking) && typeof details.thinking.text === "string") {
							for (const p of extractTextPaths(details.thinking.text)) {
								addFileRef(p, `${baseLoc}.details.thinking.text`);
							}
						}
					}
				}
			}
		}
	}
}

function scanJobReferences(job: JobRecord, refs: ScannedReferences): void {
	const loc = `jobs/${job.id}.json`;
	walkObjectForAttachmentRefs(job, "job", job.id, loc, refs.attachmentIds);
	if (isPlainRecord(job.input)) {
		if (typeof job.input.path === "string") {
			refs.filePaths.push({
				path: job.input.path,
				origin: { sourceType: "job", sourceId: job.id, location: `${loc}:input.path`, originalPath: job.input.path },
			});
		}
		if (typeof job.input.image === "string") {
			refs.filePaths.push({
				path: job.input.image,
				origin: { sourceType: "job", sourceId: job.id, location: `${loc}:input.image`, originalPath: job.input.image },
			});
		}
	}
	if (isPlainRecord(job.result)) {
		if (typeof job.result.path === "string") {
			refs.filePaths.push({
				path: job.result.path,
				origin: { sourceType: "job", sourceId: job.id, location: `${loc}:result.path`, originalPath: job.result.path },
			});
		}
		if (isPlainRecord(job.result.image)) {
			if (typeof job.result.image.path === "string") {
				refs.filePaths.push({
					path: job.result.image.path,
					origin: { sourceType: "job", sourceId: job.id, location: `${loc}:result.image.path`, originalPath: job.result.image.path },
				});
			}
			if (isAttachmentSha256(job.result.image.snapshotId)) {
				addAttachmentOrigin(refs.attachmentIds, job.result.image.snapshotId, {
					sourceType: "job",
					sourceId: job.id,
					location: `${loc}:result.image.snapshotId`,
				});
			}
		}
	}
}

function resolveLocalReferencedFile(
	rawPath: string,
	roots: Array<{ dirReal: string }>,
): { resolvedPath: string; rootReal: string } | null {
	if (rawPath.includes("\0")) return null;
	const kind = classifyMigrationPath(rawPath);
	if (kind === "relative") {
		const normalized = rawPath.replace(/\\/g, "/");
		const segments = normalized.split("/").filter((s) => s.length > 0);
		if (segments.some((s) => s === "." || s === "..")) return null;
		for (const root of roots) {
			const candidate = path.join(/* turbopackIgnore: true */ root.dirReal, ...segments);
			if (!isSafeSubpath(root.dirReal, candidate)) continue;
			const stat = fs.lstatSync(/* turbopackIgnore: true */ candidate, { throwIfNoEntry: false });
			if (stat && !stat.isSymbolicLink() && stat.isFile()) {
				return { resolvedPath: candidate, rootReal: root.dirReal };
			}
		}
		return null;
	}
	if (kind === "posix") {
		for (const root of roots) {
			if (!isSafeSubpath(root.dirReal, rawPath)) continue;
			const stat = fs.lstatSync(/* turbopackIgnore: true */ rawPath, { throwIfNoEntry: false });
			if (stat && !stat.isSymbolicLink() && stat.isFile()) {
				return { resolvedPath: rawPath, rootReal: root.dirReal };
			}
		}
		return null;
	}
	if (kind === "windows_drive" || kind === "unc") {
		let tail = rawPath.trim();
		if (kind === "windows_drive") {
			tail = tail.replace(/^[A-Za-z]:[\\/]+/, "");
		} else {
			tail = tail.replace(/^\\\\[^\\/]+[\\/]+[^\\/]+[\\/]?/, "");
		}
		const segments = tail.split(/[\\/]+/).filter((s) => s.length > 0);
		if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) return null;
		for (const root of roots) {
			for (let start = 0; start < segments.length; start++) {
				const candidate = path.join(/* turbopackIgnore: true */ root.dirReal, ...segments.slice(start));
				if (!isSafeSubpath(root.dirReal, candidate)) continue;
				const stat = fs.lstatSync(/* turbopackIgnore: true */ candidate, { throwIfNoEntry: false });
				if (stat && !stat.isSymbolicLink() && stat.isFile()) {
					return { resolvedPath: candidate, rootReal: root.dirReal };
				}
			}
		}
		return null;
	}
	return null;
}

function collectAllFilesRelative(rootReal: string, currentDir: string, relPrefix: string, out: string[]): void {
	for (const entry of listDirSafe(rootReal, currentDir)) {
		const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
		const full = path.join(/* turbopackIgnore: true */ currentDir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			collectAllFilesRelative(rootReal, full, rel, out);
		} else if (entry.isFile()) {
			out.push(rel);
		}
	}
}

/**
 * Strictly read-only exporter: reads `sourceDir`, bundles chats, graph,
 * settings, prompts, themes, jobs, and ONLY reachable verified attachments.
 * Never mutates `sourceDir` (and never imports `src/store/graph.ts`).
 */
export function exportProfile(options: ExportProfileOptions): MigrationExportReport {
	const { sourceDir, bundleDir, sourceFilesRoot, sourceOs = process.platform, now = new Date().toISOString() } = options;
	const resolvedSource = path.resolve(/* turbopackIgnore: true */ sourceDir);
	const resolvedBundle = path.resolve(/* turbopackIgnore: true */ bundleDir);

	const sourceStat = fs.lstatSync(/* turbopackIgnore: true */ resolvedSource, { throwIfNoEntry: false });
	if (!sourceStat || sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
		throw new Error(`Source profile directory is invalid or missing: ${sourceDir}`);
	}
	const realSourceDir = fs.realpathSync(/* turbopackIgnore: true */ resolvedSource);

	const bundleRelToSource = path.relative(/* turbopackIgnore: true */ realSourceDir, resolvedBundle);
	if (bundleRelToSource === "" || (!bundleRelToSource.startsWith("..") && !path.isAbsolute(bundleRelToSource))) {
		throw new Error("Bundle directory cannot be inside the source profile directory");
	}
	const bundleStat = fs.lstatSync(/* turbopackIgnore: true */ resolvedBundle, { throwIfNoEntry: false });
	if (bundleStat?.isSymbolicLink()) {
		throw new Error("Bundle directory cannot be a symbolic link");
	}

	const fileResolutionRoots: Array<{ dirReal: string; kind: "files_root" | "source_dir" }> = [];
	let explicitFilesRootReal: string | null = null;
	if (sourceFilesRoot) {
		const rfStat = fs.lstatSync(/* turbopackIgnore: true */ path.resolve(/* turbopackIgnore: true */ sourceFilesRoot), { throwIfNoEntry: false });
		if (!rfStat || rfStat.isSymbolicLink() || !rfStat.isDirectory()) {
			throw new Error(`sourceFilesRoot is invalid or missing: ${sourceFilesRoot}`);
		}
		explicitFilesRootReal = fs.realpathSync(/* turbopackIgnore: true */ path.resolve(/* turbopackIgnore: true */ sourceFilesRoot));
		fileResolutionRoots.push({ dirReal: explicitFilesRootReal, kind: "files_root" });
	}
	const defaultSourceFiles = path.join(/* turbopackIgnore: true */ realSourceDir, "source-files");
	const defaultSourceFilesStat = fs.lstatSync(/* turbopackIgnore: true */ defaultSourceFiles, { throwIfNoEntry: false });
	let fallbackSourceFilesReal: string | null = null;
	if (defaultSourceFilesStat && !defaultSourceFilesStat.isSymbolicLink() && defaultSourceFilesStat.isDirectory()) {
		fallbackSourceFilesReal = fs.realpathSync(/* turbopackIgnore: true */ defaultSourceFiles);
		if (fallbackSourceFilesReal !== explicitFilesRootReal) {
			fileResolutionRoots.push({ dirReal: fallbackSourceFilesReal, kind: "files_root" });
		}
	}
	fileResolutionRoots.push({ dirReal: realSourceDir, kind: "source_dir" });

	const diagnostics: MigrationDiagnostic[] = [];
	const excludedSecrets: string[] = [];
	const bundleFiles = new Map<string, Buffer>();

	// Detect top-level secrets / debug dir without reading them
	for (const entry of listDirSafe(realSourceDir, realSourceDir)) {
		if (entry.name === "debug" || isSecretName(entry.name)) {
			excludedSecrets.push(entry.name);
			diagnostics.push({
				code: "excluded_secret",
				severity: "info",
				location: entry.name,
				path: entry.name,
				message: `Excluded secret/debug entry '${entry.name}' from export bundle.`,
			});
		}
	}

	// 1. Settings
	let settingsUpdatedAt: string | undefined;
	const settingsRead = readFileNoSymlink(realSourceDir, path.join(/* turbopackIgnore: true */ realSourceDir, "settings.json"));
	if (settingsRead.ok) {
		try {
			const parsed = JSON.parse(settingsRead.bytes.toString("utf8"));
			const sanitized = sanitizeUserSettings(parsed);
			if (!sanitized) {
				diagnostics.push({
					code: "corrupt_record",
					severity: "warning",
					location: "settings.json",
					message: "Source settings.json is not a JSON object and was skipped.",
				});
			} else {
				settingsUpdatedAt = settingsRead.stat.mtime.toISOString();
				const rawFa = isPlainRecord(parsed) && isPlainRecord(parsed.agent) ? parsed.agent.fileAccess : undefined;
				if (isPlainRecord(rawFa) && Array.isArray(rawFa.folders)) {
					for (const folder of rawFa.folders) {
						if (typeof folder === "string" && isWindowsFileAccessFolder(folder)) {
							diagnostics.push({
								code: "windows_path",
								severity: "warning",
								location: "settings.json:agent.fileAccess.folders",
								path: folder,
								message: `Legacy Windows file-access folder '${folder}' will be sanitized on Linux import.`,
							});
						}
					}
				}
				bundleFiles.set("settings.json", Buffer.from(`${JSON.stringify(sanitized, null, "\t")}\n`, "utf8"));
			}
		} catch {
			diagnostics.push({
				code: "corrupt_record",
				severity: "warning",
				location: "settings.json",
				message: "Source settings.json contains invalid JSON and was skipped.",
			});
		}
	} else if (settingsRead.reason === "symlink") {
		diagnostics.push({
			code: "symlink_skipped",
			severity: "warning",
			location: "settings.json",
			path: "settings.json",
			message: "Skipped symlinked settings.json.",
		});
	}

	const refs: ScannedReferences = {
		attachmentIds: new Map(),
		filePaths: [],
	};

	// 2. Chats
	let chatsCount = 0;
	const chatRecords: ChatRecord[] = [];
	const chatsDir = path.join(/* turbopackIgnore: true */ realSourceDir, "chats");
	for (const entry of listDirSafe(realSourceDir, chatsDir).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.name.endsWith(".json")) continue;
		const id = entry.name.slice(0, -5);
		if (!SAFE_RECORD_ID_RE.test(id)) continue;
		const full = path.join(/* turbopackIgnore: true */ chatsDir, entry.name);
		const read = readFileNoSymlink(realSourceDir, full);
		if (!read.ok) {
			if (read.reason === "symlink") {
				diagnostics.push({
					code: "symlink_skipped",
					severity: "warning",
					location: `chats/${entry.name}`,
					path: `chats/${entry.name}`,
					chatId: id,
					message: `Skipped symlinked chat file chats/${entry.name}.`,
				});
			}
			continue;
		}
		try {
			const parsed = JSON.parse(read.bytes.toString("utf8")) as unknown;
			if (!isPlainRecord(parsed) || typeof parsed.id !== "string" || parsed.id !== id) {
				diagnostics.push({
					code: "corrupt_record",
					severity: "warning",
					location: `chats/${entry.name}`,
					chatId: id,
					message: `Skipped malformed chat record chats/${entry.name}.`,
				});
				continue;
			}
			if (typeof parsed.version === "number" && parsed.version > CURRENT_CHAT_VERSION) {
				diagnostics.push({
					code: "corrupt_record",
					severity: "warning",
					location: `chats/${entry.name}`,
					chatId: id,
					message: `Skipped chat ${id} with unsupported newer schema version ${parsed.version}.`,
				});
				continue;
			}
			const chat = parsed as unknown as ChatRecord;
			chatRecords.push(chat);
			scanChatReferences(chat, refs, diagnostics);
			bundleFiles.set(`chats/${entry.name}`, read.bytes);
			chatsCount++;
		} catch {
			diagnostics.push({
				code: "corrupt_record",
				severity: "warning",
				location: `chats/${entry.name}`,
				chatId: id,
				message: `Skipped invalid JSON in chats/${entry.name}.`,
			});
		}
	}

	// 3. Jobs
	let jobsCount = 0;
	const jobsDir = path.join(/* turbopackIgnore: true */ realSourceDir, "jobs");
	for (const entry of listDirSafe(realSourceDir, jobsDir).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.name.endsWith(".json")) continue;
		const id = entry.name.slice(0, -5);
		if (!SAFE_RECORD_ID_RE.test(id)) continue;
		const read = readFileNoSymlink(realSourceDir, path.join(/* turbopackIgnore: true */ jobsDir, entry.name));
		if (!read.ok) {
			if (read.reason === "symlink") {
				diagnostics.push({
					code: "symlink_skipped",
					severity: "warning",
					location: `jobs/${entry.name}`,
					path: `jobs/${entry.name}`,
					message: `Skipped symlinked job file jobs/${entry.name}.`,
				});
			}
			continue;
		}
		try {
			const parsed = JSON.parse(read.bytes.toString("utf8")) as unknown;
			if (!isPlainRecord(parsed) || typeof parsed.id !== "string") continue;
			const job = parsed as unknown as JobRecord;
			scanJobReferences(job, refs);
			bundleFiles.set(`jobs/${entry.name}`, read.bytes);
			jobsCount++;
		} catch {
			diagnostics.push({
				code: "corrupt_record",
				severity: "warning",
				location: `jobs/${entry.name}`,
				message: `Skipped invalid JSON in jobs/${entry.name}.`,
			});
		}
	}

	// 4. Graph (read-only — never imports src/store/graph.ts!)
	const graphDir = path.join(/* turbopackIgnore: true */ realSourceDir, "graph");
	let graphNodesCount = 0;
	let graphChainsCount = 0;
	let graphSessionsCount = 0;
	let graphCoverageCount = 0;
	let graphSourcesCount = 0;
	const legacyLedgers: string[] = [];

	const formatRead = readFileNoSymlink(realSourceDir, path.join(/* turbopackIgnore: true */ graphDir, "format.json"));
	if (formatRead.ok) {
		try {
			const parsed = JSON.parse(formatRead.bytes.toString("utf8")) as { version?: unknown };
			if (typeof parsed.version === "number" && parsed.version > CURRENT_GRAPH_FORMAT_VERSION) {
				throw new Error(`Source graph format version ${parsed.version} > supported ${CURRENT_GRAPH_FORMAT_VERSION}`);
			}
			bundleFiles.set("graph/format.json", formatRead.bytes);
		} catch (err) {
			if (err instanceof Error && err.message.includes("format version")) throw err;
		}
	}

	const nodesRead = readFileNoSymlink(realSourceDir, path.join(/* turbopackIgnore: true */ graphDir, "nodes.jsonl"));
	if (nodesRead.ok) {
		const { lines, corruptCount } = parseJsonlLines(nodesRead.bytes.toString("utf8"));
		if (corruptCount > 0) {
			diagnostics.push({
				code: "corrupt_record",
				severity: "warning",
				location: "graph/nodes.jsonl",
				message: `Skipped ${corruptCount} malformed JSONL line(s) in graph/nodes.jsonl.`,
			});
		}
		const valid = lines.filter(isGraphNode);
		graphNodesCount = valid.length;
		bundleFiles.set("graph/nodes.jsonl", Buffer.from(valid.map((r) => JSON.stringify(r)).join("\n") + (valid.length ? "\n" : ""), "utf8"));
	}

	const chainsRead = readFileNoSymlink(realSourceDir, path.join(/* turbopackIgnore: true */ graphDir, "chains.jsonl"));
	if (chainsRead.ok) {
		const { lines, corruptCount } = parseJsonlLines(chainsRead.bytes.toString("utf8"));
		if (corruptCount > 0) {
			diagnostics.push({
				code: "corrupt_record",
				severity: "warning",
				location: "graph/chains.jsonl",
				message: `Skipped ${corruptCount} malformed JSONL line(s) in graph/chains.jsonl.`,
			});
		}
		const valid = lines.filter(isGraphChain);
		graphChainsCount = valid.length;
		bundleFiles.set("graph/chains.jsonl", Buffer.from(valid.map((r) => JSON.stringify(r)).join("\n") + (valid.length ? "\n" : ""), "utf8"));
	}

	const sessionsRead = readFileNoSymlink(realSourceDir, path.join(/* turbopackIgnore: true */ graphDir, "sessions.jsonl"));
	if (sessionsRead.ok) {
		const { lines } = parseJsonlLines(sessionsRead.bytes.toString("utf8"));
		const valid = lines.filter(isCheckpoint);
		graphSessionsCount = valid.length;
		bundleFiles.set("graph/sessions.jsonl", Buffer.from(valid.map((r) => JSON.stringify(r)).join("\n") + (valid.length ? "\n" : ""), "utf8"));
	}

	const coverageRead = readFileNoSymlink(realSourceDir, path.join(/* turbopackIgnore: true */ graphDir, "coverage.jsonl"));
	if (coverageRead.ok) {
		const { lines } = parseJsonlLines(coverageRead.bytes.toString("utf8"));
		const valid = lines.filter(isCoverageEntry);
		graphCoverageCount = valid.length;
		bundleFiles.set("graph/coverage.jsonl", Buffer.from(valid.map((r) => JSON.stringify(r)).join("\n") + (valid.length ? "\n" : ""), "utf8"));
	}

	for (const legacy of ["edges.jsonl", "events.jsonl"]) {
		const legacyRead = readFileNoSymlink(realSourceDir, path.join(/* turbopackIgnore: true */ graphDir, legacy));
		if (legacyRead.ok) {
			legacyLedgers.push(legacy);
			diagnostics.push({
				code: "legacy_ledger",
				severity: "warning",
				location: `graph/${legacy}`,
				path: `graph/${legacy}`,
				message: `Detected legacy graph ledger graph/${legacy} (source left untouched; modern graph uses chains.jsonl & nodes.jsonl).`,
			});
			const { lines } = parseJsonlLines(legacyRead.bytes.toString("utf8"));
			const seen = new Set<string>();
			const deduped: unknown[] = [];
			for (const line of lines) {
				const key = canonicalJsonString(line);
				if (!seen.has(key)) {
					seen.add(key);
					deduped.push(line);
				}
			}
			bundleFiles.set(`graph/${legacy}`, Buffer.from(deduped.map((r) => JSON.stringify(r)).join("\n") + (deduped.length ? "\n" : ""), "utf8"));
		}
	}

	const sourcesRead = readFileNoSymlink(realSourceDir, path.join(/* turbopackIgnore: true */ graphDir, "sources.json"));
	if (sourcesRead.ok) {
		try {
			const parsed = JSON.parse(sourcesRead.bytes.toString("utf8")) as unknown;
			if (isPlainRecord(parsed)) {
				const validSources: Record<string, NotesSource> = {};
				for (const [id, src] of Object.entries(parsed)) {
					if (!isNotesSource(src)) continue;
					setOwnProp(validSources, id, src);
					graphSourcesCount++;
					const pKind = classifyMigrationPath(src.filePath);
					if (pKind === "windows_drive" || pKind === "unc") {
						diagnostics.push({
							code: pKind === "unc" ? "unc_path" : "windows_path",
							severity: "warning",
							location: `graph/sources.json:${id}`,
							path: src.filePath,
							message: `Notes source '${id}' references legacy Windows path '${src.filePath}'.`,
						});
					}
					refs.filePaths.push({
						path: src.filePath,
						origin: { sourceType: "source", sourceId: id, location: `graph/sources.json:${id}`, originalPath: src.filePath },
					});
				}
				bundleFiles.set("graph/sources.json", Buffer.from(`${JSON.stringify(validSources, null, "\t")}\n`, "utf8"));
			}
		} catch {
			diagnostics.push({
				code: "corrupt_record",
				severity: "warning",
				location: "graph/sources.json",
				message: "Skipped invalid JSON in graph/sources.json.",
			});
		}
	}

	const orgRead = readFileNoSymlink(realSourceDir, path.join(/* turbopackIgnore: true */ graphDir, "source-organization.json"));
	if (orgRead.ok) {
		try {
			const parsedOrg = parseSourceOrganization(JSON.parse(orgRead.bytes.toString("utf8")));
			for (const folder of parsedOrg.folders) {
				if (folder.importPath) {
					const pKind = classifyMigrationPath(folder.importPath);
					if (pKind === "windows_drive" || pKind === "unc") {
						diagnostics.push({
							code: pKind === "unc" ? "unc_path" : "windows_path",
							severity: "warning",
							location: `graph/source-organization.json:folders.${folder.id}`,
							path: folder.importPath,
							message: `Source folder '${folder.name}' retains legacy Windows importPath '${folder.importPath}'.`,
						});
					}
				}
			}
			bundleFiles.set("graph/source-organization.json", Buffer.from(`${JSON.stringify(parsedOrg, null, "\t")}\n`, "utf8"));
		} catch {
			diagnostics.push({
				code: "corrupt_record",
				severity: "warning",
				location: "graph/source-organization.json",
				message: "Skipped malformed graph/source-organization.json.",
			});
		}
	}

	const positionsRead = readFileNoSymlink(realSourceDir, path.join(/* turbopackIgnore: true */ graphDir, "positions.json"));
	if (positionsRead.ok) {
		try {
			const parsed = JSON.parse(positionsRead.bytes.toString("utf8")) as unknown;
			if (isPlainRecord(parsed) && isPlainRecord(parsed.positions)) {
				const cleanPositions: Record<string, Position> = {};
				for (const [k, v] of Object.entries(parsed.positions)) {
					if (isPosition(v)) setOwnProp(cleanPositions, k, { x: v.x, y: v.y });
				}
				const updatedAt = typeof parsed.updatedAt === "string" && !Number.isNaN(Date.parse(parsed.updatedAt))
					? parsed.updatedAt
					: positionsRead.stat.mtime.toISOString();
				bundleFiles.set("graph/positions.json", Buffer.from(`${JSON.stringify({ positions: cleanPositions, updatedAt }, null, "\t")}\n`, "utf8"));
			}
		} catch {
			diagnostics.push({
				code: "corrupt_record",
				severity: "warning",
				location: "graph/positions.json",
				message: "Skipped invalid JSON in graph/positions.json.",
			});
		}
	}

	const renderRead = readFileNoSymlink(realSourceDir, path.join(/* turbopackIgnore: true */ graphDir, "render-settings.json"));
	if (renderRead.ok) {
		try {
			const sanitized = sanitizeRenderSettings(JSON.parse(renderRead.bytes.toString("utf8")));
			bundleFiles.set("graph/render-settings.json", Buffer.from(`${JSON.stringify(sanitized, null, "\t")}\n`, "utf8"));
		} catch {
			diagnostics.push({
				code: "corrupt_record",
				severity: "warning",
				location: "graph/render-settings.json",
				message: "Skipped invalid JSON in graph/render-settings.json.",
			});
		}
	}

	// 5. Prompts
	let promptsCount = 0;
	const promptsDir = path.join(/* turbopackIgnore: true */ realSourceDir, "prompts");
	const walkPrompts = (dir: string, prefix: string): void => {
		for (const entry of listDirSafe(realSourceDir, dir).sort((a, b) => a.name.localeCompare(b.name))) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			const full = path.join(/* turbopackIgnore: true */ dir, entry.name);
			if (entry.isSymbolicLink()) {
				diagnostics.push({
					code: "symlink_skipped",
					severity: "warning",
					location: `prompts/${rel}`,
					path: `prompts/${rel}`,
					message: `Skipped symlinked prompt override prompts/${rel}.`,
				});
				continue;
			}
			if (entry.isDirectory()) {
				walkPrompts(full, rel);
			} else if (entry.isFile() && entry.name.endsWith(".md") && isValidSegmentPath(rel)) {
				const read = readFileNoSymlink(realSourceDir, full);
				if (read.ok) {
					bundleFiles.set(`prompts/${rel}`, read.bytes);
					promptsCount++;
				}
			}
		}
	};
	walkPrompts(promptsDir, "");

	// 6. Themes
	let themesCount = 0;
	const themesDir = path.join(/* turbopackIgnore: true */ realSourceDir, "themes");
	for (const entry of listDirSafe(realSourceDir, themesDir).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.name.endsWith(".json")) continue;
		const id = entry.name.slice(0, -5);
		if (!isThemeId(id) || isBuiltinThemeId(id)) continue;
		const read = readFileNoSymlink(realSourceDir, path.join(/* turbopackIgnore: true */ themesDir, entry.name));
		if (!read.ok) {
			if (read.reason === "symlink") {
				diagnostics.push({
					code: "symlink_skipped",
					severity: "warning",
					location: `themes/${entry.name}`,
					path: `themes/${entry.name}`,
					message: `Skipped symlinked theme themes/${entry.name}.`,
				});
			}
			continue;
		}
		try {
			const sanitized = sanitizeThemeFile(JSON.parse(read.bytes.toString("utf8")));
			if (sanitized) {
				bundleFiles.set(`themes/${entry.name}`, Buffer.from(`${JSON.stringify(sanitized, null, "\t")}\n`, "utf8"));
				themesCount++;
			}
		} catch {
			diagnostics.push({
				code: "corrupt_record",
				severity: "warning",
				location: `themes/${entry.name}`,
				message: `Skipped invalid JSON in themes/${entry.name}.`,
			});
		}
	}

	// 7. Reachability-filtered attachments & referenced local files
	const bundledAttachments = new Map<string, MigrationBundleAttachmentEntry>();
	const chatSnapshotIds = new Set<string>();
	for (const chat of chatRecords) {
		if (isPlainRecord(chat.imageSnapshots)) {
			for (const k of Object.keys(chat.imageSnapshots)) {
				if (isAttachmentSha256(k)) chatSnapshotIds.add(k);
			}
		}
	}

	for (const [id, origins] of refs.attachmentIds.entries()) {
		const resolved = resolveAttachmentFile(id, realSourceDir);
		if (!resolved) {
			// Inline imageSnapshots live inside chats/<id>.json unless also referenced via /api/attachments/<id>
			const hasExternalAttachmentRef = origins.some((o) =>
				o.originalPath?.startsWith("/api/attachments/") || !o.location.includes(":imageSnapshots."),
			);
			if (hasExternalAttachmentRef && !chatSnapshotIds.has(id)) {
				diagnostics.push({
					code: "missing_attachment_file",
					severity: "warning",
					location: origins[0]?.location ?? `attachments/${id}`,
					attachmentId: id,
					message: `Referenced attachment ${id} was not found in source attachments store.`,
				});
			}
			continue;
		}
		const bytes = fs.readFileSync(/* turbopackIgnore: true */ resolved.filePath);
		const actualSha = sha256Hex(bytes);
		const sniffed = detectAttachmentMimeType(bytes);
		const kind = sniffed ? attachmentKindForMime(sniffed) : null;
		if (actualSha !== id || !sniffed || sniffed !== resolved.meta.mimeType || !kind || bytes.byteLength > attachmentMaxBytesForKind(kind)) {
			diagnostics.push({
				code: "corrupt_record",
				severity: "warning",
				location: `attachments/${id}/${resolved.meta.filename}`,
				attachmentId: id,
				message: `Skipped invalid or corrupted attachment ${id}.`,
			});
			continue;
		}
		const bundlePath = `attachments/${id}/${resolved.meta.filename}`;
		const metaBundlePath = `attachments/${id}.meta.json`;
		bundleFiles.set(bundlePath, bytes);
		bundleFiles.set(metaBundlePath, Buffer.from(`${JSON.stringify(resolved.meta, null, "\t")}\n`, "utf8"));
		bundledAttachments.set(id, {
			id,
			filename: resolved.meta.filename,
			mimeType: resolved.meta.mimeType,
			sizeBytes: resolved.meta.sizeBytes,
			createdAt: resolved.meta.createdAt,
			bundlePath,
			metaBundlePath,
			origins,
		});
	}

	const matchedFilesReal = new Set<string>();
	const seenMissingPaths = new Set<string>();
	const seenRejectedFiles = new Set<string>();
	for (const ref of refs.filePaths) {
		const pKind = classifyMigrationPath(ref.path);
		if (pKind === "windows_drive" || pKind === "unc") {
			if (ref.origin.sourceType !== "source") {
				diagnostics.push({
					code: pKind === "unc" ? "unc_path" : "windows_path",
					severity: "warning",
					location: ref.origin.location,
					path: ref.path,
					...(ref.origin.sourceType === "chat" ? { chatId: ref.origin.sourceId } : {}),
					message: `Legacy ${pKind === "unc" ? "UNC" : "Windows"} path referenced at ${ref.origin.location}: ${ref.path}`,
				});
			}
		}

		if (ref.path.includes("\0")) {
			const rejectKey = `${ref.origin.location}::${ref.path}`;
			if (!seenRejectedFiles.has(rejectKey)) {
				seenRejectedFiles.add(rejectKey);
				diagnostics.push({
					code: "corrupt_record",
					severity: "warning",
					location: ref.origin.location,
					path: ref.path,
					...(ref.origin.sourceType === "chat" ? { chatId: ref.origin.sourceId } : {}),
					message: `Referenced path at ${ref.origin.location} contains a NUL byte and was skipped.`,
				});
			}
			continue;
		}

		const resolved = resolveLocalReferencedFile(ref.path, fileResolutionRoots);
		if (resolved) {
			matchedFilesReal.add(fs.realpathSync(/* turbopackIgnore: true */ resolved.resolvedPath));
			const bytes = fs.readFileSync(/* turbopackIgnore: true */ resolved.resolvedPath);
			const sniffed = detectAttachmentMimeType(bytes);
			if (!sniffed) {
				if (ref.origin.sourceType !== "source" || /\.(?:png|jpe?g|webp|gif|pdf)$/i.test(resolved.resolvedPath)) {
					const rejectKey = `${ref.origin.location}::${ref.path}`;
					if (!seenRejectedFiles.has(rejectKey)) {
						seenRejectedFiles.add(rejectKey);
						diagnostics.push({
							code: "corrupt_record",
							severity: "warning",
							location: ref.origin.location,
							path: ref.path,
							...(ref.origin.sourceType === "chat" ? { chatId: ref.origin.sourceId } : {}),
							message: `Referenced local file '${ref.path}' was not bundled: unsupported or rejected format (failed MIME sniffing).`,
						});
					}
				}
			} else {
				const kind = attachmentKindForMime(sniffed)!;
				const maxBytes = attachmentMaxBytesForKind(kind);
				if (bytes.byteLength > 0 && bytes.byteLength <= maxBytes) {
					const id = sha256Hex(bytes);
					const existing = bundledAttachments.get(id);
					if (existing) {
						existing.origins.push(ref.origin);
					} else {
						const safeName = sanitizeAttachmentFilename(path.basename(resolved.resolvedPath), sniffed);
						const meta: AttachmentMetaRecord = {
							id,
							filename: safeName,
							mimeType: sniffed,
							sizeBytes: bytes.byteLength,
							createdAt: fs.statSync(/* turbopackIgnore: true */ resolved.resolvedPath).mtime.toISOString(),
						};
						const bundlePath = `attachments/${id}/${safeName}`;
						const metaBundlePath = `attachments/${id}.meta.json`;
						bundleFiles.set(bundlePath, bytes);
						bundleFiles.set(metaBundlePath, Buffer.from(`${JSON.stringify(meta, null, "\t")}\n`, "utf8"));
						bundledAttachments.set(id, {
							id,
							filename: safeName,
							mimeType: sniffed,
							sizeBytes: bytes.byteLength,
							createdAt: meta.createdAt,
							bundlePath,
							metaBundlePath,
							origins: [ref.origin],
						});
					}
				} else {
					const rejectKey = `${ref.origin.location}::${ref.path}`;
					if (!seenRejectedFiles.has(rejectKey)) {
						seenRejectedFiles.add(rejectKey);
						diagnostics.push({
							code: "corrupt_record",
							severity: "warning",
							location: ref.origin.location,
							path: ref.path,
							...(ref.origin.sourceType === "chat" ? { chatId: ref.origin.sourceId } : {}),
							message: `Referenced local file '${ref.path}' (${bytes.byteLength} bytes) was not bundled: empty or exceeds ${Math.round(maxBytes / (1024 * 1024))} MiB limit.`,
						});
					}
				}
			}
		} else if (ref.origin.sourceType !== "source") {
			const missingKey = `${ref.origin.location}::${ref.path}`;
			if (!seenMissingPaths.has(missingKey)) {
				seenMissingPaths.add(missingKey);
				if (pKind === "windows_drive" || pKind === "unc") {
					diagnostics.push({
						code: "unmapped_windows_path",
						severity: "warning",
						location: ref.origin.location,
						path: ref.path,
						...(ref.origin.sourceType === "chat" ? { chatId: ref.origin.sourceId } : {}),
						message: `Windows/UNC path '${ref.path}' could not be resolved to an existing local file.`,
					});
				}
				diagnostics.push({
					code: "missing_referenced_file",
					severity: "warning",
					location: ref.origin.location,
					path: ref.path,
					...(ref.origin.sourceType === "chat" ? { chatId: ref.origin.sourceId } : {}),
					message: `Referenced file '${ref.path}' was not found during export.`,
				});
			}
		}
	}

	// 8. Identify skipped unreachable / orphan attachments & source-files (never bundled!)
	const skippedOrphanAttachmentIds: string[] = [];
	const attachmentsDir = path.join(/* turbopackIgnore: true */ realSourceDir, "attachments");
	for (const entry of listDirSafe(realSourceDir, attachmentsDir).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isDirectory() && isAttachmentSha256(entry.name)) {
			if (!bundledAttachments.has(entry.name)) {
				skippedOrphanAttachmentIds.push(entry.name);
				diagnostics.push({
					code: "skipped_orphan",
					severity: "info",
					location: `attachments/${entry.name}`,
					attachmentId: entry.name,
					message: `Skipped unreachable orphan attachment ${entry.name}.`,
				});
			}
		}
	}

	const skippedOrphanSourceFiles: string[] = [];
	const orphanScanRoot = explicitFilesRootReal ?? fallbackSourceFilesReal;
	if (orphanScanRoot) {
		const allRootFiles: string[] = [];
		collectAllFilesRelative(orphanScanRoot, orphanScanRoot, "", allRootFiles);
		for (const rel of allRootFiles.sort()) {
			const full = path.join(/* turbopackIgnore: true */ orphanScanRoot, ...rel.split("/"));
			const realFile = fs.realpathSync(/* turbopackIgnore: true */ full);
			if (!matchedFilesReal.has(realFile)) {
				skippedOrphanSourceFiles.push(rel);
				diagnostics.push({
					code: "skipped_orphan",
					severity: "info",
					location: `source-files/${rel}`,
					path: rel,
					message: `Skipped unreferenced orphan file '${rel}'.`,
				});
			}
		}
	}

	const attachmentsList = [...bundledAttachments.values()].sort((a, b) => a.id.localeCompare(b.id));
	const fileChecksums: Record<string, string> = {};
	for (const rel of [...bundleFiles.keys()].sort()) {
		fileChecksums[rel] = sha256Hex(bundleFiles.get(rel)!);
	}

	const manifest: MigrationBundleManifest = {
		formatVersion: MIGRATION_BUNDLE_FORMAT_VERSION,
		exportedAt: now,
		sourceOs,
		counts: {
			chats: chatsCount,
			attachments: attachmentsList.length,
			skippedOrphans: skippedOrphanAttachmentIds.length + skippedOrphanSourceFiles.length,
			graphNodes: graphNodesCount,
			graphChains: graphChainsCount,
			graphSessions: graphSessionsCount,
			graphCoverage: graphCoverageCount,
			graphSources: graphSourcesCount,
			jobs: jobsCount,
			prompts: promptsCount,
			themes: themesCount,
		},
		...(settingsUpdatedAt ? { settingsUpdatedAt } : {}),
		legacyLedgers,
		attachments: attachmentsList,
		fileChecksums,
		diagnostics,
	};

	// Write bundle atomically
	fs.mkdirSync(/* turbopackIgnore: true */ resolvedBundle, { recursive: true });
	for (const [rel, bytes] of bundleFiles.entries()) {
		if (!isValidBundleRelativePath(rel)) {
			throw new Error(`Refusing to write unsafe bundle relative path: ${rel}`);
		}
		const dest = path.join(/* turbopackIgnore: true */ resolvedBundle, ...rel.split("/"));
		fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(/* turbopackIgnore: true */ dest), { recursive: true });
		const tmp = `${dest}.tmp-${randomUUID()}`;
		try {
			const fd = fs.openSync(/* turbopackIgnore: true */ tmp, "wx", 0o644);
			try {
				fs.writeFileSync(fd, bytes);
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			fs.renameSync(/* turbopackIgnore: true */ tmp, dest);
		} catch (err) {
			try {
				fs.unlinkSync(/* turbopackIgnore: true */ tmp);
			} catch {
				/* ignore */
			}
			throw err;
		}
	}
	const manifestPath = path.join(/* turbopackIgnore: true */ resolvedBundle, "manifest.json");
	writeFileAtomicSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`, { allowInPlaceFallback: true });

	return {
		sourceDir: realSourceDir,
		bundleDir: resolvedBundle,
		manifest,
		diagnostics,
		skippedOrphans: {
			attachmentIds: skippedOrphanAttachmentIds,
			sourceFiles: skippedOrphanSourceFiles,
			totalCount: skippedOrphanAttachmentIds.length + skippedOrphanSourceFiles.length,
		},
		excludedSecrets,
		legacyLedgers,
	};
}

function createEmptyImportReport(
	bundleDir: string,
	targetDir: string,
	targetPlatform: string,
	dryRun: boolean,
): MigrationImportReport {
	return {
		mode: dryRun ? "dry-run" : "apply",
		dryRun,
		bundleDir,
		targetDir,
		targetPlatform,
		bytesWrittenToTarget: 0,
		integrity: { valid: true, errors: [] },
		chats: {
			create: [],
			update: [],
			skipServerNewer: [],
			skipUnchanged: [],
			skipNewerSchema: [],
		},
		attachments: {
			ingest: [],
			alreadyPresent: [],
		},
		graph: {
			nodesAdded: 0,
			nodesSkipped: 0,
			chainsAdded: 0,
			chainsSkipped: 0,
			sessionsAdded: 0,
			sessionsSkipped: 0,
			coverageAdded: 0,
			coverageUpdated: 0,
			coverageSkipped: 0,
			sourcesAdded: 0,
			sourcesUpdated: 0,
			sourcesPreserved: 0,
			sourceOrganizationChanged: false,
			positionsChanged: false,
			renderSettingsChanged: false,
			legacyLedgersDetected: [],
		},
		settings: {
			action: "none",
			strippedWindowsFolders: [],
			preservedRestricted: null,
		},
		jobs: {
			create: [],
			update: [],
			skipServerNewer: [],
			skipUnchanged: [],
		},
		prompts: {
			create: [],
			skipExisting: [],
		},
		themes: {
			create: [],
			skipExisting: [],
		},
		diagnostics: [],
	};
}

interface InternalApplyPlan {
	report: MigrationImportReport;
	attachmentsToIngest: Array<{ entry: MigrationBundleAttachmentEntry; bytes: Buffer }>;
	chatsToWrite: Array<{ id: string; jsonText: string }>;
	settingsToWrite: { jsonText: string } | null;
	graphWrites: {
		nodesAppend: GraphNode[];
		chainsAppend: GraphChain[];
		sessionsAppend: SessionCheckpoint[];
		coverageLines: CoverageEntry[] | null;
		coverageAppend: CoverageEntry[];
		sourcesMap: Record<string, NotesSource> | null;
		sourceOrganization: SourceOrganization | null;
		positions: { positions: Record<string, Position>; updatedAt: string } | null;
		renderSettings: ReturnType<typeof sanitizeRenderSettings> | null;
		writeFormatStamp: boolean;
	};
	jobsToWrite: Array<{ id: string; record: JobRecord; jsonText: string }>;
	promptsToWrite: Array<{ segmentPath: string; text: string }>;
	themesToWrite: Array<{ id: string; jsonText: string }>;
}

function inspectBundleTreeForSecurity(
	realBundleDir: string,
	currentDir: string,
	prefix: string,
	errors: string[],
): void {
	const entries = fs.readdirSync(/* turbopackIgnore: true */ currentDir, { withFileTypes: true });
	for (const entry of entries) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		const full = path.join(/* turbopackIgnore: true */ currentDir, entry.name);
		const stat = fs.lstatSync(/* turbopackIgnore: true */ full, { throwIfNoEntry: false });
		if (!stat || stat.isSymbolicLink()) {
			errors.push(`Symlink detected inside bundle: ${rel}`);
			continue;
		}
		if (!isValidBundleRelativePath(rel)) {
			errors.push(`Unsafe bundle path detected: ${rel}`);
			continue;
		}
		if (isSecretRelativePath(rel)) {
			errors.push(`Forbidden secret or debug file in bundle: ${rel}`);
			continue;
		}
		if (stat.isDirectory()) {
			inspectBundleTreeForSecurity(realBundleDir, full, rel, errors);
		}
	}
}

function buildImportPlan(options: PlanProfileImportOptions, dryRun: boolean): InternalApplyPlan {
	const targetPlatform = options.targetPlatform ?? process.platform;
	const resolvedBundle = path.resolve(/* turbopackIgnore: true */ options.bundleDir);
	const resolvedTarget = path.resolve(/* turbopackIgnore: true */ options.targetDir);
	const report = createEmptyImportReport(resolvedBundle, resolvedTarget, targetPlatform, dryRun);

	const emptyPlan = (): InternalApplyPlan => ({
		report,
		attachmentsToIngest: [],
		chatsToWrite: [],
		settingsToWrite: null,
		graphWrites: {
			nodesAppend: [],
			chainsAppend: [],
			sessionsAppend: [],
			coverageLines: null,
			coverageAppend: [],
			sourcesMap: null,
			sourceOrganization: null,
			positions: null,
			renderSettings: null,
			writeFormatStamp: false,
		},
		jobsToWrite: [],
		promptsToWrite: [],
		themesToWrite: [],
	});

	const bundleStat = fs.lstatSync(/* turbopackIgnore: true */ resolvedBundle, { throwIfNoEntry: false });
	if (!bundleStat || bundleStat.isSymbolicLink() || !bundleStat.isDirectory()) {
		report.integrity.valid = false;
		report.integrity.errors.push(`Bundle directory is missing or invalid: ${options.bundleDir}`);
		return emptyPlan();
	}
	const realBundleDir = fs.realpathSync(/* turbopackIgnore: true */ resolvedBundle);

	// Check targetDir is not a symlink if it exists, and validate standard target subpaths
	const targetStat = fs.lstatSync(/* turbopackIgnore: true */ resolvedTarget, { throwIfNoEntry: false });
	let realTargetDir: string | null = null;
	if (targetStat) {
		if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
			report.integrity.valid = false;
			report.integrity.errors.push(`Target directory is a symlink or not a directory: ${options.targetDir}`);
			return emptyPlan();
		}
		realTargetDir = fs.realpathSync(/* turbopackIgnore: true */ resolvedTarget);

		validateTargetSubpath(realTargetDir, ["settings.json"], "file", report.integrity.errors);
		for (const dirName of ["chats", "jobs", "prompts", "themes", "graph", "attachments"] as const) {
			validateTargetSubpath(realTargetDir, [dirName], "dir", report.integrity.errors);
		}
		for (const graphFile of [
			"format.json",
			"nodes.jsonl",
			"chains.jsonl",
			"sessions.jsonl",
			"coverage.jsonl",
			"sources.json",
			"source-organization.json",
			"positions.json",
			"render-settings.json",
		] as const) {
			validateTargetSubpath(realTargetDir, ["graph", graphFile], "file", report.integrity.errors);
		}
	}

	// Scan entire bundle tree for symlinks, unsafe paths, or forbidden secret files
	inspectBundleTreeForSecurity(realBundleDir, realBundleDir, "", report.integrity.errors);
	if (report.integrity.errors.length > 0) {
		report.integrity.valid = false;
		return emptyPlan();
	}

	const manifestPath = path.join(/* turbopackIgnore: true */ realBundleDir, "manifest.json");
	const manifestRead = readFileNoSymlink(realBundleDir, manifestPath);
	if (!manifestRead.ok) {
		report.integrity.valid = false;
		report.integrity.errors.push("Bundle manifest.json is missing or unreadable.");
		return emptyPlan();
	}

	let manifest: MigrationBundleManifest;
	try {
		manifest = parseMigrationBundleManifest(JSON.parse(manifestRead.bytes.toString("utf8")));
	} catch (err) {
		report.integrity.valid = false;
		report.integrity.errors.push(err instanceof Error ? err.message : String(err));
		return emptyPlan();
	}

	report.diagnostics.push(...manifest.diagnostics);

	// Verify every fileChecksum
	const bundleBuffers = new Map<string, Buffer>();
	for (const [rel, expectedSha] of Object.entries(manifest.fileChecksums)) {
		if (!isValidBundleRelativePath(rel) || isSecretRelativePath(rel)) {
			report.integrity.errors.push(`Invalid or forbidden path in manifest.fileChecksums: ${rel}`);
			continue;
		}
		const full = path.join(/* turbopackIgnore: true */ realBundleDir, ...rel.split("/"));
		const read = readFileNoSymlink(realBundleDir, full);
		if (!read.ok) {
			report.integrity.errors.push(`Missing or symlinked bundle file: ${rel}`);
			continue;
		}
		const actualSha = sha256Hex(read.bytes);
		if (actualSha !== expectedSha) {
			report.integrity.errors.push(`Checksum mismatch for ${rel}: expected ${expectedSha}, got ${actualSha}`);
			continue;
		}
		bundleBuffers.set(rel, read.bytes);
	}

	// Verify every attachment payload (SHA-256 + magic bytes + polyglot/APNG rejection + size limit)
	const attachmentsToIngest: Array<{ entry: MigrationBundleAttachmentEntry; bytes: Buffer }> = [];
	for (const entry of manifest.attachments) {
		if (!Object.hasOwn(manifest.fileChecksums, entry.bundlePath)) {
			report.integrity.errors.push(`Attachment ${entry.id} missing checksum entry for ${entry.bundlePath}`);
			continue;
		}
		const bytes = bundleBuffers.get(entry.bundlePath);
		if (!bytes) {
			report.integrity.errors.push(`Attachment ${entry.id} payload bytes unavailable for ${entry.bundlePath}`);
			continue;
		}
		const actualSha = sha256Hex(bytes);
		if (actualSha !== entry.id) {
			report.integrity.errors.push(`Attachment ${entry.id} SHA-256 mismatch (got ${actualSha})`);
			continue;
		}
		if (bytes.byteLength !== entry.sizeBytes) {
			report.integrity.errors.push(`Attachment ${entry.id} byte length mismatch`);
			continue;
		}
		const sniffed = detectAttachmentMimeType(bytes);
		if (!sniffed || sniffed !== entry.mimeType) {
			report.integrity.errors.push(`Attachment ${entry.id} failed MIME sniffing (declared ${entry.mimeType}, detected ${sniffed ?? "none"})`);
			continue;
		}
		const kind = attachmentKindForMime(sniffed);
		if (!kind || bytes.byteLength > attachmentMaxBytesForKind(kind)) {
			report.integrity.errors.push(`Attachment ${entry.id} exceeds size limit`);
			continue;
		}
		if (entry.metaBundlePath) {
			if (!Object.hasOwn(manifest.fileChecksums, entry.metaBundlePath)) {
				report.integrity.errors.push(`Attachment ${entry.id} missing checksum entry for ${entry.metaBundlePath}`);
				continue;
			}
			const metaBytes = bundleBuffers.get(entry.metaBundlePath);
			if (!metaBytes) {
				report.integrity.errors.push(`Attachment ${entry.id} missing metadata file ${entry.metaBundlePath}`);
				continue;
			}
			try {
				const parsedMeta = parseAttachmentMetaRecord(JSON.parse(metaBytes.toString("utf8")));
				if (parsedMeta.id !== entry.id) {
					report.integrity.errors.push(`Attachment ${entry.id} meta id mismatch`);
					continue;
				}
			} catch (err) {
				report.integrity.errors.push(`Invalid attachment metadata ${entry.metaBundlePath}: ${err instanceof Error ? err.message : String(err)}`);
				continue;
			}
		}

		// Check target attachment paths for symlinks/escapes and whether already present (strictly read-only)
		let alreadyPresent = false;
		if (realTargetDir) {
			const sanitizedFilename = sanitizeAttachmentFilename(entry.filename, sniffed);
			const dirOk = validateTargetSubpath(realTargetDir, ["attachments", entry.id], "dir", report.integrity.errors);
			const metaOk = validateTargetSubpath(realTargetDir, ["attachments", `${entry.id}.meta.json`], "file", report.integrity.errors);
			const fileOk = validateTargetSubpath(realTargetDir, ["attachments", entry.id, sanitizedFilename], "file", report.integrity.errors);
			let existingMetaFileOk = true;
			if (metaOk) {
				const targetMetaPath = path.join(/* turbopackIgnore: true */ realTargetDir, "attachments", `${entry.id}.meta.json`);
				const targetMetaRead = readFileNoSymlink(realTargetDir, targetMetaPath);
				if (!targetMetaRead.ok && targetMetaRead.reason === "symlink") {
					pushUniqueError(report.integrity.errors, `Target path cannot be a symbolic link: attachments/${entry.id}.meta.json`);
					existingMetaFileOk = false;
				} else if (targetMetaRead.ok) {
					try {
						const existingMeta = parseAttachmentMetaRecord(JSON.parse(targetMetaRead.bytes.toString("utf8")));
						if (
							existingMeta.id === entry.id &&
							!validateTargetSubpath(realTargetDir, ["attachments", entry.id, existingMeta.filename], "file", report.integrity.errors)
						) {
							existingMetaFileOk = false;
						}
					} catch {
						// corrupt existing meta file will be overwritten cleanly if non-symlink
					}
				}
			}
			if (!dirOk || !metaOk || !fileOk || !existingMetaFileOk) {
				continue;
			}
			const existing = resolveAttachmentFile(entry.id, realTargetDir);
			if (existing) {
				const existingBytes = fs.readFileSync(/* turbopackIgnore: true */ existing.filePath);
				if (sha256Hex(existingBytes) === entry.id) {
					alreadyPresent = true;
				}
			}
		}
		if (alreadyPresent) {
			report.attachments.alreadyPresent.push(entry.id);
		} else {
			report.attachments.ingest.push(entry.id);
			attachmentsToIngest.push({ entry, bytes });
		}
	}

	// Check graph format.json compatibility on both bundle and target
	const bundleFormatBytes = bundleBuffers.get("graph/format.json");
	if (bundleFormatBytes) {
		try {
			const parsed = JSON.parse(bundleFormatBytes.toString("utf8")) as { version?: unknown };
			if (typeof parsed.version === "number" && parsed.version > CURRENT_GRAPH_FORMAT_VERSION) {
				report.integrity.errors.push(`Bundle graph format version ${parsed.version} > ${CURRENT_GRAPH_FORMAT_VERSION}`);
			}
		} catch {
			report.integrity.errors.push("Bundle graph/format.json is invalid JSON");
		}
	}
	let targetHasFormatStamp = false;
	if (realTargetDir) {
		const targetFormatRead = readFileNoSymlink(
			realTargetDir,
			path.join(/* turbopackIgnore: true */ realTargetDir, "graph", "format.json"),
		);
		if (targetFormatRead.ok) {
			targetHasFormatStamp = true;
			try {
				const parsed = JSON.parse(targetFormatRead.bytes.toString("utf8")) as { version?: unknown };
				if (typeof parsed.version === "number" && parsed.version > CURRENT_GRAPH_FORMAT_VERSION) {
					report.integrity.errors.push(`Target graph format version ${parsed.version} > ${CURRENT_GRAPH_FORMAT_VERSION}`);
				}
			} catch {
				// corrupt sidecar reads as unstamped v1 per graph-format.ts
			}
		} else if (targetFormatRead.reason === "symlink") {
			report.integrity.errors.push("Target graph/format.json is a symlink");
		}
	}

	if (report.integrity.errors.length > 0) {
		report.integrity.valid = false;
		return emptyPlan();
	}

	const plan = emptyPlan();
	plan.attachmentsToIngest = attachmentsToIngest;

	// Plan Chats
	for (const rel of [...bundleBuffers.keys()].filter((k) => k.startsWith("chats/") && k.endsWith(".json")).sort()) {
		const id = rel.slice("chats/".length, -".json".length);
		if (!SAFE_RECORD_ID_RE.test(id)) continue;
		if (realTargetDir && !validateTargetSubpath(realTargetDir, ["chats", `${id}.json`], "file", report.integrity.errors)) {
			continue;
		}
		const incomingBytes = bundleBuffers.get(rel)!;
		let incoming: ChatRecordWithModifiedAt;
		try {
			incoming = JSON.parse(incomingBytes.toString("utf8")) as ChatRecordWithModifiedAt;
		} catch {
			continue;
		}
		if (!realTargetDir) {
			report.chats.create.push(id);
			plan.chatsToWrite.push({ id, jsonText: incomingBytes.toString("utf8") });
			continue;
		}
		const targetChatRead = readFileNoSymlink(realTargetDir, path.join(/* turbopackIgnore: true */ realTargetDir, "chats", `${id}.json`));
		if (!targetChatRead.ok) {
			if (targetChatRead.reason === "symlink" || targetChatRead.reason === "not_file") {
				pushUniqueError(report.integrity.errors, `Target chat path is invalid (${targetChatRead.reason}): chats/${id}.json`);
				continue;
			}
			report.chats.create.push(id);
			plan.chatsToWrite.push({ id, jsonText: incomingBytes.toString("utf8") });
			continue;
		}
		let existing: ChatRecordWithModifiedAt;
		try {
			existing = JSON.parse(targetChatRead.bytes.toString("utf8")) as ChatRecordWithModifiedAt;
		} catch {
			report.chats.update.push(id);
			plan.chatsToWrite.push({ id, jsonText: incomingBytes.toString("utf8") });
			continue;
		}
		if (typeof existing.version === "number" && existing.version > CURRENT_CHAT_VERSION) {
			report.chats.skipNewerSchema.push(id);
			continue;
		}
		const existingIso = effectiveChatModifiedAt(existing);
		const incomingIso = effectiveChatModifiedAt(incoming);
		const existingMs = parseTimestampOrNegInf(existingIso);
		const incomingMs = parseTimestampOrNegInf(incomingIso);

		if (existingMs > incomingMs) {
			report.chats.skipServerNewer.push(id);
			report.diagnostics.push({
				code: "newer_server_record",
				severity: "info",
				location: `chats/${id}.json`,
				chatId: id,
				message: `Preserved newer server chat ${id} (${existingIso} > ${incomingIso}).`,
			});
		} else if (existingMs === incomingMs) {
			if (canonicalJsonString(existing) === canonicalJsonString(incoming)) {
				report.chats.skipUnchanged.push(id);
			} else {
				report.chats.skipServerNewer.push(id);
				report.diagnostics.push({
					code: "newer_server_record",
					severity: "info",
					location: `chats/${id}.json`,
					chatId: id,
					message: `Preserved existing server chat ${id} (equal timestamp with differing content).`,
				});
			}
		} else {
			report.chats.update.push(id);
			plan.chatsToWrite.push({ id, jsonText: incomingBytes.toString("utf8") });
		}
	}

	// Plan Settings
	const settingsBytes = bundleBuffers.get("settings.json");
	if (settingsBytes) {
		try {
			const parsed = JSON.parse(settingsBytes.toString("utf8"));
			const sanitized = sanitizeUserSettings(parsed);
			if (sanitized) {
				if (sanitized.agent?.fileAccess) {
					const faSanitized = sanitizeFileAccessSettingsForPlatform(sanitized.agent.fileAccess, targetPlatform);
					sanitized.agent = { ...sanitized.agent, fileAccess: faSanitized.settings };
					report.settings.strippedWindowsFolders = faSanitized.removedWindowsFolders;
					report.settings.preservedRestricted = faSanitized.settings.restricted;
					for (const folder of faSanitized.removedWindowsFolders) {
						report.diagnostics.push({
							code: "incompatible_file_access_folder",
							severity: "warning",
							location: "settings.json:agent.fileAccess.folders",
							path: folder,
							message: `Stripped incompatible Windows folder '${folder}' from fileAccess.folders for ${targetPlatform}.`,
						});
					}
					if (
						faSanitized.removedWindowsFolders.length > 0 &&
						faSanitized.settings.restricted &&
						faSanitized.settings.folders.length === 0
					) {
						report.diagnostics.push({
							code: "file_access_all_folders_stripped",
							severity: "warning",
							location: "settings.json:agent.fileAccess",
							message: "All configured fileAccess folders were Windows paths and were stripped; restricted mode remains enabled with no allowed folders until a server path is added.",
						});
					}
				}
				const incomingSettingsText = `${JSON.stringify(sanitized, null, "\t")}\n`;
				if (realTargetDir && !validateTargetSubpath(realTargetDir, ["settings.json"], "file", report.integrity.errors)) {
					// integrity error already recorded
				} else {
					const targetSettingsRead = realTargetDir
						? readFileNoSymlink(realTargetDir, path.join(/* turbopackIgnore: true */ realTargetDir, "settings.json"))
						: { ok: false as const, reason: "missing" as const };
					if (!targetSettingsRead.ok) {
						if (targetSettingsRead.reason === "symlink" || targetSettingsRead.reason === "not_file") {
							pushUniqueError(report.integrity.errors, `Target settings.json is invalid (${targetSettingsRead.reason})`);
						} else {
							report.settings.action = "create";
							plan.settingsToWrite = { jsonText: incomingSettingsText };
						}
					} else {
						let existingSettings: UserSettings | null = null;
						try {
							existingSettings = sanitizeUserSettings(JSON.parse(targetSettingsRead.bytes.toString("utf8")));
						} catch {
							existingSettings = null;
						}
						if (existingSettings && canonicalJsonString(existingSettings) === canonicalJsonString(sanitized)) {
							report.settings.action = "skip_unchanged";
						} else {
							const incomingMs = parseTimestampOrNegInf(manifest.settingsUpdatedAt);
							const targetMs = targetSettingsRead.stat.mtimeMs;
							if (existingSettings && (!Number.isFinite(incomingMs) || targetMs >= incomingMs)) {
								report.settings.action = "preserve_server";
								report.diagnostics.push({
									code: "newer_server_record",
									severity: "info",
									location: "settings.json",
									message: "Preserved existing/newer server settings.json.",
								});
							} else {
								report.settings.action = "update";
								plan.settingsToWrite = { jsonText: incomingSettingsText };
							}
						}
					}
				}
			}
		} catch {
			// already sanitized during export
		}
	}

	// Plan Graph
	let anyGraphWrite = false;

	// Legacy ledgers detected in bundle (reported cleanly, never deleted on source, not written as dead files to target)
	for (const legacy of manifest.legacyLedgers) {
		report.graph.legacyLedgersDetected.push(legacy);
		if (!report.diagnostics.some((d) => d.code === "legacy_ledger" && d.location === `graph/${legacy}`)) {
			report.diagnostics.push({
				code: "legacy_ledger",
				severity: "warning",
				location: `graph/${legacy}`,
				path: `graph/${legacy}`,
				message: `Bundle contains retired legacy ledger graph/${legacy}; active graph uses chains.jsonl and nodes.jsonl.`,
			});
		}
	}

	// nodes.jsonl
	const bundleNodesBytes = bundleBuffers.get("graph/nodes.jsonl");
	if (bundleNodesBytes) {
		const targetNodesRaw = realTargetDir
			? readFileNoSymlink(realTargetDir, path.join(/* turbopackIgnore: true */ realTargetDir, "graph", "nodes.jsonl"))
			: { ok: false as const, reason: "missing" as const };
		if (!targetNodesRaw.ok && (targetNodesRaw.reason === "symlink" || targetNodesRaw.reason === "not_file")) {
			pushUniqueError(report.integrity.errors, `Target graph/nodes.jsonl is invalid (${targetNodesRaw.reason})`);
		}
		const targetNodes = targetNodesRaw.ok
			? parseJsonlLines(targetNodesRaw.bytes.toString("utf8")).lines.filter(isGraphNode)
			: [];
		const mergedNodes = new Map<string, { phrasings: Set<string>; provenance: ProvenancePoint[] }>();
		for (const node of targetNodes) {
			const entry = mergedNodes.get(node.id) ?? { phrasings: new Set<string>(), provenance: [] };
			if (node.statement) entry.phrasings.add(node.statement);
			for (const a of node.aliases) if (a) entry.phrasings.add(a);
			for (const pt of node.provenance) {
				if (!entry.provenance.some((p) => samePoint(p, pt))) entry.provenance.push(pt);
			}
			mergedNodes.set(node.id, entry);
		}
		const incomingNodes = parseJsonlLines(bundleNodesBytes.toString("utf8")).lines.filter(isGraphNode);
		for (const node of incomingNodes) {
			const existing = mergedNodes.get(node.id);
			if (!existing) {
				plan.graphWrites.nodesAppend.push(node);
				report.graph.nodesAdded++;
				anyGraphWrite = true;
				const phrasings = new Set<string>();
				if (node.statement) phrasings.add(node.statement);
				for (const a of node.aliases) if (a) phrasings.add(a);
				mergedNodes.set(node.id, { phrasings, provenance: [...node.provenance] });
			} else {
				const newPhrasing =
					(node.statement.length > 0 && !existing.phrasings.has(node.statement)) ||
					node.aliases.some((a) => a.length > 0 && !existing.phrasings.has(a));
				const newProv = node.provenance.some((pt) => !existing.provenance.some((p) => samePoint(p, pt)));
				if (newPhrasing || newProv) {
					plan.graphWrites.nodesAppend.push(node);
					report.graph.nodesAdded++;
					anyGraphWrite = true;
					if (node.statement) existing.phrasings.add(node.statement);
					for (const a of node.aliases) if (a) existing.phrasings.add(a);
					for (const pt of node.provenance) {
						if (!existing.provenance.some((p) => samePoint(p, pt))) existing.provenance.push(pt);
					}
				} else {
					report.graph.nodesSkipped++;
				}
			}
		}
	}

	// chains.jsonl
	const bundleChainsBytes = bundleBuffers.get("graph/chains.jsonl");
	if (bundleChainsBytes) {
		const targetChainsRaw = realTargetDir
			? readFileNoSymlink(realTargetDir, path.join(/* turbopackIgnore: true */ realTargetDir, "graph", "chains.jsonl"))
			: { ok: false as const, reason: "missing" as const };
		if (!targetChainsRaw.ok && (targetChainsRaw.reason === "symlink" || targetChainsRaw.reason === "not_file")) {
			pushUniqueError(report.integrity.errors, `Target graph/chains.jsonl is invalid (${targetChainsRaw.reason})`);
		}
		const targetChains = targetChainsRaw.ok
			? parseJsonlLines(targetChainsRaw.bytes.toString("utf8")).lines.filter(isGraphChain)
			: [];
		const byKey = new Map<string, { id: string; provenance: ProvenancePoint[] }>();
		for (const chain of targetChains) {
			const key = chainKey(chain.premises, chain.conclusion);
			const existing = byKey.get(key) ?? { id: chain.id, provenance: [] };
			for (const pt of chain.provenance) {
				if (!existing.provenance.some((p) => samePoint(p, pt))) existing.provenance.push(pt);
			}
			byKey.set(key, existing);
		}
		const incomingChains = parseJsonlLines(bundleChainsBytes.toString("utf8")).lines.filter(isGraphChain);
		for (const chain of incomingChains) {
			const key = chainKey(chain.premises, chain.conclusion);
			const existing = byKey.get(key);
			if (!existing) {
				plan.graphWrites.chainsAppend.push(chain);
				report.graph.chainsAdded++;
				anyGraphWrite = true;
				byKey.set(key, { id: chain.id, provenance: [...chain.provenance] });
			} else {
				const hasNewProv = chain.provenance.some((pt) => !existing.provenance.some((p) => samePoint(p, pt)));
				if (hasNewProv) {
					plan.graphWrites.chainsAppend.push({ ...chain, id: existing.id });
					report.graph.chainsAdded++;
					anyGraphWrite = true;
					for (const pt of chain.provenance) {
						if (!existing.provenance.some((p) => samePoint(p, pt))) existing.provenance.push(pt);
					}
				} else {
					report.graph.chainsSkipped++;
				}
			}
		}
	}

	// sessions.jsonl
	const bundleSessionsBytes = bundleBuffers.get("graph/sessions.jsonl");
	if (bundleSessionsBytes) {
		const targetSessionsRaw = realTargetDir
			? readFileNoSymlink(realTargetDir, path.join(/* turbopackIgnore: true */ realTargetDir, "graph", "sessions.jsonl"))
			: { ok: false as const, reason: "missing" as const };
		if (!targetSessionsRaw.ok && (targetSessionsRaw.reason === "symlink" || targetSessionsRaw.reason === "not_file")) {
			pushUniqueError(report.integrity.errors, `Target graph/sessions.jsonl is invalid (${targetSessionsRaw.reason})`);
		}
		const targetSessions = targetSessionsRaw.ok
			? parseJsonlLines(targetSessionsRaw.bytes.toString("utf8")).lines.filter(isCheckpoint)
			: [];
		const seen = new Set(targetSessions.map((s) => `${s.chatId}\u0000${s.foldedAt}`));
		const incomingSessions = parseJsonlLines(bundleSessionsBytes.toString("utf8")).lines.filter(isCheckpoint);
		for (const cp of incomingSessions) {
			const key = `${cp.chatId}\u0000${cp.foldedAt}`;
			if (seen.has(key)) {
				report.graph.sessionsSkipped++;
			} else {
				seen.add(key);
				plan.graphWrites.sessionsAppend.push(cp);
				report.graph.sessionsAdded++;
				anyGraphWrite = true;
			}
		}
	}

	// coverage.jsonl
	const bundleCoverageBytes = bundleBuffers.get("graph/coverage.jsonl");
	if (bundleCoverageBytes) {
		const targetCoverageRaw = realTargetDir
			? readFileNoSymlink(realTargetDir, path.join(/* turbopackIgnore: true */ realTargetDir, "graph", "coverage.jsonl"))
			: { ok: false as const, reason: "missing" as const };
		if (!targetCoverageRaw.ok && (targetCoverageRaw.reason === "symlink" || targetCoverageRaw.reason === "not_file")) {
			pushUniqueError(report.integrity.errors, `Target graph/coverage.jsonl is invalid (${targetCoverageRaw.reason})`);
		}
		const targetCoverage = targetCoverageRaw.ok
			? parseJsonlLines(targetCoverageRaw.bytes.toString("utf8")).lines.filter(isCoverageEntry)
			: [];
		const byKey = new Map<string, CoverageEntry>();
		const orderedKeys: string[] = [];
		for (const entry of targetCoverage) {
			const key = `${entry.chatId}\u0000${entry.fp}`;
			if (!byKey.has(key)) orderedKeys.push(key);
			const prev = byKey.get(key);
			if (!prev || parseTimestampOrNegInf(entry.foldedAt) > parseTimestampOrNegInf(prev.foldedAt)) {
				byKey.set(key, entry);
			}
		}
		let updatedExisting = false;
		const incomingCoverage = parseJsonlLines(bundleCoverageBytes.toString("utf8")).lines.filter(isCoverageEntry);
		for (const entry of incomingCoverage) {
			const key = `${entry.chatId}\u0000${entry.fp}`;
			const existing = byKey.get(key);
			if (!existing) {
				byKey.set(key, entry);
				orderedKeys.push(key);
				plan.graphWrites.coverageAppend.push(entry);
				report.graph.coverageAdded++;
				anyGraphWrite = true;
			} else if (parseTimestampOrNegInf(entry.foldedAt) > parseTimestampOrNegInf(existing.foldedAt)) {
				byKey.set(key, entry);
				updatedExisting = true;
				report.graph.coverageUpdated++;
				anyGraphWrite = true;
			} else {
				report.graph.coverageSkipped++;
			}
		}
		if (updatedExisting) {
			plan.graphWrites.coverageLines = orderedKeys.map((k) => byKey.get(k)!);
		}
	}

	// sources.json
	const bundleSourcesBytes = bundleBuffers.get("graph/sources.json");
	if (bundleSourcesBytes) {
		try {
			const parsedIncoming = JSON.parse(bundleSourcesBytes.toString("utf8")) as Record<string, unknown>;
			const targetSourcesRead = realTargetDir
				? readFileNoSymlink(realTargetDir, path.join(/* turbopackIgnore: true */ realTargetDir, "graph", "sources.json"))
				: { ok: false as const, reason: "missing" as const };
			if (!targetSourcesRead.ok && (targetSourcesRead.reason === "symlink" || targetSourcesRead.reason === "not_file")) {
				pushUniqueError(report.integrity.errors, `Target graph/sources.json is invalid (${targetSourcesRead.reason})`);
			}
			const mergedSources: Record<string, NotesSource> = {};
			if (targetSourcesRead.ok) {
				try {
					const parsedTarget = JSON.parse(targetSourcesRead.bytes.toString("utf8")) as Record<string, unknown>;
					if (isPlainRecord(parsedTarget)) {
						for (const [k, v] of Object.entries(parsedTarget)) {
							if (isNotesSource(v)) setOwnProp(mergedSources, k, v);
						}
					}
				} catch {
					// ignore corrupt target
				}
			}
			let sourcesChanged = false;
			if (isPlainRecord(parsedIncoming)) {
				for (const [id, rawSrc] of Object.entries(parsedIncoming)) {
					if (!isNotesSource(rawSrc)) continue;
					const existing = Object.hasOwn(mergedSources, id) ? mergedSources[id] : undefined;
					if (!existing) {
						setOwnProp(mergedSources, id, rawSrc);
						report.graph.sourcesAdded++;
						sourcesChanged = true;
					} else {
						const incomingMs = parseTimestampOrNegInf(rawSrc.importedAt);
						const existingMs = parseTimestampOrNegInf(existing.importedAt);
						const unionExtractions = [...(existing.extractions ?? [])];
						const seenStarts = new Set(unionExtractions.map((e) => e.startedAt));
						let extractionsAdded = false;
						for (const ext of rawSrc.extractions ?? []) {
							if (!seenStarts.has(ext.startedAt)) {
								seenStarts.add(ext.startedAt);
								unionExtractions.push(ext);
								extractionsAdded = true;
							}
						}
						if (incomingMs > existingMs) {
							setOwnProp(mergedSources, id, {
								...rawSrc,
								...(unionExtractions.length > 0 ? { extractions: unionExtractions } : {}),
							});
							report.graph.sourcesUpdated++;
							sourcesChanged = true;
						} else if (extractionsAdded) {
							setOwnProp(mergedSources, id, { ...existing, extractions: unionExtractions });
							report.graph.sourcesUpdated++;
							sourcesChanged = true;
						} else {
							report.graph.sourcesPreserved++;
						}
					}
				}
			}
			if (sourcesChanged) {
				plan.graphWrites.sourcesMap = mergedSources;
				anyGraphWrite = true;
			}
		} catch {
			// ignore
		}
	}

	// source-organization.json
	const bundleOrgBytes = bundleBuffers.get("graph/source-organization.json");
	if (bundleOrgBytes) {
		try {
			const incomingOrg = parseSourceOrganization(JSON.parse(bundleOrgBytes.toString("utf8")));
			const targetOrgRead = realTargetDir
				? readFileNoSymlink(realTargetDir, path.join(/* turbopackIgnore: true */ realTargetDir, "graph", "source-organization.json"))
				: { ok: false as const, reason: "missing" as const };
			if (!targetOrgRead.ok && (targetOrgRead.reason === "symlink" || targetOrgRead.reason === "not_file")) {
				pushUniqueError(report.integrity.errors, `Target graph/source-organization.json is invalid (${targetOrgRead.reason})`);
			}
			let baseOrg: SourceOrganization = emptySourceOrganization();
			let hadTargetOrg = false;
			if (targetOrgRead.ok) {
				try {
					baseOrg = parseSourceOrganization(JSON.parse(targetOrgRead.bytes.toString("utf8")));
					hadTargetOrg = true;
				} catch {
					baseOrg = emptySourceOrganization();
				}
			}
			const folderIds = new Set(baseOrg.folders.map((f) => f.id));
			const mergedFolders = [...baseOrg.folders];
			for (const folder of incomingOrg.folders) {
				if (!folderIds.has(folder.id)) {
					mergedFolders.push(folder);
					folderIds.add(folder.id);
				}
			}
			const mergedPlacements: SourceOrganization["placements"] = {};
			for (const [sourceId, placement] of Object.entries(baseOrg.placements)) {
				if (Object.hasOwn(baseOrg.placements, sourceId)) {
					setOwnProp(mergedPlacements, sourceId, placement);
				}
			}
			for (const [sourceId, placement] of Object.entries(incomingOrg.placements)) {
				if (!Object.hasOwn(mergedPlacements, sourceId)) {
					if (placement.folderId === null || folderIds.has(placement.folderId)) {
						setOwnProp(mergedPlacements, sourceId, placement);
					}
				}
			}
			const mergedOrg = parseSourceOrganization({
				version: 1,
				folders: mergedFolders,
				placements: mergedPlacements,
			});
			if (!hadTargetOrg || canonicalJsonString(mergedOrg) !== canonicalJsonString(baseOrg)) {
				plan.graphWrites.sourceOrganization = mergedOrg;
				report.graph.sourceOrganizationChanged = true;
				anyGraphWrite = true;
			}
		} catch {
			// ignore
		}
	}

	// positions.json
	const bundlePositionsBytes = bundleBuffers.get("graph/positions.json");
	if (bundlePositionsBytes) {
		try {
			const incomingParsed = JSON.parse(bundlePositionsBytes.toString("utf8")) as {
				positions?: Record<string, Position>;
				updatedAt?: string;
			};
			const incomingPos: Record<string, Position> = {};
			if (isPlainRecord(incomingParsed.positions)) {
				for (const [k, v] of Object.entries(incomingParsed.positions)) setOwnProp(incomingPos, k, v);
			}
			const incomingUpdatedAt = typeof incomingParsed.updatedAt === "string" ? incomingParsed.updatedAt : "";
			const targetPosRead = realTargetDir
				? readFileNoSymlink(realTargetDir, path.join(/* turbopackIgnore: true */ realTargetDir, "graph", "positions.json"))
				: { ok: false as const, reason: "missing" as const };
			if (!targetPosRead.ok) {
				if (targetPosRead.reason === "symlink" || targetPosRead.reason === "not_file") {
					pushUniqueError(report.integrity.errors, `Target graph/positions.json is invalid (${targetPosRead.reason})`);
				} else {
					plan.graphWrites.positions = { positions: incomingPos, updatedAt: incomingUpdatedAt || manifest.exportedAt };
					report.graph.positionsChanged = true;
					anyGraphWrite = true;
				}
			} else {
				const targetParsed = JSON.parse(targetPosRead.bytes.toString("utf8")) as {
					positions?: Record<string, Position>;
					updatedAt?: string;
				};
				const targetPos = isPlainRecord(targetParsed.positions) ? targetParsed.positions : {};
				const targetUpdatedAt = typeof targetParsed.updatedAt === "string" ? targetParsed.updatedAt : "";
				const incomingMs = parseTimestampOrNegInf(incomingUpdatedAt);
				const targetMs = parseTimestampOrNegInf(targetUpdatedAt);
				const mergedPos: Record<string, Position> = {};
				let nextUpdatedAt: string;
				if (incomingMs > targetMs) {
					for (const [k, v] of Object.entries(targetPos)) setOwnProp(mergedPos, k, v);
					for (const [k, v] of Object.entries(incomingPos)) setOwnProp(mergedPos, k, v);
					nextUpdatedAt = incomingUpdatedAt;
				} else {
					for (const [k, v] of Object.entries(incomingPos)) setOwnProp(mergedPos, k, v);
					for (const [k, v] of Object.entries(targetPos)) setOwnProp(mergedPos, k, v);
					nextUpdatedAt = targetUpdatedAt || incomingUpdatedAt || manifest.exportedAt;
				}
				const nextObj = { positions: mergedPos, updatedAt: nextUpdatedAt };
				if (canonicalJsonString(nextObj) !== canonicalJsonString({ positions: targetPos, updatedAt: targetUpdatedAt })) {
					plan.graphWrites.positions = nextObj;
					report.graph.positionsChanged = true;
					anyGraphWrite = true;
				}
			}
		} catch {
			// ignore
		}
	}

	// render-settings.json
	const bundleRenderBytes = bundleBuffers.get("graph/render-settings.json");
	if (bundleRenderBytes) {
		const targetRenderRead = realTargetDir
			? readFileNoSymlink(realTargetDir, path.join(/* turbopackIgnore: true */ realTargetDir, "graph", "render-settings.json"))
			: { ok: false as const, reason: "missing" as const };
		if (!targetRenderRead.ok) {
			if (targetRenderRead.reason === "symlink" || targetRenderRead.reason === "not_file") {
				pushUniqueError(report.integrity.errors, `Target graph/render-settings.json is invalid (${targetRenderRead.reason})`);
			} else {
				try {
					plan.graphWrites.renderSettings = sanitizeRenderSettings(JSON.parse(bundleRenderBytes.toString("utf8")));
					report.graph.renderSettingsChanged = true;
					anyGraphWrite = true;
				} catch {
					// ignore
				}
			}
		}
	}

	if (anyGraphWrite && !targetHasFormatStamp) {
		plan.graphWrites.writeFormatStamp = true;
	}

	// Plan Jobs
	for (const rel of [...bundleBuffers.keys()].filter((k) => k.startsWith("jobs/") && k.endsWith(".json")).sort()) {
		const id = rel.slice("jobs/".length, -".json".length);
		if (!SAFE_RECORD_ID_RE.test(id)) continue;
		if (realTargetDir && !validateTargetSubpath(realTargetDir, ["jobs", `${id}.json`], "file", report.integrity.errors)) {
			continue;
		}
		const bytes = bundleBuffers.get(rel)!;
		let incoming: JobRecord;
		try {
			incoming = JSON.parse(bytes.toString("utf8")) as JobRecord;
		} catch {
			continue;
		}
		const targetJobRead = realTargetDir
			? readFileNoSymlink(realTargetDir, path.join(/* turbopackIgnore: true */ realTargetDir, "jobs", `${id}.json`))
			: { ok: false as const, reason: "missing" as const };
		if (!targetJobRead.ok) {
			if (targetJobRead.reason === "symlink" || targetJobRead.reason === "not_file") {
				pushUniqueError(report.integrity.errors, `Target job path is invalid (${targetJobRead.reason}): jobs/${id}.json`);
				continue;
			}
			report.jobs.create.push(id);
			plan.jobsToWrite.push({ id, record: incoming, jsonText: bytes.toString("utf8") });
			continue;
		}
		try {
			const existing = JSON.parse(targetJobRead.bytes.toString("utf8")) as JobRecord;
			const incomingMs = parseTimestampOrNegInf(incoming.updatedAt);
			const existingMs = parseTimestampOrNegInf(existing.updatedAt);
			if (existingMs > incomingMs) {
				report.jobs.skipServerNewer.push(id);
				report.diagnostics.push({
					code: "newer_server_record",
					severity: "info",
					location: `jobs/${id}.json`,
					message: `Preserved newer server job ${id}.`,
				});
			} else if (existingMs === incomingMs) {
				if (canonicalJsonString(existing) === canonicalJsonString(incoming)) {
					report.jobs.skipUnchanged.push(id);
				} else {
					report.jobs.skipServerNewer.push(id);
					report.diagnostics.push({
						code: "newer_server_record",
						severity: "info",
						location: `jobs/${id}.json`,
						message: `Preserved existing server job ${id} (equal timestamp with differing content).`,
					});
				}
			} else {
				report.jobs.update.push(id);
				plan.jobsToWrite.push({ id, record: incoming, jsonText: bytes.toString("utf8") });
			}
		} catch {
			report.jobs.update.push(id);
			plan.jobsToWrite.push({ id, record: incoming, jsonText: bytes.toString("utf8") });
		}
	}

	// Plan Prompts
	for (const rel of [...bundleBuffers.keys()].filter((k) => k.startsWith("prompts/") && k.endsWith(".md")).sort()) {
		const seg = rel.slice("prompts/".length);
		if (!isValidSegmentPath(seg)) continue;
		const promptSegs = ["prompts", ...seg.split("/")];
		if (realTargetDir && !validateTargetSubpath(realTargetDir, promptSegs, "file", report.integrity.errors)) {
			continue;
		}
		const targetPromptRead = realTargetDir
			? readFileNoSymlink(realTargetDir, path.join(/* turbopackIgnore: true */ realTargetDir, ...promptSegs))
			: { ok: false as const, reason: "missing" as const };
		if (targetPromptRead.ok) {
			report.prompts.skipExisting.push(seg);
		} else if (targetPromptRead.reason === "symlink" || targetPromptRead.reason === "not_file") {
			pushUniqueError(report.integrity.errors, `Target prompt path is invalid (${targetPromptRead.reason}): prompts/${seg}`);
		} else {
			report.prompts.create.push(seg);
			plan.promptsToWrite.push({ segmentPath: seg, text: bundleBuffers.get(rel)!.toString("utf8") });
		}
	}

	// Plan Themes
	for (const rel of [...bundleBuffers.keys()].filter((k) => k.startsWith("themes/") && k.endsWith(".json")).sort()) {
		const id = rel.slice("themes/".length, -".json".length);
		if (!isThemeId(id) || isBuiltinThemeId(id)) continue;
		if (realTargetDir && !validateTargetSubpath(realTargetDir, ["themes", `${id}.json`], "file", report.integrity.errors)) {
			continue;
		}
		const targetThemeRead = realTargetDir
			? readFileNoSymlink(realTargetDir, path.join(/* turbopackIgnore: true */ realTargetDir, "themes", `${id}.json`))
			: { ok: false as const, reason: "missing" as const };
		if (targetThemeRead.ok) {
			report.themes.skipExisting.push(id);
		} else if (targetThemeRead.reason === "symlink" || targetThemeRead.reason === "not_file") {
			pushUniqueError(report.integrity.errors, `Target theme path is invalid (${targetThemeRead.reason}): themes/${id}.json`);
		} else {
			try {
				const sanitized = sanitizeThemeFile(JSON.parse(bundleBuffers.get(rel)!.toString("utf8")));
				if (sanitized) {
					report.themes.create.push(id);
					plan.themesToWrite.push({ id, jsonText: `${JSON.stringify(sanitized, null, "\t")}\n` });
				}
			} catch {
				// ignore
			}
		}
	}

	if (report.integrity.errors.length > 0) {
		report.integrity.valid = false;
		return emptyPlan();
	}

	return plan;
}

/**
 * Plan a migration import strictly read-only on `targetDir`.
 * Writes ZERO bytes to `targetDir` (never calls `mkdirSync` on target).
 */
export function planProfileImport(options: PlanProfileImportOptions): MigrationImportReport {
	return buildImportPlan(options, true).report;
}

/**
 * Execute or dry-run a profile import.
 * - `dryRun: true` writes ZERO bytes to `targetDir`.
 * - `dryRun: false` refuses to write if `integrity.valid === false`, otherwise applies
 *   changes atomically and idempotently while preserving newer server records.
 */
export function importProfile(options: ImportProfileOptions): MigrationImportReport {
	const plan = buildImportPlan(options, options.dryRun);
	const { report } = plan;

	if (options.dryRun || !report.integrity.valid) {
		report.bytesWrittenToTarget = 0;
		return report;
	}

	const targetDir = report.targetDir;
	let bytesWritten = 0;

	const ensureDir = (dir: string): void => {
		fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
	};

	// 1. Attachments via M1 storeAttachment
	for (const item of plan.attachmentsToIngest) {
		const stored = storeAttachment({
			bytes: item.bytes,
			filename: item.entry.filename,
			mimeType: item.entry.mimeType,
			dataDir: targetDir,
			createdAt: item.entry.createdAt,
		});
		if (!stored.deduplicated) {
			bytesWritten += item.bytes.byteLength + Buffer.byteLength(JSON.stringify(stored.meta, null, "\t") + "\n", "utf8");
		}
	}

	// 2. Chats
	if (plan.chatsToWrite.length > 0) {
		const chatsDir = path.join(/* turbopackIgnore: true */ targetDir, "chats");
		ensureDir(chatsDir);
		for (const item of plan.chatsToWrite) {
			const dest = path.join(/* turbopackIgnore: true */ chatsDir, `${item.id}.json`);
			writeFileAtomicSync(dest, item.jsonText, { allowInPlaceFallback: true });
			bytesWritten += Buffer.byteLength(item.jsonText, "utf8");
		}
	}

	// 3. Settings
	if (plan.settingsToWrite) {
		ensureDir(targetDir);
		const dest = path.join(/* turbopackIgnore: true */ targetDir, "settings.json");
		writeFileAtomicSync(dest, plan.settingsToWrite.jsonText, { allowInPlaceFallback: true });
		bytesWritten += Buffer.byteLength(plan.settingsToWrite.jsonText, "utf8");
	}

	// 4. Graph
	const graphDir = path.join(/* turbopackIgnore: true */ targetDir, "graph");
	const appendJsonlAtomic = (filename: string, newRecords: unknown[]): void => {
		if (newRecords.length === 0) return;
		ensureDir(graphDir);
		const dest = path.join(/* turbopackIgnore: true */ graphDir, filename);
		let existing = "";
		try {
			existing = fs.readFileSync(/* turbopackIgnore: true */ dest, "utf8");
		} catch {
			existing = "";
		}
		const prefix = existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n` : existing;
		const addition = `${newRecords.map((r) => JSON.stringify(r)).join("\n")}\n`;
		const nextText = prefix + addition;
		writeFileAtomicSync(dest, nextText, { allowInPlaceFallback: false });
		removeLeftoverTemps(dest);
		bytesWritten += Buffer.byteLength(addition, "utf8");
	};

	appendJsonlAtomic("nodes.jsonl", plan.graphWrites.nodesAppend);
	appendJsonlAtomic("chains.jsonl", plan.graphWrites.chainsAppend);
	appendJsonlAtomic("sessions.jsonl", plan.graphWrites.sessionsAppend);

	if (plan.graphWrites.coverageLines !== null) {
		ensureDir(graphDir);
		const dest = path.join(/* turbopackIgnore: true */ graphDir, "coverage.jsonl");
		const text = plan.graphWrites.coverageLines.map((r) => JSON.stringify(r)).join("\n") + (plan.graphWrites.coverageLines.length ? "\n" : "");
		writeFileAtomicSync(dest, text, { allowInPlaceFallback: false });
		removeLeftoverTemps(dest);
		bytesWritten += Buffer.byteLength(text, "utf8");
	} else {
		appendJsonlAtomic("coverage.jsonl", plan.graphWrites.coverageAppend);
	}

	if (plan.graphWrites.sourcesMap !== null) {
		ensureDir(graphDir);
		const dest = path.join(/* turbopackIgnore: true */ graphDir, "sources.json");
		const text = `${JSON.stringify(plan.graphWrites.sourcesMap, null, "\t")}\n`;
		writeFileAtomicSync(dest, text, { allowInPlaceFallback: true });
		bytesWritten += Buffer.byteLength(text, "utf8");
	}

	if (plan.graphWrites.sourceOrganization !== null) {
		ensureDir(graphDir);
		const dest = path.join(/* turbopackIgnore: true */ graphDir, "source-organization.json");
		const text = `${JSON.stringify(plan.graphWrites.sourceOrganization, null, "\t")}\n`;
		writeFileAtomicSync(dest, text, { allowInPlaceFallback: false });
		removeLeftoverTemps(dest);
		bytesWritten += Buffer.byteLength(text, "utf8");
	}

	if (plan.graphWrites.positions !== null) {
		ensureDir(graphDir);
		const dest = path.join(/* turbopackIgnore: true */ graphDir, "positions.json");
		const text = `${JSON.stringify(plan.graphWrites.positions, null, "\t")}\n`;
		writeFileAtomicSync(dest, text, { allowInPlaceFallback: false });
		removeLeftoverTemps(dest);
		bytesWritten += Buffer.byteLength(text, "utf8");
	}

	if (plan.graphWrites.renderSettings !== null) {
		ensureDir(graphDir);
		const dest = path.join(/* turbopackIgnore: true */ graphDir, "render-settings.json");
		const text = `${JSON.stringify(plan.graphWrites.renderSettings, null, "\t")}\n`;
		writeFileAtomicSync(dest, text, { allowInPlaceFallback: true });
		bytesWritten += Buffer.byteLength(text, "utf8");
	}

	if (plan.graphWrites.writeFormatStamp) {
		ensureDir(graphDir);
		const dest = path.join(/* turbopackIgnore: true */ graphDir, "format.json");
		const text = `${JSON.stringify({ version: CURRENT_GRAPH_FORMAT_VERSION }, null, "\t")}\n`;
		writeFileAtomicSync(dest, text, { allowInPlaceFallback: true });
		bytesWritten += Buffer.byteLength(text, "utf8");
	}

	// 5. Jobs
	if (plan.jobsToWrite.length > 0) {
		const jobsDir = path.join(/* turbopackIgnore: true */ targetDir, "jobs");
		ensureDir(jobsDir);
		for (const item of plan.jobsToWrite) {
			const strict = item.record.kind === "plugin" || item.record.plugin !== undefined;
			const dest = path.join(/* turbopackIgnore: true */ jobsDir, `${item.id}.json`);
			writeFileAtomicSync(dest, item.jsonText, {
				allowInPlaceFallback: !strict,
				...(strict ? { mode: 0o600 } : {}),
			});
			bytesWritten += Buffer.byteLength(item.jsonText, "utf8");
		}
	}

	// 6. Prompts
	if (plan.promptsToWrite.length > 0) {
		const promptsDir = path.join(/* turbopackIgnore: true */ targetDir, "prompts");
		for (const item of plan.promptsToWrite) {
			const dest = path.join(/* turbopackIgnore: true */ promptsDir, ...item.segmentPath.split("/"));
			ensureDir(path.dirname(/* turbopackIgnore: true */ dest));
			writeFileAtomicSync(dest, item.text, { allowInPlaceFallback: true });
			bytesWritten += Buffer.byteLength(item.text, "utf8");
		}
	}

	// 7. Themes
	if (plan.themesToWrite.length > 0) {
		const themesDir = path.join(/* turbopackIgnore: true */ targetDir, "themes");
		ensureDir(themesDir);
		for (const item of plan.themesToWrite) {
			const dest = path.join(/* turbopackIgnore: true */ themesDir, `${item.id}.json`);
			writeFileAtomicSync(dest, item.jsonText, { allowInPlaceFallback: false });
			removeLeftoverTemps(dest);
			bytesWritten += Buffer.byteLength(item.jsonText, "utf8");
		}
	}

	report.bytesWrittenToTarget = bytesWritten;
	return report;
}
