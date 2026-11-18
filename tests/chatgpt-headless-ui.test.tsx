import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ChatGPTStatus, ModelCatalogResponse } from "../src/core/index.ts";
import { installModalDom } from "./modal-dom.ts";

const dom = parseHTML("<html><body></body></html>");
Object.defineProperty(dom.document, "oninput", { configurable: true, value: null });
Object.assign(globalThis, {
	window: dom.window,
	self: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: { getItem: () => null, setItem() {} },
});
installModalDom(dom);

const { createRoot } = await import("react-dom/client");
const { ChatGPTConnection, ChatGPTUIProvider } = await import("../components/settings/chatgpt-connection.tsx");
const { KeysSection } = await import("../components/settings/keys-section.tsx");
const { AgentSection } = await import("../components/settings/agent-section.tsx");
const { InteractionLayersProvider } = await import("../components/interaction-layers.tsx");

const originalFetch = globalThis.fetch;
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");

let root: Root | undefined;
let host: HTMLDivElement | undefined;

const disconnected = (allowBackgroundUse = true): ChatGPTStatus => ({
	available: true,
	pending: false,
	allowBackgroundUse,
	activeId: null,
	accounts: [],
	error: null,
});

const connected = (allowBackgroundUse = true): ChatGPTStatus => ({
	available: true,
	pending: false,
	allowBackgroundUse,
	activeId: "cg-acc-1",
	accounts: [{ id: "cg-acc-1", email: "headless@example.invalid", registration: "oaiapp_headless", connected: true, planEnabled: true, canSignInAgain: false }],
	error: null,
});

async function mount(children: React.ReactNode) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(<InteractionLayersProvider>{children}</InteractionLayersProvider>);
	});
}

function byTest<T extends HTMLElement = HTMLElement>(id: string): T {
	const el = document.querySelector<T>(`[data-testid="${id}"]`);
	assert.ok(el, `missing [data-testid="${id}"]`);
	return el;
}

async function click(element: HTMLElement) {
	assert.ok(element);
	await act(async () => {
		element.click();
	});
}

async function setInputValue(input: HTMLInputElement, value: string) {
	await act(async () => {
		input.focus();
		const nativeSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
		if (nativeSetter) nativeSetter.call(input, value);
		else input.value = value;
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
	delete window.lh;
	globalThis.fetch = originalFetch;
	if (originalClipboardDescriptor) {
		Object.defineProperty(globalThis.navigator, "clipboard", originalClipboardDescriptor);
	} else {
		Reflect.deleteProperty(globalThis.navigator, "clipboard");
	}
});

test("headless OAuth UI panel in web mode supports link generation, clipboard copy, invalid-paste retry, consent draft, and completion", async () => {
	const authorizeUrl = "https://auth.openai.com/oauth/authorize?state=s1&code_challenge=ch1";
	const redirectUri = "http://127.0.0.1:1455/auth/callback";
	let currentStatus = disconnected(true);
	const ops: Array<{ op: string; body: Record<string, unknown> }> = [];
	const copied: string[] = [];

	window.lh = { expandWindow() {}, subscriptionTransport: "web" };
	Object.defineProperty(globalThis.navigator, "clipboard", {
		configurable: true,
		value: { writeText: async (text: string) => { copied.push(text); } },
	});

	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		if (url === "/api/subscriptions" && (!init?.method || init.method === "GET")) {
			return Response.json({ chatgpt: currentStatus, native: [] });
		}
		if (url === "/api/subscriptions" && init?.method === "POST") {
			const body = JSON.parse(String(init.body)) as Record<string, unknown>;
			ops.push({ op: String(body.op), body });
			if (body.op === "start-headless") {
				currentStatus = { ...currentStatus, pending: true, error: null };
				return Response.json({ value: { authorizeUrl, redirectUri, status: currentStatus } });
			}
			if (body.op === "complete-headless") {
				if (String(body.callbackUrlOrCode) === "bad-url") {
					currentStatus = { ...currentStatus, pending: true, error: "Paste the full redirect URL from your browser." };
					return Response.json({ value: currentStatus });
				}
				currentStatus = connected(currentStatus.allowBackgroundUse);
				return Response.json({ value: currentStatus });
			}
			if (body.op === "consent") {
				currentStatus = { ...currentStatus, allowBackgroundUse: Boolean(body.enabled) };
				return Response.json({ value: currentStatus });
			}
			if (body.op === "cancel") {
				currentStatus = disconnected(currentStatus.allowBackgroundUse);
				return Response.json({ value: currentStatus });
			}
		}
		throw new Error(`Unexpected fetch: ${url}`);
	}) as typeof fetch;

	await mount(
		<ChatGPTUIProvider>
			<ChatGPTConnection />
		</ChatGPTUIProvider>,
	);

	// Open Connect dialog and verify headless section is shown in web mode
	await click(byTest("chatgpt-login"));
	assert.ok(byTest("chatgpt-headless-section"));
	assert.equal(byTest("chatgpt-headless-start").textContent?.trim(), "Get sign-in link");

	// Toggle background consent off before starting headless sign-in
	const bgToggle = document.querySelector<HTMLElement>('[data-testid="chatgpt-account-dialog"] [role="switch"]')!;
	await click(bgToggle);
	assert.equal(bgToggle.getAttribute("aria-checked"), "false");

	// Generate sign-in link
	await click(byTest("chatgpt-headless-start"));
	assert.equal(ops[0]?.op, "start-headless");
	const urlInput = byTest<HTMLInputElement>("chatgpt-headless-url");
	assert.equal(urlInput.value, authorizeUrl);
	assert.equal(urlInput.hasAttribute("readonly"), true);
	assert.equal((byTest<HTMLButtonElement>("chatgpt-headless-complete")).disabled, true);

	// Copy link updates clipboard and button state
	await click(byTest("chatgpt-headless-copy"));
	assert.deepEqual(copied, [authorizeUrl]);
	assert.equal(byTest("chatgpt-headless-copy").textContent?.trim(), "Copied");

	// Invalid callback keeps headless panel open and displays error
	await setInputValue(byTest<HTMLInputElement>("chatgpt-headless-callback"), "bad-url");
	assert.equal((byTest<HTMLButtonElement>("chatgpt-headless-complete")).disabled, false);
	await click(byTest("chatgpt-headless-complete"));
	assert.equal(document.querySelector('[role="alert"]')?.textContent, "Paste the full redirect URL from your browser.");
	assert.ok(document.querySelector('[data-testid="chatgpt-headless-callback"]'));

	// Valid callback completes headless login, persists background consent draft, and closes dialog
	await setInputValue(byTest<HTMLInputElement>("chatgpt-headless-callback"), `${redirectUri}?code=valid-code&state=s1`);
	await click(byTest("chatgpt-headless-complete"));
	assert.deepEqual(ops.map((entry) => entry.op), ["start-headless", "complete-headless", "complete-headless", "consent"]);
	assert.equal(ops[3]?.body.enabled, false);
	assert.equal(document.querySelector('[data-testid="chatgpt-account-dialog"]'), null);
	assert.equal(currentStatus.allowBackgroundUse, false);
	assert.ok(byTest("chatgpt-connection").textContent?.includes("headless@example.invalid"));
	assert.ok(byTest("chatgpt-connection").textContent?.includes("Manage…"));
});

test("headless OAuth UI panel can be cancelled cleanly and is hidden in desktop IPC mode", async () => {
	let currentStatus = disconnected(true);
	const ops: string[] = [];

	window.lh = { expandWindow() {}, subscriptionTransport: "web" };
	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		if (url === "/api/subscriptions" && (!init?.method || init.method === "GET")) {
			return Response.json({ chatgpt: currentStatus, native: [] });
		}
		if (url === "/api/subscriptions" && init?.method === "POST") {
			const body = JSON.parse(String(init.body)) as Record<string, unknown>;
			ops.push(String(body.op));
			if (body.op === "start-headless") {
				currentStatus = { ...currentStatus, pending: true };
				return Response.json({ value: { authorizeUrl: "https://auth.openai.com/oauth/authorize?state=cancel", redirectUri: "http://127.0.0.1:1455/auth/callback", status: currentStatus } });
			}
			if (body.op === "cancel") {
				currentStatus = disconnected(true);
				return Response.json({ value: currentStatus });
			}
		}
		throw new Error(`Unexpected fetch: ${url}`);
	}) as typeof fetch;

	await mount(
		<ChatGPTUIProvider>
			<ChatGPTConnection />
		</ChatGPTUIProvider>,
	);

	await click(byTest("chatgpt-login"));
	await click(byTest("chatgpt-headless-start"));
	assert.ok(byTest("chatgpt-headless-callback"));

	const cancelBtn = [...byTest("chatgpt-account-dialog").querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Cancel")!;
	await click(cancelBtn);
	assert.deepEqual(ops, ["start-headless", "cancel"]);
	assert.equal(document.querySelector('[data-testid="chatgpt-account-dialog"]'), null);

	// Desktop IPC mode must NOT render the headless OAuth panel
	await act(async () => root?.unmount());
	host?.remove();
	window.lh = {
		expandWindow() {},
		chatgpt: {
			status: async () => disconnected(true),
			login: async () => disconnected(true),
			cancel: async () => disconnected(true),
			select: async () => disconnected(true),
			disconnect: async () => disconnected(true),
			logout: async () => disconnected(true),
			consent: async () => disconnected(true),
			onChange: () => () => {},
		},
	};
	await mount(
		<ChatGPTUIProvider>
			<ChatGPTConnection />
		</ChatGPTUIProvider>,
	);
	await click(byTest("chatgpt-login"));
	assert.equal(document.querySelector('[data-testid="chatgpt-headless-section"]'), null);
});

test("KeysSection manual Refresh models button handles transient failure non-destructively and succeeds on retry", async () => {
	let failRefresh = true;
	let refreshCalls = 0;

	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		if (url === "/api/keys") return Response.json({ providers: [], keys: [] });
		if (url === "/api/custom-provider") {
			return Response.json({ baseUrl: "", authMode: "keyless", keySource: "none", keyPresent: false, keyReuseRequired: false, models: [], overrides: {}, manualModels: [] });
		}
		if (url === "/api/claude-code") return Response.json({ state: "not-found", version: null, minimumVersion: "2.1.259" });
		if (url === "/api/subscriptions") return Response.json({ chatgpt: disconnected(), native: [] });
		if (url === "/api/models/refresh" && init?.method === "POST") {
			refreshCalls++;
			if (failRefresh) return Response.json({ error: "Upstream unavailable" }, { status: 503 });
			return Response.json({
				models: [],
				providers: [{ id: "chatgpt", envVar: "", keyPresent: true }],
				slots: { strong: null, cheap: null, vision: null },
				defaults: null,
			});
		}
		throw new Error(`Unexpected fetch: ${url}`);
	}) as typeof fetch;

	await mount(<KeysSection />);

	const btn = byTest<HTMLButtonElement>("refresh-models-btn");
	assert.equal(btn.textContent?.trim(), "Refresh models");

	await click(btn);
	assert.equal(refreshCalls, 1);
	assert.equal(byTest("refresh-models-error").textContent?.trim(), "Could not refresh models. Keeping last known model catalog.");
	assert.equal(document.querySelector('[data-testid="refresh-models-ok"]'), null);

	failRefresh = false;
	await click(btn);
	assert.equal(refreshCalls, 2);
	assert.equal(byTest("refresh-models-ok").textContent?.trim(), "Models refreshed");
	assert.equal(document.querySelector('[data-testid="refresh-models-error"]'), null);
});

test("AgentSection displays non-destructive catalog error banner, keeps last-known models selectable, and refreshes on click", async () => {
	const refreshBodies: Array<Record<string, unknown>> = [];
	const lastKnownCatalog: ModelCatalogResponse = {
		models: [
			{
				id: "gpt-5.3-codex",
				name: "GPT-5.3 Codex",
				provider: "chatgpt",
				input: ["text", "image"],
				contextWindow: 256_000,
				maxTokens: 32_768,
				reasoning: true,
				supportedLevels: ["low", "high"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
		providers: [{ id: "chatgpt", envVar: "", keyPresent: true }],
		slots: { strong: null, cheap: null, vision: null },
		rolePins: { researcher: null, demoBuilder: null, visualMaker: null, extractor: null, auditor: null, sideQuestion: null },
		defaults: null,
		catalogErrors: { chatgpt: "ChatGPT model catalog fetch failed (503)" },
	};

	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		if (url === "/api/models") return Response.json(lastKnownCatalog);
		if (url === "/api/settings/prompts") return Response.json({ teacher: [], prober: [], practice: [] });
		if (url === "/api/keys") return Response.json({ keys: [] });
		if (url === "/api/search") return Response.json({ available: false, engine: null, reason: "No search key" });
		if (url === "/api/models/refresh" && init?.method === "POST") {
			refreshBodies.push(JSON.parse(String(init.body || "{}")));
			return Response.json({ ...lastKnownCatalog, catalogErrors: undefined });
		}
		throw new Error(`Unexpected fetch: ${url}`);
	}) as typeof fetch;

	await mount(
		<AgentSection
			agent={undefined}
			models={undefined}
			graph={undefined}
			compaction={undefined}
			onSectionChange={() => true}
			onModelsChange={() => {}}
			onCompactionChange={() => true}
		/>,
	);

	// Non-destructive error banner shows with last-known models still selectable
	const banner = byTest("catalog-error-chatgpt");
	assert.equal(banner.getAttribute("role"), "alert");
	assert.match(banner.textContent ?? "", /ChatGPT model catalog fetch failed \(503\)/);
	assert.match(banner.textContent ?? "", /\(showing last known models\)/);

	await click(byTest("slot-model-strong"));
	assert.match(byTest("slot-model-menu-strong").textContent ?? "", /GPT-5\.3 Codex|gpt-5\.3-codex/i);

	// Clicking Refresh models inside the banner triggers POST /api/models/refresh for chatgpt and clears the banner
	const inlineRefreshBtn = banner.querySelector<HTMLButtonElement>("button")!;
	assert.equal(inlineRefreshBtn.textContent?.trim(), "Refresh models");
	await click(inlineRefreshBtn);
	assert.deepEqual(refreshBodies, [{ provider: "chatgpt" }]);
	assert.equal(document.querySelector('[data-testid="catalog-error-chatgpt"]'), null);
});
