"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DownloadIcon, HardDriveUploadIcon, RotateCcwIcon, ShieldCheckIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "./controls.tsx";
import type {
	BackupCounts,
	BackupImportPreview,
	BackupListResponse,
	BackupRestoreMode,
	BackupSnapshotMeta,
	LocalMigrationResult,
	LocalMigrationSummary,
} from "@/src/core";

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCounts(c?: BackupCounts | null): string {
	if (!c) return "";
	const parts = [`${c.chats ?? 0} chats`, `${c.graphNodes ?? 0} graph nodes`];
	if ((c.attachments ?? 0) > 0) parts.push(`${c.attachments} attachments`);
	if ((c.flashcards ?? 0) > 0) parts.push(`${c.flashcards} flashcards`);
	return parts.join(" · ");
}

function formatReason(reason: BackupSnapshotMeta["reason"]): string {
	if (reason === "pre-migration") return "Auto backup (pre-migration)";
	if (reason === "pre-restore") return "Auto backup (pre-restore)";
	return "Manual backup";
}

function formatTimestamp(iso: string): string {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return iso;
	return new Date(ms).toLocaleString();
}

export function BackupsAndMigrationSection() {
	const [data, setData] = useState<BackupListResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	// File restore state
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [selectedFile, setSelectedFile] = useState<File | null>(null);
	const [restoreMode, setRestoreMode] = useState<BackupRestoreMode>("merge");
	const [filePreview, setFilePreview] = useState<BackupImportPreview | null>(null);

	// Snapshot restore confirmation
	const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);

	// Local-to-server 1-click migration (only in Electron remote mode)
	const [localProfile, setLocalProfile] = useState<LocalMigrationSummary | null>(null);
	const [migrationPreview, setMigrationPreview] = useState<LocalMigrationResult | null>(null);

	const loadBackups = useCallback(async () => {
		try {
			const res = await fetch("/api/backups", { cache: "no-store" });
			if (!res.ok) throw new Error(`Could not load backups (${res.status})`);
			const next = (await res.json()) as Partial<BackupListResponse> | null;
			if (next && next.current && Array.isArray(next.backups)) {
				setData(next as BackupListResponse);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not load backups.");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadBackups();
		if (window.lh?.isRemoteMode && typeof window.lh.inspectLocalProfile === "function") {
			void window.lh.inspectLocalProfile()
				.then((summary) => {
					if (summary?.hasData) setLocalProfile(summary);
				})
				.catch(() => {});
		}
	}, [loadBackups]);

	const handleCreateBackup = async (downloadAfter: boolean) => {
		setBusy("create");
		setError(null);
		setNotice(null);
		try {
			const res = await fetch("/api/backups", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const body = (await res.json()) as { backup?: BackupSnapshotMeta; error?: string };
			if (!res.ok || !body.backup) throw new Error(body.error || "Could not create backup.");
			await loadBackups();
			setNotice(`Backup created (${formatCounts(body.backup.counts)}).`);
			if (downloadAfter) {
				const a = document.createElement("a");
				a.href = `/api/backups/${encodeURIComponent(body.backup.id)}`;
				a.download = `learnharness-${body.backup.id}.tar.gz`;
				document.body.appendChild(a);
				a.click();
				a.remove();
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not create backup.");
		} finally {
			setBusy(null);
		}
	};

	const handleRestoreSnapshot = async (id: string) => {
		setBusy(`restore:${id}`);
		setError(null);
		setNotice(null);
		try {
			const res = await fetch(`/api/backups/${encodeURIComponent(id)}/restore`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode: "replace", dryRun: false }),
			});
			const body = (await res.json()) as BackupImportPreview & { error?: string };
			if (!res.ok) throw new Error(body.error || "Restore failed.");
			setConfirmRestoreId(null);
			await loadBackups();
			setNotice(
				`Restored snapshot (${formatCounts(body.counts)}). An automatic pre-restore safety backup was saved first. Reloading…`,
			);
			setTimeout(() => window.location.reload(), 1200);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Restore failed.");
		} finally {
			setBusy(null);
		}
	};

	const handleDeleteSnapshot = async (id: string) => {
		setBusy(`delete:${id}`);
		setError(null);
		try {
			const res = await fetch(`/api/backups/${encodeURIComponent(id)}`, { method: "DELETE" });
			if (!res.ok) throw new Error("Could not delete backup.");
			if (confirmRestoreId === id) setConfirmRestoreId(null);
			await loadBackups();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not delete backup.");
		} finally {
			setBusy(null);
		}
	};

	const runFileImport = async (file: File, mode: BackupRestoreMode, dryRun: boolean) => {
		setBusy(dryRun ? "preview-file" : "apply-file");
		setError(null);
		setNotice(null);
		try {
			const form = new FormData();
			form.append("file", file);
			form.append("mode", mode);
			form.append("dryRun", dryRun ? "true" : "false");
			const res = await fetch("/api/backups/import", { method: "POST", body: form });
			const body = (await res.json()) as BackupImportPreview & { error?: string };
			if (!res.ok) throw new Error(body.error || "Backup import failed.");
			if (dryRun) {
				setFilePreview(body);
			} else {
				setSelectedFile(null);
				setFilePreview(null);
				await loadBackups();
				setNotice(
					`Backup ${mode === "replace" ? "restored" : "merged"} (${body.chatsCreated} new chats, ${body.chatsUpdated} updated, ${body.graphNodesAdded} graph nodes). Automatic safety backup saved. Reloading…`,
				);
				setTimeout(() => window.location.reload(), 1200);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Backup import failed.");
		} finally {
			setBusy(null);
		}
	};

	const handleFilePicked = async (file: File | null) => {
		setSelectedFile(file);
		setFilePreview(null);
		if (!file) return;
		await runFileImport(file, restoreMode, true);
	};

	const runLocalMigration = async (dryRun: boolean) => {
		if (!window.lh?.migrateLocalProfile) return;
		setBusy(dryRun ? "migrate-preview" : "migrate-apply");
		setError(null);
		setNotice(null);
		try {
			const result = await window.lh.migrateLocalProfile({ dryRun });
			if (!result.ok) {
				setError(result.error || "Local migration failed.");
				return;
			}
			if (dryRun) {
				setMigrationPreview(result);
			} else {
				setMigrationPreview(null);
				await loadBackups();
				const p = result.preview;
				setNotice(
					`Local data migrated (${p?.chatsCreated ?? 0} new chats, ${p?.chatsUpdated ?? 0} updated, ${p?.graphNodesAdded ?? 0} graph nodes, ${result.uploadedAttachments ?? 0} attachments). Automatic safety backups saved locally and on the server. Reloading…`,
				);
				setTimeout(() => window.location.reload(), 1400);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Local migration failed.");
		} finally {
			setBusy(null);
		}
	};

	return (
		<>
			{localProfile?.hasData && (
				<SettingsRow
					label="Migrate local data to server"
					hint={`Found local desktop data on this computer: ${formatCounts(localProfile.counts)}. Your local files stay untouched as a backup, and the server saves an automatic pre-migration snapshot first.`}
					testid="row-local-migration"
				>
					<div className="flex flex-wrap items-center gap-2">
						{!migrationPreview ? (
							<Button
								type="button"
								size="xs"
								variant="outline"
								disabled={busy !== null}
								data-testid="migrate-local-preview-btn"
								className="min-h-11 px-3"
								onClick={() => void runLocalMigration(true)}
							>
								<HardDriveUploadIcon className="mr-1.5 size-3.5" aria-hidden />
								{busy === "migrate-preview" ? "Checking…" : "Preview migration"}
							</Button>
						) : (
							<>
								<Button
									type="button"
									size="xs"
									disabled={busy !== null}
									data-testid="migrate-local-apply-btn"
									className="min-h-11 px-3"
									onClick={() => void runLocalMigration(false)}
								>
									{busy === "migrate-apply" ? "Migrating…" : "Confirm & migrate"}
								</Button>
								<Button
									type="button"
									size="xs"
									variant="outline"
									disabled={busy !== null}
									className="min-h-11 px-3"
									onClick={() => setMigrationPreview(null)}
								>
									Cancel
								</Button>
							</>
						)}
					</div>
				</SettingsRow>
			)}

			{migrationPreview?.preview && (
				<div
					role="status"
					data-testid="migration-preview-summary"
					className="my-2 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-xs text-foreground"
				>
					<div className="font-medium">Migration dry-run preview (0 bytes written yet):</div>
					<div className="mt-1 text-muted-foreground">
						{migrationPreview.preview.chatsCreated} new chats · {migrationPreview.preview.chatsUpdated} updated ·{" "}
						{migrationPreview.preview.chatsSkipped} already up-to-date · {migrationPreview.preview.graphNodesAdded} graph nodes ·{" "}
						{migrationPreview.preview.flashcardsRestored} flashcards
					</div>
				</div>
			)}

			<SettingsRow
				label="Backups & Restore"
				hint={
					data
						? `Current data: ${formatCounts(data.current)}. Backups exclude API keys and login credentials; every restore saves an automatic safety snapshot first.`
						: loading
							? "Loading backup inventory…"
							: "Back up or restore chats, knowledge graph, attachments, and flashcards."
				}
				testid="row-backups"
			>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						size="xs"
						variant="outline"
						disabled={busy !== null}
						data-testid="backup-create-download"
						className="min-h-11 px-3"
						onClick={() => void handleCreateBackup(true)}
					>
						<DownloadIcon className="mr-1.5 size-3.5" aria-hidden />
						{busy === "create" ? "Backing up…" : "Backup & download"}
					</Button>
					<Button
						type="button"
						size="xs"
						variant="outline"
						disabled={busy !== null}
						data-testid="backup-restore-file-btn"
						className="min-h-11 px-3"
						onClick={() => fileInputRef.current?.click()}
					>
						<UploadIcon className="mr-1.5 size-3.5" aria-hidden />
						Restore from file…
					</Button>
					<input
						ref={fileInputRef}
						type="file"
						accept=".tar.gz,.tgz,application/gzip"
						className="hidden"
						onChange={(e) => {
							const f = e.target.files?.[0] ?? null;
							e.target.value = "";
							void handleFilePicked(f);
						}}
					/>
				</div>
			</SettingsRow>

			{error && (
				<div role="alert" data-testid="backup-error" className="my-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
					{error}
				</div>
			)}
			{notice && (
				<div role="status" data-testid="backup-notice" className="my-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-foreground">
					{notice}
				</div>
			)}

			{selectedFile && filePreview && (
				<div data-testid="backup-file-preview" className="my-2 rounded-md border border-border bg-muted/30 p-3 text-xs">
					<div className="font-medium text-foreground">Ready to import: {selectedFile.name}</div>
					<div className="mt-1 text-muted-foreground">
						Archive contains: {formatCounts(filePreview.counts)}
					</div>
					<div className="mt-2 flex flex-wrap items-center gap-3">
						<label className="flex cursor-pointer items-center gap-1.5">
							<input
								type="radio"
								name="backup-restore-mode"
								checked={restoreMode === "merge"}
								onChange={() => {
									setRestoreMode("merge");
									void runFileImport(selectedFile, "merge", true);
								}}
							/>
							<span>Merge safely (keep newer existing chats)</span>
						</label>
						<label className="flex cursor-pointer items-center gap-1.5">
							<input
								type="radio"
								name="backup-restore-mode"
								checked={restoreMode === "replace"}
								onChange={() => {
									setRestoreMode("replace");
									void runFileImport(selectedFile, "replace", true);
								}}
							/>
							<span>Full replace (exact restore)</span>
						</label>
					</div>
					<div className="mt-2.5 flex items-center gap-2">
						<Button
							type="button"
							size="xs"
							disabled={busy !== null}
							data-testid="backup-file-apply"
							className="min-h-11 px-3"
							onClick={() => void runFileImport(selectedFile, restoreMode, false)}
						>
							{busy === "apply-file" ? "Restoring…" : restoreMode === "replace" ? "Replace & restore" : "Merge backup"}
						</Button>
						<Button
							type="button"
							size="xs"
							variant="outline"
							disabled={busy !== null}
							className="min-h-11 px-3"
							onClick={() => {
								setSelectedFile(null);
								setFilePreview(null);
							}}
						>
							Cancel
						</Button>
					</div>
				</div>
			)}

			{data && data.backups.length > 0 && (
				<div data-testid="backup-snapshots-list" className="mt-2 space-y-1.5">
					<div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
						<ShieldCheckIcon className="size-3.5" aria-hidden />
						<span>Saved snapshots ({data.backups.length})</span>
					</div>
					{data.backups.map((snap) => (
						<div
							key={snap.id}
							data-testid="backup-snapshot-row"
							className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 bg-background/60 px-3 py-2 text-xs"
						>
							<div className="min-w-0 flex-1">
								<div className="font-medium text-foreground">
									{formatReason(snap.reason)} · {formatTimestamp(snap.createdAt)}
								</div>
								<div className="text-muted-foreground">
									{formatCounts(snap.counts)} · {formatBytes(snap.sizeBytes)}
								</div>
							</div>
							<div className="flex items-center gap-1.5">
								<a
									href={`/api/backups/${encodeURIComponent(snap.id)}`}
									download={`learnharness-${snap.id}.tar.gz`}
									className="inline-flex min-h-9 items-center rounded-md border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
								>
									<DownloadIcon className="mr-1 size-3" aria-hidden />
									Download
								</a>
								{confirmRestoreId === snap.id ? (
									<>
										<Button
											type="button"
											size="xs"
											disabled={busy !== null}
											data-testid={`backup-confirm-restore-${snap.id}`}
											className="min-h-9 px-2.5"
											onClick={() => void handleRestoreSnapshot(snap.id)}
										>
											{busy === `restore:${snap.id}` ? "Restoring…" : "Confirm restore"}
										</Button>
										<Button
											type="button"
											size="xs"
											variant="outline"
											disabled={busy !== null}
											className="min-h-9 px-2"
											onClick={() => setConfirmRestoreId(null)}
										>
											Cancel
										</Button>
									</>
								) : (
									<Button
										type="button"
										size="xs"
										variant="outline"
										disabled={busy !== null}
										data-testid={`backup-restore-${snap.id}`}
										className="min-h-9 px-2.5"
										onClick={() => setConfirmRestoreId(snap.id)}
									>
										<RotateCcwIcon className="mr-1 size-3" aria-hidden />
										Restore
									</Button>
								)}
								<Button
									type="button"
									size="xs"
									variant="outline"
									aria-label={`Delete backup ${snap.id}`}
									disabled={busy !== null}
									className="min-h-9 px-2 text-muted-foreground hover:text-destructive"
									onClick={() => void handleDeleteSnapshot(snap.id)}
								>
									<Trash2Icon className="size-3.5" aria-hidden />
								</Button>
							</div>
						</div>
					))}
				</div>
			)}
		</>
	);
}
