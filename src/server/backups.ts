/**
 * Profile Backup, Automated Safety Snapshots, Restore, and In-App Migration.
 *
 * Manages verified `.tar.gz` backups under `<LH_DATA_DIR>/.backups/` (never
 * containing secrets like `auth.json`, `user-auth.json*`, `*-credentials.json*`,
 * or `.env*`). Every restore or migration automatically creates a verified
 * pre-operation safety snapshot first so any unexpected failure can be rolled
 * back with a single click from Settings → General.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS } from "../../config.ts";
import {
	BACKUP_ARCHIVE_FORMAT_VERSION,
	isValidBackupId,
	type BackupCounts,
	type BackupImportPreview,
	type BackupReason,
	type BackupRestoreMode,
	type BackupSnapshotMeta,
} from "../core/contracts/backups.ts";
import {
	MIGRATION_BUNDLE_FORMAT_VERSION,
	isValidBundleRelativePath,
	sanitizeFileAccessSettingsForPlatform,
	type MigrationBundleAttachmentEntry,
	type MigrationBundleManifest,
} from "../core/contracts/migration.ts";
import { isAttachmentSha256, parseAttachmentMetaRecord } from "../core/contracts/attachments.ts";
import { sanitizeUserSettings } from "../core/settings.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { packTarGz, unpackTarGz, type TarEntry } from "./backup-archive.ts";
import { importProfile } from "./migration.ts";

function resolveDataDir(): string {
	return PATHS.data;
}

function writeBytesAtomicSync(file: string, bytes: Buffer, mode?: number): void {
	const tmp = `${file}.tmp-${randomUUID()}`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(/* turbopackIgnore: true */ tmp, "wx", mode ?? 0o666);
		if (mode !== undefined && process.platform !== "win32") fs.fchmodSync(fd, mode);
		fs.writeFileSync(fd, bytes);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(/* turbopackIgnore: true */ tmp, /* turbopackIgnore: true */ file);
	} catch (err) {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* ignore */ }
		}
		try { fs.unlinkSync(/* turbopackIgnore: true */ tmp); } catch { /* ignore */ }
		throw err;
	}
}

const BACKUPS_SUBDIR = ".backups";
const MAX_STORED_BACKUPS = 12;
const MANIFEST_FILENAME = "backup-manifest.json";

const MANAGED_TOP_DIRS = new Set([
	"chats",
	"jobs",
	"graph",
	"prompts",
	"themes",
	"attachments",
	"core-plugin-data",
]);
const MANAGED_TOP_FILES = new Set(["settings.json", "plugins-state.json"]);

interface BackupArchiveManifest {
	formatVersion: typeof BACKUP_ARCHIVE_FORMAT_VERSION;
	createdAt: string;
	sourceOs: string;
	reason: BackupReason;
	label?: string;
	counts: BackupCounts;
	fileChecksums: Record<string, string>;
}

function sha256Hex(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function isSecretName(name: string): boolean {
	const lower = name.toLowerCase();
	if (lower === "auth.json") return true;
	if (lower === "user-auth.json" || lower.startsWith("user-auth.json.")) return true;
	if (lower.endsWith("-credentials.json") || /-credentials\.json\./.test(lower)) return true;
	if (lower === ".env" || lower.startsWith(".env.")) return true;
	return false;
}

function isAllowedDataRelativePath(relPath: string): boolean {
	if (!isValidBundleRelativePath(relPath)) return false;
	const parts = relPath.split("/");
	if (parts.some((p) => isSecretName(p))) return false;
	const top = parts[0]!;
	if (top === BACKUPS_SUBDIR || top === "debug") return false;
	if (parts.length === 1) return MANAGED_TOP_FILES.has(top);
	return MANAGED_TOP_DIRS.has(top);
}

function emptyCounts(): BackupCounts {
	return {
		chats: 0,
		attachments: 0,
		graphNodes: 0,
		graphChains: 0,
		jobs: 0,
		prompts: 0,
		themes: 0,
		flashcards: 0,
	};
}

function countJsonlLines(bytes: Buffer | undefined): number {
	if (!bytes) return 0;
	let count = 0;
	for (const line of bytes.toString("utf8").split(/\r?\n/)) {
		if (line.trim().length > 0) count++;
	}
	return count;
}

function countFlashcardsJson(bytes: Buffer | undefined): number {
	if (!bytes) return 0;
	try {
		const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
		if (Array.isArray(parsed)) return parsed.length;
		if (parsed && typeof parsed === "object") {
			const rec = parsed as Record<string, unknown>;
			// Official Flashcards core-plugin v1 store: { version: 1, decks: [...], propositions: { [id]: { cues: [...] } } }
			if (rec.propositions && typeof rec.propositions === "object" && !Array.isArray(rec.propositions)) {
				let totalCues = 0;
				const props = Object.values(rec.propositions as Record<string, unknown>);
				for (const p of props) {
					if (p && typeof p === "object" && Array.isArray((p as Record<string, unknown>).cues)) {
						const cues = (p as { cues: Array<{ deleted?: boolean }> }).cues;
						totalCues += cues.filter((c) => c && !c.deleted).length;
					}
				}
				return totalCues > 0 ? totalCues : props.length;
			}
			if (Array.isArray(rec.cards)) return rec.cards.length;
			if (rec.cards && typeof rec.cards === "object") return Object.keys(rec.cards).length;
		}
	} catch {
		/* ignore malformed flashcards file */
	}
	return 0;
}

function computeCountsFromEntries(entries: readonly TarEntry[]): BackupCounts {
	const counts = emptyCounts();
	const seenAttachmentIds = new Set<string>();
	for (const entry of entries) {
		const p = entry.path;
		if (p.startsWith("chats/") && p.endsWith(".json")) counts.chats++;
		else if (p.startsWith("jobs/") && p.endsWith(".json")) counts.jobs++;
		else if (p.startsWith("prompts/") && p.endsWith(".md")) counts.prompts++;
		else if (p.startsWith("themes/") && p.endsWith(".json")) counts.themes++;
		else if (p === "graph/nodes.jsonl") counts.graphNodes = countJsonlLines(entry.bytes);
		else if (p === "graph/chains.jsonl") counts.graphChains = countJsonlLines(entry.bytes);
		else if (p === "core-plugin-data/flashcards/flashcards.json") counts.flashcards = countFlashcardsJson(entry.bytes);
		else if (p.startsWith("attachments/")) {
			const parts = p.split("/");
			if (parts.length === 3 && isAttachmentSha256(parts[1]!)) {
				seenAttachmentIds.add(parts[1]!);
			}
		}
	}
	counts.attachments = seenAttachmentIds.size;
	return counts;
}

/** Collect all allowed managed files under `dataDir` strictly read-only, skipping symlinks & secrets. */
export function collectManagedDataEntries(dataDir: string): TarEntry[] {
	const resolved = path.resolve(/* turbopackIgnore: true */ dataDir);
	if (!fs.existsSync(/* turbopackIgnore: true */ resolved)) return [];
	const entries: TarEntry[] = [];

	const walk = (absDir: string, relPrefix: string): void => {
		let dirents: fs.Dirent[];
		try {
			dirents = fs.readdirSync(/* turbopackIgnore: true */ absDir, { withFileTypes: true });
		} catch {
			return;
		}
		dirents.sort((a, b) => a.name.localeCompare(b.name));
		for (const d of dirents) {
			if (d.isSymbolicLink()) continue;
			if (isSecretName(d.name)) continue;
			const rel = relPrefix ? `${relPrefix}/${d.name}` : d.name;
			const abs = path.join(/* turbopackIgnore: true */ absDir, d.name);
			if (d.isDirectory()) {
				if (!relPrefix && !MANAGED_TOP_DIRS.has(d.name)) continue;
				walk(abs, rel);
			} else if (d.isFile()) {
				if (!isAllowedDataRelativePath(rel)) continue;
				// Skip cached PDF extractions so backups stay lean and self-regenerating
				if (rel.startsWith("attachments/") && rel.endsWith(".extracted.json")) continue;
				try {
					const stat = fs.lstatSync(/* turbopackIgnore: true */ abs);
					if (stat.isSymbolicLink() || !stat.isFile()) continue;
					entries.push({
						path: rel,
						bytes: fs.readFileSync(/* turbopackIgnore: true */ abs),
						mtimeMs: stat.mtimeMs,
					});
				} catch {
					/* skip unreadable file */
				}
			}
		}
	};

	walk(resolved, "");
	return entries;
}

/** Fast read-only summary counts of a LearnHarness data directory. */
export function inspectDataDirCounts(dataDir: string = resolveDataDir()): BackupCounts {
	const entries = collectManagedDataEntries(dataDir);
	return computeCountsFromEntries(entries);
}

function backupsDirFor(dataDir: string): string {
	return path.join(/* turbopackIgnore: true */ path.resolve(dataDir), BACKUPS_SUBDIR);
}

function makeBackupId(reason: BackupReason, now: Date): string {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
	const suffix = randomBytes(3).toString("hex");
	return `${reason}_${stamp}_${suffix}`;
}

function pruneOldBackups(dir: string): void {
	const metas = listBackupSnapshotsInDir(dir);
	if (metas.length <= MAX_STORED_BACKUPS) return;
	// Prefer pruning oldest auto snapshots first, then oldest manual snapshots
	const sortedOldest = [...metas].reverse();
	const autoFirst = [
		...sortedOldest.filter((m) => m.reason !== "manual"),
		...sortedOldest.filter((m) => m.reason === "manual"),
	];
	let excess = metas.length - MAX_STORED_BACKUPS;
	for (const item of autoFirst) {
		if (excess <= 0) break;
		try {
			fs.rmSync(/* turbopackIgnore: true */ path.join(dir, `${item.id}.tar.gz`), { force: true });
			fs.rmSync(/* turbopackIgnore: true */ path.join(dir, `${item.id}.meta.json`), { force: true });
			excess--;
		} catch {
			/* best-effort prune */
		}
	}
}

function listBackupSnapshotsInDir(dir: string): BackupSnapshotMeta[] {
	if (!fs.existsSync(/* turbopackIgnore: true */ dir)) return [];
	const items: BackupSnapshotMeta[] = [];
	let files: fs.Dirent[];
	try {
		files = fs.readdirSync(/* turbopackIgnore: true */ dir, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const d of files) {
		if (!d.isFile() || !d.name.endsWith(".meta.json")) continue;
		const id = d.name.slice(0, -".meta.json".length);
		if (!isValidBackupId(id)) continue;
		const archivePath = path.join(/* turbopackIgnore: true */ dir, `${id}.tar.gz`);
		if (!fs.existsSync(/* turbopackIgnore: true */ archivePath)) continue;
		try {
			const parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ path.join(dir, d.name), "utf8")) as BackupSnapshotMeta;
			if (parsed && parsed.id === id && typeof parsed.createdAt === "string") {
				items.push(parsed);
			}
		} catch {
			/* ignore corrupt metadata */
		}
	}
	items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
	return items;
}

export function listBackupSnapshots(dataDir: string = resolveDataDir()): BackupSnapshotMeta[] {
	return listBackupSnapshotsInDir(backupsDirFor(dataDir));
}

export function createBackupSnapshot(options: {
	dataDir?: string;
	reason: BackupReason;
	label?: string;
	now?: Date;
}): BackupSnapshotMeta {
	const dataDir = options.dataDir ?? resolveDataDir();
	const now = options.now ?? new Date();
	const id = makeBackupId(options.reason, now);
	const entries = collectManagedDataEntries(dataDir);
	const counts = computeCountsFromEntries(entries);
	const fileChecksums: Record<string, string> = {};
	for (const entry of entries) {
		fileChecksums[entry.path] = sha256Hex(entry.bytes);
	}
	const manifest: BackupArchiveManifest = {
		formatVersion: BACKUP_ARCHIVE_FORMAT_VERSION,
		createdAt: now.toISOString(),
		sourceOs: process.platform,
		reason: options.reason,
		...(options.label ? { label: options.label } : {}),
		counts,
		fileChecksums,
	};
	const archiveEntries: TarEntry[] = [
		{
			path: MANIFEST_FILENAME,
			bytes: Buffer.from(`${JSON.stringify(manifest, null, "\t")}\n`, "utf8"),
			mtimeMs: now.getTime(),
		},
		...entries,
	];
	const gzBytes = packTarGz(archiveEntries);
	const dir = backupsDirFor(dataDir);
	fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 });

	const meta: BackupSnapshotMeta = {
		id,
		createdAt: now.toISOString(),
		reason: options.reason,
		...(options.label ? { label: options.label } : {}),
		sizeBytes: gzBytes.byteLength,
		counts,
		fileCount: entries.length,
	};

	const archivePath = path.join(/* turbopackIgnore: true */ dir, `${id}.tar.gz`);
	const metaPath = path.join(/* turbopackIgnore: true */ dir, `${id}.meta.json`);
	writeBytesAtomicSync(archivePath, gzBytes, 0o600);
	writeFileAtomicSync(metaPath, `${JSON.stringify(meta, null, "\t")}\n`, { allowInPlaceFallback: true, mode: 0o600 });
	pruneOldBackups(dir);
	return meta;
}

export function readBackupArchive(id: string, dataDir: string = resolveDataDir()): { meta: BackupSnapshotMeta; bytes: Buffer } | null {
	if (!isValidBackupId(id)) return null;
	const dir = backupsDirFor(dataDir);
	const archivePath = path.join(/* turbopackIgnore: true */ dir, `${id}.tar.gz`);
	const metaPath = path.join(/* turbopackIgnore: true */ dir, `${id}.meta.json`);
	if (!fs.existsSync(/* turbopackIgnore: true */ archivePath) || !fs.existsSync(/* turbopackIgnore: true */ metaPath)) {
		return null;
	}
	try {
		const meta = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ metaPath, "utf8")) as BackupSnapshotMeta;
		const bytes = fs.readFileSync(/* turbopackIgnore: true */ archivePath);
		return { meta, bytes };
	} catch {
		return null;
	}
}

export function deleteBackupSnapshot(id: string, dataDir: string = resolveDataDir()): boolean {
	if (!isValidBackupId(id)) return false;
	const dir = backupsDirFor(dataDir);
	const archivePath = path.join(/* turbopackIgnore: true */ dir, `${id}.tar.gz`);
	const metaPath = path.join(/* turbopackIgnore: true */ dir, `${id}.meta.json`);
	if (!fs.existsSync(/* turbopackIgnore: true */ archivePath) && !fs.existsSync(/* turbopackIgnore: true */ metaPath)) {
		return false;
	}
	fs.rmSync(/* turbopackIgnore: true */ archivePath, { force: true });
	fs.rmSync(/* turbopackIgnore: true */ metaPath, { force: true });
	return true;
}

function validateAndSplitArchiveEntries(rawEntries: readonly TarEntry[]): {
	dataEntries: TarEntry[];
	warnings: string[];
} {
	const warnings: string[] = [];
	let manifest: BackupArchiveManifest | null = null;
	const dataEntries: TarEntry[] = [];
	const byPath = new Map<string, TarEntry>();

	for (const entry of rawEntries) {
		if (entry.path === MANIFEST_FILENAME) {
			try {
				manifest = JSON.parse(entry.bytes.toString("utf8")) as BackupArchiveManifest;
			} catch {
				throw new Error("Backup archive has an unreadable backup-manifest.json.");
			}
			continue;
		}
		if (!isAllowedDataRelativePath(entry.path)) {
			warnings.push(`Skipped disallowed entry: ${entry.path}`);
			continue;
		}
		dataEntries.push(entry);
		byPath.set(entry.path, entry);
	}

	if (manifest) {
		if (manifest.formatVersion !== BACKUP_ARCHIVE_FORMAT_VERSION) {
			throw new Error(`Unsupported backup archive format version: ${String(manifest.formatVersion)}`);
		}
		if (manifest.fileChecksums && typeof manifest.fileChecksums === "object") {
			for (const [relPath, expectedHash] of Object.entries(manifest.fileChecksums)) {
				const found = byPath.get(relPath);
				if (!found) {
					throw new Error(`Backup archive integrity error: missing file ${relPath}`);
				}
				const actual = sha256Hex(found.bytes);
				if (actual !== expectedHash) {
					throw new Error(`Backup archive integrity error: checksum mismatch for ${relPath}`);
				}
			}
		}
	}

	return { dataEntries, warnings };
}

function mergeFlashcardsJson(existingBytes: Buffer | null, incomingBytes: Buffer): { mergedText: string; addedOrUpdated: number } {
	if (!existingBytes) {
		return {
			mergedText: incomingBytes.toString("utf8"),
			addedOrUpdated: countFlashcardsJson(incomingBytes),
		};
	}
	try {
		const existing = JSON.parse(existingBytes.toString("utf8")) as Record<string, unknown>;
		const incoming = JSON.parse(incomingBytes.toString("utf8")) as Record<string, unknown>;

		// Official Flashcards core-plugin v1 store: { version: 1, revision, settings, decks, propositions, reviews, batches, fileSources, creationReceipts }
		if (
			existing.version === 1 &&
			incoming.version === 1 &&
			existing.propositions &&
			typeof existing.propositions === "object" &&
			incoming.propositions &&
			typeof incoming.propositions === "object" &&
			Array.isArray(existing.decks) &&
			Array.isArray(incoming.decks)
		) {
			const mergedProps: Record<string, Record<string, unknown>> = {
				...(existing.propositions as Record<string, Record<string, unknown>>),
			};
			let addedOrUpdated = 0;
			const activeCueCount = (p: Record<string, unknown>): number =>
				Array.isArray(p.cues)
					? Math.max(1, (p.cues as Array<{ deleted?: boolean }>).filter((c) => c && !c.deleted).length)
					: 1;

			for (const [id, rawInc] of Object.entries(incoming.propositions as Record<string, Record<string, unknown>>)) {
				if (!rawInc || typeof rawInc !== "object") continue;
				const prev = mergedProps[id];
				if (!prev) {
					mergedProps[id] = rawInc;
					addedOrUpdated += activeCueCount(rawInc);
				} else {
					const prevVer = typeof prev.version === "number" ? prev.version : 0;
					const incVer = typeof rawInc.version === "number" ? rawInc.version : 0;
					const prevCues = Array.isArray(prev.cues) ? (prev.cues as Array<Record<string, unknown>>) : [];
					const incCues = Array.isArray(rawInc.cues) ? (rawInc.cues as Array<Record<string, unknown>>) : [];
					if (incVer > prevVer) {
						mergedProps[id] = rawInc;
						addedOrUpdated += activeCueCount(rawInc);
					} else {
						const prevCueIds = new Set(prevCues.map((c) => String(c.id ?? "")));
						const extraCues = incCues.filter((c) => !c.deleted && typeof c.id === "string" && !prevCueIds.has(c.id));
						if (extraCues.length > 0) {
							mergedProps[id] = {
								...prev,
								version: Math.max(prevVer, incVer) + 1,
								cues: [...prevCues, ...extraCues],
							};
							addedOrUpdated += extraCues.length;
						}
					}
				}
			}

			// Merge decks by id, unioning propositionIds
			const mergedDecks: Array<Record<string, unknown> & { propositionIds: string[] }> = (
				existing.decks as Array<Record<string, unknown>>
			).map((d) => ({
				...d,
				propositionIds: Array.isArray(d.propositionIds) ? [...(d.propositionIds as string[])] : [],
			}));
			const deckById = new Map<string, Record<string, unknown> & { propositionIds: string[] }>(
				mergedDecks.map((d) => [String(d.id ?? ""), d]),
			);
			for (const rawDeck of incoming.decks as Array<Record<string, unknown>>) {
				if (!rawDeck || typeof rawDeck !== "object" || typeof rawDeck.id !== "string") continue;
				const existingDeck = deckById.get(rawDeck.id);
				const incPropIds = Array.isArray(rawDeck.propositionIds) ? (rawDeck.propositionIds as string[]) : [];
				if (!existingDeck) {
					const copy = { ...rawDeck, propositionIds: [...incPropIds] };
					mergedDecks.push(copy);
					deckById.set(rawDeck.id, copy);
				} else {
					const seen = new Set(existingDeck.propositionIds);
					for (const pid of incPropIds) {
						if (!seen.has(pid)) {
							existingDeck.propositionIds.push(pid);
							seen.add(pid);
						}
					}
				}
			}

			// Merge reviews & batches deduplicating by id/timestamp key
			const reviewKey = (r: Record<string, unknown>) =>
				typeof r.id === "string" ? r.id : `${String(r.at ?? "")}:${String(r.propositionId ?? "")}:${String(r.cueId ?? "")}`;
			const existingReviews = Array.isArray(existing.reviews) ? (existing.reviews as Array<Record<string, unknown>>) : [];
			const incomingReviews = Array.isArray(incoming.reviews) ? (incoming.reviews as Array<Record<string, unknown>>) : [];
			const seenReviews = new Set(existingReviews.map(reviewKey));
			const mergedReviews = [...existingReviews];
			for (const r of incomingReviews) {
				if (!r || typeof r !== "object") continue;
				const key = reviewKey(r);
				if (!seenReviews.has(key)) {
					seenReviews.add(key);
					mergedReviews.push(r);
				}
			}

			const existingBatches = Array.isArray(existing.batches) ? (existing.batches as Array<Record<string, unknown>>) : [];
			const incomingBatches = Array.isArray(incoming.batches) ? (incoming.batches as Array<Record<string, unknown>>) : [];
			const seenBatches = new Set(existingBatches.map((b) => String(b.id ?? "")));
			const mergedBatches = [...existingBatches];
			for (const b of incomingBatches) {
				if (!b || typeof b !== "object" || typeof b.id !== "string") continue;
				if (!seenBatches.has(b.id)) {
					seenBatches.add(b.id);
					mergedBatches.push(b);
				}
			}

			const mergedFileSources = {
				...((incoming.fileSources && typeof incoming.fileSources === "object") ? (incoming.fileSources as Record<string, unknown>) : {}),
				...((existing.fileSources && typeof existing.fileSources === "object") ? (existing.fileSources as Record<string, unknown>) : {}),
			};
			const existingRev = typeof existing.revision === "number" ? existing.revision : 0;
			const incomingRev = typeof incoming.revision === "number" ? incoming.revision : 0;
			const merged = {
				...existing,
				revision: Math.max(existingRev, incomingRev) + (addedOrUpdated > 0 ? 1 : 0),
				decks: mergedDecks,
				propositions: mergedProps,
				reviews: mergedReviews,
				batches: mergedBatches,
				...(Object.keys(mergedFileSources).length > 0 ? { fileSources: mergedFileSources } : {}),
			};
			return { mergedText: JSON.stringify(merged), addedOrUpdated };
		}

		// Legacy / simple { cards: [...] } shape fallback
		if (Array.isArray(existing.cards) && Array.isArray(incoming.cards)) {
			const byId = new Map<string, Record<string, unknown>>();
			const order: string[] = [];
			for (const c of existing.cards) {
				if (c && typeof c === "object" && typeof (c as Record<string, unknown>).id === "string") {
					const id = (c as Record<string, unknown>).id as string;
					byId.set(id, c as Record<string, unknown>);
					order.push(id);
				}
			}
			let addedOrUpdated = 0;
			for (const c of incoming.cards) {
				if (!c || typeof c !== "object" || typeof (c as Record<string, unknown>).id !== "string") continue;
				const card = c as Record<string, unknown>;
				const id = card.id as string;
				const prev = byId.get(id);
				if (!prev) {
					byId.set(id, card);
					order.push(id);
					addedOrUpdated++;
				} else {
					const prevAt = Date.parse(String(prev.updatedAt ?? prev.lastReviewedAt ?? prev.createdAt ?? ""));
					const nextAt = Date.parse(String(card.updatedAt ?? card.lastReviewedAt ?? card.createdAt ?? ""));
					if (Number.isFinite(nextAt) && (!Number.isFinite(prevAt) || nextAt > prevAt)) {
						byId.set(id, card);
						addedOrUpdated++;
					}
				}
			}
			const merged = { ...existing, cards: order.map((id) => byId.get(id)!) };
			return { mergedText: `${JSON.stringify(merged, null, "\t")}\n`, addedOrUpdated };
		}
	} catch {
		/* fall through */
	}
	return { mergedText: existingBytes.toString("utf8"), addedOrUpdated: 0 };
}

function writeTempMigrationBundle(dataEntries: readonly TarEntry[], nowIso: string): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-backup-merge-"));
	const fileChecksums: Record<string, string> = {};
	const attachments: MigrationBundleAttachmentEntry[] = [];
	const byPath = new Map<string, TarEntry>();
	for (const entry of dataEntries) byPath.set(entry.path, entry);

	for (const entry of dataEntries) {
		// core-plugin-data & plugins-state are handled separately alongside importProfile
		if (entry.path.startsWith("core-plugin-data/") || entry.path === "plugins-state.json") continue;
		const dest = path.join(/* turbopackIgnore: true */ tmpDir, ...entry.path.split("/"));
		fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(dest), { recursive: true });
		fs.writeFileSync(/* turbopackIgnore: true */ dest, entry.bytes);
		fileChecksums[entry.path] = sha256Hex(entry.bytes);

		if (entry.path.startsWith("attachments/") && entry.path.endsWith(".meta.json")) {
			const id = entry.path.slice("attachments/".length, -".meta.json".length);
			if (!isAttachmentSha256(id)) continue;
			try {
				const meta = parseAttachmentMetaRecord(JSON.parse(entry.bytes.toString("utf8")));
				const binRel = `attachments/${id}/${meta.filename}`;
				if (byPath.has(binRel)) {
					attachments.push({
						id: meta.id,
						filename: meta.filename,
						mimeType: meta.mimeType,
						sizeBytes: meta.sizeBytes,
						createdAt: meta.createdAt,
						bundlePath: binRel,
						metaBundlePath: entry.path,
						origins: [],
					});
				}
			} catch {
				/* ignore malformed attachment meta */
			}
		}
	}

	const counts = computeCountsFromEntries(dataEntries);
	const manifest: MigrationBundleManifest = {
		formatVersion: MIGRATION_BUNDLE_FORMAT_VERSION,
		exportedAt: nowIso,
		sourceOs: process.platform,
		counts: {
			chats: counts.chats,
			attachments: attachments.length,
			skippedOrphans: 0,
			graphNodes: counts.graphNodes,
			graphChains: counts.graphChains,
			graphSessions: 0,
			graphCoverage: 0,
			graphSources: 0,
			jobs: counts.jobs,
			prompts: counts.prompts,
			themes: counts.themes,
		},
		legacyLedgers: [],
		attachments,
		fileChecksums,
		diagnostics: [],
	};
	fs.writeFileSync(
		path.join(/* turbopackIgnore: true */ tmpDir, "manifest.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
		"utf8",
	);
	return tmpDir;
}

export function restoreFromEntries(options: {
	entries: readonly TarEntry[];
	targetDir?: string;
	mode: BackupRestoreMode;
	dryRun: boolean;
	safetyReason: BackupReason;
	safetyLabel?: string;
}): BackupImportPreview {
	const targetDir = path.resolve(/* turbopackIgnore: true */ options.targetDir ?? resolveDataDir());
	const { dataEntries, warnings } = validateAndSplitArchiveEntries(options.entries);
	const counts = computeCountsFromEntries(dataEntries);
	const nowIso = new Date().toISOString();

	if (options.mode === "merge") {
		const tmpBundle = writeTempMigrationBundle(dataEntries, nowIso);
		try {
			const planReport = importProfile({
				bundleDir: tmpBundle,
				targetDir,
				dryRun: true,
			});
			if (!planReport.integrity.valid) {
				throw new Error(`Backup verification failed: ${planReport.integrity.errors.join("; ")}`);
			}

			// Preview flashcards / core-plugin-data merges
			let flashcardsRestored = 0;
			const pluginEntries = dataEntries.filter((e) => e.path.startsWith("core-plugin-data/"));
			const fcEntry = pluginEntries.find((e) => e.path === "core-plugin-data/flashcards/flashcards.json");
			if (fcEntry) {
				const existingFcPath = path.join(/* turbopackIgnore: true */ targetDir, "core-plugin-data", "flashcards", "flashcards.json");
				const existingBytes = fs.existsSync(/* turbopackIgnore: true */ existingFcPath)
					? fs.readFileSync(/* turbopackIgnore: true */ existingFcPath)
					: null;
				flashcardsRestored = mergeFlashcardsJson(existingBytes, fcEntry.bytes).addedOrUpdated;
			}

			if (options.dryRun) {
				return {
					dryRun: true,
					mode: "merge",
					counts,
					chatsCreated: planReport.chats.create.length,
					chatsUpdated: planReport.chats.update.length,
					chatsSkipped:
						planReport.chats.skipServerNewer.length +
						planReport.chats.skipUnchanged.length +
						planReport.chats.skipNewerSchema.length,
					attachmentsIngested: planReport.attachments.ingest.length,
					graphNodesAdded: planReport.graph.nodesAdded,
					graphChainsAdded: planReport.graph.chainsAdded,
					flashcardsRestored,
					bytesWritten: 0,
					warnings,
				};
			}

			// Always capture a verified safety snapshot BEFORE writing anything
			const safetyBackup = createBackupSnapshot({
				dataDir: targetDir,
				reason: options.safetyReason,
				label: options.safetyLabel ?? `Before merge (${nowIso})`,
			});

			const applied = importProfile({
				bundleDir: tmpBundle,
				targetDir,
				dryRun: false,
			});
			let extraBytes = 0;

			// Merge core-plugin-data (including Flashcards)
			for (const entry of pluginEntries) {
				const dest = path.join(/* turbopackIgnore: true */ targetDir, ...entry.path.split("/"));
				fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(dest), { recursive: true });
				if (entry.path === "core-plugin-data/flashcards/flashcards.json") {
					const existingBytes = fs.existsSync(/* turbopackIgnore: true */ dest)
						? fs.readFileSync(/* turbopackIgnore: true */ dest)
						: null;
					const { mergedText, addedOrUpdated } = mergeFlashcardsJson(existingBytes, entry.bytes);
					flashcardsRestored = addedOrUpdated;
					if (addedOrUpdated > 0 || !existingBytes) {
						writeFileAtomicSync(dest, mergedText, { allowInPlaceFallback: true });
						extraBytes += Buffer.byteLength(mergedText, "utf8");
					}
				} else if (!fs.existsSync(/* turbopackIgnore: true */ dest)) {
					writeBytesAtomicSync(dest, entry.bytes);
					extraBytes += entry.bytes.byteLength;
				}
			}

			// Merge plugins-state.json (preserve server-enabled plugins, enable incoming enabled plugins)
			const pluginStateEntry = dataEntries.find((e) => e.path === "plugins-state.json");
			if (pluginStateEntry) {
				const dest = path.join(/* turbopackIgnore: true */ targetDir, "plugins-state.json");
				try {
					const incomingState = JSON.parse(pluginStateEntry.bytes.toString("utf8")) as Record<string, unknown>;
					const existingState = fs.existsSync(/* turbopackIgnore: true */ dest)
						? (JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ dest, "utf8")) as Record<string, unknown>)
						: {};
					const mergedState: Record<string, unknown> = { ...incomingState, ...existingState };
					const text = `${JSON.stringify(mergedState, null, "\t")}\n`;
					writeFileAtomicSync(dest, text, { allowInPlaceFallback: true });
					extraBytes += Buffer.byteLength(text, "utf8");
				} catch {
					/* ignore malformed plugins-state.json */
				}
			}

			return {
				dryRun: false,
				mode: "merge",
				safetyBackup,
				counts,
				chatsCreated: applied.chats.create.length,
				chatsUpdated: applied.chats.update.length,
				chatsSkipped:
					applied.chats.skipServerNewer.length +
					applied.chats.skipUnchanged.length +
					applied.chats.skipNewerSchema.length,
				attachmentsIngested: applied.attachments.ingest.length,
				graphNodesAdded: applied.graph.nodesAdded,
				graphChainsAdded: applied.graph.chainsAdded,
				flashcardsRestored,
				bytesWritten: applied.bytesWrittenToTarget + extraBytes,
				warnings,
			};
		} finally {
			fs.rmSync(/* turbopackIgnore: true */ tmpBundle, { recursive: true, force: true });
		}
	}

	// mode === "replace" (full rollback / exact restore of a backup snapshot)
	if (options.dryRun) {
		return {
			dryRun: true,
			mode: "replace",
			counts,
			chatsCreated: counts.chats,
			chatsUpdated: 0,
			chatsSkipped: 0,
			attachmentsIngested: counts.attachments,
			graphNodesAdded: counts.graphNodes,
			graphChainsAdded: counts.graphChains,
			flashcardsRestored: counts.flashcards,
			bytesWritten: 0,
			warnings,
		};
	}

	const safetyBackup = createBackupSnapshot({
		dataDir: targetDir,
		reason: options.safetyReason,
		label: options.safetyLabel ?? `Before replace restore (${nowIso})`,
	});

	fs.mkdirSync(/* turbopackIgnore: true */ targetDir, { recursive: true });
	for (const topDir of MANAGED_TOP_DIRS) {
		fs.rmSync(/* turbopackIgnore: true */ path.join(targetDir, topDir), { recursive: true, force: true });
	}
	for (const topFile of MANAGED_TOP_FILES) {
		fs.rmSync(/* turbopackIgnore: true */ path.join(targetDir, topFile), { force: true });
	}

	let bytesWritten = 0;
	for (const entry of dataEntries) {
		const dest = path.join(/* turbopackIgnore: true */ targetDir, ...entry.path.split("/"));
		fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(dest), { recursive: true });
		if (entry.path === "settings.json" && process.platform !== "win32") {
			try {
				const parsed = sanitizeUserSettings(JSON.parse(entry.bytes.toString("utf8")));
				if (parsed) {
					if (parsed.agent?.fileAccess) {
						const { settings: sanitizedAccess } = sanitizeFileAccessSettingsForPlatform(parsed.agent.fileAccess, process.platform);
						parsed.agent = { ...parsed.agent, fileAccess: sanitizedAccess };
					}
					const text = `${JSON.stringify(parsed, null, "\t")}\n`;
					writeFileAtomicSync(dest, text, { allowInPlaceFallback: true });
					bytesWritten += Buffer.byteLength(text, "utf8");
					continue;
				}
			} catch {
				/* fall through to raw write */
			}
		}
		writeBytesAtomicSync(dest, entry.bytes);
		bytesWritten += entry.bytes.byteLength;
	}

	return {
		dryRun: false,
		mode: "replace",
		safetyBackup,
		counts,
		chatsCreated: counts.chats,
		chatsUpdated: 0,
		chatsSkipped: 0,
		attachmentsIngested: counts.attachments,
		graphNodesAdded: counts.graphNodes,
		graphChainsAdded: counts.graphChains,
		flashcardsRestored: counts.flashcards,
		bytesWritten,
		warnings,
	};
}

export function restoreBackupSnapshot(options: {
	id: string;
	mode?: BackupRestoreMode;
	dryRun?: boolean;
	dataDir?: string;
}): BackupImportPreview {
	const dataDir = options.dataDir ?? resolveDataDir();
	const loaded = readBackupArchive(options.id, dataDir);
	if (!loaded) {
		throw new Error(`Backup snapshot "${options.id}" was not found.`);
	}
	const entries = unpackTarGz(loaded.bytes);
	return restoreFromEntries({
		entries,
		targetDir: dataDir,
		mode: options.mode ?? "replace",
		dryRun: options.dryRun ?? false,
		safetyReason: "pre-restore",
		safetyLabel: `Auto safety backup before restoring ${options.id}`,
	});
}

export function importBackupArchive(options: {
	archiveBytes: Buffer;
	mode?: BackupRestoreMode;
	dryRun?: boolean;
	dataDir?: string;
	reason?: BackupReason;
}): BackupImportPreview {
	const entries = unpackTarGz(options.archiveBytes);
	return restoreFromEntries({
		entries,
		targetDir: options.dataDir ?? resolveDataDir(),
		mode: options.mode ?? "merge",
		dryRun: options.dryRun ?? false,
		safetyReason: options.reason ?? "pre-restore",
		safetyLabel: "Auto safety backup before archive import",
	});
}

export function importChunkedProfile(options: {
	files: ReadonlyArray<{ path: string; contentBase64: string }>;
	mode?: BackupRestoreMode;
	dryRun?: boolean;
	dataDir?: string;
}): BackupImportPreview {
	const entries: TarEntry[] = [];
	for (const file of options.files) {
		if (!file || typeof file.path !== "string" || typeof file.contentBase64 !== "string") {
			throw new Error("Invalid file entry in migration payload.");
		}
		entries.push({
			path: file.path,
			bytes: Buffer.from(file.contentBase64, "base64"),
		});
	}
	return restoreFromEntries({
		entries,
		targetDir: options.dataDir ?? resolveDataDir(),
		mode: options.mode ?? "merge",
		dryRun: options.dryRun ?? false,
		safetyReason: "pre-migration",
		safetyLabel: "Auto safety backup before local-to-server migration",
	});
}
