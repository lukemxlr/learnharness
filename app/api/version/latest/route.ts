import { NextResponse } from "next/server";
import { checkLatestServerRelease } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const result = await checkLatestServerRelease();
	return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
