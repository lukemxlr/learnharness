import { redirect } from "next/navigation";
import { requirePageAuth } from "../_lib/auth.ts";

export const dynamic = "force-dynamic";

/**
 * The settings surface graduated into a centered dialog over the app
 * (settings-app wave, 2026-09-20 — owner decision: modal-only, no page).
 * The URL stays routed but redirects: nothing should land on a dead
 * page; the dialog opens via the sidebar row or mod+,.
 */
export default async function SettingsPage() {
	await requirePageAuth("/settings");
	redirect("/chat/new");
}
