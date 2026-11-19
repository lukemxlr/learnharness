"use strict";

/*
 * Setup / Reconnect Preload (M3): exposed ONLY to the isolated local
 * setup.html and remote-reconnect.html BrowserWindow (never to remote origins).
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lhSetup", {
	platform: process.platform,
	getState: () => ipcRenderer.invoke("lh:setup:get-state"),
	saveServerUrl: (rawUrl) => ipcRenderer.invoke("lh:setup:save", rawUrl),
	reconnect: () => ipcRenderer.invoke("lh:setup:reconnect"),
	openSetup: () => ipcRenderer.invoke("lh:setup:open"),
	cancel: () => ipcRenderer.invoke("lh:setup:cancel"),
});
