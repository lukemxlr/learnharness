import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { computeMenuPlacement } from "../components/menu-shell.tsx";
import { readVisualViewport, syncVisualViewportVars } from "../components/visual-viewport.ts";
import { PracticeDock } from "../components/practice-dock.tsx";
import { LoginForm } from "../components/login-form.tsx";
import { AppShell, SessionRow, SidebarProvider, SidebarToggle } from "../components/sidebar.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { PluginsProvider } from "../components/plugins.tsx";
import { ModelPickerPill } from "../components/model-picker-pill.tsx";
import { Composer } from "../components/composer.tsx";
import { installModalDom } from "./modal-dom.ts";
import type { ChatListItem } from "../src/core/index.ts";

let root: Root | undefined;
let cleanupDom: (() => void) | undefined;
const originalFetch = globalThis.fetch;

afterEach(async () => {
	if (root) {
		await act(async () => {
			root?.unmount();
		});
		root = undefined;
	}
	cleanupDom?.();
	cleanupDom = undefined;
	globalThis.fetch = originalFetch;
});

function setupDom(viewport = { width: 820, height: 1180 }) {
	const dom = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
	const storageMap = new Map<string, string>();
	const memStorage = {
		getItem: (k: string) => storageMap.get(k) ?? null,
		setItem: (k: string, v: string) => {
			storageMap.set(k, String(v));
		},
		removeItem: (k: string) => {
			storageMap.delete(k);
		},
		clear: () => {
			storageMap.clear();
		},
	};
	Object.defineProperty(dom.window, "localStorage", { configurable: true, value: memStorage });
	const globals: Record<string, unknown> = {
		React,
		self: dom.window,
		window: dom.window,
		document: dom.document,
		localStorage: memStorage,
		Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement,
		HTMLInputElement: dom.window.HTMLInputElement,
		HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
		HTMLButtonElement: dom.window.HTMLButtonElement,
		Node: dom.window.Node,
		Event: dom.window.Event,
		MouseEvent: dom.window.MouseEvent,
		KeyboardEvent: dom.window.KeyboardEvent,
		CustomEvent: dom.window.CustomEvent,
		ResizeObserver: class ResizeObserver {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		MutationObserver: dom.window.MutationObserver ?? class MutationObserver {
			observe() {}
			disconnect() {}
			takeRecords() { return []; }
		},
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const saved = new Map(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
	for (const [key, val] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: val });
	}
	const restoreModal = installModalDom(dom);
	Object.defineProperty(dom.window, "innerWidth", { configurable: true, writable: true, value: viewport.width });
	Object.defineProperty(dom.window, "innerHeight", { configurable: true, writable: true, value: viewport.height });
	cleanupDom = () => {
		restoreModal();
		for (const [key, desc] of saved) {
			if (desc) Object.defineProperty(globalThis, key, desc);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	root = createRoot(dom.document.querySelector("#root")!);
	return dom;
}

describe("M5 iPadOS / WebKit UI & Responsive Primitives", () => {
	it("computeMenuPlacement clamps wide menus horizontally on Split-View and respects visualViewport shrink", () => {
		// 5-arg signature backward-compatible (omits maxWidth so deepEqual callers stay identical)
		const compat = computeMenuPlacement(
			{ top: 40, bottom: 72, left: 20, right: 120 },
			{ width: 375, height: 1024 },
			100,
			"down",
			"left",
		);
		assert.equal(compat.style.left, 20);
		assert.equal(compat.maxWidth, undefined);

		// 6-arg signature clamps 352px model menu inside 375px Split-View
		const clampedLeft = computeMenuPlacement(
			{ top: 40, bottom: 72, left: 280, right: 360 },
			{ width: 375, height: 1024 },
			240,
			"down",
			"left",
			352,
		);
		assert.equal(clampedLeft.style.left, 15, "shifts menu left so left + 352 <= 375 - 8");
		assert.equal(clampedLeft.maxWidth, 359);

		// Right-aligned menu near left edge clamps right so right-edge - width >= 8
		const clampedRight = computeMenuPlacement(
			{ top: 40, bottom: 72, left: 12, right: 80 },
			{ width: 320, height: 1024 },
			200,
			"down",
			"right",
			304,
		);
		assert.equal(clampedRight.style.right, 8);
		assert.equal(clampedRight.maxWidth, 304);

		// Onscreen keyboard shrinks visualViewport height from 1133 -> 773 while layoutHeight stays 1133
		const keyboardUp = computeMenuPlacement(
			{ top: 710, bottom: 750, left: 24, right: 140 },
			{ width: 744, height: 773, offsetTop: 0, offsetLeft: 0, layoutWidth: 744, layoutHeight: 1133 },
			260,
			"up",
			"left",
			352,
		);
		assert.equal(keyboardUp.side, "up");
		assert.equal(keyboardUp.style.bottom, 1133 - 710 + 4);
		assert.ok(keyboardUp.maxHeight <= 700);
	});

	it("readVisualViewport & syncVisualViewportVars compute bottom keyboard inset cleanly", () => {
		const dom = setupDom({ width: 744, height: 1133 });
		Object.defineProperty(dom.window, "visualViewport", {
			configurable: true,
			value: {
				width: 744,
				height: 773,
				offsetTop: 0,
				offsetLeft: 0,
				scale: 1,
			},
		});
		const snap = readVisualViewport(dom.window as unknown as Window);
		assert.equal(snap.bottomInset, 360);
		syncVisualViewportVars(dom.document as unknown as Document, snap);
		assert.equal(dom.document.documentElement.style.getPropertyValue("--lh-vv-height"), "773px");
		assert.equal(dom.document.documentElement.style.getPropertyValue("--lh-vv-bottom-inset"), "360px");
	});

	it("PracticeDock keeps form & PathInput editor mounted across collapse/expand (zero-unmount)", async () => {
		setupDom({ width: 820, height: 1180 });
		function Harness() {
			const [expanded, setExpanded] = useState(true);
			return (
				<div>
					<button type="button" data-testid="toggle-expand" onClick={() => setExpanded((v) => !v)}>
						Toggle
					</button>
					<PracticeDock
						problemCallId="prob-1"
						input={{ statement: "Derive the Henderson-Hasselbalch equation." }}
						expanded={expanded}
						onExpand={() => setExpanded(true)}
						onSubmit={() => {}}
					/>
				</div>
			);
		}
		await act(async () => {
			root!.render(<Harness />);
		});
		const editor = document.querySelector<HTMLElement>('[data-testid="practice-thinking-field"] [data-file-path-input]');
		assert.ok(editor, "thinking PathInput mounted when expanded");
		await act(async () => {
			editor.textContent = "pH = pKa + log([A-]/[HA])";
			editor.dispatchEvent(new window.Event("input", { bubbles: true }));
		});

		// Collapse PracticeDock -> form must stay in DOM (hidden), preserving state & DOM identity
		const toggle = document.querySelector<HTMLButtonElement>('[data-testid="toggle-expand"]')!;
		await act(async () => {
			toggle.click();
		});
		const collapsedForm = document.querySelector<HTMLElement>('[data-testid="practice-dock"]');
		assert.ok(collapsedForm, "practice-dock stays mounted while collapsed");
		assert.notEqual(editor.closest("[hidden]"), null, "thinking editor sits inside hidden wrapper while collapsed");
		assert.ok(document.querySelector('[data-testid="practice-dock-bar"]'), "collapsed bar renders");

		// Re-expand -> exact same editor DOM node & text preserved
		await act(async () => {
			toggle.click();
		});
		const revealedEditor = document.querySelector<HTMLElement>('[data-testid="practice-thinking-field"] [data-file-path-input]');
		assert.equal(revealedEditor, editor, "PathInput DOM node never unmounted");
		assert.equal(revealedEditor?.textContent, "pH = pKa + log([A-]/[HA])");
		assert.equal(editor.closest("[hidden]"), null);
	});

	it("Sidebar uses overlay drawer on <1024px without unmounting main children across viewport resize", async () => {
		const dom = setupDom({ width: 820, height: 1180 });
		globalThis.fetch = async (input) => {
			const url = String(input);
			if (url.startsWith("/api/chats")) {
				const chats: ChatListItem[] = [
					{
						id: "c-ipad-1",
						title: "Organic Synthesis",
						kind: "teach",
						createdAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-02T00:00:00.000Z",
						messageCount: 3,
						phase: "teach",
						pendingQuestion: false,
						pendingProblem: false,
						busy: false,
						compacting: false,
					},
				];
				return Response.json({ chats });
			}
			if (url.startsWith("/api/plugins")) return Response.json({ plugins: [], directory: "/tmp" });
			if (url.startsWith("/api/settings")) return Response.json({ settings: { version: 1 } });
			return Response.json({});
		};
		const connect = (): NotifySource => ({ close() {}, onOpen() {}, onEvent() {} });
		const router = {
			bfcacheId: "test",
			back() {},
			forward() {},
			refresh() {},
			hmrRefresh() {},
			push() {},
			replace() {},
			async prefetch() {},
		};
		function ChildProbe() {
			const [draft, setDraft] = useState("preserved-across-resize");
			return (
				<main data-testid="probe-main">
					<SidebarToggle />
					<input data-testid="probe-input" value={draft} onChange={(e) => setDraft(e.target.value)} />
				</main>
			);
		}
		await act(async () => {
			root!.render(
				<InteractionLayersProvider>
					<AppRouterContext.Provider value={router}>
						<PathnameContext.Provider value="/chat/c-ipad-1">
							<ServerEventsProvider connect={connect}>
								<PluginsProvider>
									<SidebarProvider>
										<AppShell>
											<ChildProbe />
										</AppShell>
									</SidebarProvider>
								</PluginsProvider>
							</ServerEventsProvider>
						</PathnameContext.Provider>
					</AppRouterContext.Provider>
				</InteractionLayersProvider>,
			);
		});

		const probeInputBefore = document.querySelector<HTMLInputElement>('[data-testid="probe-input"]');
		assert.ok(probeInputBefore);
		const aside = document.querySelector<HTMLElement>("aside")!;
		assert.equal(aside.getAttribute("data-drawer"), "true", "820px portrait uses overlay drawer mode");
		assert.equal(aside.getAttribute("aria-hidden"), "true", "drawer starts closed on narrow/tablet viewport");
		assert.ok(aside.classList.contains("hidden"), "closed overlay drawer stays display:none instead of an offscreen fixed box");
		assert.equal(document.querySelector('[data-testid="sidebar-backdrop"]'), null);

		// Open drawer via Open sidebar button -> backdrop + dialog semantics + session-row-more touch button
		const openBtn = document.querySelector<HTMLButtonElement>('[aria-label="Open sidebar"]')!;
		assert.ok(openBtn, "Open sidebar toggle button renders");
		await act(async () => {
			openBtn.click();
		});
		assert.equal(aside.getAttribute("aria-hidden"), "false");
		assert.equal(aside.getAttribute("role"), "dialog");
		const backdrop = document.querySelector<HTMLElement>('[data-testid="sidebar-backdrop"]');
		assert.ok(backdrop, "backdrop renders when overlay drawer is open");
		const moreBtn = document.querySelector<HTMLButtonElement>('[data-testid="session-row-more"]');
		assert.ok(moreBtn, "touch session-row-more button renders without requiring right-click");

		// Backdrop click dismisses drawer
		await act(async () => {
			backdrop.click();
		});
		assert.equal(aside.getAttribute("aria-hidden"), "true");

		// Resize across 820 -> 1366 -> 507 -> ChildProbe never unmounts!
		for (const nextWidth of [1366, 507]) {
			await act(async () => {
				Object.defineProperty(dom.window, "innerWidth", { configurable: true, writable: true, value: nextWidth });
				dom.window.dispatchEvent(new dom.window.Event("resize"));
			});
		}
		const probeInputAfter = document.querySelector<HTMLInputElement>('[data-testid="probe-input"]');
		assert.equal(probeInputAfter, probeInputBefore, "main session subtree never unmounted across drawer/desktop breakpoint transitions");
		assert.equal(probeInputAfter?.value, "preserved-across-resize");
	});

	it("keeps sign-in controls disabled until hydration and never submits credentials in the URL", async () => {
		const login = <LoginForm nextPath="/" configured />;
		const ssr = parseHTML(renderToStaticMarkup(login)).document;
		assert.equal(ssr.querySelector("form")!.getAttribute("method"), "post");
		for (const id of ["login-username", "login-password", "login-submit"]) {
			assert.ok(ssr.querySelector(`[data-testid="${id}"]`)!.hasAttribute("disabled"), id);
		}

		setupDom({ width: 820, height: 1180 });
		await act(async () => { root!.render(login); });
		for (const id of ["login-username", "login-password", "login-submit"]) {
			assert.equal(document.querySelector(`[data-testid="${id}"]`)!.hasAttribute("disabled"), false, id);
		}
	});

	it("renders remote-mode 'Change Server URL' affordance on LoginForm and Settings General only when window.lh.isRemoteMode is active", async () => {
		const dom = setupDom({ width: 820, height: 1180 });
		let calls = 0;
		globalThis.fetch = async () => Response.json({ settings: { version: 1 }, keys: [], providers: [], models: [], slots: {} });

		// 1. Browser mode (no window.lh) -> no Change Server URL button
		await act(async () => {
			root!.render(<LoginForm nextPath="/" configured />);
		});
		assert.equal(document.querySelector('[data-testid="change-server-url"]'), null);

		// 2. Remote mode -> Change Server URL button renders on LoginForm and invokes window.lh.changeServerUrl()
		(dom.window as unknown as { lh: unknown }).lh = {
			isRemoteMode: true,
			changeServerUrl: async () => {
				calls++;
			},
		};
		await act(async () => {
			root!.render(<LoginForm nextPath="/" configured />);
		});
		const loginBtn = document.querySelector<HTMLButtonElement>('[data-testid="change-server-url"]');
		assert.ok(loginBtn, "Change Server URL button visible on LoginForm in remote mode");
		await act(async () => {
			loginBtn.click();
		});
		assert.equal(calls, 1);

		// 3. Also visible in Settings -> General
		await act(async () => {
			root!.render(
				<InteractionLayersProvider>
					<SettingsDialogBody onClose={() => {}} initialSection="general" />
				</InteractionLayersProvider>,
			);
		});
		const settingsBtn = document.querySelector<HTMLButtonElement>('[data-testid="change-server-url"]');
		assert.ok(settingsBtn, "Change Server URL button visible in Settings General in remote mode");
		await act(async () => {
			settingsBtn.click();
		});
		assert.equal(calls, 2);
	});

	it("preserves >=44x44px touch sizing classes on ModelPickerPill, SessionRow more trigger, and Composer Send button", () => {
		const pillHtml = renderToStaticMarkup(
			<ModelPickerPill data-testid="stats-model">Claude Sonnet</ModelPickerPill>,
		);
		assert.ok(pillHtml.includes("min-h-11") && pillHtml.includes("rounded-full"));

		const rowHtml = renderToStaticMarkup(
			<SessionRow
				chat={{
					id: "c1",
					title: "Session",
					kind: "teach",
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-02T00:00:00.000Z",
					messageCount: 1,
					phase: "probe",
					pendingQuestion: false,
					pendingProblem: false,
					busy: false,
					compacting: false,
				}}
				active={false}
				onOpen={() => {}}
				onOpenMenu={() => {}}
			/>,
		);
		assert.ok(rowHtml.includes('data-testid="session-row-more"'));
		assert.ok(rowHtml.includes("size-11"));

		const composerHtml = renderToStaticMarkup(
			<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend />,
		);
		assert.ok(composerHtml.includes("size-10") && composerHtml.includes("min-h-11") && composerHtml.includes("rounded-[10px]"));
	});
});
