"use client";

import { FileTextIcon, Loader2Icon, XIcon } from "lucide-react";
import { parseAttachmentRef, type AttachmentRef } from "@/src/core";
import { cn } from "@/lib/utils";

const ATTACHMENT_EXT_RE = /\.(png|jpe?g|webp|gif|pdf)$/i;

export function isSupportedAttachmentFile(file: File): boolean {
	if (file.type.startsWith("image/") || file.type === "application/pdf") return true;
	if (!file.type && ATTACHMENT_EXT_RE.test(file.name)) return true;
	return false;
}

export function extractPastedAttachmentFiles(clipboardData: DataTransfer | null | undefined): File[] {
	if (!clipboardData) return [];
	const files: File[] = [];
	if (clipboardData.files && clipboardData.files.length > 0) {
		for (const file of Array.from(clipboardData.files)) {
			if (isSupportedAttachmentFile(file)) files.push(file);
		}
	}
	if (files.length === 0 && clipboardData.items) {
		for (const item of Array.from(clipboardData.items)) {
			if (item.kind !== "file") continue;
			const file = item.getAsFile?.();
			if (file && (isSupportedAttachmentFile(file) || item.type.startsWith("image/") || item.type === "application/pdf")) {
				files.push(file);
			}
		}
	}
	return files;
}

export function formatAttachmentUploadError(error: unknown): string {
	const raw = error instanceof Error ? error.message.trim() : String(error ?? "").trim();
	if (!raw) return "Upload failed: could not attach file.";
	if (/(failed|error|upload|invalid|unsupported|pdf|transient|limit)/i.test(raw)) return raw;
	return `Upload failed: ${raw}`;
}

export async function uploadAttachmentFile(
	file: File,
	fetchImpl: typeof fetch = globalThis.fetch,
): Promise<AttachmentRef> {
	const form = new FormData();
	form.append("file", file, file.name || "attachment");
	const res = await fetchImpl("/api/attachments", { method: "POST", body: form });
	let body: unknown = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	if (!res.ok) {
		const message =
			body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
				? (body as { error: string }).error
				: `Upload failed (${res.status})`;
		throw new Error(message);
	}
	return parseAttachmentRef(body);
}

export interface StagedAttachmentsProps {
	attachments: readonly AttachmentRef[];
	uploadingCount?: number;
	error?: string | null;
	onRemove?: (id: string, index: number) => void;
	onDismissError?: () => void;
	className?: string;
}

export function StagedAttachments({
	attachments,
	uploadingCount = 0,
	error,
	onRemove,
	onDismissError,
	className,
}: StagedAttachmentsProps) {
	if (attachments.length === 0 && uploadingCount === 0 && !error) return null;
	return (
		<div className={cn("flex flex-col gap-1.5 px-1.5 pt-1 pb-1.5", className)} data-testid="staged-attachments">
			{error && (
				<div
					role="alert"
					data-testid="attachment-upload-error"
					className="flex items-center justify-between gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
				>
					<span className="min-w-0 break-words">{error}</span>
					{onDismissError && (
						<button
							type="button"
							aria-label="Dismiss upload error"
							onClick={onDismissError}
							className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md hover:bg-destructive/15"
						>
							<XIcon className="size-3.5" aria-hidden />
						</button>
					)}
				</div>
			)}
			{(attachments.length > 0 || uploadingCount > 0) && (
				<div className="flex flex-wrap items-center gap-2">
					{attachments.map((att, index) => (
						<div
							key={`${att.id}-${index}`}
							data-testid="staged-attachment-item"
							className="flex max-w-full items-center gap-2 rounded-lg border border-border/80 bg-background/80 pl-2 pr-1 py-1 text-xs"
						>
							{att.kind === "image" ? (
								// eslint-disable-next-line @next/next/no-img-element
								<img
									src={att.url}
									alt={att.filename}
									className="size-10 shrink-0 rounded object-cover"
								/>
							) : (
								<FileTextIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
							)}
							<span className="max-w-[12rem] truncate font-medium text-foreground">{att.filename}</span>
							{onRemove && (
								<button
									type="button"
									aria-label={`Remove ${att.filename}`}
									onClick={() => onRemove(att.id, index)}
									className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
								>
									<XIcon className="size-3.5" aria-hidden />
								</button>
							)}
						</div>
					))}
					{uploadingCount > 0 && (
						<div
							role="status"
							data-testid="attachment-uploading"
							className="flex min-h-11 items-center gap-1.5 rounded-lg border border-border/60 bg-background/60 px-2.5 text-xs text-muted-foreground"
						>
							<Loader2Icon className="size-3.5 animate-spin" aria-hidden />
							<span>Uploading…</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
