/**
 * Backup, Restore, and In-App Migration Contracts (Zone-3 pure, browser-safe).
 */

export type BackupReason = "manual" | "pre-migration" | "pre-restore";
export type BackupRestoreMode = "merge" | "replace";

export interface BackupCounts {
	chats: number;
	attachments: number;
	graphNodes: number;
	graphChains: number;
	jobs: number;
	prompts: number;
	themes: number;
	flashcards: number;
}

export interface BackupSnapshotMeta {
	id: string;
	createdAt: string;
	reason: BackupReason;
	label?: string;
	sizeBytes: number;
	counts: BackupCounts;
	fileCount: number;
}

export interface BackupListResponse {
	current: BackupCounts;
	backups: BackupSnapshotMeta[];
}

export interface BackupImportPreview {
	dryRun: boolean;
	mode: BackupRestoreMode;
	safetyBackup?: BackupSnapshotMeta;
	counts: BackupCounts;
	chatsCreated: number;
	chatsUpdated: number;
	chatsSkipped: number;
	attachmentsIngested: number;
	graphNodesAdded: number;
	graphChainsAdded: number;
	flashcardsRestored: number;
	bytesWritten: number;
	warnings: string[];
}

export interface LocalMigrationSummary {
	hasData: boolean;
	counts: BackupCounts;
}

export interface LocalMigrationResult {
	ok: boolean;
	dryRun?: boolean;
	preview?: BackupImportPreview;
	localBackupPath?: string;
	uploadedAttachments?: number;
	skippedAttachments?: number;
	error?: string;
}

export const BACKUP_ARCHIVE_FORMAT_VERSION = 1 as const;
export const SAFE_BACKUP_ID_RE = /^[A-Za-z0-9_-]{4,80}$/;

export function isValidBackupId(id: unknown): id is string {
	return typeof id === "string" && SAFE_BACKUP_ID_RE.test(id);
}
