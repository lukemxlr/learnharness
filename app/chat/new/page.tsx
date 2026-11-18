import { NewSession } from "@/components/new-session";
import { readSettingsRecord } from "@/src/server";
import { slotsConfigured } from "@/src/core";
import { requirePageAuth } from "../../_lib/auth.ts";

export const dynamic = "force-dynamic";

export default async function NewSessionPage({
	searchParams,
}: {
	searchParams: Promise<{ mode?: string }>;
}) {
	const { mode } = await searchParams;
	const nextPath = mode ? `/chat/new?mode=${encodeURIComponent(mode)}` : "/chat/new";
	await requirePageAuth(nextPath);
	return (
		<NewSession
			initialConfigured={slotsConfigured(readSettingsRecord()?.models)}
			mode={mode === "practice" ? "practice" : "teach"}
		/>
	);
}
