"use strict";

/*
 * Remote Preload: minimal Electron chrome, server-switch, desktop auto-updater
 * status, and narrow fixed-dir local-to-server migration bridge ONLY.
 * Zero arbitrary local filesystem, attachment folder picker, or OAuth/subscription
 * APIs are exposed to remote origins.
 */
const { contextBridge, ipcRenderer } = require("electron");

let openSettingsListener = null;
let pendingOpenSettings = null;
ipcRenderer.on("lh:open-settings", (_event, section) => {
	if (openSettingsListener) openSettingsListener(section);
	else pendingOpenSettings = section;
});

contextBridge.exposeInMainWorld("lh", {
	isRemoteMode: true,
	platform: process.platform,
	getAppVersion: () => ipcRenderer.invoke("lh:app:version"),
	expandWindow: () => ipcRenderer.send("lh:expand-window"),
	setAppearance: (a) => ipcRenderer.send("lh:appearance", a),
	onZoom: (cb) => {
		const listener = (_event, factor) => cb(factor);
		ipcRenderer.on("lh:zoom", listener);
		return () => ipcRenderer.removeListener("lh:zoom", listener);
	},
	getZoom: () => ipcRenderer.invoke("lh:zoom:get"),
	onUpdateStatus: (cb) => {
		const listener = (_event, status) => cb(status);
		ipcRenderer.on("lh:update-status", listener);
		return () => ipcRenderer.removeListener("lh:update-status", listener);
	},
	installUpdate: () => ipcRenderer.send("lh:update-install"),
	getUpdateState: () => ipcRenderer.invoke("lh:update:get"),
	checkForUpdates: () => ipcRenderer.invoke("lh:update:check"),
	onOpenSettings: (cb) => {
		openSettingsListener = cb;
		if (pendingOpenSettings !== null) {
			const section = pendingOpenSettings;
			pendingOpenSettings = null;
			cb(section);
		}
		return () => {
			if (openSettingsListener === cb) openSettingsListener = null;
		};
	},
	changeServerUrl: () => ipcRenderer.invoke("lh:remote:change-server"),
	inspectLocalProfile: () => ipcRenderer.invoke("lh:remote:inspect-local"),
	migrateLocalProfile: (opts) => ipcRenderer.invoke("lh:remote:migrate-local", opts),
});
