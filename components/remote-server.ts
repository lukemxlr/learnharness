"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/** Hydration-safe check for Electron remote-mode server switching (`electron/preload-remote.cjs`). */
export function canChangeRemoteServerUrl(): boolean {
	if (typeof window === "undefined") return false;
	return Boolean(window.lh?.isRemoteMode && typeof window.lh?.changeServerUrl === "function");
}

export function canSwitchFromLocalToServer(): boolean {
	if (typeof window === "undefined") return false;
	return Boolean(window.lh && !window.lh.isRemoteMode && typeof window.lh.changeServerUrl === "function");
}

export function useCanChangeServerUrl(): boolean {
	return useSyncExternalStore(noopSubscribe, canChangeRemoteServerUrl, () => false);
}

export function useCanSwitchFromLocalToServer(): boolean {
	return useSyncExternalStore(noopSubscribe, canSwitchFromLocalToServer, () => false);
}
