"use client";

import { useCallback, useEffect, useState } from "react";
import type { ModelCatalogResponse } from "@/src/core";
import { onSettingsSaved } from "@/components/settings-signal";

// Shared stale-while-revalidate catalog. Metadata refreshes retain the last
// good snapshot; connection changes clear selectable models immediately.
let catalogCache: ModelCatalogResponse | undefined;
let catalogError = false;
let catalogInflight: Promise<void> | undefined;
let catalogGeneration = 0;
let stopCatalogSignals: (() => void) | undefined;
const catalogReaders = new Set<() => void>();
const publishCatalog = () => { for (const reader of catalogReaders) reader(); };

function fetchCatalog(revalidate = false): void {
	if (revalidate) { catalogGeneration++; catalogInflight = undefined; }
	if (catalogInflight) return;
	const generation = catalogGeneration;
	catalogError = false;
	publishCatalog();
	catalogInflight = fetch("/api/models")
		.then((r) => { if (!r.ok) throw new Error(`catalog request failed: ${r.status}`); return r.json() as Promise<ModelCatalogResponse>; })
		.then((c) => {
			if (generation === catalogGeneration) { catalogCache = c; catalogError = false; publishCatalog(); }
		})
		.catch(() => {
			if (generation === catalogGeneration) { catalogError = true; publishCatalog(); }
		})
		.finally(() => { if (generation === catalogGeneration) catalogInflight = undefined; });
}

export function forceRefreshCatalog(provider?: string): Promise<boolean> {
	const generation = ++catalogGeneration;
	catalogInflight = undefined;
	catalogError = false;
	publishCatalog();
	const run = fetch("/api/models/refresh", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(provider ? { provider } : {}),
	})
		.then((r) => {
			if (!r.ok) throw new Error(`catalog refresh failed: ${r.status}`);
			return r.json() as Promise<ModelCatalogResponse>;
		})
		.then((c) => {
			if (generation === catalogGeneration) {
				catalogCache = c;
				catalogError = false;
				publishCatalog();
			}
			return true;
		})
		.catch(() => {
			// Retain last-known-good catalogCache on error.
			if (generation === catalogGeneration) {
				catalogError = true;
				publishCatalog();
			}
			return false;
		})
		.finally(() => {
			if (generation === catalogGeneration) catalogInflight = undefined;
		});
	catalogInflight = run.then(() => undefined);
	return run;
}

export function useModelCatalog(): {
	catalog: ModelCatalogResponse | undefined;
	failed: boolean;
	refresh: () => void;
	forceRefresh: (provider?: string) => Promise<boolean>;
} {
	const [snapshot, setSnapshot] = useState(() => ({ catalog: catalogCache, failed: catalogError }));
	useEffect(() => {
		const first = catalogReaders.size === 0;
		const read = () => setSnapshot({ catalog: catalogCache, failed: catalogError });
		catalogReaders.add(read);
		if (first) {
			stopCatalogSignals = onSettingsSaved((section) => {
				if (section === "keys" || section === "claudeCode") {
					catalogGeneration++; catalogInflight = undefined; catalogCache = undefined;
					fetchCatalog();
				} else if (section === "models") fetchCatalog(true);
			});
			fetchCatalog(true);
		} else fetchCatalog();
		read();
		return () => { catalogReaders.delete(read); if (!catalogReaders.size) { stopCatalogSignals?.(); stopCatalogSignals = undefined; } };
	}, []);
	const refresh = useCallback(() => fetchCatalog(true), []);
	const forceRefresh = useCallback((provider?: string) => forceRefreshCatalog(provider), []);
	return { ...snapshot, refresh, forceRefresh };
}
