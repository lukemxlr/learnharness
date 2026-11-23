import { NextResponse } from "next/server";
import { isValidBackupId } from "@/src/core";
import { deleteBackupSnapshot, readBackupArchive } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
	const { id } = await context.params;
	if (!isValidBackupId(id)) {
		return NextResponse.json({ error: "Invalid backup ID." }, { status: 400 });
	}
	const loaded = readBackupArchive(id);
	if (!loaded) {
		return NextResponse.json({ error: "Backup not found." }, { status: 404 });
	}
	return new NextResponse(new Uint8Array(loaded.bytes), {
		status: 200,
		headers: {
			"Content-Type": "application/gzip",
			"Content-Disposition": `attachment; filename="learnharness-${id}.tar.gz"`,
			"Content-Length": String(loaded.bytes.byteLength),
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
	const { id } = await context.params;
	if (!isValidBackupId(id)) {
		return NextResponse.json({ error: "Invalid backup ID." }, { status: 400 });
	}
	const deleted = deleteBackupSnapshot(id);
	if (!deleted) {
		return NextResponse.json({ error: "Backup not found." }, { status: 404 });
	}
	return NextResponse.json({ ok: true, id });
}
