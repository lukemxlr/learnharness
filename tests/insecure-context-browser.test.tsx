import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import {
	DICTATION_INSECURE_CONTEXT,
	useDictation,
	useDictationTarget,
	type Dictation,
} from "../components/dictation.tsx";
import { isDictationActive } from "../components/dictation-state.ts";
import {
	newMessageId,
	newPlanBlockMessage,
	newSideThreadId,
	newUserMessage,
	randomUuid,
} from "../src/core/index.ts";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

afterEach(async () => {
	await dispose?.();
	dispose = undefined;
	restore?.();
	restore = undefined;
});

test("randomUuid and core ID helpers work when crypto.randomUUID is unavailable (plain HTTP LAN)", () => {
	const origDesc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
	const origCrypto = globalThis.crypto;
	Object.defineProperty(globalThis, "crypto", {
		configurable: true,
		writable: true,
		value: {
			getRandomValues: origCrypto.getRandomValues.bind(origCrypto),
		},
	});
	try {
		const id = randomUuid();
		assert.match(id, UUID_V4_RE);
		assert.notEqual(id, randomUuid());
		assert.match(newMessageId(), /^msg_[0-9a-z]+_[0-9a-f]{8}$/);
		assert.match(newPlanBlockMessage("call_1", {}).id, /^pb_[0-9a-z]+_[0-9a-f]{8}$/);
		assert.match(newSideThreadId(), /^side_[0-9a-z]+_[0-9a-f]{8}$/);
		const msg = newUserMessage("Hallo");
		assert.match(msg.id, /^msg_[0-9a-z]+_[0-9a-f]{8}$/);
		assert.equal(msg.content, "Hallo");
	} finally {
		if (origDesc) Object.defineProperty(globalThis, "crypto", origDesc);
		else delete globals.crypto;
	}
});

test("useDictation surfaces HTTPS requirement cleanly instead of throwing when mediaDevices is absent on plain HTTP LAN", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.defineProperty(dom.window, "isSecureContext", { value: false, configurable: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React,
		window: dom.window,
		document: dom.document,
		CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "" },
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string) => {
			if (url === "/api/settings") {
				return Response.json({ settings: { version: 1, dictation: { language: "de" } } });
			}
			return Response.json({ token: "unused" });
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globals, key));
		Object.defineProperty(globals, key, { value, writable: true, configurable: true });
	}
	restore = () => {
		for (const [key, desc] of previous) {
			if (desc) Object.defineProperty(globals, key, desc);
			else delete globals[key];
		}
	};

	const { createRoot } = await import("react-dom/client");
	let latest!: Dictation;
	function Harness() {
		useDictationTarget(() => {}, true);
		latest = useDictation({ append: () => {} });
		return null;
	}
	const root = createRoot(dom.document.getElementById("root")!);
	dispose = async () => {
		await act(async () => root.unmount());
	};

	await act(async () => root.render(React.createElement(Harness)));
	await act(async () => {
		latest.toggle();
		await new Promise((r) => setTimeout(r, 20));
	});

	assert.equal(latest.error, DICTATION_INSECURE_CONTEXT);
	assert.equal(latest.active, false);
	assert.equal(isDictationActive(), false);
});
