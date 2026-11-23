"use strict";

/*
 * Setup / Reconnect Preload: exposed ONLY to the isolated local
 * setup.html and remote-reconnect.html BrowserWindow (never to remote origins).
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lhSetup", {
	platform: process.platform,
	getState: () => ipcRenderer.invoke("lh:setup:get-state"),
	saveServerUrl: (rawUrl, opts) => (opts === undefined ? ipcRenderer.invoke("lh:setup:save", rawUrl) : ipcRenderer.invoke("lh:setup:save", rawUrl, opts)),
	useLocalMode: () => ipcRenderer.invoke("lh:setup:use-local"),
	openServerDocs: () => ipcRenderer.invoke("lh:setup:open-docs"),
	reconnect: () => ipcRenderer.invoke("lh:setup:reconnect"),
	openSetup: () => ipcRenderer.invoke("lh:setup:open"),
	cancel: () => ipcRenderer.invoke("lh:setup:cancel"),
});
