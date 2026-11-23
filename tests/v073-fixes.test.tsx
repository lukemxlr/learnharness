import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { syncDockHeight } from "../components/dock-height.ts";
import { fitGraphView, fitZoomFor, pinchGraphView, ZOOM_MAX } from "../components/pan-zoom.ts";
import { UpdateSettings } from "../components/settings/update-settings.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { installModalDom } from "./modal-dom.ts";
import {
	checkLatestServerRelease,
	githubRepoSlugFromHomepage,
	isNewerSemver,
	parseSemverTriplet,
	resetServerUpdateCacheForTest,
} from "../src/server/version-check.ts";
import manifest from "../app/manifest.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	getComputedStyle: () => ({
		paddingTop: "0px",
		paddingBottom: "0px",
		borderTopWidth: "1px",
		borderBottomWidth: "1px",
		lineHeight: "24px",
		fontSize: "16px",
	}),
});
const restoreModalDom = installModalDom(dom);
after(restoreModalDom);

const originalFetch = globalThis.fetch;
const roots: { root: Root; host: HTMLElement }[] = [];

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => { root.unmount(); });
		host.remove();
	}
	await new Promise((r) => setTimeout(r, 5));
	delete window.lh;
	globalThis.fetch = originalFetch;
	resetServerUpdateCacheForTest();
});

async function mount(element: React.ReactElement) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => {
		root.render(<InteractionLayersProvider>{element}</InteractionLayersProvider>);
	});
	return host;
}

describe("v0.7.3 iPadOS visualViewport dock-height fix", () => {
	it("does not collapse dock viewport to 0px when iPadOS Safari pans visualViewport.offsetTop > 0", () => {
		const prevVv = Object.getOwnPropertyDescriptor(dom.window, "visualViewport");
		Object.defineProperty(dom.window, "visualViewport", {
			configurable: true,
			value: { width: 1024, height: 368, offsetTop: 380, offsetLeft: 0, scale: 1 },
		});
		try {
			const makeEl = (rect: Partial<DOMRect>, clientHeight = 0): HTMLElement => {
				const el = document.createElement("div");
				Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
				el.getBoundingClientRect = () =>
					({
						top: rect.top ?? 0,
						bottom: rect.bottom ?? (rect.height ?? 0),
						left: 0,
						right: 800,
						width: 800,
						height: rect.height ?? 0,
						x: 0,
						y: rect.top ?? 0,
						toJSON: () => ({}),
					}) as DOMRect;
				return el;
			};

			// Exact iPadOS landscape keyboard geometry: colRect shifted by -380 in visual coords
			const column = makeEl({ top: -332, bottom: 388, height: 720 }, 720);
			const block = makeEl({ height: 420 });
			const viewport = makeEl({ height: 360 });
			const body = makeEl({ height: 360 });
			const shell = makeEl({ height: 360 });
			const content = makeEl({ height: 358 });
			const question = makeEl({ height: 180 });
			question.setAttribute("data-dock-scroll-area", "");
			content.appendChild(question);

			const budget = syncDockHeight({ column, block, viewport, body, shell, content }, true);
			assert.ok(budget.viewportMaxHeight >= 240, `expected usable viewportMaxHeight >= 240px, got ${budget.viewportMaxHeight}`);
			assert.equal(viewport.style.maxHeight, `${budget.viewportMaxHeight}px`);
		} finally {
			if (prevVv) Object.defineProperty(dom.window, "visualViewport", prevVv);
			else Reflect.deleteProperty(dom.window, "visualViewport");
		}
	});
});

describe("v0.7.3 2-finger pinch-zoom + pan math (pan-zoom.ts)", () => {
	it("zooms in smoothly from fitZoom around the midpoint, pans simultaneously, and re-centers at floor", () => {
		const box = { w: 800, h: 600 };
		const viewport = { w: 400, h: 300 };
		const floor = fitZoomFor(box, viewport);
		const initial = fitGraphView(box, viewport, floor);

		// Spread two fingers apart 2x around center (200, 150) while shifting midpoint +20px right
		const zoomed = pinchGraphView(
			initial,
			{ x: 150, y: 150 },
			{ x: 250, y: 150 },
			{ x: 120, y: 150 },
			{ x: 320, y: 150 },
			floor,
			box,
			viewport,
		);
		assert.ok(Math.abs(zoomed.zoom - floor * 2) < 1e-6);
		// Content point at (200, 150) should now map to new midpoint (220, 150)
		const contentX = (200 - initial.x) / initial.zoom;
		assert.ok(Math.abs(zoomed.x + contentX * zoomed.zoom - 220) < 1e-6);

		// Clamps at ZOOM_MAX
		const maxed = pinchGraphView(
			zoomed,
			{ x: 199, y: 150 },
			{ x: 201, y: 150 },
			{ x: 0, y: 150 },
			{ x: 400, y: 150 },
			floor,
			box,
			viewport,
		);
		assert.equal(maxed.zoom, ZOOM_MAX);

		// Pinching back below floor re-centers cleanly to fitGraphView
		const floored = pinchGraphView(
			zoomed,
			{ x: 100, y: 150 },
			{ x: 300, y: 150 },
			{ x: 195, y: 150 },
			{ x: 205, y: 150 },
			floor,
			box,
			viewport,
		);
		assert.deepEqual(floored, initial);
	});
});

describe("v0.7.3 server version-check, split desktop/server version UI, remote auto-update & PWA manifest", () => {
	it("parses semver, compares strictly, extracts GitHub slug, and handles checkLatestServerRelease cleanly", async () => {
		assert.deepEqual(parseSemverTriplet("v0.7.3"), [0, 7, 3]);
		assert.equal(isNewerSemver("0.7.4", "0.7.3"), true);
		assert.equal(isNewerSemver("0.7.3", "0.7.3"), false);
		assert.equal(isNewerSemver("0.7.2", "0.7.3"), false);
		assert.equal(githubRepoSlugFromHomepage("https://github.com/lukemxlr/learnharness"), "lukemxlr/learnharness");
		assert.equal(githubRepoSlugFromHomepage("https://example.com/a/b"), null);

		const newer = await checkLatestServerRelease({
			currentVersion: "0.7.2",
			homepage: "https://github.com/lukemxlr/learnharness",
			fetchImpl: (async () =>
				Response.json({
					tag_name: "v0.7.3",
					html_url: "https://github.com/lukemxlr/learnharness/releases/tag/v0.7.3",
					draft: false,
					prerelease: false,
				})) as unknown as typeof fetch,
		});
		assert.equal(newer.updateAvailable, true);
		assert.equal(newer.latestVersion, "0.7.3");

		// Fails open on network error
		const offline = await checkLatestServerRelease({
			currentVersion: "0.7.3",
			homepage: "https://github.com/lukemxlr/learnharness",
			fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch,
		});
		assert.equal(offline.updateAvailable, false);
		assert.equal(offline.latestVersion, null);
	});

	it("shows separate Desktop app and Server versions in remote mode, checks server update on demand, and routes auto-update toggle to Electron", async () => {
		let storedAutoUpdate = true;
		let desktopChecks = 0;
		let serverVersionChecks = 0;
		window.lh = {
			isRemoteMode: true,
			expandWindow() {},
			getAppVersion: async () => "0.7.3",
			getAutoUpdate: async () => storedAutoUpdate,
			setAutoUpdate: async (on: boolean) => { storedAutoUpdate = on; return on; },
			getUpdateState: async () => ({ status: "idle", version: null, revision: 0 }),
			onUpdateStatus: () => () => {},
			checkForUpdates: async () => { desktopChecks++; },
			installUpdate: () => {},
			changeServerUrl: async () => ({ ok: true }),
		};
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			if (String(input) === "/api/version/latest") {
				serverVersionChecks++;
				return Response.json({
					currentVersion: "0.7.2",
					latestVersion: "0.7.3",
					updateAvailable: true,
					releaseUrl: "https://github.com/lukemxlr/learnharness/releases/tag/v0.7.3",
				});
			}
			return Response.json({});
		}) as typeof fetch;

		const host = await mount(
			<UpdateSettings
				autoUpdate={true}
				onAutoUpdateChange={() => { throw new Error("must not write server settings in remote mode"); }}
				version="0.7.2"
				homepage="https://github.com/lukemxlr/learnharness"
			/>,
		);
		assert.ok(host.textContent!.includes("Desktop app 0.7.3"));
		assert.ok(host.textContent!.includes("Server 0.7.2"));
		assert.equal(serverVersionChecks, 0, "must never check /api/version/latest on mount");

		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-testid="toggle-auto-update"]')!.click();
		});
		assert.equal(storedAutoUpdate, false);

		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-testid="update-check"]')!.click();
		});
		assert.equal(desktopChecks, 1);
		assert.equal(serverVersionChecks, 1);
		assert.ok(host.textContent!.includes("Server update available (v0.7.3)"));
		assert.ok(host.textContent!.includes("update-server.sh"));
	});

	it("displays connected server URL subtly in Settings -> General and ships LearnHarness PWA manifest", async () => {
		const m = manifest();
		assert.equal(m.name, "LearnHarness");
		assert.equal(m.short_name, "LearnHarness");
		assert.equal(m.display, "standalone");
		assert.ok(Array.isArray(m.icons) && m.icons.some((i) => i.src === "/icon-512.png"));

		const prevLoc = Object.getOwnPropertyDescriptor(dom.window, "location");
		Object.defineProperty(dom.window, "location", {
			configurable: true,
			value: { origin: "https://lh.example.test", assign() {} },
		});
		window.lh = {
			isRemoteMode: true,
			expandWindow() {},
			changeServerUrl: async () => ({ ok: true }),
			getUpdateState: async () => ({ status: "idle", version: null, revision: 0 }),
			onUpdateStatus: () => () => {},
		};
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			if (String(input) === "/api/settings") return Response.json({ settings: { version: 1 } });
			return Response.json({});
		}) as typeof fetch;
		try {
			const host = await mount(<SettingsDialogBody initialSection="general" onClose={() => {}} />);
			const row = host.querySelector('[data-testid="row-remote-server"]');
			assert.ok(row?.textContent?.includes("Connected to https://lh.example.test"));
		} finally {
			if (prevLoc) Object.defineProperty(dom.window, "location", prevLoc);
		}
	});

	it("shows a clean manual .dmg update hint on unsigned macOS builds when auto-updater is disabled", async () => {
		window.lh = {
			platform: "darwin",
			expandWindow() {},
			getUpdateState: async () => ({ status: "disabled", version: null, revision: 1 }),
			onUpdateStatus: () => () => {},
		};
		const host = await mount(
			<UpdateSettings
				autoUpdate={true}
				onAutoUpdateChange={() => {}}
				version="0.7.3"
				homepage="https://github.com/lukemxlr/learnharness"
			/>,
		);
		assert.equal(host.querySelector('[data-testid="update-check"]'), null);
		assert.equal(host.querySelector('[data-testid="row-auto-update"]'), null);
		assert.ok(host.querySelector('[data-testid="mac-manual-update-hint"]')?.textContent?.includes(".dmg"));
	});
});
