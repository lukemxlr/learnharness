"use client";

import { useEffect, useLayoutEffect, useState } from "react";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface VisualViewportSnapshot {
	width: number;
	height: number;
	offsetTop: number;
	offsetLeft: number;
	scale: number;
	layoutWidth: number;
	layoutHeight: number;
	bottomInset: number;
}

export function readVisualViewport(win?: Window): VisualViewportSnapshot {
	const w = win ?? (typeof window !== "undefined" ? window : undefined);
	if (!w) {
		return {
			width: 0,
			height: 0,
			offsetTop: 0,
			offsetLeft: 0,
			scale: 1,
			layoutWidth: 0,
			layoutHeight: 0,
			bottomInset: 0,
		};
	}
	const layoutWidth = w.innerWidth || 0;
	const layoutHeight = w.innerHeight || 0;
	const vv = w.visualViewport;
	if (!vv || !(vv.width > 0) || !(vv.height > 0)) {
		return {
			width: layoutWidth,
			height: layoutHeight,
			offsetTop: 0,
			offsetLeft: 0,
			scale: 1,
			layoutWidth,
			layoutHeight,
			bottomInset: 0,
		};
	}
	const width = vv.width;
	const height = vv.height;
	const offsetTop = vv.offsetTop ?? 0;
	const offsetLeft = vv.offsetLeft ?? 0;
	const scale = vv.scale ?? 1;
	const bottomInset = Math.max(0, Math.round(layoutHeight - (offsetTop + height)));
	return {
		width,
		height,
		offsetTop,
		offsetLeft,
		scale,
		layoutWidth,
		layoutHeight,
		bottomInset,
	};
}

export function syncVisualViewportVars(doc: Document, snap: VisualViewportSnapshot): void {
	const root = doc.documentElement;
	if (!root?.style) return;
	root.style.setProperty("--lh-vv-width", `${snap.width}px`);
	root.style.setProperty("--lh-vv-height", `${snap.height}px`);
	root.style.setProperty("--lh-vv-top", `${snap.offsetTop}px`);
	root.style.setProperty("--lh-vv-left", `${snap.offsetLeft}px`);
	root.style.setProperty("--lh-vv-bottom-inset", `${snap.bottomInset}px`);
}

export function subscribeVisualViewport(win: Window, onChange: () => void): () => void {
	const vv = win.visualViewport;
	win.addEventListener?.("resize", onChange);
	vv?.addEventListener?.("resize", onChange);
	vv?.addEventListener?.("scroll", onChange);
	return () => {
		win.removeEventListener?.("resize", onChange);
		vv?.removeEventListener?.("resize", onChange);
		vv?.removeEventListener?.("scroll", onChange);
	};
}

export function useVisualViewport(syncRootVars = false): VisualViewportSnapshot {
	const [snapshot, setSnapshot] = useState<VisualViewportSnapshot>(() => readVisualViewport());

	useIsoLayoutEffect(() => {
		if (typeof window === "undefined") return;
		const update = () => {
			const next = readVisualViewport(window);
			if (syncRootVars && typeof document !== "undefined") {
				syncVisualViewportVars(document, next);
			}
			setSnapshot((prev) =>
				prev.width === next.width &&
				prev.height === next.height &&
				prev.offsetTop === next.offsetTop &&
				prev.offsetLeft === next.offsetLeft &&
				prev.scale === next.scale &&
				prev.layoutWidth === next.layoutWidth &&
				prev.layoutHeight === next.layoutHeight &&
				prev.bottomInset === next.bottomInset
					? prev
					: next,
			);
		};
		update();
		return subscribeVisualViewport(window, update);
	}, [syncRootVars]);

	return snapshot;
}
