import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import test from "node:test";
import { Chat } from "../components/chat.tsx";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import type { LhMessage } from "../src/core/native-messages.ts";
import { mountPluginChrome } from "./helpers/plugin-chrome.tsx";

function createControllableSource() {
	let openCb: (() => void) | undefined;
	const eventCbs = new Map<string, (data: string) => void>();
	const source: NotifySource = {
		close() {},
		onOpen(cb) { openCb = cb; },
		onEvent(name, cb) { eventCbs.set(name, cb); },
	};
	return {
		source,
		fireOpen() { openCb?.(); },
		emit(name: string, payload: unknown) { eventCbs.get(name)?.(JSON.stringify(payload)); },
	};
}

function sseBody(...frames: unknown[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const text = frames.map((f) => (f === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(f)}\n\n`)).join("");
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(text));
			controller.close();
		},
	});
}

async function waitForUi(pred: () => boolean, timeoutMs = 5_000, label = "condition"): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	await act(async () => {
		await Promise.resolve();
	});
	while (!pred()) {
		if (performance.now() >= deadline) {
			throw new Error(`Timed out waiting for ${label}`);
		}
		await act(async () => {
			await new Promise((r) => setTimeout(r, 10));
		});
	}
}

test("Chat resyncs on EventSource reconnect, visibilitychange, focus, and online without starting a 2nd model run", async () => {
	const savedObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
	Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });

	const controllable = createControllableSource();
	const chatId = "chat_resync_ui";
	const initialMessages: LhMessage[] = [{ id: "u0", role: "user", content: "Initial question", timestamp: 1 } as LhMessage];

	let serverTurnInFlight = false;
	let serverMessages: LhMessage[] = [...initialMessages];
	let streamRequests = 0;
	let chatPosts = 0;
	let jobsRequests = 0;
	let releaseStream!: () => void;

	let fixture: Awaited<ReturnType<typeof mountPluginChrome>> | undefined;
	try {
		fixture = await mountPluginChrome(
			{ activate() {} },
			<ServerEventsProvider connect={() => controllable.source}>
				<Chat chatId={chatId} title="Resync Session" initialMessages={initialMessages} />
			</ServerEventsProvider>,
			{
				pathname: `/chat/${chatId}`,
				prepareDom(dom) {
					const prototype = dom.window.HTMLElement.prototype;
					const saved = [
						[dom.window, "location"],
						[dom.window, "localStorage"],
						[prototype, "getAnimations"],
						[prototype, "offsetWidth"],
					].map(([object, key]) => ({
						object: object as object,
						key: key as string,
						descriptor: Object.getOwnPropertyDescriptor(object, key as string),
					}));
					const values = new Map<string, string>();
					Object.defineProperty(dom.window, "location", { configurable: true, value: new URL(`http://fixture/chat/${chatId}`) });
					Object.defineProperty(dom.window, "localStorage", {
						configurable: true,
						value: {
							getItem: (k: string) => values.get(k) ?? null,
							setItem: (k: string, v: string) => values.set(k, v),
							removeItem: (k: string) => values.delete(k),
						},
					});
					Object.defineProperty(prototype, "getAnimations", { configurable: true, value: () => [] });
					Object.defineProperty(prototype, "offsetWidth", { configurable: true, get() { return this.clientWidth; } });
					Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => "visible" });
					return () => {
						for (const { object, key, descriptor } of saved) {
							if (descriptor) Object.defineProperty(object, key, descriptor);
							else Reflect.deleteProperty(object, key);
						}
					};
				},
				fetch: async (input, init) => {
					const url = String(input);
					if (url === "/api/chat" || (url.endsWith("/chat") && init?.method === "POST")) {
						chatPosts++;
						return Response.json({ ok: true });
					}
					if (url === "/api/models") return Response.json({ providers: [], models: [], slots: {} });
					if (url === "/api/settings") return Response.json({});
					if (url === `/api/chats/${chatId}/side-chats`) return Response.json({ threads: [] });
					if (url === `/api/jobs?chatId=${chatId}`) {
						jobsRequests++;
						return Response.json({ jobs: [], turnInFlight: serverTurnInFlight });
					}
					if (url === `/api/chats/${chatId}`) {
						return Response.json({ id: chatId, messages: serverMessages, turnInFlight: serverTurnInFlight });
					}
					if (url === `/api/chats/${chatId}/stream`) {
						streamRequests++;
						const encoder = new TextEncoder();
						const body = new ReadableStream<Uint8Array>({
							async start(controller) {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "agent_start" })}\n\n`));
								controller.enqueue(encoder.encode(": ping\n\n"));
								controller.enqueue(
									encoder.encode(
										`data: ${JSON.stringify({
											type: "message_start",
											message: { role: "assistant", content: [{ type: "text", text: "Live from client A..." }] },
										})}\n\n`,
									),
								);
								await new Promise<void>((r) => { releaseStream = r; });
								controller.enqueue(
									encoder.encode(
										`data: ${JSON.stringify({
											type: "message_end",
											message: { role: "assistant", content: [{ type: "text", text: "Live from client A... complete!" }], stopReason: "stop" },
										})}\n\n`,
									),
								);
								controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "agent_end", messages: [] })}\n\n`));
								controller.enqueue(encoder.encode("data: [DONE]\n\n"));
								controller.close();
							},
						});
						return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
					}
					throw new Error(`Unexpected request: ${url}`);
				},
			},
		);

		const mounted = fixture;
		// 1. Simulate Client A starting a turn while Client B's EventSource missed `turn-started`.
		serverTurnInFlight = true;
		serverMessages = [
			...initialMessages,
			{ id: "u_missed", role: "user", content: "Client A question", timestamp: 2 } as LhMessage,
		];

		// 2. Trigger burst of resync events (visibilitychange + focus + online + EventSource.onopen)
		// Should coalesce without duplicate /stream attachments!
		await act(async () => {
			mounted.document.dispatchEvent(new window.Event("visibilitychange"));
			window.dispatchEvent(new window.Event("focus"));
			window.dispatchEvent(new window.Event("online"));
			controllable.fireOpen();
		});
		await waitForUi(
			() => streamRequests >= 1 && Boolean(mounted.document.body.textContent?.includes("Live from client A...")),
			5_000,
			"coalesced stream attach and partial render",
		);

		assert.equal(chatPosts, 0, "second client resync must NEVER POST /api/chat");
		assert.equal(streamRequests, 1, "burst of wake/reconnect events must coalesce to 1 stream attach");
		assert.ok(mounted.document.body.textContent?.includes("Live from client A..."));

		// 3. Another focus/visibilitychange while healthy stream is active must NOT abort or duplicate it
		const jobsBefore = jobsRequests;
		await act(async () => {
			window.dispatchEvent(new window.Event("focus"));
			mounted.document.dispatchEvent(new window.Event("visibilitychange"));
		});
		await waitForUi(
			() => jobsRequests >= jobsBefore + 1,
			5_000,
			"active-stream resync fetchJobs",
		);
		assert.ok(jobsRequests >= jobsBefore + 1);
		assert.equal(streamRequests, 1, "healthy active stream must not be aborted on focus/visibilitychange");

		// 4. Finish the server stream
		serverTurnInFlight = false;
		serverMessages = [
			...serverMessages,
			{
				id: "a_final",
				role: "assistant",
				content: [{ type: "text", text: "Live from client A... complete!" }],
				stopReason: "stop",
				usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				provider: "custom",
				model: "test-model",
				timestamp: 3,
			} as unknown as LhMessage,
		];
		await act(async () => {
			releaseStream();
		});
		await waitForUi(
			() => Boolean(mounted.document.body.textContent?.includes("Live from client A... complete!")),
			5_000,
			"completed stream render",
		);
		assert.ok(mounted.document.body.textContent?.includes("Live from client A... complete!"));

		// 5. Missed turn-settled while asleep: server added a new settled turn with no live stream
		serverMessages = [
			...serverMessages,
			{ id: "u_wake", role: "user", content: "Missed while asleep", timestamp: 4 } as LhMessage,
			{
				id: "a_wake",
				role: "assistant",
				content: [{ type: "text", text: "Settled while offline." }],
				stopReason: "stop",
				usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				provider: "custom",
				model: "test-model",
				timestamp: 5,
			} as unknown as LhMessage,
		];
		await act(async () => {
			window.dispatchEvent(new window.Event("online"));
		});
		await waitForUi(
			() => Boolean(mounted.document.body.textContent?.includes("Settled while offline.")),
			5_000,
			"missed turn-settled render",
		);
		assert.ok(mounted.document.body.textContent?.includes("Settled while offline."));
		assert.equal(chatPosts, 0);

		// 6. Unmount cleanup removes DOM listeners cleanly (no further /api/jobs calls on events)
		const jobsAtUnmount = jobsRequests;
		await mounted.render(null);
		await act(async () => {
			mounted.document.dispatchEvent(new window.Event("visibilitychange"));
			window.dispatchEvent(new window.Event("focus"));
			window.dispatchEvent(new window.Event("online"));
			await new Promise((r) => setTimeout(r, 20));
		});
		assert.equal(jobsRequests, jobsAtUnmount, "unmounted Chat must remove visibilitychange/focus/online listeners");
	} finally {
		await fixture?.close();
		if (savedObserver) Object.defineProperty(globalThis, "ResizeObserver", savedObserver);
		else Reflect.deleteProperty(globalThis, "ResizeObserver");
	}
});

// Keep sseBody referenced cleanly for future scenarios or remove unused helper lint warning:
void sseBody;

test("Chat recovers stale hung streaming/submitted sockets, preserves pre-turn compaction, and heals reconciliation=failed on resync", async () => {
	const savedObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
	const origDateNow = Date.now;
	let timeOffset = 0;
	Date.now = () => origDateNow() + timeOffset;
	Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });

	const controllable = createControllableSource();
	const chatId = "chat_stale_and_reconcile_ui";
	const initialMessages: LhMessage[] = [{ id: "u0", role: "user", content: "Start", timestamp: 1 } as LhMessage];

	let serverTurnInFlight = false;
	let serverCompacting = false;
	let failRecordGet = false;
	let serverMessages: LhMessage[] = [...initialMessages];
	let streamRequests = 0;
	let jobsRequests = 0;
	let recordRequests = 0;
	let chatPosts = 0;
	let streamMode: "streaming" | "submitted" | "done" = "streaming";
	let streamCancelledCount = 0;
	const pendingStreamReleases: Array<() => void> = [];

	let fixture: Awaited<ReturnType<typeof mountPluginChrome>> | undefined;
	try {
		fixture = await mountPluginChrome(
			{ activate() {} },
			<ServerEventsProvider connect={() => controllable.source}>
				<Chat chatId={chatId} title="Stale Socket Session" initialMessages={initialMessages} />
			</ServerEventsProvider>,
			{
				pathname: `/chat/${chatId}`,
				prepareDom(dom) {
					const prototype = dom.window.HTMLElement.prototype;
					const saved = [
						[dom.window, "location"],
						[dom.window, "localStorage"],
						[prototype, "getAnimations"],
						[prototype, "offsetWidth"],
					].map(([object, key]) => ({
						object: object as object,
						key: key as string,
						descriptor: Object.getOwnPropertyDescriptor(object, key as string),
					}));
					const values = new Map<string, string>();
					Object.defineProperty(dom.window, "location", { configurable: true, value: new URL(`http://fixture/chat/${chatId}`) });
					Object.defineProperty(dom.window, "localStorage", {
						configurable: true,
						value: {
							getItem: (k: string) => values.get(k) ?? null,
							setItem: (k: string, v: string) => values.set(k, v),
							removeItem: (k: string) => values.delete(k),
						},
					});
					Object.defineProperty(prototype, "getAnimations", { configurable: true, value: () => [] });
					Object.defineProperty(prototype, "offsetWidth", { configurable: true, get() { return this.clientWidth; } });
					Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => "visible" });
					return () => {
						for (const { object, key, descriptor } of saved) {
							if (descriptor) Object.defineProperty(object, key, descriptor);
							else Reflect.deleteProperty(object, key);
						}
					};
				},
				fetch: async (input, init) => {
					const url = String(input);
					if (url === "/api/chat" || (url.endsWith("/chat") && init?.method === "POST")) {
						chatPosts++;
						return Response.json({ ok: true });
					}
					if (url === "/api/models") return Response.json({ providers: [], models: [], slots: {} });
					if (url === "/api/settings") return Response.json({});
					if (url === `/api/chats/${chatId}/side-chats`) return Response.json({ threads: [] });
					if (url === `/api/jobs?chatId=${chatId}`) {
						jobsRequests++;
						return Response.json({ jobs: [], turnInFlight: serverTurnInFlight });
					}
					if (url === `/api/chats/${chatId}`) {
						recordRequests++;
						if (failRecordGet) return new Response("Sync failed", { status: 500 });
						return Response.json({
							id: chatId,
							messages: serverMessages,
							turnInFlight: serverTurnInFlight,
							compacting: serverCompacting,
						});
					}
					if (url === `/api/chats/${chatId}/stream`) {
						streamRequests++;
						const encoder = new TextEncoder();
						const mode = streamMode;
						const signal = init?.signal;
						const body = new ReadableStream<Uint8Array>({
							async start(controller) {
								const onAbort = () => {
									streamCancelledCount++;
									try {
										controller.error(new DOMException("Aborted", "AbortError"));
									} catch {
										/* already closed */
									}
								};
								if (signal?.aborted) {
									onAbort();
									return;
								}
								signal?.addEventListener("abort", onAbort, { once: true });
								if (mode === "done") {
									controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "agent_start" })}\n\n`));
									controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "agent_end", messages: [] })}\n\n`));
									controller.enqueue(encoder.encode("data: [DONE]\n\n"));
									controller.close();
									return;
								}
								controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "agent_start" })}\n\n`));
								if (mode === "streaming") {
									controller.enqueue(
										encoder.encode(
											`data: ${JSON.stringify({
												type: "message_start",
												message: { role: "assistant", content: [{ type: "text", text: "Partial before sleep" }] },
											})}\n\n`,
										),
									);
								}
								await new Promise<void>((r) => { pendingStreamReleases.push(r); });
								signal?.removeEventListener("abort", onAbort);
								try {
									controller.close();
								} catch {
									/* already closed/errored */
								}
							},
						});
						return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
					}
					throw new Error(`Unexpected request: ${url}`);
				},
			},
		);

		const mounted = fixture;

		// 1. Stale hung "streaming" socket after server settled (idleMs > 45_000, turnInFlight === false)
		serverTurnInFlight = true;
		streamMode = "streaming";
		await act(async () => {
			mounted.document.dispatchEvent(new window.Event("visibilitychange"));
		});
		await waitForUi(
			() => streamRequests >= 1 && Boolean(mounted.document.body.textContent?.includes("Partial before sleep")),
			5_000,
			"partial stream render before sleep",
		);
		assert.equal(streamRequests, 1);
		assert.ok(mounted.document.body.textContent?.includes("Partial before sleep"));

		timeOffset += 60_000;
		serverTurnInFlight = false;
		serverMessages = [
			...initialMessages,
			{
				id: "a_after_sleep_1",
				role: "assistant",
				content: [{ type: "text", text: "Final answer after sleep." }],
				stopReason: "stop",
				usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				provider: "custom",
				model: "test-model",
				timestamp: 2,
			} as unknown as LhMessage,
		];
		await act(async () => {
			mounted.document.dispatchEvent(new window.Event("visibilitychange"));
		});
		await waitForUi(
			() => streamCancelledCount >= 1 && Boolean(mounted.document.body.textContent?.includes("Final answer after sleep.")),
			5_000,
			"stale streaming socket recovery",
		);
		assert.equal(chatPosts, 0);
		assert.equal(streamRequests, 1);
		assert.equal(streamCancelledCount, 1, "hung streaming socket should be cancelled");
		assert.ok(mounted.document.body.textContent?.includes("Final answer after sleep."));

		// 2. Pre-turn compacting: true guard preserves "submitted" stream when idleMs > 45_000
		serverTurnInFlight = true;
		serverCompacting = true;
		streamMode = "submitted";
		await act(async () => {
			window.dispatchEvent(new window.Event("online"));
		});
		await waitForUi(
			() => streamRequests >= 2 && Boolean(mounted.document.body.textContent?.includes("THINKING…")),
			5_000,
			"submitted stream attach for compacting check",
		);
		assert.equal(streamRequests, 2);

		timeOffset += 60_000;
		serverTurnInFlight = false; // Pre-turn ensureCompacted runs before beginTurn
		const compactingJobsBefore = jobsRequests;
		const compactingRecordBefore = recordRequests;
		await act(async () => {
			mounted.document.dispatchEvent(new window.Event("visibilitychange"));
		});
		await waitForUi(
			() =>
				jobsRequests >= compactingJobsBefore + 1
				&& recordRequests >= compactingRecordBefore + 1
				&& Boolean(mounted.document.body.textContent?.includes("COMPACTING CONTEXT…")),
			5_000,
			"compacting readRecord preservation check",
		);
		assert.equal(streamCancelledCount, 1, "submitted turn during server compacting: true must NOT be stopped");

		// 3. Once compacting finishes and turn settled, stale "submitted" socket recovers
		serverCompacting = false;
		serverMessages = [
			...serverMessages,
			{ id: "u2", role: "user", content: "Second prompt", timestamp: 3 } as LhMessage,
			{
				id: "a_after_sleep_2",
				role: "assistant",
				content: [{ type: "text", text: "Recovered from submitted sleep." }],
				stopReason: "stop",
				usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				provider: "custom",
				model: "test-model",
				timestamp: 4,
			} as unknown as LhMessage,
		];
		await act(async () => {
			mounted.document.dispatchEvent(new window.Event("visibilitychange"));
		});
		await waitForUi(
			() => streamCancelledCount >= 2 && Boolean(mounted.document.body.textContent?.includes("Recovered from submitted sleep.")),
			5_000,
			"stale submitted socket recovery",
		);
		assert.equal(streamCancelledCount, 2, "hung submitted socket should be cancelled once not compacting");
		assert.ok(mounted.document.body.textContent?.includes("Recovered from submitted sleep."));

		// 4. reconciliation === "failed" alert heals automatically on resync
		serverTurnInFlight = true;
		streamMode = "done";
		await act(async () => {
			window.dispatchEvent(new window.Event("focus"));
		});
		await waitForUi(
			() => streamRequests >= 3 && !mounted.document.body.textContent?.includes("THINKING…"),
			5_000,
			"done stream settle before reconcile failure test",
		);
		// Ensure the /api/chats/[id] GET inside reconcile() fails
		failRecordGet = true;
		serverTurnInFlight = false;
		await act(async () => {
			// Trigger another turn-end reconcile while failRecordGet = true
			controllable.emit("turn-started", { chatId });
		});
		await waitForUi(
			() => Boolean(mounted.document.body.textContent?.includes("Could not sync the saved session")),
			5_000,
			"reconcile failure alert",
		);
		assert.ok(
			mounted.document.body.textContent?.includes("Could not sync the saved session"),
			"reconcile failure should show sync alert",
		);

		failRecordGet = false;
		serverMessages = [
			...serverMessages,
			{
				id: "a_after_reconcile",
				role: "assistant",
				content: [{ type: "text", text: "Healed after sync failure." }],
				stopReason: "stop",
				usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				provider: "custom",
				model: "test-model",
				timestamp: 5,
			} as unknown as LhMessage,
		];
		await act(async () => {
			window.dispatchEvent(new window.Event("online"));
		});
		await waitForUi(
			() =>
				!mounted.document.body.textContent?.includes("Could not sync the saved session")
				&& Boolean(mounted.document.body.textContent?.includes("Healed after sync failure.")),
			5_000,
			"reconcile recovery render",
		);
		assert.equal(
			mounted.document.body.textContent?.includes("Could not sync the saved session"),
			false,
			"sync alert should clear once resync succeeds",
		);
		assert.ok(mounted.document.body.textContent?.includes("Healed after sync failure."));
		assert.equal(chatPosts, 0);
	} finally {
		for (const release of pendingStreamReleases) release();
		Date.now = origDateNow;
		await fixture?.close();
		if (savedObserver) Object.defineProperty(globalThis, "ResizeObserver", savedObserver);
		else Reflect.deleteProperty(globalThis, "ResizeObserver");
	}
});

test("Probe 1C: submitted stream delivering message_start while readRecord(adoption=none) is pending is NOT aborted", async () => {
	const savedObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
	const origDateNow = Date.now;
	let timeOffset = 0;
	Date.now = () => origDateNow() + timeOffset;
	Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });

	const controllable = createControllableSource();
	const chatId = "chat_probe_1c_ui";
	const initialMessages: LhMessage[] = [{ id: "u0", role: "user", content: "Start", timestamp: 1 } as LhMessage];

	let serverTurnInFlight = true;
	let streamCancelledCount = 0;
	let blockRecordRead = false;
	let recordReadDone = 0;
	let releaseRecordRead: (() => void) | undefined;
	let recordReadStarted: (() => void) | undefined;
	let deliverMessageStart!: () => void;
	let releaseStream!: () => void;

	let fixture: Awaited<ReturnType<typeof mountPluginChrome>> | undefined;
	try {
		fixture = await mountPluginChrome(
			{ activate() {} },
			<ServerEventsProvider connect={() => controllable.source}>
				<Chat chatId={chatId} title="Probe 1C Session" initialMessages={initialMessages} />
			</ServerEventsProvider>,
			{
				pathname: `/chat/${chatId}`,
				prepareDom(dom) {
					const prototype = dom.window.HTMLElement.prototype;
					const saved = [
						[dom.window, "location"],
						[dom.window, "localStorage"],
						[prototype, "getAnimations"],
						[prototype, "offsetWidth"],
					].map(([object, key]) => ({
						object: object as object,
						key: key as string,
						descriptor: Object.getOwnPropertyDescriptor(object, key as string),
					}));
					const values = new Map<string, string>();
					Object.defineProperty(dom.window, "location", { configurable: true, value: new URL(`http://fixture/chat/${chatId}`) });
					Object.defineProperty(dom.window, "localStorage", {
						configurable: true,
						value: {
							getItem: (k: string) => values.get(k) ?? null,
							setItem: (k: string, v: string) => values.set(k, v),
							removeItem: (k: string) => values.delete(k),
						},
					});
					Object.defineProperty(prototype, "getAnimations", { configurable: true, value: () => [] });
					Object.defineProperty(prototype, "offsetWidth", { configurable: true, get() { return this.clientWidth; } });
					Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => "visible" });
					return () => {
						for (const { object, key, descriptor } of saved) {
							if (descriptor) Object.defineProperty(object, key, descriptor);
							else Reflect.deleteProperty(object, key);
						}
					};
				},
				fetch: async (input, init) => {
					const url = String(input);
					if (url === "/api/models") return Response.json({ providers: [], models: [], slots: {} });
					if (url === "/api/settings") return Response.json({});
					if (url === `/api/chats/${chatId}/side-chats`) return Response.json({ threads: [] });
					if (url === `/api/jobs?chatId=${chatId}`) {
						return Response.json({ jobs: [], turnInFlight: serverTurnInFlight });
					}
					if (url === `/api/chats/${chatId}`) {
						if (blockRecordRead) {
							recordReadStarted?.();
							await new Promise<void>((r) => { releaseRecordRead = r; });
						}
						recordReadDone++;
						return Response.json({
							id: chatId,
							messages: initialMessages,
							turnInFlight: serverTurnInFlight,
							compacting: false,
						});
					}
					if (url === `/api/chats/${chatId}/stream`) {
						const encoder = new TextEncoder();
						const signal = init?.signal;
						const body = new ReadableStream<Uint8Array>({
							async start(controller) {
								const onAbort = () => {
									streamCancelledCount++;
									try {
										controller.error(new DOMException("Aborted", "AbortError"));
									} catch {
										/* already closed */
									}
								};
								if (signal?.aborted) {
									onAbort();
									return;
								}
								signal?.addEventListener("abort", onAbort, { once: true });
								controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "agent_start" })}\n\n`));
								await new Promise<void>((r) => { deliverMessageStart = r; });
								controller.enqueue(
									encoder.encode(
										`data: ${JSON.stringify({
											type: "message_start",
											message: { role: "assistant", content: [{ type: "text", text: "Live chunk after wake" }] },
										})}\n\n`,
									),
								);
								await new Promise<void>((r) => { releaseStream = r; });
								signal?.removeEventListener("abort", onAbort);
								try {
									controller.close();
								} catch {
									/* already closed/errored */
								}
							},
						});
						return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
					}
					throw new Error(`Unexpected request: ${url}`);
				},
			},
		);

		const mounted = fixture;
		// 1. Attach into "submitted" state (agent_start received, message_start not yet sent)
		await act(async () => {
			mounted.document.dispatchEvent(new window.Event("visibilitychange"));
		});
		await waitForUi(
			() => typeof deliverMessageStart === "function" && Boolean(mounted.document.body.textContent?.includes("THINKING…")),
			5_000,
			"Probe 1C deliverMessageStart initialization and submitted state",
		);
		assert.equal(streamCancelledCount, 0);

		// 2. Advance past STALE_STREAM_MS and start a resync whose readRecord({ adoption: "none" }) blocks
		timeOffset += 60_000;
		serverTurnInFlight = false;
		blockRecordRead = true;
		let notifyReadStarted!: () => void;
		const readStarted = new Promise<void>((r) => { notifyReadStarted = r; });
		recordReadStarted = notifyReadStarted;

		await act(async () => {
			mounted.document.dispatchEvent(new window.Event("visibilitychange"));
			await readStarted;
		});

		// 3. While readRecord({ adoption: "none" }) is pending, the submitted stream wakes up with message_start
		await act(async () => {
			deliverMessageStart();
		});
		await waitForUi(
			() => Boolean(mounted.document.body.textContent?.includes("Live chunk after wake")),
			5_000,
			"Probe 1C live chunk render",
		);
		assert.ok(mounted.document.body.textContent?.includes("Live chunk after wake"));

		// 4. Unblock readRecord; runResync must observe updated stream activity and NOT call stop()
		blockRecordRead = false;
		const readDoneBefore = recordReadDone;
		await act(async () => {
			releaseRecordRead?.();
		});
		await waitForUi(
			() => recordReadDone >= readDoneBefore + 1,
			5_000,
			"Probe 1C readRecord release",
		);
		await act(async () => {
			await Promise.resolve();
		});

		assert.equal(streamCancelledCount, 0, "submitted stream that delivered message_start during readRecord await must NOT be aborted");
		assert.ok(mounted.document.body.textContent?.includes("Live chunk after wake"));
	} finally {
		deliverMessageStart?.();
		releaseRecordRead?.();
		releaseStream?.();
		Date.now = origDateNow;
		await fixture?.close();
		if (savedObserver) Object.defineProperty(globalThis, "ResizeObserver", savedObserver);
		else Reflect.deleteProperty(globalThis, "ResizeObserver");
	}
});
