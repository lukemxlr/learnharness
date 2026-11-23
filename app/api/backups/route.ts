import { NextResponse } from "next/server";
import { createBackupSnapshot, inspectDataDirCounts, listBackupSnapshots } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		const current = inspectDataDirCounts();
		const backups = listBackupSnapshots();
		return NextResponse.json({ current, backups });
	} catch (err) {
		return NextResponse.json(
			{ error: err instanceof Error ? err.message : "Could not list backups." },
			{ status: 500 },
		);
	}
}

export async function POST(request: Request) {
	try {
		let label: string | undefined;
		try {
			const body = (await request.json()) as { label?: unknown };
			if (typeof body?.label === "string" && body.label.trim().length > 0) {
				label = body.label.trim().slice(0, 120);
			}
		} catch {
			/* optional JSON body */
		}
		const backup = createBackupSnapshot({ reason: "manual", label });
		return NextResponse.json({ backup }, { status: 201 });
	} catch (err) {
		return NextResponse.json(
			{ error: err instanceof Error ? err.message : "Could not create backup." },
			{ status: 500 },
		);
	}
}
