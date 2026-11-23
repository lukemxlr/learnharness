import { NextResponse } from "next/server";
import type { BackupRestoreMode } from "@/src/core";
import { importBackupArchive, importChunkedProfile, reloadPluginsAfterDataChange } from "@/src/server";

export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024; // 64 MiB for single-file archive upload

export async function POST(request: Request) {
	const contentType = request.headers.get("content-type") ?? "";
	try {
		if (contentType.includes("multipart/form-data")) {
			const form = await request.formData();
			const file = form.get("file");
			if (!(file instanceof File)) {
				return NextResponse.json({ error: "Missing backup archive file." }, { status: 400 });
			}
			if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
				return NextResponse.json(
					{ error: `Backup archive must be between 1 byte and ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MiB.` },
					{ status: 413 },
				);
			}
			const rawMode = form.get("mode");
			const mode: BackupRestoreMode = rawMode === "replace" ? "replace" : "merge";
			const dryRun = form.get("dryRun") === "true" || form.get("dryRun") === "1";
			const bytes = Buffer.from(await file.arrayBuffer());
			const result = importBackupArchive({ archiveBytes: bytes, mode, dryRun });
			if (!dryRun) await reloadPluginsAfterDataChange();
			return NextResponse.json(result);
		}

		const body = (await request.json()) as {
			files?: Array<{ path: string; contentBase64: string }>;
			mode?: unknown;
			dryRun?: unknown;
		};
		if (!Array.isArray(body?.files)) {
			return NextResponse.json({ error: "Expected multipart backup file or JSON { files: [...] } payload." }, { status: 400 });
		}
		const mode: BackupRestoreMode = body.mode === "replace" ? "replace" : "merge";
		const dryRun = body.dryRun === true;
		const result = importChunkedProfile({ files: body.files, mode, dryRun });
		if (!dryRun) await reloadPluginsAfterDataChange();
		return NextResponse.json(result);
	} catch (err) {
		return NextResponse.json(
			{ error: err instanceof Error ? err.message : "Backup import failed." },
			{ status: 400 },
		);
	}
}
