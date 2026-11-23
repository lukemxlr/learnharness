import { NextResponse } from "next/server";
import { isValidBackupId, type BackupRestoreMode } from "@/src/core";
import { reloadPluginsAfterDataChange, restoreBackupSnapshot } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
	const { id } = await context.params;
	if (!isValidBackupId(id)) {
		return NextResponse.json({ error: "Invalid backup ID." }, { status: 400 });
	}
	let mode: BackupRestoreMode = "replace";
	let dryRun = false;
	try {
		const body = (await request.json()) as { mode?: unknown; dryRun?: unknown };
		if (body?.mode === "merge" || body?.mode === "replace") mode = body.mode;
		if (typeof body?.dryRun === "boolean") dryRun = body.dryRun;
	} catch {
		/* default replace, apply */
	}
	try {
		const result = restoreBackupSnapshot({ id, mode, dryRun });
		if (!dryRun) await reloadPluginsAfterDataChange();
		return NextResponse.json(result);
	} catch (err) {
		return NextResponse.json(
			{ error: err instanceof Error ? err.message : "Backup restore failed." },
			{ status: 400 },
		);
	}
}
