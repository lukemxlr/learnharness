"use strict";

/*
 * Remote Preload (M3): minimal Electron chrome + server-switch bridge ONLY.
 * Zero local filesystem, attachment folder picker, OAuth/subscription, or
 * auto-updater APIs are exposed to remote origins.
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
	expandWindow: () => ipcRenderer.send("lh:expand-window"),
	setAppearance: (a) => ipcRenderer.send("lh:appearance", a),
	onZoom: (cb) => {
		const listener = (_event, factor) => cb(factor);
		ipcRenderer.on("lh:zoom", listener);
		return () => ipcRenderer.removeListener("lh:zoom", listener);
	},
	getZoom: () => ipcRenderer.invoke("lh:zoom:get"),
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
});
