import { PluginViewScreen } from "@/components/plugin-view";
import { requirePageAuth } from "../../../_lib/auth.ts";

export const dynamic = "force-dynamic";

export default async function PluginPage({ params }: { params: Promise<{ pluginId: string; viewId: string }> }) {
	const { pluginId, viewId } = await params;
	await requirePageAuth(`/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(viewId)}`);
	return <PluginViewScreen pluginId={pluginId} viewId={viewId} />;
}
